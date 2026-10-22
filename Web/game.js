import {
  RingSchedule,
  closeWindowMs,
  classify,
  ticksFor,
  nextRating,
  baseDurationForRating,
  offlineGauntletSeed,
  SLOWMO_FACTOR,
  HUMAN_REACTION_FLOOR_MS,
} from './core.js';

// ============================================================ Storage (per-browser conveniences only)

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('omt.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('omt.' + key, JSON.stringify(value));
    } catch {
      /* storage blocked: the game still works, it just forgets */
    }
  },
};

// ============================================================ API client (mirrors NetworkManager.cs)

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const randomNonce = () => b64(crypto.getRandomValues(new Uint8Array(18))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

class Api {
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
      const timer = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch('/v1/time', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
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
        const r = await fetch(path, { method, headers, body: method === 'GET' ? undefined : raw, cache: 'no-store' });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ Audio + haptics (procedural, nothing to load)

const fx = {
  ctx: null,
  sound: store.get('sound', true),
  haptics: store.get('haptics', true),
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,

  unlock() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ctx = null;
    }
  },
  tone(freq, dur, { type = 'sine', gain = 0.18, endFreq = null, delay = 0 } = {}) {
    if (!this.sound || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },
  vibrate(pattern) {
    if (this.haptics && navigator.vibrate) navigator.vibrate(pattern);
  },
  verdict(v) {
    switch (v) {
      case 'PERFECT':
        this.tone(880, 0.5, { gain: 0.22 });
        this.tone(1760, 0.3, { gain: 0.06 });
        this.vibrate(18);
        break;
      case 'CLEAN':
        this.tone(660, 0.12, { type: 'triangle', gain: 0.14 });
        this.vibrate(8);
        break;
      case 'CLOSE':
        this.tone(140, 0.22, { gain: 0.3 });
        this.vibrate(12);
        break;
      default:
        this.tone(320, 0.32, { type: 'sawtooth', gain: 0.07, endFreq: 110 });
        this.vibrate([30, 30, 40]);
    }
  },
  spawn() {
    this.tone(2200, 0.03, { type: 'square', gain: 0.015 });
  },
  milestone() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, { gain: 0.12, delay: i * 0.07 }));
    this.vibrate([30, 60, 30, 60, 45]);
  },
};

// ============================================================ Rendering

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;
let DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
}
window.addEventListener('resize', resize);

const COLORS = {
  ring: '#d8e6ff',
  target: 'rgba(216,230,255,0.28)',
  gold: '#ffc857',
  clean: '#8fd3ff',
  close: '#c9a2ff',
  miss: '#ff5d73',
  slowmo: '#b18cff',
};

// Preallocated particle + shockwave pools: no allocation inside the frame loop.
const particles = Array.from({ length: 96 }, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, color: '' }));
const waves = Array.from({ length: 8 }, () => ({ alive: false, x: 0, y: 0, r: 0, life: 0, color: '' }));
let punchUntil = 0;

function burst(x, y, color, count, speed) {
  if (fx.reducedMotion) return;
  let spawned = 0;
  for (const p of particles) {
    if (p.alive) continue;
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.8);
    p.alive = true;
    p.x = x;
    p.y = y;
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s;
    p.life = 0;
    p.max = 0.5 + Math.random() * 0.5;
    p.color = color;
    if (++spawned >= count) break;
  }
}

function shockwave(x, y, r, color) {
  const w = waves.find((q) => !q.alive);
  if (!w) return;
  w.alive = true;
  w.x = x;
  w.y = y;
  w.r = r;
  w.life = 0;
  w.color = color;
}

const geometry = () => {
  const m = Math.min(W, H);
  return { cx: W / 2, cy: H / 2 - m * 0.04, target: m * 0.12, start: m * 0.44 };
};

function drawCircle(x, y, r, color, width, alpha = 1, glow = 0) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

let lastFrame = performance.now();

