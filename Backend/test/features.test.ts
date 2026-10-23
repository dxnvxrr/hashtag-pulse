import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS modules shared with the browser client
const progress = await import('../../Web/progress.js');
// @ts-expect-error — plain JS module shared with the browser client
const core = await import('../../Web/core.js');
// @ts-expect-error — plain JS module shared with the browser client
const music = await import('../../Web/music.js');

test('daily streak: continues, resets, and same-day plays count once', () => {
  let r = progress.recordPlay(progress.emptyStreak(), '2026-10-01');
  assert.equal(r.event, 'first');
  assert.equal(r.state.streak, 1);
  r = progress.recordPlay(r.state, '2026-10-01');
  assert.equal(r.event, 'same-day');
  assert.equal(r.state.streak, 1);
  r = progress.recordPlay(r.state, '2026-10-02');
  assert.equal(r.event, 'continued');
  assert.equal(r.state.streak, 2);
  r = progress.recordPlay(r.state, '2026-10-05');
  assert.equal(r.event, 'reset', 'two missed days with no Anchors');
  assert.equal(r.state.streak, 1);
  assert.equal(r.state.best, 2);
});

test('daily streak: every 7th day earns an Anchor (max 2); Anchors bridge missed days', () => {
  let s = progress.emptyStreak();
  let earned = 0;
  for (let d = 1; d <= 21; d++) {
    const r = progress.recordPlay(s, `2026-03-${String(d).padStart(2, '0')}`);
    s = r.state;
    if (r.anchorEarned) earned++;
  }
  assert.equal(s.streak, 21);
  assert.equal(earned, 2, 'days 7 and 14 earn; day 21 is capped at 2');
  assert.equal(s.anchors, 2);
  // Miss 2 days (22nd, 23rd), play on the 24th: both Anchors spent, streak continues.
  assert.equal(progress.streakStatus(s, '2026-03-24'), 'anchored');
  const r = progress.recordPlay(s, '2026-03-24');
  assert.equal(r.event, 'anchored');
  assert.equal(r.anchorsUsed, 2);
  assert.equal(r.state.streak, 22);
  assert.equal(r.state.anchors, 0);
  assert.equal(progress.streakStatus(r.state, '2026-03-25'), 'due');
  assert.equal(progress.streakStatus(r.state, '2026-03-27'), 'lost');
});

test('daily streak: day math crosses months, years and DST', () => {
  assert.equal(progress.daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(progress.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(progress.daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(progress.dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('challenge codes round-trip and reject garbage', () => {
  const c = { seed: 4294967295, base: 1900, block: 3, hits: 42, avgUs: 11250, runId: null };
  const code = progress.encodeChallenge(c);
  assert.match(code, /^[A-Za-z0-9-]+$/);
  assert.deepEqual(progress.decodeChallenge(`#${code}`), c);
  assert.deepEqual(progress.decodeChallenge(`#${code}-debug`), c, 'a trailing tag is ignored');
  // With the verified run id (dashes stripped in the link, restored on decode).
  const v = { ...c, runId: '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab' };
  const vcode = progress.encodeChallenge(v);
  assert.equal(vcode, `${code}-0f8b2c4e1a2b4c3d9e8f0123456789ab`);
  assert.deepEqual(progress.decodeChallenge(`#${vcode}-debug`), v);
  for (const bad of ['', '#debug', '#c-1-2-3', '#c-99999999999-1900-0-1-1', '#c-1-700-0-1-1', '#c-1-1900-11-1-1', '#c-x-1900-0-1-1']) {
    assert.equal(progress.decodeChallenge(bad), null, bad);
  }
  assert.equal(progress.compareChallenge({ hits: 10, avgUs: 9000 }, { hits: 9, avgUs: 1000 }), 'win');
  assert.equal(progress.compareChallenge({ hits: 9, avgUs: 9000 }, { hits: 9, avgUs: 8000 }), 'lose');
  assert.equal(progress.compareChallenge({ hits: 9, avgUs: 8000 }, { hits: 9, avgUs: 8000 }), 'tie');
});

test('ring looks: deterministic, unlocked by Prestige block, never change the close moment', () => {
  assert.deepEqual([0, 9, 10, 25, 30, 100].map(core.looksUnlocked), [0, 0, 1, 2, 3, 3]);
  const seq = (unlocked: number) => Array.from({ length: 300 }, (_, i) => core.ringLook(777, i, 0, unlocked));
  assert.deepEqual(seq(3), seq(3), 'same seed, same looks (challenge links show the same rings)');
  assert.ok(seq(0).every((l: string) => l === 'standard'));
  assert.ok(seq(1).every((l: string) => l === 'standard' || l === 'ghost'));
  assert.ok(seq(3).slice(0, 5).every((l: string) => l === 'standard'), 'first five rings stay plain');
  const share = seq(3).filter((l: string) => l !== 'standard').length / 300;
  assert.ok(share > 0.15 && share < 0.35, `about a quarter are special (${share})`);
  assert.equal(core.ringLook(777, 7, 1, 3), 'drifter');
  for (const look of ['standard', 'drifter', 'ghost', 'stutter', 'eclipse']) {
    assert.equal(core.lookProgress(look, 0), 0, `${look} starts at full size`);
    assert.equal(core.lookProgress(look, 1), 1, `${look} is on the target exactly at the close`);
    assert.equal(core.lookAlpha(look, 0.95), 1, `${look} is fully visible near the close`);
  }
  assert.equal(core.lookProgress('eclipse', 0.45), 1, 'eclipse decoy touches the target early');
  assert.ok(core.lookProgress('eclipse', 0.7) < 0.6, 'then opens back up');
});

test('music intensity follows the streak', () => {
  assert.deepEqual([0, 4, 5, 9, 10, 19, 20, 99].map(music.intensityForStreak), [0, 0, 1, 1, 2, 2, 3, 3]);
  const t = music.composeTheme(0);
  assert.ok(t.steps.every((s: { arp: number }) => typeof s.arp === 'number'), 'every theme can add an arpeggio');
  assert.deepEqual(t.base, { hat: false, arp: false, kick: false }, 'Drift starts bare; layers come from the streak');
});
