// Prestige backgrounds: 100 procedural, animated geometric scenes, one per Prestige level.
// Ten families of ten levels; within a family each level has its own palette, density, motion and shape parameter.
// Level 100 is ZERO, the black-and-gold scene from the concept doc's top league. Level 0 is the plain default.
// Everything is generated from the level number, so there are no assets to load.

import { Mulberry32 } from './core.js';

export const FAMILIES = [
  { name: 'Drift', blurb: 'Floating orbs' },
  { name: 'Prism', blurb: 'Tumbling polygons' },
  { name: 'Lattice', blurb: 'Breathing grid' },
  { name: 'Hive', blurb: 'Honeycomb tide' },
  { name: 'Orbit', blurb: 'Planetary rings' },
  { name: 'Starfall', blurb: 'Falling stars' },
  { name: 'Tide', blurb: 'Sine currents' },
  { name: 'Kaleido', blurb: 'Mirrored petals' },
  { name: 'Tesseract', blurb: 'Wireframe cubes' },
  { name: 'Nova', blurb: 'Spinning seed field' },
];

const TAU = Math.PI * 2;
const cache = new Map();

/** Display info for a level (0 = default). */
export function themeInfo(level) {
  if (level === 0) return { level, name: 'Default', family: 'Dark', blurb: 'The original black' };
  if (level === 100) return { level, name: 'ZERO', family: 'Zero', blurb: 'Black and gold. The last one.' };
  const fam = FAMILIES[Math.floor((level - 1) / 10)];
  return { level, name: `${fam.name} ${((level - 1) % 10) + 1}`, family: fam.name, blurb: fam.blurb };
}

function sceneFor(level) {
  let scene = cache.get(level);
  if (scene) return scene;
  const rng = new Mulberry32(level * 7919 + 101);
  const rand = () => rng.nextUint() / 4294967296;
  const family = level === 100 ? 10 : Math.floor((level - 1) / 10);
  const step = level === 100 ? 9 : (level - 1) % 10; // 0..9 inside the family: higher = denser, faster, brighter
  const hue = (level * 137.508) % 360;
  const scheme = [
    [0, 28, -28, 56],
    [0, 180, 24, 204],
    [0, 120, 240, 60],
    [0, 150, 210, 32],
  ][level % 4];
  const sat = Math.min(96, 58 + family * 4);
  const light = 54 + Math.round(rand() * 10);
  const palette = scheme.map((o) => `hsl(${(hue + o + 360) % 360} ${sat}% ${light}%)`);
  const items = [];
  const count = 14 + step * 3 + family * 2;
  for (let i = 0; i < count; i++) {
    items.push({ u: rand(), v: rand(), size: 0.3 + rand() * 0.7, phase: rand() * TAU, speed: 0.5 + rand(), color: Math.floor(rand() * palette.length), rot: rand() * TAU });
  }
  scene = {
    level,
    family,
    step,
    palette,
    base: level === 100 ? '#030303' : `hsl(${hue} 45% 8%)`,
    items,
    param: 3 + (step % 4), // polygon sides / symmetry tweak
    speed: 0.6 + step * 0.06 + family * 0.03,
    alpha: 0.55 + family * 0.03,
  };
  cache.set(level, scene);
  return scene;
}

function polygon(ctx, x, y, r, sides, rot) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

function star(ctx, x, y, r, points, rot) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i / (points * 2)) * TAU;
    const rr = i % 2 === 0 ? r : r * 0.45;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

const wrap = (v) => ((v % 1) + 1) % 1;