function render(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const g = geometry();

  if (now < punchUntil && !fx.reducedMotion) {
    ctx.translate(g.cx, g.cy);
    ctx.scale(0.975, 0.975);
    ctx.translate(-g.cx, -g.cy);
  }

  const run = game.run;
  let x = g.cx;
  if (run) {
    const ring = run.cur;
    if (ring && ring.archetype === 1 && !fx.reducedMotion) {
      const p = Math.min(1.2, Math.max(0, (now - ring.spawnPerf) / (ring.closePerf - ring.spawnPerf)));
      x = g.cx + ring.drift * Math.min(W * 0.22, 160) * (p - 0.5) * 2;
    }

    // Streak progress arc around the target circle (GDD: streak shown as a thin ring around the tap target).
    const nextMilestone = [10, 25, 50, 100].find((m) => m > run.streak) ?? run.streak + 50;
    const prevMilestone = [0, 10, 25, 50, 100].filter((m) => m <= run.streak).pop() ?? 0;
    const frac = (run.streak - prevMilestone) / (nextMilestone - prevMilestone);
    ctx.strokeStyle = COLORS.gold;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, g.cy, g.target + 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
    ctx.globalAlpha = 1;

    drawCircle(x, g.cy, g.target, COLORS.target, 2);

    if (ring && !ring.resolved && now >= ring.spawnPerf) {
      const p = (now - ring.spawnPerf) / (ring.closePerf - ring.spawnPerf);
      const r = g.start - (g.start - g.target) * p;
      const fadeIn = Math.min(1, (now - ring.spawnPerf) / 140);
      const color = ring.slow ? COLORS.slowmo : COLORS.ring;
      if (r > 0) drawCircle(x, g.cy, r, color, 3, fadeIn, 18);
    } else if (ring && !ring.resolved && now >= ring.spawnPerf - 160) {
      // Inhale: the target pulses just before the next ring draws on.
      drawCircle(x, g.cy, g.target * (1 + (ring.spawnPerf - now) / 900), COLORS.target, 1, 0.5);
    }
  } else {
    // Attract mode: a slow idle ring behind the title screen.
    const p = ((now / 2600) % 1);
    drawCircle(g.cx, g.cy, g.target, COLORS.target, 2);
    drawCircle(g.cx, g.cy, g.start - (g.start - g.target) * p, COLORS.ring, 2, 0.14 * (1 - p * 0.5), 10);
  }

  for (const w of waves) {
    if (!w.alive) continue;
    w.life += dt;
    const t = w.life / 0.5;
    if (t >= 1) {
      w.alive = false;
      continue;
    }
    drawCircle(w.x, w.y, w.r + t * Math.min(W, H) * 0.3, w.color, 3 * (1 - t), 1 - t, 20);
  }
  for (const p of particles) {
    if (!p.alive) continue;
    p.life += dt;
    if (p.life >= p.max) {
      p.alive = false;
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 240 * dt;
    ctx.globalAlpha = 1 - p.life / p.max;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  if (run) tick(now);
  requestAnimationFrame(render);
}

// ============================================================ Game state

const api = new Api();

const game = {
  online: false,
  mode: store.get('mode', 'PULSE'),
  run: null,
  profile: {
    rating: store.get('rating', 1000),
    bestUs: store.get('bestUs', null),
    ticks: store.get('ticks', 0),
    slowMoTickets: store.get('slowMoTickets', 3),
  },
};

function fmtDelta(us, signed = true) {
  const s = (Math.abs(us) / 1e6).toFixed(3);
  if (!signed || Math.abs(us) < 500) return `${s}s`;
  return `${us > 0 ? '+' : '−'}${s}s`;
}

function setScreen(id) {
  for (const s of ['title-screen', 'results-screen', 'continue-screen']) $(s).hidden = s !== id;
  const playing = id === null;
  $('hud').hidden = !playing;
  $('slowmo').hidden = !playing || game.run?.mode === 'GAUNTLET';
}

function renderProfile() {
  const p = game.profile;
  $('profile-best').textContent = p.bestUs === null ? '—' : fmtDelta(p.bestUs, false);
  $('profile-rating').textContent = String(p.rating);
  $('profile-ticks').textContent = String(p.ticks);
}

function renderHud() {
  const run = game.run;
  if (!run) return;
  $('hud-ring').textContent = String(run.verdicts.length + (run.cur && !run.cur.resolved ? 1 : 0));
  $('hud-ticks').textContent = String(run.ticks);
  const lives = $('hud-lives');
  if (!Number.isFinite(run.maxMisses)) {
    $('hud-lives-label').textContent = 'ZEN';
    lives.textContent = '∞';
  } else {
    $('hud-lives-label').textContent = 'LIVES';
    const total = run.maxMisses + run.extraLives;
    lives.textContent = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('i');
      if (i < run.misses) dot.className = 'lost';
      lives.appendChild(dot);
    }
    lives.setAttribute('aria-label', `${total - run.misses} lives left`);
  }
  const available = run.tickets - run.slowMoRings.length - (run.armed ? 1 : 0);
  $('slowmo-count').textContent = String(Math.max(0, available));
  $('slowmo').classList.toggle('armed', run.armed);
  $('slowmo').disabled = !run.armed && available <= 0;
}

let verdictTimer = 0;
function showVerdict(v, deltaUs, tapped) {
  const el = $('verdict');
  el.dataset.v = v;
  $('verdict-word').textContent = v === 'CLOSE' ? 'SO CLOSE' : v;
  $('verdict-delta').textContent = tapped ? fmtDelta(deltaUs) : 'NO TAP';
  el.classList.add('show');
  clearTimeout(verdictTimer);
  verdictTimer = setTimeout(() => el.classList.remove('show'), 700);
}

// ============================================================ Run lifecycle

async function startRun() {
  fx.unlock();
  const mode = game.mode;
  let params;
  if (game.online) {
    try {
      const res = await api.request('POST', '/v1/runs/start', { mode });
      params = {
        runId: res.runId,
        seed: res.seed,
        base: res.baseDurationMs,
        ftue: res.ftue,
        maxRings: res.maxRings,
        maxMisses: mode === 'ZEN' ? Infinity : res.maxMisses,
        ring0Perf: Math.max(performance.now() + 300, api.serverToPerf(res.ring0ServerTimeMs)),
      };
    } catch (e) {
      $('connection').textContent = `Couldn't reach the server (${e.code}). Playing offline.`;
      game.online = false;
    }
  }
  if (!params) {
    const day = new Date().toISOString().slice(0, 10);
    const ftue = mode === 'PULSE' && game.profile.bestUs === null;
    params = {
      runId: null,
      seed: mode === 'GAUNTLET' ? offlineGauntletSeed(day) : crypto.getRandomValues(new Uint32Array(1))[0],
      base: ftue ? 2500 : mode === 'PULSE' || mode === 'ZEN' ? baseDurationForRating(game.profile.rating) : 1900,
      ftue,
      maxRings: mode === 'GAUNTLET' ? 25 : 500,
      maxMisses: mode === 'ZEN' ? Infinity : 3,
      ring0Perf: performance.now() + 900,
    };
  }

  game.run = {
    ...params,
    mode,
    online: game.online && params.runId !== null,
    schedule: new RingSchedule(params.seed, params.base),
    cur: null,
    tapsUs: [],
    deltasUs: [],
    verdicts: [],
    slowMoRings: [],
    resumes: [],
    armed: false,
    tickets: game.profile.slowMoTickets,
    misses: 0,
    streak: 0,
    bestStreak: 0,
    ticks: 0,
    extraLives: 0,
    adOffered: false,
    ended: false,
    startedAt: performance.now(),
  };
  $('hint').hidden = !params.ftue && store.get('seenHint', false);
  scheduleRing(0);
  setScreen(null);
  renderHud();
}

/** Creates the next ring. `resolveUs` is when the previous ring resolved, in µs after ring 0's spawn. */
function scheduleRing(resolveUs, resumeAtUs = null) {
  const run = game.run;
  const p = run.schedule.next();
  let spawnUs = p.index === 0 ? 0 : resolveUs + p.gapMs * 1000;
  if (resumeAtUs !== null) spawnUs = Math.max(spawnUs, resumeAtUs);
  const slow = run.armed;
  if (slow) {
    run.armed = false;
    run.slowMoRings.push(p.index);
  }
  const durationUs = slow ? p.durationMs * SLOWMO_FACTOR * 1000 : p.durationMs * 1000;
  const windowMs = closeWindowMs(run.ftue, p.index);
  run.cur = {
    index: p.index,
    archetype: p.archetype,
    drift: p.drift,
    slow,
    spawnUs,
    closeUs: spawnUs + durationUs,
    deadlineUs: spawnUs + durationUs + windowMs * 1000,
    windowMs,
    spawnPerf: run.ring0Perf + spawnUs / 1000,
    closePerf: run.ring0Perf + (spawnUs + durationUs) / 1000,
    spawned: false,
    resolved: false,
  };
}

function tick(now) {
  const run = game.run;
  const ring = run?.cur;
  if (!ring || ring.resolved || run.ended) return;
  if (!ring.spawned && now >= ring.spawnPerf) {
    ring.spawned = true;
    fx.spawn();
    renderHud();
  }
  // Small grace so a tap event stamped before the deadline but dispatched late still counts.
  if (now > run.ring0Perf + ring.deadlineUs / 1000 + 30) resolveRing(null);
}

function onTap(e) {
  const run = game.run;
  if (!run || run.ended || e.button > 0) return;
  fx.unlock();
  const ring = run.cur;
  if (!ring || ring.resolved) return;
  const tapUs = Math.round((e.timeStamp - run.ring0Perf) * 1000);
  if (tapUs < ring.spawnUs + HUMAN_REACTION_FLOOR_MS * 1000) return; // before spawn / mashed carry-over: ignore
  if (tapUs > ring.deadlineUs) {
    resolveRing(null);
    return;
  }
  resolveRing(tapUs);
}

function resolveRing(tapUs) {
  const run = game.run;
  const ring = run.cur;
  ring.resolved = true;
  const g = geometry();
  let verdict;
  let deltaUs = 0;
  let resolveUs;
  if (tapUs === null) {
    verdict = 'MISS';
    run.tapsUs.push(-1);
    resolveUs = ring.deadlineUs;
  } else {
    deltaUs = tapUs - ring.closeUs;
    verdict = classify(Math.abs(deltaUs), ring.windowMs);
    run.tapsUs.push(tapUs);
    run.deltasUs.push(deltaUs);
    resolveUs = tapUs;
    store.set('seenHint', true);
    $('hint').hidden = true;
  }
  run.verdicts.push(verdict);
  run.ticks += ticksFor(verdict);

  fx.verdict(verdict);
  showVerdict(verdict, deltaUs, tapUs !== null);
  if (verdict === 'PERFECT') {
    punchUntil = performance.now() + 8 * 4;
    shockwave(g.cx, g.cy, g.target, COLORS.gold);
    burst(g.cx, g.cy, COLORS.gold, 40, 420);
  } else if (verdict === 'CLEAN') {
    shockwave(g.cx, g.cy, g.target, COLORS.clean);
    burst(g.cx, g.cy, COLORS.clean, 14, 260);
  } else if (verdict === 'CLOSE') {
    canvas.classList.add('desat');
    setTimeout(() => canvas.classList.remove('desat'), 120);
  } else {
    const v = $('vignette');
    v.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove('on')));
  }

  if (verdict === 'MISS') {
    run.misses++;
    run.streak = 0;
  } else {
    run.streak++;
    run.bestStreak = Math.max(run.bestStreak, run.streak);
    if ([10, 25, 50, 100].includes(run.streak)) {
      fx.milestone();
      burst(g.cx, g.cy, COLORS.gold, 60, 520);
    }
  }
  renderHud();

  if (run.misses >= run.maxMisses + run.extraLives) {
    if (run.mode === 'PULSE' && !run.adOffered && run.verdicts.length >= 5) {
      run.adOffered = true;
      run.pendingResolveUs = resolveUs;
      setScreen('continue-screen');
      $('ad-status').textContent = '';
      return;
    }
    endRun();
  } else if (run.verdicts.length >= run.maxRings) {
    endRun();
  } else {
    scheduleRing(resolveUs);
  }
}

