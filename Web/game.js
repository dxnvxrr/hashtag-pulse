import {
  RingSchedule,
  closeWindowMs,
  classify,
  ticksFor,
  nextRating,
  baseDurationForRating,
  toGameTimeUs,
  windowRealUs,
  prestigeCircleSize,
  prestigeHalfPoints,
  circleAfterMiss,
  missHalvesCircle,
  LIVES,
  PRESTIGE_MAX,
  ringLook,
  lookProgress,
  lookAlpha,
  looksUnlocked,
  SLOWMO_FACTOR,
  HUMAN_REACTION_FLOOR_MS,
} from './core.js';
import { drawBackground, drawThumbnail, themeInfo } from './backgrounds.js';
import { Music, themeIndexFor, themeName, intensityForStreak } from './music.js';
import { dayKey, recordPlay, streakStatus, emptyStreak, encodeChallenge, decodeChallenge, compareChallenge } from './progress.js';
import { store } from './store.js';
import { Api, ApiError, sleep } from './api.js';
import { halfPoints, makeHandle, regionForTimeZone, REGION_CODES, seasonId } from './social.js';
import { createBoards } from './board.js';
import { native } from './native.js';

// ============================================================ Audio + haptics (procedural, nothing to load)

const clamp01 = (v, d) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : d));

const fx = {
  ctx: null,
  master: null,
  sfx: null,
  musicBus: null,
  music: null,
  // Older builds stored one 'volume'; it becomes the Sound FX level.
  sfxVolume: clamp01(store.get('sfxVolume', store.get('volume', 0.8)), 0.8),
  musicVolume: clamp01(store.get('musicVolume', 0.5), 0.5),
  haptics: store.get('haptics', true),
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,

  /**
   * Creates/resumes audio from inside a user gesture. Browsers start audio suspended until the player interacts; iOS
   * additionally mutes Web Audio when the ringer switch is on silent unless the page asks for 'playback' audio.
   */
  unlock() {
    if (!this.ctx) {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        /* older Safari: no audioSession */
      }
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        this.ctx = null;
        return;
      }
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicVolume;
      this.musicBus.connect(this.master);
      // A one-sample silent buffer started inside the gesture unlocks audio on older iOS.
      const silent = this.ctx.createBufferSource();
      silent.buffer = this.ctx.createBuffer(1, 1, 22050);
      silent.connect(this.ctx.destination);
      silent.start(0);
      this.music = new Music(this.ctx, this.musicBus);
      this.music.setTheme(themeIndexFor(game.equipped));
      this.music.start();
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  },
  setSfxVolume(v) {
    this.sfxVolume = v;
    store.set('sfxVolume', v);
    if (this.sfx) this.sfx.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  },
  setMusicVolume(v) {
    this.musicVolume = v;
    store.set('musicVolume', v);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  },
  setMusicTheme(level) {
    this.music?.setTheme(themeIndexFor(level));
  },
  setStreak(streak) {
    this.music?.setIntensity(intensityForStreak(streak));
  },
  tone(freq, dur, { type = 'sine', gain = 0.18, endFreq = null, delay = 0 } = {}) {
    if (!this.ctx || this.sfxVolume <= 0) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },
  /** `kind` picks the native haptic in the app; `pattern` is the web fallback (Android browsers only). */
  vibrate(pattern, kind = 'tap') {
    if (!this.haptics) return;
    if (!native.haptic(kind) && navigator.vibrate) navigator.vibrate(pattern);
  },
  /** `streak` raises the PERFECT chime a semitone per hit in a row, up to an octave. */
  verdict(v, streak = 0) {
    switch (v) {
      case 'PERFECT': {
        const f = 880 * 2 ** (Math.min(streak, 12) / 12);
        this.tone(f, 0.5, { gain: 0.22 });
        this.tone(f * 2, 0.3, { gain: 0.06 });
        this.vibrate(18, 'perfect');
        break;
      }
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
        this.vibrate([30, 30, 40], 'miss');
    }
  },
  spawn() {
    this.tone(2200, 0.03, { type: 'square', gain: 0.015 });
  },
  milestone() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, { gain: 0.12, delay: i * 0.07 }));
    this.vibrate([30, 60, 30, 60, 45], 'big');
  },
  prestige() {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.32, { gain: 0.13, delay: i * 0.06 }));
    this.tone(1760, 0.8, { gain: 0.05, delay: 0.38 });
    this.vibrate([40, 50, 40, 50, 40, 50, 90], 'big');
  },
};

// ============================================================ Rendering

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;
let DPR = 1;

const bgCanvas = $('bg');
const bgCtx = bgCanvas.getContext('2d');

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  for (const c of [canvas, bgCanvas]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
  bgDirty = true;
}

// ---- Prestige background layer (its own canvas, drawn under the ring)
let bgLevel = 0;
let bgDirty = true;
let bgTime = 4.2; // scene clock in seconds; runs faster while the background pulses
// Reactions to play, each decaying from 1 to 0: pulse (PERFECT), gold (circle filled), dim (miss).
const bgFx = { pulse: 0, gold: 0, dim: 0 };

function reactBackground(kind, amount = 1) {
  bgFx[kind] = Math.max(bgFx[kind], amount);
}

function setBackground(level) {
  if (level === bgLevel) return;
  // Short CSS crossfade: fade out, swap scene, fade in.
  bgCanvas.style.opacity = '0';
  setTimeout(() => {
    bgLevel = level;
    bgDirty = true;
    bgCanvas.style.opacity = '1';
  }, 220);
}

function renderBackground(dt) {
  const reacting = bgFx.pulse > 0.01 || bgFx.gold > 0.01 || bgFx.dim > 0.01;
  for (const k in bgFx) bgFx[k] = Math.max(0, bgFx[k] - dt * (k === 'dim' ? 2.2 : 1.6));
  if (!fx.reducedMotion) bgTime += dt * (1 + 2.5 * bgFx.pulse);
  // Static scenes (default, or reduced motion) are redrawn only when something changes.
  if ((bgLevel === 0 || fx.reducedMotion) && !bgDirty && !reacting) return;
  bgDirty = false;

  const g = geometry();
  bgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bgCtx.clearRect(0, 0, W, H);
  if (bgLevel > 0) {
    if (bgFx.pulse > 0 && !fx.reducedMotion) {
      const k = 1 + 0.03 * bgFx.pulse;
      bgCtx.setTransform(DPR * k, 0, 0, DPR * k, DPR * g.cx * (1 - k), DPR * g.cy * (1 - k));
    }
    drawBackground(bgCtx, W, H, bgTime, bgLevel, g.cx, g.cy, game.run ? g.start : 0);
    bgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  if (bgFx.gold > 0) {
    const grad = bgCtx.createRadialGradient(g.cx, g.cy, g.target, g.cx, g.cy, Math.max(W, H) * 0.7);
    grad.addColorStop(0, `rgba(255,200,87,${0.35 * bgFx.gold})`);
    grad.addColorStop(1, 'rgba(255,200,87,0)');
    bgCtx.fillStyle = grad;
    bgCtx.fillRect(0, 0, W, H);
  }
  if (bgFx.dim > 0) {
    bgCtx.fillStyle = `rgba(0,0,0,${0.55 * bgFx.dim})`;
    bgCtx.fillRect(0, 0, W, H);
  }
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
const particles = Array.from({ length: 160 }, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, color: '' }));
const waves = Array.from({ length: 8 }, () => ({ alive: false, x: 0, y: 0, r: 0, life: 0, color: '', reach: 0.3 }));
let punchUntil = 0;
const shake = { until: 0, mag: 0 };

