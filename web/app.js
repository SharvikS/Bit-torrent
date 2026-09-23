/* ══════════════════════════════════════════════════════════════════════
   Fission — application shell.

   State flows one way: the server pushes a snapshot each second, we merge it
   into `state`, and render. Every user action is a request; nothing is
   optimistically mutated except selection and pure-UI preferences, so the UI
   can never disagree with the daemon for more than one tick.
   ══════════════════════════════════════════════════════════════════════ */

import * as F from './format.js';
import { Api, Live } from './net.js';
import {
  toast, toastError, modal, closeActiveModal, modalOpen,
  confirmDialog, contextMenu, copyText, setToastsEnabled,
} from './ui.js';

const api = new Api();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ─────────────────────────────── state ─────────────────────────────── */

const PREF_KEY = 'fission.prefs.v1';

const state = {
  torrents: new Map(),
  stats: {},
  categories: [],
  tags: [],
  settings: null,

  filter: { status: 'all', category: null, tag: null, query: '' },
  sort: { key: 'added_on', dir: -1 },

  selection: new Set(),
  anchor: null,

  detailHash: null,
  detailTab: 'general',
  detail: null,

  connection: 'connecting',
  prefs: loadPrefs(),
};

function loadPrefs() {
  const fallback = {
    theme: 'midnight', accent: 'violet', density: 'cozy', motion: 'system',
    unit: 'binary', detailOpen: false, detailWidth: 0, columns: null,
    confirmDelete: true, notifications: true,
  };
  try {
    const saved = { ...fallback, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
    // The palette grew from two themes to a named set; remap old values.
    saved.theme = ({ dark: 'midnight', light: 'paper', auto: 'system' })[saved.theme] || saved.theme;
    return saved;
  } catch {
    // Private windows and blocked site data both throw here; defaults are fine.
    return fallback;
  }
}

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs)); } catch { /* non-fatal */ }
}

/* The appearance registry. Each theme declares the two colours its preview
   swatch needs and which family it belongs to, so "System" can resolve to a
   sensible member rather than a hard-coded pair. */
const THEMES = [
  { id: 'system',    name: 'System',    family: 'auto',  bg: '#14161d', fg: '#f6f7f9' },
  { id: 'midnight',  name: 'Midnight',  family: 'dark',  bg: '#0a0b0f', fg: '#e9ebf0' },
  { id: 'graphite',  name: 'Graphite',  family: 'dark',  bg: '#141414', fg: '#ededed' },
  { id: 'carbon',    name: 'Carbon',    family: 'dark',  bg: '#000000', fg: '#f2f2f2' },
  { id: 'nord',      name: 'Nord',      family: 'dark',  bg: '#2e3440', fg: '#eceff4' },
  { id: 'dracula',   name: 'Dracula',   family: 'dark',  bg: '#282a36', fg: '#f8f8f2' },
  { id: 'paper',     name: 'Paper',     family: 'light', bg: '#f6f7f9', fg: '#10131a' },
  { id: 'sandstone', name: 'Sandstone', family: 'light', bg: '#f7f4ef', fg: '#1c1814' },
  { id: 'contrast',  name: 'Contrast',  family: 'a11y',  bg: '#000000', fg: '#ffffff' },
];
const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));
const SYSTEM_DARK = 'midnight';
const SYSTEM_LIGHT = 'paper';

const ACCENTS = [
  { id: 'violet', hex: '#8b5cf6' }, { id: 'blue', hex: '#3b82f6' },
  { id: 'teal',   hex: '#14b8a6' }, { id: 'green', hex: '#10b981' },
  { id: 'amber',  hex: '#f59e0b' }, { id: 'rose',  hex: '#f43f5e' },
  { id: 'cyan',   hex: '#06b6d4' },
];

const DENSITIES = [
  { id: 'compact', name: 'Compact' },
  { id: 'cozy', name: 'Cozy' },
  { id: 'comfortable', name: 'Comfortable' },
];

/* ─────────────────────────────── columns ─────────────────────────────── */

const COLUMNS = [
  { key: 'queue_position', label: '#', width: 40, num: true, optional: true,
    value: (t) => t.queue_position, text: (t) => (t.queue_position >= 0 ? t.queue_position + 1 : '—') },
  { key: 'name', label: 'Name', width: null, value: (t) => t.name.toLowerCase(), html: nameCell },
  { key: 'size', label: 'Size', width: 88, num: true, value: (t) => t.size, text: (t) => F.bytes(t.size) },
  { key: 'progress', label: 'Progress', width: 132, html: progressCell, value: (t) => t.progress },
  { key: 'state', label: 'Status', width: 108, html: stateCell, value: (t) => t.state },
  { key: 'seeds', label: 'Seeds', width: 72, num: true, value: (t) => t.seeds,
    text: (t) => (t.seeds_total > t.seeds ? `${t.seeds} (${t.seeds_total})` : String(t.seeds)) },
  { key: 'peers', label: 'Peers', width: 72, num: true, value: (t) => t.peers,
    text: (t) => (t.peers_total > t.peers ? `${t.peers} (${t.peers_total})` : String(t.peers)) },
  { key: 'dlspeed', label: 'Down', width: 88, num: true, value: (t) => t.dlspeed,
    html: (t) => `<span class="rate-cell ${t.dlspeed ? 'down' : 'zero'}">${F.speed(t.dlspeed)}</span>` },
  { key: 'upspeed', label: 'Up', width: 88, num: true, value: (t) => t.upspeed,
    html: (t) => `<span class="rate-cell ${t.upspeed ? 'up' : 'zero'}">${F.speed(t.upspeed)}</span>` },
  { key: 'eta', label: 'ETA', width: 84, num: true, optional: true,
    // Sort "unknown" (-1) last rather than first, which is what users expect.
    value: (t) => (t.eta < 0 ? Number.MAX_SAFE_INTEGER : t.eta), text: (t) => F.eta(t.eta) },
  { key: 'ratio', label: 'Ratio', width: 68, num: true, value: (t) => t.ratio, text: (t) => F.ratio(t.ratio) },
  { key: 'added_on', label: 'Added', width: 110, num: true, optional: true,
    value: (t) => t.added_on, text: (t) => F.ago(t.added_on) },
  { key: 'category', label: 'Category', width: 110, optional: true,
    value: (t) => t.category.toLowerCase(), text: (t) => t.category || '—' },
];

const VISIBLE_DEFAULT = ['name', 'size', 'progress', 'state', 'seeds', 'peers',
                         'dlspeed', 'upspeed', 'eta', 'ratio', 'added_on'];

function visibleColumns() {
  const chosen = state.prefs.columns || VISIBLE_DEFAULT;
  return COLUMNS.filter((c) => chosen.includes(c.key));
}

function nameCell(t) {
  const chips = [];
  if (t.category) chips.push(`<span class="chip">${F.esc(t.category)}</span>`);
  for (const tag of t.tags.slice(0, 2)) chips.push(`<span class="chip">${F.esc(tag)}</span>`);
  if (t.sequential) chips.push('<span class="chip" title="Sequential download">SEQ</span>');
  if (t.force_started) chips.push('<span class="chip" title="Forced — ignores the queue">F</span>');
  return `<div class="name-cell">
      <span class="state-dot s-${t.state}" style="background:currentColor"></span>
      <span class="txt" title="${F.esc(t.name)}">${F.esc(t.name)}</span>${chips.join('')}
    </div>`;
}

function progressCell(t) {
  const indeterminate = t.state === 'metadata' || (!t.has_metadata && t.progress === 0);
  return `<div class="progress-cell">
      <div class="bar s-${t.state}${indeterminate ? ' indet' : ''}">
        <i style="width:${(Math.min(1, t.progress) * 100).toFixed(2)}%"></i>
      </div>
      <span class="pct">${indeterminate ? '—' : F.pct(t.progress)}</span>
    </div>`;
}

function stateCell(t) {
  const label = t.error ? 'Error' : F.stateLabel(t.state);
  return `<span class="state-text s-${t.state}" title="${F.esc(t.error || label)}">${F.esc(label)}</span>`;
}

/* ─────────────────────────────── filters ─────────────────────────────── */

const STATUS_FILTERS = [
  { key: 'all',         label: 'All',         color: 'var(--text-2)' },
  { key: 'downloading', label: 'Downloading', color: 'var(--s-download)' },
  { key: 'seeding',     label: 'Seeding',     color: 'var(--s-seed)' },
  { key: 'finished',    label: 'Completed',   color: 'var(--s-seed)' },
  { key: 'active',      label: 'Active',      color: 'var(--accent)' },
  { key: 'inactive',    label: 'Inactive',    color: 'var(--s-stall)' },
  { key: 'stalled',     label: 'Stalled',     color: 'var(--s-stall)' },
  { key: 'paused',      label: 'Paused',      color: 'var(--s-pause)' },
  { key: 'queued',      label: 'Queued',      color: 'var(--s-queue)' },
  { key: 'checking',    label: 'Checking',    color: 'var(--s-check)' },
  { key: 'error',       label: 'Errored',     color: 'var(--s-error)' },
];

const MATCHERS = {
  all: () => true,
  downloading: (t) => t.state === 'downloading' || t.state === 'metadata',
  seeding: (t) => t.state === 'seeding',
  finished: (t) => ['seeding', 'finished', 'paused_seed', 'queued_seed'].includes(t.state),
  active: (t) => t.dlspeed > 0 || t.upspeed > 0,
  inactive: (t) => t.dlspeed === 0 && t.upspeed === 0,
  stalled: (t) => t.state === 'stalled',
  paused: (t) => t.state === 'paused' || t.state === 'paused_seed',
  queued: (t) => t.state === 'queued' || t.state === 'queued_seed',
  checking: (t) => t.state === 'checking',
  error: (t) => t.state === 'error',
};

function visibleTorrents() {
  const { status, category, tag, query } = state.filter;
  const match = MATCHERS[status] || MATCHERS.all;
  const needle = query.trim().toLowerCase();

  const list = [];
  for (const t of state.torrents.values()) {
    if (!match(t)) continue;
    if (category !== null && t.category !== category) continue;
    if (tag !== null && !t.tags.includes(tag)) continue;
    if (needle && !t.name.toLowerCase().includes(needle)
        && !t.hash.startsWith(needle) && !t.category.toLowerCase().includes(needle)) continue;
    list.push(t);
  }

  const col = COLUMNS.find((c) => c.key === state.sort.key) || COLUMNS[1];
  const dir = state.sort.dir;
  list.sort((a, b) => {
    const av = col.value(a);
    const bv = col.value(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    // Stable tiebreak so equal values never jitter between frames.
    return a.hash < b.hash ? -1 : 1;
  });
  return list;
}

/* ─────────────────────────────── boot ─────────────────────────────── */

const live = new Live(onLiveMessage, onLiveStatus);

async function boot() {
  applyTheme();
  F.setUnitMode(state.prefs.unit);
  setToastsEnabled(state.prefs.notifications);

  const status = await api.get('/api/ping').catch(() => null);
  if (status && status.auth_required && !status.authenticated) {
    showLogin();
    return;
  }
  startApp();
}

function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  buildStatusFilters();
  buildTableHead();
  scheduleSkeleton();
  wireChrome();
  wireKeyboard();
  wireDragDrop();
  if (state.prefs.detailOpen) toggleDetail(true);
  live.connect();
  api.get('/api/settings').then((data) => { state.settings = data.settings; }).catch(() => {});
}

function showLogin() {
  const box = $('#login');
  box.hidden = false;
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#login-error');
    error.hidden = true;
    try {
      await api.post('/api/login', { password: $('#login-password').value });
      startApp();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      $('#login-password').select();
    }
  });
  $('#login-password').focus();
}

/* ───────────────────────── live data handling ───────────────────────── */