// ---- Rewarded ad continue ("Replay this exact ring" placement, server-validated when online)
async function watchAdToContinue() {
  const run = game.run;
  const status = $('ad-status');
  $('continue-ad').disabled = true;
  try {
    let grantId = null;
    if (run.online) {
      grantId = (await api.request('POST', '/v1/ads/intent', { placement: 'replay_ring', runId: run.runId })).grantId;
    }
    for (let s = 3; s > 0; s--) {
      status.textContent = `Simulated ad… ${s}`;
      await sleep(1000);
    }
    if (run.online) {
      status.textContent = 'Verifying reward with the server…';
      await api.request('POST', `/v1/ads/dev-complete/${grantId}`, {});
      let granted = false;
      for (let i = 0; i < 8 && !granted; i++) {
        granted = (await api.request('GET', `/v1/ads/grant/${grantId}`)).status === 'GRANTED';
        if (!granted) await sleep(500);
      }
      if (!granted) throw new Error('not granted');
    }
    run.extraLives++;
    const resumeAtUs = Math.round((performance.now() + 900 - run.ring0Perf) * 1000);
    run.resumes.push({ afterRing: run.verdicts.length - 1, atUs: resumeAtUs });
    setScreen(null);
    scheduleRing(run.pendingResolveUs, resumeAtUs);
    renderHud();
  } catch (e) {
    status.textContent = `The ad reward couldn't be verified (${e.code ?? e.message}). Ending the run.`;
    await sleep(1200);
    endRun();
  } finally {
    $('continue-ad').disabled = false;
  }
}

