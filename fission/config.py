"""Configuration model and on-disk persistence.

Settings live in a single JSON document inside the state directory so the whole
application is relocatable: point ``--state-dir`` somewhere else and you get a
completely independent instance (useful for testing, or for running a second
daemon on another port).
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

# Every key the UI is allowed to write, with its default. Anything not in this
# map is rejected on save, which keeps a malformed request from poisoning the
# config file.
DEFAULTS: dict[str, Any] = {
    # ---- paths -----------------------------------------------------------
    "download_dir": str(Path.home() / "Downloads" / "Fission"),
    "incomplete_dir": "",          # empty -> download straight to download_dir
    "use_incomplete_dir": False,
    "watch_dir": "",               # auto-add .torrent files dropped here
    "watch_dir_enabled": False,

    # ---- network ---------------------------------------------------------
    "listen_port": 6881,
    "listen_port_max": 6891,
    "random_port": False,
    "enable_dht": True,
    "enable_lsd": True,
    "enable_upnp": True,
    "enable_natpmp": True,
    "enable_utp": True,
    "enable_pex": True,
    "prefer_tcp": False,
    "anonymous_mode": False,
    # 0 = disabled (plaintext only), 1 = enabled (prefer encrypted), 2 = forced
    "encryption_policy": 1,

    # ---- bandwidth -------------------------------------------------------
    "download_rate_limit": 0,      # bytes/sec, 0 = unlimited
    "upload_rate_limit": 0,
    "alt_download_rate_limit": 512 * 1024,
    "alt_upload_rate_limit": 128 * 1024,
    "alt_speed_enabled": False,
    "alt_speed_scheduler": False,
    "alt_speed_from": 1380,        # minutes past midnight (23:00)
    "alt_speed_to": 420,           # 07:00
    "rate_limit_ip_overhead": True,

    # ---- connections -----------------------------------------------------
    "connections_limit": 500,
    "connections_limit_per_torrent": 100,
    "unchoke_slots_limit": 20,
    "uploads_limit_per_torrent": 8,

    # ---- queueing --------------------------------------------------------
    "active_downloads": 5,
    "active_seeds": 10,
    "active_limit": 20,
    "dont_count_slow_torrents": True,

    # ---- seeding limits --------------------------------------------------
    "share_ratio_limit": 0.0,      # 0 = seed forever
    "seed_time_limit": 0,          # minutes, 0 = forever
    "share_limit_action": "pause",  # pause | remove | remove_with_data

    # ---- disk ------------------------------------------------------------
    "cache_size_mib": 0,           # 0 = let libtorrent decide
    "preallocate": False,
    "check_on_completion": False,

    # ---- proxy -----------------------------------------------------------
    # 0=none 1=socks4 2=socks5 3=socks5_pw 4=http 5=http_pw
    "proxy_type": 0,
    "proxy_host": "",
    "proxy_port": 1080,
    "proxy_username": "",
    "proxy_password": "",
    "proxy_peer_connections": True,
    "proxy_tracker_connections": True,
    "proxy_hostnames": True,

    # ---- behaviour -------------------------------------------------------
    "add_paused": False,
    "sequential_default": False,
    "auto_manage": True,
    "delete_torrent_file_after_add": False,
    "default_trackers": "",        # newline separated, appended to every add

    # ---- interface -------------------------------------------------------
    # system | midnight | graphite | carbon | nord | dracula | paper
    # | sandstone | contrast
    "theme": "midnight",
    # violet | blue | teal | green | amber | rose | cyan
    "accent": "violet",
    "density": "cozy",             # compact | cozy | comfortable
    "motion": "system",            # system | full | reduced
    "speed_unit": "binary",        # binary (KiB) | decimal (kB)
    "confirm_delete": True,
    "notifications": True,
}

# Theme names changed when the palette grew from two options to a named set.
# Old configs are rewritten on load so nobody lands on a blank appearance.
THEME_ALIASES = {"dark": "midnight", "light": "paper", "auto": "system"}

# Keys that only affect the UI: changing them never restarts the session.
UI_KEYS = {"theme", "accent", "density", "motion", "speed_unit",
           "confirm_delete", "notifications"}


class Config:
    """A dict-backed config with atomic writes."""

    def __init__(self, state_dir: Path):
        self.state_dir = Path(state_dir).expanduser().resolve()
        self.path = self.state_dir / "config.json"
        self.data: dict[str, Any] = dict(DEFAULTS)
        self.load()

    # -- persistence -------------------------------------------------------

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            stored = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            # A corrupt config should never stop the daemon from booting; we
            # fall back to defaults and overwrite on the next save.
            return
        for key, value in stored.items():
            if key in DEFAULTS:
                self.data[key] = value
        # Migrate any renamed values before the rest of the app reads them.
        self.data["theme"] = THEME_ALIASES.get(self.data["theme"], self.data["theme"])

    def save(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        # Write to a sibling temp file then rename, so a crash mid-write can
        # never leave a half-serialised config behind.
        fd, tmp = tempfile.mkstemp(dir=self.state_dir, prefix=".config-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, indent=2, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # -- access ------------------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def update(self, patch: dict[str, Any]) -> set[str]:
        """Apply a patch, returning the set of keys that actually changed."""
        changed: set[str] = set()
        for key, value in patch.items():
            if key not in DEFAULTS:
                continue
            coerced = _coerce(DEFAULTS[key], value)
            if coerced != self.data.get(key):
                self.data[key] = coerced
                changed.add(key)
        if changed:
            self.save()
        return changed

    def as_dict(self) -> dict[str, Any]:
        return dict(self.data)

    # -- derived paths -----------------------------------------------------

    @property
    def resume_dir(self) -> Path:
        return self.state_dir / "resume"

    @property
    def torrents_dir(self) -> Path:
        return self.state_dir / "torrents"

    @property
    def meta_path(self) -> Path:
        return self.state_dir / "meta.json"

    @property
    def session_state_path(self) -> Path:
        return self.state_dir / "session.dat"

    def ensure_dirs(self) -> None:
        for path in (self.state_dir, self.resume_dir, self.torrents_dir):
            path.mkdir(parents=True, exist_ok=True)
        if self.data["download_dir"]:
            Path(self.data["download_dir"]).expanduser().mkdir(parents=True, exist_ok=True)


def _coerce(default: Any, value: Any) -> Any:
    """Coerce an incoming JSON value to the type of its default.

    The web UI sends everything through JSON, and browsers are loose about
    number/string/bool distinctions in form inputs. Rather than trusting the
    wire type we pin each value to the shape its default declares.
    """
    if isinstance(default, bool):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(default, int):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return default
    if isinstance(default, float):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default
    if isinstance(default, str):
        return "" if value is None else str(value)
    return value


def default_state_dir() -> Path:
    """Follow the XDG spec, with a sane fallback."""
    base = os.environ.get("XDG_DATA_HOME")
    root = Path(base) if base else Path.home() / ".local" / "share"
    return root / "fission"


def disk_free(path: str | Path) -> int:
    """Bytes free on the filesystem holding *path* (0 if unknown)."""
    try:
        target = Path(path).expanduser()
        while not target.exists() and target != target.parent:
            target = target.parent
        return shutil.disk_usage(target).free
    except OSError:
        return 0