function onLiveStatus(status) {
  state.connection = status;
  const el = $('#conn');
  if (!el) return;
  el.className = `conn ${status === 'open' ? 'on' : status === 'closed' ? 'off' : ''}`;
  el.lastElementChild.textContent =
    status === 'open' ? 'Connected' : status === 'closed' ? 'Reconnecting…' : 'Connecting…';
  // Anything on screen while the socket is down is a frozen snapshot. Desaturate
  // it rather than blanking the table — the numbers are still the last truth.
  $('#app').classList.toggle('stale', status === 'closed');
}

let skeletonTimer = null;

/**
 * Arm the loading state.
 *
 * On a local daemon the first snapshot lands in ~10ms, and placeholders that
 * appear and vanish inside a single frame read as a glitch rather than as
 * feedback. So the skeleton is only drawn if the data is actually late —
 * which is the case that needed it in the first place (a remote instance, a
 * slow link, a daemon still loading a few thousand resume files).
 */
function scheduleSkeleton() {
  clearTimeout(skeletonTimer);
  skeletonTimer = setTimeout(renderSkeleton, 160);
}

/** Placeholder rows for the gap between first paint and first snapshot. */
function renderSkeleton() {
  const root = $('#skeleton');
  if (!root || root.hidden) return;
  const widths = [[42, 9, 16, 12, 10], [30, 7, 20, 9, 14], [50, 11, 13, 15, 8],
                  [36, 8, 18, 11, 12], [45, 10, 15, 13, 9], [28, 9, 22, 10, 11]];
  root.innerHTML = widths.map((row) =>
    `<div class="sk-row">${row.map((w, i) =>
      `<div class="skeleton" style="flex:${i === 0 ? `1 1 ${w}%` : `0 0 ${w * 4}px`}"></div>`).join('')}</div>`
  ).join('');
}

function clearSkeleton() {
  clearTimeout(skeletonTimer);
  const root = $('#skeleton');
  if (!root || root.hidden) return;
  root.hidden = true;
  root.innerHTML = '';
}

function onLiveMessage(msg) {
  if (msg.type === 'snapshot') {
    clearSkeleton();
    const next = new Map();
    for (const t of msg.torrents) next.set(t.hash, t);
    state.torrents = next;
    state.stats = msg.stats;
    state.categories = msg.categories;
    state.tags = msg.tags;

    // Drop selections for torrents that no longer exist.
    for (const hash of Array.from(state.selection)) {
      if (!next.has(hash)) state.selection.delete(hash);
    }
    if (state.detailHash && !next.has(state.detailHash)) closeDetail();

    renderAll();
  } else if (msg.type === 'detail') {
    state.detail = msg.detail;
    if (msg.detail.hash === state.detailHash) renderDetail();
  } else if (msg.type === 'event') {
    handleEvent(msg.event);
  }
}

const EVENT_TOASTS = {
  finished: (e) => ['Download complete', e.name, 'success'],
  added: (e) => ['Torrent added', e.name || e.message || '', 'success'],
  error: (e) => ['Error', e.message, 'error'],
  limit: (e) => ['Share limit', `${e.name}: ${e.message}`, 'info'],
  moved: (e) => ['Files moved', e.message, 'success'],
  schedule: (e) => ['Schedule', e.message, 'info'],
  settings: (e) => ['Settings saved', '', 'success'],
};

function handleEvent(event) {
  const build = EVENT_TOASTS[event.kind];
  if (!build) return;
  const [title, message, kind] = build(event);
  toast(title, message, kind);
  if (event.kind === 'finished' && state.prefs.notifications
      && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Download complete', { body: event.name, tag: event.hash });
  }
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

function renderAll() {
  renderSidebar();
  renderTable();
  renderStatusBar();
  renderToolbar();
  drawSparkline();
}

function buildStatusFilters() {
  $('#status-filters').innerHTML = STATUS_FILTERS.map((f) =>
    `<button class="filter" data-status="${f.key}">
       <span class="dot" style="color:${f.color}"></span>
       <span class="label">${f.label}</span>
       <span class="count" data-count="${f.key}">0</span>
     </button>`).join('');

  $('#status-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    if (!button) return;
    state.filter.status = button.dataset.status;
    state.filter.category = null;
    state.filter.tag = null;
    queueLayoutAnimation();
    renderAll();
  });
}

function renderSidebar() {
  const counts = state.stats.counts || {};
  for (const f of STATUS_FILTERS) {
    const el = $(`[data-count="${f.key}"]`);
    if (el) el.textContent = counts[f.key] ?? 0;
  }
  $$('#status-filters .filter').forEach((b) => {
    b.classList.toggle('on', state.filter.status === b.dataset.status
      && state.filter.category === null && state.filter.tag === null);
  });

  renderChipFilters('#category-filters', state.categories, 'category', 'No categories');
  renderChipFilters('#tag-filters', state.tags, 'tag', 'No tags');

  $('#free-space').textContent = F.bytes(state.stats.free_space || 0);
  const path = state.stats.download_dir || '';
  const pathEl = $('#dl-path');
  // The element is `direction: rtl` so long paths truncate from the left,
  // keeping the filename visible. That reorders leading neutral characters,
  // so "/home/..." renders as "home/.../". A LEFT-TO-RIGHT MARK anchors it.
  pathEl.textContent = path ? `\u200e${path}` : '';
  pathEl.title = path;
}

function renderChipFilters(selector, items, kind, emptyText) {
  const root = $(selector);
  if (!items.length) {
    root.innerHTML = `<div class="filter dim" style="cursor:default">${emptyText}</div>`;
    return;
  }
  const active = state.filter[kind];
  root.innerHTML = items.map((item) =>
    `<button class="filter${active === item.name ? ' on' : ''}" data-${kind}="${F.esc(item.name)}">
       <span class="label">${F.esc(item.name)}</span>
       <span class="count">${item.count}</span>
     </button>`).join('');

  if (root.dataset.wired) return;
  root.dataset.wired = '1';
  root.addEventListener('click', (event) => {
    const button = event.target.closest(`[data-${kind}]`);
    if (!button) return;
    const value = button.dataset[kind];
    // Clicking the active filter clears it — a back button you don't have to hunt for.
    state.filter[kind] = state.filter[kind] === value ? null : value;
    const other = kind === 'category' ? 'tag' : 'category';
    state.filter[other] = null;
    state.filter.status = 'all';
    queueLayoutAnimation();
    renderAll();
  });
  root.addEventListener('contextmenu', (event) => {
    const button = event.target.closest(`[data-${kind}]`);
    if (!button || kind !== 'category') return;
    event.preventDefault();
    const name = button.dataset.category;
    contextMenu(event.clientX, event.clientY, [
      { label: `Pause all in “${name}”`, run: () => actOnCategory(name, 'pause') },
      { label: `Resume all in “${name}”`, run: () => actOnCategory(name, 'resume') },
      { separator: true },
      { label: 'Remove category from all', danger: true, run: () => actOnCategory(name, 'uncategorise') },
    ]);
  });
}

async function actOnCategory(name, action) {
  const hashes = Array.from(state.torrents.values())
    .filter((t) => t.category === name).map((t) => t.hash);
  if (!hashes.length) return;
  try {
    if (action === 'uncategorise') await api.action('set_category', hashes, { category: '' });
    else await api.action(action, hashes);
  } catch (err) { toastError(err); }
}

/* ─────────────────────────────── table ─────────────────────────────── */

function buildTableHead() {
  const cols = visibleColumns();
  $('#head-row').innerHTML = cols.map((c) => {
    const sorted = state.sort.key === c.key;
    const arrow = state.sort.dir > 0 ? '▲' : '▼';
    return `<th data-key="${c.key}" class="col-${c.key}${c.num ? ' num' : ''}${sorted ? ' sorted' : ''}"
             ${c.width ? `style="width:${c.width}px"` : ''}>
             ${F.esc(c.label)}<span class="sort">${arrow}</span></th>`;
  }).join('');

  const head = $('#head-row');
  if (head.dataset.wired) return;
  head.dataset.wired = '1';
  head.addEventListener('click', (event) => {
    const th = event.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    if (state.sort.key === key) state.sort.dir *= -1;
    else { state.sort.key = key; state.sort.dir = key === 'name' ? 1 : -1; }
    queueLayoutAnimation();
    buildTableHead();
    renderTable();
  });
  head.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const chosen = state.prefs.columns || VISIBLE_DEFAULT;
    contextMenu(event.clientX, event.clientY, [
      { header: 'Columns' },
      ...COLUMNS.filter((c) => c.key !== 'name').map((c) => ({
        label: `${chosen.includes(c.key) ? '✓ ' : '   '}${c.label}`,
        run: () => {
          const next = chosen.includes(c.key)
            ? chosen.filter((k) => k !== c.key)
            : [...chosen, c.key];
          state.prefs.columns = COLUMNS.filter((x) => next.includes(x.key) || x.key === 'name')
            .map((x) => x.key);
          savePrefs();
          buildTableHead();
          renderTable(true);
        },
      })),
    ]);
  });
}

const rowCache = new Map();   // hash -> <tr>

let lastColumnSignature = '';

/* Rows move for two very different reasons, and only one of them deserves an
   animation. A user re-sorting or filtering is a deliberate rearrangement
   worth showing; the 1 Hz refresh nudging a row because a speed ticked is
   not — animating that would leave the table permanently in motion. So
   layout animation is opt-in, armed by the interactions that cause it. */
let pendingLayoutAnim = false;
function queueLayoutAnimation() { pendingLayoutAnim = true; }

function renderTable(force = false) {
  const tbody = $('#rows');
  const cols = visibleColumns();
  // Cell classes are written once at row creation, so a column change has to
  // invalidate the cache rather than try to patch existing rows.
  const signature = cols.map((c) => c.key).join(',');
  if (signature !== lastColumnSignature) { lastColumnSignature = signature; force = true; }
  const list = visibleTorrents();

  $('#empty').hidden = list.length > 0 || state.torrents.size > 0;
  if (state.torrents.size > 0 && list.length === 0) {
    $('#empty').hidden = false;
    $('#empty').querySelector('h2').textContent = 'No matches';
    $('#empty').querySelector('p').textContent = 'No torrents match the current filter.';
    $('#btn-add-empty').hidden = true;
  } else if (state.torrents.size === 0) {
    $('#empty').querySelector('h2').textContent = 'Nothing here yet';
    $('#empty').querySelector('p').innerHTML =
      'Drop a <code>.torrent</code> file anywhere, paste a magnet link, or press <kbd>N</kbd>.';
    $('#btn-add-empty').hidden = false;
  }

  if (force) { rowCache.clear(); tbody.innerHTML = ''; }

  // FLIP, first half: record where every existing row sits before we touch
  // the DOM. Cheap because it is one read pass with no interleaved writes.
  const animate = pendingLayoutAnim && !force && rowCache.size > 0;
  pendingLayoutAnim = false;
  const before = animate ? new Map() : null;
  if (animate) {
    for (const [hash, tr] of rowCache) {
      if (tr.isConnected) before.set(hash, tr.getBoundingClientRect().top);
    }
  }

  // Reconcile in place: rows are keyed by hash so the browser keeps scroll
  // position, text selection and hover state across the 1 Hz refresh.
  const seen = new Set();
  const fresh = [];
  list.forEach((t, index) => {
    seen.add(t.hash);
    let tr = rowCache.get(t.hash);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.hash = t.hash;
      fresh.push(tr);
      tr.innerHTML = cols.map((c) =>
        `<td class="col-${c.key}${c.num ? ' num' : ''}${c.key === 'name' ? ' name' : ''}"></td>`).join('');
      rowCache.set(t.hash, tr);
    }
    const cells = tr.children;
    cols.forEach((c, i) => {
      const td = cells[i];
      if (!td) return;
      const html = c.html ? c.html(t) : F.esc(c.text ? c.text(t) : t[c.key]);
      if (td._v !== html) { td.innerHTML = html; td._v = html; }
    });
    tr.classList.toggle('sel', state.selection.has(t.hash));

    const current = tbody.children[index];
    if (current !== tr) tbody.insertBefore(tr, current || null);
  });

  for (const [hash, tr] of rowCache) {
    if (!seen.has(hash)) { tr.remove(); rowCache.delete(hash); }
  }

  // A torrent that has just appeared slides in. Skip it on the very first
  // paint, where every row is "new" and the whole table would animate.
  if (!force && rowCache.size > fresh.length) {
    for (const tr of fresh) playOnce(tr, 'enter');
  }

  // FLIP, second half: invert each moved row to its old position and let the
  // animation carry it back to the new one.
  if (animate && before) {
    for (const [hash, tr] of rowCache) {
      const was = before.get(hash);
      if (was === undefined || !tr.isConnected) continue;
      const dy = was - tr.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      tr.style.setProperty('--dy', `${dy}px`);
      playOnce(tr, 'flip', () => tr.style.removeProperty('--dy'));
    }
  }

  $('#table').setAttribute('aria-rowcount', String(list.length));
}