/** Streak scale for effects: 0 on the first hit, 1 from 20 in a row. */
const streakScale = (streak) => Math.min(streak, 20) / 20;

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

function shockwave(x, y, r, color, reach = 0.3) {
  const w = waves.find((q) => !q.alive);
  if (!w) return;
  w.alive = true;
  w.x = x;
  w.y = y;
  w.r = r;
  w.life = 0;
  w.color = color;
  w.reach = reach;
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

  renderBackground(dt);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const g = geometry();

  if (now < shake.until && !fx.reducedMotion) {
    const k = shake.mag * ((shake.until - now) / 140);
    ctx.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
  }

  if (now < punchUntil && !fx.reducedMotion) {
    ctx.translate(g.cx, g.cy);
    ctx.scale(0.975, 0.975);
    ctx.translate(-g.cx, -g.cy);
  }

  const run = game.run;
  let x = g.cx;
  if (run) {
    const ring = run.cur;
    if (ring && ring.look === 'drifter' && !fx.reducedMotion) {
      const p = Math.min(1.2, Math.max(0, (now - ring.spawnPerf) / (ring.closePerf - ring.spawnPerf)));
      x = g.cx + ring.drift * Math.min(W * 0.22, 160) * (p - 0.5) * 2;
    }
    run.ringX = x;

    // The golden circle around the target. Ranked: fills one segment per hit in a row; full = next Prestige level.
    // Zen: shows progress to the next streak milestone.
    let frac;
    if (run.mode === 'RANKED') {
      frac = run.prestige >= PRESTIGE_MAX ? 1 : run.circleHalf / (prestigeCircleSize(run.prestige + 1) * 2);
    } else {
      const nextMilestone = [10, 25, 50, 100].find((m) => m > run.streak) ?? run.streak + 50;
      const prevMilestone = [0, 10, 25, 50, 100].filter((m) => m <= run.streak).pop() ?? 0;
      frac = (run.streak - prevMilestone) / (nextMilestone - prevMilestone);
    }
    // The unfilled part is only a whisper, so it doesn't read as a second ring.
    ctx.strokeStyle = COLORS.gold;
    ctx.globalAlpha = 0.045;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, g.cy, g.target + 11, 0, Math.PI * 2);
    ctx.stroke();
    if (frac > 0) {
      ctx.globalAlpha = 0.9;
      ctx.shadowColor = COLORS.gold;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, g.cy, g.target + 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (run.mode === 'RANKED' && run.prestige < PRESTIGE_MAX) {
      // Exact fill, e.g. "6.5 / 10", so halving after a miss is legible.
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = COLORS.gold;
      ctx.font = '500 11px "Martian Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${run.circleHalf / 2} / ${prestigeCircleSize(run.prestige + 1)}`, x, g.cy - g.target - 22);
      ctx.textAlign = 'start';
    }
    if (run.streak >= 3) {
      ctx.globalAlpha = 0.55 + 0.45 * streakScale(run.streak);
      ctx.fillStyle = COLORS.gold;
      ctx.font = '800 12px "Manrope", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`STREAK ${run.streak}`, x, g.cy - g.target - 40);
      ctx.textAlign = 'start';
    }
    ctx.globalAlpha = 1;

    drawCircle(x, g.cy, g.target, COLORS.target, 2);

    if (ring && !ring.resolved && now >= ring.spawnPerf) {
      const p = (now - ring.spawnPerf) / (ring.closePerf - ring.spawnPerf);
      const r = g.start - (g.start - g.target) * lookProgress(ring.look, p);
      const alpha = Math.min(1, (now - ring.spawnPerf) / 140) * lookAlpha(ring.look, p);
      const color = ring.slow ? COLORS.slowmo : COLORS.ring;
      if (r > 0) drawCircle(x, g.cy, r, color, 3, alpha, 18);
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
    drawCircle(w.x, w.y, w.r + t * Math.min(W, H) * w.reach, w.color, 3 * (1 - t), 1 - t, 20);
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

const MODES = ['RANKED', 'ZEN'];

const game = {
  online: false,
  mode: MODES.includes(store.get('mode', 'RANKED')) ? store.get('mode', 'RANKED') : 'RANKED',
  run: null,
  profile: {
    rating: store.get('rating', 1000),
    bestUs: store.get('bestUs', null),
    ticks: store.get('ticks', 0),
    slowMoTickets: store.get('slowMoTickets', 3),
    prestige: Math.min(PRESTIGE_MAX, Math.max(0, Number(store.get('prestige', 0)) || 0)),
  },
  equipped: Number(store.get('equippedBg', 0)) || 0,
  daily: { ...emptyStreak(), ...store.get('daily', {}) },
  /** A friend's challenge from the page link (#c-…), or null. */
  challenge: decodeChallenge(location.hash),
  seenLooks: store.get('seenLooks', []),
  /** Lifetime Ranked verdicts: the server's totals when online; offline practice is counted on this device only. */
  lifetime: { server: store.get('lifetime', null), device: store.get('lifetimeDevice', null) },
  /** How the server lets this client claim an ad reward: 'attest' | 'dev' | 'none' (offline: local). */
  webAdRewards: 'local',
  /** Leaderboard identity. Offline it lives on the device; online the server's copy replaces it. */
  player: { name: localHandle(), region: localRegion(), regionLockedUntil: null, ageGateAnswered: store.get('ageGateAnswered', false) },
  /** This device's Ranked points for the current season (offline and shared-board play). */
  season: currentSeason(store.get('seasonDevice', null)),
};

function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function localHandle() {
  let name = store.get('handle', null);
  if (typeof name !== 'string' || !name) {
    const r = crypto.getRandomValues(new Uint32Array(3));
    name = makeHandle(r[0], r[1], r[2]);
    store.set('handle', name);
  }
  return name;
}

function localRegion() {
  const saved = store.get('region', undefined);
  if (saved === null || REGION_CODES.includes(saved)) return saved;
  return regionForTimeZone(deviceTimeZone());
}

function currentSeason(saved) {
  const id = seasonId(new Date());
  return saved && saved.id === id && Number.isFinite(saved.half) ? saved : { id, half: 0 };
}

function fmtDelta(us, signed = true) {
  const s = (Math.abs(us) / 1e6).toFixed(3);
  if (!signed || Math.abs(us) < 500) return `${s}s`;
  return `${us > 0 ? '+' : '−'}${s}s`;
}

function setScreen(id) {
  for (const s of ['title-screen', 'results-screen', 'ad-screen', 'unlocks-screen', 'board-screen']) $(s).hidden = s !== id;
  const playing = id === null;
  $('hud').hidden = !playing;
  $('slowmo').hidden = !playing;
}

function renderProfile() {
  const p = game.profile;
  $('profile-best').textContent = p.bestUs === null ? '—' : fmtDelta(p.bestUs, false);
  $('profile-rating').textContent = String(p.rating);
  $('profile-prestige').textContent = String(p.prestige);
  const life = lifetime();
  $('life-perfect').textContent = fmtCount(life.perfects);
  $('life-clean').textContent = fmtCount(life.cleans);
  $('life-close').textContent = fmtCount(life.closes);
  $('lifetime-source').textContent = game.online ? '' : ' · THIS DEVICE';
}

const fmtCount = (n) => n.toLocaleString('en-US');
const ZERO_LIFETIME = { perfects: 0, cleans: 0, closes: 0, rankedRuns: 0 };

function lifetime() {
  return (game.online ? game.lifetime.server : game.lifetime.device) ?? ZERO_LIFETIME;
}

/** Ranked verdicts that count toward lifetime stats. Slow-Mo rings don't (same rule as the server). */
function statCounts(run) {
  const c = { perfects: 0, cleans: 0, closes: 0 };
  for (const r of run.rings) {
    if (r.slow) continue;
    if (r.verdict === 'PERFECT') c.perfects++;
    else if (r.verdict === 'CLEAN') c.cleans++;
    else if (r.verdict === 'CLOSE') c.closes++;
  }
  return c;
}

function setServerLifetime(stats) {
  game.lifetime.server = stats;
  store.set('lifetime', stats);
}

/** Equips a background the player has unlocked (0 = default). */
function equip(level) {
  if (level < 0 || level > game.profile.prestige) return;
  game.equipped = level;
  store.set('equippedBg', level);
  setBackground(level);
  fx.setMusicTheme(level);
  refreshUnlocks();
}

let toastTimer = 0;
function showToast(eyebrow, name) {
  const t = $('toast');
  $('toast-eyebrow').textContent = eyebrow;
  $('toast-name').textContent = name;
  t.hidden = true;
  void t.offsetWidth; // restart the CSS animation
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

const LOOK_TIPS = {
  ghost: 'Ghost ring · fades in and out',
  stutter: 'Stutter ring · closes in jumps',
  eclipse: 'Eclipse ring · tap the second close',
};

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
    // Always 5 dots: an ad refill restores them instead of adding more.
    const lost = Math.max(0, run.misses - run.refilledLives);
    lives.textContent = '';
    for (let i = 0; i < run.maxMisses; i++) {
      const dot = document.createElement('i');
      if (i < lost) dot.className = 'lost';
      lives.appendChild(dot);
    }
    lives.setAttribute('aria-label', `${run.maxMisses - lost} lives left`);
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

/** `challenge`: a decoded challenge link; the run replays the friend's exact rings (same seed, speed and looks). */
async function startRun(challenge = null) {
  fx.unlock();
  const mode = challenge ? 'CHALLENGE' : game.mode;
  let params;
  if (game.online) {
    try {
      const body = challenge ? { mode: 'DUEL', duelSeed: challenge.seed, duelBaseMs: challenge.base } : { mode };
      let res;
      try {
        res = await api.request('POST', '/v1/runs/start', challenge?.runId ? { ...body, challengeRunId: challenge.runId } : body);
      } catch (e) {
        // A link from an older or unverified run: still playable as a plain DUEL, compared with the link's numbers.
        if (e.code !== 'bad_challenge') throw e;
        res = await api.request('POST', '/v1/runs/start', body);
      }
      // The server's copy of the challenger's score wins over the numbers in the link (links can be edited).
      if (challenge && res.challenge) challenge = { ...challenge, ...res.challenge, verified: true };
      params = {
        runId: res.runId,
        seed: res.seed,
        base: res.baseDurationMs,
        ftue: res.ftue,
        maxRings: res.maxRings,
        maxMisses: LIVES[mode],
        ring0Perf: Math.max(performance.now() + 300, api.serverToPerf(res.ring0ServerTimeMs)),
      };
    } catch (e) {
      $('connection').textContent = `Couldn't reach the server (${e.code}). Playing offline.`;
      game.online = false;
    }
  }
  if (!params) {
    const ftue = mode === 'RANKED' && game.profile.bestUs === null;
    params = {
      runId: null,
      seed: challenge ? challenge.seed : crypto.getRandomValues(new Uint32Array(1))[0],
      base: challenge ? challenge.base : ftue ? 2500 : baseDurationForRating(game.profile.rating),
      ftue,
      maxRings: 500,
      maxMisses: LIVES[mode],
      ring0Perf: performance.now() + 900,
    };
  }

  game.run = {
    ...params,
    mode,
    online: game.online && params.runId !== null,
    challenge,
    looks: challenge ? challenge.block : looksUnlocked(game.profile.prestige),
    schedule: new RingSchedule(params.seed, params.base),
    cur: null,
    tapsUs: [],
    deltasUs: [],
    verdicts: [],
    rings: [],
    slowMoRings: [],
    resumes: [],
    armed: false,
    tickets: game.profile.slowMoTickets,
    misses: 0,
    streak: 0,
    bestStreak: 0,
    ticks: 0,
    refilledLives: 0,
    adShown: false,
    prestige: game.profile.prestige,
    circleHalf: 0, // golden-circle fill in half-points
    unlocked: [],
    ended: false,
    startedAt: performance.now(),
  };
  $('hint').hidden = !params.ftue && store.get('seenHint', false);
  scheduleRing(0);
  setScreen(null);
  $('slowmo').hidden = mode === 'CHALLENGE'; // challenges compare raw skill
  fx.setStreak(0);
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
  const look = ringLook(run.seed, p.index, p.archetype, run.looks);
  run.cur = {
    index: p.index,
    look,
    drift: p.drift,
    slow,
    spawnUs,
    closeUs: spawnUs + durationUs,
    deadlineUs: spawnUs + durationUs + windowRealUs(windowMs, slow),
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
    if (LOOK_TIPS[ring.look] && !game.seenLooks.includes(ring.look)) {
      // First sighting of a new ring type: a one-time tip.
      game.seenLooks.push(ring.look);
      store.set('seenLooks', game.seenLooks);
      showToast('NEW RING', LOOK_TIPS[ring.look]);
    }
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
    // Slow-Mo rings are scored in game time, so their windows are 2.5x wider in real time.
    deltaUs = toGameTimeUs(tapUs - ring.closeUs, ring.slow);
    verdict = classify(Math.abs(deltaUs), ring.windowMs);
    run.tapsUs.push(tapUs);
    run.deltasUs.push(deltaUs);
    resolveUs = tapUs;
    store.set('seenHint', true);
    $('hint').hidden = true;
  }
  run.verdicts.push(verdict);
  run.rings.push({ verdict, deltaUs: tapUs === null ? null : deltaUs, slow: ring.slow });
  run.ticks += ticksFor(verdict);

  // Effects grow with the streak this hit extends (a miss resets it below).
  const nextStreak = verdict === 'MISS' ? 0 : run.streak + 1;
  const k = streakScale(nextStreak);
  const x = run.ringX ?? g.cx;
  fx.verdict(verdict, nextStreak);
  showVerdict(verdict, deltaUs, tapUs !== null);
  if (verdict === 'PERFECT') {
    punchUntil = performance.now() + 32;
    shake.until = performance.now() + 140;
    shake.mag = 3 + 9 * k;
    shockwave(x, g.cy, g.target, COLORS.gold, 0.3 + 0.3 * k);
    burst(x, g.cy, COLORS.gold, 40 + Math.round(60 * k), 420 + 260 * k);
    reactBackground('pulse');
  } else if (verdict === 'CLEAN') {
    shake.until = performance.now() + 100;
    shake.mag = 1 + 4 * k;
    shockwave(x, g.cy, g.target, COLORS.clean, 0.3 + 0.15 * k);
    burst(x, g.cy, COLORS.clean, 14 + Math.round(30 * k), 260 + 160 * k);
    reactBackground('pulse', 0.5);
  } else if (verdict === 'CLOSE') {
    canvas.classList.add('desat');
    setTimeout(() => canvas.classList.remove('desat'), 120);
  } else {
    const v = $('vignette');
    v.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove('on')));
    reactBackground('dim');
  }

  if (verdict === 'MISS') {
    run.misses++;
    run.streak = 0;
    fx.setStreak(0);
    // Same rule as applyPrestige (core.js / server): levels X1–X7 keep half the circle, X8–X10 empty it.
    if (run.mode === 'RANKED' && run.prestige < PRESTIGE_MAX) run.circleHalf = circleAfterMiss(run.circleHalf, run.prestige + 1);
  } else {
    run.streak++;
    run.bestStreak = Math.max(run.bestStreak, run.streak);
    fx.setStreak(run.streak);
    if (run.mode === 'RANKED' && run.prestige < PRESTIGE_MAX) {
      // Same rule as applyPrestige: PERFECT +2, CLEAN +1.5, SO CLOSE +1; overflow carries over.
      run.circleHalf += prestigeHalfPoints(verdict);
      while (run.prestige < PRESTIGE_MAX && run.circleHalf >= prestigeCircleSize(run.prestige + 1) * 2) {
        run.circleHalf -= prestigeCircleSize(run.prestige + 1) * 2;
        run.prestige++;
        run.unlocked.push(run.prestige);
        unlockPrestige(run.prestige);
      }
      if (run.prestige >= PRESTIGE_MAX) run.circleHalf = 0;
    } else if (run.mode === 'ZEN' && [10, 25, 50, 100].includes(run.streak)) {
      fx.milestone();
      burst(x, g.cy, COLORS.gold, 60, 520);
    }
  }
  renderHud();

  if (run.misses >= run.maxMisses + run.refilledLives) {
    if (run.mode === 'RANKED' && !run.adShown) {
      showAdPopup(resolveUs);
      return;
    }
    endRun();
  } else if (run.verdicts.length >= run.maxRings) {
    endRun();
  } else {
    scheduleRing(resolveUs);
  }
}

/** A full golden circle mid-run: celebrate, unlock and equip the new background straight away. */
function unlockPrestige(level) {
  const g = geometry();
  const x = game.run?.ringX ?? g.cx;
  fx.prestige();
  shockwave(x, g.cy, g.target, COLORS.gold, 0.6);
  shockwave(x, g.cy, g.target * 1.6, COLORS.gold, 0.6);
  burst(x, g.cy, COLORS.gold, 100, 640);
  reactBackground('gold');
  showToast(`PRESTIGE ${level} UNLOCKED`, themeInfo(level).name);
  // Kept locally so the background appears now; the server confirms the level when the run is submitted.
  game.profile.prestige = Math.max(game.profile.prestige, level);
  store.set('prestige', game.profile.prestige);
  equip(level);
}

// ============================================================ Ads
// Ranked: losing the 5th life opens one short ad popup per run. Watching it lets the player keep going with +1 life.
// A real ad network (Google H5 Games Ads) is used when the page carries <meta name="omt-ad-client">; otherwise a
// house popup is shown, which earns nothing.

const adClient = document.querySelector('meta[name="omt-ad-client"]')?.content ?? '';

function loadAdNetwork() {
  if (!adClient || window.adBreak) return;
  window.adsbygoogle = window.adsbygoogle || [];
  // COPPA: until the age gate says 13+, only non-personalized ads.
  if (!store.get('ageGateAnswered', false) || store.get('isMinor', true)) window.adsbygoogle.requestNonPersonalizedAds = 1;
  window.adBreak = window.adConfig = (o) => window.adsbygoogle.push(o);
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(adClient)}`;
  script.dataset.adFrequencyHint = '30s';
  script.crossOrigin = 'anonymous';
  document.head.append(script);
  window.adConfig({ preloadAdBreaks: 'on', sound: 'on' });
}

/** Resolves true when the ad network showed an interstitial. */
/** A Google H5 Games rewarded ad (web). Resolves true only when the player watched to the end. */
function showNetworkAd() {
  if (!adClient || !window.adBreak) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (viewed) => {
      if (!settled) {
        settled = true;
        resolve(viewed);
      }
    };
    window.adBreak({
      type: 'reward',
      name: 'ranked_out_of_lives',
      beforeAd: () => fx.master?.gain.setValueAtTime(0, fx.ctx.currentTime),
      afterAd: () => fx.master?.gain.setValueAtTime(1, fx.ctx.currentTime),
      // The player already chose to watch (the button), so show it straight away.
      beforeReward: (showAdFn) => showAdFn(),
      adViewed: () => done(true),
      adDismissed: () => done(false),
      adBreakDone: (info) => done(info?.breakStatus === 'viewed'),
    });
    setTimeout(() => done(false), 30_000);
  });
}

/** The fallback "ad" (offline demo, development, or no ad to show): a short sponsor card. Earns nothing. */
async function showHousePopup(seconds = 5) {
  const cd = $('ad-countdown');
  $('ad-slot').hidden = false;
  cd.hidden = false;
  for (let s = seconds; s > 0; s--) {
    cd.textContent = `Ad closes in ${s}s`;
    await sleep(1000);
  }
  cd.hidden = true;
  $('ad-slot').hidden = true;
}

/** Whether this run can offer a refill at all: offline demo, the app (AdMob), or a server that accepts web ads. */
function canOfferRefill(run) {
  if (!run.online) return true;
  return native.adsAvailable() || game.webAdRewards !== 'none';
}

/**
 * Out of lives: the player chooses. A rewarded ad is always opt-in (ad-network policy, and it's the player's
 * call), so the offer appears at once with no countdown. Once per run.
 */
function showAdPopup(resolveUs) {
  const run = game.run;
  run.adShown = true;
  run.pendingResolveUs = resolveUs;
  if (!canOfferRefill(run)) {
    endRun();
    return;
  }
  $('ad-slot').hidden = true;
  $('ad-countdown').hidden = true;
  $('ad-status').textContent = '';
  $('ad-continue').disabled = false;
  setScreen('ad-screen');
  $('ad-continue').focus();
}

/** Waits for the server to record the reward (AdMob's server-side callback, or the web attestation). */
async function awaitGrant(grantId, tries) {
  for (let i = 0; i < tries; i++) {
    if ((await api.request('GET', `/v1/ads/grant/${grantId}`)).status === 'GRANTED') return;
    await sleep(500);
  }
  throw new ApiError(408, 'grant_timeout', 'Reward not confirmed');
}

async function watchAdForLives() {
  const run = game.run;
  const status = $('ad-status');
  $('ad-continue').disabled = true;
  status.textContent = '';
  try {
    if (!run.online) {
      await showHousePopup();
    } else {
      // The server enforces the cool-down and daily cap and issues a one-time grant for this view.
      const { grantId } = await api.request('POST', '/v1/ads/intent', { placement: 'replay_ring', runId: run.runId });
      if (native.adsAvailable()) {
        if (!(await native.rewardedAd({ grantId, userId: game.userId }))) throw new ApiError(0, 'ad_not_finished', 'No ad, or it was closed early');
        status.textContent = 'Confirming your extra lives…';
        await awaitGrant(grantId, 30);
      } else {
        if (!(await showNetworkAd())) await showHousePopup();
        status.textContent = 'Confirming your extra lives…';
        await api.request('POST', game.webAdRewards === 'attest' ? `/v1/ads/attest/${grantId}` : `/v1/ads/dev-complete/${grantId}`, {});
        await awaitGrant(grantId, 8);
      }
    }
    if (game.run !== run || run.ended) return;
    run.refilledLives += run.maxMisses; // all 5 lives back
    const resumeAtUs = Math.round((performance.now() + 900 - run.ring0Perf) * 1000);
    run.resumes.push({ afterRing: run.verdicts.length - 1, atUs: resumeAtUs });
    setScreen(null);
    scheduleRing(run.pendingResolveUs, resumeAtUs);
    renderHud();
  } catch (e) {
    status.textContent =
      e.code === 'ad_not_finished' ? 'No extra lives: the ad didn’t finish. Try again, or end the run.' : `No extra lives this time (${e.code ?? e.message}).`;
    $('ad-continue').disabled = e.code === 'ad_daily_cap';
  }
}

async function endRun() {
  const run = game.run;
  if (!run || run.ended) return;
  run.ended = true;
  if (run.cur && !run.cur.resolved) run.cur.resolved = true; // a ring still on screen when the player quits is not counted
  setScreen('results-screen');

  const before = { ...game.profile, prestige: run.prestige - run.unlocked.length };
  // Best tap is a skill record: Slow-Mo rings don't count toward it.
  const skillDeltas = run.rings.filter((r) => !r.slow && r.deltaUs !== null).map((r) => Math.abs(r.deltaUs));
  const best = skillDeltas.length ? Math.min(...skillDeltas) : null;
  const local = {
    verdicts: run.verdicts,
    ticks: run.mode === 'ZEN' ? 0 : run.ticks,
    rating: run.mode === 'RANKED' ? nextRating(before.rating, run.rings) : before.rating,
    prestige: run.prestige,
    unlocked: run.unlocked,
  };
  run.score = challengeScore(run);
  // Offline the device keeps the day streak; online the server does (it arrives with the verified result).
  if (run.mode === 'RANKED' && run.verdicts.length > 0 && !run.online) run.daily = recordDaily();
  renderResults(run, local, best, before, null);

  if (run.verdicts.length === 0) return;
  if (!run.online) {
    if (run.mode === 'RANKED') {
      const c = statCounts(run);
      const d = game.lifetime.device ?? ZERO_LIFETIME;
      game.lifetime.device = { perfects: d.perfects + c.perfects, cleans: d.cleans + c.cleans, closes: d.closes + c.closes, rankedRuns: d.rankedRuns + 1 };
      store.set('lifetimeDevice', game.lifetime.device);
      const season = currentSeason(game.season);
      game.season = { id: season.id, half: season.half + halfPoints(c) };
      store.set('seasonDevice', game.season);
    }
    const p = game.profile;
    p.ticks += local.ticks;
    p.rating = local.rating;
    p.slowMoTickets = Math.max(0, p.slowMoTickets - run.slowMoRings.length);
    p.prestige = Math.max(p.prestige, local.prestige);
    if (best !== null && (p.bestUs === null || best < p.bestUs)) p.bestUs = best;
    saveProfile();
    renderResults(run, local, best, before, { kind: 'offline' });
    if (run.mode === 'RANKED') {
      boards.publishShared();
      native.notifications.afterRankedRun(game.daily.streak);
    }
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
    // The server's Prestige is authoritative; drop optimistic unlocks it didn't confirm.
    game.profile.prestige = res.prestige;
    store.set('prestige', res.prestige);
    if (game.equipped > res.prestige) equip(res.prestige);
    if (res.status === 'VALIDATED') {
      game.profile.rating = res.precisionRating;
      if (res.newBestDeltaUs >= 0) game.profile.bestUs = res.newBestDeltaUs;
      if (res.wallet) {
        game.profile.ticks = Number(res.wallet.ticks);
        game.profile.slowMoTickets = res.wallet.slowMoTickets;
      }
      if (res.lifetime) setServerLifetime(res.lifetime);
      if (res.daily) {
        run.daily = res.daily;
        game.daily = res.daily.state;
        renderDaily();
        native.notifications.afterRankedRun(game.daily.streak);
      }
      boards.invalidate();
      // The server's score and run id make the share link verifiable.
      if (res.score) {
        run.score = res.score;
        run.verifiedRunId = run.runId;
      }
      saveProfile();
    }
    const mismatch = res.verdicts.some((v, i) => v !== run.verdicts[i]);
    renderResults(
      run,
      { verdicts: res.verdicts, ticks: res.ticksAwarded, rating: res.precisionRating, prestige: res.prestige, unlocked: res.prestigeUnlocked },
      best,
      before,
      { kind: 'server', res, mismatch },
    );
  } catch (e) {
    renderResults(run, local, best, before, { kind: 'error', code: e.code ?? 'network_error' });
  }
}

/** "6 rings (avg 0.004s)"; no average when nothing was hit. */
function scoreText({ hits, avgUs }) {
  return hits ? `${hits} ring${hits === 1 ? '' : 's'} (avg ${fmtDelta(avgUs, false)})` : '0 rings';
}

/** Challenge score: hits and average |delta| within the first 5 lives, so ad refills and Zen don't inflate it. */
function challengeScore(run) {
  let misses = 0;
  let hits = 0;
  let sum = 0;
  for (const r of run.rings) {
    if (r.verdict === 'MISS') {
      if (++misses >= LIVES.RANKED) break;
      continue;
    }
    hits++;
    sum += Math.abs(r.deltaUs);
  }
  return { hits, avgUs: hits ? Math.round(sum / hits) : 0 };
}

/** Counts today toward the daily streak (first Ranked run of the day) and returns what changed. */
function recordDaily() {
  const result = recordPlay(game.daily, dayKey(new Date()));
  game.daily = result.state;
  store.set('daily', game.daily);
  renderDaily();
  return result;
}

function saveProfile() {
  const p = game.profile;
  store.set('rating', p.rating);
  store.set('bestUs', p.bestUs);
  store.set('ticks', p.ticks);
  store.set('slowMoTickets', p.slowMoTickets);
  store.set('prestige', p.prestige);
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
  if (run.mode === 'RANKED' && diff !== 0) {
    const span = document.createElement('span');
    span.className = diff > 0 ? 'up' : 'down';
    span.textContent = `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}`;
    ratingEl.append(span);
  }

  const prestigeEl = $('r-prestige');
  prestigeEl.hidden = run.mode !== 'RANKED';
  if (run.mode === 'RANKED') {
    const n = result.unlocked.length;
    prestigeEl.textContent = `PRESTIGE ${result.prestige}${n ? ` · ${n} new background${n > 1 ? 's' : ''}` : ''}`;
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

  // Lifetime totals: shown once they include this run (offline at once; online after the server verifies it).
  const lifeEl = $('r-lifetime');
  const counted = run.mode === 'RANKED' && (verification?.kind === 'offline' || (verification?.kind === 'server' && verification.res.lifetime));
  lifeEl.hidden = !counted;
  if (counted) {
    const l = lifetime();
    lifeEl.textContent = `LIFETIME\n${fmtCount(l.perfects)} PERFECT · ${fmtCount(l.cleans)} CLEAN · ${fmtCount(l.closes)} CLOSE`;
  }

  const daily = run.daily;
  const dailyEl = $('r-daily');
  dailyEl.hidden = !daily || daily.event === 'same-day';
  if (daily && daily.event !== 'same-day') {
    const notes = [];
    if (daily.anchorsUsed) notes.push(`${daily.anchorsUsed} Anchor${daily.anchorsUsed > 1 ? 's' : ''} saved it`);
    if (daily.event === 'reset') notes.push('streak restarted');
    if (daily.anchorEarned) notes.push('Anchor earned');
    dailyEl.textContent = `DAY STREAK ${daily.state.streak}${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
  }

  const challengeEl = $('r-challenge');
  challengeEl.hidden = !run.challenge;
  if (run.challenge) {
    const outcome = compareChallenge(run.score, run.challenge);
    challengeEl.dataset.outcome = outcome;
    const verdict = outcome === 'win' ? 'You win' : outcome === 'lose' ? 'They win' : 'Dead heat';
    challengeEl.textContent = `${verdict}: ${scoreText(run.score)} vs their ${scoreText(run.challenge)}`;
  }

  // The link replays these exact rings for a friend: same seed, speed and ring looks.
  const code = encodeChallenge({ seed: run.seed, base: run.base, block: run.looks, hits: run.score.hits, avgUs: run.score.avgUs, runId: run.verifiedRunId ?? null });
  const shareBase = document.querySelector('meta[name="omt-share-url"]')?.content || location.origin + location.pathname;
  $('share').dataset.text = `I hit ${scoreText(run.score)} in One More Tap. Beat my exact rings: ${shareBase}#${code}`;
  $('share-text').textContent = '';
}