const DRAW = [
  // 0 Drift: soft orbs rising with sway
  (ctx, w, h, t, s) => {
    const m = Math.min(w, h);
    for (const it of s.items) {
      const x = wrap(it.u + Math.sin(t * 0.3 * it.speed + it.phase) * 0.03) * w;
      const y = wrap(it.v - t * 0.02 * it.speed * s.speed) * h;
      const r = m * (0.02 + it.size * 0.06);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, s.palette[it.color]);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  },
  // 1 Prism: tumbling outlined polygons drifting diagonally
  (ctx, w, h, t, s) => {
    const m = Math.min(w, h);
    ctx.lineWidth = 1.5;
    for (const it of s.items) {
      const x = wrap(it.u + t * 0.012 * it.speed * s.speed) * w;
      const y = wrap(it.v + t * 0.008 * it.speed * s.speed) * h;
      ctx.strokeStyle = s.palette[it.color];
      polygon(ctx, x, y, m * (0.025 + it.size * 0.05), s.param, it.rot + t * 0.4 * it.speed);
      ctx.stroke();
    }
  },
  // 2 Lattice: square grid pulsing outward from the centre
  (ctx, w, h, t, s) => {
    const cell = Math.max(28, Math.min(w, h) / (7 + s.step));
    ctx.lineWidth = 1.2;
    for (let y = cell / 2; y < h + cell; y += cell) {
      for (let x = cell / 2; x < w + cell; x += cell) {
        const d = Math.hypot(x - w / 2, y - h / 2) / cell;
        const k = 0.5 + 0.5 * Math.sin(t * 1.6 * s.speed - d * 0.6);
        ctx.strokeStyle = s.palette[Math.floor(d) % s.palette.length];
        ctx.globalAlpha = s.alpha * (0.3 + k);
        const r = cell * 0.18 + cell * 0.22 * k;
        ctx.strokeRect(x - r, y - r, r * 2, r * 2);
      }
    }
  },
  // 3 Hive: honeycomb with a travelling fill wave
  (ctx, w, h, t, s) => {
    const r = Math.max(16, Math.min(w, h) / (10 + s.step));
    const hx = r * Math.sqrt(3);
    for (let row = -1, y = 0; y < h + r * 2; row++, y = row * r * 1.5) {
      for (let col = -1; col * hx < w + hx; col++) {
        const x = col * hx + (row % 2 ? hx / 2 : 0);
        const k = 0.5 + 0.5 * Math.sin(t * 1.2 * s.speed + x * 0.012 + y * 0.018);
        ctx.fillStyle = s.palette[(row + col + 8) % s.palette.length];
        ctx.globalAlpha = s.alpha * k * 0.42;
        polygon(ctx, x, y, r * 0.9, 6, Math.PI / 6);
        ctx.fill();
      }
    }
  },
  // 4 Orbit: concentric orbits with moving planets
  (ctx, w, h, t, s) => {
    const m = Math.max(w, h);
    const rings = 5 + Math.floor(s.step / 2);
    for (let i = 1; i <= rings; i++) {
      const R = (m * 0.6 * i) / rings;
      ctx.strokeStyle = s.palette[i % s.palette.length];
      ctx.globalAlpha = s.alpha * 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, R, R * 0.62, 0.3, 0, TAU);
      ctx.stroke();
      for (let p = 0; p < 1 + (i % 3); p++) {
        const a = t * (0.5 * s.speed) / i + p * 2.1 + i;
        const x = w / 2 + Math.cos(a) * R * Math.cos(0.3) - Math.sin(a) * R * 0.62 * Math.sin(0.3);
        const y = h / 2 + Math.cos(a) * R * Math.sin(0.3) + Math.sin(a) * R * 0.62 * Math.cos(0.3);
        ctx.globalAlpha = s.alpha * 1.6;
        ctx.fillStyle = s.palette[(i + p) % s.palette.length];
        ctx.beginPath();
        ctx.arc(x, y, 3 + (i % 4) * 1.5, 0, TAU);
        ctx.fill();
      }
    }
  },
  // 5 Starfall: rotating stars falling and twinkling
  (ctx, w, h, t, s) => {
    const m = Math.min(w, h);
    for (const it of s.items) {
      const x = wrap(it.u + t * 0.004 * it.speed) * w;
      const y = wrap(it.v + t * 0.03 * it.speed * s.speed) * h;
      ctx.globalAlpha = s.alpha * (0.5 + 0.5 * Math.sin(t * 3 * it.speed + it.phase)) * 1.4;
      ctx.fillStyle = s.palette[it.color];
      star(ctx, x, y, m * (0.012 + it.size * 0.03), 4 + (s.param % 4), it.rot + t * it.speed);
      ctx.fill();
    }
  },
  // 6 Tide: layered sine currents
  (ctx, w, h, t, s) => {
    const lines = 10 + s.step * 2;
    ctx.lineWidth = 2;
    for (let i = 0; i < lines; i++) {
      const y0 = ((i + 0.5) / lines) * h;
      const amp = h * (0.02 + 0.03 * ((i * 7) % 5) / 5);
      ctx.strokeStyle = s.palette[i % s.palette.length];
      ctx.globalAlpha = s.alpha * 1.2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 12) {
        const y = y0 + Math.sin(x * 0.01 * (1 + (i % 3) * 0.4) + t * s.speed * (1 + (i % 4) * 0.25) + i) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
  // 7 Kaleido: k-fold mirrored petals rotating around the centre
  (ctx, w, h, t, s) => {
    const k = 6 + (s.step % 4) * 2;
    const m = Math.max(w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(t * 0.08 * s.speed);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < k; i++) {
      ctx.rotate(TAU / k);
      for (const it of s.items.slice(0, 10 + s.step)) {
        const r = m * (0.08 + it.v * 0.5);
        const a = it.u * (TAU / k) + Math.sin(t * 0.4 * it.speed + it.phase) * 0.15;
        ctx.strokeStyle = s.palette[it.color];
        polygon(ctx, Math.cos(a) * r, Math.sin(a) * r, m * 0.02 * (1 + it.size * 2), s.param, it.rot + t * 0.5);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
  // 8 Tesseract: rotating wireframe cubes in perspective
  (ctx, w, h, t, s) => {
    const m = Math.min(w, h);
    const cubes = 4 + Math.floor(s.step / 2);
    const V = [-1, 1];
    const E = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
    ctx.lineWidth = 1.4;
    for (let c = 0; c < cubes; c++) {
      const it = s.items[c];
      const cx = it.u * w;
      const cy = it.v * h;
      const size = m * (0.05 + it.size * 0.08);
      const ax = t * 0.5 * it.speed * s.speed + it.phase;
      const ay = t * 0.37 * it.speed * s.speed;
      const pts = [];
      for (const x of V) for (const y of V) for (const z of V) {
        const y1 = y * Math.cos(ax) - z * Math.sin(ax);
        const z1 = y * Math.sin(ax) + z * Math.cos(ax);
        const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
        const z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
        const p = 3 / (3 + z2);
        pts.push([cx + x2 * size * p, cy + y1 * size * p]);
      }
      ctx.strokeStyle = s.palette[it.color];
      ctx.beginPath();
      for (const [a, b] of E) {
        ctx.moveTo(pts[a][0], pts[a][1]);
        ctx.lineTo(pts[b][0], pts[b][1]);
      }
      ctx.stroke();
    }
  },
  // 9 Nova: breathing, rotating seed field (phyllotaxis)
  (ctx, w, h, t, s) => {
    const n = 120 + s.step * 30;
    const m = Math.max(w, h);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const breathe = 1 + 0.06 * Math.sin(t * 0.9 * s.speed);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(i / n) * m * 0.62 * breathe;
      const a = i * golden + t * 0.12 * s.speed;
      ctx.globalAlpha = s.alpha * (0.4 + 0.6 * Math.abs(Math.sin(t * 1.5 + i * 0.05)));
      // Colour by one of 13 spiral arms (a Fibonacci number) so the sunflower pattern reads.
      ctx.fillStyle = s.palette[Math.floor(((i % 13) / 13) * s.palette.length)];
      ctx.beginPath();
      ctx.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 1.5 + (i / n) * 3, 0, TAU);
      ctx.fill();
    }
  },
  // 10 ZERO: black-and-gold mandala with sparkles
  (ctx, w, h, t, s) => {
    const m = Math.max(w, h);
    const golds = ['#f7d774', '#d4a017', '#fff1b8', '#b8860b'];
    ctx.save();
    ctx.translate(w / 2, h / 2);
    for (let layer = 0; layer < 4; layer++) {
      const k = 8 + layer * 4;
      const R = m * (0.12 + layer * 0.13);
      ctx.save();
      ctx.rotate((layer % 2 ? -1 : 1) * t * (0.05 + layer * 0.02));
      ctx.strokeStyle = golds[layer];
      ctx.globalAlpha = 0.55 - layer * 0.07;
      ctx.lineWidth = 1.2;
      for (let i = 0; i < k; i++) {
        ctx.rotate(TAU / k);
        ctx.beginPath();
        ctx.ellipse(R, 0, R * 0.45, R * 0.12, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    for (const it of s.items) {
      const tw = Math.max(0, Math.sin(t * 2.2 * it.speed + it.phase));
      ctx.globalAlpha = 0.7 * tw * tw;
      ctx.fillStyle = golds[it.color];
      star(ctx, it.u * w, it.v * h, 2 + it.size * 4, 4, it.rot);
      ctx.fill();
    }
  },
];

/**
 * Draws `level`'s background at time `t` (seconds). `cx, cy, clearR` mark the play area, which gets a dark
 * scrim so the ring always stays the brightest thing on screen.
 */
export function drawBackground(ctx, w, h, t, level, cx = w / 2, cy = h / 2, clearR = 0) {
  if (level <= 0) return;
  const s = sceneFor(level);
  ctx.save();
  ctx.fillStyle = s.base;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = s.alpha;
  if (s.family >= 4) ctx.globalCompositeOperation = 'lighter';
  DRAW[s.family](ctx, w, h, t, s);
  ctx.restore();
  if (clearR > 0) {
    // Dark well behind the ring only, so the background stays vivid everywhere else.
    const g = ctx.createRadialGradient(cx, cy, clearR * 0.3, cx, cy, clearR * 1.15);
    g.addColorStop(0, 'rgba(6,8,15,0.72)');
    g.addColorStop(1, 'rgba(6,8,15,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

/** Static thumbnail for the unlock menu. */
export function drawThumbnail(canvas, level, locked) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#06080f';
  ctx.fillRect(0, 0, w, h);
  if (locked && level === 100) return; // ZERO stays a secret until it's earned
  drawBackground(ctx, w, h, 4.2, level);
  if (locked) {
    ctx.fillStyle = 'rgba(6,8,15,0.6)';
    ctx.fillRect(0, 0, w, h);
  }
}
