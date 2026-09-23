"""Command line entry point: ``python -m fission``."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import sys
import webbrowser
from pathlib import Path

from aiohttp import web

from . import __version__
from .api import build_app
from .config import Config, default_state_dir
from .engine import Engine

BANNER = r"""
   ___ _         _
  / __(_)__ ___ (_)___  ___
 / _// (_-<(_-</ / _ \/ _ \    Fission {version}
/_/ /_/___/___/_/\___/_//_/    a fast, modern BitTorrent client
"""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="fission",
        description="A fast, modern BitTorrent client with a web UI.",
    )
    parser.add_argument("--host", default="127.0.0.1",
                        help="interface for the web UI (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080,
                        help="port for the web UI (default: 8080)")
    parser.add_argument("--state-dir", type=Path, default=None,
                        help="where settings, resume data and metadata live")
    parser.add_argument("--download-dir", type=Path, default=None,
                        help="override the default download directory")
    parser.add_argument("--password", default=os.environ.get("FISSION_PASSWORD"),
                        help="require this password to use the UI")
    parser.add_argument("--open", action="store_true",
                        help="open the UI in your browser once started")
    parser.add_argument("--verbose", "-v", action="store_true", help="debug logging")
    parser.add_argument("--version", action="version", version=f"Fission {__version__}")
    return parser.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    state_dir = args.state_dir or default_state_dir()
    config = Config(state_dir)
    if args.download_dir:
        config.update({"download_dir": str(args.download_dir.expanduser())})

    engine = Engine(config)
    await engine.start()

    app = build_app(engine, config, password=args.password,
                    host=args.host, version=__version__)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port, reuse_address=True)
    try:
        await site.start()
    except OSError as exc:
        print(f"\n  Could not bind {args.host}:{args.port} — {exc}\n", file=sys.stderr)
        await engine.stop()
        await runner.cleanup()
        return 1

    display_host = "localhost" if args.host in ("0.0.0.0", "::", "127.0.0.1") else args.host
    url = f"http://{display_host}:{args.port}"
    print(BANNER.format(version=__version__))
    print(f"  Web UI      {url}")
    print(f"  Downloads   {config['download_dir']}")
    print(f"  State       {state_dir}")
    print(f"  Torrents    {len(engine.torrents)} loaded")
    print(f"  Auth        {'password required' if args.password else 'disabled (loopback only)'}")
    print("\n  Press Ctrl+C to stop.\n")

    if args.open:
        with contextlib.suppress(Exception):
            webbrowser.open(url)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    await stop.wait()

    print("\n  Shutting down — saving resume data...")
    await runner.cleanup()
    await engine.stop()
    print("  Done.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