// ============================================================ Title: daily streak + challenge card

function renderDaily() {
  const d = game.daily;
  const today = dayKey(new Date());
  const days = $('daily-days');
  days.textContent = '';
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = dayKey(date);
    const dot = document.createElement('i');
    dot.className = d.played.includes(key) ? 'on' : key === today ? 'today' : '';
    dot.title = key;
    days.append(dot);
  }
  const status = streakStatus(d, today);
  const anchors = d.anchors ? ` · ${d.anchors} Anchor${d.anchors > 1 ? 's' : ''}` : '';
  const line = {
    none: 'Play Ranked today to start a day streak.',
    done: `Day streak ${d.streak}${anchors}. Come back tomorrow.`,
    due: `Day streak ${d.streak}${anchors}. Play Ranked today to keep it.`,
    anchored: `Day streak ${d.streak}${anchors}. Your Anchors will cover the missed days.`,
    lost: `Your ${d.streak}-day streak ended. Play Ranked to start a new one.`,
  }[status];
  $('daily-text').textContent = line;
  $('daily').dataset.status = status;
}

function renderChallengeCard() {
  const c = game.challenge;
  $('challenge-card').hidden = !c;
  if (!c) return;
  $('challenge-text').textContent = `A friend hit ${scoreText(c)}. Play their exact rings and beat it.`;
}

