// Procedural chiptune: one looping theme per Prestige family (levels 1-10, 11-20, ... 91-99) plus ZERO at 100.
// Each theme is composed deterministically from its index: key, mode, tempo, chord progression and instrument layers.
// Higher families add layers (hats, arpeggios, kick), so the music grows with the backgrounds. Nothing to download.

import { Mulberry32 } from './core.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];

// prog: scale degree of each bar's chord (4 bars). layers grow with the family.
const THEMES = [
  { name: 'Drift', root: 60, scale: MAJOR, bpm: 96, prog: [0, 4, 5, 3], lead: 'triangle', bass: 'triangle', hat: false, arp: false, kick: false },
  { name: 'Prism', root: 62, scale: DORIAN, bpm: 104, prog: [0, 3, 6, 4], lead: 'square', bass: 'triangle', hat: false, arp: false, kick: false },
  { name: 'Lattice', root: 57, scale: MINOR, bpm: 110, prog: [0, 5, 2, 6], lead: 'square', bass: 'triangle', hat: true, arp: false, kick: false },
  { name: 'Hive', root: 55, scale: MIXOLYDIAN, bpm: 114, prog: [0, 6, 3, 0], lead: 'triangle', bass: 'square', hat: true, arp: false, kick: false },
  { name: 'Orbit', root: 64, scale: MINOR, bpm: 100, prog: [0, 3, 5, 4], lead: 'sine', bass: 'triangle', hat: true, arp: true, kick: false },
  { name: 'Starfall', root: 65, scale: LYDIAN, bpm: 120, prog: [0, 1, 4, 0], lead: 'square', bass: 'triangle', hat: true, arp: true, kick: false },
  { name: 'Tide', root: 58, scale: MAJOR, bpm: 92, prog: [0, 5, 3, 4], lead: 'triangle', bass: 'sine', hat: true, arp: true, kick: true },
  { name: 'Kaleido', root: 63, scale: MAJOR, bpm: 126, prog: [5, 3, 0, 4], lead: 'square', bass: 'triangle', hat: true, arp: true, kick: true },
  { name: 'Tesseract', root: 59, scale: MINOR, bpm: 132, prog: [0, 6, 5, 4], lead: 'sawtooth', bass: 'square', hat: true, arp: true, kick: true },
  { name: 'Nova', root: 57, scale: MAJOR, bpm: 138, prog: [0, 4, 5, 3], lead: 'square', bass: 'sawtooth', hat: true, arp: true, kick: true },
  { name: 'ZERO', root: 62, scale: HARMONIC_MINOR, bpm: 84, prog: [0, 5, 3, 4], lead: 'bell', bass: 'sine', hat: true, arp: true, kick: true },
];

const STEPS_PER_BAR = 8; // eighth notes
const BARS = 4;

/** Theme for a background level: 0 (default) and 1–10 share Drift's, 100 is ZERO. */
export function themeIndexFor(level) {
  if (level >= 100) return 10;
  if (level <= 0) return 0;
  return Math.floor((level - 1) / 10);
}

export function themeName(index) {
  return THEMES[index].name;
}

const midiAt = (t, degree, octave = 0) => {
  const len = t.scale.length;
  const oct = Math.floor(degree / len);
  return t.root + t.scale[((degree % len) + len) % len] + 12 * (oct + octave);
};

/** Deterministic 4-bar loop for a theme: one entry per eighth note. Exported for tests. */
export function composeTheme(index) {
  const t = THEMES[index];
  const rng = new Mulberry32(0x5eed + index * 977);
  const rand = () => rng.nextUint() / 4294967296;
  const steps = [];
  let prev = 0;
  for (let bar = 0; bar < BARS; bar++) {
    const chord = t.prog[bar];
    const tones = [chord, chord + 2, chord + 4];
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const strong = s % 2 === 0;
      let lead = null;
      const last = bar === BARS - 1 && s === STEPS_PER_BAR - 2;
      if (last) {
        lead = midiAt(t, 7, 1); // resolve to the tonic an octave up so the loop lands
      } else if (rand() > (strong ? 0.12 : 0.55)) {
        // Strong beats take chord tones; weak beats step through the scale from the previous note.
        const deg = strong ? tones[Math.floor(rand() * 3)] + (rand() < 0.3 ? 7 : 0) : prev + (rand() < 0.5 ? 1 : -1);
        prev = deg;
        lead = midiAt(t, deg, 1);
      }
      steps.push({
        lead,
        leadLen: strong && rand() < 0.35 ? 2 : 1,
        bass: s === 0 || s === 4 || (index >= 6 && (s === 2 || s === 6)) ? midiAt(t, chord, s === 2 || s === 6 ? 0 : -1) : null,
        arp: t.arp ? midiAt(t, tones[s % 3], 2) : null,
        hat: t.hat && s % 2 === 1,
        kick: t.kick && (s === 0 || s === 4),
      });
    }
  }
  return { name: t.name, bpm: t.bpm, lead: t.lead, bass: t.bass, steps };
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

export class Music {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = destination;
    this.theme = composeTheme(0);
    this.pending = null;
    this.step = 0;
    this.nextTime = 0;
    this.timer = 0;
    this.noise = this.makeNoise();
  }

  makeNoise() {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.2, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Switches theme at the next bar line so the change stays musical. */
  setTheme(index) {
    if (this.theme.name === THEMES[index].name && !this.pending) return;
    this.pending = composeTheme(index);
    if (!this.timer) {
      this.theme = this.pending;
      this.pending = null;
    }
  }

  start() {
    if (this.timer) return;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    // Lookahead scheduler: timers only queue notes; the audio clock plays them sample-accurately.
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  schedule() {
    const stepDur = 60 / this.theme.bpm / 2;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      if (this.step % STEPS_PER_BAR === 0 && this.pending) {
        this.theme = this.pending;
        this.pending = null;
        this.step = 0;
      }
      const s = this.theme.steps[this.step % this.theme.steps.length];
      const t = this.nextTime;
      if (s.lead !== null) this.voice(this.theme.lead, hz(s.lead), t, stepDur * s.leadLen * 0.9, 0.17);
      if (s.bass !== null) this.voice(this.theme.bass, hz(s.bass), t, stepDur * 1.6, 0.2);
      if (s.arp !== null) this.voice('triangle', hz(s.arp), t, stepDur * 0.5, 0.06);
      if (s.hat) this.hat(t);
      if (s.kick) this.kick(t);
      this.nextTime += stepDur;
      this.step++;
    }
  }

  voice(type, freq, t, dur, gain) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out);
    const oscs = [];
    if (type === 'bell') {
      // Two inharmonic sine partials make a soft bell (ZERO's gold).
      for (const [mult, amp] of [[1, 1], [2.76, 0.35]]) {
        const o = this.ctx.createOscillator();
        const og = this.ctx.createGain();
        o.frequency.value = freq * mult;
        og.gain.value = amp;
        o.connect(og).connect(g);
        oscs.push(o);
      }
    } else {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.connect(g);
      oscs.push(o);
    }
    for (const o of oscs) {
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  hat(t) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + 0.06);
  }

  kick(t) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.2);
  }
}
