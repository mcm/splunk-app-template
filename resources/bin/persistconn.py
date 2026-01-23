# https://medium.com/@rsalgare95/writing-an-asgi-server-from-scratch-and-using-it-with-fastapi-21ec1191f3c7

import asyncio
import base64
import importlib.util
import json
import logging
import os
import sys
import traceback
from dataclasses import dataclass, field
from typing import Any, ClassVar, Optional, TYPE_CHECKING
from urllib.parse import urlencode, urlparse

if TYPE_CHECKING:
    from asgiref.typing import ASGIApplication

try:
    from splunk.persistconn.packet import PersistentServerConnectionProtocolException  # pyright: ignore[reportMissingImports]
except ImportError:

    class PersistentServerConnectionProtocolException(Exception):
        pass


logger = logging.getLogger("persistconn")


APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP_LIB_DIR = os.path.join(APP_DIR, "lib")

if os.path.exists(APP_LIB_DIR):
    sys.path.insert(0, APP_LIB_DIR)


BLOCKED_RESPONSE_HEADERS = [b"content-length"]


def import_from_path(module_name, file_path):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None:
        raise ImportError(file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    if spec.loader is None:
        raise ImportError(file_path)
    spec.loader.exec_module(module)
    return module


OPCODE_REQUEST_INIT = 0x01
OPCODE_REQUEST_BLOCK = 0x02
OPCODE_REQUEST_END = 0x04
OPCODE_REQUEST_ALLOW_STREAM = 0x08


async def connect_stdin_stdout(loop: asyncio.AbstractEventLoop, stdin=sys.stdin, stdout=sys.stdout):
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, stdin)

    w_transport, w_protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, stdout)
    writer = asyncio.StreamWriter(w_transport, w_protocol, reader, loop)
    return reader, writer


@dataclass
class StdioTransport:
    loop: asyncio.AbstractEventLoop
    stdin: asyncio.StreamReader
    stdout: asyncio.StreamWriter

    async def get_connection(self):
        try:
            opcode = await self.read_int()
        except EOFError:
            return None, 0x00

        if not opcode & OPCODE_REQUEST_INIT:
            raise ValueError(opcode)

        return Connection(transport=self), opcode

    async def read_int(self):
        while True:
            data = await self.stdin.read(1)
            if data == b"":
                raise EOFError
            elif data == b"\n":
                continue
            return ord(data)

    async def read_number(self):
        while True:
            if n := (await self.stdin.readline()).strip(b"\n"):
                break
        try:
            n = int(n)
        except ValueError:
            raise PersistentServerConnectionProtocolException(f"expected non-negative integer, got '{n}'")
        if n < 0:
            raise PersistentServerConnectionProtocolException(f"expected non-negative integer, got '{n}'")
        return n

    async def read_bytes(self):
        strlen = await self.read_number()
        return await self.stdin.read(strlen)

    async def read_string(self):
        return (await self.read_bytes()).decode()

    async def write_bytes(self, value: bytes):
        self.stdout.write(f"{len(value):d}\n".encode())
        self.stdout.write(value)
        await self.stdout.drain()

    async def write_string(self, value: str):
        await self.write_bytes(value.encode())


@dataclass
class Connection:
    transport: StdioTransport

    async def read_int(self):
        return await self.transport.read_int()

    async def read_number(self):
        return await self.transport.read_number()

    async def read_bytes(self):
        return await self.transport.read_bytes()

    async def read_string(self):
        return await self.transport.read_string()

    async def write_bytes(self, value: bytes):
        return await self.transport.write_bytes(value)

    async def write_string(self, value: str):
        return await self.transport.write_string(value)


@dataclass
class ConnectionHandler:
    loop: asyncio.AbstractEventLoop
    connection: Connection
    opcode: int
    handlers: dict[str, "ASGIApplication"] = field(default_factory=dict)  # pyright: ignore[reportInvalidTypeForm]

    LOG_FORMAT: ClassVar[str] = (
        '%(hostname)s %(remote_logname)s %(user_id)s %(asctime)s "%(request_line)s" %(status)s %(bytes)s'
    )

    async def get_command(self):
        command: list[str] = []
        for i in range(await self.connection.read_number()):
            command.append(await self.connection.read_string())
        return command

    async def get_command_arg(self):
        if command_arg := await self.connection.read_string():
            return command_arg
        return None

    def load_app_from_file(self, file_path: str, module_name: str, app_attr_name: str):
        module = import_from_path(module_name, file_path)
        return getattr(module, app_attr_name)

    async def handle_connection(self):
        command = await self.get_command()
        command_arg = await self.get_command_arg()

        while not self.opcode & OPCODE_REQUEST_BLOCK:
            self.opcode = await self.connection.read_int()
            if self.opcode & OPCODE_REQUEST_INIT:
                raise PersistentServerConnectionProtocolException("Received new init message while waiting for block")

        packet_block = await self.connection.read_bytes()

        request = Request()
        request.parse_packet_block(packet_block)

        if command_arg is None:
            raise PersistentServerConnectionProtocolException("Must pass script.param pointing to ASGI app")

        if command_arg not in self.handlers:
            try:
                module_str, app_str = command_arg.rsplit(".", 1)
                self.handlers[command_arg] = self.load_app_from_file(command[0], module_str, app_str)
            except:
                logger.exception(traceback.format_exc())

        app = self.handlers.get(command_arg)
        await self.connection.write_bytes(b"")

        if app is None:
            response = {"status": 404, "payload": "No handler found"}
        else:
            asgi = ASGI(request=request)
            await asgi(app)
            await asgi.response.done.wait()

            response = {
                "status": asgi.response.status,
                "payload": asgi.response.body.decode(),
                "headers": dict(
                    [
                        (k.decode(), v.decode())
                        for (k, v) in asgi.response.headers
                        if k.lower() not in BLOCKED_RESPONSE_HEADERS
                    ]
                ),
            }

        logger.info(
            self.LOG_FORMAT,
            extra={
                "hostname": "127.0.0.1",
                "remote_logname": "-",
                "user_id": "?",
                "request_line": "",
                "status": "200",
                "bytes": "2326",
            },
        )

        await self.connection.write_string(json.dumps(response))

        while not self.opcode & OPCODE_REQUEST_END:
            self.opcode = await self.connection.read_int()