// ============================================================ Title: age gate, challenge results, prizes (online)

function renderAgeCard() {
  // Asked once, neutrally, after the player's first run, never before they can play.
  const played = (lifetime().rankedRuns ?? 0) > 0 || game.run !== null;
  $('age-card').hidden = !game.online || game.player.ageGateAnswered || !played;
}

function buildYearOptions() {
  const select = $('age-year');
  const now = new Date().getFullYear();
  for (let y = now; y >= now - 100; y--) select.add(new Option(String(y), String(y)));
}

async function submitAgeGate(e) {
  e.preventDefault();
  const birthYear = Number($('age-year').value);
  if (!birthYear) return;
  try {
    const res = await api.request('POST', '/v1/account/age-gate', { birthYear });
    store.set('ageGateAnswered', true);
    store.set('isMinor', res.isMinor);
    game.player.ageGateAnswered = true;
    renderAgeCard();
    // New session claims carry the answer (telemetry and ads read them).
    await api.login().catch(() => {});
  } catch (err) {
    $('connection').textContent = `Couldn't save that (${err.code ?? 'network_error'}).`;
  }
}

/** Results of friends playing your challenge links, newest first; dismissed ones stay hidden. */
async function loadInbox() {
  if (!game.online) return;
  try {
    const { results } = await api.request('GET', '/v1/challenges');
    const seen = store.get('inboxSeen', '');
    const fresh = results.filter((r) => r.at > seen).slice(0, 3);
    const list = $('inbox-list');
    list.textContent = '';
    for (const r of fresh) {
      const li = document.createElement('li');
      li.dataset.outcome = r.outcome;
      const verb = r.outcome === 'win' ? 'You beat' : r.outcome === 'lose' ? 'You lost to' : 'Dead heat with';
      li.textContent = `${verb} ${r.name}: your ${scoreText(r.mine)} vs ${scoreText(r.theirs)}`;
      list.append(li);
    }
    $('inbox-card').hidden = fresh.length === 0;
    $('inbox-dismiss').dataset.latest = results[0]?.at ?? '';
  } catch {
    $('inbox-card').hidden = true;
  }
}