async function endRun() {
  const run = game.run;
  if (!run || run.ended) return;
  run.ended = true;
  if (run.cur && !run.cur.resolved) run.cur.resolved = true; // a ring still on screen when the player quits is not counted
  setScreen('results-screen');

  const before = { ...game.profile };
  const best = run.deltasUs.length ? Math.min(...run.deltasUs.map(Math.abs)) : null;
  const local = {
    verdicts: run.verdicts,
    ticks: run.mode === 'ZEN' ? 0 : run.ticks,
    rating: run.mode === 'PULSE' ? nextRating(before.rating, run.verdicts, run.deltasUs) : before.rating,
  };
  renderResults(run, local, best, before, null);

  if (run.verdicts.length === 0) return;
  if (!run.online) {
    const p = game.profile;
    p.ticks += local.ticks;
    p.rating = local.rating;
    p.slowMoTickets = Math.max(0, p.slowMoTickets - run.slowMoRings.length);
    if (best !== null && (p.bestUs === null || best < p.bestUs)) p.bestUs = best;
    saveProfile();
    renderResults(run, local, best, before, { kind: 'offline' });
    return;
  }

  $('r-verify').textContent = 'Verifying run with the server…';
  $('r-verify').className = 'verify';
  try {
    const res = await api.request('POST', '/v1/runs/submit', {
      runId: run.runId,
      tapsUs: run.tapsUs,
      slowMoRings: run.slowMoRings,
      resumes: run.resumes,
    });
    if (res.status === 'VALIDATED') {
      game.profile.rating = res.precisionRating;
      if (res.newBestDeltaUs >= 0) game.profile.bestUs = res.newBestDeltaUs;
      if (res.wallet) {
        game.profile.ticks = Number(res.wallet.ticks);
        game.profile.slowMoTickets = res.wallet.slowMoTickets;
      }
      saveProfile();
    }
    const mismatch = res.verdicts.some((v, i) => v !== run.verdicts[i]);
    renderResults(run, { verdicts: res.verdicts, ticks: res.ticksAwarded, rating: res.precisionRating }, best, before, { kind: 'server', res, mismatch });
    if (run.mode === 'GAUNTLET' && res.status === 'VALIDATED') loadLeaderboard();
  } catch (e) {
    renderResults(run, local, best, before, { kind: 'error', code: e.code ?? 'network_error' });
  }
}

