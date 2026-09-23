#!/usr/bin/env bash
# Launch Fission from a source checkout without installing anything.
#
# The web assets are found relative to this script, so the checkout can live
# anywhere. Any arguments are passed straight through to the daemon, e.g.
#   ./fission.sh --port 9090 --open
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if ! python3 -c "import libtorrent" 2>/dev/null; then
  cat >&2 <<'MSG'
Fission needs the libtorrent Python bindings, which are not installed.

  Arch / CachyOS   sudo pacman -S libtorrent-rasterbar
  Debian / Ubuntu  sudo apt install python3-libtorrent
  Fedora           sudo dnf install rb_libtorrent-python3
  macOS            brew install libtorrent-rasterbar
  any platform     pip install libtorrent

MSG
  exit 1
fi

if ! python3 -c "import aiohttp" 2>/dev/null; then
  echo "Fission needs aiohttp:  pip install aiohttp  (or your distro's python3-aiohttp)" >&2
  exit 1
fi

exec python3 -m fission "$@"
