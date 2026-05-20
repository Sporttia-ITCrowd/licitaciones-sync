import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { env } from './env.js';
import { logger } from './logger.js';
import { createDb } from './db.js';
import { sync } from './sync.js';

async function main(): Promise<void> {
  logger.info(
    {
      tmpDir: env.TMP_DIR,
      batchSize: env.BATCH_SIZE,
      logLevel: env.LOG_LEVEL,
      runMigrations: env.RUN_MIGRATIONS,
    },
    'starting licitaciones-sync',
  );

  const { db, close } = createDb(env.DATABASE_URL);
  try {
    if (env.RUN_MIGRATIONS) {
      logger.info('applying drizzle migrations');
      await migrate(db, { migrationsFolder: './drizzle' });
      logger.info('migrations applied');
    }

    const result = await sync(db, logger);
    if (!result) {
      logger.info('sync skipped (lock held by another instance)');
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  logger.fatal({ err: message }, 'fatal error');
  process.exit(1);
});
