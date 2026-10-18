import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { redis, RedisKeys } from '../lib/redis.js';
import { authOf, requireAuth } from '../plugins/authenticate.js';

/**
 * High-throughput analytics ingest.
 *
 * Redis is the buffer, not the warehouse: events go to capped Redis Streams (one per category) that a
 * downstream consumer group drains into the analytics store (BigQuery/ClickHouse/etc.). Daily counters
 * are kept alongside for live dashboards. One pipelined round trip per batch, no DB writes on the hot path.
 */

const Categories = ['ftue', 'difficulty', 'performance', 'transaction', 'ad', 'viral', 'session'] as const;
type Category = (typeof Categories)[number];

/** COPPA: for under-13 accounts only non-behavioural, operational telemetry is accepted. */
const MinorAllowed: ReadonlySet<Category> = new Set<Category>(['performance', 'session']);

const STREAM_MAXLEN = 2_000_000;
const COUNTER_TTL_SEC = 40 * 24 * 60 * 60;

const PropValue = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

const Event = z.object({
  category: z.enum(Categories),
  /** e.g. ftue: "first_tap" | "first_ring_complete"; performance: "frame_drop"; transaction: "iap_success". */
  name: z.string().regex(/^[a-z0-9_.]{1,64}$/),
  /** Client epoch ms (already offset-corrected by the client clock sync). */
  ts: z.number().int().positive(),
  sessionId: z.string().max(64).optional(),
  props: z.record(z.string().regex(/^[a-zA-Z0-9_]{1,40}$/), PropValue).refine((o) => Object.keys(o).length <= 24, 'too many props').default({}),
});

const Batch = z.object({
  appVersion: z.string().max(32),
  platform: z.enum(['IOS', 'ANDROID', 'EDITOR']),
  events: z.array(Event).min(1).max(200),
});

export async function telemetryController(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/telemetry',
    {
      preHandler: requireAuth,
      bodyLimit: 512 * 1024,
      // Clients batch (flush every ~10 s or 50 events), so a lower per-user ceiling is plenty.
      config: { rateLimit: { max: 4, timeWindow: '1 second' } },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const batch = Batch.parse(req.body);
      const receivedAt = Date.now();
      const day = new Date(receivedAt).toISOString().slice(0, 10);
      const counterKey = RedisKeys.telemetryCounter(day);

      const pipe = redis.pipeline();
      let accepted = 0;
      for (const e of batch.events) {
        if (auth.min && !MinorAllowed.has(e.category)) continue;
        pipe.xadd(
          RedisKeys.telemetryStream(e.category),
          'MAXLEN',
          '~',
          STREAM_MAXLEN,
          '*',
          'u', auth.sub,
          'n', e.name,
          'ts', String(e.ts),
          'rx', String(receivedAt),
          'v', batch.appVersion,
          'p', batch.platform,
          's', e.sessionId ?? '',
          'props', JSON.stringify(e.props),
        );
        pipe.hincrby(counterKey, `${e.category}:${e.name}`, 1);
        accepted++;
      }
      if (accepted > 0) {
        pipe.expire(counterKey, COUNTER_TTL_SEC);
        const results = await pipe.exec();
        const failed = results?.filter(([err]) => err !== null).length ?? 0;
        if (failed > 0) req.log.warn({ failed }, 'telemetry pipeline partial failure');
      }
      return reply.code(202).send({ accepted, dropped: batch.events.length - accepted });
    },
  );
}
