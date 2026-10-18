import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GameRules } from '../config.js';
import { serverTime, startRun, submitRun } from '../services/antiCheat.service.js';
import { getWallet } from '../services/wallet.service.js';
import { authOf, requireSignedAuth } from '../plugins/authenticate.js';

const StartBody = z.object({
  mode: z.enum(['PULSE', 'GAUNTLET', 'DUEL', 'ZEN']),
  duelSeed: z.number().int().min(0).max(0xffffffff).optional(),
});

const SubmitBody = z.object({
  runId: z.string().uuid(),
  tapsUs: z.array(z.number().int().min(-1).max(24 * 60 * 60 * 1_000_000)).min(1).max(GameRules.runMaxRings),
  slowMoRings: z.array(z.number().int().min(0)).max(GameRules.runMaxRings).default([]),
});

export async function gameController(app: FastifyInstance): Promise<void> {
  // Unauthenticated and unsigned on purpose: the client needs server time before it can sign anything.
  app.get('/v1/time', async () => serverTime());

  app.post('/v1/runs/start', { preHandler: requireSignedAuth }, async (req) => {
    const body = StartBody.parse(req.body);
    return startRun(authOf(req).sub, body.mode, body.duelSeed);
  });

  app.post('/v1/runs/submit', { preHandler: requireSignedAuth }, async (req) => {
    const body = SubmitBody.parse(req.body);
    return submitRun(authOf(req).sub, body, req.ip);
  });

  app.get('/v1/wallet', { preHandler: requireSignedAuth }, async (req) => getWallet(authOf(req).sub));
}
