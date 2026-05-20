import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import sax from 'sax';
import yauzl from 'yauzl';
import { fetch } from 'undici';

// ────────────────────────────────────────────────────────────────────
// Namespaces (DGPE-PLACE CODICE extension, NOT standard UBL/OASIS)
// ────────────────────────────────────────────────────────────────────
const NS_ATOM = 'http://www.w3.org/2005/Atom';
const NS_TOMBSTONES = 'http://purl.org/atompub/tombstones/1.0';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────
export interface RawNode {
  _text?: string;
  _attrs?: Record<string, string>;
  [child: string]: unknown;
}

export type AtomEvent =
  | { type: 'entry'; raw: RawNode }
  | { type: 'tombstone'; ref: string; when: string; reason: string | null }
  | { type: 'feedUpdated'; when: string }
  | { type: 'nextLink'; url: string };

export interface Lot {
  lot_id: string | null;
  subject: string | null;
  cpvs: string[];
  budget_without_tax: number | null;
  budget_with_tax: number | null;
}

export interface Result {
  lot_id: string | null;
  result_code: string | null;
  award_date: string | null;
  tender_count: number | null;
  awardee_is_sme: boolean | null;
  awardee_name: string | null;
  awardee_tax_id: string | null;
  award_amount_without_tax: number | null;
  award_amount_with_tax: number | null;
}

export interface Document {
  type: 'legal' | 'technical' | 'additional';
  id: string | null;
  url: string;
}

export interface Tender {
  source: string;
  id: string;
  updated_at: Date;

  file_number: string | null;
  status_code: string | null;

  authority_name: string | null;
  authority_tax_id: string | null;
  authority_dir3: string | null;
  authority_platform_id: string | null;
  authority_city: string | null;
  authority_postal_code: string | null;
  authority_email: string | null;
  authority_profile_url: string | null;
  authority_hierarchy: string | null;

  title: string | null;
  subject: string | null;
  summary: string | null;
  contract_type_code: string | null;
  subtype_code: string | null;
  main_cpv: string | null;
  cpvs: string[];
  location_nuts: string | null;
  location_name: string | null;
  location_city: string | null;
  location_postal_code: string | null;
  duration_value: number | null;
  duration_unit: string | null;
  period_start: string | null;
  period_end: string | null;

  estimated_value: number | null;
  budget_without_tax: number | null;
  budget_with_tax: number | null;
  currency: string;

  procedure_code: string | null;
  urgency_code: string | null;
  contracting_system_code: string | null;
  submission_method_code: string | null;
  submission_deadline: Date | null;
  documentation_deadline: string | null;
  publication_date: string | null;

  award_date: string | null;
  award_amount_without_tax: number | null;
  award_amount_with_tax: number | null;
  awardee_name: string | null;
  awardee_tax_id: string | null;
  tender_count: number | null;
  awardee_is_sme: boolean | null;
  result_code: string | null;

  detail_url: string | null;

  lots: Lot[];
  results: Result[];
  documents: Document[];
  raw_payload: unknown;
}

export interface Period {
  cursor: string;
  url: string;
  isCurrent: boolean;
}

