import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenders = pgTable(
  'tenders',
  {
    source: varchar('source', { length: 32 }).notNull(),
    id: text('id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),

    fileNumber: text('file_number'),
    statusCode: varchar('status_code', { length: 16 }),

    authorityName: text('authority_name'),
    authorityTaxId: varchar('authority_tax_id', { length: 32 }),
    authorityDir3: varchar('authority_dir3', { length: 32 }),
    authorityPlatformId: text('authority_platform_id'),
    authorityCity: text('authority_city'),
    authorityPostalCode: varchar('authority_postal_code', { length: 16 }),
    authorityEmail: text('authority_email'),
    authorityProfileUrl: text('authority_profile_url'),
    authorityHierarchy: text('authority_hierarchy'),

    title: text('title'),
    subject: text('subject'),
    summary: text('summary'),
    contractTypeCode: varchar('contract_type_code', { length: 8 }),
    subtypeCode: varchar('subtype_code', { length: 16 }),
    mainCpv: varchar('main_cpv', { length: 16 }),
    cpvs: text('cpvs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    locationNuts: varchar('location_nuts', { length: 16 }),
    locationName: text('location_name'),
    locationCity: text('location_city'),
    locationPostalCode: varchar('location_postal_code', { length: 16 }),
    durationValue: integer('duration_value'),
    durationUnit: varchar('duration_unit', { length: 8 }),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),

    estimatedValue: numeric('estimated_value', { precision: 18, scale: 2 }),
    budgetWithoutTax: numeric('budget_without_tax', { precision: 18, scale: 2 }),
    budgetWithTax: numeric('budget_with_tax', { precision: 18, scale: 2 }),
    currency: varchar('currency', { length: 3 }).default('EUR'),

    procedureCode: varchar('procedure_code', { length: 8 }),
    urgencyCode: varchar('urgency_code', { length: 8 }),
    contractingSystemCode: varchar('contracting_system_code', { length: 8 }),
    submissionMethodCode: varchar('submission_method_code', { length: 8 }),
    submissionDeadline: timestamp('submission_deadline', { withTimezone: true }),
    documentationDeadline: date('documentation_deadline'),
    publicationDate: date('publication_date'),

    awardDate: date('award_date'),
    awardAmountWithoutTax: numeric('award_amount_without_tax', { precision: 18, scale: 2 }),
    awardAmountWithTax: numeric('award_amount_with_tax', { precision: 18, scale: 2 }),
    awardeeName: text('awardee_name'),
    awardeeTaxId: varchar('awardee_tax_id', { length: 32 }),
    tenderCount: integer('tender_count'),
    awardeeIsSme: boolean('awardee_is_sme'),
    resultCode: varchar('result_code', { length: 8 }),

    detailUrl: text('detail_url'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: varchar('deleted_reason', { length: 16 }),

    lots: jsonb('lots')
      .notNull()
      .default(sql`'[]'::jsonb`),
    results: jsonb('results')
      .notNull()
      .default(sql`'[]'::jsonb`),
    documents: jsonb('documents')
      .notNull()
      .default(sql`'[]'::jsonb`),
    rawPayload: jsonb('raw_payload').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.id] }),
    index('tenders_updated_idx').on(t.updatedAt.desc()),
    index('tenders_status_idx').on(t.statusCode),
    index('tenders_authority_tax_idx').on(t.authorityTaxId),
    index('tenders_awardee_tax_idx').on(t.awardeeTaxId),
    index('tenders_main_cpv_idx').on(t.mainCpv),
    index('tenders_cpvs_gin').using('gin', t.cpvs),
    index('tenders_publication_idx').on(t.publicationDate.desc()),
    index('tenders_source_idx').on(t.source),
  ],
);

export const syncState = pgTable('sync_state', {
  source: varchar('source', { length: 32 }).primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastCursor: varchar('last_cursor', { length: 16 }),
  lastEntryUpdated: timestamp('last_entry_updated', { withTimezone: true }),
  lastError: text('last_error'),
});

export const syncLocks = pgTable('sync_locks', {
  name: varchar('name', { length: 64 }).primaryKey(),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull(),
  heartbeat: timestamp('heartbeat', { withTimezone: true }).notNull(),
  instanceId: text('instance_id').notNull(),
});

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Tender } from './placsp.js';

export type Db = ReturnType<typeof drizzle>;

