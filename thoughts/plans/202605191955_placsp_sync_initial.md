# Plan: Sync de licitaciones PLACSP a Postgres (Node.js + Cloud Run Job) — versión simple

## 📋 User Request

> Usa este repositorio de git https://github.com/BquantFinance/licitaciones-espana/tree/main y crea un script en node js que ejecutaremos desde un scheduler de google cloud para que actualice los datos de licitaciones de toda españa. Por el momento solo quiero las de PLACSP. Lo que necesito es que coja los datos y los normalice por lo que necesito que verifiques cual debería ser la estructura clave. Finalmente estos datos deben ser guardados en una base de datos en postgres lo mas sencillo posible y con la mayor cantidad de datos posible que sea util. Esto va a ser utilizado por nuestro sistema de alertas propio de licitaciones, analisis de las mismas, analisis de contratos de la competencia etc... Ten en cuenta problemas de ejecución a la vez de dos veces la sincronización, la primera sincronización es de todo pero las futuras deberán ser desde la ultima actualización que se realizó, tiene que ser lo mas escalable y rapido posible. A postgres conectate con drizzle orm por ejemplo o si ves que es muy complejo y no merece la pena directamente con la libreria de postgres. Debe poder ejecutarse n veces seguidas sin duplicar datos. Destacar que si vamos a tener una tabla con todas las licitaciones tener en cuenta añadir un campo de donde viene la licitacion porque en el futuro probablemente añadamos licitaciones de la junta de andalucia, comunidad de madrid... Añade logs para verificar que se ejecuta y todo el proceso que realiza.

**Feedback acumulado del usuario:**
- v2: simplificar (no hexagonal), vertical slicing si hace falta.
- v3: **mínimo de tablas**, **todos los campos en inglés**, **complejidad 0**, sólo PLACSP por ahora, "ya pelearemos los otros proveedores en el futuro".

## 🔍 Research Used

- [202605191955_placsp-sync-research.md](../research/202605191955_placsp-sync-research.md) — endpoints PLACSP, mapeo CODICE→SQL, quirks, stack GCP.

## 🎯 Goal

Script Node.js + TS muy simple ejecutado desde Cloud Scheduler → Cloud Run Job:

1. **Bootstrap**: descarga histórico canal PLACSP 643 (2012→presente).
2. **Incremental**: mes corriente + mes anterior cada corrida (idempotente).
3. **Sin duplicados** por `ON CONFLICT (source, id) DO UPDATE`.
4. **Sin solapes** con tabla `sync_locks` + heartbeat.
5. **Logs JSON** para Cloud Logging.
6. **Mínima superficie**: 6 archivos `.ts`, 3 tablas SQL.
7. Columna `source` reservada para añadir CCAA en el futuro (sin más maquinaria).

## 📐 Current State

- Repo `licitaciones-sync` vacío (sólo `.git`).
- Branch actual: `master`. No commits todavía.
- No hay infraestructura GCP creada.

## 🏁 Desired End State

```
licitaciones-sync/
├── src/
│   ├── index.ts      # entrypoint: aplica migraciones (si RUN_MIGRATIONS) y llama sync()
│   ├── env.ts        # validación zod
│   ├── logger.ts     # pino + preset GCP
│   ├── db.ts         # schema drizzle + client postgres.js + helpers (upsert, markDeleted, lock, syncState)
│   ├── placsp.ts     # downloadZip, streamAtoms, parseAtom, mapEntry, discoverPeriods, parseAmount
│   └── sync.ts       # pipeline principal: lock → discover → por period (download + parse + upsert) → release
├── tests/
│   ├── env.test.ts
│   ├── placsp.test.ts     # parseAmount + parseAtom + mapEntry + discoverPeriods
│   ├── db.test.ts         # idempotencia upsert + lock concurrente
│   └── fixtures/
│       ├── entry-basico.atom
│       ├── entry-completa.atom
│       ├── entry-coma-decimal.atom
│       ├── feed-tombstone.atom
│       └── sample.zip
├── drizzle/0000_initial.sql
├── docker/Dockerfile
├── infra/README.md
├── drizzle.config.ts
├── tsconfig.json
├── vitest.config.ts
├── package.json
├── .env.example
└── README.md
```

6 archivos en `src/`. 3 tablas en Postgres. Cero abstracciones de más.

Añadir Junta de Andalucía en el futuro: copiar `placsp.ts` a `andalucia.ts` con su propio mapper y descargador, llamar `sync('andalucia')` en `index.ts`. No hay nada más.

## 🚫 Out of Scope

- Otros canales PLACSP (1044 agregadas, 1143 menores, 1383 encargos, 1403 CPM).
- Otras fuentes (Andalucía, Madrid…). Sólo se reserva la columna `source`.
- Tablas hijas relacionales (lots/results/documents) — todo en JSONB dentro de `tenders`.
- Catálogos como tablas (tipos contrato, procedimientos…) — códigos crudos.
- Tabla maestra de órganos — denormalizado.
- PDFs de pliegos — sólo URLs en JSONB.
- Near-real-time. v1 sólo cron diario.
- Terraform.

