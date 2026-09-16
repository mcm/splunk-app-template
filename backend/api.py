"""Example backend for a Splunk app.

This is ordinary FastAPI. The only Splunk-specific part is `current_splunk_user`, a
dependency that hands routes the already-authenticated user - splunkd authenticates every
request before it ever reaches Python, so routes never parse headers or check credentials
themselves.
"""

import random
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from splunklib.client import Service

app = FastAPI(
    title="My Splunk App",
    # splunkd serves this handler under the `match` prefix from restmap.conf. Declaring it
    # as root_path keeps route decorators clean: `@app.get("/d6")` serves
    # `/services/my_splunk_app/d6`.
    root_path="/services/my_splunk_app",
    # The interactive docs load Swagger/ReDoc assets from a public CDN, which will not work
    # in an air-gapped Splunk and is a liability for Cloud vetting. The schema itself is
    # static JSON, so it stays.
    docs_url=None,
    redoc_url=None,
)


class SplunkUser(BaseModel):
    """The user splunkd authenticated for this request."""

    username: str
    """Login name, e.g. `admin`."""

    token: str = Field(exclude=True)
    """Session token for calling back into Splunk as this user.

    `exclude=True` keeps it out of every serialised response. It is a live credential and a
    route that returns a `SplunkUser` should never leak it to the browser.
    """

    app: Optional[str] = None
    """Namespace app. Only set on `/servicesNS/<user>/<app>/...` requests."""

    owner: Optional[str] = None
    """Namespace owner. Only set on `/servicesNS/<user>/<app>/...` requests."""


def current_splunk_user(request: Request) -> SplunkUser:
    """Dependency yielding the authenticated Splunk user.

    Identity comes from the persistent-connection packet that splunkd sends, which
    `persistconn.py` puts on the ASGI scope. `session` is always present; `ns` is only
    populated for `/servicesNS/<user>/<app>/...` requests, so treat it as optional.
    """
    packet: Dict[str, Any] = request.scope.get("extensions", {}).get("x-splunk-persistconn", {})

    session = packet.get("session") or {}
    username = session.get("user")
    token = session.get("authtoken")
    if not username or not token:
        raise HTTPException(status_code=401, detail="No authenticated Splunk session")

    namespace = packet.get("ns") or {}
    return SplunkUser(
        username=username,
        token=token,
        app=namespace.get("app"),
        owner=namespace.get("user"),
    )


def splunk_service(
    request: Request, user: SplunkUser = Depends(current_splunk_user)
) -> Service:
    """Dependency yielding a `splunklib` client bound to the requesting user.

    Calls made through it are authorised as that user, so Splunk's own access controls
    apply - do not substitute a more privileged token here.
    """
    return Service(
        host=request.headers.get("x-splunk-rest-uri-host") or "localhost",
        port=int(request.headers.get("x-splunk-rest-uri-port") or 8089),
        scheme=request.headers.get("x-splunk-rest-uri-scheme") or "https",
        owner=user.owner or "-",
        app=user.app or "-",
        token=user.token,
    )


@app.get("/whoami")
def whoami(user: SplunkUser = Depends(current_splunk_user)) -> SplunkUser:
    """Who splunkd says is calling."""
    return user


@app.get("/d6")
def roll_d6() -> Dict[str, int]:
    """A route that needs no Splunk context at all."""
    return {"result": random.randint(1, 6)}


@app.get("/apps")
def list_apps(service: Service = Depends(splunk_service)) -> Dict[str, List[str]]:
    """The Splunk SDK works alongside FastAPI - this lists apps visible to the caller."""
    return {"apps": sorted(entry.name for entry in service.apps)}
