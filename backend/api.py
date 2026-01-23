import random
from collections import UserList
from collections.abc import Collection, Sequence
from contextlib import asynccontextmanager
from typing import Any, Callable, Optional

from splunklib.client import Service
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route


class Router(UserList[Route]):
    def __call__(
        self,
        path: str,
        *,
        methods: Optional[Collection[str]] = None,
        name: Optional[str] = None,
        include_in_schema: bool = True,
        middleware: Optional[Sequence[Middleware]] = None,
    ):
        def decorator(endpoint: Callable[..., Any]):
            self.append(
                Route(
                    path,
                    endpoint,
                    methods=methods,
                    name=name,
                    include_in_schema=include_in_schema,
                    middleware=middleware,
                )
            )
            return endpoint

        return decorator


router = Router()


@router("/services/splunk_react18_asgi_example/whoami")
def whoami(request: Request):
    service = Service(
        host=request.headers.get("x-splunk-rest-uri-host") or "localhost",
        port=int(request.headers.get("x-splunk-rest-uri-port") or 8089),
        scheme=request.headers.get("x-splunk-rest-uri-scheme") or "https",
        owner=request.headers.get("x-splunk-ns-user") or "-",
        app=request.headers.get("x-splunk-ns-app") or "-",
        token=request.headers.get("authorization", "Splunk none").rsplit(" ", 1)[1],
    )

    resp = service.request("/services/authentication/current-context")

    return Response(
        content=resp["body"].read(),
        headers=dict(resp["headers"]),
    )


@router("/services/splunk_react18_asgi_example/d6")
def roll_d6(request: Request):
    return JSONResponse({"result": random.randint(1, 6)})


@asynccontextmanager
async def lifespan(app):
    # Do startup things
    yield
    # Do shutdown things


app = Starlette(routes=router, lifespan=lifespan, middleware=[])
