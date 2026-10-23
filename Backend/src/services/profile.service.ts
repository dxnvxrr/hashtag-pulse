import type { Region } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { randomUint32 } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { moveRegion } from './leaderboard.service.js';
import { isTimeZone } from './streak.js';

// Same lists as Web/social.js (test/social.test.ts checks they match).
export const NAME_ADJECTIVES = [
  'Amber', 'Arctic', 'Bold', 'Brisk', 'Calm', 'Cobalt', 'Cosmic', 'Crimson', 'Crisp', 'Daring', 'Electric', 'Ember',
  'Frost', 'Gilded', 'Golden', 'Hollow', 'Indigo', 'Ivory', 'Jade', 'Keen', 'Lucky', 'Lunar', 'Neon', 'Nimble',
  'Onyx', 'Polar', 'Quiet', 'Rapid', 'Scarlet', 'Silent', 'Silver', 'Solar', 'Steady', 'Swift', 'Velvet', 'Vivid',
];
export const NAME_NOUNS = [
  'Arrow', 'Atlas', 'Beacon', 'Comet', 'Cipher', 'Echo', 'Falcon', 'Fox', 'Glider', 'Halo', 'Heron', 'Lynx',
  'Meteor', 'Nova', 'Orbit', 'Otter', 'Owl', 'Panther', 'Pulse', 'Quasar', 'Raven', 'Ripple', 'Rocket', 'Sparrow',
  'Spark', 'Sphinx', 'Tiger', 'Vector', 'Viper', 'Wave', 'Wolf', 'Zephyr',
];

export function makeHandle(r1: number, r2: number, r3: number): string {
  return `${NAME_ADJECTIVES[r1 % NAME_ADJECTIVES.length]} ${NAME_NOUNS[r2 % NAME_NOUNS.length]} ${1000 + (r3 % 9000)}`;
}

export const randomHandle = () => makeHandle(randomUint32(), randomUint32(), randomUint32());

/** After the first choice, a player may move region once a week, so nobody hops to a quieter board to top it. */
export const REGION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_REROLLS_PER_DAY = 20;

/** Gives the player a generated name the first time anyone asks. */
export async function ensureDisplayName(userId: string, current: string | null): Promise<string> {
  if (current) return current;
  const name = randomHandle();
  await prisma.user.updateMany({ where: { id: userId, displayName: null }, data: { displayName: name } });
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
  return u.displayName ?? name;
}

export interface ProfilePatch {
  region?: Region | null;
  timeZone?: string;
  rerollName?: boolean;
}

export async function updateProfile(userId: string, patch: ProfilePatch, ip: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { region: true, regionChangedAt: true, timeZone: true, displayName: true } });
  const data: { region?: Region | null; regionChangedAt?: Date; timeZone?: string; displayName?: string } = {};
  const now = new Date();

  if (patch.region !== undefined && patch.region !== user.region) {
    // The first pick is free; after that, once a week.
    if (user.regionChangedAt && now.getTime() - user.regionChangedAt.getTime() < REGION_COOLDOWN_MS) {
      const next = new Date(user.regionChangedAt.getTime() + REGION_COOLDOWN_MS);
      throw Errors.conflict('region_cooldown', `Region can change again after ${next.toISOString()}`);
    }
    data.region = patch.region;
    // Choosing a region for the first time (often the automatic time-zone guess) doesn't start the cooldown, so
    // a wrong guess can be corrected straight away.
    if (user.region !== null) data.regionChangedAt = now;
  }
  if (patch.timeZone !== undefined && patch.timeZone !== user.timeZone) {
    if (!isTimeZone(patch.timeZone)) throw Errors.badRequest('bad_time_zone', 'Unknown time zone');
    data.timeZone = patch.timeZone;
  }
  if (patch.rerollName) {
    const k = RedisKeys.nameRerolls(userId, now.toISOString().slice(0, 10));
    const n = await redis.incr(k);
    await redis.expire(k, 26 * 60 * 60);
    if (n > MAX_REROLLS_PER_DAY) throw Errors.conflict('reroll_limit', 'Name rerolls are limited per day');
    data.displayName = randomHandle();
  }

  if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: userId }, data });
  if (data.region !== undefined) {
    await moveRegion(userId, user.region, data.region, now);
    await audit('account.region_changed', { userId, ip, metadata: { from: user.region, to: data.region } });
  }
  return profileView(userId);
}

export async function profileView(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { displayName: true, region: true, regionChangedAt: true, timeZone: true, isMinor: true, isAdult: true, ageGateAnsweredAt: true },
  });
  const regionLockedUntil =
    u.regionChangedAt && Date.now() - u.regionChangedAt.getTime() < REGION_COOLDOWN_MS
      ? new Date(u.regionChangedAt.getTime() + REGION_COOLDOWN_MS).toISOString()
      : null;
  return {
    displayName: await ensureDisplayName(userId, u.displayName),
    region: u.region,
    regionLockedUntil,
    timeZone: u.timeZone,
    ageGateAnswered: u.ageGateAnsweredAt !== null,
  };
}
