import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertDeviceBinding, verifyAccessToken, type AccessClaims } from '../services/auth.service.js';
import { verifyRequestSignature } from '../services/antiCheat.service.js';
import { Errors } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessClaims | null;
    rawBody: string;
  }
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** JWT + hardware binding only. Used for endpoints that must work before a signing session exists. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authz = header(req, 'authorization');
  if (!authz?.startsWith('Bearer ')) throw Errors.unauthorized('missing_bearer');
  const claims = verifyAccessToken(authz.slice(7));
  assertDeviceBinding(claims, header(req, 'x-device-fingerprint'));
  req.auth = claims;
}

/** JWT + hardware binding + HMAC request signature + replay protection. Default for all game endpoints. */
export async function requireSignedAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  await verifyRequestSignature({
    method: req.method,
    path: req.url,
    timestampMs: header(req, 'x-timestamp'),
    nonce: header(req, 'x-nonce'),
    signature: header(req, 'x-signature'),
    sessionId: req.auth!.sid,
    rawBody: req.rawBody ?? '',
  });
}

export function authOf(req: FastifyRequest): AccessClaims {
  if (!req.auth) throw Errors.unauthorized('unauthenticated');
  return req.auth;
}