## 🗺️ Implementation Approach

### Esquema mínimo: 3 tablas

```sql
CREATE TABLE tenders (
  source                    varchar(32) NOT NULL,            -- 'placsp' (futuro: 'andalucia'…)
  id                        text        NOT NULL,            -- entry/id URI (estable)
  updated_at                timestamptz NOT NULL,            -- entry/updated
  ingested_at               timestamptz NOT NULL DEFAULT NOW(),

  file_number               text,                            -- ContractFolderID (expediente)
  status_code               varchar(16),                     -- PRE/PUB/EV/ADJ/RES/ANUL

  -- contracting authority
  authority_name            text,
  authority_tax_id          varchar(32),                     -- NIF
  authority_dir3            varchar(32),
  authority_platform_id     text,
  authority_city            text,
  authority_postal_code     varchar(16),
  authority_email           text,
  authority_profile_url     text,
  authority_hierarchy       text,

  -- subject
  title                     text,
  subject                   text,
  summary                   text,
  contract_type_code        varchar(8),
  subtype_code              varchar(16),
  main_cpv                  varchar(16),
  cpvs                      text[]        NOT NULL DEFAULT '{}',
  location_nuts             varchar(16),
  location_name             text,
  location_city             text,
  location_postal_code      varchar(16),
  duration_value            integer,
  duration_unit             varchar(8),                      -- DAY/MON/ANN
  period_start              date,
  period_end                date,

  -- amounts
  estimated_value           numeric(18,2),
  budget_without_tax        numeric(18,2),
  budget_with_tax           numeric(18,2),
  currency                  varchar(3) DEFAULT 'EUR',

  -- procedure
  procedure_code            varchar(8),
  urgency_code              varchar(8),
  contracting_system_code   varchar(8),
  submission_method_code    varchar(8),
  submission_deadline       timestamptz,
  documentation_deadline    date,
  publication_date          date,

  -- award (summary; full detail in `results`)
  award_date                date,
  award_amount_without_tax  numeric(18,2),
  award_amount_with_tax     numeric(18,2),
  awardee_name              text,
  awardee_tax_id            varchar(32),
  tender_count              integer,
  awardee_is_sme            boolean,
  result_code               varchar(8),

  detail_url                text,
  deleted_at                timestamptz,
  deleted_reason            varchar(16),                     -- 'ANULADA' / 'CERRADA'

  -- structured collections (no extra tables)
  lots                      jsonb NOT NULL DEFAULT '[]',
  results                   jsonb NOT NULL DEFAULT '[]',
  documents                 jsonb NOT NULL DEFAULT '[]',
  raw_payload               jsonb NOT NULL,                  -- full CODICE blob

  PRIMARY KEY (source, id)
);

CREATE INDEX tenders_updated_idx          ON tenders (updated_at DESC);
CREATE INDEX tenders_status_idx           ON tenders (status_code);
CREATE INDEX tenders_authority_tax_idx    ON tenders (authority_tax_id);
CREATE INDEX tenders_awardee_tax_idx      ON tenders (awardee_tax_id);
CREATE INDEX tenders_main_cpv_idx         ON tenders (main_cpv);
CREATE INDEX tenders_cpvs_gin             ON tenders USING GIN (cpvs);
CREATE INDEX tenders_publication_idx      ON tenders (publication_date DESC);
CREATE INDEX tenders_source_idx           ON tenders (source);

CREATE TABLE sync_state (
  source             varchar(32) PRIMARY KEY,
  last_run_at        timestamptz NOT NULL,
  last_success_at    timestamptz,
  last_cursor        varchar(16),                            -- 'YYYYMM'
  last_entry_updated timestamptz,
  last_error         text
);

CREATE TABLE sync_locks (
  name        varchar(64) PRIMARY KEY,
  locked_at   timestamptz NOT NULL,
  heartbeat   timestamptz NOT NULL,
  instance_id text NOT NULL
);
```

**Justificación de minimalismo**:
- `lots`, `results`, `documents` como JSONB en lugar de tablas hijas: pierde queries SQL relacionales sobre lotes individuales, pero gana simplicidad enorme. Postgres permite indexar JSONB con GIN si más adelante hace falta. v1 prioriza velocidad de desarrollo y cobertura de los casos de uso del usuario (alertas y análisis competencia consultan el `awardee_tax_id` / `main_cpv` / `status_code` de la tabla principal, no detalles de lotes).
- `cpvs text[]` con índice GIN: queries "tenders con CPV X" siguen siendo eficientes.
- `raw_payload jsonb` preserva absolutamente todo el CODICE para casos futuros no previstos.
- `source` columna desde el día 1: PK `(source, id)` no aumenta complejidad y bloquea colisiones futuras.

### Idempotencia y locking

