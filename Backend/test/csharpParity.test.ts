import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
process.env.DEVICE_FINGERPRINT_PEPPER ??= 'test-pepper-test-pepper';

const { evaluateRun } = await import('../src/services/antiCheat.service.ts');

const hasMono = spawnSync('mcs', ['--version']).status === 0 && spawnSync('mono', ['--version']).status === 0;
const client = resolve(import.meta.dirname, '../../Client');

test('Unity RunSession produces runs the server scores identically', { skip: !hasMono && 'mcs/mono not installed' }, () => {
  const out = join(mkdtempSync(join(tmpdir(), 'omt-')), 'parity.exe');
  execFileSync('mcs', [
    '-langversion:7.2', '-nologo', `-out:${out}`,
    join(client, 'Tests/Parity/RunSessionParity.cs'),
    join(client, 'Assets/Scripts/Core/RingSchedule.cs'),
    join(client, 'Assets/Scripts/Core/RunSession.cs'),
  ]);
  const run = JSON.parse(execFileSync('mono', [out], { encoding: 'utf8' }));
  const ev = evaluateRun({
    seed: 424242, baseDurationMs: 2000, ftue: true, maxMisses: 3 + run.resumes.length, maxRings: 500,
    tapsUs: run.tapsUs, slowMoRings: run.slowMoRings, resumes: run.resumes, maxResumes: run.resumes.length,
  });
  assert.equal(ev.valid, true, ev.rejectReason);
  assert.deepEqual(ev.verdicts, run.verdicts);
});
