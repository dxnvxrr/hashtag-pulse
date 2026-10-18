import { z } from 'zod';

const pem = z
  .string()
  .default('')
  .transform((v) => v.replace(/\\n/g, '\n'));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Set to the number of trusted proxy hops (e.g. 1 behind a load balancer) so req.ip is the real client. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().default('https://api.onemoretap.game'),
  JWT_AUDIENCE: z.string().default('onemoretap-client'),
  DEVICE_FINGERPRINT_PEPPER: z.string().min(16),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),

  APPLE_BUNDLE_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(''),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(''),

  APPSTORE_ISSUER_ID: z.string().default(''),
  APPSTORE_KEY_ID: z.string().default(''),
  APPSTORE_PRIVATE_KEY: pem,
  APPSTORE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),

  GOOGLE_PLAY_PACKAGE_NAME: z.string().default(''),
  GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
  GOOGLE_PLAY_SERVICE_ACCOUNT_KEY: pem,

  LEVELPLAY_SSV_PRIVATE_KEY: z.string().default(''),
});

export type AppConfig = z.infer<typeof EnvSchema>;

function load(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();
export const isProduction = config.NODE_ENV === 'production';

/** Tunables shared by the game services. Kept in code so they are versioned with the rules that use them. */
export const GameRules = {
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 30 * 24 * 60 * 60,
  /** Max |client clock - server clock| tolerated on a signed request. */
  signatureMaxSkewMs: 30_000,
  /** Nonce memory; must be >= 2 * signatureMaxSkewMs. */
  nonceTtlSec: 120,

  verdict: { perfectMs: 5, cleanMs: 15, closeMs: 40 },
  /** Tap within this long after a ring spawns is inhuman (GDD: human floor ≈ 80 ms). */
  humanReactionFloorMs: 80,
  /** Standard deviation of tap deltas below this across >= botMinSamples taps flags a bot. */
  botStdDevFloorMs: 2,
  botMinSamples: 50,
  /** Allowed drift between client-reported run length and server wall clock, as a ratio + fixed slack. */
  speedHackDriftRatio: 0.03,
  speedHackSlackMs: 1_500,
  /** Lead time between run creation and ring 0 spawn, so the client can render it. */
  runLeadInMs: 1_500,
  runMaxRings: 500,
  runTtlSec: 60 * 60,
  maxMisses: 3,

  ticksPerPerfect: 5,
  ticksPerClean: 2,
  ticksPerClose: 1,
  maxTicksPerRun: 1_000,
} as const;
