import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  acquireLock,
  createDb,
  dedupeByKey,
  markDeleted,
  markRunFailure,
  markRunStart,
  markRunSuccess,
  readSyncState,
  syncLocks,
  syncState,
  tenders,
  upsertTenders,
  type Db,
} from '../src/db.js';
import type { Tender } from '../src/placsp.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/licitaciones';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  const built = createDb(DATABASE_URL);
  db = built.db;
  close = built.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(tenders);
  await db.delete(syncState);
  await db.delete(syncLocks);
});

function fakeTender(
  externalId: string,
  updatedAt: string,
  overrides: Partial<Tender> = {},
): Tender {
  return {
    source: 'placsp',
    external_id: externalId,
    updated_at: new Date(updatedAt),
    file_number: 'EXP-' + externalId,
    status_code: 'PUB',
    authority_name: 'Org',
    authority_tax_id: null,
    authority_dir3: null,
    authority_platform_id: null,
    authority_city: null,
    authority_postal_code: null,
    authority_email: null,
    authority_profile_url: null,
    authority_hierarchy: null,
    title: 'Test ' + externalId,
    subject: null,
    summary: null,
    contract_type_code: '2',
    subtype_code: null,
    main_cpv: '50000000-5',
    cpvs: ['50000000-5'],
    location_nuts: null,
    location_name: null,
    location_city: null,
    location_postal_code: null,
    duration_value: null,
    duration_unit: null,
    period_start: null,
    period_end: null,
    estimated_value: 1000,
    budget_without_tax: 800,
    budget_with_tax: 968,
    currency: 'EUR',
    procedure_code: '1',
    urgency_code: null,
    contracting_system_code: null,
    submission_method_code: null,
    submission_deadline: null,
    documentation_deadline: null,
    publication_date: null,
    award_date: null,
    award_amount_without_tax: null,
    award_amount_with_tax: null,
    awardee_name: null,
    awardee_tax_id: null,
    tender_count: null,
    awardee_is_sme: null,
    result_code: null,
    detail_url: null,
    lots: [],
    results: [],
    documents: [],
    raw_payload: { id: externalId, marker: true },
    ...overrides,
  };
}

describe('upsertTenders', () => {
  it('inserts new rows and returns counts', async () => {
    const r = await upsertTenders(db, [fakeTender('a', '2026-01-01T00:00:00Z')]);
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(0);
    const rows = await db.select().from(tenders);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('a');
    expect(typeof rows[0].id).toBe('number');
    expect(rows[0].id).toBeGreaterThan(0);
    expect(rows[0].cpvs).toEqual(['50000000-5']);
    expect(rows[0].rawPayload).toEqual({ id: 'a', marker: true });
  });

  it('is idempotent across multiple runs with same data', async () => {
    for (let i = 0; i < 5; i++) {
      await upsertTenders(db, [fakeTender('a', '2026-01-01T00:00:00Z')]);
    }
    const rows = await db.select().from(tenders);
    expect(rows).toHaveLength(1);
  });

  it('updates fields when updated_at is newer', async () => {
    await upsertTenders(db, [
      fakeTender('a', '2026-01-01T00:00:00Z', { title: 'old' }),
    ]);
    const r = await upsertTenders(db, [
      fakeTender('a', '2026-02-01T00:00:00Z', { title: 'new' }),
    ]);
    expect(r.updated).toBe(1);
    const rows = await db.select().from(tenders);
    expect(rows[0].title).toBe('new');
  });

  it('skips updates when updated_at is older', async () => {
    await upsertTenders(db, [
      fakeTender('a', '2026-02-01T00:00:00Z', { title: 'newer' }),
    ]);
    const r = await upsertTenders(db, [
      fakeTender('a', '2026-01-01T00:00:00Z', { title: 'older' }),
    ]);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(tenders);
    expect(rows[0].title).toBe('newer');
  });

  it('handles batch with multiple rows', async () => {
    const batch = Array.from({ length: 10 }, (_, i) =>
      fakeTender(`id-${i}`, '2026-01-01T00:00:00Z'),
    );
    const r = await upsertTenders(db, batch);
    expect(r.inserted).toBe(10);
    const rows = await db.select().from(tenders);
    expect(rows).toHaveLength(10);
  });

  it('deduplicates same (source, id) within a single batch, keeping latest updated_at', async () => {
    const older = fakeTender('a', '2026-01-01T00:00:00Z', { title: 'old' });
    const newer = fakeTender('a', '2026-02-01T00:00:00Z', { title: 'new' });
    // Same key three times in one batch
    const r = await upsertTenders(db, [older, newer, older]);
    expect(r.inserted).toBe(1);
    const rows = await db.select().from(tenders);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('new');
  });

  it('dedupeByKey is order-independent and keeps the newest', () => {
    const older = fakeTender('a', '2026-01-01T00:00:00Z', { title: 'old' });
    const newer = fakeTender('a', '2026-02-01T00:00:00Z', { title: 'new' });
    expect(dedupeByKey([older, newer])[0].title).toBe('new');
    expect(dedupeByKey([newer, older])[0].title).toBe('new');
  });

  it('persists lots and results as JSONB arrays', async () => {
    const t = fakeTender('a', '2026-01-01T00:00:00Z', {
      lots: [
        {
          lot_id: '1',
          subject: 'L1',
          cpvs: ['50000000-5'],
          budget_without_tax: 100,
          budget_with_tax: 121,
        },
      ],
      results: [
        {
          lot_id: '1',
          result_code: '8',
          award_date: '2026-02-01',
          tender_count: 3,
          awardee_is_sme: true,
          awardee_name: 'Acme',
          awardee_tax_id: 'B11111111',
          award_amount_without_tax: 90,
          award_amount_with_tax: 108.9,
        },
      ],
    });
    await upsertTenders(db, [t]);
    const rows = await db.select().from(tenders);
    expect((rows[0].lots as unknown[])).toHaveLength(1);
    expect((rows[0].results as unknown[])).toHaveLength(1);
  });
});

