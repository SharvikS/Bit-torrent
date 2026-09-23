"""HTTP + WebSocket API.

The transport split is deliberate:

* **WebSocket** carries everything that changes on a timer — the torrent list,
  session stats, and (if the client has a torrent open) that torrent's detail
  payload. One push per second per client, so the UI never polls.
* **HTTP** carries everything the user initiates. Actions are POSTs that return
  the affected count, so the UI can show an honest confirmation.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import os
import secrets
import time
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from .config import Config, DEFAULTS, UI_KEYS
from .engine import Engine

log = logging.getLogger("fission.api")

PUSH_INTERVAL = 1.0
MAX_UPLOAD = 32 * 1024 * 1024  # generous for a .torrent, tight enough to be safe


def json_response(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, default=str))


def error(message: str, status: int = 400) -> web.Response:
    return json_response({"ok": False, "error": message}, status=status)


def ok(**payload: Any) -> web.Response:
    return json_response({"ok": True, **payload})


# ----------------------------------------------------------------------
# authentication
# ----------------------------------------------------------------------

COOKIE = "fission_session"


class Auth:
    """Optional password gate.

    Disabled by default because the daemon binds to loopback. Turning it on is
    what makes it safe to expose the UI on a LAN or behind a reverse proxy.
    """

    def __init__(self, password: str | None):
        self.password = password or None
        self.tokens: dict[str, float] = {}

    @property
    def enabled(self) -> bool:
        return self.password is not None

    def issue(self) -> str:
        token = secrets.token_urlsafe(32)
        self.tokens[token] = time.time() + 30 * 24 * 3600
        return token

    def check(self, request: web.Request) -> bool:
        if not self.enabled:
            return True
        token = request.cookies.get(COOKIE) or request.headers.get("X-Fission-Token", "")
        expiry = self.tokens.get(token)
        if expiry is None:
            return False
        if expiry < time.time():
            self.tokens.pop(token, None)
            return False
        return True

    def verify(self, password: str) -> bool:
        return self.enabled and secrets.compare_digest(password, self.password)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    auth: Auth = request.app["auth"]
    path = request.path
    public = path in ("/api/login", "/api/ping") or not path.startswith("/api")
    if public or auth.check(request):
        return await handler(request)
    return error("Authentication required", 401)


@web.middleware
async def guard_middleware(request: web.Request, handler):
    """Reject cross-origin and rebound-DNS requests at the door.

    A torrent daemon on loopback is a juicy target for a malicious web page:
    without this, any site the user visits could drive the API through their
    browser. We pin the Host header and require same-origin for state changes.
    """
    allowed: set[str] = request.app["allowed_hosts"]
    if allowed:
        host = (request.headers.get("Host", "").split(":")[0] or "").lower()
        if host and host not in allowed:
            return error("Host not allowed", 403)

    origin = request.headers.get("Origin")
    if origin and request.method not in ("GET", "HEAD", "OPTIONS"):
        expected_hosts = allowed or {""}
        origin_host = origin.split("//", 1)[-1].split(":")[0].lower()
        if origin_host not in expected_hosts:
            return error("Cross-origin request blocked", 403)

    return await handler(request)


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except KeyError as exc:
        return error(f"Not found: {exc}", 404)
    except ValueError as exc:
        return error(str(exc), 400)
    except Exception as exc:  # pragma: no cover - unexpected
        log.exception("unhandled error on %s", request.path)
        return error(f"Internal error: {exc}", 500)


# ----------------------------------------------------------------------
# websocket hub
# ----------------------------------------------------------------------

class Hub:
    """Tracks connected clients and fans out snapshots + events."""

    def __init__(self, engine: Engine):
        self.engine = engine
        self.clients: set[web.WebSocketResponse] = set()
        # Which torrent (if any) each client currently has expanded.
        self.watching: dict[web.WebSocketResponse, str] = {}
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._push_loop(), name="fission-push")
        self.engine.listeners.append(self._on_event)

    async def stop(self) -> None:
        with contextlib.suppress(ValueError):
            self.engine.listeners.remove(self._on_event)
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        for ws in list(self.clients):
            with contextlib.suppress(Exception):
                await ws.close()
        self.clients.clear()

    def _on_event(self, event: dict[str, Any]) -> None:
        if not self.clients:
            return
        asyncio.create_task(self._broadcast({"type": "event", "event": event}))

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        dead = []
        text = json.dumps(payload, default=str)
        for ws in list(self.clients):
            try:
                await ws.send_str(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)
            self.watching.pop(ws, None)

    async def _push_loop(self) -> None:
        while True:
            try:
                if self.clients:
                    snapshot = self.engine.snapshot()
                    base = json.dumps({"type": "snapshot", **snapshot}, default=str)
                    dead = []
                    for ws in list(self.clients):
                        try:
                            await ws.send_str(base)
                            ih = self.watching.get(ws)
                            if ih and ih in self.engine.torrents:
                                detail = self.engine.torrent_detail(ih)
                                await ws.send_str(json.dumps(
                                    {"type": "detail", "detail": detail}, default=str))
                        except Exception:
                            dead.append(ws)
                    for ws in dead:
                        self.clients.discard(ws)
                        self.watching.pop(ws, None)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("push loop error")
            await asyncio.sleep(PUSH_INTERVAL)


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    auth: Auth = request.app["auth"]
    if not auth.check(request):
        raise web.HTTPUnauthorized()

    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)

    hub: Hub = request.app["hub"]
    engine: Engine = request.app["engine"]
    hub.clients.add(ws)

    # Send an immediate snapshot so the UI paints without waiting for the tick.
    with contextlib.suppress(Exception):
        await ws.send_str(json.dumps({"type": "snapshot", **engine.snapshot()}, default=str))

    try:
        async for msg in ws:
            if msg.type is not WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(msg.data)
            except ValueError:
                continue
            kind = payload.get("type")
            if kind == "watch":
                ih = payload.get("hash") or ""
                if ih:
                    hub.watching[ws] = ih
                    if ih in engine.torrents:
                        await ws.send_str(json.dumps(
                            {"type": "detail", "detail": engine.torrent_detail(ih)}, default=str))
                else:
                    hub.watching.pop(ws, None)
            elif kind == "ping":
                await ws.send_str(json.dumps({"type": "pong", "at": time.time()}))
    finally:
        hub.clients.discard(ws)
        hub.watching.pop(ws, None)
    return ws


# ----------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------

async def login(request: web.Request) -> web.Response:
    auth: Auth = request.app["auth"]
    if not auth.enabled:
        return ok(required=False)
    body = await _json_body(request)
    if not auth.verify(str(body.get("password", ""))):
        # A small constant delay blunts online guessing without the complexity
        # of real rate limiting.
        await asyncio.sleep(0.5)
        return error("Incorrect password", 401)
    token = auth.issue()
    response = json_response({"ok": True, "token": token})
    response.set_cookie(COOKIE, token, httponly=True, samesite="Strict",
                        max_age=30 * 24 * 3600, path="/")
    return response


async def logout(request: web.Request) -> web.Response:
    auth: Auth = request.app["auth"]
    token = request.cookies.get(COOKIE, "")
    auth.tokens.pop(token, None)
    response = ok()
    response.del_cookie(COOKIE, path="/")
    return response


async def ping(request: web.Request) -> web.Response:
    auth: Auth = request.app["auth"]
    return ok(auth_required=auth.enabled, authenticated=auth.check(request),
              version=request.app["version"])


async def get_state(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    return json_response(engine.snapshot())


async def get_torrent(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    return json_response(engine.torrent_detail(request.match_info["hash"]))


async def download_torrent_file(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    ih = request.match_info["hash"]
    blob = engine.torrent_file_bytes(ih)
    if blob is None:
        return error("Metadata not available yet", 404)
    name = engine.torrents[ih].status.name if ih in engine.torrents else ih
    safe = "".join(c for c in name if c.isalnum() or c in " ._-")[:100] or ih
    return web.Response(
        body=blob,
        content_type="application/x-bittorrent",
        headers={"Content-Disposition": f'attachment; filename="{safe}.torrent"'},
    )


async def add_torrents(request: web.Request) -> web.Response:
    """Add one or more magnets / info hashes pasted as text."""
    engine: Engine = request.app["engine"]
    body = await _json_body(request)
    raw = str(body.get("urls", "") or "")
    options = _add_options(body)

    entries = [line.strip() for line in raw.replace(",", "\n").splitlines() if line.strip()]
    if not entries:
        return error("Nothing to add")

    added, failures = [], []
    for entry in entries:
        try:
            added.append(engine.add_any(entry, options))
        except ValueError as exc:
            failures.append({"input": entry[:80], "error": str(exc)})
    if not added and failures:
        return error(failures[0]["error"])
    return ok(added=added, failed=failures, count=len(added))


async def upload_torrents(request: web.Request) -> web.Response:
    """Add .torrent files sent as multipart form data."""
    engine: Engine = request.app["engine"]
    reader = await request.multipart()
    options: dict[str, Any] = {}
    added, failures = [], []

    async for part in reader:
        if part.name == "options":
            with contextlib.suppress(ValueError):
                options = _add_options(json.loads(await part.text()))
            continue
        if part.filename is None:
            continue
        chunks, size = [], 0
        while True:
            chunk = await part.read_chunk(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD:
                return error("File too large", 413)
            chunks.append(chunk)
        blob = b"".join(chunks)
        try:
            opts = dict(options)
            opts["filename"] = part.filename
            added.append(engine.add_torrent_bytes(blob, opts))
        except ValueError as exc:
            failures.append({"input": part.filename, "error": str(exc)})

    if not added and failures:
        return error(failures[0]["error"])
    if not added:
        return error("No .torrent files found in upload")
    return ok(added=added, failed=failures, count=len(added))


def _add_options(body: dict[str, Any]) -> dict[str, Any]:
    options: dict[str, Any] = {}
    for key in ("save_path", "category", "filename"):
        if body.get(key):
            options[key] = str(body[key])
    for key in ("paused", "sequential", "skip_check", "force_start"):
        if key in body:
            options[key] = bool(body[key])
    if body.get("tags"):
        tags = body["tags"]
        options["tags"] = [t.strip() for t in
                           (tags.split(",") if isinstance(tags, str) else tags) if str(t).strip()]
    if body.get("trackers"):
        trackers = body["trackers"]
        options["trackers"] = (trackers.splitlines() if isinstance(trackers, str) else list(trackers))
    for key in ("download_limit", "upload_limit"):
        if body.get(key):
            with contextlib.suppress(ValueError, TypeError):
                options[key] = int(body[key])
    return options


async def torrent_action(request: web.Request) -> web.Response:
    """Single dispatch point for every bulk operation the UI offers."""
    engine: Engine = request.app["engine"]
    body = await _json_body(request)
    action = str(body.get("action", ""))
    hashes = body.get("hashes") or []
    if isinstance(hashes, str):
        hashes = [hashes]
    if hashes == ["*"]:
        hashes = list(engine.torrents)

    simple = {
        "pause": engine.pause,
        "resume": engine.resume,
        "force_start": engine.force_start,
        "recheck": engine.recheck,
        "reannounce": engine.reannounce,
        "scrape": engine.scrape,
    }
    if action in simple:
        return ok(count=simple[action](hashes))

    if action == "remove":
        return ok(count=engine.remove(hashes, with_data=bool(body.get("with_data"))))
    if action == "queue":
        return ok(count=engine.queue(hashes, str(body.get("direction", "up"))))
    if action == "set_limits":
        return ok(count=engine.set_limits(hashes, body.get("download"), body.get("upload")))
    if action == "set_connection_limits":
        return ok(count=engine.set_connection_limits(
            hashes, body.get("connections"), body.get("uploads")))
    if action == "set_flag":
        return ok(count=engine.set_flags(hashes, str(body.get("flag", "")), bool(body.get("enabled"))))
    if action == "set_category":
        return ok(count=engine.set_category(hashes, str(body.get("category", ""))))
    if action == "set_tags":
        tags = body.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        return ok(count=engine.set_tags(hashes, tags, str(body.get("mode", "set"))))
    if action == "move":
        target = str(body.get("path", "")).strip()
        if not target:
            return error("A destination path is required")
        return ok(count=engine.move_storage(hashes, target))
    if action == "rename":
        name = str(body.get("name", "")).strip()
        if not name or "/" in name:
            return error("Invalid name")
        engine.rename_torrent(hashes[0], name)
        return ok(count=1)

    return error(f"Unknown action: {action}")


async def set_file_priorities(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    body = await _json_body(request)
    ih = request.match_info["hash"]
    priorities = body.get("priorities") or {}
    if isinstance(priorities, list):
        priorities = {i: p for i, p in enumerate(priorities)}
    engine.set_file_priorities(ih, {int(k): int(v) for k, v in priorities.items()})
    return ok()


async def edit_trackers(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    body = await _json_body(request)
    ih = request.match_info["hash"]
    urls = body.get("urls") or []
    if isinstance(urls, str):
        urls = urls.splitlines()
    if body.get("op") == "remove":
        return ok(count=engine.remove_trackers(ih, urls))
    return ok(count=engine.add_trackers(ih, urls))


async def get_settings(request: web.Request) -> web.Response:
    config: Config = request.app["config"]
    return json_response({"settings": config.as_dict(), "defaults": DEFAULTS})


async def save_settings(request: web.Request) -> web.Response:
    config: Config = request.app["config"]
    engine: Engine = request.app["engine"]
    patch = await _json_body(request)
    changed = config.update(patch)
    # Anything outside the UI-only set can affect the libtorrent session, so
    # re-apply the pack. libtorrent diffs internally, making this cheap.
    if changed - UI_KEYS:
        engine.apply_settings()
        engine.emit("settings", {"message": "Settings applied"}, level="success")
    return ok(changed=sorted(changed), settings=config.as_dict())


async def toggle_alt_speed(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    body = await _json_body(request)
    enabled = engine.toggle_alt_speed(body.get("enabled"))
    return ok(enabled=enabled)


async def get_events(request: web.Request) -> web.Response:
    engine: Engine = request.app["engine"]
    return json_response({"events": list(engine.events)[-200:]})


async def browse(request: web.Request) -> web.Response:
    """Directory listing that backs the save-path picker."""
    raw = request.query.get("path", "") or str(Path.home())
    target = Path(raw).expanduser()
    if not target.is_absolute():
        target = Path.home() / target
    if not target.is_dir():
        target = target.parent if target.parent.is_dir() else Path.home()

    entries = []
    with contextlib.suppress(OSError):
        for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith("."):
                continue
            with contextlib.suppress(OSError):
                if child.is_dir():
                    entries.append({"name": child.name, "path": str(child)})
    return json_response({
        "path": str(target),
        "parent": str(target.parent) if target.parent != target else "",
        "entries": entries[:500],
    })


async def _json_body(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        body = await request.json()
    except (ValueError, json.JSONDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


# ----------------------------------------------------------------------
# application factory
# ----------------------------------------------------------------------

def _allowed_hosts(host: str) -> set[str]:
    """Hosts we will answer to, for DNS-rebinding protection.

    Binding to a wildcard address means the user intends remote access, so we
    cannot know the hostname in advance and the check is disabled (an empty set
    means "allow anything"). Loopback binds get the strict treatment.
    """
    if host in ("0.0.0.0", "::", ""):
        return set()
    base = {"localhost", "127.0.0.1", "::1", "[::1]", host.lower()}
    extra = os.environ.get("FISSION_ALLOWED_HOSTS", "")
    base |= {h.strip().lower() for h in extra.split(",") if h.strip()}
    return base


async def index(request: web.Request) -> web.Response:
    path: Path = request.app["web_root"] / "index.html"
    if not path.exists():
        return web.Response(text="Fission UI assets are missing", status=500)
    return web.Response(
        body=path.read_bytes(),
        content_type="text/html",
        charset="utf-8",
        # The shell must never be cached: it is the only thing that knows which
        # asset versions to load.
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


async def static_asset(request: web.Request) -> web.Response:
    root: Path = request.app["web_root"]
    rel = request.match_info["path"]
    target = (root / rel).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        raise web.HTTPForbidden()
    if not target.is_file():
        raise web.HTTPNotFound()
    ctype, _ = mimetypes.guess_type(target.name)
    return web.Response(
        body=target.read_bytes(),
        content_type=ctype or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def build_app(engine: Engine, config: Config, *, password: str | None = None,
              host: str = "127.0.0.1", web_root: Path | None = None,
              version: str = "1.0.0") -> web.Application:
    app = web.Application(
        middlewares=[error_middleware, guard_middleware, auth_middleware],
        client_max_size=MAX_UPLOAD + 1024 * 1024,
    )
    app["engine"] = engine
    app["config"] = config
    app["auth"] = Auth(password)
    app["hub"] = Hub(engine)
    app["version"] = version
    app["allowed_hosts"] = _allowed_hosts(host)
    app["web_root"] = (web_root or Path(__file__).resolve().parent.parent / "web")

    app.add_routes([
        web.get("/api/ping", ping),
        web.post("/api/login", login),
        web.post("/api/logout", logout),
        web.get("/api/ws", ws_handler),
        web.get("/api/state", get_state),
        web.get("/api/events", get_events),
        web.get("/api/settings", get_settings),
        web.post("/api/settings", save_settings),
        web.post("/api/alt-speed", toggle_alt_speed),
        web.get("/api/fs", browse),
        web.post("/api/add", add_torrents),
        web.post("/api/upload", upload_torrents),
        web.post("/api/action", torrent_action),
        web.get("/api/torrents/{hash}", get_torrent),
        web.get("/api/torrents/{hash}/file", download_torrent_file),
        web.post("/api/torrents/{hash}/files", set_file_priorities),
        web.post("/api/torrents/{hash}/trackers", edit_trackers),
        web.get("/", index),
        web.get("/index.html", index),
        web.get("/{path:.+}", static_asset),
    ])

    async def on_startup(_: web.Application) -> None:
        app["hub"].start()

    async def on_cleanup(_: web.Application) -> None:
        await app["hub"].stop()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app