const money = (cents, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** A prize waiting for verification (only when the server has prizes switched on). */
async function loadPrizes() {
  if (!game.online) return;
  try {
    const p = await api.request('GET', '/v1/prizes');
    const due = p.enabled ? p.payouts.find((x) => x.status === 'AWAITING_VERIFICATION') : null;
    $('prize-card').hidden = !due;
    if (!due) return;
    const by = new Date(due.claimDeadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    $('prize-text').textContent = `You placed #${due.rank} in season ${due.season} and won ${money(due.amountCents, due.currency)}. Verify your identity by ${by} to claim it.`;
    const verify = $('prize-verify');
    verify.hidden = !p.verifyUrl;
    if (p.verifyUrl) verify.href = `${p.verifyUrl}${p.verifyUrl.includes('?') ? '&' : '?'}reference=${encodeURIComponent(due.id)}`;
    $('prize-rules').hidden = !p.rulesUrl;
    if (p.rulesUrl) $('prize-rules').href = p.rulesUrl;
  } catch {
    $('prize-card').hidden = true;
  }
}

/** In the app, once the streak is worth protecting (2+ days), offer a reminder. Asked once; never on first launch. */
async function renderRemindCard() {
  const status = await native.notifications.status();
  $('remind-card').hidden = status !== 'prompt' || game.daily.streak < 2 || store.get('remindAsked', false);
}

async function answerRemind(yes) {
  store.set('remindAsked', true);
  $('remind-card').hidden = true;
  if (yes && (await native.notifications.request())) native.notifications.afterRankedRun(game.daily.streak);
}

/** Deletes the account (online) and everything this device stored. Two taps, so it can't happen by accident. */
async function deleteMyData() {
  const btn = $('delete-data');
  const note = $('delete-note');
  if (btn.dataset.confirm !== 'yes') {
    btn.dataset.confirm = 'yes';
    btn.textContent = 'TAP AGAIN TO DELETE';
    note.textContent = game.online
      ? 'This deletes your account, Prestige, stats and leaderboard entries. It can’t be undone.'
      : 'This erases everything saved on this device. It can’t be undone.';
    return;
  }
  btn.disabled = true;
  try {
    if (game.online) await api.request('POST', '/v1/account/delete', {});
    for (const key of Object.keys(localStorage)) if (key.startsWith('omt.')) localStorage.removeItem(key);
    await native.clearSaved();
    location.reload();
  } catch (e) {
    btn.disabled = false;
    note.textContent = `Couldn't delete (${e.code ?? 'network_error'}). Check your connection and try again.`;
  }
}

function renderTitleCards() {
  renderAgeCard();
  renderRemindCard();
  loadInbox();
  loadPrizes();
}

// ============================================================ Leaderboards

const boards = createBoards({
  api,
  store,
  $,
  me: () => ({
    online: game.online,
    name: game.player.name,
    region: game.player.region,
    lifetime: lifetime(),
    prestige: game.profile.prestige,
    rating: game.profile.rating,
    season: currentSeason(game.season),
  }),
  async onRegion(region) {
    if (!game.online) {
      game.player.region = region;
      store.set('region', region);
      boards.publishShared();
      return null;
    }
    try {
      applyPlayer(await api.request('PATCH', '/v1/profile', { region }));
      return null;
    } catch (e) {
      if (e.code === 'region_cooldown') return `You can change region once a week. ${regionUnlockText()}`;
      return `Couldn't change region (${e.code ?? 'network_error'}).`;
    }
  },
  async onReroll() {
    if (!game.online) {
      store.set('handle', null);
      game.player.name = localHandle();
      boards.publishShared();
      return null;
    }
    try {
      applyPlayer(await api.request('PATCH', '/v1/profile', { rerollName: true }));
      return null;
    } catch (e) {
      return e.code === 'reroll_limit' ? 'That’s enough new names for today.' : `Couldn't change name (${e.code ?? 'network_error'}).`;
    }
  },
});

function regionUnlockText() {
  const until = game.player.regionLockedUntil;
  return until ? `Next change: ${new Date(until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.` : '';
}

function applyPlayer(p) {
  game.player = { name: p.displayName, region: p.region, regionLockedUntil: p.regionLockedUntil, ageGateAnswered: p.ageGateAnswered };
}

function openBoard() {
  setScreen('board-screen');
  boards.open();
}

// ============================================================ Unlocks menu

let gridBuilt = false;
let thumbObserver = null;

function buildUnlocks() {
  const grid = $('unlock-grid');
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        paintTile(e.target);
      }
    },
    { root: $('unlocks-screen'), rootMargin: '200px' },
  );
  for (let level = 0; level <= PRESTIGE_MAX; level++) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'unlock-tile' + (level === 100 ? ' zero' : '');
    btn.dataset.level = String(level);
    const c = document.createElement('canvas');
    c.width = 192;
    c.height = 192;
    const lock = document.createElement('span');
    lock.className = 'lock';
    lock.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    const meta = document.createElement('span');
    meta.className = 'tile-meta';
    meta.innerHTML = '<span class="tile-level"></span><span class="tile-name"></span>';
    btn.append(c, lock, meta);
    btn.addEventListener('click', () => {
      if (level <= game.profile.prestige) equip(level);
    });
    li.append(btn);
    grid.append(li);
    thumbObserver.observe(btn);
  }
  gridBuilt = true;
}

