/* Reusable chrome: toasts, modals, context menus.
   Kept free of app state so it can be reasoned about on its own. */

import { esc } from './format.js';

const toastRoot = () => document.getElementById('toasts');
const modalRoot = () => document.getElementById('modal-root');
const menuRoot  = () => document.getElementById('context-menu');

/* ────────────────────────────── toasts ────────────────────────────── */

let toastsEnabled = true;
export function setToastsEnabled(on) { toastsEnabled = !!on; }

export function toast(title, message = '', kind = 'info', ttl = 4200) {
  if (!toastsEnabled && kind !== 'error') return;
  const root = toastRoot();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  // The drain bar's duration has to match the real lifetime, so it is passed
  // in rather than duplicated as a magic number in the stylesheet.
  el.style.setProperty('--toast-life', `${ttl}ms`);
  el.innerHTML =
    `<div class="tbody"><div class="ttitle">${esc(title)}</div>` +
    (message ? `<div class="tmsg">${esc(message)}</div>` : '') + '</div>';

  // A toast is a visual-only event; mirror it into the live region so screen
  // readers are told a download finished or an action failed.
  announce(`${title}${message ? '. ' + message : ''}`);

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  el.addEventListener('click', dismiss);
  root.appendChild(el);
  // Never let a burst of events bury the screen.
  while (root.children.length > 5) root.firstElementChild.remove();
  setTimeout(dismiss, ttl);
}

/** Send a message to the polite live region for assistive technology. */
export function announce(text) {
  const live = document.getElementById('live-region');
  if (!live) return;
  // Re-setting identical text does not re-announce; clear first.
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 40);
}

export const toastError = (err) =>
  toast('Something went wrong', err && err.message ? err.message : String(err), 'error', 6500);

/* ────────────────────────────── modals ────────────────────────────── */

let closeModal = null;

/**
 * Open a modal.
 * @returns {{close:Function, el:HTMLElement}}
 */
export function modal({ title, body, footer, wide = false, cls = '', onMount, onClose }) {
  closeActiveModal();
  const root = modalRoot();
  root.hidden = false;
  root.innerHTML =
    `<div class="modal${wide ? ' wide' : ''}${cls ? ' ' + cls : ''}" role="dialog" aria-modal="true">
       <div class="modal-head">
         <h2>${esc(title)}</h2>
         <button class="btn icon ghost" data-close aria-label="Close">
           <svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6L6 18"/></svg>
         </button>
       </div>
       <div class="modal-body">${body}</div>
       ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
     </div>`;

  const el = root.firstElementChild;
  // Remember where focus came from: without this the keyboard is left inside a
  // detached input, and global shortcuts silently stop working.
  const returnFocus = document.activeElement;
  const close = () => {
    if (closeModal !== close) return;
    closeModal = null;
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    if (returnFocus && returnFocus.isConnected && returnFocus !== document.body) {
      try { returnFocus.focus(); } catch { /* element may be gone */ }
    } else if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  };

  closeModal = close;
  document.addEventListener('keydown', onKey, true);
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  root.addEventListener('mousedown', (event) => { if (event.target === root) close(); });

  if (onMount) onMount(el, close);
  // Focus the first meaningful control so the keyboard works immediately.
  const focusable = el.querySelector('input:not([type=hidden]), textarea, select, button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { el, close };
}

export function closeActiveModal() { if (closeModal) closeModal(); }
export const modalOpen = () => closeModal !== null;

/** A promise-returning confirmation dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, extra = '' }) {
  return new Promise((resolve) => {
    let decided = false;
    const { el, close } = modal({
      title,
      body: `<p style="margin:0 0 4px;font-size:13px;line-height:1.6">${message}</p>${extra}`,
      footer: `<button class="btn" data-close>Cancel</button>
               <button class="btn ${danger ? 'danger primary' : 'primary'}" data-confirm>${esc(confirmLabel)}</button>`,
      onMount(node) {
        node.querySelector('[data-confirm]').addEventListener('click', () => {
          decided = true;
          const checked = {};
          node.querySelectorAll('.modal-body input[type=checkbox]').forEach((c) => {
            checked[c.dataset.key || c.id] = c.checked;
          });
          close();
          resolve({ ok: true, ...checked });
        });
      },
      onClose() { if (!decided) resolve({ ok: false }); },
    });
    setTimeout(() => {
      const btn = el.querySelector('[data-confirm]');
      if (btn) btn.focus();
    }, 30);
  });
}

/* ──────────────────────────── context menu ──────────────────────────── */

/**
 * @param {number} x @param {number} y
 * @param {Array<{label?:string, icon?:string, shortcut?:string, danger?:boolean,
 *                separator?:boolean, header?:string, disabled?:boolean, run?:Function}>} items
 */
export function contextMenu(x, y, items) {
  const root = menuRoot();
  root.hidden = false;
  root.innerHTML = items.map((item, index) => {
    if (item.separator) return '<hr>';
    if (item.header) return `<div class="menu-label">${esc(item.header)}</div>`;
    return `<button data-i="${index}"${item.disabled ? ' disabled' : ''}` +
      `${item.danger ? ' class="danger"' : ''}>` +
      (item.icon ? `<svg viewBox="0 0 24 24" class="ico">${item.icon}</svg>` : '<span class="ico"></span>') +
      `<span>${esc(item.label)}</span>` +
      (item.shortcut ? `<span class="sc">${esc(item.shortcut)}</span>` : '') +
      '</button>';
  }).join('');

  // Flip the menu back on screen when opened near an edge.
  root.style.left = '0px';
  root.style.top = '0px';
  const rect = root.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  root.style.left = `${Math.max(8, left)}px`;
  root.style.top = `${Math.max(8, top)}px`;

  const dismiss = () => {
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('resize', dismiss);
  };
  const onDown = (event) => { if (!root.contains(event.target)) dismiss(); };
  const onKey = (event) => { if (event.key === 'Escape') dismiss(); };

  root.querySelectorAll('button[data-i]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items[Number(button.dataset.i)];
      dismiss();
      if (item && item.run) item.run();
    });
  });

  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
  }, 0);
  return dismiss;
}

export const menuOpen = () => !menuRoot().hidden;

/* ───────────────────────────── misc helpers ───────────────────────────── */

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Clipboard API is unavailable over plain http on a LAN address, which is
  // exactly how most people will reach this UI — so keep the legacy path.
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); resolve(); }
    catch (err) { reject(err); }
    finally { ta.remove(); }
  });
}
