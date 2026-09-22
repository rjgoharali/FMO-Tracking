import { z } from 'zod';
import { config } from 'dotenv';
import { resolve } from 'node:path';

export function loadEnv() {
  config({ path: resolve('.env'), quiet: true });
}
export function parseEnv(env: NodeJS.ProcessEnv) {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().url().refine(s => /^postgres(ql)?:/.test(s)),
    JWT_SECRET: z.string().min(32).refine(s => !/replace|example|changeme/i.test(s), 'Generate a random JWT secret'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(30).default(15),
    SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().min(1).default('./uploads'),
    STORAGE_ENDPOINT: z.union([z.url(), z.literal('')]).optional(),
    STORAGE_REGION: z.string().default('us-east-1'),
    STORAGE_BUCKET: z.string().optional(),
    STORAGE_ACCESS_KEY: z.string().optional(), STORAGE_SECRET_KEY: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform(s => s === 'true'),
  });
  const parsed = schema.parse(env);
  if (parsed.STORAGE_PROVIDER === 's3' && !parsed.STORAGE_BUCKET) throw new Error('STORAGE_BUCKET is required for S3');
  if (Boolean(parsed.STORAGE_ACCESS_KEY) !== Boolean(parsed.STORAGE_SECRET_KEY)) throw new Error('Supply both storage credential fields or use IAM credentials');
  if (parsed.NODE_ENV === 'production' && parsed.STORAGE_ENDPOINT && !parsed.STORAGE_ENDPOINT.startsWith('https://')) throw new Error('Production object storage requires HTTPS');
  const origins = parsed.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('CORS entries must be exact HTTP origins');
    if (parsed.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production CORS origins require HTTPS');
  }
  if (!origins.length) throw new Error('At least one CORS origin is required');
  return { ...parsed, origins };
}