function saveProfile() {
  const p = game.profile;
  store.set('rating', p.rating);
  store.set('bestUs', p.bestUs);
  store.set('ticks', p.ticks);
  store.set('slowMoTickets', p.slowMoTickets);
  renderProfile();
}

function renderResults(run, result, best, before, verification) {
  const count = (v) => result.verdicts.filter((x) => x === v).length;
  $('results-mode').textContent = `${run.mode}${run.online ? '' : ' · OFFLINE'}`;
  $('results-title').textContent = best === null ? '—' : fmtDelta(best, false);
  $('results-caption').textContent = best === null ? 'no taps this run' : 'best tap this run';
  $('results-pb').hidden = !(best !== null && (before.bestUs === null || best < before.bestUs));
  $('r-rings').textContent = String(result.verdicts.length);
  $('r-perfect').textContent = String(count('PERFECT'));
  $('r-clean').textContent = String(count('CLEAN'));
  $('r-close').textContent = String(count('CLOSE'));
  const avg = run.deltasUs.length ? run.deltasUs.reduce((a, d) => a + Math.abs(d), 0) / run.deltasUs.length : null;
  $('r-avg').textContent = avg === null ? '—' : fmtDelta(avg, false);
  $('r-ticks').textContent = `+${result.ticks}`;

  const diff = result.rating - before.rating;
  const ratingEl = $('r-rating');
  ratingEl.textContent = '';
  ratingEl.append(`PRECISION ${result.rating} `);
  if (run.mode === 'PULSE' && diff !== 0) {
    const span = document.createElement('span');
    span.className = diff > 0 ? 'up' : 'down';
    span.textContent = `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}`;
    ratingEl.append(span);
  }

  const v = $('r-verify');
  if (!verification) {
    v.textContent = '';
  } else if (verification.kind === 'offline') {
    v.className = 'verify';
    v.textContent = 'Offline demo: scored on this device. Run the backend to play server-verified runs.';
  } else if (verification.kind === 'error') {
    v.className = 'verify bad';
    v.textContent = `Couldn't submit the run (${verification.code}). It was not counted.`;
  } else if (verification.res.status === 'VALIDATED') {
    v.className = 'verify ok';
    v.textContent = verification.mismatch
      ? 'Server-verified. The server re-scored some rings slightly differently; its verdicts are shown.'
      : 'Server-verified: every ring re-simulated and scored by the server.';
  } else {
    v.className = 'verify bad';
    v.textContent = `Run ${verification.res.status.toLowerCase()} by anti-cheat (${verification.res.reason}). No rewards.`;
  }

  const shareBest = best === null ? 'no taps' : `best tap ${fmtDelta(best, false)}`;
  $('share').dataset.text = `One More Tap · ${run.mode} · ${shareBest} · ${result.verdicts.length} rings · seed ${run.seed}. Beat that.`;
  $('share-text').textContent = '';
  $('leaderboard').hidden = true;
}