/** Add an animation class and strip it once the animation ends. */
function playOnce(el, className, done) {
  el.classList.remove(className);
  // Force a reflow so re-adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add(className);
  el.addEventListener('animationend', function off() {
    el.classList.remove(className);
    el.removeEventListener('animationend', off);
    if (done) done();
  }, { once: true });
}

/* ───────────────────────────── selection ───────────────────────────── */

function selected() {
  return Array.from(state.selection).filter((h) => state.torrents.has(h));
}

function selectHash(hash, { toggle = false, range = false } = {}) {
  const list = visibleTorrents().map((t) => t.hash);
  if (range && state.anchor && list.includes(state.anchor)) {
    const a = list.indexOf(state.anchor);
    const b = list.indexOf(hash);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    state.selection = new Set(list.slice(lo, hi + 1));
  } else if (toggle) {
    if (state.selection.has(hash)) state.selection.delete(hash);
    else state.selection.add(hash);
    state.anchor = hash;
  } else {
    state.selection = new Set([hash]);
    state.anchor = hash;
  }
  if (state.detailHash) openDetail(hash);
  renderTable();
  renderToolbar();
}

function selectAllVisible() {
  state.selection = new Set(visibleTorrents().map((t) => t.hash));
  renderTable();
  renderToolbar();
}

function renderToolbar() {
  const count = selected().length;
  $$('#toolbar [data-act]').forEach((b) => { b.disabled = count === 0; });
  const info = $('#selection-info');
  if (count === 0) { info.textContent = ''; return; }
  const chosen = selected().map((h) => state.torrents.get(h));
  const size = chosen.reduce((sum, t) => sum + t.size, 0);
  info.textContent = `${count} selected · ${F.bytes(size)}`;
}

/* ───────────────────────────── status bar ───────────────────────────── */

function renderStatusBar() {
  const s = state.stats;
  const c = s.counts || {};
  $('#rate-down').textContent = F.speed(s.dlspeed || 0).replace('—', '0 B/s');
  $('#rate-up').textContent = F.speed(s.upspeed || 0).replace('—', '0 B/s');

  const limits = [];
  if (s.dl_limit) limits.push(`↓ limit ${F.bytes(s.dl_limit)}/s`);
  if (s.up_limit) limits.push(`↑ limit ${F.bytes(s.up_limit)}/s`);
  $('.rates').title = limits.length ? limits.join('  ·  ') : 'No speed limits set';

  $('#stat-counts').textContent =
    `${c.all || 0} torrents · ${c.downloading || 0} downloading · ${c.seeding || 0} seeding`;
  $('#stat-dht').textContent = s.dht_running ? `DHT ${s.dht_nodes || 0}` : 'DHT off';
  $('#stat-port').textContent = `Port ${s.listen_port || '—'}${s.is_listening ? '' : ' (closed)'}`;
  $('#stat-session').textContent =
    `↓ ${F.bytes(s.session_downloaded || 0)}   ↑ ${F.bytes(s.session_uploaded || 0)}`;
  $('#stat-version').textContent = s.lt_version ? `libtorrent ${s.lt_version}` : '';
  $('#btn-alt').classList.toggle('active', !!s.alt_speed);
  $('#btn-alt').setAttribute('aria-pressed', String(!!s.alt_speed));
}

/* ───────────────────────────── sparkline ───────────────────────────── */