// ────────────────────────────────────────────────────────────────────
// parseAmount — quirk #1 of the spec: comma and dot decimals coexist
// ────────────────────────────────────────────────────────────────────
export function parseAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const normalized = trimmed.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// ────────────────────────────────────────────────────────────────────
// parseAtom — streaming SAX parser yielding entry/tombstone/feedUpdated/nextLink
// ────────────────────────────────────────────────────────────────────
export async function* parseAtom(input: Readable): AsyncIterable<AtomEvent> {
  const parser = sax.parser(true, { xmlns: true, trim: false });

  const queue: AtomEvent[] = [];
  let ended = false;
  let parseError: Error | null = null;
  let resolveWaiter: (() => void) | null = null;

  function notify() {
    const r = resolveWaiter;
    resolveWaiter = null;
    if (r) r();
  }
  function push(ev: AtomEvent) {
    queue.push(ev);
    notify();
  }

  interface Frame {
    node: RawNode;
    localName: string;
  }
  const stack: Frame[] = [];
  let inEntry = false;
  let inTombstone: { ref: string; when: string; reason: string | null } | null =
    null;
  let inFeedUpdated = false;
  let feedUpdatedBuffer = '';
  let textBuffer = '';

  function extractAttrs(node: sax.QualifiedTag): Record<string, string> {
    const out: Record<string, string> = {};
    for (const attr of Object.values(node.attributes)) {
      out[(attr as sax.QualifiedAttribute).local] = (
        attr as sax.QualifiedAttribute
      ).value;
    }
    return out;
  }

  function getAttrValue(
    node: sax.QualifiedTag,
    localName: string,
  ): string | undefined {
    for (const attr of Object.values(node.attributes)) {
      const a = attr as sax.QualifiedAttribute;
      if (a.local === localName) return a.value;
    }
    return undefined;
  }

  parser.onopentag = (rawNode) => {
    const node = rawNode as sax.QualifiedTag;
    // ── Feed-level handling ──
    if (!inEntry && !inTombstone && stack.length === 0) {
      if (node.local === 'entry' && node.uri === NS_ATOM) {
        inEntry = true;
        const root: RawNode = {};
        stack.push({ node: root, localName: 'entry' });
        textBuffer = '';
        return;
      }
      if (node.local === 'deleted-entry' && node.uri === NS_TOMBSTONES) {
        inTombstone = {
          ref: getAttrValue(node, 'ref') ?? '',
          when: getAttrValue(node, 'when') ?? '',
          reason: null,
        };
        return;
      }
      if (node.local === 'updated' && node.uri === NS_ATOM) {
        inFeedUpdated = true;
        feedUpdatedBuffer = '';
        return;
      }
      if (node.local === 'link' && node.uri === NS_ATOM) {
        const rel = getAttrValue(node, 'rel');
        const href = getAttrValue(node, 'href');
        if (rel === 'next' && href) push({ type: 'nextLink', url: href });
        return;
      }
      return;
    }

    // ── Tombstone (only `<at:comment>` matters inside) ──
    if (inTombstone) {
      if (node.local === 'comment' && node.uri === NS_TOMBSTONES) {
        const t = getAttrValue(node, 'type');
        if (t) inTombstone.reason = t;
      }
      return;
    }

    // ── Inside an entry: build the tree ──
    const newNode: RawNode = {};
    const attrs = extractAttrs(node);
    if (Object.keys(attrs).length > 0) newNode._attrs = attrs;
    stack.push({ node: newNode, localName: node.local });
    textBuffer = '';
  };

  parser.ontext = (text) => {
    if (inFeedUpdated) {
      feedUpdatedBuffer += text;
    } else if (stack.length > 0 || inTombstone) {
      textBuffer += text;
    }
  };
  parser.oncdata = (text) => {
    if (stack.length > 0) textBuffer += text;
  };

  parser.onclosetag = (tagName) => {
    if (inFeedUpdated) {
      push({ type: 'feedUpdated', when: feedUpdatedBuffer.trim() });
      inFeedUpdated = false;
      feedUpdatedBuffer = '';
      return;
    }

    if (inTombstone) {
      // sax with xmlns:true returns the qualified name (prefix:local)
      // tombstone close: tagName ends with 'deleted-entry'
      if (tagName === 'at:deleted-entry' || tagName.endsWith(':deleted-entry')) {
        push({
          type: 'tombstone',
          ref: inTombstone.ref,
          when: inTombstone.when,
          reason: inTombstone.reason,
        });
        inTombstone = null;
      }
      return;
    }

    if (stack.length === 0) return;

    const top = stack[stack.length - 1];
    const trimmed = textBuffer.trim();
    textBuffer = '';
    if (trimmed) top.node._text = trimmed;

    stack.pop();

    if (stack.length === 0 && inEntry) {
      push({ type: 'entry', raw: top.node });
      inEntry = false;
      return;
    }

    if (stack.length > 0) {
      const parent = stack[stack.length - 1].node;
      const key = top.localName;
      const existing = parent[key];
      if (existing === undefined) {
        parent[key] = top.node;
      } else if (Array.isArray(existing)) {
        (existing as RawNode[]).push(top.node);
      } else {
        parent[key] = [existing as RawNode, top.node];
      }
    }
  };

  parser.onerror = (err) => {
    parseError = err;
    notify();
  };
  parser.onend = () => {
    ended = true;
    notify();
  };

  const writePromise = (async () => {
    try {
      for await (const chunk of input) {
        const str =
          typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8');
        parser.write(str);
      }
      parser.close();
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
      ended = true;
      notify();
    }
  })();

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (parseError) throw parseError;
    if (ended) break;
    await new Promise<void>((r) => {
      resolveWaiter = r;
    });
  }

  await writePromise;
}

