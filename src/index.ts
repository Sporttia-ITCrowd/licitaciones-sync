import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as dsql } from 'drizzle-orm';
import { env } from './env.js';
import { logger } from './logger.js';
import { createDb } from './db.js';
import { sync } from './sync.js';

/** Mask the password component of a postgres URL so we can log it safely. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return raw.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  }
}

/** Extract every interesting field from an error (including drizzle's wrapped cause). */
function describeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  const root = err as Error & { cause?: unknown };
  const cause =
    root.cause instanceof Error
      ? (root.cause as Error & Record<string, unknown>)
      : null;
  const dbErr = (cause ?? root) as Error & Record<string, unknown>;
  return {
    name: cause?.name ?? err.name,
    message: String(err.message ?? '')
      .split('\n')
      .slice(0, 3)
      .join(' | ')
      .slice(0, 600),
    cause_message: cause
      ? String(cause.message ?? '').slice(0, 600)
      : undefined,
    code: dbErr.code,
    severity: dbErr.severity,
    detail: typeof dbErr.detail === 'string' ? dbErr.detail.slice(0, 500) : undefined,
    hint: typeof dbErr.hint === 'string' ? dbErr.hint.slice(0, 500) : undefined,
    table: dbErr.table,
    column: dbErr.column,
    constraint: dbErr.constraint,
    routine: dbErr.routine,
    schema: dbErr.schema,
    where: typeof dbErr.where === 'string' ? dbErr.where.slice(0, 500) : undefined,
    stack: err.stack?.split('\n').slice(0, 6).join('\n'),
  };
}

async function main(): Promise<void> {
  logger.info(
    {
      tmpDir: env.TMP_DIR,
      batchSize: env.BATCH_SIZE,
      logLevel: env.LOG_LEVEL,
      runMigrations: env.RUN_MIGRATIONS,
      databaseUrl: redactUrl(env.DATABASE_URL),
    },
    'starting licitaciones-sync',
  );

  const { db, close } = createDb(env.DATABASE_URL);
  try {
    // Connection sanity check — answers: who am I? what DB? can I create schemas?
    logger.info('verifying database connection');
    const pingRows = (await db.execute(
      dsql`SELECT
        current_user::text AS current_user,
        current_database()::text AS current_database,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
        current_setting('server_version') AS server_version`,
    )) as unknown as Array<{
      current_user: string;
      current_database: string;
      can_create: boolean;
      server_version: string;
    }>;
    const ping = pingRows[0];
    logger.info(
      {
        current_user: ping?.current_user,
        current_database: ping?.current_database,
        can_create: ping?.can_create,
        server_version: ping?.server_version,
      },
      'database connection ok',
    );

    if (env.RUN_MIGRATIONS) {
      logger.info('applying drizzle migrations');
      try {
        await migrate(db, { migrationsFolder: './drizzle' });
        logger.info('migrations applied');
      } catch (err) {
        logger.error(describeError(err), 'migration failed');
        throw err;
      }
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
  logger.fatal({ err: describeError(err) }, 'fatal error');
  process.exit(1);
});
