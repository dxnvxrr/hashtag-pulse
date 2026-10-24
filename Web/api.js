import { store } from './store.js';

// ============================================================ API client (mirrors NetworkManager.cs)

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const randomNonce = () => b64(crypto.getRandomValues(new Uint8Array(18))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

/**
 * Where the API lives. Empty = the page's own server (the backend serves /play). The app build sets
 * <meta name="omt-api" content="https://api.example.com"> because its page is loaded from the app bundle.
 * Requests are signed over the path only, so the base never affects signatures.
 */
const API_BASE = (document.querySelector('meta[name="omt-api"]')?.content ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  constructor() {
    this.offsetMs = 0;
    this.session = null;
    this.hmacKey = null;
    this.fingerprint = null;
  }

  localNow() {
    return performance.timeOrigin + performance.now();
  }
  serverNow() {
    return this.localNow() + this.offsetMs;
  }
  /** Server epoch ms → performance.now() timeline (the timeline pointer events are stamped on). */
  serverToPerf(serverMs) {
    return performance.now() + (serverMs - this.serverNow());
  }

  async detect() {
    if (!window.isSecureContext || !crypto.subtle) return false;
    try {
      const ctl = new AbortController();
      // Same-origin answers fast; a remote API on a cold mobile connection (the app) needs longer.
      const timer = setTimeout(() => ctl.abort(), API_BASE ? 5000 : 1500);
      const r = await fetch(`${API_BASE}/v1/time`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      // Rate-limited means the server is there (the clock sync that follows retries).
      if (r.status === 429) return true;
      if (!r.ok) return false;
      const j = await r.json();
      return typeof j.serverTimeMs === 'number';
    } catch {
      return false;
    }
  }

  async syncClock(samples = 3) {
    let bestRtt = Infinity;
    for (let i = 0; i < samples; i++) {
      const t0 = this.localNow();
      const { serverTimeMs } = await this.request('GET', '/v1/time', undefined, { auth: 'none' });
      const t1 = this.localNow();
      if (t1 - t0 < bestRtt) {
        bestRtt = t1 - t0;
        this.offsetMs = serverTimeMs - (t0 + (t1 - t0) / 2);
      }
    }
  }

  async login() {
    if (!this.fingerprint) {
      let deviceId = store.get('deviceId', null);
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        store.set('deviceId', deviceId);
      }
      this.fingerprint = await sha256Hex(`web|${deviceId}`);
    }
    const refreshToken = store.get('refreshToken', null);
    if (refreshToken) {
      try {
        await this.applySession(await this.request('POST', '/v1/auth/refresh', { refreshToken, deviceFingerprint: this.fingerprint }, { auth: 'none' }));
        return;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status >= 500 || e.status === 0) throw e;
        store.set('refreshToken', null);
      }
    }
    const isMinor = store.get('ageGateAnswered', false) ? store.get('isMinor', true) : true;
    const res = await this.request('POST', '/v1/auth/guest', { deviceFingerprint: this.fingerprint, platform: 'WEB', model: navigator.userAgent.slice(0, 120), isMinor }, { auth: 'none' });
    await this.applySession(res);
  }

  async applySession(s) {
    this.session = s;
    this.hmacKey = await crypto.subtle.importKey('raw', b64urlToBytes(s.sessionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    store.set('refreshToken', s.refreshToken);
  }

  async request(method, path, body, { auth = 'signed', retries = 2, recovered = false } = {}) {
    const raw = body === undefined ? (method === 'GET' ? '' : '{}') : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const headers = { accept: 'application/json' };
      if (raw) headers['content-type'] = 'application/json';
      if (auth !== 'none') {
        if (!this.session) throw new ApiError(401, 'no_session');
        headers.authorization = 'Bearer ' + this.session.accessToken;
        headers['x-device-fingerprint'] = this.fingerprint;
      }
      if (auth === 'signed') {
        const ts = String(Math.round(this.serverNow()));
        const nonce = randomNonce();
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${await sha256Hex(raw)}`;
        headers['x-timestamp'] = ts;
        headers['x-nonce'] = nonce;
        headers['x-signature'] = b64(await crypto.subtle.sign('HMAC', this.hmacKey, enc.encode(canonical)));
      }

      let status = 0;
      let json = null;
      try {
        const r = await fetch(API_BASE + path, { method, headers, body: method === 'GET' ? undefined : raw, cache: 'no-store' });
        status = r.status;
        json = await r.json().catch(() => null);
        if (r.ok) return json;
      } catch {
        status = 0;
      }

      const err = new ApiError(status, json?.error ?? (status ? `http_${status}` : 'network_error'), json?.message);
      if (status === 401 && auth !== 'none' && !recovered && ['invalid_access_token', 'session_expired', 'no_session'].includes(err.code)) {
        await this.login();
        return this.request(method, path, body, { auth, retries, recovered: true });
      }
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= retries) throw err;
      await sleep(Math.min(4000, 250 * 2 ** attempt) / 2 + Math.random() * 250 * 2 ** attempt);
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
