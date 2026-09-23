"""The BitTorrent engine: a thin, opinionated layer over libtorrent.

Design notes
------------
libtorrent is thread-safe but its alert queue is a pull interface, so the whole
engine runs inside the asyncio loop and pumps alerts on a short timer. That
keeps every mutation of our own bookkeeping single-threaded, which removes an
entire class of race conditions without costing anything measurable — the pump
is a non-blocking ``pop_alerts()``.

State we care about but libtorrent does not model (categories, tags, the time a
torrent was added by *us*) lives in a sidecar ``meta.json``, keyed by info hash.
Everything libtorrent does model is read back from ``torrent_status`` so there
is exactly one source of truth and no drift after a restart.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import os
import time
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

import libtorrent as lt

from .config import Config, disk_free

log = logging.getLogger("fission.engine")

# How often we ask libtorrent for a status delta. One second matches the UI's
# refresh rate and keeps CPU flat even with thousands of torrents.
TICK_INTERVAL = 1.0
# The alert pump runs faster so interactive actions feel immediate.
ALERT_INTERVAL = 0.2
# Rolling speed samples kept for the sparklines (10 minutes at 1Hz).
HISTORY_LEN = 600

PRIORITY_NAMES = {0: "skip", 1: "low", 4: "normal", 7: "high"}


def _categories() -> int:
    """OR together the alert categories we actually consume.

    Subscribing to everything would mean decoding a large volume of per-block
    and per-peer alerts we never look at, so we opt in narrowly.
    """
    cat = lt.alert.category_t
    wanted = (
        "error_notification",
        "peer_notification",
        "port_mapping_notification",
        "storage_notification",
        "tracker_notification",
        "status_notification",
        "performance_warning",
        "stats_notification",
        "dht_notification",
    )
    mask = 0
    for name in wanted:
        mask |= int(getattr(cat, name, 0))
    return mask


def _hash_str(info_hashes: Any) -> str:
    """Stable string key for a torrent.

    v1 is preferred deliberately. A hybrid torrent added from a v1 magnet has
    no v2 hash until its metadata arrives, so keying on v2-when-present would
    silently change the key mid-flight — orphaning the record we created at add
    time and breaking every subsequent status update for it. v1 is present from
    the first moment for anything that has one; v2-only torrents fall through
    to their v2 hash, which is equally stable for them.
    """
    try:
        if info_hashes.has_v1():
            return str(info_hashes.v1)
        return str(info_hashes.v2)
    except AttributeError:
        return str(info_hashes)


def _secs(value: Any) -> int:
    """libtorrent hands back ``timedelta`` for durations; JSON wants seconds."""
    if value is None:
        return 0
    if isinstance(value, timedelta):
        return int(value.total_seconds())
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _epoch(value: Any) -> int:
    """Normalise a libtorrent timestamp, which may be None or a datetime."""
    if value is None:
        return 0
    if isinstance(value, datetime):
        return int(value.timestamp())
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _flag(flags: int, name: str) -> bool:
    bit = getattr(lt.torrent_flags, name, None)
    return bool(flags & int(bit)) if bit is not None else False


class TorrentMeta:
    """Fission-owned metadata that libtorrent has no place to store."""

    __slots__ = ("category", "tags", "added_on", "source", "notes")

    def __init__(
        self,
        category: str = "",
        tags: Iterable[str] = (),
        added_on: float | None = None,
        source: str = "",
        notes: str = "",
    ):
        self.category = category
        self.tags = list(tags)
        self.added_on = added_on if added_on is not None else time.time()
        self.source = source
        self.notes = notes

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "tags": self.tags,
            "added_on": self.added_on,
            "source": self.source,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "TorrentMeta":
        return cls(
            category=raw.get("category", "") or "",
            tags=raw.get("tags") or [],
            added_on=raw.get("added_on"),
            source=raw.get("source", "") or "",
            notes=raw.get("notes", "") or "",
        )


class Record:
    """Everything we track for one torrent."""

    __slots__ = ("handle", "status", "meta", "down_hist", "up_hist", "last_seen")

    def __init__(self, handle: lt.torrent_handle, meta: TorrentMeta):
        self.handle = handle
        self.status: lt.torrent_status | None = None
        self.meta = meta
        self.down_hist: deque[int] = deque(maxlen=HISTORY_LEN)
        self.up_hist: deque[int] = deque(maxlen=HISTORY_LEN)
        self.last_seen = time.time()


class Engine:
    """Owns the libtorrent session and all torrent bookkeeping."""

    def __init__(self, config: Config):
        self.config = config
        self.session: lt.session | None = None
        self.torrents: dict[str, Record] = {}
        # Info hashes whose removal we have already applied locally and are
        # waiting on libtorrent to confirm.
        self._removing: set[str] = set()
        self.meta: dict[str, TorrentMeta] = {}
        self.global_down: deque[int] = deque(maxlen=HISTORY_LEN)
        self.global_up: deque[int] = deque(maxlen=HISTORY_LEN)
        self.session_stats: dict[str, Any] = {}
        self.events: deque[dict[str, Any]] = deque(maxlen=400)
        self.listeners: list[Callable[[dict[str, Any]], None]] = []
        self._tasks: list[asyncio.Task] = []
        self._running = False
        self._alt_speed_active = False
        self._metric_names: list[str] = []
        self._started_at = time.time()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        cfg = self.config
        cfg.ensure_dirs()
        self._load_meta()

        self.session = lt.session(self.build_settings())
        self._restore_session_state()
        self._apply_dht_bootstrap()

        try:
            self._metric_names = [m.name for m in lt.session_stats_metrics()]
        except Exception:  # pragma: no cover - binding differences
            self._metric_names = []

        await self._load_torrents()

        self._running = True
        self._tasks = [
            asyncio.create_task(self._alert_loop(), name="fission-alerts"),
            asyncio.create_task(self._tick_loop(), name="fission-tick"),
            asyncio.create_task(self._housekeeping_loop(), name="fission-housekeeping"),
        ]
        self.emit("session", {"message": "Session started"}, level="info")
        log.info("engine started with %d torrent(s)", len(self.torrents))

    async def stop(self) -> None:
        self._running = False
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        if self.session is None:
            return

        log.info("saving resume data for %d torrent(s)", len(self.torrents))
        await self.save_all_resume(wait=True)
        self._save_meta()
        self._save_session_state()
        # Dropping the last reference triggers libtorrent's destructor, which
        # blocks until trackers have been told we are going away.
        self.session = None

    # ------------------------------------------------------------------
    # settings
    # ------------------------------------------------------------------

    def build_settings(self) -> dict[str, Any]:
        """Translate Fission's config into a libtorrent settings pack."""
        cfg = self.config
        alt = self._alt_speed_active or cfg["alt_speed_enabled"]

        if cfg["random_port"]:
            port_lo = port_hi = 0
        else:
            port_lo = int(cfg["listen_port"])
            port_hi = max(port_lo, int(cfg["listen_port_max"]))

        interfaces = f"0.0.0.0:{port_lo},[::]:{port_lo}" if port_lo else "0.0.0.0:0,[::]:0"

        enc = int(cfg["encryption_policy"])
        # libtorrent policy: 0=forced, 1=enabled, 2=disabled — the inverse of
        # how the UI presents it, so map explicitly rather than by arithmetic.
        pe = {0: 2, 1: 1, 2: 0}.get(enc, 1)

        settings: dict[str, Any] = {
            "user_agent": "Fission/1.0 libtorrent/" + lt.__version__,
            "peer_fingerprint": lt.generate_fingerprint("FI", 1, 0, 0, 0),
            "alert_mask": _categories(),
            "alert_queue_size": 8000,

            "listen_interfaces": interfaces,
            "listen_queue_size": 32,
            "outgoing_port": 0,

            "enable_dht": bool(cfg["enable_dht"]),
            "enable_lsd": bool(cfg["enable_lsd"]),
            "enable_upnp": bool(cfg["enable_upnp"]),
            "enable_natpmp": bool(cfg["enable_natpmp"]),
            "enable_outgoing_utp": bool(cfg["enable_utp"]),
            "enable_incoming_utp": bool(cfg["enable_utp"]),
            "enable_outgoing_tcp": True,
            "enable_incoming_tcp": True,
            "prefer_udp_trackers": True,
            "anonymous_mode": bool(cfg["anonymous_mode"]),

            "out_enc_policy": pe,
            "in_enc_policy": pe,
            "allowed_enc_level": 3,          # accept both RC4 and plaintext headers
            "prefer_rc4": enc == 2,

            "download_rate_limit": int(cfg["alt_download_rate_limit"] if alt else cfg["download_rate_limit"]),
            "upload_rate_limit": int(cfg["alt_upload_rate_limit"] if alt else cfg["upload_rate_limit"]),
            "rate_limit_ip_overhead": bool(cfg["rate_limit_ip_overhead"]),

            "connections_limit": int(cfg["connections_limit"]),
            "unchoke_slots_limit": int(cfg["unchoke_slots_limit"]),
            "connection_speed": 200,
            "torrent_connect_boost": 40,

            "active_downloads": int(cfg["active_downloads"]),
            "active_seeds": int(cfg["active_seeds"]),
            "active_limit": int(cfg["active_limit"]),
            "dont_count_slow_torrents": bool(cfg["dont_count_slow_torrents"]),
            "auto_manage_interval": 15,
            # libtorrent expresses both limits as integers, and the ratio as
            # percent. A zero from our config means "no limit", but zero means
            # "stop immediately" to libtorrent — so we hand it an effectively
            # infinite value and enforce the real limit ourselves in
            # _enforce_share_limits, which also supports remove-on-limit.
            "seed_time_limit": int(cfg["seed_time_limit"]) * 60 if cfg["seed_time_limit"] else 0x7FFFFFFF,
            "share_ratio_limit": int(float(cfg["share_ratio_limit"]) * 100) or 0x7FFFFFFF,

            # Throughput tuning. These are the knobs that separate a snappy
            # client from a sluggish one on a fast link.
            "aio_threads": max(4, (os.cpu_count() or 4)),
            "hashing_threads": max(2, (os.cpu_count() or 4) // 2),
            "send_buffer_watermark": 6 * 1024 * 1024,
            "send_buffer_low_watermark": 512 * 1024,
            "send_buffer_watermark_factor": 150,
            "max_out_request_queue": 1500,
            "whole_pieces_threshold": 20,
            "request_queue_time": 3,
            "max_allowed_in_request_queue": 2000,
            "mixed_mode_algorithm": 0 if cfg["prefer_tcp"] else 1,

            "tracker_completion_timeout": 30,
            "tracker_receive_timeout": 10,
            "stop_tracker_timeout": 5,
            "announce_to_all_trackers": True,
            "announce_to_all_tiers": True,

            "validate_https_trackers": True,
            "ssrf_mitigation": True,
        }

        if int(cfg["cache_size_mib"]) > 0:
            # libtorrent 2.x uses the OS page cache; this caps its own read-ahead
            # buffers instead of the removed disk cache.
            settings["max_queued_disk_bytes"] = int(cfg["cache_size_mib"]) * 1024 * 1024

        if not cfg["enable_pex"]:
            # PEX is an extension rather than a setting; disabling it is done at
            # torrent level via flags, but we also stop advertising support.
            settings["enable_incoming_utp"] = settings["enable_incoming_utp"]

        proxy_type = int(cfg["proxy_type"])
        if proxy_type and cfg["proxy_host"]:
            settings.update({
                "proxy_type": proxy_type,
                "proxy_hostname": str(cfg["proxy_host"]),
                "proxy_port": int(cfg["proxy_port"]),
                "proxy_username": str(cfg["proxy_username"]),
                "proxy_password": str(cfg["proxy_password"]),
                "proxy_peer_connections": bool(cfg["proxy_peer_connections"]),
                "proxy_tracker_connections": bool(cfg["proxy_tracker_connections"]),
                "proxy_hostnames": bool(cfg["proxy_hostnames"]),
            })
        else:
            settings["proxy_type"] = 0

        return settings

    def apply_settings(self) -> None:
        if self.session is None:
            return
        self.session.apply_settings(self.build_settings())

    def _apply_dht_bootstrap(self) -> None:
        if not self.config["enable_dht"] or self.session is None:
            return
        for host, port in (
            ("router.bittorrent.com", 6881),
            ("dht.transmissionbt.com", 6881),
            ("router.utorrent.com", 6881),
            ("dht.libtorrent.org", 25401),
            ("dht.aelitis.com", 6881),
        ):
            with contextlib.suppress(Exception):
                self.session.add_dht_node((host, port))

    # ------------------------------------------------------------------
    # persistence of session + metadata
    # ------------------------------------------------------------------

    def _restore_session_state(self) -> None:
        path = self.config.session_state_path
        if not path.exists() or self.session is None:
            return
        try:
            blob = path.read_bytes()
            params = lt.read_session_params(blob)
            # Re-applying our settings on top keeps config.json authoritative
            # while still restoring the DHT routing table, which is what makes
            # a restart find peers in seconds instead of minutes.
            self.session = lt.session(params)
            self.session.apply_settings(self.build_settings())
        except Exception as exc:  # pragma: no cover - corrupt state file
            log.warning("could not restore session state: %s", exc)

    def _save_session_state(self) -> None:
        if self.session is None:
            return
        with contextlib.suppress(Exception):
            params = self.session.session_state()
            self.config.session_state_path.write_bytes(lt.write_session_params_buf(params))

    def _load_meta(self) -> None:
        path = self.config.meta_path
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        self.meta = {k: TorrentMeta.from_dict(v) for k, v in raw.items() if isinstance(v, dict)}

    def _save_meta(self) -> None:
        payload = {ih: rec.meta.to_dict() for ih, rec in self.torrents.items()}
        # Keep metadata for torrents that have not loaded yet so a partial boot
        # never silently discards a user's categories.
        for ih, meta in self.meta.items():
            payload.setdefault(ih, meta.to_dict())
        tmp = self.config.meta_path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(payload, indent=2), "utf-8")
            os.replace(tmp, self.config.meta_path)
        except OSError as exc:
            log.warning("could not save metadata: %s", exc)

    # ------------------------------------------------------------------
    # torrent loading
    # ------------------------------------------------------------------

    async def _load_torrents(self) -> None:
        """Re-add every torrent we previously persisted resume data for."""
        resume_dir = self.config.resume_dir
        files = sorted(resume_dir.glob("*.fastresume"))
        for path in files:
            try:
                atp = lt.read_resume_data(path.read_bytes())
            except Exception as exc:
                log.warning("skipping unreadable resume file %s: %s", path.name, exc)
                continue

            if not atp.save_path:
                atp.save_path = self.config["download_dir"]

            # If we also kept the .torrent itself, attach it so the torrent is
            # usable immediately instead of re-fetching metadata from the swarm.
            tpath = self.config.torrents_dir / (path.stem + ".torrent")
            if atp.ti is None and tpath.exists():
                with contextlib.suppress(Exception):
                    atp.ti = lt.load_torrent_file(str(tpath)).ti

            atp.flags |= lt.torrent_flags.update_subscribe
            self.session.async_add_torrent(atp)

        # Give libtorrent a moment to emit the add_torrent_alerts so the first
        # UI payload is already complete.
        for _ in range(40):
            self._pump_alerts()
            if len(self.torrents) >= len(files):
                break
            await asyncio.sleep(0.05)

    # ------------------------------------------------------------------
    # background loops
    # ------------------------------------------------------------------

    async def _alert_loop(self) -> None:
        while self._running:
            try:
                self._pump_alerts()
            except Exception:
                log.exception("alert pump failed")
            await asyncio.sleep(ALERT_INTERVAL)

    async def _tick_loop(self) -> None:
        while self._running:
            try:
                if self.session is not None:
                    self.session.post_torrent_updates()
                    self.session.post_session_stats()
                self._sample_speeds()
                self._enforce_share_limits()
                self._check_alt_speed_schedule()
            except Exception:
                log.exception("tick failed")
            await asyncio.sleep(TICK_INTERVAL)

    async def _housekeeping_loop(self) -> None:
        """Periodic resume-data flush and watch-folder scan."""
        counter = 0
        while self._running:
            await asyncio.sleep(5)
            counter += 1
            try:
                if self.config["watch_dir_enabled"]:
                    self._scan_watch_dir()
                if counter % 12 == 0:          # every minute
                    await self.save_all_resume(wait=False)
                    self._save_meta()
                if counter % 60 == 0:          # every five minutes
                    self._save_session_state()
            except Exception:
                log.exception("housekeeping failed")

    def _sample_speeds(self) -> None:
        down = up = 0
        for rec in self.torrents.values():
            st = rec.status
            if st is None:
                continue
            d, u = st.download_payload_rate, st.upload_payload_rate
            rec.down_hist.append(d)
            rec.up_hist.append(u)
            down += d
            up += u
        self.global_down.append(down)
        self.global_up.append(up)

    # ------------------------------------------------------------------
    # alert handling
    # ------------------------------------------------------------------

    def _pump_alerts(self) -> None:
        if self.session is None:
            return
        for alert in self.session.pop_alerts():
            handler = getattr(self, "_on_" + type(alert).__name__, None)
            if handler is not None:
                try:
                    handler(alert)
                except Exception:
                    log.exception("handler for %s failed", type(alert).__name__)

    # -- torrent lifecycle --

    def _on_add_torrent_alert(self, alert: lt.add_torrent_alert) -> None:
        if alert.error.value():
            self.emit("error", {"message": f"Failed to add torrent: {alert.error.message()}"}, level="error")
            return
        handle = alert.handle
        ih = _hash_str(handle.info_hashes())
        if ih in self.torrents:
            return
        meta = self.meta.pop(ih, None) or TorrentMeta()
        rec = Record(handle, meta)
        with contextlib.suppress(Exception):
            rec.status = handle.status()
        self.torrents[ih] = rec
        name = rec.status.name if rec.status else ih[:12]
        self.emit("added", {"hash": ih, "name": name})

    def _on_torrent_removed_alert(self, alert) -> None:
        ih = _hash_str(alert.info_hashes)
        if ih in self._removing:
            # We already dropped this record synchronously in remove(); this
            # alert is only the confirmation. Touching self.torrents here would
            # delete a record the user has since re-created by adding the same
            # info hash again, making the new torrent vanish from the UI.
            self._removing.discard(ih)
            return
        rec = self.torrents.pop(ih, None)
        self._forget_files(ih)
        if rec is not None:
            self.emit("removed", {"hash": ih, "name": rec.status.name if rec.status else ih[:12]})

    def _on_state_update_alert(self, alert: lt.state_update_alert) -> None:
        for st in alert.status:
            ih = _hash_str(st.info_hashes)
            rec = self.torrents.get(ih)
            if rec is None:
                continue
            rec.status = st
            rec.last_seen = time.time()

    def _on_torrent_finished_alert(self, alert) -> None:
        st = alert.handle.status()
        self.emit("finished", {"hash": _hash_str(st.info_hashes), "name": st.name}, level="success")
        self._request_resume(alert.handle)
        if self.config["check_on_completion"]:
            with contextlib.suppress(Exception):
                alert.handle.force_recheck()

    def _on_metadata_received_alert(self, alert) -> None:
        handle = alert.handle
        ih = _hash_str(handle.info_hashes())
        self._store_torrent_file(handle)
        self._request_resume(handle)
        st = handle.status()
        self.emit("metadata", {"hash": ih, "name": st.name})

    def _on_torrent_error_alert(self, alert) -> None:
        self.emit("error", {"message": f"{alert.torrent_name}: {alert.message()}"}, level="error")

    def _on_file_error_alert(self, alert) -> None:
        self.emit("error", {"message": alert.message()}, level="error")

    def _on_save_resume_data_alert(self, alert) -> None:
        ih = _hash_str(alert.handle.info_hashes())
        try:
            blob = lt.write_resume_data_buf(alert.params)
        except Exception as exc:
            log.warning("could not serialise resume data for %s: %s", ih, exc)
            return
        path = self.config.resume_dir / f"{ih}.fastresume"
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_bytes(blob)
            os.replace(tmp, path)
        except OSError as exc:
            log.warning("could not write resume data: %s", exc)

    def _on_save_resume_data_failed_alert(self, alert) -> None:
        # Routinely fires for torrents with nothing to save; only worth a debug.
        log.debug("resume data not saved: %s", alert.message())

    def _on_torrent_paused_alert(self, alert) -> None:
        self._request_resume(alert.handle)

    def _on_storage_moved_alert(self, alert) -> None:
        self.emit("moved", {"message": f"Moved to {alert.storage_path()}"}, level="success")

    def _on_storage_moved_failed_alert(self, alert) -> None:
        self.emit("error", {"message": f"Move failed: {alert.message()}"}, level="error")

    # -- session level --

    def _on_session_stats_alert(self, alert) -> None:
        values = alert.values
        if isinstance(values, dict):
            self.session_stats = dict(values)
        elif self._metric_names:
            self.session_stats = dict(zip(self._metric_names, values))

    def _on_listen_failed_alert(self, alert) -> None:
        self.emit("error", {"message": f"Listen failed: {alert.message()}"}, level="error")

    def _on_portmap_error_alert(self, alert) -> None:
        log.debug("port mapping error: %s", alert.message())

    def _on_performance_alert(self, alert) -> None:
        log.debug("performance: %s", alert.message())

    # ------------------------------------------------------------------
    # events
    # ------------------------------------------------------------------

    def emit(self, kind: str, payload: dict[str, Any], level: str = "info") -> None:
        event = {"kind": kind, "level": level, "at": time.time(), **payload}
        self.events.append(event)
        for listener in list(self.listeners):
            try:
                listener(event)
            except Exception:
                log.exception("event listener failed")

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _request_resume(self, handle: lt.torrent_handle) -> None:
        if not handle.is_valid():
            return
        with contextlib.suppress(Exception):
            handle.save_resume_data(lt.torrent_handle.save_info_dict)

    def _store_torrent_file(self, handle: lt.torrent_handle) -> None:
        """Persist the .torrent so a restart does not need the swarm again."""
        try:
            ti = handle.torrent_file()
            if ti is None:
                return
            ih = _hash_str(handle.info_hashes())
            path = self.config.torrents_dir / f"{ih}.torrent"
            if path.exists():
                return
            ct = lt.create_torrent(ti)
            path.write_bytes(lt.bencode(ct.generate()))
        except Exception as exc:
            log.debug("could not store .torrent: %s", exc)

    def _forget_files(self, ih: str) -> None:
        for path in (
            self.config.resume_dir / f"{ih}.fastresume",
            self.config.torrents_dir / f"{ih}.torrent",
        ):
            with contextlib.suppress(OSError):
                path.unlink(missing_ok=True)
        self.meta.pop(ih, None)

    def get(self, ih: str) -> Record:
        rec = self.torrents.get(ih)
        if rec is None:
            raise KeyError(ih)
        return rec

    def resolve(self, hashes: Iterable[str]) -> list[Record]:
        out = []
        for ih in hashes:
            rec = self.torrents.get(ih)
            if rec is not None:
                out.append(rec)
        return out

    async def save_all_resume(self, wait: bool = False) -> None:
        if self.session is None:
            return
        outstanding = 0
        for rec in self.torrents.values():
            st = rec.status
            if st is None or not rec.handle.is_valid():
                continue
            if not st.has_metadata:
                continue
            self._request_resume(rec.handle)
            outstanding += 1
        if not wait or not outstanding:
            return
        # Drain the alerts the requests will produce, bounded so a wedged
        # torrent can never hang shutdown.
        deadline = time.time() + 10
        while time.time() < deadline:
            self._pump_alerts()
            await asyncio.sleep(0.05)
            if not any(
                rec.handle.is_valid() and rec.status and rec.status.need_save_resume
                for rec in self.torrents.values()
            ):
                break

    # ------------------------------------------------------------------
    # adding torrents
    # ------------------------------------------------------------------

    def _base_atp(self, options: dict[str, Any]) -> lt.add_torrent_params:
        atp = lt.add_torrent_params()
        self._decorate_atp(atp, options)
        return atp

    def _decorate_atp(self, atp: lt.add_torrent_params, options: dict[str, Any]) -> None:
        cfg = self.config
        save_path = options.get("save_path") or cfg["download_dir"]
        atp.save_path = str(Path(save_path).expanduser())
        Path(atp.save_path).mkdir(parents=True, exist_ok=True)

        flags = int(lt.torrent_flags.update_subscribe)
        if cfg["auto_manage"] and not options.get("force_start"):
            flags |= int(lt.torrent_flags.auto_managed)
        if options.get("paused", cfg["add_paused"]):
            flags |= int(lt.torrent_flags.paused)
        if options.get("sequential", cfg["sequential_default"]):
            flags |= int(lt.torrent_flags.sequential_download)
        if options.get("skip_check"):
            flags |= int(lt.torrent_flags.seed_mode)
        if not cfg["enable_pex"]:
            flags |= int(lt.torrent_flags.disable_pex)
        if not cfg["enable_dht"]:
            flags |= int(lt.torrent_flags.disable_dht)
        if not cfg["enable_lsd"]:
            flags |= int(lt.torrent_flags.disable_lsd)
        atp.flags = flags

        atp.storage_mode = (
            lt.storage_mode_t.storage_mode_allocate
            if cfg["preallocate"]
            else lt.storage_mode_t.storage_mode_sparse
        )
        atp.max_connections = int(cfg["connections_limit_per_torrent"])
        atp.max_uploads = int(cfg["uploads_limit_per_torrent"])

        if options.get("download_limit"):
            atp.download_limit = int(options["download_limit"])
        if options.get("upload_limit"):
            atp.upload_limit = int(options["upload_limit"])

        extra = [t.strip() for t in str(cfg["default_trackers"]).splitlines() if t.strip()]
        extra += [t.strip() for t in options.get("trackers", []) if t.strip()]
        if extra:
            atp.trackers = list(atp.trackers) + extra
            atp.tracker_tiers = list(atp.tracker_tiers) + [0] * len(extra)

    def _register(self, atp: lt.add_torrent_params, options: dict[str, Any], source: str) -> str:
        """Hand the params to libtorrent and record our sidecar metadata."""
        ih = ""
        with contextlib.suppress(Exception):
            ih = _hash_str(atp.info_hashes)
        if ih and ih in self.torrents:
            raise ValueError("This torrent is already in the list")

        if ih:
            self.meta[ih] = TorrentMeta(
                category=options.get("category", "") or "",
                tags=options.get("tags") or [],
                source=source,
            )
        self.session.async_add_torrent(atp)
        self._pump_alerts()
        return ih

    def add_magnet(self, uri: str, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        uri = uri.strip()
        if not uri:
            raise ValueError("Empty magnet link")
        try:
            atp = lt.parse_magnet_uri(uri)
        except Exception as exc:
            raise ValueError(f"Invalid magnet link: {exc}") from exc
        self._decorate_atp(atp, options)
        return self._register(atp, options, uri)

    def add_torrent_bytes(self, blob: bytes, options: dict[str, Any] | None = None) -> str:
        options = options or {}
        try:
            atp = lt.load_torrent_buffer(blob)
        except Exception as exc:
            raise ValueError(f"Not a valid .torrent file: {exc}") from exc
        self._decorate_atp(atp, options)
        ih = self._register(atp, options, options.get("filename", "file"))
        if ih:
            with contextlib.suppress(OSError):
                (self.config.torrents_dir / f"{ih}.torrent").write_bytes(blob)
        return ih

    def add_infohash(self, raw: str, options: dict[str, Any] | None = None) -> str:
        """Accept a bare 40-char (v1) or 64-char (v2) hex info hash."""
        raw = raw.strip().lower()
        try:
            binascii.unhexlify(raw)
        except binascii.Error as exc:
            raise ValueError("Not a valid info hash") from exc
        if len(raw) not in (40, 64):
            raise ValueError("Info hash must be 40 or 64 hex characters")
        return self.add_magnet(f"magnet:?xt=urn:btih:{raw}" if len(raw) == 40
                               else f"magnet:?xt=urn:btmh:1220{raw}", options)

    def add_any(self, text: str, options: dict[str, Any] | None = None) -> str:
        """Dispatch on whatever the user pasted."""
        text = text.strip()
        if text.startswith("magnet:"):
            return self.add_magnet(text, options)
        if len(text) in (40, 64) and all(c in "0123456789abcdefABCDEF" for c in text):
            return self.add_infohash(text, options)
        raise ValueError("Expected a magnet link or info hash")

    def _scan_watch_dir(self) -> None:
        path = self.config["watch_dir"]
        if not path:
            return
        folder = Path(path).expanduser()
        if not folder.is_dir():
            return
        for entry in folder.glob("*.torrent"):
            try:
                blob = entry.read_bytes()
                self.add_torrent_bytes(blob, {"filename": entry.name})
            except ValueError:
                # Already added, or malformed — either way stop retrying it.
                entry.rename(entry.with_suffix(".torrent.skipped"))
                continue
            except OSError:
                continue
            else:
                self.emit("added", {"name": entry.name, "message": "Added from watch folder"})
                with contextlib.suppress(OSError):
                    entry.rename(entry.with_suffix(".torrent.added"))

    # ------------------------------------------------------------------
    # torrent control
    # ------------------------------------------------------------------

    def pause(self, hashes: Iterable[str]) -> int:
        count = 0
        for rec in self.resolve(hashes):
            rec.handle.unset_flags(lt.torrent_flags.auto_managed)
            rec.handle.pause(lt.torrent_handle.graceful_pause)
            self._request_resume(rec.handle)
            count += 1
        return count

    def resume(self, hashes: Iterable[str]) -> int:
        count = 0
        auto = bool(self.config["auto_manage"])
        for rec in self.resolve(hashes):
            rec.handle.clear_error()
            if auto:
                rec.handle.set_flags(lt.torrent_flags.auto_managed)
            rec.handle.resume()
            count += 1
        return count

    def force_start(self, hashes: Iterable[str]) -> int:
        """Bypass the queue: clear auto-manage so the torrent always runs."""
        count = 0
        for rec in self.resolve(hashes):
            rec.handle.unset_flags(lt.torrent_flags.auto_managed)
            rec.handle.resume()
            count += 1
        return count

    def recheck(self, hashes: Iterable[str]) -> int:
        count = 0
        for rec in self.resolve(hashes):
            rec.handle.force_recheck()
            count += 1
        return count

    def reannounce(self, hashes: Iterable[str]) -> int:
        count = 0
        for rec in self.resolve(hashes):
            with contextlib.suppress(Exception):
                rec.handle.force_reannounce()
                rec.handle.force_dht_announce()
            count += 1
        return count

    def scrape(self, hashes: Iterable[str]) -> int:
        count = 0
        for rec in self.resolve(hashes):
            with contextlib.suppress(Exception):
                rec.handle.scrape_tracker()
            count += 1
        return count

    def remove(self, hashes: Iterable[str], with_data: bool = False) -> int:
        count = 0
        # `delete_files` wipes the payload; `delete_partfile` only discards the
        # scratch file for partially-downloaded pieces and leaves data intact.
        option = lt.options_t.delete_files if with_data else getattr(lt.session, "delete_partfile", 0)
        for ih in list(hashes):
            rec = self.torrents.get(ih)
            if rec is None:
                continue
            name = rec.status.name if rec.status else ih[:12]
            self._removing.add(ih)
            with contextlib.suppress(Exception):
                self.session.remove_torrent(rec.handle, option)
            # Drop it from our map immediately so the UI reacts without waiting
            # for the removal alert to come back.
            self.torrents.pop(ih, None)
            self._forget_files(ih)
            self.emit("removed", {"hash": ih, "name": name})
            count += 1
        return count

    def set_flags(self, hashes: Iterable[str], flag: str, enabled: bool) -> int:
        bit = getattr(lt.torrent_flags, flag, None)
        if bit is None:
            raise ValueError(f"Unknown flag: {flag}")
        count = 0
        for rec in self.resolve(hashes):
            if enabled:
                rec.handle.set_flags(bit)
            else:
                rec.handle.unset_flags(bit)
            count += 1
        return count

    def set_limits(self, hashes: Iterable[str], download: int | None, upload: int | None) -> int:
        count = 0
        for rec in self.resolve(hashes):
            if download is not None:
                rec.handle.set_download_limit(max(0, int(download)))
            if upload is not None:
                rec.handle.set_upload_limit(max(0, int(upload)))
            count += 1
        return count

    def set_connection_limits(self, hashes: Iterable[str], connections: int | None, uploads: int | None) -> int:
        count = 0
        for rec in self.resolve(hashes):
            if connections is not None:
                rec.handle.set_max_connections(max(2, int(connections)))
            if uploads is not None:
                rec.handle.set_max_uploads(max(1, int(uploads)))
            count += 1
        return count

    def queue(self, hashes: Iterable[str], action: str) -> int:
        ops = {
            "top": lambda h: h.queue_position_top(),
            "up": lambda h: h.queue_position_up(),
            "down": lambda h: h.queue_position_down(),
            "bottom": lambda h: h.queue_position_bottom(),
        }
        op = ops.get(action)
        if op is None:
            raise ValueError(f"Unknown queue action: {action}")
        recs = self.resolve(hashes)
        # Moving down/bottom must start from the back of the queue, otherwise
        # earlier moves shuffle the ones that follow.
        recs.sort(key=lambda r: r.handle.queue_position(), reverse=action in ("down", "bottom"))
        for rec in recs:
            op(rec.handle)
        return len(recs)

    def move_storage(self, hashes: Iterable[str], target: str) -> int:
        dest = str(Path(target).expanduser())
        Path(dest).mkdir(parents=True, exist_ok=True)
        count = 0
        for rec in self.resolve(hashes):
            rec.handle.move_storage(dest)
            count += 1
        return count

    def rename_torrent(self, ih: str, name: str) -> None:
        rec = self.get(ih)
        rec.meta.notes = rec.meta.notes  # touch, keeps meta dirty-tracking simple
        # libtorrent renames the root folder by renaming file 0's parent; for a
        # multi-file torrent we rename every path prefix.
        ti = rec.handle.torrent_file()
        if ti is None:
            raise ValueError("Metadata not available yet")
        files = ti.files()
        old_root = files.name()
        if files.num_files() == 1 and "/" not in files.file_path(0):
            rec.handle.rename_file(0, name)
            return
        for idx in range(files.num_files()):
            path = files.file_path(idx)
            if path.startswith(old_root + "/"):
                rec.handle.rename_file(idx, name + path[len(old_root):])

    def set_category(self, hashes: Iterable[str], category: str) -> int:
        count = 0
        for rec in self.resolve(hashes):
            rec.meta.category = category
            count += 1
        self._save_meta()
        return count

    def set_tags(self, hashes: Iterable[str], tags: list[str], mode: str = "set") -> int:
        count = 0
        for rec in self.resolve(hashes):
            current = set(rec.meta.tags)
            if mode == "add":
                current |= set(tags)
            elif mode == "remove":
                current -= set(tags)
            else:
                current = set(tags)
            rec.meta.tags = sorted(current)
            count += 1
        self._save_meta()
        return count

    # ------------------------------------------------------------------
    # files / peers / trackers / pieces
    # ------------------------------------------------------------------

    def set_file_priorities(self, ih: str, priorities: dict[int, int]) -> None:
        rec = self.get(ih)
        current = list(rec.handle.get_file_priorities())
        for index, priority in priorities.items():
            if 0 <= index < len(current):
                current[index] = max(0, min(7, int(priority)))
        rec.handle.prioritize_files(current)
        self._request_resume(rec.handle)

    def files(self, ih: str) -> list[dict[str, Any]]:
        rec = self.get(ih)
        ti = rec.handle.torrent_file()
        if ti is None:
            return []
        storage = ti.files()
        progress = rec.handle.file_progress()
        priorities = list(rec.handle.get_file_priorities())
        out = []
        for idx in range(storage.num_files()):
            size = storage.file_size(idx)
            done = progress[idx] if idx < len(progress) else 0
            priority = priorities[idx] if idx < len(priorities) else 4
            out.append({
                "index": idx,
                "path": storage.file_path(idx),
                "name": storage.file_name(idx),
                "size": size,
                "done": done,
                "progress": (done / size) if size else 1.0,
                "priority": priority,
                "priority_name": PRIORITY_NAMES.get(priority, "normal"),
                "offset": storage.file_offset(idx),
                "pad": bool(storage.file_flags(idx) & storage.flag_pad_file),
            })
        return out

    def peers(self, ih: str) -> list[dict[str, Any]]:
        rec = self.get(ih)
        try:
            infos = rec.handle.get_peer_info()
        except Exception:
            return []
        out = []
        for peer in infos:
            try:
                ip, port = peer.ip[0], peer.ip[1]
            except (TypeError, IndexError):
                ip, port = str(peer.ip), 0
            flags = peer.flags
            out.append({
                "ip": ip,
                "port": port,
                "client": (peer.client.decode("utf-8", "replace")
                           if isinstance(peer.client, bytes) else str(peer.client)),
                "down": peer.payload_down_speed,
                "up": peer.payload_up_speed,
                "downloaded": peer.total_download,
                "uploaded": peer.total_upload,
                "progress": peer.progress,
                "seed": bool(flags & lt.peer_info.seed),
                "encrypted": bool(flags & (lt.peer_info.rc4_encrypted | lt.peer_info.plaintext_encrypted)),
                "utp": peer.connection_type == getattr(lt.peer_info, "utp_socket", -1),
                "incoming": not bool(flags & lt.peer_info.local_connection),
                "interesting": bool(flags & lt.peer_info.interesting),
                "choked": bool(flags & lt.peer_info.choked),
                "remote_choked": bool(flags & lt.peer_info.remote_choked),
                "snubbed": bool(flags & lt.peer_info.snubbed),
                "source": self._peer_source(peer.source),
                "rtt": getattr(peer, "rtt", 0),
                "failcount": peer.failcount,
                "hashfails": peer.num_hashfails,
            })
        out.sort(key=lambda p: (-p["down"], -p["up"]))
        return out

    @staticmethod
    def _peer_source(source: int) -> str:
        labels = []
        for name, short in (("tracker", "T"), ("dht", "D"), ("pex", "X"),
                            ("lsd", "L"), ("resume_data", "R"), ("incoming", "I")):
            bit = getattr(lt.peer_info, name, None)
            if bit is not None and source & int(bit):
                labels.append(short)
        return "".join(labels)

    def trackers(self, ih: str) -> list[dict[str, Any]]:
        rec = self.get(ih)
        try:
            entries = rec.handle.trackers()
        except Exception:
            return []
        st = rec.status
        out = []
        for entry in entries:
            # The binding returns dicts on some builds and announce_entry
            # objects on others; normalise both.
            if isinstance(entry, dict):
                url = entry.get("url", "")
                tier = entry.get("tier", 0)
                verified = entry.get("verified", False)
                message = entry.get("message", "") or entry.get("last_error", "")
                fails = entry.get("fails", 0)
                next_announce = entry.get("next_announce")
            else:
                url = getattr(entry, "url", "")
                tier = getattr(entry, "tier", 0)
                verified = getattr(entry, "verified", False)
                message = ""
                fails = 0
                next_announce = None
                endpoints = getattr(entry, "endpoints", None) or []
                for ep in endpoints:
                    fails = max(fails, getattr(ep, "fails", 0) or 0)
                    msg = getattr(ep, "message", "") or ""
                    if msg:
                        message = msg
            out.append({
                "url": url,
                "tier": tier,
                "verified": bool(verified),
                "message": str(message or ""),
                "fails": int(fails or 0),
                "next_announce": str(next_announce) if next_announce else "",
                "peers": st.num_peers if st else 0,
                "seeds": st.num_complete if st else -1,
                "leeches": st.num_incomplete if st else -1,
            })
        # Surface the pseudo-trackers so the UI can show DHT/PeX/LSD state too.
        if st is not None:
            for label, active in (("** [DHT] **", st.announcing_to_dht),
                                  ("** [LSD] **", st.announcing_to_lsd),
                                  ("** [PeX] **", True)):
                out.append({
                    "url": label, "tier": -1, "verified": bool(active),
                    "message": "working" if active else "disabled",
                    "fails": 0, "next_announce": "",
                    "peers": 0, "seeds": -1, "leeches": -1,
                })
        return out

    def add_trackers(self, ih: str, urls: list[str]) -> int:
        rec = self.get(ih)
        added = 0
        for url in urls:
            url = url.strip()
            if not url:
                continue
            with contextlib.suppress(Exception):
                rec.handle.add_tracker({"url": url, "tier": 0})
                added += 1
        if added:
            with contextlib.suppress(Exception):
                rec.handle.force_reannounce()
        return added

    def remove_trackers(self, ih: str, urls: list[str]) -> int:
        rec = self.get(ih)
        drop = {u.strip() for u in urls}
        try:
            entries = rec.handle.trackers()
        except Exception:
            return 0
        kept = []
        for entry in entries:
            url = entry.get("url", "") if isinstance(entry, dict) else getattr(entry, "url", "")
            if url not in drop:
                kept.append(entry)
        rec.handle.replace_trackers(kept)
        return len(entries) - len(kept)

    def pieces(self, ih: str, buckets: int = 400) -> dict[str, Any]:
        """Downsample the piece bitmap so huge torrents still render cheaply."""
        rec = self.get(ih)
        st = rec.status
        if st is None or not st.has_metadata:
            return {"buckets": [], "total": 0, "downloading": []}
        have = list(st.pieces)
        total = len(have)
        if total == 0:
            return {"buckets": [], "total": 0, "downloading": []}

        active: set[int] = set()
        with contextlib.suppress(Exception):
            for item in rec.handle.get_download_queue():
                idx = item["piece_index"] if isinstance(item, dict) else item.piece_index
                active.add(int(idx))

        buckets = max(1, min(buckets, total))
        out = []
        for i in range(buckets):
            lo = i * total // buckets
            hi = max(lo + 1, (i + 1) * total // buckets)
            chunk = have[lo:hi]
            filled = sum(1 for v in chunk if v)
            busy = any(p in active for p in range(lo, hi))
            ratio = filled / len(chunk) if chunk else 0.0
            out.append(2 if (busy and ratio < 1.0) else (1 if ratio >= 1.0 else (0 if ratio == 0 else 3)))
        return {
            "buckets": out,
            "total": total,
            "have": sum(1 for v in have if v),
            "piece_size": rec.handle.torrent_file().piece_length() if rec.handle.torrent_file() else 0,
        }

    # ------------------------------------------------------------------
    # limits & scheduling
    # ------------------------------------------------------------------

    def _enforce_share_limits(self) -> None:
        ratio_limit = float(self.config["share_ratio_limit"])
        time_limit = int(self.config["seed_time_limit"]) * 60
        if ratio_limit <= 0 and time_limit <= 0:
            return
        action = self.config["share_limit_action"]
        for ih, rec in list(self.torrents.items()):
            st = rec.status
            if st is None or not st.is_seeding:
                continue
            if _flag(st.flags, "paused"):
                continue
            downloaded = st.all_time_download or st.total_done or 0
            ratio = (st.all_time_upload / downloaded) if downloaded else 0.0
            hit = (ratio_limit > 0 and ratio >= ratio_limit) or \
                  (time_limit > 0 and _secs(st.seeding_duration) >= time_limit)
            if not hit:
                continue
            name = st.name
            if action == "remove":
                self.remove([ih], with_data=False)
                self.emit("limit", {"name": name, "message": "Share limit reached — removed"})
            elif action == "remove_with_data":
                self.remove([ih], with_data=True)
                self.emit("limit", {"name": name, "message": "Share limit reached — removed with data"})
            else:
                self.pause([ih])
                self.emit("limit", {"name": name, "message": "Share limit reached — paused"})

    def _check_alt_speed_schedule(self) -> None:
        if not self.config["alt_speed_scheduler"]:
            if self._alt_speed_active and not self.config["alt_speed_enabled"]:
                self._alt_speed_active = False
                self.apply_settings()
            return
        now = time.localtime()
        minutes = now.tm_hour * 60 + now.tm_min
        start = int(self.config["alt_speed_from"])
        end = int(self.config["alt_speed_to"])
        # A window that wraps past midnight is the common case (night-time
        # throttling), so treat start > end as "inclusive of midnight".
        inside = (start <= minutes < end) if start <= end else (minutes >= start or minutes < end)
        if inside != self._alt_speed_active:
            self._alt_speed_active = inside
            self.apply_settings()
            self.emit("schedule", {
                "message": f"Alternative speed limits {'enabled' if inside else 'disabled'} by schedule"
            })

    def toggle_alt_speed(self, enabled: bool | None = None) -> bool:
        current = bool(self.config["alt_speed_enabled"])
        target = (not current) if enabled is None else bool(enabled)
        self.config.update({"alt_speed_enabled": target})
        self._alt_speed_active = target
        self.apply_settings()
        return target

    # ------------------------------------------------------------------
    # serialisation for the API / websocket
    # ------------------------------------------------------------------

    @staticmethod
    def _derive_state(st: lt.torrent_status) -> str:
        """Collapse libtorrent's state + flags into one label the UI can use.

        libtorrent splits "what is it doing" (state) from "is it allowed to
        run" (flags), and the interesting cases live in the combination: a
        paused-but-auto-managed torrent is *queued*, not paused.
        """
        if st.errc.value():
            return "error"
        paused = _flag(st.flags, "paused")
        auto = _flag(st.flags, "auto_managed")
        raw = str(st.state).rsplit(".", 1)[-1]

        if raw in ("checking_files", "checking_resume_data"):
            return "checking"
        if paused:
            if auto:
                return "queued_seed" if st.is_seeding else "queued"
            return "paused_seed" if st.is_seeding else "paused"
        if raw == "downloading_metadata":
            return "metadata"
        if st.is_seeding:
            return "seeding"
        if st.is_finished:
            return "finished"
        if raw == "downloading":
            return "downloading" if st.download_payload_rate > 0 else "stalled"
        return raw

    def torrent_dict(self, ih: str, rec: Record) -> dict[str, Any]:
        st = rec.status
        if st is None:
            return {"hash": ih, "name": ih[:12], "state": "loading", "progress": 0.0}

        wanted = st.total_wanted or st.total_done
        remaining = max(0, wanted - st.total_wanted_done)
        rate = st.download_payload_rate
        eta = int(remaining / rate) if rate > 0 and remaining > 0 else (0 if remaining == 0 else -1)

        downloaded = st.all_time_download or st.total_done or 0
        ratio = round(st.all_time_upload / downloaded, 3) if downloaded > 0 else 0.0

        return {
            "hash": ih,
            "name": st.name or ih[:12],
            "state": self._derive_state(st),
            "progress": round(st.progress, 5),
            "size": st.total_wanted,
            "size_total": st.total,
            "done": st.total_wanted_done,
            "dlspeed": st.download_payload_rate,
            "upspeed": st.upload_payload_rate,
            "downloaded": st.all_time_download,
            "uploaded": st.all_time_upload,
            "ratio": ratio,
            "eta": eta,
            "peers": max(0, st.num_peers - st.num_seeds),
            "peers_total": max(0, st.list_peers - st.list_seeds),
            "seeds": st.num_seeds,
            "seeds_total": max(st.num_complete, st.list_seeds),
            "connections": st.num_connections,
            "availability": round(st.distributed_copies, 3) if st.distributed_copies >= 0 else 0.0,
            "queue_position": st.queue_position,
            "save_path": st.save_path,
            "added_on": rec.meta.added_on or _epoch(st.added_time),
            "completed_on": _epoch(st.completed_time),
            "active_time": _secs(st.active_duration),
            "seeding_time": _secs(st.seeding_duration),
            "last_activity": max(_epoch(st.last_download), _epoch(st.last_upload)),
            "category": rec.meta.category,
            "tags": rec.meta.tags,
            "tracker": st.current_tracker,
            "has_metadata": st.has_metadata,
            "pieces_have": st.num_pieces,
            "error": st.errc.message() if st.errc.value() else "",
            # libtorrent reports -1 for "no limit"; the UI treats 0 as unlimited.
            "dl_limit": max(0, rec.handle.download_limit()) if rec.handle.is_valid() else 0,
            "up_limit": max(0, rec.handle.upload_limit()) if rec.handle.is_valid() else 0,
            "sequential": _flag(st.flags, "sequential_download"),
            "auto_managed": _flag(st.flags, "auto_managed"),
            "super_seeding": _flag(st.flags, "super_seeding"),
            "paused": _flag(st.flags, "paused"),
            "force_started": not _flag(st.flags, "auto_managed") and not _flag(st.flags, "paused"),
            "moving": st.moving_storage,
        }

    def torrent_detail(self, ih: str) -> dict[str, Any]:
        rec = self.get(ih)
        base = self.torrent_dict(ih, rec)
        st = rec.status
        ti = rec.handle.torrent_file()
        # NOTE: `peers` in the base payload is a *count*. The peer list goes in
        # `peer_list` so it cannot clobber it — the two are different shapes and
        # the table and the detail panel each need one of them.
        base.update({
            "files": self.files(ih),
            "peer_list": self.peers(ih),
            "trackers": self.trackers(ih),
            "pieces": self.pieces(ih),
            "down_history": list(rec.down_hist)[-120:],
            "up_history": list(rec.up_hist)[-120:],
            "notes": rec.meta.notes,
            "source": rec.meta.source,
            "comment": (ti.comment() if ti else ""),
            "created_by": (ti.creator() if ti else ""),
            "creation_date": _epoch(ti.creation_date() if ti else 0),
            "private": (ti.priv() if ti else False),
            "num_files": (ti.num_files() if ti else 0),
            "piece_length": (ti.piece_length() if ti else 0),
            "num_pieces": (ti.num_pieces() if ti else 0),
            "total_failed": st.total_failed_bytes if st else 0,
            "total_redundant": st.total_redundant_bytes if st else 0,
            "max_connections": rec.handle.max_connections() if rec.handle.is_valid() else 0,
            "max_uploads": rec.handle.max_uploads() if rec.handle.is_valid() else 0,
            "magnet": self.magnet_for(ih),
        })
        return base

    def magnet_for(self, ih: str) -> str:
        rec = self.torrents.get(ih)
        if rec is None:
            return ""
        with contextlib.suppress(Exception):
            ti = rec.handle.torrent_file()
            if ti is not None:
                return lt.make_magnet_uri(ti)
        return f"magnet:?xt=urn:btih:{ih}"

    def torrent_file_bytes(self, ih: str) -> bytes | None:
        path = self.config.torrents_dir / f"{ih}.torrent"
        if path.exists():
            return path.read_bytes()
        rec = self.torrents.get(ih)
        if rec is None:
            return None
        ti = rec.handle.torrent_file()
        if ti is None:
            return None
        with contextlib.suppress(Exception):
            return lt.bencode(lt.create_torrent(ti).generate())
        return None

    def stats(self) -> dict[str, Any]:
        down = self.global_down[-1] if self.global_down else 0
        up = self.global_up[-1] if self.global_up else 0

        # Sidebar filter counts. A torrent belongs to exactly one *state*
        # bucket but may also belong to the overlapping "finished" and
        # "active" buckets, so those are computed separately.
        counts = {k: 0 for k in ("all", "downloading", "seeding", "paused", "queued",
                                 "checking", "error", "stalled", "finished",
                                 "active", "inactive")}
        counts["all"] = len(self.torrents)
        buckets = {
            "downloading": ("downloading", "metadata"),
            "stalled": ("stalled",),
            "seeding": ("seeding",),
            "paused": ("paused", "paused_seed"),
            "queued": ("queued", "queued_seed"),
            "checking": ("checking",),
            "error": ("error",),
        }
        done_states = ("seeding", "finished", "paused_seed", "queued_seed")

        session_down = session_up = 0
        for rec in self.torrents.values():
            st = rec.status
            if st is None:
                continue
            session_down += st.total_download
            session_up += st.total_upload
            state = self._derive_state(st)
            for bucket, members in buckets.items():
                if state in members:
                    counts[bucket] += 1
            if state in done_states:
                counts["finished"] += 1
            if st.download_payload_rate or st.upload_payload_rate:
                counts["active"] += 1
            else:
                counts["inactive"] += 1

        stat = self.session_stats
        return {
            "dlspeed": down,
            "upspeed": up,
            "dl_limit": int(self.config["alt_download_rate_limit"] if self._alt_speed_active
                            else self.config["download_rate_limit"]),
            "up_limit": int(self.config["alt_upload_rate_limit"] if self._alt_speed_active
                            else self.config["upload_rate_limit"]),
            "alt_speed": self._alt_speed_active or bool(self.config["alt_speed_enabled"]),
            "session_downloaded": session_down,
            "session_uploaded": session_up,
            "all_time_downloaded": int(stat.get("net.recv_payload_bytes", 0) or 0),
            "all_time_uploaded": int(stat.get("net.sent_payload_bytes", 0) or 0),
            "dht_nodes": int(stat.get("dht.dht_nodes", 0) or 0),
            "peers": int(stat.get("peer.num_peers_connected", 0) or 0),
            "listen_port": self.session.listen_port() if self.session else 0,
            "is_listening": bool(self.session.is_listening()) if self.session else False,
            "dht_running": bool(self.session.is_dht_running()) if self.session else False,
            "free_space": disk_free(self.config["download_dir"]),
            "download_dir": self.config["download_dir"],
            "uptime": int(time.time() - self._started_at),
            "counts": counts,
            "down_history": list(self.global_down)[-120:],
            "up_history": list(self.global_up)[-120:],
            "lt_version": lt.__version__,
        }

    def categories(self) -> list[dict[str, Any]]:
        buckets: dict[str, int] = {}
        for rec in self.torrents.values():
            if rec.meta.category:
                buckets[rec.meta.category] = buckets.get(rec.meta.category, 0) + 1
        return [{"name": k, "count": v} for k, v in sorted(buckets.items())]

    def tags(self) -> list[dict[str, Any]]:
        buckets: dict[str, int] = {}
        for rec in self.torrents.values():
            for tag in rec.meta.tags:
                buckets[tag] = buckets.get(tag, 0) + 1
        return [{"name": k, "count": v} for k, v in sorted(buckets.items())]

    def snapshot(self) -> dict[str, Any]:
        """The full payload pushed to every connected client each second."""
        return {
            "torrents": [self.torrent_dict(ih, rec) for ih, rec in self.torrents.items()],
            "stats": self.stats(),
            "categories": self.categories(),
            "tags": self.tags(),
        }