async function loadLeaderboard() {
  try {
    const lb = await api.request('GET', '/v1/leaderboard/gauntlet');
    const list = $('leaderboard');
    list.textContent = '';
    for (const row of lb.top) {
      const li = document.createElement('li');
      if (row.isYou) li.className = 'me';
      const misses = row.misses ? ` · ${row.misses}✕` : '';
      li.append(Object.assign(document.createElement('span'), { textContent: `#${row.rank}` }));
      li.append(Object.assign(document.createElement('span'), { textContent: row.isYou ? 'You' : row.player }));
      li.append(Object.assign(document.createElement('span'), { textContent: `${fmtDelta(row.totalDeltaUs, false)}${misses}` }));
      list.append(li);
    }
    if (lb.you && !lb.top.some((r) => r.isYou)) {
      const li = document.createElement('li');
      li.className = 'me';
      li.textContent = `#${lb.you.rank}  You  ${fmtDelta(lb.you.totalDeltaUs, false)}`;
      list.append(li);
    }
    list.hidden = lb.top.length === 0;
  } catch {
    /* leaderboard is optional */
  }
}

// ============================================================ Wiring

canvas.addEventListener('pointerdown', onTap);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && game.run && !game.run.ended) {
    e.preventDefault();
    onTap({ timeStamp: e.timeStamp, button: 0 });
  }
});

