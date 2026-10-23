import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
const { statCounts } = await import('../src/services/stats.service.js');

test('lifetime stats count Ranked verdicts but never Slow-Mo rings', () => {
  const rings = [
    { verdict: 'PERFECT', deltaUs: 1000, slow: false },
    { verdict: 'PERFECT', deltaUs: 900, slow: true },
    { verdict: 'CLEAN', deltaUs: 9000, slow: false },
    { verdict: 'CLOSE', deltaUs: 30000, slow: false },
    { verdict: 'CLOSE', deltaUs: 31000, slow: true },
    { verdict: 'MISS', deltaUs: null, slow: false },
  ] as const;
  assert.deepEqual(statCounts([...rings]), { perfects: 1, cleans: 1, closes: 1 });
});
