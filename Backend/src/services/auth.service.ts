import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import { Prisma, type Device, type IdentityProvider, type Platform, type User } from '@prisma/client';
import { config, GameRules } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { hmacSha256Hex, randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { removeFromBoards } from './leaderboard.service.js';
import { audit } from '../lib/audit.js';
import { applyLedgerEntries, type LedgerEntry } from './wallet.service.js';

export interface AccessClaims {
  sub: string;
  /** Device row id. */
  did: string;
  /** Peppered fingerprint hash the token is bound to. */
  dfp: string;
  /** Signing session id; selects the HMAC key in Redis. */
  sid: string;
  /** COPPA minor flag: gates personalised ads, social and behavioural telemetry without a DB lookup. */
  min: boolean;
}

export interface SessionTokens {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  sessionId: string;
  /** Base64 HMAC key for request signing. Delivered once over TLS; rotates on every refresh. */
  sessionKey: string;
  /** Server epoch ms when issued — lets the client seed its clock offset immediately. */
  serverTimeMs: number;
}

export interface SessionRecord {
  key: string;
  userId: string;
  deviceId: string;
}

const APPLE_ISSUER = 'https://appleid.apple.com';
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
  cooldownDuration: 60_000,
  cacheMaxAge: 6 * 60 * 60 * 1000,
});

/** Raw client fingerprints are never persisted; only this peppered hash is. */
export function fingerprintHash(rawFingerprint: string): string {
  return hmacSha256Hex(config.DEVICE_FINGERPRINT_PEPPER, rawFingerprint);
}

function assertFingerprint(raw: string): void {
  if (!/^[a-f0-9]{64}$/.test(raw)) throw Errors.badRequest('invalid_fingerprint', 'Fingerprint must be 64 hex chars');
}

async function createSession(user: User, device: Device): Promise<SessionTokens> {
  const sessionId = randomUUID();
  const sessionKey = randomToken(32);
  const record: SessionRecord = { key: sessionKey, userId: user.id, deviceId: device.id };
  // Session outlives the access token slightly so in-flight requests at expiry still verify.
  await redis.set(RedisKeys.sessionKey(sessionId), JSON.stringify(record), 'EX', GameRules.accessTokenTtlSec + 120);

  const claims: AccessClaims = { sub: user.id, did: device.id, dfp: device.fingerprintHash, sid: sessionId, min: user.isMinor };
  const accessToken = jwt.sign(claims, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: GameRules.accessTokenTtlSec,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    jwtid: randomUUID(),
  });

  const refreshToken = randomToken(48);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      deviceId: device.id,
      tokenHash: sha256Hex(refreshToken),
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + GameRules.refreshTokenTtlSec * 1000),
    },
  });

  return {
    userId: user.id,
    accessToken,
    refreshToken,
    expiresInSec: GameRules.accessTokenTtlSec,
    sessionId,
    sessionKey,
    serverTimeMs: Date.now(),
  };
}

export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  const raw = await redis.get(RedisKeys.sessionKey(sessionId));
  return raw ? (JSON.parse(raw) as SessionRecord) : null;
}

/** Guest-first: zero-tap account on first launch, bound to the device fingerprint. */
export async function guestLogin(input: {
  deviceFingerprint: string;
  platform: Platform;
  model: string;
  isMinor: boolean;
  ip: string;
}): Promise<SessionTokens & { created: boolean }> {
  assertFingerprint(input.deviceFingerprint);
  const fpHash = fingerprintHash(input.deviceFingerprint);

  const existing = await prisma.device.findUnique({ where: { fingerprintHash: fpHash }, include: { user: true } });
  if (existing) {
    if (existing.user.status === 'BANNED') throw Errors.forbidden('account_banned', 'Account banned');
    if (existing.user.status === 'PENDING_DELETION') throw Errors.forbidden('account_deleted', 'Account scheduled for deletion');
    const device = await prisma.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
    const tokens = await createSession(existing.user, device);
    return { ...tokens, created: false };
  }

  try {
    const { user, device } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { isMinor: input.isMinor, wallet: { create: {} } } });
      const device = await tx.device.create({
        data: { userId: user.id, fingerprintHash: fpHash, platform: input.platform, model: input.model.slice(0, 128) },
      });
      await audit('auth.guest_created', { userId: user.id, ip: input.ip, metadata: { platform: input.platform } }, tx);
      return { user, device };
    });
    const tokens = await createSession(user, device);
    return { ...tokens, created: true };
  } catch (err) {
    // Two concurrent first-launch requests from the same device: the loser retries as a returning device.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return guestLogin(input);
    }
    throw err;
  }
}

/**
 * Rotating refresh tokens. Presenting an already-rotated token means it was stolen or replayed:
 * the entire token family is revoked and the event is audited as critical.
 */