/**
 * Build a Drizzle DB client from a connection URL.
 * Two URL shapes are supported:
 *  - TCP:  `postgres://user:pass@host:port/dbname`
 *  - Cloud SQL Unix socket: `postgres://user:pass@HOST/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE`
 *
 * When the `?host=/...` query parameter is present, `postgres.js` (unlike libpq)
 * does NOT use it for the connection — it would still try the URL hostname and
 * fail with ECONNREFUSED 127.0.0.1:5432 inside Cloud Run. We detect that case
 * and pass the socket path as the explicit `host` option.
 */
export function createDb(databaseUrl: string): { db: Db; close(): Promise<void> } {
  const baseOptions = { max: 5, prepare: false };
  let sqlClient: ReturnType<typeof postgres>;

  let parsed: URL | null = null;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    parsed = null;
  }
  const socketHost = parsed?.searchParams.get('host');
  if (parsed && socketHost && socketHost.startsWith('/')) {
    sqlClient = postgres({
      ...baseOptions,
      host: socketHost,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, '') || undefined,
    });
  } else {
    sqlClient = postgres(databaseUrl, baseOptions);
  }

  const db = drizzle(sqlClient);
  return {
    db,
    close: async () => {
      await sqlClient.end({ timeout: 5 });
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// upsertTenders — INSERT with ON CONFLICT, only update when newer
// ────────────────────────────────────────────────────────────────────
function num(n: number | null): string | null {
  return n === null ? null : String(n);
}

export async function upsertTenders(
  db: Db,
  batch: Tender[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (batch.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  // PLACSP feeds can contain the same (source, id) several times within the same
  // batch (multiple state transitions: PUB → ADJ → RES). Postgres' ON CONFLICT
  // refuses to update the same row twice in a single statement ("cannot affect
  // row a second time"), so we keep only the latest entry per key.
  const deduped = new Map<string, Tender>();
  for (const t of batch) {
    const key = `${t.source}\x00${t.id}`;
    const prev = deduped.get(key);
    if (!prev || t.updated_at >= prev.updated_at) deduped.set(key, t);
  }
  const dedupedBatch = Array.from(deduped.values());

  const rows = dedupedBatch.map((t) => ({
    source: t.source,
    id: t.id,
    updatedAt: t.updated_at,
    fileNumber: t.file_number,
    statusCode: t.status_code,
    authorityName: t.authority_name,
    authorityTaxId: t.authority_tax_id,
    authorityDir3: t.authority_dir3,
    authorityPlatformId: t.authority_platform_id,
    authorityCity: t.authority_city,
    authorityPostalCode: t.authority_postal_code,
    authorityEmail: t.authority_email,
    authorityProfileUrl: t.authority_profile_url,
    authorityHierarchy: t.authority_hierarchy,
    title: t.title,
    subject: t.subject,
    summary: t.summary,
    contractTypeCode: t.contract_type_code,
    subtypeCode: t.subtype_code,
    mainCpv: t.main_cpv,
    cpvs: t.cpvs,
    locationNuts: t.location_nuts,
    locationName: t.location_name,
    locationCity: t.location_city,
    locationPostalCode: t.location_postal_code,
    durationValue: t.duration_value,
    durationUnit: t.duration_unit,
    periodStart: t.period_start,
    periodEnd: t.period_end,
    estimatedValue: num(t.estimated_value),
    budgetWithoutTax: num(t.budget_without_tax),
    budgetWithTax: num(t.budget_with_tax),
    currency: t.currency,
    procedureCode: t.procedure_code,
    urgencyCode: t.urgency_code,
    contractingSystemCode: t.contracting_system_code,
    submissionMethodCode: t.submission_method_code,
    submissionDeadline: t.submission_deadline,
    documentationDeadline: t.documentation_deadline,
    publicationDate: t.publication_date,
    awardDate: t.award_date,
    awardAmountWithoutTax: num(t.award_amount_without_tax),
    awardAmountWithTax: num(t.award_amount_with_tax),
    awardeeName: t.awardee_name,
    awardeeTaxId: t.awardee_tax_id,
    tenderCount: t.tender_count,
    awardeeIsSme: t.awardee_is_sme,
    resultCode: t.result_code,
    detailUrl: t.detail_url,
    lots: t.lots,
    results: t.results,
    documents: t.documents,
    rawPayload: t.raw_payload,
  }));

  const result = await db
    .insert(tenders)
    .values(rows)
    .onConflictDoUpdate({
      target: [tenders.source, tenders.id],
      set: {
        updatedAt: dsql`EXCLUDED.updated_at`,
        ingestedAt: dsql`NOW()`,
        fileNumber: dsql`EXCLUDED.file_number`,
        statusCode: dsql`EXCLUDED.status_code`,
        authorityName: dsql`EXCLUDED.authority_name`,
        authorityTaxId: dsql`EXCLUDED.authority_tax_id`,
        authorityDir3: dsql`EXCLUDED.authority_dir3`,
        authorityPlatformId: dsql`EXCLUDED.authority_platform_id`,
        authorityCity: dsql`EXCLUDED.authority_city`,
        authorityPostalCode: dsql`EXCLUDED.authority_postal_code`,
        authorityEmail: dsql`EXCLUDED.authority_email`,
        authorityProfileUrl: dsql`EXCLUDED.authority_profile_url`,
        authorityHierarchy: dsql`EXCLUDED.authority_hierarchy`,
        title: dsql`EXCLUDED.title`,
        subject: dsql`EXCLUDED.subject`,
        summary: dsql`EXCLUDED.summary`,
        contractTypeCode: dsql`EXCLUDED.contract_type_code`,
        subtypeCode: dsql`EXCLUDED.subtype_code`,
        mainCpv: dsql`EXCLUDED.main_cpv`,
        cpvs: dsql`EXCLUDED.cpvs`,
        locationNuts: dsql`EXCLUDED.location_nuts`,
        locationName: dsql`EXCLUDED.location_name`,
        locationCity: dsql`EXCLUDED.location_city`,
        locationPostalCode: dsql`EXCLUDED.location_postal_code`,
        durationValue: dsql`EXCLUDED.duration_value`,
        durationUnit: dsql`EXCLUDED.duration_unit`,
        periodStart: dsql`EXCLUDED.period_start`,
        periodEnd: dsql`EXCLUDED.period_end`,
        estimatedValue: dsql`EXCLUDED.estimated_value`,
        budgetWithoutTax: dsql`EXCLUDED.budget_without_tax`,
        budgetWithTax: dsql`EXCLUDED.budget_with_tax`,
        currency: dsql`EXCLUDED.currency`,
        procedureCode: dsql`EXCLUDED.procedure_code`,
        urgencyCode: dsql`EXCLUDED.urgency_code`,
        contractingSystemCode: dsql`EXCLUDED.contracting_system_code`,
        submissionMethodCode: dsql`EXCLUDED.submission_method_code`,
        submissionDeadline: dsql`EXCLUDED.submission_deadline`,
        documentationDeadline: dsql`EXCLUDED.documentation_deadline`,
        publicationDate: dsql`EXCLUDED.publication_date`,
        awardDate: dsql`EXCLUDED.award_date`,
        awardAmountWithoutTax: dsql`EXCLUDED.award_amount_without_tax`,
        awardAmountWithTax: dsql`EXCLUDED.award_amount_with_tax`,
        awardeeName: dsql`EXCLUDED.awardee_name`,
        awardeeTaxId: dsql`EXCLUDED.awardee_tax_id`,
        tenderCount: dsql`EXCLUDED.tender_count`,
        awardeeIsSme: dsql`EXCLUDED.awardee_is_sme`,
        resultCode: dsql`EXCLUDED.result_code`,
        detailUrl: dsql`EXCLUDED.detail_url`,
        lots: dsql`EXCLUDED.lots`,
        results: dsql`EXCLUDED.results`,
        documents: dsql`EXCLUDED.documents`,
        rawPayload: dsql`EXCLUDED.raw_payload`,
      },
      setWhere: dsql`EXCLUDED.updated_at >= ${tenders.updatedAt}`,
    })
    .returning({
      source: tenders.source,
      id: tenders.id,
      // xmax = 0 ⇒ insert; otherwise ⇒ update
      isInsert: dsql<boolean>`(xmax = 0)`,
    });

  const inserted = result.filter((r) => r.isInsert).length;
  const updated = result.length - inserted;
  const skipped = batch.length - result.length;
  return { inserted, updated, skipped };
}

// Exported for testing — same dedup logic used internally by upsertTenders
export function dedupeByKey(batch: Tender[]): Tender[] {
  const map = new Map<string, Tender>();
  for (const t of batch) {
    const key = `${t.source}\x00${t.id}`;
    const prev = map.get(key);
    if (!prev || t.updated_at >= prev.updated_at) map.set(key, t);
  }
  return Array.from(map.values());
}

// ────────────────────────────────────────────────────────────────────
// markDeleted
// ────────────────────────────────────────────────────────────────────
export async function markDeleted(
  db: Db,
  source: string,
  id: string,
  when: Date,
  reason: string | null,
): Promise<void> {
  await db
    .update(tenders)
    .set({ deletedAt: when, deletedReason: reason })
    .where(and(eq(tenders.source, source), eq(tenders.id, id)));
}

// ────────────────────────────────────────────────────────────────────
// acquireLock + heartbeat
// ────────────────────────────────────────────────────────────────────
export interface Lock {
  instanceId: string;
  release(): Promise<void>;
}

export async function acquireLock(
  db: Db,
  name: string,
  opts: { staleAfterMs: number; heartbeatMs: number },
): Promise<Lock | null> {
  const instanceId = randomBytes(12).toString('hex');
  const staleSeconds = Math.round(opts.staleAfterMs / 1000);

  // Insert or steal expired
  const inserted = await db.execute<{ instance_id: string }>(dsql`
    INSERT INTO sync_locks (name, locked_at, heartbeat, instance_id)
    VALUES (${name}, NOW(), NOW(), ${instanceId})
    ON CONFLICT (name) DO UPDATE
      SET locked_at = EXCLUDED.locked_at,
          heartbeat = EXCLUDED.heartbeat,
          instance_id = EXCLUDED.instance_id
      WHERE sync_locks.heartbeat < NOW() - (${staleSeconds} || ' seconds')::INTERVAL
    RETURNING instance_id
  `);

  const rows = inserted as unknown as Array<{ instance_id: string }>;
  if (!rows[0] || rows[0].instance_id !== instanceId) return null;

  const interval = setInterval(() => {
    db.execute(
      dsql`UPDATE sync_locks SET heartbeat = NOW() WHERE name = ${name} AND instance_id = ${instanceId}`,
    ).catch(() => {
      /* swallow — release will try regardless */
    });
  }, opts.heartbeatMs);
  interval.unref();

  return {
    instanceId,
    async release() {
      clearInterval(interval);
      await db.execute(
        dsql`DELETE FROM sync_locks WHERE name = ${name} AND instance_id = ${instanceId}`,
      );
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// sync_state helpers
// ────────────────────────────────────────────────────────────────────
export interface SyncStateRow {
  source: string;
  lastCursor: string | null;
  lastEntryUpdated: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

export async function readSyncState(
  db: Db,
  source: string,
): Promise<SyncStateRow | null> {
  const rows = await db.select().from(syncState).where(eq(syncState.source, source));
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    source: r.source,
    lastCursor: r.lastCursor,
    lastEntryUpdated: r.lastEntryUpdated,
    lastSuccessAt: r.lastSuccessAt,
    lastError: r.lastError,
  };
}

export async function markRunStart(db: Db, source: string): Promise<void> {
  await db
    .insert(syncState)
    .values({ source, lastRunAt: new Date(), lastError: null })
    .onConflictDoUpdate({
      target: syncState.source,
      set: { lastRunAt: dsql`NOW()`, lastError: null },
    });
}

export async function markRunSuccess(
  db: Db,
  source: string,
  cursor: string,
  lastEntryUpdated: Date | null,
): Promise<void> {
  await db
    .insert(syncState)
    .values({
      source,
      lastRunAt: new Date(),
      lastSuccessAt: new Date(),
      lastCursor: cursor,
      lastEntryUpdated,
    })
    .onConflictDoUpdate({
      target: syncState.source,
      set: {
        lastSuccessAt: dsql`NOW()`,
        lastCursor: cursor,
        lastEntryUpdated: lastEntryUpdated ?? dsql`sync_state.last_entry_updated`,
      },
    });
}

export async function markRunFailure(
  db: Db,
  source: string,
  error: string,
): Promise<void> {
  await db
    .insert(syncState)
    .values({ source, lastRunAt: new Date(), lastError: error })
    .onConflictDoUpdate({
      target: syncState.source,
      set: { lastError: error },
    });
}
