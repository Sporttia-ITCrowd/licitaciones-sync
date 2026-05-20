import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AtomEvent,
  type RawNode,
  discoverPeriods,
  mapEntry,
  parseAmount,
  parseAtom,
  streamAtoms,
} from '../src/placsp.js';

async function collect(parser: AsyncIterable<AtomEvent>): Promise<AtomEvent[]> {
  const out: AtomEvent[] = [];
  for await (const ev of parser) out.push(ev);
  return out;
}

async function parseFixture(filename: string): Promise<AtomEvent[]> {
  return await collect(
    parseAtom(createReadStream(`tests/fixtures/${filename}`)),
  );
}

async function loadEntry(filename: string): Promise<RawNode> {
  const events = await parseFixture(filename);
  const entry = events.find((e) => e.type === 'entry');
  if (!entry || entry.type !== 'entry')
    throw new Error(`No entry found in ${filename}`);
  return entry.raw;
}

// ───────────────────────────────── parseAmount ─────────────────────────────────
describe('parseAmount', () => {
  it.each<[string | null | undefined, number | null]>([
    ['10000000', 10000000],
    ['4949909.74', 4949909.74],
    ['5989390,79', 5989390.79],
    ['', null],
    [undefined, null],
    [null, null],
    ['   ', null],
    ['abc', null],
    ['-100,5', -100.5],
    [' 12.34 ', 12.34],
    ['0', 0],
    ['0.00', 0],
  ])('parseAmount(%p) -> %p', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });
});

// ───────────────────────────────── parseAtom ─────────────────────────────────
describe('parseAtom', () => {
  it('emits exactly one entry for entry-basico.atom', async () => {
    const events = await parseFixture('entry-basico.atom');
    const entries = events.filter((e) => e.type === 'entry');
    expect(entries).toHaveLength(1);
    if (entries[0].type !== 'entry') throw new Error();
    expect(entries[0].raw.id).toBeDefined();
  });

  it('preserves attributes (schemeName, currencyID)', async () => {
    const raw = await loadEntry('entry-basico.atom');
    const cfs = raw.ContractFolderStatus as RawNode;
    const party = (cfs.LocatedContractingParty as RawNode).Party as RawNode;
    const ids = party.PartyIdentification as RawNode[];
    expect(Array.isArray(ids)).toBe(true);
    const nif = ids
      .map((p) => p.ID as RawNode)
      .find((id) => id?._attrs?.schemeName === 'NIF');
    expect(nif?._text).toBe('P4109100E');

    const project = cfs.ProcurementProject as RawNode;
    const budget = project.BudgetAmount as RawNode;
    const total = budget.TotalAmount as RawNode;
    expect(total._attrs?.currencyID).toBe('EUR');
  });

  it('coalesces repeated tags into arrays (lots, cpvs)', async () => {
    const raw = await loadEntry('entry-completa.atom');
    const cfs = raw.ContractFolderStatus as RawNode;
    const lots = cfs.ProcurementProjectLot as RawNode[];
    expect(Array.isArray(lots)).toBe(true);
    expect(lots).toHaveLength(2);

    const project = cfs.ProcurementProject as RawNode;
    const cpvs = project.RequiredCommodityClassification as RawNode[];
    expect(Array.isArray(cpvs)).toBe(true);
    expect(cpvs.length).toBe(2);
  });

  it('emits tombstone events with reason', async () => {
    const events = await parseFixture('feed-tombstone.atom');
    const tombs = events.filter((e) => e.type === 'tombstone');
    expect(tombs).toHaveLength(2);
    if (tombs[0].type !== 'tombstone') throw new Error();
    expect(tombs[0].reason).toBe('ANULADA');
    if (tombs[1].type !== 'tombstone') throw new Error();
    expect(tombs[1].reason).toBe('CERRADA');
  });

  it('emits nextLink for feed-level <link rel="next">', async () => {
    const events = await parseFixture('feed-tombstone.atom');
    const links = events.filter((e) => e.type === 'nextLink');
    expect(links).toHaveLength(1);
    if (links[0].type !== 'nextLink') throw new Error();
    expect(links[0].url).toContain('licitaciones_20260324');
  });

  it('emits feedUpdated', async () => {
    const events = await parseFixture('entry-basico.atom');
    const fu = events.filter((e) => e.type === 'feedUpdated');
    expect(fu).toHaveLength(1);
  });
});

