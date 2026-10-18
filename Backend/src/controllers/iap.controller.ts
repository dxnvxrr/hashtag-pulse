import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateAndGrant } from '../services/iap.service.js';
import { authOf, requireSignedAuth } from '../plugins/authenticate.js';

const ValidateBody = z.object({
  productId: z.string().min(1).max(128),
  receipt: z.string().min(10).max(200_000),
});

export async function iapController(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/iap/validate',
    { preHandler: requireSignedAuth, bodyLimit: 256 * 1024 },
    async (req) => {
      const body = ValidateBody.parse(req.body);
      return validateAndGrant(authOf(req).sub, body, req.ip);
    },
  );
}
