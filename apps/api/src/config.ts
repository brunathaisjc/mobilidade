import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().default('postgres://mobi:mobi@localhost:5432/mobilidade'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-0123456789abcdef'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Origem do front-end (CORS e links de compartilhamento). */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  /** local: disco em STORAGE_DIR; s3: qualquer serviço compatível (AWS S3, MinIO, Cloudflare R2). */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),
  /** Planejador: URL do OpenTripPlanner 2.x; vazio = planejador interno de linhas diretas. */
  OTP_URL: z.string().optional(),
  /** Geocodificador compatível com Photon (self-hosted em produção). Vazio = só pontos de ônibus. */
  GEOCODER_URL: z.string().optional(),
  MAX_WALK_METERS: z.coerce.number().int().positive().default(800),
  TERMS_VERSION: z.string().default('2026-10'),
  REALTIME_POLL_MS: z.coerce.number().int().positive().default(5000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production' && cfg.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('JWT_SECRET precisa ser definido em produção');
  }
  return cfg;
}