function drawSparkline() {
  const canvas = $('#spark');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 150;
  const h = canvas.clientHeight || 34;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const down = (state.stats.down_history || []).slice(-60);
  const up = (state.stats.up_history || []).slice(-60);
  if (!down.length) return;

  // A shared scale keeps the two series honestly comparable.
  const peak = Math.max(1, ...down, ...up);
  const css = getComputedStyle(document.documentElement);
  const series = [
    { data: down, color: css.getPropertyValue('--s-download').trim() },
    { data: up, color: css.getPropertyValue('--s-seed').trim() },
  ];

  for (const { data, color } of series) {
    const step = w / Math.max(1, data.length - 1);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * step;
      const y = h - 2 - (v / peak) * (h - 5);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, color + '38');
    gradient.addColorStop(1, color + '00');
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

/* ─────────────────────────── detail panel ─────────────────────────── */

function toggleDetail(force) {
  const open = force !== undefined ? force : $('#detail').hidden;
  $('#detail').hidden = !open;
  $('.body').classList.toggle('with-detail', open);
  state.prefs.detailOpen = open;
  savePrefs();
  if (open) {
    const hash = state.detailHash || selected()[0] || visibleTorrents()[0]?.hash;
    if (hash) openDetail(hash);
  } else {
    state.detailHash = null;
    live.watch('');
  }
}

function openDetail(hash) {
  if (!hash || !state.torrents.has(hash)) return;
  const changed = state.detailHash !== hash;
  state.detailHash = hash;
  if (changed) state.detail = null;
  if ($('#detail').hidden) toggleDetail(true);
  live.watch(hash);
  renderDetail();
}

function closeDetail() {
  state.detailHash = null;
  state.detail = null;
  live.watch('');
  $('#detail').hidden = true;
  $('.body').classList.remove('with-detail');
}

function renderDetail() {
  const body = $('#detail-body');
  const t = state.detail;
  const live_ = state.detailHash ? state.torrents.get(state.detailHash) : null;
  $('#detail-title').textContent = (t && t.name) || (live_ && live_.name) || '—';
  $('#detail-title').title = $('#detail-title').textContent;

  if (!t) {
    body.innerHTML = '<div class="palette-empty">Loading…</div>';
    return;
  }
  const renderers = {
    general: detailGeneral, files: detailFiles, peers: detailPeers,
    trackers: detailTrackers, pieces: detailPieces, speed: detailSpeed,
  };
  (renderers[state.detailTab] || detailGeneral)(body, t);
}

function detailGeneral(root, t) {
  const stat = (label, value) =>
    `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
  const kv = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;

  root.innerHTML = `
    <div class="section">
      <div class="stat-grid">
        ${stat('Progress', F.pct(t.progress))}
        ${stat('Download', F.speed(t.dlspeed))}
        ${stat('Upload', F.speed(t.upspeed))}
        ${stat('Ratio', F.ratio(t.ratio))}
        ${stat('Seeds', `${t.seeds}<span class="muted" style="font-size:11px"> / ${t.seeds_total}</span>`)}
        ${stat('Peers', `${t.peers}<span class="muted" style="font-size:11px"> / ${t.peers_total}</span>`)}
        ${stat('ETA', F.eta(t.eta))}
        ${stat('Availability', (t.availability || 0).toFixed(2))}
      </div>
    </div>

    <div class="section">
      <h3>Transfer</h3>
      <dl class="kv">
        ${kv('Status', `<span class="s-${t.state}">${F.stateLabel(t.state)}</span>`)}
        ${kv('Downloaded', `${F.bytes(t.downloaded)} <span class="muted">of ${F.bytes(t.size)}</span>`)}
        ${kv('Uploaded', F.bytes(t.uploaded))}
        ${kv('Wasted', F.bytes(t.total_failed + t.total_redundant))}
        ${kv('Connections', `${t.connections}<span class="muted"> / ${t.max_connections}</span>`)}
        ${kv('Active for', F.duration(t.active_time, 3))}
        ${kv('Seeding for', F.duration(t.seeding_time, 3))}
        ${kv('Last activity', F.ago(t.last_activity))}
        ${kv('Speed limits', `↓ ${t.dl_limit ? F.bytes(t.dl_limit) + '/s' : 'Unlimited'} · ↑ ${t.up_limit ? F.bytes(t.up_limit) + '/s' : 'Unlimited'}`)}
      </dl>
    </div>

    <div class="section">
      <h3>Torrent</h3>
      <dl class="kv">
        ${kv('Size', `${F.bytes(t.size)}${t.size !== t.size_total ? ` <span class="muted">(${F.bytes(t.size_total)} total)</span>` : ''}`)}
        ${kv('Files', t.num_files || '—')}
        ${kv('Pieces', t.num_pieces ? `${t.num_pieces} × ${F.bytes(t.piece_length)} <span class="muted">(${t.pieces_have} have)</span>` : '—')}
        ${kv('Added', F.date(t.added_on))}
        ${kv('Completed', t.completed_on ? F.date(t.completed_on) : '—')}
        ${kv('Created', t.creation_date ? F.date(t.creation_date) : '—')}
        ${kv('Created by', F.esc(t.created_by) || '—')}
        ${kv('Private', t.private ? 'Yes — DHT and PeX disabled' : 'No')}
        ${kv('Save path', `<span class="mono" style="font-size:11px">${F.esc(t.save_path)}</span>`)}
        ${kv('Hash', `<span class="mono" style="font-size:11px;overflow-wrap:anywhere">${F.esc(t.hash)}</span>`)}
        ${t.comment ? kv('Comment', F.esc(t.comment)) : ''}
      </dl>
    </div>

    <div class="section">
      <h3>Actions</h3>
      <div class="file-tools">
        <button class="btn sm" data-d="magnet">Copy magnet</button>
        <button class="btn sm" data-d="torrent">Save .torrent</button>
        <button class="btn sm" data-d="limits">Speed limits…</button>
        <button class="btn sm" data-d="move">Move files…</button>
      </div>
      <label class="check"><input type="checkbox" data-d="sequential" ${t.sequential ? 'checked' : ''}>
        <span><span class="ctext">Sequential download</span>
        <span class="chint">Fetch pieces in order — useful for previewing media.</span></span></label>
      <label class="check"><input type="checkbox" data-d="super_seeding" ${t.super_seeding ? 'checked' : ''}>
        <span><span class="ctext">Super seeding</span>
        <span class="chint">Distribute rare pieces first when you are the only seed.</span></span></label>
    </div>`;

  root.querySelectorAll('[data-d]').forEach((el) => {
    const kind = el.dataset.d;
    if (el.type === 'checkbox') {
      el.addEventListener('change', () =>
        api.action('set_flag', [t.hash], { flag: kind, enabled: el.checked }).catch(toastError));
    } else {
      el.addEventListener('click', () => {
        if (kind === 'magnet') copyText(t.magnet).then(() => toast('Magnet link copied'), toastError);
        if (kind === 'torrent') window.open(`/api/torrents/${t.hash}/file`, '_blank');
        if (kind === 'limits') limitsDialog([t.hash]);
        if (kind === 'move') moveDialog([t.hash]);
      });
    }
  });
}

/* ── files ── */

function buildFileTree(files) {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const file of files) {
    if (file.pad) continue;               // padding files are an implementation detail
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(file);
  }
  return root;
}

const collapsedDirs = new Set();

function detailFiles(root, t) {
  if (!t.files.length) {
    root.innerHTML = '<div class="palette-empty">File list appears once metadata arrives.</div>';
    return;
  }
  const tree = buildFileTree(t.files);
  const wanted = t.files.filter((f) => !f.pad && f.priority > 0).length;

  root.innerHTML = `
    <div class="file-tools">
      <button class="btn sm" data-f="all">Select all</button>
      <button class="btn sm" data-f="none">Select none</button>
      <button class="btn sm" data-f="invert">Invert</button>
      <span class="spacer"></span>
      <span class="muted" style="font-size:11px">${wanted} of ${t.files.filter((f) => !f.pad).length} selected</span>
    </div>
    <div id="file-tree">${renderTreeNode(tree, '')}</div>`;

  root.querySelectorAll('[data-f]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.f;
      const priorities = {};
      for (const file of t.files) {
        if (file.pad) continue;
        priorities[file.index] = mode === 'all' ? 4 : mode === 'none' ? 0 : (file.priority > 0 ? 0 : 4);
      }
      setPriorities(t.hash, priorities);
    });
  });

  root.querySelectorAll('.folder-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('input')) return;
      const key = row.dataset.path;
      if (collapsedDirs.has(key)) collapsedDirs.delete(key); else collapsedDirs.add(key);
      renderDetail();
    });
  });

  root.querySelectorAll('.file-row input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () =>
      setPriorities(t.hash, { [box.dataset.index]: box.checked ? 4 : 0 }));
  });
  root.querySelectorAll('.file-row select').forEach((sel) => {
    sel.addEventListener('change', () =>
      setPriorities(t.hash, { [sel.dataset.index]: Number(sel.value) }));
  });
  root.querySelectorAll('.folder-row input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () => {
      const prefix = box.dataset.path;
      const priorities = {};
      for (const file of t.files) {
        if (!file.pad && file.path.startsWith(prefix)) priorities[file.index] = box.checked ? 4 : 0;
      }
      setPriorities(t.hash, priorities);
    });
  });
}

function renderTreeNode(node, prefix) {
  let html = '';
  for (const [name, dir] of node.dirs) {
    const path = prefix + name + '/';
    const closed = collapsedDirs.has(path);
    html += `<div class="folder-row${closed ? ' closed' : ''}" data-path="${F.esc(path)}" style="cursor:pointer">
        <svg viewBox="0 0 24 24" class="ico caret"><path d="M6 9l6 6 6-6"/></svg>
        <input type="checkbox" data-path="${F.esc(path)}" ${dirChecked(dir) ? 'checked' : ''}>
        <span>${F.esc(name)}</span>
      </div>
      ${closed ? '' : `<div class="file-children">${renderTreeNode(dir, path)}</div>`}`;
  }
  for (const file of node.files) {
    const skipped = file.priority === 0;
    html += `<div class="file-row${skipped ? ' skip' : ''}">
        <input type="checkbox" data-index="${file.index}" ${skipped ? '' : 'checked'}>
        <span class="fname" title="${F.esc(file.path)}">${F.esc(file.name)}</span>
        <div class="bar fbar"><i style="width:${(file.progress * 100).toFixed(1)}%"></i></div>
        <span class="fsize">${F.bytes(file.size)}</span>
        <select data-index="${file.index}">
          <option value="0"${file.priority === 0 ? ' selected' : ''}>Skip</option>
          <option value="1"${file.priority === 1 ? ' selected' : ''}>Low</option>
          <option value="4"${file.priority >= 2 && file.priority <= 6 ? ' selected' : ''}>Normal</option>
          <option value="7"${file.priority === 7 ? ' selected' : ''}>High</option>
        </select>
      </div>`;
  }
  return html;
}

function dirChecked(node) {
  for (const file of node.files) if (file.priority > 0) return true;
  for (const [, dir] of node.dirs) if (dirChecked(dir)) return true;
  return false;
}

async function setPriorities(hash, priorities) {
  try {
    await api.post(`/api/torrents/${hash}/files`, { priorities });
    // Reflect immediately rather than waiting for the next detail push.
    if (state.detail && state.detail.hash === hash) {
      for (const file of state.detail.files) {
        if (priorities[file.index] !== undefined) file.priority = priorities[file.index];
      }
      renderDetail();
    }
  } catch (err) { toastError(err); }
}

/* ── peers ── */

function detailPeers(root, t) {
  const peers = t.peer_list || [];
  if (!peers.length) {
    root.innerHTML = '<div class="palette-empty">No peers connected right now.</div>';
    return;
  }
  root.innerHTML = `
    <table class="mini-table">
      <thead><tr>
        <th style="width:34%">Address</th><th style="width:26%">Client</th>
        <th class="num">Prog</th><th class="num">Down</th><th class="num">Up</th><th style="width:40px">Flags</th>
      </tr></thead>
      <tbody>${peers.map((p) => {
        const flags = [
          p.seed ? 'S' : '', p.encrypted ? 'E' : '', p.utp ? 'μ' : '',
          p.incoming ? 'I' : '', p.snubbed ? 'N' : '',
        ].filter(Boolean).join('');
        return `<tr>
          <td class="mono" title="${F.esc(p.ip)}:${p.port}">${F.esc(p.ip)}<span class="dim">:${p.port}</span></td>
          <td title="${F.esc(p.client)}">${F.esc(p.client)}</td>
          <td class="num">${F.pct(p.progress, 0)}</td>
          <td class="num" style="color:${p.down ? 'var(--s-download)' : 'inherit'}">${p.down ? F.bytes(p.down) + '/s' : '—'}</td>
          <td class="num" style="color:${p.up ? 'var(--s-seed)' : 'inherit'}">${p.up ? F.bytes(p.up) + '/s' : '—'}</td>
          <td class="mono" title="Source: ${F.esc(p.source)}">${F.esc(flags)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <div class="legend">
      <span><b>S</b> seed</span><span><b>E</b> encrypted</span><span><b>μ</b> µTP</span>
      <span><b>I</b> incoming</span><span><b>N</b> snubbed</span>
    </div>`;
}

/* ── trackers ── */

function detailTrackers(root, t) {
  root.innerHTML = `
    <div class="file-tools">
      <button class="btn sm" data-tr="add">Add tracker…</button>
      <button class="btn sm" data-tr="reannounce">Reannounce</button>
    </div>
    <table class="mini-table">
      <thead><tr><th>Tracker</th><th class="num">Seeds</th><th class="num">Peers</th><th style="width:30%">Status</th></tr></thead>
      <tbody>${t.trackers.map((tr) => `
        <tr data-url="${F.esc(tr.url)}">
          <td title="${F.esc(tr.url)}">${F.esc(tr.url)}</td>
          <td class="num">${tr.seeds < 0 ? '—' : tr.seeds}</td>
          <td class="num">${tr.leeches < 0 ? '—' : tr.leeches}</td>
          <td title="${F.esc(tr.message)}" style="color:${tr.fails ? 'var(--s-error)' : tr.verified ? 'var(--s-seed)' : 'inherit'}">
            ${tr.fails ? `Failed (${tr.fails})` : tr.verified ? 'Working' : F.esc(tr.message) || 'Not contacted'}
          </td>
        </tr>`).join('')}</tbody>
    </table>`;

  root.querySelector('[data-tr="add"]').addEventListener('click', () => addTrackersDialog(t.hash));
  root.querySelector('[data-tr="reannounce"]').addEventListener('click', () =>
    api.action('reannounce', [t.hash]).then(() => toast('Reannounced to all trackers')).catch(toastError));

  root.querySelectorAll('tbody tr').forEach((row) => {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const url = row.dataset.url;
      if (url.startsWith('**')) return;   // the DHT/LSD/PeX pseudo-rows
      contextMenu(event.clientX, event.clientY, [
        { label: 'Copy URL', run: () => copyText(url).then(() => toast('Copied')) },
        { separator: true },
        { label: 'Remove tracker', danger: true, run: async () => {
          try {
            await api.post(`/api/torrents/${t.hash}/trackers`, { op: 'remove', urls: [url] });
            toast('Tracker removed');
          } catch (err) { toastError(err); }
        } },
      ]);
    });
  });
}

/* ── pieces ── */

function detailPieces(root, t) {
  const p = t.pieces || { buckets: [], total: 0 };
  if (!p.total) {
    root.innerHTML = '<div class="palette-empty">The piece map appears once metadata arrives.</div>';
    return;
  }
  root.innerHTML = `
    <div class="canvas-box"><canvas id="piece-canvas" height="96"></canvas></div>
    <div class="legend">
      <span><i style="background:var(--s-seed)"></i>Complete</span>
      <span><i style="background:var(--s-download)"></i>Downloading</span>
      <span><i style="background:var(--accent)"></i>Partial</span>
      <span><i style="background:var(--surface-3)"></i>Missing</span>
    </div>
    <div class="section" style="margin-top:14px">
      <dl class="kv">
        <dt>Pieces</dt><dd>${p.have} of ${p.total} · ${F.bytes(p.piece_size)} each</dd>
        <dt>Downloaded</dt><dd>${F.bytes(t.done)} of ${F.bytes(t.size)}</dd>
      </dl>
    </div>`;
  drawPieces($('#piece-canvas'), p.buckets);
}

function drawPieces(canvas, buckets) {
  if (!canvas || !buckets.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 96;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const css = getComputedStyle(document.documentElement);
  const colors = [
    css.getPropertyValue('--surface-3').trim(),   // 0 missing
    css.getPropertyValue('--s-seed').trim(),      // 1 complete
    css.getPropertyValue('--s-download').trim(),  // 2 downloading
    css.getPropertyValue('--accent').trim(),      // 3 partial
  ];

  // Lay the buckets out as a grid of blocks so even a 50k-piece torrent stays
  // readable in a panel a few hundred pixels wide.
  const cols = Math.ceil(Math.sqrt(buckets.length * (w / h)));
  const rows = Math.ceil(buckets.length / cols);
  const bw = w / cols;
  const bh = h / rows;
  ctx.clearRect(0, 0, w, h);
  buckets.forEach((v, i) => {
    ctx.fillStyle = colors[v] || colors[0];
    const x = (i % cols) * bw;
    const y = Math.floor(i / cols) * bh;
    ctx.fillRect(x, y, Math.max(1, bw - 0.6), Math.max(1, bh - 0.6));
  });
}

/* ── speed chart ── */

function detailSpeed(root, t) {
  root.innerHTML = `
    <div class="canvas-box"><canvas id="speed-canvas" height="170"></canvas></div>
    <div class="legend">
      <span><i style="background:var(--s-download)"></i>Download</span>
      <span><i style="background:var(--s-seed)"></i>Upload</span>
      <span class="spacer"></span>
      <span id="speed-peak"></span>
    </div>
    <div class="section" style="margin-top:16px">
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Down now</div><div class="stat-value">${F.speed(t.dlspeed)}</div></div>
        <div class="stat"><div class="stat-label">Up now</div><div class="stat-value">${F.speed(t.upspeed)}</div></div>
        <div class="stat"><div class="stat-label">Downloaded</div><div class="stat-value">${F.bytes(t.downloaded)}</div></div>
        <div class="stat"><div class="stat-label">Uploaded</div><div class="stat-value">${F.bytes(t.uploaded)}</div></div>
      </div>
    </div>`;
  drawChart($('#speed-canvas'), t.down_history || [], t.up_history || [], $('#speed-peak'));
}

function drawChart(canvas, down, up, peakLabel) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 170;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue('--border').trim();
  const observed = Math.max(0, ...down, ...up);
  const peak = Math.max(1, observed);
  // "Peak 1 B/s" is a confusing way to say a torrent has never transferred.
  if (peakLabel) peakLabel.textContent = observed ? `Peak ${F.bytes(observed)}/s` : 'No traffic yet';

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round((h - 1) * (i / 4)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  for (const [data, varName] of [[down, '--s-download'], [up, '--s-seed']]) {
    if (data.length < 2) continue;
    const color = css.getPropertyValue(varName).trim();
    const step = w / (data.length - 1);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * step;
      const y = h - 2 - (v / peak) * (h - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, color + '33');
    gradient.addColorStop(1, color + '00');
    ctx.fillStyle = gradient;
    ctx.fill();
  }
}

/* ─────────────────────────────── actions ─────────────────────────────── */

async function run(action, hashes, extra, message) {
  const targets = hashes || selected();
  if (!targets.length) return;
  try {
    const result = await api.action(action, targets, extra);
    if (message) toast(message.replace('{n}', result.count));
  } catch (err) { toastError(err); }
}

async function removeSelected(hashes) {
  const targets = hashes || selected();
  if (!targets.length) return;
  const names = targets.map((h) => state.torrents.get(h)).filter(Boolean);
  const label = targets.length === 1
    ? `<b>${F.esc(names[0] ? names[0].name : '')}</b>`
    : `<b>${targets.length} torrents</b>`;
  const size = names.reduce((sum, t) => sum + (t.done || 0), 0);

  if (state.prefs.confirmDelete) {
    const answer = await confirmDialog({
      title: 'Remove torrent' + (targets.length > 1 ? 's' : ''),
      message: `Remove ${label} from Fission?`,
      confirmLabel: 'Remove',
      danger: true,
      extra: `<label class="check" style="margin-top:12px">
                <input type="checkbox" data-key="withData">
                <span><span class="ctext">Also delete downloaded files</span>
                <span class="chint">Permanently erases ${F.bytes(size)} from disk. This cannot be undone.</span></span>
              </label>`,
    });
    if (!answer.ok) return;
    await run('remove', targets, { with_data: !!answer.withData },
      answer.withData ? 'Removed {n} torrent(s) and their files' : 'Removed {n} torrent(s)');
  } else {
    await run('remove', targets, { with_data: false }, 'Removed {n} torrent(s)');
  }
  state.selection.clear();
  renderToolbar();
}

/** Space toggles: pause if anything is running, otherwise resume everything. */
function togglePlay(hashes) {
  const targets = hashes || selected();
  if (!targets.length) return;
  const anyRunning = targets.some((h) => {
    const t = state.torrents.get(h);
    return t && !['paused', 'paused_seed'].includes(t.state);
  });
  run(anyRunning ? 'pause' : 'resume', targets);
}

function rowContextMenu(event, hash) {
  if (!state.selection.has(hash)) selectHash(hash);
  const targets = selected();
  const t = state.torrents.get(hash);
  if (!t) return;
  const many = targets.length > 1;

  contextMenu(event.clientX, event.clientY, [
    { label: many ? `Resume ${targets.length}` : 'Resume', shortcut: 'Space',
      icon: '<path d="M7 4l13 8-13 8z"/>', run: () => run('resume', targets) },
    { label: many ? `Pause ${targets.length}` : 'Pause',
      icon: '<path d="M8 4h3v16H8zM13 4h3v16h-3z"/>', run: () => run('pause', targets) },
    { label: 'Force start', icon: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
      run: () => run('force_start', targets, null, 'Force-started {n} torrent(s)') },
    { separator: true },
    { header: 'Queue' },
    { label: 'Move to top', run: () => run('queue', targets, { direction: 'top' }) },
    { label: 'Move up', run: () => run('queue', targets, { direction: 'up' }) },
    { label: 'Move down', run: () => run('queue', targets, { direction: 'down' }) },
    { label: 'Move to bottom', run: () => run('queue', targets, { direction: 'bottom' }) },
    { separator: true },
    { label: 'Force recheck', icon: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
      run: () => confirmRecheck(targets) },
    { label: 'Reannounce', run: () => run('reannounce', targets, null, 'Reannounced {n} torrent(s)') },
    { separator: true },
    { label: 'Set category…', run: () => categoryDialog(targets) },
    { label: 'Set tags…', run: () => tagsDialog(targets) },
    { label: 'Speed limits…', run: () => limitsDialog(targets) },
    { label: 'Move files…', run: () => moveDialog(targets) },
    { label: 'Rename…', disabled: many, run: () => renameDialog(hash) },
    { separator: true },
    { label: 'Sequential download', icon: t.sequential ? '<path d="M5 12l5 5 9-9"/>' : '',
      run: () => run('set_flag', targets, { flag: 'sequential_download', enabled: !t.sequential }) },
    { label: 'Copy magnet link', icon: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/>',
      run: async () => {
        const detail = await api.get(`/api/torrents/${hash}`).catch(() => null);
        if (detail) copyText(detail.magnet).then(() => toast('Magnet link copied'), toastError);
      } },
    { label: 'Save .torrent file', run: () => window.open(`/api/torrents/${hash}/file`, '_blank') },
    { label: 'Show details', shortcut: 'I', run: () => openDetail(hash) },
    { separator: true },
    { label: many ? `Remove ${targets.length}…` : 'Remove…', shortcut: 'Del', danger: true,
      icon: '<path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3"/>', run: () => removeSelected(targets) },
  ]);
}

async function confirmRecheck(targets) {
  const answer = await confirmDialog({
    title: 'Force recheck',
    message: `Re-verify every piece of ${targets.length === 1 ? 'this torrent' : `these ${targets.length} torrents`} against the files on disk? This can take a while for large torrents.`,
    confirmLabel: 'Recheck',
  });
  if (answer.ok) run('recheck', targets, null, 'Rechecking {n} torrent(s)');
}

/* ─────────────────────────────── dialogs ─────────────────────────────── */

function addDialog(prefill = '') {
  modal({
    title: 'Add torrent',
    body: `
      <div class="field">
        <label for="add-urls">Magnet links or info hashes</label>
        <textarea id="add-urls" placeholder="magnet:?xt=urn:btih:…&#10;One per line">${F.esc(prefill)}</textarea>
        <div class="hint">Or <button type="button" class="btn sm" id="add-pick" style="height:22px">choose .torrent files…</button></div>
        <input type="file" id="add-files" accept=".torrent,application/x-bittorrent" multiple hidden>
        <div class="hint" id="add-filelist" hidden></div>
      </div>
      <div class="field">
        <label for="add-path">Save to</label>
        <div class="inline">
          <input type="text" id="add-path" placeholder="Default download folder">
          <button type="button" class="btn" id="add-browse">Browse…</button>
        </div>
      </div>
      <div class="row">
        <div class="field"><label for="add-category">Category</label>
          <input type="text" id="add-category" list="cat-list" placeholder="None">
          <datalist id="cat-list">${state.categories.map((c) => `<option value="${F.esc(c.name)}">`).join('')}</datalist>
        </div>
        <div class="field"><label for="add-tags">Tags</label>
          <input type="text" id="add-tags" placeholder="comma, separated"></div>
      </div>
      <label class="check"><input type="checkbox" id="add-paused">
        <span><span class="ctext">Start paused</span></span></label>
      <label class="check"><input type="checkbox" id="add-seq">
        <span><span class="ctext">Sequential download</span></span></label>
      <label class="check"><input type="checkbox" id="add-skip">
        <span><span class="ctext">Skip hash check</span>
        <span class="chint">Only when you are certain the files on disk are already correct.</span></span></label>`,
    footer: `<button class="btn" data-close>Cancel</button>
             <button class="btn primary" id="add-go">Add torrent</button>`,
    onMount(el, close) {
      const filesInput = $('#add-files', el);
      const list = $('#add-filelist', el);
      $('#add-pick', el).addEventListener('click', () => filesInput.click());
      filesInput.addEventListener('change', () => {
        const names = Array.from(filesInput.files).map((f) => f.name);
        list.hidden = !names.length;
        list.textContent = names.length ? `${names.length} file(s): ${names.join(', ')}` : '';
      });
      $('#add-browse', el).addEventListener('click', () =>
        browseDialog($('#add-path', el).value, (path) => { $('#add-path', el).value = path; }));

      $('#add-go', el).addEventListener('click', async () => {
        const options = {
          save_path: $('#add-path', el).value.trim(),
          category: $('#add-category', el).value.trim(),
          tags: $('#add-tags', el).value.trim(),
          paused: $('#add-paused', el).checked,
          sequential: $('#add-seq', el).checked,
          skip_check: $('#add-skip', el).checked,
        };
        const urls = $('#add-urls', el).value.trim();
        const files = Array.from(filesInput.files);
        if (!urls && !files.length) { toast('Nothing to add', 'Paste a magnet link or pick a file', 'warn'); return; }
        try {
          let count = 0;
          if (files.length) count += (await api.upload(files, options)).count;
          if (urls) count += (await api.post('/api/add', { urls, ...options })).count;
          close();
          toast(`Added ${count} torrent${count === 1 ? '' : 's'}`);
        } catch (err) { toastError(err); }
      });
    },
  });
}

function browseDialog(startPath, onPick) {
  let current = startPath || '';
  const { el, close } = modal({
    title: 'Choose a folder',
    body: '<div id="browse-body">Loading…</div>',
    footer: `<button class="btn" data-close>Cancel</button>
             <button class="btn primary" id="browse-pick">Use this folder</button>`,
    onMount(node) {
      node.querySelector('#browse-pick').addEventListener('click', () => { onPick(current); close(); });
      load(current);
    },
  });

  async function load(path) {
    const body = $('#browse-body', el);
    try {
      const data = await api.get(`/api/fs?path=${encodeURIComponent(path)}`);
      current = data.path;
      body.innerHTML = `
        <div class="field"><input type="text" id="browse-path" value="${F.esc(data.path)}"></div>
        <div style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)">
          ${data.parent ? `<div class="file-row" data-go="${F.esc(data.parent)}" style="cursor:pointer"><span class="fname">📁 ..</span></div>` : ''}
          ${data.entries.map((e) => `<div class="file-row" data-go="${F.esc(e.path)}" style="cursor:pointer"><span class="fname">📁 ${F.esc(e.name)}</span></div>`).join('')
            || '<div class="palette-empty">No sub-folders</div>'}
        </div>`;
      $('#browse-path', el).addEventListener('change', (event) => load(event.target.value));
      body.querySelectorAll('[data-go]').forEach((row) =>
        row.addEventListener('click', () => load(row.dataset.go)));
    } catch (err) {
      body.innerHTML = `<div class="palette-empty">${F.esc(err.message)}</div>`;
    }
  }
}

function limitsDialog(targets) {
  const first = state.torrents.get(targets[0]) || {};
  modal({
    title: 'Speed limits',
    body: `<p class="muted" style="margin-top:0;font-size:12px">Blank or 0 means unlimited. Accepts units, e.g. <code>2 MB</code> or <code>512k</code>.</p>
      <div class="row">
        <div class="field"><label for="lim-dl">Download limit</label>
          <input type="text" id="lim-dl" value="${first.dl_limit ? F.bytes(first.dl_limit, 0) : ''}" placeholder="Unlimited"></div>
        <div class="field"><label for="lim-up">Upload limit</label>
          <input type="text" id="lim-up" value="${first.up_limit ? F.bytes(first.up_limit, 0) : ''}" placeholder="Unlimited"></div>
      </div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="lim-go">Apply</button>`,
    onMount(el, close) {
      $('#lim-go', el).addEventListener('click', async () => {
        await run('set_limits', targets, {
          download: F.parseSize($('#lim-dl', el).value),
          upload: F.parseSize($('#lim-up', el).value),
        }, 'Speed limits updated for {n} torrent(s)');
        close();
      });
    },
  });
}

function moveDialog(targets) {
  const first = state.torrents.get(targets[0]) || {};
  modal({
    title: 'Move files',
    body: `<div class="field"><label for="mv-path">New location</label>
        <div class="inline"><input type="text" id="mv-path" value="${F.esc(first.save_path || '')}">
        <button type="button" class="btn" id="mv-browse">Browse…</button></div>
        <div class="hint">Files are moved on disk. The torrent keeps seeding from the new location.</div></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="mv-go">Move</button>`,
    onMount(el, close) {
      $('#mv-browse', el).addEventListener('click', () =>
        browseDialog($('#mv-path', el).value, (p) => { $('#mv-path', el).value = p; }));
      $('#mv-go', el).addEventListener('click', async () => {
        const path = $('#mv-path', el).value.trim();
        if (!path) return;
        await run('move', targets, { path }, 'Moving {n} torrent(s)…');
        close();
      });
    },
  });
}

function categoryDialog(targets) {
  const current = state.torrents.get(targets[0])?.category || '';
  modal({
    title: 'Set category',
    body: `<div class="field"><label for="cat-name">Category</label>
      <input type="text" id="cat-name" value="${F.esc(current)}" list="cat-list2" placeholder="Leave blank to clear">
      <datalist id="cat-list2">${state.categories.map((c) => `<option value="${F.esc(c.name)}">`).join('')}</datalist></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="cat-go">Apply</button>`,
    onMount(el, close) {
      $('#cat-go', el).addEventListener('click', async () => {
        await run('set_category', targets, { category: $('#cat-name', el).value.trim() },
          'Category updated for {n} torrent(s)');
        close();
      });
    },
  });
}

function tagsDialog(targets) {
  const current = (state.torrents.get(targets[0])?.tags || []).join(', ');
  modal({
    title: 'Set tags',
    body: `<div class="field"><label for="tag-names">Tags</label>
      <input type="text" id="tag-names" value="${F.esc(current)}" placeholder="comma, separated">
      <div class="hint">Existing tags: ${state.tags.map((t) => F.esc(t.name)).join(', ') || 'none yet'}</div></div>
      <div class="field"><label class="field-label">Mode</label>
      <div class="seg" id="tag-mode">
        <button data-mode="set" class="on">Replace</button>
        <button data-mode="add">Add</button>
        <button data-mode="remove">Remove</button>
      </div></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="tag-go">Apply</button>`,
    onMount(el, close) {
      let mode = 'set';
      el.querySelectorAll('#tag-mode button').forEach((b) =>
        b.addEventListener('click', () => {
          mode = b.dataset.mode;
          el.querySelectorAll('#tag-mode button').forEach((x) => x.classList.toggle('on', x === b));
        }));
      $('#tag-go', el).addEventListener('click', async () => {
        await run('set_tags', targets, { tags: $('#tag-names', el).value, mode },
          'Tags updated for {n} torrent(s)');
        close();
      });
    },
  });
}

function renameDialog(hash) {
  const t = state.torrents.get(hash);
  modal({
    title: 'Rename torrent',
    body: `<div class="field"><label for="rn-name">Name</label>
      <input type="text" id="rn-name" value="${F.esc(t ? t.name : '')}">
      <div class="hint">Renames the folder or file on disk.</div></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rn-go">Rename</button>`,
    onMount(el, close) {
      $('#rn-go', el).addEventListener('click', async () => {
        await run('rename', [hash], { name: $('#rn-name', el).value.trim() }, 'Renamed');
        close();
      });
    },
  });
}

function addTrackersDialog(hash) {
  modal({
    title: 'Add trackers',
    body: `<div class="field"><label for="tk-urls">Tracker URLs</label>
      <textarea id="tk-urls" placeholder="udp://tracker.example.com:6969/announce&#10;One per line"></textarea></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="tk-go">Add</button>`,
    onMount(el, close) {
      $('#tk-go', el).addEventListener('click', async () => {
        try {
          const res = await api.post(`/api/torrents/${hash}/trackers`, { urls: $('#tk-urls', el).value });
          toast(`Added ${res.count} tracker(s)`);
          close();
        } catch (err) { toastError(err); }
      });
    },
  });
}

/* ─────────────────────────────── settings ─────────────────────────────── */

/* Declarative schema — each entry maps one config key to one control, so the
   panes stay in sync with config.py without hand-written markup per field. */
const SETTINGS_PANES = [
  { id: 'downloads', label: 'Downloads', fields: [
    { key: 'download_dir', type: 'path', label: 'Default download folder' },
    { key: 'use_incomplete_dir', type: 'check', label: 'Use a separate folder for incomplete downloads',
      hint: 'Completed files are moved to the download folder when they finish.' },
    { key: 'incomplete_dir', type: 'path', label: 'Incomplete folder' },
    { key: 'watch_dir_enabled', type: 'check', label: 'Watch a folder for .torrent files' },
    { key: 'watch_dir', type: 'path', label: 'Watch folder' },
    { key: 'add_paused', type: 'check', label: 'Add new torrents paused' },
    { key: 'sequential_default', type: 'check', label: 'Download sequentially by default' },
    { key: 'preallocate', type: 'check', label: 'Pre-allocate disk space',
      hint: 'Reduces fragmentation at the cost of a slower start.' },
    { key: 'check_on_completion', type: 'check', label: 'Verify files when a download completes' },
  ] },
  { id: 'bandwidth', label: 'Bandwidth', fields: [
    { key: 'download_rate_limit', type: 'size', label: 'Global download limit' },
    { key: 'upload_rate_limit', type: 'size', label: 'Global upload limit' },
    { divider: 'Alternative limits' },
    { key: 'alt_download_rate_limit', type: 'size', label: 'Alternative download limit' },
    { key: 'alt_upload_rate_limit', type: 'size', label: 'Alternative upload limit' },
    { key: 'alt_speed_scheduler', type: 'check', label: 'Switch automatically on a schedule' },
    { key: 'alt_speed_from', type: 'time', label: 'From' },
    { key: 'alt_speed_to', type: 'time', label: 'To' },
    { key: 'rate_limit_ip_overhead', type: 'check', label: 'Count protocol overhead against limits' },
  ] },
  { id: 'connection', label: 'Connection', fields: [
    { key: 'listen_port', type: 'number', label: 'Incoming port', min: 1, max: 65535 },
    { key: 'listen_port_max', type: 'number', label: 'Port range end', min: 1, max: 65535 },
    { key: 'random_port', type: 'check', label: 'Use a random port each start' },
    { key: 'enable_upnp', type: 'check', label: 'Forward the port with UPnP' },
    { key: 'enable_natpmp', type: 'check', label: 'Forward the port with NAT-PMP' },
    { divider: 'Peer discovery' },
    { key: 'enable_dht', type: 'check', label: 'DHT (distributed hash table)' },
    { key: 'enable_lsd', type: 'check', label: 'Local peer discovery' },
    { key: 'enable_pex', type: 'check', label: 'Peer exchange' },
    { key: 'enable_utp', type: 'check', label: 'µTP transport',
      hint: 'Congestion-aware UDP transport that yields to other traffic on your link.' },
    { key: 'prefer_tcp', type: 'check', label: 'Prefer TCP over µTP' },
    { divider: 'Limits' },
    { key: 'connections_limit', type: 'number', label: 'Global connection limit', min: 10 },
    { key: 'connections_limit_per_torrent', type: 'number', label: 'Connections per torrent', min: 2 },
    { key: 'unchoke_slots_limit', type: 'number', label: 'Global upload slots', min: 1 },
    { key: 'uploads_limit_per_torrent', type: 'number', label: 'Upload slots per torrent', min: 1 },
  ] },
  { id: 'queue', label: 'Queue', fields: [
    { key: 'auto_manage', type: 'check', label: 'Manage the queue automatically' },
    { key: 'active_downloads', type: 'number', label: 'Maximum active downloads', min: 1 },
    { key: 'active_seeds', type: 'number', label: 'Maximum active seeds', min: 1 },
    { key: 'active_limit', type: 'number', label: 'Maximum active torrents', min: 1 },
    { key: 'dont_count_slow_torrents', type: 'check', label: 'Do not count slow torrents against the limits' },
    { divider: 'Seeding limits' },
    { key: 'share_ratio_limit', type: 'float', label: 'Stop seeding at ratio', hint: '0 seeds forever.' },
    { key: 'seed_time_limit', type: 'number', label: 'Stop seeding after (minutes)', min: 0 },
    { key: 'share_limit_action', type: 'select', label: 'When a limit is reached', options: [
      ['pause', 'Pause the torrent'], ['remove', 'Remove the torrent'],
      ['remove_with_data', 'Remove the torrent and its files'],
    ] },
  ] },
  { id: 'privacy', label: 'Privacy', fields: [
    { key: 'encryption_policy', type: 'select', label: 'Protocol encryption', options: [
      [0, 'Disabled — plaintext only'], [1, 'Enabled — prefer encrypted'], [2, 'Forced — encrypted only'],
    ] },
    { key: 'anonymous_mode', type: 'check', label: 'Anonymous mode',
      hint: 'Stops sending your client name and listen port to trackers and peers.' },
    { divider: 'Proxy' },
    { key: 'proxy_type', type: 'select', label: 'Proxy type', options: [
      [0, 'None'], [1, 'SOCKS4'], [2, 'SOCKS5'], [3, 'SOCKS5 with password'],
      [4, 'HTTP'], [5, 'HTTP with password'],
    ] },
    { key: 'proxy_host', type: 'text', label: 'Proxy host' },
    { key: 'proxy_port', type: 'number', label: 'Proxy port', min: 1, max: 65535 },
    { key: 'proxy_username', type: 'text', label: 'Username' },
    { key: 'proxy_password', type: 'password', label: 'Password' },
    { key: 'proxy_peer_connections', type: 'check', label: 'Send peer connections through the proxy' },
    { key: 'proxy_tracker_connections', type: 'check', label: 'Send tracker connections through the proxy' },
    { key: 'proxy_hostnames', type: 'check', label: 'Resolve hostnames through the proxy',
      hint: 'Prevents DNS leaks outside the tunnel.' },
  ] },
  { id: 'trackers', label: 'Trackers', fields: [
    { key: 'default_trackers', type: 'textarea', label: 'Add these trackers to every new torrent',
      hint: 'One URL per line. Useful for public torrents with few trackers.' },
  ] },
  { id: 'interface', label: 'Appearance', fields: [
    { key: 'theme', type: 'theme', label: 'Theme' },
    { key: 'accent', type: 'accent', label: 'Accent colour' },
    { key: 'density', type: 'seg', label: 'Density',
      options: DENSITIES.map((d) => [d.id, d.name]),
      hint: 'Row height and type size throughout the app.' },
    { key: 'motion', type: 'seg', label: 'Motion',
      options: [['system', 'Match system'], ['full', 'Full'], ['reduced', 'Reduced']],
      hint: 'Reduced keeps every transition but collapses its duration.' },
    { divider: 'Display' },
    { key: 'speed_unit', type: 'seg', label: 'Units', options: [['binary', 'KiB / MiB'], ['decimal', 'kB / MB']] },
    { key: 'confirm_delete', type: 'check', label: 'Confirm before removing torrents' },
    { key: 'notifications', type: 'check', label: 'Show notifications' },
  ] },
];


async function settingsDialog(openPane = null) {
  let settings;
  try {
    settings = (await api.get('/api/settings')).settings;
  } catch (err) { toastError(err); return; }
  state.settings = settings;

  const field = (f) => {
    if (f.divider) return `<h3 style="margin:18px 0 9px">${F.esc(f.divider)}</h3>`;
    const value = settings[f.key];
    const id = `set-${f.key}`;
    const hint = f.hint ? `<div class="hint">${F.esc(f.hint)}</div>` : '';
    switch (f.type) {
      case 'check':
        return `<label class="check"><input type="checkbox" id="${id}" data-key="${f.key}" ${value ? 'checked' : ''}>
          <span><span class="ctext">${F.esc(f.label)}</span>${f.hint ? `<span class="chint">${F.esc(f.hint)}</span>` : ''}</span></label>`;
      case 'size':
        return `<div class="field"><label for="${id}">${F.esc(f.label)}</label>
          <input type="text" id="${id}" data-key="${f.key}" data-kind="size"
                 value="${value ? F.bytes(value, 0) : ''}" placeholder="Unlimited">${hint}</div>`;
      case 'time': {
        const hh = String(Math.floor(value / 60)).padStart(2, '0');
        const mm = String(value % 60).padStart(2, '0');
        return `<div class="field"><label for="${id}">${F.esc(f.label)}</label>
          <input type="time" id="${id}" data-key="${f.key}" data-kind="time" value="${hh}:${mm}">${hint}</div>`;
      }
      case 'path':
        return `<div class="field"><label for="${id}">${F.esc(f.label)}</label>
          <div class="inline"><input type="text" id="${id}" data-key="${f.key}" value="${F.esc(value)}">
          <button type="button" class="btn" data-browse="${id}">Browse…</button></div>${hint}</div>`;
      case 'select':
        return `<div class="field"><label for="${id}">${F.esc(f.label)}</label>
          <select id="${id}" data-key="${f.key}" data-kind="${typeof value === 'number' ? 'number' : 'text'}">
          ${f.options.map(([v, l]) => `<option value="${F.esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${F.esc(l)}</option>`).join('')}
          </select>${hint}</div>`;
      case 'seg':
        return `<div class="field"><span class="field-label">${F.esc(f.label)}</span>
          <div class="seg" data-seg="${f.key}">${f.options.map(([v, l]) =>
            `<button type="button" data-v="${F.esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${F.esc(l)}</button>`).join('')}
          </div>${hint}</div>`;
      case 'accent':
        return `<div class="field"><span class="field-label">${F.esc(f.label)}</span>
          <div class="swatches" data-seg="${f.key}" role="radiogroup" aria-label="Accent colour">${ACCENTS.map((a) =>
            `<button type="button" class="swatch ${a.id === value ? 'on' : ''}" data-v="${a.id}"
               style="background:${a.hex}" title="${a.id}" role="radio"
               aria-checked="${a.id === value}" aria-label="${a.id}"></button>`).join('')}
          </div></div>`;
      case 'theme':
        return `<div class="field"><span class="field-label">${F.esc(f.label)}</span>
          <div class="theme-grid" data-seg="${f.key}" role="radiogroup" aria-label="Theme">${THEMES.map((t) =>
            `<button type="button" class="theme-card${t.id === value ? ' on' : ''}" data-v="${t.id}"
                     role="radio" aria-checked="${t.id === value}">
               <span class="theme-chip" style="background:${t.bg}">
                 <i style="background:${t.fg}"></i><i style="background:${t.fg};opacity:.45"></i>
               </span>
               <span class="theme-name">${F.esc(t.name)}</span>
             </button>`).join('')}
          </div>
          <div class="hint">System follows your operating system's light or dark setting.</div></div>`;
      case 'textarea':
        return `<div class="field"><label for="${id}">${F.esc(f.label)}</label>
          <textarea id="${id}" data-key="${f.key}">${F.esc(value)}</textarea>${hint}</div>`;
      default:
        return `<div class="field"><label for="${id}">${F.esc(f.label)}</label>
          <input type="${f.type === 'password' ? 'password' : f.type === 'number' || f.type === 'float' ? 'number' : 'text'}"
                 id="${id}" data-key="${f.key}" data-kind="${f.type}" value="${F.esc(value)}"
                 ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}
                 ${f.type === 'float' ? 'step="0.1"' : ''}>${hint}</div>`;
    }
  };

  modal({
    title: 'Settings',
    wide: true,
    cls: 'settings',
    body: `<div class="set-rail">${SETTINGS_PANES.map((p, i) =>
              `<button class="filter${i === 0 ? ' on' : ''}" data-pane="${p.id}"><span class="label">${p.label}</span></button>`).join('')}</div>
           <div>${SETTINGS_PANES.map((p, i) =>
              `<div class="set-pane" data-pane-body="${p.id}" ${i ? 'hidden' : ''}>${p.fields.map(field).join('')}</div>`).join('')}</div>`,
    footer: `<span class="muted" style="font-size:11.5px;align-self:center">Changes apply immediately on save.</span>
             <div class="spacer"></div>
             <button class="btn" data-close>Cancel</button>
             <button class="btn primary" id="set-save">Save settings</button>`,
    onMount(el, close) {
      el.querySelectorAll('[data-pane]').forEach((tab) =>
        tab.addEventListener('click', () => {
          el.querySelectorAll('[data-pane]').forEach((x) => x.classList.toggle('on', x === tab));
          el.querySelectorAll('[data-pane-body]').forEach((body) => {
            body.hidden = body.dataset.paneBody !== tab.dataset.pane;
          });
        }));

      // Jump straight to a pane when the caller asked for one. Must run
      // after the listeners above exist, or the click does nothing.
      if (openPane) {
        const target = el.querySelector(`[data-pane="${openPane}"]`);
        if (target) target.click();
      }

      el.querySelectorAll('[data-seg]').forEach((group) =>
        group.querySelectorAll('button').forEach((button) =>
          button.addEventListener('click', () => {
            group.querySelectorAll('button').forEach((x) => {
              x.classList.toggle('on', x === button);
              if (x.getAttribute('role') === 'radio') x.setAttribute('aria-checked', String(x === button));
            });
            // Theme and accent preview live, so the choice is judged in context.
            const axis = group.dataset.seg;
            if (axis === 'theme' || axis === 'accent' || axis === 'density' || axis === 'motion') {
              state.prefs[axis] = button.dataset.v;
              applyTheme(true);
            }
          })));

      el.querySelectorAll('[data-browse]').forEach((button) =>
        button.addEventListener('click', () => {
          const input = el.querySelector('#' + button.dataset.browse);
          browseDialog(input.value, (path) => { input.value = path; });
        }));

      $('#set-save', el).addEventListener('click', async () => {
        const patch = {};
        el.querySelectorAll('[data-key]').forEach((input) => {
          const key = input.dataset.key;
          const kind = input.dataset.kind;
          if (input.type === 'checkbox') patch[key] = input.checked;
          else if (kind === 'size') patch[key] = F.parseSize(input.value);
          else if (kind === 'time') {
            const [h, m] = input.value.split(':').map(Number);
            patch[key] = (h || 0) * 60 + (m || 0);
          } else if (kind === 'number') patch[key] = Number(input.value) || 0;
          else if (kind === 'float') patch[key] = parseFloat(input.value) || 0;
          else patch[key] = input.value;
        });
        el.querySelectorAll('[data-seg]').forEach((group) => {
          const on = group.querySelector('button.on');
          if (on) patch[group.dataset.seg] = on.dataset.v;
        });

        try {
          const res = await api.post('/api/settings', patch);
          state.settings = res.settings;
          state.prefs.theme = res.settings.theme;
          state.prefs.accent = res.settings.accent;
          state.prefs.density = res.settings.density;
          state.prefs.motion = res.settings.motion;
          state.prefs.unit = res.settings.speed_unit;
          state.prefs.confirmDelete = res.settings.confirm_delete;
          state.prefs.notifications = res.settings.notifications;
          savePrefs();
          F.setUnitMode(state.prefs.unit);
          setToastsEnabled(state.prefs.notifications);
          applyTheme(true);
          renderAll();
          close();
        } catch (err) { toastError(err); }
      });
    },
    onClose() {
      // Revert an unsaved live preview.
      if (state.settings) {
        state.prefs.theme = state.settings.theme;
        state.prefs.accent = state.settings.accent;
        state.prefs.density = state.settings.density;
        state.prefs.motion = state.settings.motion;
        applyTheme(true);
      }
    },
  });
}

function accentColor(id) {
  return (ACCENTS.find((a) => a.id === id) || ACCENTS[0]).hex;
}

let themingTimer;

/** Resolve "system" to a concrete theme id. */
function resolvedTheme(id) {
  if (id !== 'system') return THEME_BY_ID[id] ? id : SYSTEM_DARK;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? SYSTEM_LIGHT : SYSTEM_DARK;
}

/**
 * Push the three appearance axes onto <html>.
 * @param {boolean} animate cross-fade the surfaces (skip on first paint,
 *   where there is nothing to fade *from* and it would just delay the UI).
 */
function applyTheme(animate = false) {
  const root = document.documentElement;
  const next = resolvedTheme(state.prefs.theme);

  if (animate && root.dataset.theme !== next) {
    root.classList.add('theming');
    clearTimeout(themingTimer);
    // Drop the class once the dissolve is done: leaving a transition on
    // every element would smear ordinary hovers afterwards.
    themingTimer = setTimeout(() => root.classList.remove('theming'), 320);
  }

  root.dataset.theme = next;
  root.dataset.accent = state.prefs.accent;
  root.dataset.density = state.prefs.density;
  root.dataset.motion = state.prefs.motion;
  // Tell the browser which scheme is active so native widgets, scrollbars
  // and form controls match rather than fighting the palette.
  root.style.colorScheme = (THEME_BY_ID[next] || {}).family === 'light' ? 'light' : 'dark';
  savePrefs();
}

/** Quick-switch menu on the topbar's theme button. */
function themeMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const current = state.prefs.theme;
  const tick = '<path d="M5 12l5 5 9-9"/>';
  const items = [{ header: 'Theme' }];
  let family = null;
  for (const t of THEMES) {
    if (family !== null && t.family !== family) items.push({ separator: true });
    family = t.family;
    items.push({
      label: t.name,
      icon: t.id === current ? tick : '',
      run: () => setAppearance({ theme: t.id }),
    });
  }
  items.push({ separator: true }, {
    label: 'Appearance settings…',
    run: () => settingsDialog('interface'),
  });
  contextMenu(rect.left - 150, rect.bottom + 6, items);
}

/** Apply an appearance change locally, then persist it. */
function setAppearance(patch) {
  Object.assign(state.prefs, patch);
  applyTheme(true);
  if (patch.unit) F.setUnitMode(patch.unit);
  renderAll();
  const wire = {};
  if (patch.theme) wire.theme = patch.theme;
  if (patch.accent) wire.accent = patch.accent;
  if (patch.density) wire.density = patch.density;
  if (patch.motion) wire.motion = patch.motion;
  if (Object.keys(wire).length) api.post('/api/settings', wire).catch(() => {});
}

/* ───────────────────────── command palette ───────────────────────── */

function paletteCommands() {
  const sel = selected();
  const has = sel.length > 0;
  return [
    { label: 'Add torrent…', sc: 'N', run: () => addDialog() },
    { label: 'Open settings', sc: ',', run: settingsDialog },
    { label: 'Toggle alternative speed limits', sc: 'T', run: toggleAltSpeed },
    { label: 'Toggle details panel', sc: 'I', run: () => toggleDetail() },
    { label: 'Switch between light and dark', run: () => {
      const family = (THEME_BY_ID[resolvedTheme(state.prefs.theme)] || {}).family;
      setAppearance({ theme: family === 'light' ? SYSTEM_DARK : SYSTEM_LIGHT });
    } },
    { label: 'Change theme…', run: () => themeMenu($('#btn-theme')) },
    { label: 'Change density…', run: () => settingsDialog('interface') },
    { label: 'Select all torrents', sc: '⌘A', run: selectAllVisible },
    { label: 'Resume all torrents', run: () => run('resume', ['*'], null, 'Resumed {n} torrent(s)') },
    { label: 'Pause all torrents', run: () => run('pause', ['*'], null, 'Paused {n} torrent(s)') },
    ...(has ? [
      { label: `Resume ${sel.length} selected`, run: () => run('resume', sel) },
      { label: `Pause ${sel.length} selected`, run: () => run('pause', sel) },
      { label: `Force recheck ${sel.length} selected`, run: () => confirmRecheck(sel) },
      { label: `Set category for ${sel.length} selected…`, run: () => categoryDialog(sel) },
      { label: `Set tags for ${sel.length} selected…`, run: () => tagsDialog(sel) },
      { label: `Speed limits for ${sel.length} selected…`, run: () => limitsDialog(sel) },
      { label: `Move ${sel.length} selected…`, run: () => moveDialog(sel) },
      { label: `Remove ${sel.length} selected…`, sc: 'Del', run: () => removeSelected(sel) },
    ] : []),
    ...STATUS_FILTERS.map((f) => ({
      label: `Filter: ${f.label}`,
      run: () => { state.filter = { status: f.key, category: null, tag: null, query: '' };
                   $('#search').value = ''; renderAll(); },
    })),
  ];
}

function openPalette() {
  const root = $('#palette');
  const input = $('#palette-input');
  const list = $('#palette-list');
  const commands = paletteCommands();
  let filtered = commands;
  let cursor = 0;

  const draw = () => {
    list.innerHTML = filtered.length
      ? filtered.map((c, i) =>
          `<button class="palette-item${i === cursor ? ' on' : ''}" data-i="${i}">
             <span>${F.esc(c.label)}</span>${c.sc ? `<span class="sc">${F.esc(c.sc)}</span>` : ''}</button>`).join('')
      : '<div class="palette-empty">No matching commands</div>';
    const active = list.children[cursor];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  };

  const returnFocus = document.activeElement;
  const close = () => {
    root.hidden = true;
    input.value = '';
    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('mousedown', onDown);
    // Hand the keyboard back, or global shortcuts stay trapped in this input.
    input.blur();
    if (returnFocus && returnFocus.isConnected && returnFocus !== input) {
      try { returnFocus.focus(); } catch { /* element may be gone */ }
    }
  };
  const choose = (index) => {
    const command = filtered[index];
    close();
    if (command) command.run();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); cursor = Math.min(cursor + 1, filtered.length - 1); draw(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); cursor = Math.max(cursor - 1, 0); draw(); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(cursor); }
  };
  const onDown = (event) => { if (event.target === root) close(); };

  input.oninput = () => {
    const needle = input.value.toLowerCase().trim();
    filtered = needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
    cursor = 0;
    draw();
  };
  list.onclick = (event) => {
    const button = event.target.closest('[data-i]');
    if (button) choose(Number(button.dataset.i));
  };

  root.hidden = false;
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', onDown);
  draw();
  input.focus();
}

