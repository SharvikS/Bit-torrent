# Fission

A fast, modern BitTorrent client with a real-time web UI.

Fission pairs **libtorrent 2.x** — the same engine behind qBittorrent and
Deluge — with an async Python daemon and a zero-build web interface. The engine
is battle-tested C++; the UI is plain ES modules with no bundler, no framework
and no install step, so it loads instantly and there is nothing to rebuild.

```
python3 -m fission --open
```

---

## Highlights

**Engine**
- libtorrent 2.x: BitTorrent v1 **and** v2, hybrid torrents, µTP, DHT, PeX,
  local peer discovery, UPnP/NAT-PMP port mapping
- Protocol encryption (prefer or require), SOCKS4/5 and HTTP proxy support with
  optional DNS-through-proxy to avoid leaks
- Resume data written on pause, completion and every minute — a restart never
  triggers a re-check
- The DHT routing table is persisted too, so a restart finds peers in seconds

**Torrents**
- Add by magnet link, `.torrent` file (drag-and-drop anywhere), bare info hash,
  or a watch folder
- Selective download with a real file tree and four priority levels
- Sequential download, super-seeding, force-start, per-torrent speed and
  connection limits
- Queue management, categories, tags, move-files-on-disk, rename
- Share-ratio and seed-time limits with pause / remove / remove-with-data
- Per-torrent piece map, live peer list, tracker editing

**Interface**
- Live WebSocket push — the UI never polls
- Sortable, filterable table that stays smooth with thousands of torrents
- Detail panel: general, files, peers, trackers, piece map, speed chart
- Command palette (`⌘/Ctrl K`), full keyboard control, context menus
- Dark and light themes, six accent colours, binary or decimal units
- Alternative speed limits with an optional nightly schedule
- Responsive down to phone width

---

## Install

Fission needs **Python 3.10+**, **libtorrent 2.x** and **aiohttp**. libtorrent is
a compiled extension, so your distribution's package is usually the smoothest
path:

| Platform | Command |
| --- | --- |
| Arch / CachyOS | `sudo pacman -S libtorrent-rasterbar python-aiohttp` |
| Debian / Ubuntu | `sudo apt install python3-libtorrent python3-aiohttp` |
| Fedora | `sudo dnf install rb_libtorrent-python3 python3-aiohttp` |
| macOS | `brew install libtorrent-rasterbar && pip install aiohttp` |
| Any | `pip install libtorrent aiohttp` |

Then run it straight from the checkout:

```bash
git clone https://github.com/SharvikS/Bit-torrent.git
cd Bit-torrent
./fission.sh --open
```

Or install it so `fission` is on your `PATH`:

```bash
pip install -e .
fission --open
```

> If you install into a virtualenv, create it with `--system-site-packages` so
> it can see a distro-provided libtorrent.

Open <http://localhost:8080>.

---

## Usage

```
fission [--host HOST] [--port PORT] [--state-dir DIR]
        [--download-dir DIR] [--password PASS] [--open] [--verbose]
```

| Flag | Meaning |
| --- | --- |
| `--host` | Interface to bind. Defaults to `127.0.0.1` (local only). |
| `--port` | Web UI port. Default `8080`. |
| `--state-dir` | Settings, resume data and metadata. Default `~/.local/share/fission`. |
| `--download-dir` | Override the default download folder. |
| `--password` | Require a password. Also read from `$FISSION_PASSWORD`. |
| `--open` | Open the UI in your browser once started. |

Everything else is configured in the UI under **Settings**, and is written to
`<state-dir>/config.json`.

### Running as a service

`packaging/fission.service` is a hardened systemd **user** unit:

```bash
mkdir -p ~/.config/systemd/user
cp packaging/fission.service ~/.config/systemd/user/
# point WorkingDirectory at your checkout, then:
systemctl --user daemon-reload
systemctl --user enable --now fission
```

It allows 30 seconds to shut down — Fission uses that time to tell trackers it
is going away and to flush resume data, which is what saves you a full hash
re-check on the next start.

---

## Keyboard