// ────────────────────────────────────────────────────────────────────
// mapEntry — CODICE tree → flat Tender + arrays + raw payload
// ────────────────────────────────────────────────────────────────────
function asNode(v: unknown): RawNode | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return (v[0] as RawNode) ?? null;
  if (typeof v === 'object') return v as RawNode;
  return null;
}
function asArray(v: unknown): RawNode[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v as RawNode[];
  if (typeof v === 'object') return [v as RawNode];
  return [];
}
function text(v: unknown): string | null {
  const n = asNode(v);
  return n?._text ?? null;
}
function intVal(v: unknown): number | null {
  const t = text(v);
  if (t === null) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
function boolVal(v: unknown): boolean | null {
  const t = text(v);
  if (t === null) return null;
  if (t.toLowerCase() === 'true') return true;
  if (t.toLowerCase() === 'false') return false;
  return null;
}

function buildHierarchy(party: RawNode | null): string | null {
  if (!party) return null;
  const names: string[] = [];
  let current: RawNode | null = party;
  while (current) {
    const name = text((asNode(current.PartyName) as RawNode | null)?.Name);
    if (name) names.push(name);
    current = asNode(current.ParentLocatedParty);
  }
  return names.length > 0 ? names.join(' > ') : null;
}

function partyIdBy(partyIds: RawNode[], scheme: string): string | null {
  for (const p of partyIds) {
    const idNode = asNode(p.ID);
    if (idNode?._attrs?.schemeName === scheme) return idNode._text ?? null;
  }
  return null;
}

function firstPartyIdAnyScheme(partyIds: RawNode[]): string | null {
  for (const p of partyIds) {
    const idNode = asNode(p.ID);
    if (idNode?._text) return idNode._text;
  }
  return null;
}

function dateOnly(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function combineDateTime(date: string | null, time: string | null): Date | null {
  if (!date) return null;
  // Default timezone for PLACSP: Europe/Madrid (peninsula). Use offset based on month.
  const tz = isDST(date) ? '+02:00' : '+01:00';
  const iso = `${date}T${time ?? '00:00:00'}${tz}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isDST(dateStr: string): boolean {
  // crude EU DST: last Sunday of March → last Sunday of October
  const d = new Date(`${dateStr}T12:00:00Z`);
  const m = d.getUTCMonth(); // 0=Jan
  if (m > 2 && m < 9) return true;
  if (m < 2 || m > 9) return false;
  // March or October: more precise check
  const year = d.getUTCFullYear();
  const lastSundayMarch = lastSundayOf(year, 2);
  const lastSundayOctober = lastSundayOf(year, 9);
  if (m === 2) return d.getUTCDate() >= lastSundayMarch;
  return d.getUTCDate() < lastSundayOctober;
}
function lastSundayOf(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

export function mapEntry(raw: RawNode, source = 'placsp'): Tender {
  const cfs = asNode(raw.ContractFolderStatus) ?? {};
  const lcp = asNode(cfs.LocatedContractingParty) ?? {};
  const party = asNode(lcp.Party) ?? {};
  const partyIds = asArray(party.PartyIdentification);
  const project = asNode(cfs.ProcurementProject) ?? {};
  const budget = asNode(project.BudgetAmount) ?? {};
  const procurement = asNode(cfs.TenderingProcess) ?? {};
  const submission = asNode(procurement.TenderSubmissionDeadlinePeriod) ?? {};
  const docAvailability = asNode(procurement.DocumentAvailabilityPeriod) ?? {};

  const idStr = text(raw.id) ?? '';
  const updatedStr = text(raw.updated);
  const updated_at = updatedStr ? new Date(updatedStr) : new Date(0);

  // Address
  const postal = asNode(party.PostalAddress) ?? {};
  // Contact
  const contact = asNode(party.Contact) ?? {};

  // Location of execution
  const location = asNode(project.RealizedLocation) ?? {};
  const locationAddress = asNode(location.Address) ?? {};

  // CPVs (project-level)
  const cpvNodes = asArray(project.RequiredCommodityClassification);
  const cpvs: string[] = [];
  for (const node of cpvNodes) {
    const code = text(node.ItemClassificationCode);
    if (code) cpvs.push(code);
  }

  // Planned period
  const plannedPeriod = asNode(project.PlannedPeriod) ?? {};
  const durationNode = asNode(plannedPeriod.DurationMeasure);
  const duration_value = intVal(plannedPeriod.DurationMeasure);
  const duration_unit = durationNode?._attrs?.unitCode ?? null;

  // Submission deadline as Date
  const submissionDate = text(submission.EndDate);
  const submissionTime = text(submission.EndTime);
  const submission_deadline = combineDateTime(submissionDate, submissionTime);

  // Publication date (from ValidNoticeInfo)
  const validNotice = asNode(cfs.ValidNoticeInfo) ?? {};
  const additionalStatus = asNode(validNotice.AdditionalPublicationStatus);
  const additionalDocRef =
    asNode(additionalStatus?.AdditionalPublicationDocumentReference);
  const publication_date = dateOnly(text(additionalDocRef?.IssueDate));

  // Detail link (entry/link[@href])
  const linkNode = asNode(raw.link);
  const detail_url = linkNode?._attrs?.href ?? null;

  // Lots
  const lots: Lot[] = asArray(cfs.ProcurementProjectLot).map((lotNode) => {
    const lotProject = asNode(lotNode.ProcurementProject) ?? {};
    const lotBudget = asNode(lotProject.BudgetAmount) ?? {};
    const lotCpvNodes = asArray(lotProject.RequiredCommodityClassification);
    const lotCpvs: string[] = [];
    for (const n of lotCpvNodes) {
      const c = text(n.ItemClassificationCode);
      if (c) lotCpvs.push(c);
    }
    return {
      lot_id: text(lotNode.ID),
      subject: text(lotProject.Name),
      cpvs: lotCpvs,
      budget_without_tax: parseAmount(text(lotBudget.TaxExclusiveAmount)),
      budget_with_tax: parseAmount(text(lotBudget.TotalAmount)),
    };
  });

  // Results (TenderResult, 0..n)
  const results: Result[] = asArray(cfs.TenderResult).map((r) => {
    const winningParty = asNode(r.WinningParty) ?? {};
    const winningPartyIds = asArray(winningParty.PartyIdentification);
    const awarded = asNode(r.AwardedTenderedProject) ?? {};
    const legalTotal = asNode(awarded.LegalMonetaryTotal) ?? {};
    return {
      lot_id: text(awarded.ProcurementProjectLotID),
      result_code: text(r.ResultCode),
      award_date: dateOnly(text(r.AwardDate)),
      tender_count: intVal(r.ReceivedTenderQuantity),
      awardee_is_sme: boolVal(r.SMEAwardedIndicator),
      awardee_name: text((asNode(winningParty.PartyName) as RawNode)?.Name),
      awardee_tax_id:
        partyIdBy(winningPartyIds, 'NIF') ??
        firstPartyIdAnyScheme(winningPartyIds),
      award_amount_without_tax: parseAmount(text(legalTotal.TaxExclusiveAmount)),
      award_amount_with_tax: parseAmount(text(legalTotal.PayableAmount)),
    };
  });

  // Documents
  const documents: Document[] = [];
  const legalDoc = asNode(cfs.LegalDocumentReference);
  if (legalDoc) {
    const uri = text(
      (asNode(asNode(legalDoc.Attachment)?.ExternalReference))?.URI,
    );
    if (uri) {
      documents.push({ type: 'legal', id: text(legalDoc.ID), url: uri });
    }
  }
  const techDoc = asNode(cfs.TechnicalDocumentReference);
  if (techDoc) {
    const uri = text(
      (asNode(asNode(techDoc.Attachment)?.ExternalReference))?.URI,
    );
    if (uri) {
      documents.push({ type: 'technical', id: text(techDoc.ID), url: uri });
    }
  }
  for (const doc of asArray(cfs.AdditionalDocumentReference)) {
    const uri = text((asNode(asNode(doc.Attachment)?.ExternalReference))?.URI);
    if (uri) {
      documents.push({ type: 'additional', id: text(doc.ID), url: uri });
    }
  }

  // Awardee summary at top level: first ADJ-status result (result_code=8)
  const adjudicatedResults = results.filter((r) => r.result_code === '8');
  const primaryResult = adjudicatedResults[0] ?? results[0] ?? null;

  // Budget extraction
  const estimated_value = parseAmount(text(budget.EstimatedOverallContractAmount));
  const budget_without_tax = parseAmount(text(budget.TaxExclusiveAmount));
  const budget_with_tax = parseAmount(text(budget.TotalAmount));
  const currencyId =
    (asNode(budget.TaxExclusiveAmount)?._attrs?.currencyID ??
      asNode(budget.TotalAmount)?._attrs?.currencyID ??
      asNode(budget.EstimatedOverallContractAmount)?._attrs?.currencyID ??
      'EUR');

  return {
    source,
    id: idStr,
    updated_at,

    file_number: text(cfs.ContractFolderID),
    status_code: text(cfs.ContractFolderStatusCode),

    authority_name: text((asNode(party.PartyName) as RawNode)?.Name),
    authority_tax_id: partyIdBy(partyIds, 'NIF'),
    authority_dir3: partyIdBy(partyIds, 'DIR3'),
    authority_platform_id: partyIdBy(partyIds, 'ID_PLATAFORMA'),
    authority_city: text(postal.CityName),
    authority_postal_code: text(postal.PostalZone),
    authority_email: text(contact.ElectronicMail),
    authority_profile_url: text(party.BuyerProfileURIID),
    authority_hierarchy: buildHierarchy(asNode(lcp.ParentLocatedParty)),

    title: text(raw.title),
    subject: text(project.Name),
    summary: text(raw.summary),
    contract_type_code: text(project.TypeCode),
    subtype_code: text(project.SubTypeCode),
    main_cpv: cpvs[0] ?? null,
    cpvs,
    location_nuts: text(location.CountrySubentityCode),
    location_name: text(location.CountrySubentity),
    location_city: text(locationAddress.CityName),
    location_postal_code: text(locationAddress.PostalCode),
    duration_value,
    duration_unit,
    period_start: dateOnly(text(plannedPeriod.StartDate)),
    period_end: dateOnly(text(plannedPeriod.EndDate)),

    estimated_value,
    budget_without_tax,
    budget_with_tax,
    currency: currencyId,

    procedure_code: text(procurement.ProcedureCode),
    urgency_code: text(procurement.UrgencyCode),
    contracting_system_code: text(procurement.ContractingSystemCode),
    submission_method_code: text(procurement.SubmissionMethodCode),
    submission_deadline,
    documentation_deadline: dateOnly(text(docAvailability.EndDate)),
    publication_date,

    award_date: primaryResult?.award_date ?? null,
    award_amount_without_tax: primaryResult?.award_amount_without_tax ?? null,
    award_amount_with_tax: primaryResult?.award_amount_with_tax ?? null,
    awardee_name: primaryResult?.awardee_name ?? null,
    awardee_tax_id: primaryResult?.awardee_tax_id ?? null,
    tender_count: primaryResult?.tender_count ?? null,
    awardee_is_sme: primaryResult?.awardee_is_sme ?? null,
    result_code: primaryResult?.result_code ?? null,

    detail_url,

    lots,
    results,
    documents,
    raw_payload: raw,
  };
}

// ────────────────────────────────────────────────────────────────────
// discoverPeriods
// ────────────────────────────────────────────────────────────────────
const ZIP_BASE =
  'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3';
const FIRST_YEAR = 2012;

function buildUrl(periodCursor: string): string {
  return `${ZIP_BASE}_${periodCursor}.zip`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function discoverPeriods(opts: {
  fromCursor?: string;
  now?: Date;
}): Period[] {
  const now = opts.now ?? new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-12
  const currentCursor = `${currentYear}${pad2(currentMonth)}`;

  if (!opts.fromCursor) {
    // Bootstrap: annual ZIPs from FIRST_YEAR..currentYear-1, then current month
    const periods: Period[] = [];
    for (let y = FIRST_YEAR; y < currentYear; y++) {
      periods.push({
        cursor: String(y),
        url: buildUrl(String(y)),
        isCurrent: false,
      });
    }
    periods.push({
      cursor: currentCursor,
      url: buildUrl(currentCursor),
      isCurrent: true,
    });
    return periods;
  }

  // Incremental: from (cursor - 1 month) through current month
  const cursor = opts.fromCursor;
  let startYear: number, startMonth: number;
  if (cursor.length === 6) {
    startYear = parseInt(cursor.slice(0, 4), 10);
    startMonth = parseInt(cursor.slice(4, 6), 10) - 1; // step back one month
    if (startMonth < 1) {
      startMonth = 12;
      startYear -= 1;
    }
  } else {
    // Year cursor: start at January of next year
    startYear = parseInt(cursor, 10) + 1;
    startMonth = 1;
  }

  const periods: Period[] = [];
  let y = startYear;
  let m = startMonth;
  while (y < currentYear || (y === currentYear && m <= currentMonth)) {
    const c = `${y}${pad2(m)}`;
    periods.push({
      cursor: c,
      url: buildUrl(c),
      isCurrent: y === currentYear && m === currentMonth,
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return periods;
}

// ────────────────────────────────────────────────────────────────────
// downloadZip — HTTP streaming with If-Modified-Since
// ────────────────────────────────────────────────────────────────────
export interface DownloadResult {
  status: number;
  lastModified: string | null;
  etag: string | null;
  sizeBytes: number;
}

export async function downloadZip(
  url: string,
  destPath: string,
  opts: {
    ifModifiedSince?: Date;
    userAgent?: string;
    maxRetries?: number;
  } = {},
): Promise<DownloadResult | null> {
  const userAgent =
    opts.userAgent ?? 'sporttia-licitaciones-sync/1.0 (rruano@sporttia.com)';
  const maxRetries = opts.maxRetries ?? 3;
  await mkdir(dirname(destPath), { recursive: true });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = { 'user-agent': userAgent };
      if (opts.ifModifiedSince)
        headers['if-modified-since'] = opts.ifModifiedSince.toUTCString();

      const response = await fetch(url, { headers });

      if (response.status === 304) {
        return null;
      }
      if (response.status === 404) {
        return null;
      }
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} on ${url}`);
        await sleep(Math.pow(2, attempt) * 500);
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status} on ${url}`);
      }

      const body = response.body;
      if (!body) throw new Error('Empty body');

      const fileStream = createWriteStream(destPath);
      // Node Readable can be piped from Web ReadableStream via undici
      await pipeline(body as unknown as Readable, fileStream);

      return {
        status: response.status,
        lastModified: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
        sizeBytes: fileStream.bytesWritten,
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 500);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to download ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────
// streamAtoms — yields each .atom file inside a ZIP in lex order
// ────────────────────────────────────────────────────────────────────
export function streamAtoms(
  zipPath: string,
): AsyncIterable<{ name: string; stream: Readable }> {
  return {
    [Symbol.asyncIterator]() {
      return createAtomIterator(zipPath);
    },
  };
}

function createAtomIterator(
  zipPath: string,
): AsyncIterator<{ name: string; stream: Readable }> {
  let zipfile: yauzl.ZipFile | null = null;
  let entries: yauzl.Entry[] | null = null;
  let cursor = 0;
  let openError: Error | null = null;
  let openPromise: Promise<void> | null = null;

  async function ensureOpen() {
    if (zipfile && entries) return;
    if (!openPromise) {
      openPromise = new Promise<void>((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zf) => {
          if (err) {
            openError = err;
            return reject(err);
          }
          zipfile = zf;
          const collected: yauzl.Entry[] = [];
          zf.on('entry', (entry) => {
            collected.push(entry);
            zf.readEntry();
          });
          zf.on('end', () => {
            entries = collected
              .filter((e) => e.fileName.toLowerCase().endsWith('.atom'))
              .sort((a, b) => a.fileName.localeCompare(b.fileName));
            resolve();
          });
          zf.on('error', (e) => {
            openError = e;
            reject(e);
          });
          zf.readEntry();
        });
      });
    }
    await openPromise;
    if (openError) throw openError;
  }

  return {
    async next() {
      await ensureOpen();
      if (!entries || cursor >= entries.length) {
        zipfile?.close();
        return { value: undefined as never, done: true };
      }
      const entry = entries[cursor++];
      return await new Promise<
        IteratorResult<{ name: string; stream: Readable }>
      >((resolve, reject) => {
        zipfile!.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          resolve({
            value: { name: entry.fileName, stream: stream as Readable },
            done: false,
          });
        });
      });
    },
    async return() {
      zipfile?.close();
      return { value: undefined as never, done: true };
    },
  };
}

export type { Readable };