// ───────────────────────────────── mapEntry ─────────────────────────────────
describe('mapEntry', () => {
  it('sets source and id', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.source).toBe('placsp');
    expect(t.id).toMatch(/^https:\/\//);
    expect(t.id).toContain('TEST001');
  });

  it('maps updated_at as Date in UTC', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.updated_at).toBeInstanceOf(Date);
    // 2026-03-25T10:00:00+01:00 → 09:00:00Z
    expect(t.updated_at.toISOString()).toBe('2026-03-25T09:00:00.000Z');
  });

  it('maps status_code', async () => {
    expect(mapEntry(await loadEntry('entry-basico.atom')).status_code).toBe(
      'PUB',
    );
    expect(mapEntry(await loadEntry('entry-completa.atom')).status_code).toBe(
      'ADJ',
    );
  });

  it('maps file_number from ContractFolderID', async () => {
    expect(mapEntry(await loadEntry('entry-basico.atom')).file_number).toBe(
      'EXP/2026/0001',
    );
  });

  it('maps authority NIF, DIR3, platform_id', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.authority_name).toBe('Ayuntamiento de Sevilla');
    expect(t.authority_tax_id).toBe('P4109100E');
    expect(t.authority_dir3).toBe('L01410917');
    expect(t.authority_platform_id).toBe('12345');
    expect(t.authority_city).toBe('Sevilla');
    expect(t.authority_postal_code).toBe('41004');
    expect(t.authority_email).toBe('contratacion@sevilla.org');
    expect(t.authority_profile_url).toContain('perfilContratante');
  });

  it('builds authority_hierarchy recursively', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    expect(t.authority_hierarchy).toBe(
      'Secretaria de Estado para el Deporte > Ministerio de Cultura y Deporte',
    );
  });

  it('maps three amount variants with dot decimals', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.estimated_value).toBe(60000);
    expect(t.budget_without_tax).toBe(50000);
    expect(t.budget_with_tax).toBe(60500);
    expect(t.currency).toBe('EUR');
  });

  it('normalizes comma decimals', async () => {
    const t = mapEntry(await loadEntry('entry-coma-decimal.atom'));
    expect(t.estimated_value).toBe(10000000);
    expect(t.budget_with_tax).toBe(5989390.79);
    expect(t.budget_without_tax).toBe(4949909.74);
  });

  it('returns cpvs array with main_cpv as first', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    expect(t.cpvs).toEqual(['37400000-2', '37410000-5']);
    expect(t.main_cpv).toBe('37400000-2');
  });

  it('returns lots as serializable array', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    expect(Array.isArray(t.lots)).toBe(true);
    expect(t.lots).toHaveLength(2);
    expect(t.lots[0].lot_id).toBe('1');
    expect(t.lots[0].subject).toContain('educacion fisica');
    expect(t.lots[0].budget_without_tax).toBe(150000);
    expect(t.lots[0].budget_with_tax).toBe(181500);
    expect(t.lots[0].cpvs).toEqual(['37400000-2']);
    expect(t.lots[1].lot_id).toBe('2');
    expect(t.lots[1].cpvs).toEqual(['37410000-5']);
    expect(() => JSON.stringify(t.lots)).not.toThrow();
  });

  it('returns results array (one per TenderResult)', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    expect(t.results).toHaveLength(2);
    const adj = t.results.find((r) => r.result_code === '8')!;
    expect(adj.awardee_tax_id).toBe('B12345678');
    expect(adj.awardee_name).toBe('Sportia SL');
    expect(adj.awardee_is_sme).toBe(true);
    expect(adj.tender_count).toBe(5);
    expect(adj.award_amount_without_tax).toBe(140000);
    expect(adj.award_amount_with_tax).toBe(169400);
    expect(adj.lot_id).toBe('1');
  });

  it('returns documents array (legal + technical)', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    const legal = t.documents.find((d) => d.type === 'legal');
    const tech = t.documents.find((d) => d.type === 'technical');
    expect(legal?.url).toContain('pcap-2026-099.pdf');
    expect(tech?.url).toContain('ppt-2026-099.pdf');
  });

  it('preserves raw_payload as serializable object', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(typeof t.raw_payload).toBe('object');
    expect(() => JSON.stringify(t.raw_payload)).not.toThrow();
  });

  it('handles missing fields gracefully (no throws, null/[] defaults)', async () => {
    const t = mapEntry(await loadEntry('entry-coma-decimal.atom'));
    expect(t.results).toEqual([]);
    expect(t.lots).toEqual([]);
    expect(t.award_date).toBeNull();
    expect(t.awardee_name).toBeNull();
  });

  it('exposes detail_url from entry link', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.detail_url).toContain('deeplink:detalle_licitacion');
  });

  it('maps publication_date from ValidNoticeInfo', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    expect(t.publication_date).toBe('2026-02-15');
  });

  it('maps duration_value and duration_unit', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.duration_value).toBe(12);
    expect(t.duration_unit).toBe('MON');
  });

  it('maps location_nuts and location_name', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.location_nuts).toBe('ES618');
    expect(t.location_name).toBe('Sevilla');
  });

  it('maps procedure and urgency codes', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.procedure_code).toBe('1');
    expect(t.urgency_code).toBe('1');
  });

  it('combines submission deadline date + time as Date', async () => {
    const t = mapEntry(await loadEntry('entry-basico.atom'));
    expect(t.submission_deadline).toBeInstanceOf(Date);
    // 2026-04-15 is in DST: +02:00 → 14:00:00+02:00 = 12:00:00Z
    expect(t.submission_deadline?.toISOString()).toBe(
      '2026-04-15T12:00:00.000Z',
    );
  });

  it('promotes adjudicated result to top-level award fields', async () => {
    const t = mapEntry(await loadEntry('entry-completa.atom'));
    expect(t.awardee_tax_id).toBe('B12345678');
    expect(t.awardee_name).toBe('Sportia SL');
    expect(t.award_date).toBe('2026-04-10');
    expect(t.award_amount_without_tax).toBe(140000);
    expect(t.tender_count).toBe(5);
    expect(t.awardee_is_sme).toBe(true);
  });
});

