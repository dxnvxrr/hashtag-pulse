import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config, isProduction } from './config.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { AppError } from './lib/errors.js';
import { verifyAccessToken } from './services/auth.service.js';
import { authController } from './controllers/auth.controller.js';
import { gameController } from './controllers/game.controller.js';
import { iapController } from './controllers/iap.controller.js';
import { adsController } from './controllers/ads.controller.js';
import { telemetryController } from './controllers/telemetry.controller.js';
import { webController } from './controllers/web.controller.js';
import { startJobs } from './jobs/maintenance.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-signature"]', 'req.headers["x-device-fingerprint"]'],
      ...(isProduction ? {} : { transport: { target: 'pino-pretty' } }),
    },
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? (_addr: string, hop: number) => hop < config.TRUST_PROXY_HOPS : false,
    bodyLimit: 64 * 1024,
    disableRequestLogging: isProduction,
    requestIdHeader: 'x-request-id',
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('rawBody', '');

  // Keep the exact bytes the client signed; HMAC verification must run over the raw body, not re-serialised JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = text;
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, 'invalid_json', 'Body is not valid JSON'), undefined);
    }
  });

  // ---------------------------------------------------------------- Security headers
  await app.register(helmet, {
    // JSON API: no HTML is served, so the strictest CSP costs nothing.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // ---------------------------------------------------------------- CORS origin locking
  // Native mobile clients send no Origin header and are unaffected; browsers are limited to the allow-list.
  const allowed = new Set(config.CORS_ORIGINS);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, allowed.has(origin));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'authorization', 'x-device-fingerprint', 'x-timestamp', 'x-nonce', 'x-signature', 'idempotency-key'],
    credentials: false,
    maxAge: 600,
  });

  // ---------------------------------------------------------------- Rate limiting (10 req/s)
  // Authenticated traffic is keyed by verified user id: mobile carriers put thousands of players behind one
  // CGNAT IP, so a pure per-IP key would throttle innocent players. Unauthenticated traffic is keyed by IP.
  await app.register(rateLimit, {
    global: true,
    max: 10,
    timeWindow: 1000,
    redis,
    nameSpace: 'rl:',
    skipOnError: true,
    keyGenerator: (req) => {
      const authz = req.headers.authorization;
      if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
        try {
          return `u:${verifyAccessToken(authz.slice(7)).sub}`;
        } catch {
          // Invalid token falls through to IP keying; the route itself will reject it.
        }
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
    }),
  });

  // ---------------------------------------------------------------- Errors
  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'app error');
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 429) return reply.code(429).send(err);
    if (status < 500) return reply.code(status).send({ error: (err as FastifyError).code ?? 'bad_request', message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // ---------------------------------------------------------------- Health
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ---------------------------------------------------------------- Routes
  await app.register(authController);
  await app.register(gameController);
  await app.register(iapController);
  await app.register(adsController);
  await app.register(telemetryController);
  await app.register(webController);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  const stopJobs = config.RUN_JOBS ? startJobs(app.log) : () => undefined;

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      stopJobs();
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
