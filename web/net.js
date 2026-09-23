/* Transport: a self-healing WebSocket for live state, fetch for actions. */

export class Api {
  async request(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok || (data && data.ok === false)) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  get(path) { return this.request(path); }
  post(path, body) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body || {}) });
  }
  upload(files, options) {
    const form = new FormData();
    form.append('options', JSON.stringify(options || {}));
    for (const file of files) form.append('files', file, file.name);
    return this.request('/api/upload', { method: 'POST', body: form });
  }

  action(action, hashes, extra) {
    return this.post('/api/action', { action, hashes, ...(extra || {}) });
  }
}

export class Live {
  /**
   * @param {(msg:object)=>void} onMessage
   * @param {(state:'connecting'|'open'|'closed')=>void} onStatus
   */
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.attempt = 0;
    this.watching = '';
    this.closed = false;
  }

  connect() {
    if (this.closed) return;
    this.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus('open');
      // Re-assert which torrent we care about; the server keeps this per
      // connection, so a reconnect must restate it.
      if (this.watching) this.send({ type: 'watch', hash: this.watching });
    };
    ws.onmessage = (event) => {
      try { this.onMessage(JSON.parse(event.data)); } catch { /* ignore junk */ }
    };
    ws.onclose = () => {
      this.ws = null;
      this.onStatus('closed');
      if (this.closed) return;
      // Exponential backoff, capped so a long outage still recovers promptly.
      const delay = Math.min(1000 * 2 ** this.attempt++, 15000);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  watch(hash) {
    this.watching = hash || '';
    this.send({ type: 'watch', hash: this.watching });
  }

  close() { this.closed = true; if (this.ws) this.ws.close(); }
}
