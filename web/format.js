/* Formatting helpers. Every number the user sees passes through here, so unit
   preferences stay consistent across the table, detail panel and tooltips. */

let BINARY = true;
export function setUnitMode(mode) { BINARY = mode !== 'decimal'; }

const BIN = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const DEC = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(n, digits) {
  n = Number(n) || 0;
  if (n < 0) n = 0;
  const step = BINARY ? 1024 : 1000;
  const units = BINARY ? BIN : DEC;
  if (n < step) return n + ' B';
  let i = 0;
  while (n >= step && i < units.length - 1) { n /= step; i++; }
  // Keep the width stable: more precision for small mantissas, less for large.
  const d = digits !== undefined ? digits : (n < 10 ? 2 : n < 100 ? 1 : 0);
  return n.toFixed(d) + ' ' + units[i];
}

export function speed(n) {
  n = Number(n) || 0;
  return n === 0 ? '—' : bytes(n) + '/s';
}

export function pct(fraction, digits = 1) {
  const v = (Number(fraction) || 0) * 100;
  // Never show "100.0%" for something that is not actually complete — it is
  // the single most confusing thing a torrent client can do.
  if (v >= 100) return '100%';
  if (v > 99.9) return '99.9%';
  return v.toFixed(digits) + '%';
}

export function eta(seconds) {
  const s = Number(seconds);
  if (s === 0) return 'Done';
  if (!Number.isFinite(s) || s < 0) return '∞';
  return duration(s, 2);
}

export function duration(seconds, parts = 2) {
  let s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 1) return '0s';
  const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  const out = [];
  for (const [label, size] of units) {
    if (out.length >= parts) break;
    const v = Math.floor(s / size);
    if (v > 0 || out.length) { out.push(v + label); s -= v * size; }
  }
  return out.join(' ') || '0s';
}

export function ago(timestamp) {
  const t = Number(timestamp) || 0;
  if (t <= 0) return 'Never';
  const delta = Date.now() / 1000 - t;
  if (delta < 45) return 'Just now';
  return duration(delta, 1) + ' ago';
}

export function date(timestamp) {
  const t = Number(timestamp) || 0;
  if (t <= 0) return '—';
  return new Date(t * 1000).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function ratio(value) {
  const v = Number(value) || 0;
  return v >= 100 ? '∞' : v.toFixed(2);
}

const STATE_LABELS = {
  downloading: 'Downloading', stalled: 'Stalled', seeding: 'Seeding',
  finished: 'Completed', paused: 'Paused', paused_seed: 'Paused',
  queued: 'Queued', queued_seed: 'Queued', checking: 'Checking',
  metadata: 'Fetching metadata', error: 'Error', loading: 'Loading',
  moving: 'Moving',
};
export function stateLabel(state) { return STATE_LABELS[state] || state; }

/** Escape text for safe insertion into an HTML string. */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Parse "10 MB", "512k", "1.5 GiB" into bytes. Blank or 0 means unlimited. */
export function parseSize(text) {
  const m = String(text || '').trim().match(/^([\d.]+)\s*([kmgt]?)i?b?\/?s?$/i);
  if (!m) return 0;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * (mult[m[2].toLowerCase()] || 1));
}