export async function refreshSession(input: { refreshToken: string; deviceFingerprint: string; ip: string }): Promise<SessionTokens> {
  assertFingerprint(input.deviceFingerprint);
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256Hex(input.refreshToken) },
    include: { device: true, user: true },
  });
  if (!row) throw Errors.unauthorized('invalid_refresh_token');

  if (row.rotatedAt || row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit('auth.refresh_token_reuse', { userId: row.userId, severity: 'critical', ip: input.ip, metadata: { familyId: row.familyId } });
    throw Errors.unauthorized('refresh_token_reused');
  }
  if (row.expiresAt.getTime() < Date.now()) throw Errors.unauthorized('refresh_token_expired');
  if (!safeEqual(row.device.fingerprintHash, fingerprintHash(input.deviceFingerprint))) {
    await audit('auth.refresh_device_mismatch', { userId: row.userId, severity: 'warn', ip: input.ip });
    throw Errors.unauthorized('device_mismatch');
  }
  if (row.user.status === 'BANNED' || row.user.status === 'PENDING_DELETION') throw Errors.forbidden('account_inactive');

  // Conditional update makes rotation race-safe: only one concurrent refresh can win.
  const rotated = await prisma.refreshToken.updateMany({ where: { id: row.id, rotatedAt: null }, data: { rotatedAt: new Date() } });
  if (rotated.count === 0) throw Errors.unauthorized('refresh_token_reused');

  const tokens = await createSession(row.user, row.device);
  // Keep the new token in the same family so reuse detection spans the whole chain.
  await prisma.refreshToken.update({ where: { tokenHash: sha256Hex(tokens.refreshToken) }, data: { familyId: row.familyId } });
  await prisma.device.update({ where: { id: row.deviceId }, data: { lastSeenAt: new Date() } });
  return tokens;
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    if (typeof decoded === 'string') throw new Error('unexpected string payload');
    const { sub, did, dfp, sid, min } = decoded as jwt.JwtPayload & Partial<AccessClaims>;
    if (!sub || !did || !dfp || !sid) throw new Error('missing claims');
    return { sub, did, dfp, sid, min: min === true };
  } catch {
    throw Errors.unauthorized('invalid_access_token');
  }
}

/** Hardware binding: the token is only valid alongside the fingerprint it was issued to. */
export function assertDeviceBinding(claims: AccessClaims, rawFingerprintHeader: string | undefined): void {
  if (!rawFingerprintHeader || !/^[a-f0-9]{64}$/.test(rawFingerprintHeader)) throw Errors.unauthorized('missing_device_fingerprint');
  if (!safeEqual(claims.dfp, fingerprintHash(rawFingerprintHeader))) throw Errors.unauthorized('device_binding_mismatch');
}

// ---------------------------------------------------------------- OAuth / OIDC

/** Verifies a Sign in with Apple identity token against Apple's published JWKS. Returns Apple's stable `sub`. */
export async function verifyAppleIdentityToken(identityToken: string): Promise<string> {
  if (!config.APPLE_BUNDLE_ID) throw Errors.unavailable('apple_not_configured', 'Sign in with Apple is not configured');
  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: APPLE_ISSUER,
      audience: config.APPLE_BUNDLE_ID,
      algorithms: ['RS256'],
    });
    if (!payload.sub) throw new Error('no sub');
    return payload.sub;
  } catch {
    throw Errors.unauthorized('invalid_apple_token');
  }
}

/**
 * Google Play Games Services v2: the client obtains a one-time server auth code; the server exchanges it
 * with Google and asks the Games API who the player is. The code can't be forged without Google's cooperation.
 */
export async function verifyGooglePlayGamesAuthCode(serverAuthCode: string): Promise<string> {
  if (!config.GOOGLE_OAUTH_CLIENT_ID || !config.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw Errors.unavailable('gpgs_not_configured', 'Google Play Games is not configured');
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: serverAuthCode,
      client_id: config.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: '',
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!tokenRes.ok) throw Errors.unauthorized('invalid_gpgs_code');
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) throw Errors.unauthorized('invalid_gpgs_code');

  const playerRes = await fetch('https://games.googleapis.com/games/v1/players/me', {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!playerRes.ok) throw Errors.unauthorized('gpgs_player_lookup_failed');
  const player = (await playerRes.json()) as { playerId?: string };
  if (!player.playerId) throw Errors.unauthorized('gpgs_player_lookup_failed');
  return player.playerId;
}

/**
 * Links an external identity to the calling guest account. If the identity already belongs to another
 * account (e.g. reinstall, new phone), the guest's meta-progression is migrated into that account and a
 * fresh session for the linked account is returned — the "silent background migration" from the GDD.
 */
