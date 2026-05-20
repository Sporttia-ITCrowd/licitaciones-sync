import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CLOUDSQL_INSTANCE: z.string().optional(),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  PLACSP_USER_AGENT: z
    .string()
    .default('sporttia-licitaciones-sync/1.0 (rruano@sporttia.com)'),
  TMP_DIR: z.string().default('./tmp/placsp'),
  BATCH_SIZE: z.coerce.number().int().positive().default(500),
  LOCK_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  LOCK_STALE_AFTER_MS: z.coerce.number().int().positive().default(30 * 60_000),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  RUN_MIGRATIONS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}

export const env = loadEnv();