- `ON CONFLICT (source, id) DO UPDATE SET … WHERE excluded.updated_at >= tenders.updated_at` — re-correr N veces deja exactamente los mismos datos.
- `sync_locks` con heartbeat 60s, lock zombi expira a 30 min.
- Bootstrap (sin `sync_state['placsp']`): descarga años 2012 → (año actual − 1) + mes corriente.
- Incremental: mes corriente + mes anterior.

### TDD

Vitest desde el inicio. TDD focalizado donde más vale:
- `parseAmount` (decimales coma/punto).
- `mapEntry` (CODICE → row).
- `upsertTenders` (idempotencia hard).
- `acquireLock` (concurrencia).

I/O (download/extract) con MockAgent de undici, sin red real.

## 🪜 Steps

### Step 1 — Scaffold

**Status:** ⬜ Pending

**What:** `package.json` (type=module, node ≥22, scripts npm), `tsconfig.json` (ES2022, NodeNext, strict), `vitest.config.ts`, `.gitignore`, `.env.example`.

**Why:** Cimiento. Sin esto, nada arranca.

**How:**
- Runtime deps: `postgres drizzle-orm sax yauzl pino @google-cloud/pino-logging-gcp-config undici zod`.
- Dev deps: `typescript tsx vitest drizzle-kit @types/node @types/sax @types/yauzl`.
- Scripts: `build` (`tsc`), `sync` (`tsx src/index.ts`), `test` (`vitest run`), `test:watch` (`vitest`), `lint` (`tsc --noEmit`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`drizzle-kit migrate`).
- `.env.example` con `DATABASE_URL`, `CLOUDSQL_INSTANCE`, `LOG_LEVEL`, `PLACSP_USER_AGENT`, `TMP_DIR`, `BATCH_SIZE`, `LOCK_HEARTBEAT_INTERVAL_MS`, `LOCK_STALE_AFTER_MS`, `GOOGLE_CLOUD_PROJECT`.

**TDD — failing test to write first:** No aplica (instalación).

**Acceptance criteria:**
- [ ] `npm install` sin errores.
- [ ] `npm run lint` no falla.
- [ ] `npm test` arranca Vitest.

**Depends on:** —

---

### Step 2 — `src/db.ts` (schema) + `drizzle.config.ts` + migración inicial

**Status:** ⬜ Pending

**What:** Schema drizzle con las 3 tablas y migración generada.

**Why:** Contrato SQL antes que cualquier código que lo use.

**How:**
- `src/db.ts` exporta los tres `pgTable` (`tenders`, `syncState`, `syncLocks`) en inglés exactamente como en la spec arriba.
- `drizzle.config.ts` apunta a `src/db.ts`, dialecto postgresql, out `./drizzle`.
- `npx drizzle-kit generate` → `drizzle/0000_initial.sql`, commitear.

**TDD — failing test to write first:** No aplica (declarativo).

**Acceptance criteria:**
- [ ] Migración generada y aplicable contra Postgres local sin errores.
- [ ] El SQL contiene las 3 tablas, los índices listados (incluyendo GIN sobre `cpvs`).

**Depends on:** Step 1.

---

### Step 3 — `src/env.ts` + `src/logger.ts`

**Status:** ⬜ Pending

**What:** Validación zod de env vars y logger pino con preset GCP. Idéntico al planteado anteriormente.

**Why:** Centralizar config y logging. Logs estructurados son requisito (`Añade logs para verificar que se ejecuta`).

**How:**
- `env.ts`: schema zod, defaults razonables, falla rápido si falta `DATABASE_URL`.
- `logger.ts`: pino con `createGcpLoggingPinoConfig`, child con trace id aleatorio + labels Cloud Run (`CLOUD_RUN_JOB`, `CLOUD_RUN_EXECUTION`, `CLOUD_RUN_TASK_INDEX`).

**TDD — failing test to write first:**
`tests/env.test.ts`:
```ts
it('throws when DATABASE_URL missing', () => {
  expect(() => loadEnv({})).toThrow();
});
it('applies defaults', () => {
  expect(loadEnv({ DATABASE_URL: '...' }).BATCH_SIZE).toBe(500);
});
it('coerces numeric env from string', () => {
  expect(loadEnv({ DATABASE_URL:'...', BATCH_SIZE:'250' }).BATCH_SIZE).toBe(250);
});
```

Refactor `env.ts` para exponer `loadEnv(source)` además de `env` por defecto, así el test no depende de `process.env`.

**Acceptance criteria:**
- [ ] Tests verdes.
- [ ] Logger imprime JSON con `severity`, `message`, `time`, `logging.googleapis.com/trace`, `logging.googleapis.com/labels`.

**Depends on:** Step 1.

---

### Step 4 — `tests/fixtures/*.atom` + `tests/fixtures/sample.zip`

**Status:** ⬜ Pending

**What:** 4 fixtures XML + 1 ZIP de prueba (3 `.atom` + 1 `.txt`).

**Why:** Sin fixtures reales no se puede TDD el parser/mapper. Los namespaces DGPE-PLACE son la fuente principal de bugs silenciosos.