$('slowmo').addEventListener('click', () => {
  const run = game.run;
  if (!run || run.ended) return;
  const available = run.tickets - run.slowMoRings.length;
  if (run.armed) run.armed = false;
  else if (available > 0) run.armed = true;
  // A ring already counting down keeps its speed; the armed ticket applies to the next ring that spawns.
  if (run.cur && !run.cur.spawned && run.armed && !run.cur.slow) {
    // Next ring hasn't drawn yet: apply now by rebuilding it with the same schedule entry.
    const ring = run.cur;
    const baseUs = ring.closeUs - ring.spawnUs;
    ring.slow = true;
    run.armed = false;
    run.slowMoRings.push(ring.index);
    ring.closeUs = ring.spawnUs + baseUs * SLOWMO_FACTOR;
    ring.deadlineUs = ring.closeUs + ring.windowMs * 1000;
    ring.closePerf = run.ring0Perf + ring.closeUs / 1000;
  }
  renderHud();
});

$('end-run').addEventListener('click', () => endRun());

for (const btn of document.querySelectorAll('.mode')) {
  btn.addEventListener('click', () => {
    game.mode = btn.dataset.mode;
    store.set('mode', game.mode);
    for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-checked', String(b === btn));
  });
  btn.setAttribute('aria-checked', String(btn.dataset.mode === game.mode));
}

$('start').addEventListener('click', () => startRun());
$('again').addEventListener('click', () => startRun());
$('menu').addEventListener('click', () => {
  game.run = null;
  renderProfile();
  setScreen('title-screen');
});
$('continue-ad').addEventListener('click', () => watchAdToContinue());
$('continue-end').addEventListener('click', () => endRun());
$('share').addEventListener('click', async (e) => {
  const text = e.currentTarget.dataset.text ?? '';
  const out = $('share-text');
  try {
    await navigator.clipboard.writeText(text);
    out.textContent = 'Copied.';
  } catch {
    out.textContent = text;
  }
});

const sound = $('opt-sound');
const haptics = $('opt-haptics');
sound.checked = fx.sound;
haptics.checked = fx.haptics;
sound.addEventListener('change', () => store.set('sound', (fx.sound = sound.checked)));
haptics.addEventListener('change', () => store.set('haptics', (fx.haptics = haptics.checked)));

document.addEventListener('visibilitychange', () => {
  // Backgrounding mid-run would turn every remaining ring into a miss; end the run cleanly instead.
  if (document.hidden && game.run && !game.run.ended && $('continue-screen').hidden) endRun();
});

async function connect() {
  const status = $('connection');
  if (!(await api.detect())) {
    status.textContent = 'Offline demo. Runs are scored on this device. Serve this page from the One More Tap backend for server-verified runs.';
    return;
  }
  try {
    status.textContent = 'Connecting…';
    await api.syncClock();
    await api.login();
    const profile = await api.request('GET', '/v1/profile');
    game.profile = {
      rating: profile.precisionRating,
      bestUs: profile.bestDeltaUs >= 0 ? profile.bestDeltaUs : null,
      ticks: Number(profile.wallet.ticks),
      slowMoTickets: profile.wallet.slowMoTickets,
    };
    game.online = true;
    renderProfile();
    status.className = 'connection online';
    status.textContent = `Online. Runs are re-simulated and scored by the server (clock offset ${Math.round(api.offsetMs)} ms).`;
  } catch (e) {
    status.textContent = `Server found but login failed (${e.code ?? e.message}). Playing offline.`;
  }
}

// Read-only test hook (used by the automated browser test). Exposes nothing the server trusts.
if (location.hash === '#debug') window.omtDebug = game;

resize();
renderProfile();
setScreen('title-screen');
requestAnimationFrame(render);
connect();