function paintTile(btn) {
  const level = Number(btn.dataset.level);
  const locked = level > game.profile.prestige;
  if (btn.dataset.painted === String(locked)) return;
  drawThumbnail(btn.querySelector('canvas'), level, locked);
  btn.dataset.painted = String(locked);
}

function refreshUnlocks() {
  if (!gridBuilt) return;
  const p = game.profile.prestige;
  $('unlocks-level').textContent = String(p);
  $('equipped-label').textContent = `EQUIPPED · ${themeInfo(game.equipped).name.toUpperCase()}`;
  $('unlocks-hint').textContent =
    p >= PRESTIGE_MAX
      ? 'All 100 unlocked. You reached ZERO.'
      : `Fill the golden circle in Ranked to unlock Prestige ${p + 1} (${prestigeCircleSize(p + 1)} points): PERFECT +2, CLEAN +1.5, SO CLOSE +1. ${
          missHalvesCircle(p + 1) ? 'A miss halves the circle.' : 'Final levels of the block: a miss empties the circle.'
        }`;
  $('music-theme').textContent = `Now playing: ${themeName(themeIndexFor(game.equipped))}`;
  for (const btn of $('unlock-grid').querySelectorAll('.unlock-tile')) {
    const level = Number(btn.dataset.level);
    const locked = level > p;
    const info = themeInfo(level);
    btn.classList.toggle('locked', locked);
    btn.classList.toggle('equipped', level === game.equipped);
    btn.setAttribute('aria-disabled', String(locked));
    btn.setAttribute('aria-pressed', String(level === game.equipped));
    btn.querySelector('.tile-level').textContent = level === 0 ? 'DEFAULT' : `LVL ${level}`;
    btn.querySelector('.tile-name').textContent = locked && level === 100 ? '???' : info.name;
    btn.querySelector('.lock').hidden = !locked;
    btn.setAttribute('aria-label', locked ? `Level ${level}, locked` : `${info.name}, ${info.blurb}${level === game.equipped ? ', equipped' : ''}`);
    if (btn.dataset.painted !== undefined && btn.dataset.painted !== String(locked)) paintTile(btn);
  }
}