**How:** Adaptar el ejemplo del apartado 3 de la spec PLACSP (ver investigación, sección 1.3 y 1.6). Cada fixture cubre un caso:
- `entry-basico.atom`: campos mínimos + estado=PUB.
- `entry-completa.atom`: 2 lotes, CPVs múltiples, 2 `TenderResult` (uno ADJ + uno DES), publicación oficial.
- `entry-coma-decimal.atom`: importes en coma decimal.
- `feed-tombstone.atom`: `<at:deleted-entry ref=... when=...><at:comment type="ANULADA"/></at:deleted-entry>`.
- `sample.zip`: empaqueta `a.atom`, `b.atom`, `c.atom`, `ignored.txt` (para test de `streamAtoms`).

**TDD — failing test to write first:** Test smoke `tests/placsp.test.ts > fixtures parse without error`.

**Acceptance criteria:**
- [ ] Los 5 ficheros existen.
- [ ] Cada `.atom` parsea como XML válido con sax.

**Depends on:** Step 1.

---

### Step 5 — `src/placsp.ts` · `parseAmount` (TDD)

**Status:** ⬜ Pending

**What:** Función pura exportada de `placsp.ts`:
```ts
export function parseAmount(raw: string | undefined | null): number | null
```

**Why:** Quirk #1 (decimales coma/punto en la misma entry).

**How:** Reemplazar `,` por `.`, trim, parseFloat, validar NaN.

**TDD — failing test to write first:** En `tests/placsp.test.ts`, sub-describe `parseAmount`:
```ts
describe('parseAmount', () => {
  it.each([
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
  ])('parseAmount(%s) -> %s', (input, expected) => {
    expect(parseAmount(input as any)).toBe(expected);
  });
});
```

**Acceptance criteria:**
- [ ] 10 cases verde.

**Depends on:** Step 1.

---

### Step 6 — `src/placsp.ts` · `parseAtom` SAX streaming (TDD)

**Status:** ⬜ Pending

**What:** Función `parseAtom(input: Readable): AsyncIterable<AtomEvent>` que emite:
```ts
type AtomEvent =
  | { type: 'entry'; raw: RawEntry }
  | { type: 'tombstone'; ref: string; when: string; reason: string | null }
  | { type: 'feedUpdated'; when: string }
  | { type: 'nextLink'; url: string };
```

`RawEntry` es un árbol JS con local-names (sin prefijos), atributos en `_attrs`, tags repetidos coalescidos a array.

**Why:** Streaming obligatorio (`.atom` puede ser cientos de MB). Resolver por namespace URI (no prefijo) inmuniza el código.

**How:** `sax.createStream(true, { xmlns: true, trim: true })`. Stack de objetos. URIs conocidas como constantes (`NS_ATOM`, `NS_CAC`, `NS_CBC`, `NS_CAC_PLACE_EXT`, `NS_CBC_PLACE_EXT`, `NS_TOMBSTONES`). Convertir EventEmitter SAX a AsyncIterable con un buffer + Promise.

**TDD — failing test to write first:** En `tests/placsp.test.ts > describe parseAtom`:
```ts
it('emits entry for entry-basico.atom', async () => {
  const evs = await collect(parseAtom(fs.createReadStream('tests/fixtures/entry-basico.atom')));
  const entries = evs.filter(e => e.type === 'entry');
  expect(entries).toHaveLength(1);
  expect(entries[0].raw.id).toMatch(/^https:\/\//);
});

it('coalesces repeated tags into arrays', async () => {
  const evs = await collect(parseAtom(fs.createReadStream('tests/fixtures/entry-completa.atom')));
  const entry = (evs.find(e => e.type === 'entry') as any).raw;
  expect(Array.isArray(entry.ContractFolderStatus.ProcurementProjectLot)).toBe(true);
  expect(entry.ContractFolderStatus.ProcurementProjectLot.length).toBe(2);
});

it('emits tombstone with reason', async () => {
  const evs = await collect(parseAtom(fs.createReadStream('tests/fixtures/feed-tombstone.atom')));
  const tombs = evs.filter(e => e.type === 'tombstone') as any[];
  expect(tombs).toHaveLength(1);
  expect(tombs[0].reason).toBe('ANULADA');
});
```

**Acceptance criteria:**
- [ ] Tests verdes.
- [ ] Sin carga completa en memoria.

**Depends on:** Step 4.

---

### Step 7 — `src/placsp.ts` · `mapEntry` (TDD intensivo)

**Status:** ⬜ Pending

**What:** Función `mapEntry(raw: RawEntry, source = 'placsp'): Tender`. Todos los campos planos definidos en el schema (Step 2) + arrays/jsonb (`cpvs`, `lots`, `results`, `documents`, `raw_payload`).

**Why:** Pieza con más superficie de bug. TDD obligatoria.

**How:**
- Helpers internos privados: `getId(partyIds, schemeName)`, `buildHierarchy(parent)`, `parseDate(s)`, `parseTimestamp(s)`.
- Aplicar `parseAmount` a todos los importes.
- Para `lots`/`results`/`documents` mapear a objetos JS planos serializables a JSONB.
- `raw_payload` = `raw` entero.
- Si falta un campo, devolver `null` (jamás lanzar).

