import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAdIntent, devCompleteAd, getAdGrantStatus, handleLevelPlayCallback, isPlacement } from '../services/ads.service.js';
import { authOf, requireSignedAuth } from '../plugins/authenticate.js';
import { Errors } from '../lib/errors.js';
import { isProduction } from '../config.js';

const IntentBody = z.object({
  placement: z.string().refine(isPlacement, 'unknown placement'),
  // Unity's JsonUtility serialises null strings as "", so treat empty as absent.
  runId: z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().optional()),
});

export async function adsController(app: FastifyInstance): Promise<void> {
  app.post('/v1/ads/intent', { preHandler: requireSignedAuth }, async (req) => {
    const body = IntentBody.parse(req.body);
    if (!isPlacement(body.placement)) throw Errors.badRequest('bad_placement', 'Unknown placement');
    return createAdIntent(authOf(req).sub, body.placement, body.runId);
  });

  app.get<{ Params: { grantId: string } }>('/v1/ads/grant/:grantId', { preHandler: requireSignedAuth }, async (req) => {
    const grantId = z.string().uuid().parse(req.params.grantId);
    return getAdGrantStatus(authOf(req).sub, grantId);
  });

  // Called by the ad network's servers, not the game client: authenticated by the callback signature.
  app.get('/v1/ads/ssv/levelplay', { config: { rateLimit: { max: 200, timeWindow: '1 second' } } }, async (req, reply) => {
    const ack = await handleLevelPlayCallback(req.query as Record<string, string | undefined>, req.ip);
    return reply.type('text/plain').send(ack);
  });

  if (!isProduction) {
    app.post<{ Params: { grantId: string } }>('/v1/ads/dev-complete/:grantId', { preHandler: requireSignedAuth }, async (req) => {
      const grantId = z.string().uuid().parse(req.params.grantId);
      return devCompleteAd(authOf(req).sub, grantId, req.ip);
    });
  }
}