// ───────────────────────────────── discoverPeriods ─────────────────────────────────
describe('discoverPeriods', () => {
  const now = new Date('2026-05-19T10:00:00Z');

  it('bootstrap returns 2012..2025 yearly + current month', () => {
    const ps = discoverPeriods({ now });
    const cursors = ps.map((p) => p.cursor);
    expect(cursors).toContain('2012');
    expect(cursors).toContain('2013');
    expect(cursors).toContain('2025');
    expect(cursors).toContain('202605');
    expect(cursors).not.toContain('2026'); // current year not as annual
  });

  it('bootstrap marks only current month as isCurrent=true', () => {
    const ps = discoverPeriods({ now });
    const currents = ps.filter((p) => p.isCurrent);
    expect(currents).toHaveLength(1);
    expect(currents[0].cursor).toBe('202605');
  });

  it('builds correct annual and monthly URL patterns', () => {
    const ps = discoverPeriods({ now });
    expect(ps.find((p) => p.cursor === '2023')?.url).toMatch(
      /licitacionesPerfilesContratanteCompleto3_2023\.zip$/,
    );
    expect(ps.find((p) => p.cursor === '202605')?.url).toMatch(
      /licitacionesPerfilesContratanteCompleto3_202605\.zip$/,
    );
  });

  it('incremental from monthly cursor returns prev + current', () => {
    const ps = discoverPeriods({ fromCursor: '202604', now });
    expect(ps.map((p) => p.cursor)).toEqual(['202603', '202604', '202605']);
  });

  it('incremental from same-month cursor returns prev + current', () => {
    const ps = discoverPeriods({ fromCursor: '202605', now });
    expect(ps.map((p) => p.cursor)).toEqual(['202604', '202605']);
  });

  it('incremental from year cursor starts next January', () => {
    const ps = discoverPeriods({ fromCursor: '2025', now });
    expect(ps[0].cursor).toBe('202601');
    expect(ps[ps.length - 1].cursor).toBe('202605');
  });

  it('handles year rollover when stepping back from January', () => {
    const ps = discoverPeriods({
      fromCursor: '202601',
      now: new Date('2026-02-15T00:00:00Z'),
    });
    expect(ps.map((p) => p.cursor)).toEqual(['202512', '202601', '202602']);
  });
});

// ───────────────────────────────── streamAtoms ─────────────────────────────────
describe('streamAtoms', () => {
  it('yields .atom files in lex order, ignoring non-atom entries', async () => {
    const seen: string[] = [];
    for await (const { name, stream } of streamAtoms('tests/fixtures/sample.zip')) {
      seen.push(name);
      // Drain
      for await (const _ of stream) {
        // consume
      }
    }
    expect(seen).toEqual(['a.atom', 'b.atom', 'c.atom']);
  });
});