async function toggleAltSpeed() {
  try {
    const res = await api.post('/api/alt-speed', {});
    toast(res.enabled ? 'Alternative speed limits on' : 'Alternative speed limits off');
  } catch (err) { toastError(err); }
}

/* ─────────────────────────────── wiring ─────────────────────────────── */

function wireChrome() {
  $('#btn-add').addEventListener('click', () => addDialog());
  $('#btn-add-empty').addEventListener('click', () => addDialog());
  $('#btn-settings').addEventListener('click', settingsDialog);
  $('#btn-alt').addEventListener('click', toggleAltSpeed);
  $('#btn-detail-toggle').addEventListener('click', () => toggleDetail());
  $('#btn-detail-close').addEventListener('click', closeDetail);

  $('#btn-theme').addEventListener('click', (event) => themeMenu(event.currentTarget));

  $('#btn-new-category').addEventListener('click', () => {
    if (!selected().length) {
      toast('Select torrents first', 'Categories are assigned to torrents.', 'warn');
      return;
    }
    categoryDialog(selected());
  });

  let searchTimer;
  $('#search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    // Debounce so typing in a 5000-torrent list stays smooth.
    searchTimer = setTimeout(() => {
      state.filter.query = event.target.value;
      queueLayoutAnimation();
      renderTable();
    }, 120);
  });

  const TOOLBAR_ACTIONS = {
    resume: () => run('resume', null),
    pause: () => run('pause', null),
    remove: () => removeSelected(),
    recheck: () => confirmRecheck(selected()),
    reannounce: () => run('reannounce', null, null, 'Reannounced {n} torrent(s)'),
    'queue-top': () => run('queue', null, { direction: 'top' }),
    'queue-up': () => run('queue', null, { direction: 'up' }),
    'queue-down': () => run('queue', null, { direction: 'down' }),
    'queue-bottom': () => run('queue', null, { direction: 'bottom' }),
  };
  $('#toolbar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (button && TOOLBAR_ACTIONS[button.dataset.act]) TOOLBAR_ACTIONS[button.dataset.act]();
  });

  const tbody = $('#rows');
  tbody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-hash]');
    if (!row) return;
    selectHash(row.dataset.hash, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  });
  tbody.addEventListener('dblclick', (event) => {
    const row = event.target.closest('tr[data-hash]');
    if (row) openDetail(row.dataset.hash);
  });
  tbody.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('tr[data-hash]');
    if (!row) return;
    event.preventDefault();
    rowContextMenu(event, row.dataset.hash);
  });

  $('#detail-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    state.detailTab = tab.dataset.tab;
    $$('#detail-tabs .tab').forEach((x) => {
      x.classList.toggle('active', x === tab);
      x.setAttribute('aria-selected', String(x === tab));
    });
    renderDetail();
  });

  // Clicking empty space below the rows clears the selection.
  $('#table-wrap').addEventListener('mousedown', (event) => {
    if (event.target.closest('tr') || event.button !== 0) return;
    state.selection.clear();
    renderTable();
    renderToolbar();
  });

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (state.prefs.theme === 'system') applyTheme(true);
  });

  // A shadow under the sticky header, but only once there is content above.
  const wrap = $('#table-wrap');
  wrap.addEventListener('scroll', () => {
    wrap.classList.toggle('scrolled', wrap.scrollTop > 2);
  }, { passive: true });

  wireDetailResize();

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { drawSparkline(); renderDetail(); }, 120);
  });

  if (state.prefs.notifications && 'Notification' in window && Notification.permission === 'default') {
    // Ask only once the user has actually engaged with the app.
    document.addEventListener('click', function askOnce() {
      document.removeEventListener('click', askOnce);
      Notification.requestPermission().catch(() => {});
    }, { once: true });
  }
}