**TDD — failing test to write first:**
```ts
describe('mapEntry', () => {
  let basico: any, completa: any, comaDecimal: any;
  beforeAll(async () => {
    basico = await loadEntry('entry-basico.atom');
    completa = await loadEntry('entry-completa.atom');
    comaDecimal = await loadEntry('entry-coma-decimal.atom');
  });

  it('sets source field', () => {
    expect(mapEntry(basico).source).toBe('placsp');
  });
  it('maps id and updated_at as Date', () => {
    const t = mapEntry(basico);
    expect(t.id).toMatch(/^https:\/\//);
    expect(t.updated_at).toBeInstanceOf(Date);
  });
  it('maps status_code', () => { expect(mapEntry(basico).status_code).toBe('PUB'); });
  it('maps authority NIF, DIR3, platform_id', () => { ... });
  it('builds authority_hierarchy recursively', () => { ... });
  it('maps three amount variants', () => { ... });
  it('normalizes comma decimals', () => {
    const t = mapEntry(comaDecimal);
    expect(t.budget_with_tax).toBe(5989390.79);
    expect(t.budget_without_tax).toBe(4949909.74);
  });
  it('puts CPVs into cpvs array, main_cpv = first', () => {
    const t = mapEntry(completa);
    expect(t.main_cpv).toBe(t.cpvs[0]);
    expect(t.cpvs.length).toBeGreaterThan(1);
  });
  it('produces lots as serializable jsonb', () => {
    const t = mapEntry(completa);
    expect(Array.isArray(t.lots)).toBe(true);
    expect(t.lots.length).toBe(2);
    expect(() => JSON.stringify(t.lots)).not.toThrow();
  });
  it('produces results array (one per TenderResult)', () => {
    const t = mapEntry(completa);
    expect(t.results.length).toBe(2);
    expect(t.results[0]).toHaveProperty('awardee_tax_id');
  });
  it('produces documents array', () => { ... });
  it('preserves raw_payload as object', () => {
    const t = mapEntry(basico);
    expect(() => JSON.stringify(t.raw_payload)).not.toThrow();
  });
  it('returns nulls for missing fields (no throws)', () => { ... });
});
```

**Acceptance criteria:**
- [ ] Tests verdes.
- [ ] `mapEntry` no lanza nunca (null si falta).
- [ ] `raw_payload`, `lots`, `results`, `documents` JSON-serializables.

**Depends on:** Step 5, Step 6.

---

### Step 8 — `src/placsp.ts` · `discoverPeriods` + `downloadZip` + `streamAtoms`

**Status:** ⬜ Pending

**What:** Tres funciones más en `placsp.ts`:

```ts
export interface Period { cursor: string; url: string; isCurrent: boolean; }

export function discoverPeriods(opts: { fromCursor?: string; now?: Date }): Period[];

export async function downloadZip(
  url: string,
  destPath: string,
  opts?: { ifModifiedSince?: Date; userAgent?: string }
): Promise<{ status: number; lastModified: string|null; etag: string|null; sizeBytes: number } | null>;

export function streamAtoms(zipPath: string): AsyncIterable<{ name: string; stream: Readable }>;
```

**Why:** Tres funciones que reúnen toda la lógica de I/O específica de PLACSP.

**How:**
- `discoverPeriods`:
  - Sin cursor (bootstrap): años `2012` → `now.year - 1` como ZIP anuales + mes corriente `YYYYMM` como ZIP mensual.
  - Con cursor `'YYYYMM'`: meses `[cursor-1, …, currentMonth]`.
  - URL pattern: `https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3_{periodo}.zip`.
- `downloadZip`: `undici.fetch` con `If-Modified-Since` opcional, `pipeline(body, createWriteStream)`. Retries exponencial 3×. 304/404 → `null`.
- `streamAtoms`: `yauzl.open({lazyEntries:true})`, recolectar `.atom`, ordenar lex, async generator que abre `openReadStream` por cada uno.

**TDD — failing test to write first:**
```ts
describe('discoverPeriods', () => {
  it('bootstrap returns annual ZIPs 2012..lastYear plus current month', () => {
    const ps = discoverPeriods({ now: new Date('2026-05-19T00:00:00Z') });
    const cursors = ps.map(p => p.cursor);
    expect(cursors).toContain('2012');
    expect(cursors).toContain('2025');
    expect(cursors).toContain('202605');
    expect(cursors).not.toContain('2026');
  });
  it('incremental returns previous + current month', () => {
    const ps = discoverPeriods({ fromCursor: '202604', now: new Date('2026-05-19') });
    expect(ps.map(p => p.cursor)).toEqual(['202604', '202605']);
  });
  it('builds correct URL pattern', () => {
    const ps = discoverPeriods({ now: new Date('2026-05-19') });
    expect(ps.find(p => p.cursor === '2023')!.url).toMatch(/_2023\.zip$/);
    expect(ps.find(p => p.cursor === '202605')!.url).toMatch(/_202605\.zip$/);
  });
});

describe('downloadZip', () => {
  it('returns null on 304', async () => { /* MockAgent undici */ });
  it('writes body to disk on 200', async () => { ... });
  it('returns null on 404', async () => { ... });
  it('retries on 503', async () => { ... });
});

describe('streamAtoms', () => {
  it('emits .atom files in lex order, ignoring others', async () => {
    const seen: string[] = [];
    for await (const { name, stream } of streamAtoms('tests/fixtures/sample.zip')) {
      seen.push(name);
      stream.resume();
    }
    expect(seen).toEqual(['a.atom', 'b.atom', 'c.atom']);
  });
});
```