function openUnlocks() {
  if (!gridBuilt) buildUnlocks();
  refreshUnlocks();
  setScreen('unlocks-screen');
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
    ring.deadlineUs = ring.closeUs + windowRealUs(ring.windowMs, true);
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
$('again').addEventListener('click', () => startRun(game.run?.challenge ?? null));
$('challenge-accept').addEventListener('click', () => startRun(game.challenge));
$('challenge-dismiss').addEventListener('click', () => {
  game.challenge = null;
  renderChallengeCard();
});
$('menu').addEventListener('click', () => {
  renderProfile();
  setScreen('title-screen');
  renderTitleCards();
  game.run = null;
});
$('open-board').addEventListener('click', () => openBoard());
$('board-close').addEventListener('click', () => setScreen('title-screen'));
$('age-card').addEventListener('submit', submitAgeGate);
$('remind-yes').addEventListener('click', () => answerRemind(true));
$('remind-no').addEventListener('click', () => answerRemind(false));
$('delete-data').addEventListener('click', deleteMyData);

// Privacy policy: the app build names its URL; the backend serves /privacy next to /play.
{
  const url = document.querySelector('meta[name="omt-privacy-url"]')?.content || (location.pathname.startsWith('/play') ? '/privacy' : '');
  $('privacy-link').hidden = !url;
  if (url) $('privacy-link').href = url;
}

// App shell: challenge links open the app; backgrounding ends a run cleanly; Android back steps out of screens.
native.onDeepLink((hash) => {
  const c = decodeChallenge(hash);
  if (!c || (game.run && !game.run.ended)) return;
  game.challenge = c;
  renderChallengeCard();
  setScreen('title-screen');
});
native.onPause(() => {
  if (game.run && !game.run.ended && $('ad-screen').hidden) endRun();
});
native.onBack(() => {
  if (game.run && !game.run.ended) {
    endRun();
    return true;
  }
  if (!$('title-screen').hidden) return false;
  setScreen('title-screen');
  return true;
});
$('inbox-dismiss').addEventListener('click', (e) => {
  store.set('inboxSeen', e.currentTarget.dataset.latest ?? '');
  $('inbox-card').hidden = true;
});
$('ad-continue').addEventListener('click', () => watchAdForLives());
$('ad-end').addEventListener('click', () => endRun());
$('open-unlocks').addEventListener('click', () => openUnlocks());
$('unlocks-close').addEventListener('click', () => setScreen('title-screen'));
$('share').addEventListener('click', async (e) => {
  const text = e.currentTarget.dataset.text ?? '';
  const out = $('share-text');
  if (await native.share(text)) return;
  try {
    await navigator.clipboard.writeText(text);
    out.textContent = 'Copied.';
  } catch {
    out.textContent = text;
  }
});

const haptics = $('opt-haptics');
function bindSlider(id, valueId, initial, apply, preview) {
  const el = $(id);
  el.value = String(Math.round(initial * 100));
  $(valueId).textContent = el.value;
  el.addEventListener('input', () => {
    fx.unlock();
    apply(Number(el.value) / 100);
    $(valueId).textContent = el.value;
  });
  if (preview) el.addEventListener('change', preview);
}
bindSlider('opt-music', 'music-value', fx.musicVolume, (v) => fx.setMusicVolume(v));
bindSlider('opt-sfx', 'sfx-value', fx.sfxVolume, (v) => fx.setSfxVolume(v), () => fx.verdict('PERFECT'));

// Unlock audio on the first interaction anywhere (iOS only unlocks on touchend/click, not on touchstart).
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(type, () => fx.unlock(), { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (!fx.ctx) return;
  if (document.hidden) fx.ctx.suspend().catch(() => {});
  else fx.ctx.resume().catch(() => {});
});
haptics.checked = fx.haptics;
haptics.addEventListener('change', () => store.set('haptics', (fx.haptics = haptics.checked)));

document.addEventListener('visibilitychange', () => {
  // Backgrounding mid-run would turn every remaining ring into a miss; end the run cleanly instead.
  if (document.hidden && game.run && !game.run.ended && $('ad-screen').hidden) endRun();
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
      prestige: profile.prestige,
    };
    game.webAdRewards = profile.webAdRewards ?? 'none';
    game.userId = profile.userId;
    if (profile.lifetime) setServerLifetime(profile.lifetime);
    if (profile.daily) game.daily = profile.daily;
    if (profile.player) {
      applyPlayer(profile.player);
      await syncPlayer(profile.player);
    }
    store.set('prestige', profile.prestige);
    if (game.equipped > profile.prestige) equip(profile.prestige);
    game.online = true;
    renderProfile();
    renderDaily();
    renderTitleCards();
    status.className = 'connection online';
    status.textContent = `Online. Runs are re-simulated and scored by the server (clock offset ${Math.round(api.offsetMs)} ms).`;
  } catch (e) {
    status.textContent = `Server found but login failed (${e.code ?? e.message}). Playing offline.`;
  }
}

