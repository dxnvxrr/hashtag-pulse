import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(40);
process.env.DEVICE_FINGERPRINT_PEPPER ??= 'y'.repeat(20);
const { verifyAdMobQuery } = await import('../src/services/ads.service.js');

// Same scheme as AdMob SSV: ECDSA P-256 / SHA-256 over everything before "&signature=", web-safe base64.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keys = new Map([['3335741209', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]);
const signed = (content: string, keyId = '3335741209') => {
  const sig = sign('sha256', Buffer.from(content), { key: privateKey, dsaEncoding: 'der' }).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${content}&signature=${sig}&key_id=${keyId}`;
};
const content =
  'ad_network=5450213213286189855&ad_unit=1234567890&custom_data=0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab&reward_amount=1&reward_item=lives&timestamp=1792800000000&transaction_id=abc123&user_id=11111111-2222-4333-8444-555555555555';

test('AdMob SSV: a correctly signed callback verifies and yields its parameters', () => {
  const p = verifyAdMobQuery(signed(content), keys);
  assert.equal(p.get('custom_data'), '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab');
  assert.equal(p.get('user_id'), '11111111-2222-4333-8444-555555555555');
});

test('AdMob SSV: tampering, unknown keys and missing signatures are refused', () => {
  const good = signed(content);
  assert.throws(() => verifyAdMobQuery(good.replace('reward_amount=1', 'reward_amount=9'), keys));
  assert.throws(() => verifyAdMobQuery(good.replace('user_id=1111', 'user_id=9999'), keys));
  assert.throws(() => verifyAdMobQuery(signed(content, '999'), keys));
  assert.throws(() => verifyAdMobQuery(content, keys));
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forged = `${content}&signature=${sign('sha256', Buffer.from(content), { key: other.privateKey, dsaEncoding: 'der' }).toString('base64')}&key_id=3335741209`;
  assert.throws(() => verifyAdMobQuery(forged, keys));
});