**Acceptance criteria:**
- [ ] Tests verdes (red real mockeada con undici MockAgent).
- [ ] streamAtoms no carga ZIP completo en memoria.

**Depends on:** Step 4.

---

### Step 9 — `src/db.ts` · helpers (`upsertTenders`, `markDeleted`, `acquireLock`, syncState CRUD) + tests integración

**Status:** ⬜ Pending

**What:** Extender `db.ts` con funciones que operan contra la DB. Sin clases — funciones que toman el `db` drizzle como primer argumento.

```ts
export function createDb(): Db;                                          // factory: postgres.js + drizzle
export async function upsertTenders(db: Db, batch: Tender[]): Promise<{ inserted: number; updated: number }>;
export async function markDeleted(db: Db, source: string, id: string, when: Date, reason: string|null): Promise<void>;
export async function acquireLock(db: Db, name: string, opts: { staleAfterMs: number; heartbeatMs: number }): Promise<Lock | null>;
export interface Lock { instanceId: string; release(): Promise<void>; }
export async function readSyncState(db: Db, source: string): Promise<SyncStateRow | null>;
export async function markRunStart(db: Db, source: string): Promise<void>;
export async function markRunSuccess(db: Db, source: string, cursor: string, lastEntryUpdated: Date): Promise<void>;
export async function markRunFailure(db: Db, source: string, error: string): Promise<void>;
```

**Why:** Toda interacción con Postgres aquí. Funciones planas, sin DI, sin clases.

**How:**
- `upsertTenders`: `INSERT … ON CONFLICT (source, id) DO UPDATE SET … WHERE excluded.updated_at >= tenders.updated_at`. Helper `buildConflictUpdateColumns` para el SET dinámico. Batch interno 500.
- `acquireLock`: INSERT/ON CONFLICT DO UPDATE WHERE heartbeat < NOW() - INTERVAL, RETURNING instance_id. Si coincide → `setInterval` heartbeat. `release()` clearInterval + DELETE.
- `syncState`: SELECT/UPSERT trivial.

**TDD — failing test to write first:** `tests/db.test.ts` con Postgres real (testcontainer o `pg-mem` si funciona):
```ts
describe('upsertTenders', () => {
  it('inserts new rows', async () => { ... });
  it('is idempotent (5 reruns leave same rows)', async () => {
    for (let i = 0; i < 5; i++) await upsertTenders(db, [mk('1', '2026-01-01')]);
    const rows = await db.select().from(tenders);
    expect(rows).toHaveLength(1);
  });
  it('updates when newer updated_at', async () => { ... });
  it('ignores older updated_at', async () => { ... });
  it('stores cpvs[], lots, results, documents, raw_payload', async () => { ... });
  it('markDeleted sets deleted_at and reason', async () => { ... });
});

describe('acquireLock', () => {
  it('acquires when empty', async () => { ... });
  it('refuses concurrent acquisition', async () => {
    const a = await acquireLock(db, 't', opts);
    const b = await acquireLock(db, 't', opts);
    expect(b).toBeNull();
    await a!.release();
  });
  it('steals expired lock', async () => { ... });
  it('release removes only own lock', async () => { ... });
});

describe('syncState', () => {
  it('returns null when none', async () => { ... });
  it('persists run lifecycle', async () => { ... });
});
```

**Acceptance criteria:**
- [ ] Tests verdes contra Postgres real.
- [ ] Idempotencia hard verificada (re-ejecutar mismo dato 5 veces → mismas filas).
- [ ] Lock liberado en happy path y error path.

**Depends on:** Step 2, Step 5, Step 7.

---

### Step 10 — `src/sync.ts` · pipeline principal

**Status:** ⬜ Pending

**What:** Función `sync(db, logger): Promise<SyncResult>` que orquesta todo. Sin clases, sin interfaces SyncProvider, sólo una función.