/**
 * Drag the detail panel's leading edge to resize it.
 *
 * Width is written to a CSS variable the grid template reads, so the resize
 * is a single custom-property update per frame rather than a relayout of
 * anything JavaScript owns.
 */
function wireDetailResize() {
  const handle = $('#detail-resize');
  const body = $('.body');
  if (!handle) return;

  const MIN = 320;
  const max = () => Math.max(MIN, Math.min(window.innerWidth - 480, 900));
  const apply = (px) => {
    const w = Math.round(Math.max(MIN, Math.min(px, max())));
    body.style.setProperty('--detail-w', `${w}px`);
    state.prefs.detailWidth = w;
    return w;
  };

  if (state.prefs.detailWidth) apply(state.prefs.detailWidth);

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const startX = event.clientX;
    const startW = $('#detail').getBoundingClientRect().width;

    const move = (e) => apply(startW + (startX - e.clientX));
    const up = () => {
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      savePrefs();
      renderDetail();          // charts are sized to the panel, so redraw
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  // Resizing must be reachable without a pointer.
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 16;
    const current = $('#detail').getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') { event.preventDefault(); apply(current + step); savePrefs(); renderDetail(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); apply(current - step); savePrefs(); renderDetail(); }
  });

  handle.addEventListener('dblclick', () => {
    body.style.removeProperty('--detail-w');
    state.prefs.detailWidth = 0;
    savePrefs();
    renderDetail();
  });
}