export async function linkIdentity(input: {
  guestUserId: string;
  deviceId: string;
  provider: IdentityProvider;
  subject: string;
  ip: string;
}): Promise<{ merged: boolean; tokens: SessionTokens | null }> {
  const owner = await prisma.identity.findUnique({ where: { provider_subject: { provider: input.provider, subject: input.subject } } });

  if (!owner) {
    await prisma.identity.create({ data: { userId: input.guestUserId, provider: input.provider, subject: input.subject } });
    await audit('auth.identity_linked', { userId: input.guestUserId, ip: input.ip, metadata: { provider: input.provider } });
    return { merged: false, tokens: null };
  }
  if (owner.userId === input.guestUserId) return { merged: false, tokens: null };

  const target = owner.userId;
  const source = input.guestUserId;

  await prisma.$transaction(
    async (tx) => {
      // Lock in a deterministic order (by user id) to avoid deadlocks with a concurrent reverse merge.
      const [first, second] = source < target ? [source, target] : [target, source];
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "wallets" WHERE "userId" IN (${first}::uuid, ${second}::uuid) ORDER BY "userId" FOR UPDATE`);
      const src = await tx.wallet.findUniqueOrThrow({ where: { userId: source } });
      const credits: LedgerEntry[] = [];
      const debits: LedgerEntry[] = [];
      const add = (currency: LedgerEntry['currency'], amount: bigint) => {
        if (amount <= 0n) return;
        const meta = { from: source, to: target };
        credits.push({ currency, amount, reason: 'ACCOUNT_MERGE', idempotencyKey: `merge:${source}:${target}:in:${currency}`, metadata: meta });
        debits.push({ currency, amount: -amount, reason: 'ACCOUNT_MERGE', idempotencyKey: `merge:${source}:${target}:out:${currency}`, metadata: meta });
      };
      add('TICKS', src.ticks);
      add('CORES', src.cores);
      add('SLOWMO_TICKETS', BigInt(src.slowMoTickets));
      add('ANCHORS', BigInt(src.anchors));

      if (debits.length > 0) {
        await applyLedgerEntries(tx, source, debits);
        await applyLedgerEntries(tx, target, credits);
      }

      const [srcUser, dstUser] = await Promise.all([
        tx.user.findUniqueOrThrow({ where: { id: source } }),
        tx.user.findUniqueOrThrow({ where: { id: target } }),
      ]);
      const best = [srcUser.bestDeltaUs, dstUser.bestDeltaUs].filter((v): v is number => v !== null);
      await tx.user.update({
        where: { id: target },
        data: {
          precisionRating: Math.max(srcUser.precisionRating, dstUser.precisionRating),
          bestDeltaUs: best.length ? Math.min(...best) : null,
        },
      });
      await tx.device.updateMany({ where: { userId: source }, data: { userId: target } });
      await tx.refreshToken.updateMany({ where: { userId: source, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.user.update({ where: { id: source }, data: { status: 'PENDING_DELETION', deletionRequestedAt: new Date() } });
      await audit('auth.account_merged', { userId: target, ip: input.ip, metadata: { from: source, provider: input.provider } }, tx);
    },
    { timeout: 15_000 },
  );

  const [user, device] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: target } }),
    prisma.device.findUniqueOrThrow({ where: { id: input.deviceId } }),
  ]);
  return { merged: true, tokens: await createSession(user, device) };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await redis.del(RedisKeys.sessionKey(sessionId));
}

/** GDPR/CCPA one-tap deletion: revoke everything now; a purge job hard-deletes after the 30-day SLA window. */
export async function requestAccountDeletion(userId: string, sessionId: string, ip: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { status: 'PENDING_DELETION', deletionRequestedAt: new Date() } });
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit('account.deletion_requested', { userId, ip }, tx);
  });
  await revokeSession(sessionId);
  await removeFromBoards(userId).catch(() => undefined); // the 6-hourly rebuild drops them anyway
}

/**
 * Neutral age gate. Either a birth year (web) or a plain minor/adult answer (Unity). The first answer is recorded
 * as given; after that both flags may only tighten, so nobody turns themselves into an adult by answering again.
 *  - isMinor (COPPA, under 13): conservative, so anyone who might still be 12 counts as a minor.
 *  - isAdult (18+): self-declared, for prize eligibility. Payouts verify age with ID anyway.
 */
export function ageFlags(birthYear: number, now = new Date()): { isMinor: boolean; isAdult: boolean } {
  const maxAge = now.getUTCFullYear() - birthYear;
  const isMinor = maxAge <= 13;
  return { isMinor, isAdult: !isMinor && maxAge >= 18 };
}

export async function submitAgeGate(
  userId: string,
  answer: { isMinor: boolean } | { birthYear: number },
  ip: string,
): Promise<{ isMinor: boolean; isAdult: boolean }> {
  const flags = 'birthYear' in answer ? ageFlags(answer.birthYear) : { isMinor: answer.isMinor, isAdult: false };
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { isMinor: true, isAdult: true, ageGateAnsweredAt: true } });
  const first = user.ageGateAnsweredAt === null;
  const isMinor = first ? flags.isMinor : user.isMinor || flags.isMinor;
  const isAdult = !isMinor && (first ? flags.isAdult : user.isAdult && flags.isAdult);
  await prisma.user.update({ where: { id: userId }, data: { isMinor, isAdult, ageGateAnsweredAt: user.ageGateAnsweredAt ?? new Date() } });
  if (first || isMinor !== user.isMinor || isAdult !== user.isAdult) {
    await audit('account.age_gate', { userId, ip, metadata: { isMinor, isAdult } });
  }
  return { isMinor, isAdult };
}
