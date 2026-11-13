// Neegy-Talk :: websocket transport
// One socket, automatic reconnect with backoff, heartbeat, and a status the UI
// can render. Frames are plain objects (see protocol.js).

import { CONFIG } from './config.js';
import { encode, decode } from './protocol.js';

export const STATUS = Object.freeze({
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed'
});

export function wsUrl() {
  if (CONFIG.wsUrl) return CONFIG.wsUrl;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class Socket {
  constructor({ url = wsUrl(), onFrame, onStatus, onLatency } = {}) {
    this.url = url;
    this.onFrame = onFrame || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLatency = onLatency || (() => {});
    this.status = STATUS.CLOSED;
    this.sock = null;
    this.attempt = 0;
    this.retryTimer = 0;
    this.pingTimer = 0;
    this.lastFrame = 0;
    this.stopped = true;
    this.pingSent = 0;
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  connect() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    if (this.sock && (this.sock.readyState === 0 || this.sock.readyState === 1)) return;
    this.setStatus(this.attempt ? STATUS.RECONNECTING : STATUS.CONNECTING);

    let sock;
    try {
      sock = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.sock = sock;

    sock.addEventListener('open', () => {
      this.attempt = 0;
      this.lastFrame = Date.now();
      this.setStatus(STATUS.OPEN);
      this.startHeartbeat();
    });

    sock.addEventListener('message', (ev) => {
      this.lastFrame = Date.now();
      const frame = decode(ev.data);
      if (!frame) return;
      if (frame.t === 'pong') {
        this.onLatency(Date.now() - this.pingSent);
        return;
      }
      this.onFrame(frame);
    });

    sock.addEventListener('close', () => {
      this.stopHeartbeat();
      this.sock = null;
      if (this.stopped) {
        this.setStatus(STATUS.CLOSED);
        return;
      }
      this.scheduleRetry();
    });

    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    });
  }

  scheduleRetry() {
    this.attempt += 1;
    this.setStatus(STATUS.RECONNECTING);
    const base = Math.min(15_000, 500 * 1.7 ** this.attempt);
    const jitter = base * 0.25 * Math.random();
    const wait = Math.round(base + jitter);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.sock || this.sock.readyState !== 1) return;
      if (Date.now() - this.lastFrame > 65_000) {
        try {
          this.sock.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.pingSent = Date.now();
      this.send({ t: 'ping', ts: this.pingSent });
    }, 25_000);
  }

  stopHeartbeat() {
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }

  send(obj) {
    if (!this.sock || this.sock.readyState !== 1) return false;
    try {
      this.sock.send(encode(obj));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    if (this.sock) {
      try {
        this.sock.close(1000, 'bye');
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
    this.setStatus(STATUS.CLOSED);
  }
}