/* ─────────────────────────────── keyboard ─────────────────────────────── */

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
                              || target.tagName === 'SELECT' || target.isContentEditable);

    // Global chords work even while typing.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !typing) {
      event.preventDefault();
      selectAllVisible();
      return;
    }
    if (event.key === 'Escape' && typing && target.id === 'search') {
      target.value = '';
      state.filter.query = '';
      target.blur();
      renderTable();
      return;
    }
    if (typing || modalOpen() || !$('#palette').hidden) return;

    const list = visibleTorrents();
    const index = state.anchor ? list.findIndex((t) => t.hash === state.anchor) : -1;

    switch (event.key) {
      case '/':
        event.preventDefault();
        $('#search').focus();
        $('#search').select();
        break;
      case 'n': case 'N':
        event.preventDefault();
        addDialog();
        break;
      case ',':
        event.preventDefault();
        settingsDialog();
        break;
      case 't': case 'T':
        event.preventDefault();
        toggleAltSpeed();
        break;
      case 'i': case 'I':
        event.preventDefault();
        toggleDetail();
        break;
      case ' ':
        event.preventDefault();
        togglePlay();
        break;
      case 'Delete': case 'Backspace':
        event.preventDefault();
        removeSelected();
        break;
      case 'ArrowDown': case 'j': {
        event.preventDefault();
        const next = list[Math.min(index + 1, list.length - 1)] || list[0];
        if (next) selectHash(next.hash, { range: event.shiftKey });
        break;
      }
      case 'ArrowUp': case 'k': {
        event.preventDefault();
        const prev = list[Math.max(index - 1, 0)] || list[0];
        if (prev) selectHash(prev.hash, { range: event.shiftKey });
        break;
      }
      case 'Enter':
        if (state.anchor) { event.preventDefault(); openDetail(state.anchor); }
        break;
      case '?':
        event.preventDefault();
        shortcutsDialog();
        break;
      default:
        break;
    }
  });
}

