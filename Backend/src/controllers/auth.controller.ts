import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  guestLogin,
  linkIdentity,
  refreshSession,
  requestAccountDeletion,
  submitAgeGate,
  verifyAppleIdentityToken,
  verifyGooglePlayGamesAuthCode,
} from '../services/auth.service.js';
import { authOf, requireSignedAuth } from '../plugins/authenticate.js';

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

const GuestBody = z.object({
  deviceFingerprint: Fingerprint,
  platform: z.enum(['IOS', 'ANDROID', 'EDITOR', 'WEB']),
  model: z.string().min(1).max(128),
  isMinor: z.boolean().default(false),
});

const RefreshBody = z.object({
  refreshToken: z.string().min(32).max(256),
  deviceFingerprint: Fingerprint,
});

const LinkBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('APPLE'), identityToken: z.string().min(20).max(4096) }),
  z.object({ provider: z.literal('GOOGLE_PLAY_GAMES'), serverAuthCode: z.string().min(10).max(1024) }),
]);

export async function authController(app: FastifyInstance): Promise<void> {
  // These run before the player has a token, so they're limited per IP, and mobile carriers put thousands of players
  // behind one IP. New accounts stay tight-ish (the account-farming vector; prize payouts also verify real people).
  // Refresh runs on every launch and its token is 256 random bits, so a generous limit costs no security.
  const guestLimit = { config: { rateLimit: { max: 30, timeWindow: '10 seconds' } } };
  const refreshLimit = { config: { rateLimit: { max: 200, timeWindow: '10 seconds' } } };
  // Linking is per signed-in user (keyed by user id), so the strict limit stays.
  const authLimit = { config: { rateLimit: { max: 5, timeWindow: '10 seconds' } } };

  app.post('/v1/auth/guest', guestLimit, async (req) => {
    const body = GuestBody.parse(req.body);
    return guestLogin({ ...body, ip: req.ip });
  });

  app.post('/v1/auth/refresh', refreshLimit, async (req) => {
    const body = RefreshBody.parse(req.body);
    return refreshSession({ ...body, ip: req.ip });
  });

  app.post('/v1/auth/link', { ...authLimit, preHandler: requireSignedAuth }, async (req) => {
    const auth = authOf(req);
    const body = LinkBody.parse(req.body);
    const subject =
      body.provider === 'APPLE'
        ? await verifyAppleIdentityToken(body.identityToken)
        : await verifyGooglePlayGamesAuthCode(body.serverAuthCode);
    return linkIdentity({ guestUserId: auth.sub, deviceId: auth.did, provider: body.provider, subject, ip: req.ip });
  });

  // Returns the effective flag; the client then refreshes so new access tokens carry it.
  app.post('/v1/account/age-gate', { preHandler: requireSignedAuth }, async (req) => {
    const body = z
      .union([z.object({ birthYear: z.number().int().min(1900).max(new Date().getUTCFullYear()) }), z.object({ isMinor: z.boolean() })])
      .parse(req.body);
    return submitAgeGate(authOf(req).sub, body, req.ip);
  });

  app.post('/v1/account/delete', { preHandler: requireSignedAuth }, async (req, reply) => {
    const auth = authOf(req);
    await requestAccountDeletion(auth.sub, auth.sid, req.ip);
    return reply.code(202).send({ status: 'scheduled', purgeWithinDays: 30 });
  });
}
