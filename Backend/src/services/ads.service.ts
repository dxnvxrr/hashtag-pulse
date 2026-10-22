import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { config, isProduction } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { safeEqual } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { applyLedger } from './wallet.service.js';
import { grantExtraLife, todayKey } from './antiCheat.service.js';

/** The two GDD placements. Rewards are defined here, never by the client or the ad network. */
export const AdPlacements = {
  replay_ring: { cooldownSec: 30, dailyCap: 15 },
  double_ticks: { cooldownSec: 120, dailyCap: 6 },
} as const;
export type AdPlacement = keyof typeof AdPlacements;

const INTENT_TTL_MS = 5 * 60 * 1000;
const DOUBLE_TICKS_RINGS = 10;

export function isPlacement(p: string): p is AdPlacement {
  return Object.prototype.hasOwnProperty.call(AdPlacements, p);
}

/**
 * Step 1 — client asks to show an ad. Server-side cooldown + daily cap are authoritative (the client's
 * local timers are a UX courtesy). Returns a one-time grant id the client passes to the ad SDK as
 * custom data; the ad network echoes it back in the S2S callback.
 */
export async function createAdIntent(userId: string, placement: AdPlacement, runId: string | undefined) {
  const rules = AdPlacements[placement];
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } });
  if (user.status !== 'ACTIVE') throw Errors.forbidden('account_inactive');

  const cdKey = RedisKeys.adCooldown(userId, placement);
  const ok = await redis.set(cdKey, '1', 'EX', rules.cooldownSec, 'NX');
  if (ok !== 'OK') throw Errors.tooMany('ad_cooldown', 'Ad cooldown active');

  const dailyKey = RedisKeys.adDaily(userId, `${placement}:${todayKey()}`);
  const count = await redis.incr(dailyKey);
  if (count === 1) await redis.expire(dailyKey, 26 * 60 * 60);
  if (count > rules.dailyCap) throw Errors.tooMany('ad_daily_cap', 'Daily ad cap reached');

  const reward = await prisma.adReward.create({
    data: { userId, placement, expiresAt: new Date(Date.now() + INTENT_TTL_MS) },
  });
  if (runId) await redis.set(`adrun:${reward.id}`, runId, 'PX', INTENT_TTL_MS);
  return { grantId: reward.id, expiresAt: reward.expiresAt.toISOString() };
}