describe('markDeleted', () => {
  it('marks a tender as deleted with reason', async () => {
    await upsertTenders(db, [fakeTender('a', '2026-01-01T00:00:00Z')]);
    await markDeleted(db, 'placsp', 'a', new Date('2026-03-01T00:00:00Z'), 'ANULADA');
    const rows = await db
      .select()
      .from(tenders)
      .where(eq(tenders.externalId, 'a'));
    expect(rows[0].deletedReason).toBe('ANULADA');
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
  });
});

describe('acquireLock', () => {
  const opts = { staleAfterMs: 30_000, heartbeatMs: 60_000 };

  it('acquires when no lock exists', async () => {
    const lock = await acquireLock(db, 'test', opts);
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('refuses concurrent acquisition', async () => {
    const a = await acquireLock(db, 'test', opts);
    const b = await acquireLock(db, 'test', opts);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await a!.release();
  });

  it('release removes only own lock', async () => {
    const a = await acquireLock(db, 'test', opts);
    await a!.release();
    const rows = await db.select().from(syncLocks);
    expect(rows).toHaveLength(0);
  });

  it('steals an expired lock', async () => {
    // Insert a dead lock with old heartbeat
    await db.insert(syncLocks).values({
      name: 'test',
      lockedAt: new Date(Date.now() - 60 * 60 * 1000),
      heartbeat: new Date(Date.now() - 60 * 60 * 1000),
      instanceId: 'dead-process',
    });
    const fresh = await acquireLock(db, 'test', { staleAfterMs: 1000, heartbeatMs: 60_000 });
    expect(fresh).not.toBeNull();
    await fresh!.release();
  });
});

describe('syncState', () => {
  it('returns null when no state for source', async () => {
    expect(await readSyncState(db, 'nope')).toBeNull();
  });

  it('persists run lifecycle (start, success, failure)', async () => {
    await markRunStart(db, 'placsp');
    let state = await readSyncState(db, 'placsp');
    expect(state).not.toBeNull();
    expect(state!.lastCursor).toBeNull();

    await markRunSuccess(db, 'placsp', '202605', new Date('2026-05-19T00:00:00Z'));
    state = await readSyncState(db, 'placsp');
    expect(state!.lastCursor).toBe('202605');
    expect(state!.lastSuccessAt).toBeInstanceOf(Date);
    expect(state!.lastEntryUpdated).toBeInstanceOf(Date);

    await markRunFailure(db, 'placsp', 'boom');
    state = await readSyncState(db, 'placsp');
    expect(state!.lastError).toBe('boom');
    // Cursor remains across failure
    expect(state!.lastCursor).toBe('202605');
  });
});