| Key | Action |
| --- | --- |
| `⌘/Ctrl K` | Command palette |
| `N` | Add torrent |
| `/` | Focus search |
| `Space` | Pause / resume selection |
| `Delete` | Remove selection |
| `↑ ↓` or `J K` | Move through the list |
| `Shift + ↑ ↓` | Extend selection |
| `⌘/Ctrl A` | Select all |
| `Enter` | Open details |
| `I` | Toggle details panel |
| `T` | Alternative speed limits |
| `,` | Settings |
| `?` | Shortcut help |

Pasting a magnet link anywhere opens the add dialog pre-filled.

---

## Exposing it beyond localhost

The daemon binds to loopback and runs without authentication by default, which
is safe on a single-user machine. Before putting it on a network:

1. **Set a password**: `fission --password 'something-long'`.
2. **Bind deliberately**: `--host 0.0.0.0` only if you mean it.
3. **Terminate TLS in front of it** — a reverse proxy (Caddy, nginx, Traefik)
   is the right place for certificates. Pass the browser-facing hostname in
   `FISSION_ALLOWED_HOSTS` so the rebinding guard accepts it:

   ```bash
   FISSION_ALLOWED_HOSTS=torrents.example.com fission --password …
   ```

On a loopback bind Fission pins the `Host` header to localhost and rejects
cross-origin state changes, so a web page you happen to visit cannot drive the
API through your browser. Binding to a wildcard address necessarily relaxes the
host check, which is why the password matters there.

---

## Architecture

```
fission/
  __main__.py   CLI, startup and graceful shutdown
  config.py     typed settings with atomic writes
  engine.py     libtorrent session, alert pump, torrent operations
  api.py        aiohttp routes, WebSocket hub, auth and request guards
web/
  index.html    application shell
  app.css       design system
  app.js        state, table, detail panel, dialogs, shortcuts
  net.js        self-healing WebSocket + fetch wrapper
  ui.js         toasts, modals, context menus
  format.js     byte / rate / duration formatting
```

The engine runs inside the asyncio loop and pumps libtorrent's alert queue on a
short timer, so every mutation of Fission's own bookkeeping is single-threaded.
State flows one way: the daemon pushes a snapshot once per second, the UI
renders it, and user actions are ordinary requests — nothing is optimistically
mutated, so the UI cannot disagree with the daemon for more than a tick.

Anything libtorrent models is read back from `torrent_status`, so there is one
source of truth and no drift across restarts. The few things it does not model —
categories, tags, the time *we* added a torrent — live in a sidecar
`meta.json` keyed by info hash.

### HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Full snapshot: torrents, stats, categories, tags |
| `GET` | `/api/ws` | WebSocket: snapshots, detail, events |
| `POST` | `/api/add` | Add magnets / info hashes |
| `POST` | `/api/upload` | Add `.torrent` files (multipart) |
| `POST` | `/api/action` | Bulk actions (see below) |
| `GET` | `/api/torrents/{hash}` | Full detail incl. files, peers, trackers, pieces |
| `GET` | `/api/torrents/{hash}/file` | Download the `.torrent` |
| `POST` | `/api/torrents/{hash}/files` | Set file priorities |
| `POST` | `/api/torrents/{hash}/trackers` | Add or remove trackers |
| `GET`/`POST` | `/api/settings` | Read / update settings |
| `POST` | `/api/alt-speed` | Toggle alternative limits |

`/api/action` takes `{"action": …, "hashes": [...]}` where `hashes` may be
`["*"]` for everything. Actions: `pause`, `resume`, `force_start`, `recheck`,
`reannounce`, `scrape`, `remove`, `queue`, `set_limits`,
`set_connection_limits`, `set_flag`, `set_category`, `set_tags`, `move`,
`rename`.

```bash
curl -X POST localhost:8080/api/add \
  -H 'Content-Type: application/json' \
  -d '{"urls":"magnet:?xt=urn:btih:…","category":"linux","tags":"iso"}'
```

---

## Legal

Fission is a BitTorrent client. BitTorrent is a transfer protocol with entirely
legitimate uses — Linux distributions, datasets, game patches, the Internet
Archive. What you move with it is your responsibility; respect copyright and
your local law.

## License

MIT.