async function fulfil(grantId: string, networkEventId: string, ip: string): Promise<'granted' | 'duplicate' | 'expired' | 'unknown'> {
  // 1) Durable state change in Postgres: PENDING -> GRANTED exactly once.
  const decided = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "ad_rewards" WHERE "id" = ${grantId}::uuid FOR UPDATE`);
    if (rows.length === 0) return { outcome: 'unknown' as const };
    const reward = await tx.adReward.findUniqueOrThrow({ where: { id: grantId } });
    if (reward.status === 'GRANTED') return { outcome: 'duplicate' as const };
    if (reward.expiresAt.getTime() < Date.now()) {
      await tx.adReward.update({ where: { id: grantId }, data: { status: 'EXPIRED' } });
      return { outcome: 'expired' as const };
    }
    await tx.adReward.update({ where: { id: grantId }, data: { status: 'GRANTED', grantedAt: new Date(), networkEventId } });
    await audit('ads.reward_granted', { userId: reward.userId, ip, metadata: { grantId, placement: reward.placement, networkEventId } }, tx);
    return { outcome: 'granted' as const, userId: reward.userId, placement: reward.placement };
  });
  if (decided.outcome !== 'granted') return decided.outcome;

  // 2) Side effects only after the commit, so a rolled-back transaction can never leave a Redis reward behind.
  if (decided.placement === 'double_ticks') {
    await redis.multi().incrby(`boost:${decided.userId}`, DOUBLE_TICKS_RINGS).expire(`boost:${decided.userId}`, 24 * 60 * 60).exec();
  } else if (decided.placement === 'replay_ring') {
    const runId = await redis.get(`adrun:${grantId}`);
    const extended = runId ? await grantExtraLife(decided.userId, runId) : false;
    if (!extended) {
      // Run already over: compensate with a Slow-Mo Ticket so the viewer is never left with nothing. Idempotent by key.
      await applyLedger(decided.userId, [
        { currency: 'SLOWMO_TICKETS', amount: 1n, reason: 'AD_REWARD', idempotencyKey: `ad:${grantId}:SLOWMO`, metadata: { placement: decided.placement } },
      ]);
    }
  }
  return 'granted';
}

/**
 * Step 2 — LevelPlay (ironSource) server-to-server rewarded callback.
 * signature = MD5(timestamp + eventId + appUserId + rewards + privateKey).
 * `custom_grantId` is the value the client set as dynamic user id / custom param for this impression.
 */
export async function handleLevelPlayCallback(q: Record<string, string | undefined>, ip: string): Promise<string> {
  if (!config.LEVELPLAY_SSV_PRIVATE_KEY) throw Errors.unavailable('ssv_not_configured', 'Ad SSV not configured');
  const { timestamp, eventId, appUserId, rewards, signature } = q;
  const grantId = q.custom_grantId;
  if (!timestamp || !eventId || !appUserId || rewards === undefined || !signature || !grantId) {
    throw Errors.badRequest('bad_ssv', 'Missing SSV parameters');
  }
  const expected = createHash('md5').update(`${timestamp}${eventId}${appUserId}${rewards}${config.LEVELPLAY_SSV_PRIVATE_KEY}`).digest('hex');
  if (!safeEqual(expected, signature.toLowerCase())) {
    await audit('ads.ssv_bad_signature', { severity: 'critical', ip, metadata: { eventId } });
    throw Errors.unauthorized('bad_ssv_signature');
  }

  const reward = await prisma.adReward.findUnique({ where: { id: grantId }, select: { userId: true } });
  if (!reward || reward.userId !== appUserId) throw Errors.badRequest('ssv_user_mismatch', 'Grant does not belong to user');

  const outcome = await fulfil(grantId, eventId, ip);
  // LevelPlay expects "<eventId>:OK" to stop retrying; duplicates must also be acknowledged.
  if (outcome === 'granted' || outcome === 'duplicate') return `${eventId}:OK`;
  throw Errors.badRequest(`ssv_${outcome}`, `Grant ${outcome}`);
}

/** Step 3 — client polls until the S2S callback has landed. */
export async function getAdGrantStatus(userId: string, grantId: string) {
  const reward = await prisma.adReward.findUnique({ where: { id: grantId } });
  if (!reward || reward.userId !== userId) throw Errors.notFound('grant_not_found');
  return { grantId, status: reward.status, placement: reward.placement };
}

/** Web H5 ads: the client attests it showed the ad. Off unless WEB_ADS_CLIENT_ATTESTED=true; caps still apply. */
export async function attestWebAd(userId: string, grantId: string, ip: string) {
  if (!config.WEB_ADS_CLIENT_ATTESTED) throw Errors.notFound('not_found');
  const reward = await prisma.adReward.findUnique({ where: { id: grantId } });
  if (!reward || reward.userId !== userId) throw Errors.notFound('grant_not_found');
  return { outcome: await fulfil(grantId, `web-attest-${grantId}`, ip) };
}

/** Development only: simulates the S2S callback so the full loop is testable in the Unity Editor. */
export async function devCompleteAd(userId: string, grantId: string, ip: string) {
  if (isProduction) throw Errors.notFound('not_found');
  const reward = await prisma.adReward.findUnique({ where: { id: grantId } });
  if (!reward || reward.userId !== userId) throw Errors.notFound('grant_not_found');
  return { outcome: await fulfil(grantId, `dev-${grantId}`, ip) };
}