```ts
export async function sync(db: Db, logger: Logger): Promise<SyncResult | null> {
  const source = 'placsp';
  const log = logger.child({ source });
  const lock = await acquireLock(db, 'placsp_sync', { staleAfterMs: env.LOCK_STALE_AFTER_MS, heartbeatMs: env.LOCK_HEARTBEAT_INTERVAL_MS });
  if (!lock) { log.warn('lock not acquired, exiting'); return null; }

  let entriesUpserted = 0, tombstones = 0;
  let lastEntryUpdated: Date | null = null;
  let lastCursor: string | null = null;

  try {
    const state = await readSyncState(db, source);
    await markRunStart(db, source);
    const periods = discoverPeriods({ fromCursor: state?.lastCursor ?? undefined });
    log.info({ mode: state ? 'incremental' : 'bootstrap', periods: periods.length }, 'starting sync');

    for (const period of periods) {
      log.info({ period: period.cursor, url: period.url }, 'processing period');
      const zipPath = path.join(env.TMP_DIR, `${period.cursor}.zip`);
      await fs.mkdir(env.TMP_DIR, { recursive: true });
      const meta = await downloadZip(period.url, zipPath, { userAgent: env.PLACSP_USER_AGENT });
      if (!meta) { log.warn({ period: period.cursor }, 'zip not available, skipping'); continue; }

      let buffer: Tender[] = [];
      for await (const { name, stream } of streamAtoms(zipPath)) {
        log.debug({ period: period.cursor, atom: name }, 'parsing atom');
        for await (const ev of parseAtom(stream)) {
          if (ev.type === 'tombstone') {
            await markDeleted(db, source, ev.ref, new Date(ev.when), ev.reason);
            tombstones++;
          } else if (ev.type === 'entry') {
            const t = mapEntry(ev.raw, source);
            buffer.push(t);
            if (!lastEntryUpdated || t.updated_at > lastEntryUpdated) lastEntryUpdated = t.updated_at;
            if (buffer.length >= env.BATCH_SIZE) {
              const r = await upsertTenders(db, buffer);
              entriesUpserted += r.inserted + r.updated;
              buffer = [];
            }
          }
        }
      }
      if (buffer.length) {
        const r = await upsertTenders(db, buffer);
        entriesUpserted += r.inserted + r.updated;
      }
      await fs.rm(zipPath, { force: true });
      lastCursor = period.cursor;
      if (lastEntryUpdated) await markRunSuccess(db, source, period.cursor, lastEntryUpdated);
      log.info({ period: period.cursor, entriesUpserted, tombstones }, 'period done');
    }

    log.info({ entriesUpserted, tombstones, periods: periods.length }, 'sync completed');
    return { source, periodsProcessed: periods.length, entriesUpserted, tombstones, lastCursor, lastEntryUpdated };
  } catch (err) {
    await markRunFailure(db, source, String(err));
    log.error({ err }, 'sync failed');
    throw err;
  } finally {
    await lock.release();
  }
}
```

**Why:** Una función. Sin abstracciones. Lee desde arriba a abajo y se entiende.

**How:** Importa de `placsp.ts` (`discoverPeriods`, `downloadZip`, `streamAtoms`, `parseAtom`, `mapEntry`) y `db.ts` (`acquireLock`, `upsertTenders`, `markDeleted`, `readSyncState`, `markRunStart`, `markRunSuccess`, `markRunFailure`).

**TDD — failing test to write first:** Test de integración ligero opcional en `tests/sync.test.ts`. Como las piezas individuales ya están testeadas, validamos sólo:
```ts
it('runs end-to-end against a real ZIP fixture and Postgres', async () => {
  // Stub HTTP server local sirviendo tests/fixtures/sample-monthly.zip
  // Llamar sync() y verificar que tenders.count > 0 y sync_state.last_cursor está actualizado
});
```

Si este test es demasiado costoso, marcarlo como `.skip` y validar manualmente en Step 11.

**Acceptance criteria:**
- [ ] Lock se libera en happy path y error path.
- [ ] Cursor avanza por periodo, no al final.
- [ ] Logs cubren: inicio, descubrimiento de periodos, descarga de cada ZIP, parseo de cada `.atom`, batches insertados, fin de periodo, fin global.

**Depends on:** Step 8, Step 9.

---

### Step 11 — `src/index.ts` + smoke local

**Status:** ⬜ Pending

**What:** Entrypoint que aplica migraciones (si `RUN_MIGRATIONS=true`) y llama `sync()`.

```ts
import { env } from './env.js';
import { logger } from './logger.js';
import { createDb } from './db.js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sync } from './sync.js';

async function main() {
  logger.info({ tmpDir: env.TMP_DIR, batchSize: env.BATCH_SIZE }, 'starting licitaciones-sync');
  const db = createDb();
  if (process.env.RUN_MIGRATIONS === 'true') {
    logger.info('applying migrations');
    await migrate(db as any, { migrationsFolder: './drizzle' });
  }
  const result = await sync(db, logger);
  logger.info(result ?? { skipped: true }, 'done');
}

main().catch((err) => { logger.fatal({ err }, 'fatal'); process.exit(1); });
```

**Why:** Composición en 20 líneas.

**How:** Listo arriba.

