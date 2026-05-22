import { rm, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';
import { logger as rootLogger, type Logger } from './logger.js';
import {
  acquireLock,
  markDeleted,
  markRunFailure,
  markRunStart,
  markRunSuccess,
  readSyncState,
  upsertTenders,
  type Db,
} from './db.js';
import {
  discoverPeriods,
  downloadZip,
  mapEntry,
  parseAtom,
  streamAtoms,
  type Tender,
} from './placsp.js';

export interface SyncResult {
  source: string;
  mode: 'bootstrap' | 'incremental';
  periodsProcessed: number;
  periodsSkipped: number;
  entriesUpserted: number;
  tombstones: number;
  durationMs: number;
}

const SOURCE = 'placsp';
const LOCK_NAME = 'placsp_sync';

const MONTH_NAMES_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * Turn a cursor like '202604' into a readable date label such as
 * '2026-04 (abril 2026)'. Yearly cursors like '2012' become 'año 2012'.
 */
function formatPeriod(cursor: string): string {
  if (cursor.length === 6) {
    const year = cursor.slice(0, 4);
    const month = parseInt(cursor.slice(4, 6), 10);
    const monthName = MONTH_NAMES_ES[month - 1] ?? `month-${month}`;
    return `${year}-${cursor.slice(4, 6)} (${monthName} ${year})`;
  }
  return `año ${cursor}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/**
 * Try the whole batch; if it fails, fall back to per-row inserts and log the offenders.
 * Prevents one bad record from killing an entire period.
 */
async function upsertBatchSafe(
  db: Db,
  batch: Tender[],
  log: Logger,
  period: string,
): Promise<{ inserted: number; updated: number; skipped: number; failed: number }> {
  try {
    const r = await upsertTenders(db, batch);
    log.debug(
      { period, batch: batch.length, ...r },
      'batch upserted',
    );
    return { ...r, failed: 0 };
  } catch (err) {
    const summary = describeError(err);
    log.warn(
      { period, batch: batch.length, ...summary.fields, message: summary.message },
      'batch failed, falling back to per-row inserts',
    );
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of batch) {
    try {
      const r = await upsertTenders(db, [t]);
      inserted += r.inserted;
      updated += r.updated;
      skipped += r.skipped;
    } catch (err) {
      failed++;
      const summary = describeError(err);
      log.warn(
        {
          period,
          external_id: t.external_id,
          file_number: t.file_number,
          ...summary.fields,
          message: summary.message,
        },
        'row failed, skipping',
      );
    }
  }
  return { inserted, updated, skipped, failed };
}

function describeError(err: unknown): {
  message: string;
  full: string;
  fields: Record<string, unknown>;
} {
  if (!(err instanceof Error)) {
    return { message: String(err), full: String(err), fields: {} };
  }
  // Drizzle wraps the postgres.js error in DrizzleQueryError; the DB detail
  // lives in err.cause (a postgres.js PostgresError with code/column/detail).
  const root = err as Error & { cause?: unknown };
  const cause =
    root.cause instanceof Error
      ? (root.cause as Error & Record<string, unknown>)
      : null;
  const dbErr = (cause ?? root) as Error & Record<string, unknown>;

  // Prefer the DB error's first line; fall back to drizzle wrapper.
  const dbMsg = String(dbErr.message ?? '').split('\n')[0].slice(0, 500);
  const wrapperMsg = String(err.message ?? '')
    .split('\n')[0]
    .slice(0, 200);
  return {
    message: dbMsg || wrapperMsg || err.name,
    full: err.stack ?? err.message ?? String(err),
    fields: {
      name: cause?.name ?? err.name,
      code: dbErr.code,
      severity: dbErr.severity,
      detail:
        typeof dbErr.detail === 'string' ? dbErr.detail.slice(0, 500) : undefined,
      schema: dbErr.schema,
      table: dbErr.table,
      column: dbErr.column,
      constraint: dbErr.constraint,
      routine: dbErr.routine,
      where:
        typeof dbErr.where === 'string' ? dbErr.where.slice(0, 500) : undefined,
      cause_message:
        cause && cause !== root
          ? String(cause.message ?? '')
              .split('\n')[0]
              .slice(0, 300)
          : undefined,
    },
  };
}

export async function sync(
  db: Db,
  logger: Logger = rootLogger,
): Promise<SyncResult | null> {
  const startedAt = Date.now();
  const log = logger.child({ source: SOURCE });

  const lock = await acquireLock(db, LOCK_NAME, {
    staleAfterMs: env.LOCK_STALE_AFTER_MS,
    heartbeatMs: env.LOCK_HEARTBEAT_INTERVAL_MS,
  });

  if (!lock) {
    log.warn({ lock: LOCK_NAME }, 'lock not acquired, another sync is running');
    return null;
  }
  log.info({ instanceId: lock.instanceId }, 'lock acquired');

  let periodsProcessed = 0;
  let periodsSkipped = 0;
  let entriesUpserted = 0;
  let tombstones = 0;
  let lastEntryUpdated: Date | null = null;

  try {
    const state = await readSyncState(db, SOURCE);
    await markRunStart(db, SOURCE);
    const mode: 'bootstrap' | 'incremental' = state?.lastCursor
      ? 'incremental'
      : 'bootstrap';
    const periods = discoverPeriods({
      fromCursor: state?.lastCursor ?? undefined,
    });
    log.info(
      { mode, fromCursor: state?.lastCursor ?? null, periodCount: periods.length },
      'starting sync',
    );

    await mkdir(env.TMP_DIR, { recursive: true });

    for (const period of periods) {
      const periodStart = Date.now();
      const periodLabel = formatPeriod(period.cursor);
      const zipPath = join(env.TMP_DIR, `placsp-${period.cursor}.zip`);
      log.info(
        { period: period.cursor, url: period.url, isCurrent: period.isCurrent },
        `processing period ${periodLabel}`,
      );

      let meta;
      try {
        meta = await downloadZip(period.url, zipPath, {
          userAgent: env.PLACSP_USER_AGENT,
        });
      } catch (err) {
        log.error(
          { period: period.cursor, err: String(err) },
          `download failed for ${periodLabel}, skipping period`,
        );
        periodsSkipped++;
        continue;
      }
      if (!meta) {
        log.warn(
          { period: period.cursor },
          `zip not available (304 or 404) for ${periodLabel}, skipping period`,
        );
        periodsSkipped++;
        continue;
      }
      log.info(
        {
          period: period.cursor,
          sizeBytes: meta.sizeBytes,
          lastModified: meta.lastModified,
        },
        `zip downloaded for ${periodLabel} (${formatSize(meta.sizeBytes)})`,
      );

      let buffer: Tender[] = [];
      let periodEntries = 0;
      let periodTombs = 0;
      let atomsSeen = 0;

      for await (const { name, stream } of streamAtoms(zipPath)) {
        atomsSeen++;
        log.debug(
          { period: period.cursor, atom: name },
          `parsing atom ${name} for ${periodLabel}`,
        );
        for await (const ev of parseAtom(stream)) {
          if (ev.type === 'tombstone') {
            try {
              await markDeleted(db, SOURCE, ev.ref, new Date(ev.when), ev.reason);
              tombstones++;
              periodTombs++;
            } catch (err) {
              log.warn(
                { period: period.cursor, ref: ev.ref, err: String(err) },
                `failed to mark tombstone for ${periodLabel}`,
              );
            }
          } else if (ev.type === 'entry') {
            const tender = mapEntry(ev.raw, SOURCE);
            if (!tender.external_id) continue;
            buffer.push(tender);
            if (
              !lastEntryUpdated ||
              tender.updated_at > lastEntryUpdated
            ) {
              lastEntryUpdated = tender.updated_at;
            }
            if (buffer.length >= env.BATCH_SIZE) {
              const r = await upsertBatchSafe(db, buffer, log, period.cursor);
              entriesUpserted += r.inserted + r.updated;
              periodEntries += buffer.length;
              buffer = [];
            }
          }
        }
      }
      if (buffer.length > 0) {
        const r = await upsertBatchSafe(db, buffer, log, period.cursor);
        entriesUpserted += r.inserted + r.updated;
        periodEntries += buffer.length;
        buffer = [];
      }

      try {
        await unlink(zipPath);
      } catch {
        /* tmp cleanup best-effort */
      }
      await markRunSuccess(db, SOURCE, period.cursor, lastEntryUpdated);
      periodsProcessed++;
      log.info(
        {
          period: period.cursor,
          atomsParsed: atomsSeen,
          entries: periodEntries,
          tombstones: periodTombs,
          durationMs: Date.now() - periodStart,
        },
        `period ${periodLabel} completed (${periodEntries} entries, ${periodTombs} tombstones, ${((Date.now() - periodStart) / 1000).toFixed(1)}s)`,
      );
    }

    const result: SyncResult = {
      source: SOURCE,
      mode,
      periodsProcessed,
      periodsSkipped,
      entriesUpserted,
      tombstones,
      durationMs: Date.now() - startedAt,
    };
    log.info(result, 'sync completed');
    return result;
  } catch (err) {
    const summary = describeError(err);
    await markRunFailure(db, SOURCE, summary.full.slice(0, 4000)).catch(() => {
      /* ignore — we already failed */
    });
    log.error(summary.fields, summary.message);
    throw err;
  } finally {
    await lock.release().catch(() => {
      /* swallow */
    });
    // Best-effort tmp cleanup of partial files
    try {
      await rm(env.TMP_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
