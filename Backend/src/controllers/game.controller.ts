import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, GameRules, isProduction } from '../config.js';
import { gauntletLeaderboard, serverTime, startRun, submitRun } from '../services/antiCheat.service.js';
import { prisma } from '../lib/prisma.js';
import { Errors } from '../lib/errors.js';
import { getWallet } from '../services/wallet.service.js';
import { getPlayerStats } from '../services/stats.service.js';
import { BOARDS, REGIONS, readBoard } from '../services/leaderboard.service.js';
import { profileView, updateProfile } from '../services/profile.service.js';
import { challengeInbox } from '../services/challenge.service.js';
import { playerPrizes } from '../services/prize.service.js';
import { authOf, requireSignedAuth } from '../plugins/authenticate.js';

const StartBody = z.object({
  mode: z.enum(['RANKED', 'ZEN', 'PULSE', 'GAUNTLET', 'DUEL']),
  duelSeed: z.number().int().min(0).max(0xffffffff).optional(),
  /** Ring speed of the challenged run; same bounds as any ring schedule. */
  duelBaseMs: z.number().int().min(800).max(2500).optional(),
  /** A challenge link's run: the server checks it matches and supplies the challenger's verified score. */
  challengeRunId: z.string().uuid().optional(),
});

const ProfilePatch = z
  .object({
    region: z.enum(REGIONS as [string, ...string[]]).nullable().optional(),
    timeZone: z.string().min(1).max(64).optional(),
    rerollName: z.literal(true).optional(),
  })
  .strict();

const BoardQuery = z.object({
  board: z.enum(BOARDS).default('season'),
  region: z.enum(['GLOBAL', ...REGIONS] as [string, ...string[]]).default('GLOBAL'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const SubmitBody = z.object({
  runId: z.string().uuid(),
  tapsUs: z.array(z.number().int().min(-1).max(24 * 60 * 60 * 1_000_000)).min(1).max(GameRules.runMaxRings),
  slowMoRings: z.array(z.number().int().min(0)).max(GameRules.runMaxRings).default([]),
  resumes: z
    .array(z.object({ afterRing: z.number().int().min(0), atUs: z.number().int().min(0) }))
    .max(10)
    .default([]),
});

export async function gameController(app: FastifyInstance): Promise<void> {
  // Unauthenticated and unsigned on purpose: the client needs server time before it can sign anything.
  app.get('/v1/time', async () => serverTime());

  app.post('/v1/runs/start', { preHandler: requireSignedAuth }, async (req) => {
    const body = StartBody.parse(req.body);
    return startRun(authOf(req).sub, body.mode, body.duelSeed, body.duelBaseMs, body.challengeRunId);
  });

  app.post('/v1/runs/submit', { preHandler: requireSignedAuth }, async (req) => {
    const body = SubmitBody.parse(req.body);
    return submitRun(authOf(req).sub, body, req.ip);
  });

  app.get('/v1/wallet', { preHandler: requireSignedAuth }, async (req) => getWallet(authOf(req).sub));

  app.get('/v1/profile', { preHandler: requireSignedAuth }, async (req) => {
    const userId = authOf(req).sub;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { precisionRating: true, bestDeltaUs: true, prestige: true } });
    if (!user) throw Errors.notFound('user_not_found');
    return {
      userId,
      precisionRating: user.precisionRating,
      prestige: user.prestige,
      // -1 instead of null: Unity's JsonUtility cannot read null into a number.
      bestDeltaUs: user.bestDeltaUs ?? -1,
      wallet: await getWallet(userId),
      /** Lifetime Ranked verdicts from server-verified runs (Slow-Mo rings excluded) and the daily streak. */
      ...(await getPlayerStats(userId)),
      /** Leaderboard name, region, time zone, age-gate state. */
      player: await profileView(userId),
      // How a web client may claim an ad reward: client attestation, the dev simulator, or not at all.
      webAdRewards: config.WEB_ADS_CLIENT_ATTESTED ? 'attest' : isProduction ? 'none' : 'dev',
    };
  });

  app.patch('/v1/profile', { preHandler: requireSignedAuth }, async (req) => {
    const body = ProfilePatch.parse(req.body);
    return updateProfile(authOf(req).sub, body as Parameters<typeof updateProfile>[1], req.ip);
  });

  app.get('/v1/leaderboard', { preHandler: requireSignedAuth }, async (req) => {
    const q = BoardQuery.parse(req.query);
    return readBoard(authOf(req).sub, q.board, q.region as Parameters<typeof readBoard>[2], q.limit);
  });

  app.get('/v1/challenges', { preHandler: requireSignedAuth }, async (req) => ({ results: await challengeInbox(authOf(req).sub) }));

  app.get('/v1/prizes', { preHandler: requireSignedAuth }, async (req) => playerPrizes(authOf(req).sub));

  app.get('/v1/leaderboard/gauntlet', { preHandler: requireSignedAuth }, async (req) => gauntletLeaderboard(authOf(req).sub));
}
