import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableAutoPipelining: true,
  lazyConnect: true,
});

export const RedisKeys = {
  nonce: (sessionId: string, nonce: string) => `nonce:${sessionId}:${nonce}`,
  sessionKey: (sessionId: string) => `sess:${sessionId}`,
  run: (runId: string) => `run:${runId}`,
  adCooldown: (userId: string, placement: string) => `adcd:${userId}:${placement}`,
  adDaily: (userId: string, day: string) => `addaily:${userId}:${day}`,
  telemetryStream: (category: string) => `telemetry:${category}`,
  telemetryCounter: (day: string) => `telemetry:counters:${day}`,
  googleAccessToken: () => 'cache:google-play-access-token',
  leaderboard: (board: string, day: string) => `lb:${board}:${day}`,
  jobLock: (job: string) => `lock:job:${job}`,
} as const;