**TDD — failing test to write first:** No aplica (composition root). Smoke manual local:
```bash
docker run -d --name pg -e POSTGRES_PASSWORD=x -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:x@localhost/postgres RUN_MIGRATIONS=true npm run sync
# verificar: SELECT count(*) FROM tenders;
# re-ejecutar y verificar mismo count
```

**Acceptance criteria:**
- [ ] `npm run sync` local descarga al menos el mes corriente, parsea, inserta filas.
- [ ] Re-ejecutar 3 veces seguidas → mismo count, mismos `updated_at`.
- [ ] Ejecutar dos en paralelo → el segundo sale con log "lock not acquired".

**Depends on:** Step 10.

---

### Step 12 — `docker/Dockerfile`

**Status:** ⬜ Pending

**What:** Dockerfile multi-stage para Cloud Run Job.

**How:**
```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
USER node
CMD ["node", "dist/index.js"]
```

**Acceptance criteria:**
- [ ] `docker build` ok, imagen < 250 MB.
- [ ] `docker run --env-file .env` arranca local.

**Depends on:** Step 11.

---

### Step 13 — `infra/README.md` + `README.md`

**Status:** ⬜ Pending

**What:**
- `infra/README.md` (es): comandos `gcloud` paso a paso (habilitar APIs, Artifact Registry, Cloud SQL, Secret Manager, Cloud Run Job, Service Accounts + roles, Cloud Scheduler con OAuth, verificación).
- `README.md` (es) raíz: propósito 1 párrafo, diagrama ASCII, dev local con Docker Postgres, env vars, tabla de columnas principales (para el equipo de alertas), link a infra/, y nota "Cómo añadir un nuevo proveedor: copiar `src/placsp.ts` a `src/<nombre>.ts`, exportar `sync<Nombre>(db, logger)`, llamarlo desde `index.ts`".

**Acceptance criteria:**
- [ ] Cualquier dev arranca local en <10 min siguiendo el README.
- [ ] Cualquier devops puede desplegar siguiendo `infra/README.md`.

**Depends on:** Step 12.

---

## ✅ Final Acceptance Criteria

- [ ] `npm install && npm test` todos los tests verdes.
- [ ] `npm run sync` local carga el mes corriente sin errores.
- [ ] Re-ejecutar 5× → exactamente las mismas filas (idempotencia).
- [ ] Dos `npm run sync` en paralelo → el segundo sale con "lock not acquired".
- [ ] La PK `(source, id)` permite filas con `source='andalucia'` sin colisionar.
- [ ] Cloud Run Job ejecutable desde Scheduler con OAuth, contra Cloud SQL.
- [ ] Logs JSON en Cloud Logging con severity correcto.
- [ ] Schema cubre: alertas (NIF/CPV/estado/fecha), análisis competencia (awardee_tax_id + CPV), análisis general (importes/lugar/procedimiento). Detalles de lotes/resultados consultables vía JSONB.
- [ ] **6 archivos en `src/`. 3 tablas. Cero abstracciones de más.**

## 📁 Affected Files

Todo nuevo:

- Raíz: `package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`, `.gitignore`, `.env.example`, `README.md`
- `src/`: `index.ts`, `env.ts`, `logger.ts`, `db.ts`, `placsp.ts`, `sync.ts`
- `tests/`: `env.test.ts`, `placsp.test.ts`, `db.test.ts`, `sync.test.ts` (opcional)
- `tests/fixtures/`: `entry-basico.atom`, `entry-completa.atom`, `entry-coma-decimal.atom`, `feed-tombstone.atom`, `sample.zip`
- `drizzle/0000_initial.sql`
- `docker/Dockerfile`
- `infra/README.md`

## 📦 New Dependencies

**Runtime:** `postgres`, `drizzle-orm`, `sax`, `yauzl`, `pino`, `@google-cloud/pino-logging-gcp-config`, `undici`, `zod`.

**Dev:** `typescript`, `tsx`, `vitest`, `drizzle-kit`, `@types/node`, `@types/sax`, `@types/yauzl`.

## 🧠 Decisiones de simplicidad

- **3 tablas** en lugar de 7. Hijas como JSONB. Pierde queries SQL relacionales sobre lotes individuales, gana 80% menos código.
- **6 archivos** en `src/`. Sin `shared/`, sin `sources/`, sin `ports/`. Sólo funciones puras + 1 función principal `sync()`.
- **Sin abstracción multi-fuente**. Columna `source` reservada en el schema. Cuando llegue Andalucía: copiar `placsp.ts`, adaptar mapper, llamar nuevo `syncAndalucia()` desde `index.ts`. No prematuro.
- **Sin clases**. Sólo funciones que reciben sus dependencias como argumentos. Tests usan fakes triviales (o Postgres real para integración).
- **Inglés en todas las tablas y columnas**.
- **Postgres** (no MySQL). El usuario lo pidió explícitamente al inicio; "mysql" en el feedback posterior se asume como typo. Si quiere MySQL real avisará y se sustituye `postgres.js` por `mysql2` + `drizzle-orm/mysql2` + adaptar tipos (`text[]` → `JSON`, `jsonb` → `JSON`).