@dataclass
class Response:
    status: int = 200
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)
    body: bytes = b""
    more_body: bool = False
    done: asyncio.Event = field(default_factory=asyncio.Event)

    def handle_message(self, message: dict[str, Any]):
        if message["type"] == "http.response.start":
            self.status = message.get("status", 200)
            self.headers = message.get("headers", [])
        elif message["type"] == "http.response.body":
            self.body += message.get("body", b"")
            self.more_body = message.get("more_body", False)
            if not self.more_body:
                self.done.set()


@dataclass
class Request:
    method: str = ""
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)
    request_type: str = "HTTP"
    http_version: str = "1.1"
    path: str = ""
    body: bytes = b""
    query: bytes = b""
    server: Optional[tuple[str, int]] = None
    response: Response = field(default_factory=Response)
    parsed_packet_block: dict[str, Any] = field(default_factory=dict)

    @property
    def request_line(self):
        path = self.path
        if self.query:
            path = f"{path}?{self.query}"

        return f"{self.method} {path} {self.request_type}/{self.http_version}"

    def parse_packet_block(self, block: bytes):
        try:
            self.parsed_packet_block: dict[str, Any] = json.loads(block)
        except:
            raise PersistentServerConnectionProtocolException("Packet block could not be parsed as JSON")

        try:
            self.method = self.parsed_packet_block["method"]
            self.request_type, self.http_version = "HTTP", "1.1"

            self.path = f"/services{self.parsed_packet_block['rest_path']}"

            header_name: str
            header_value: str
            for header_name, header_value in self.parsed_packet_block["headers"]:
                if header_name.lower() == "authorization":
                    header_value = f"Splunk {self.parsed_packet_block['session']['authtoken']}"
                self.headers.append((header_name.lower().encode(), header_value.encode()))

            self.headers.append((b"x-splunk-outout-mode", self.parsed_packet_block["output_mode"].encode()))
            if self.parsed_packet_block["output_mode_explicit"]:
                self.headers.append((b"x-splunk-output-mode-explicit", b"true"))

            if namespace := self.parsed_packet_block.get("ns"):
                self.headers.append((b"x-splunk-ns-user", namespace["user"].encode()))
                self.headers.append((b"x-splunk-ns-app", namespace["app"].encode()))

            rest_uri = urlparse(self.parsed_packet_block["server"]["rest_uri"])
            if rest_uri.port is None:
                self.server = (rest_uri.hostname, 443 if rest_uri.scheme == "https" else 80)
            else:
                self.server = (rest_uri.hostname, rest_uri.port)
            self.headers.append((b"x-splunk-rest-uri", self.parsed_packet_block["server"]["rest_uri"].encode()))
            self.headers.append((b"x-splunk-rest-uri-scheme", rest_uri.scheme.encode()))
            self.headers.append((b"x-splunk-rest-uri-host", self.server[0].encode()))
            self.headers.append((b"x-splunk-rest-uri-port", str(self.server[1]).encode()))

            self.query = urlencode(dict(self.parsed_packet_block["query"])).encode()

            if payload := self.parsed_packet_block.get("payload_base64"):
                self.body = base64.b64decode(payload.encode())
        except Exception as e:
            raise
            # raise PersistentServerConnectionProtocolException("Unable to convert packet to HTTP")


@dataclass
class ASGI:
    request: Request
    scope: dict[str, Any] = field(default_factory=dict)
    response: Response = field(default_factory=Response)

    def __post_init__(self):
        self.scope = {
            "asgi": {"version": "3.0"},
            "method": self.request.method,
            "type": "http",
            "http_version": self.request.http_version,
            "path": self.request.path,
            "headers": self.request.headers,
            "server": self.request.server,
            "query_string": self.request.query,
            "extensions": {"x-splunk-persistconn": self.request.parsed_packet_block},
        }

    async def __call__(self, app):
        await app(self.scope, self.receive, self.send)

    async def receive(self):
        message = {
            "type": "http.request",
            "body": self.request.body,
            "more_body": False,
        }
        return message

    async def send(self, message: dict):
        self.response.handle_message(message)
        if message["type"] == "http.response.start":
            self.trailers = message.get("trailers", False)


class Server:
    loop: asyncio.AbstractEventLoop
    stdin: asyncio.StreamReader
    stdout: asyncio.StreamWriter

    async def listen_for_connections(self):
        transport = StdioTransport(self.loop, self.stdin, self.stdout)

        while True:
            connection, opcode = await transport.get_connection()
            if connection is None:
                break

            handler = ConnectionHandler(self.loop, connection, opcode)
            await handler.handle_connection()

    async def start(self):
        self.loop = asyncio.get_event_loop()
        self.stdin, self.stdout = await connect_stdin_stdout(self.loop)
        await self.listen_for_connections()


if __name__ == "__main__":
    server = Server()
    asyncio.run(server.start())