/** Tells the server this device's time zone (the day streak counts its days) and, once, its likely region. */
async function syncPlayer(p) {
  const patch = {};
  const tz = deviceTimeZone();
  if (tz && tz !== p.timeZone) patch.timeZone = tz;
  if (p.region === null && !store.get('regionAsked', false)) {
    const guess = regionForTimeZone(tz);
    if (guess) patch.region = guess;
    store.set('regionAsked', true);
  }
  if (Object.keys(patch).length === 0) return;
  try {
    applyPlayer(await api.request('PATCH', '/v1/profile', patch));
  } catch {
    // Not worth bothering the player: the streak falls back to UTC days and the region can be picked by hand.
  }
}

// Read-only test hook (used by the automated browser test). Exposes nothing the server trusts.
if (location.hash.endsWith('debug')) {
  window.omtDebug = game;
  window.omtFx = fx;
  window.omtBg = bgFx;
  window.omtApi = api;
}

/** Web fonts load after first paint; the system fallback stack shows until they arrive. */
function loadFonts() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Martian+Mono:wght@500;800&family=Manrope:wght@400;600;800&display=swap';
  document.head.append(link);
}

resize();
renderProfile();
renderDaily();
renderChallengeCard();
buildYearOptions();
if (game.equipped > game.profile.prestige) game.equipped = 0;
bgLevel = game.equipped;
loadAdNetwork();
setScreen('title-screen');
requestAnimationFrame(render);
requestAnimationFrame(loadFonts);
connect();