function shortcutsDialog() {
  const groups = [
    ['General', [['⌘/Ctrl K', 'Command palette'], ['N', 'Add torrent'], [',', 'Settings'],
                 ['/', 'Focus search'], ['?', 'This help'], ['I', 'Toggle details']]],
    ['Selection', [['↑ ↓ / J K', 'Move through the list'], ['Shift + ↑ ↓', 'Extend selection'],
                   ['⌘/Ctrl A', 'Select all'], ['Click + Shift', 'Select a range'],
                   ['Click + ⌘/Ctrl', 'Toggle one']]],
    ['Torrents', [['Space', 'Pause or resume'], ['Delete', 'Remove'], ['Enter', 'Open details'],
                  ['T', 'Alternative speed limits']]],
  ];
  modal({
    title: 'Keyboard shortcuts',
    body: groups.map(([title, rows]) => `
      <div class="section"><h3>${title}</h3><dl class="kv">
        ${rows.map(([keys, what]) => `<dt><kbd>${F.esc(keys)}</kbd></dt><dd>${F.esc(what)}</dd>`).join('')}
      </dl></div>`).join(''),
    footer: '<button class="btn primary" data-close>Got it</button>',
  });
}

/* ─────────────────────────── drag and drop ─────────────────────────── */

function wireDragDrop() {
  const veil = $('#drop-veil');
  let depth = 0;

  const isFileDrag = (event) =>
    Array.from(event.dataTransfer?.types || []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth++;
    veil.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    // dragleave fires for every child element, so count enter/leave pairs.
    if (--depth <= 0) { depth = 0; veil.hidden = true; }
  });
  window.addEventListener('drop', async (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    veil.hidden = true;

    const files = Array.from(event.dataTransfer.files)
      .filter((f) => f.name.toLowerCase().endsWith('.torrent'));
    if (!files.length) {
      toast('Not a torrent', 'Only .torrent files can be dropped here.', 'warn');
      return;
    }
    try {
      const res = await api.upload(files, {});
      toast(`Added ${res.count} torrent${res.count === 1 ? '' : 's'}`);
    } catch (err) { toastError(err); }
  });

  // Pasting a magnet link anywhere opens the add dialog pre-filled.
  window.addEventListener('paste', (event) => {
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const text = (event.clipboardData || window.clipboardData).getData('text') || '';
    if (text.trim().startsWith('magnet:')) {
      event.preventDefault();
      addDialog(text.trim());
    }
  });
}

/* ─────────────────────────────── start ─────────────────────────────── */

boot().catch((err) => {
  document.body.innerHTML =
    `<div style="padding:40px;font:14px system-ui;color:#e8eaf0">
       <h1 style="font-size:18px">Fission could not start</h1>
       <p style="color:#8b91a3">${F.esc(err.message)}</p>
     </div>`;
});
