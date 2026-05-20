# Investigación — Sync de licitaciones PLACSP a Postgres (Node.js + GCP)

Fecha: 2026-05-19
Fuentes:
- Repo de referencia: https://github.com/BquantFinance/licitaciones-espana
- Especificación oficial de sindicación PLACSP v1.10 (250 pp): https://contrataciondelsectorpublico.gob.es/datosabiertos/especificacion-sindicacion.pdf
- Manual OpenPLACSP v1.3 (DGPE, 29/04/2022): https://contrataciondelestado.es/datosabiertos/DGPE_PLACSP_OpenPLACSP_v.1.3.pdf
- Portal datos abiertos: https://contrataciondelsectorpublico.gob.es/wps/portal/DatosAbiertos
- Listas CODICE: https://contrataciondelestado.es/codice/cl/
- Catálogos en datos.gob.es (perfiles + agregadas)
- Documentación de Drizzle / postgres.js / Cloud Run Jobs / Cloud Scheduler / pino + GCP

---

## 1. Origen de datos — PLACSP

### 1.1 Endpoints (5 canales / "sindicaciones")

Host canónico: `contrataciondelsectorpublico.gob.es` (alias antiguo: `contrataciondelestado.es`).

| Canal | ID | URL ZIP anual | URL ZIP mensual (año corriente) | Desde |
|---|---|---|---|---|
| Licitaciones perfiles PLACSP (sin menores) | **643** | `/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3_AAAA.zip` | `…_AAAAMM.zip` | 2012 |
| Licitaciones agregadas CCAA (sin menores) | 1044 | `/sindicacion/sindicacion_1044/PlataformasAgregadasSinMenores_AAAA.zip` | `…_AAAAMM.zip` | 2016 |
| Contratos menores | 1143 | `/sindicacion/sindicacion_1143/contratosMenoresPerfilesContratantes_AAAA.zip` | `…_AAAAMM.zip` | 2018 |
| Encargos a medios propios (EMP) | 1383 | `/sindicacion/sindicacion_1383/EMP_SectorPublico_AAAA.zip` | sólo anual | 2022 |
| Consultas preliminares (CPM) | 1403 | `/sindicacion/sindicacion_1403/CPM_SectorPublico_AAAA.zip` | sólo anual | 2022 |

Feed Atom "vivo" para 643:
`https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom`

**Para este proyecto v1 sólo se consume el canal 643** (alcance acotado por el usuario). El esquema se diseña multifuente desde el inicio (columna `source`).

### 1.2 Tamaños

| Canal | Acumulado histórico | ZIP mensual reciente |
|---|---|---|
| 643 | ~4M expedientes | 35–50 MB (~14k entries/mes, ~60 archivos `.atom`) |
| 1044 | ~1.7M | 20–40 MB |
| 1143 | ~2M | 30–50 MB |

ZIP anual completo de 643: 50–150 MB. Cobertura 2012→2026 implica descargar ~14 ZIPs anuales + el mes corriente.

### 1.3 Formato del feed (Atom 1.0 + CODICE-PLACE)

Atom 1.0 RFC 4287 con extensiones:
- **Tombstones** (RFC 6721): `<at:deleted-entry ref="..." when="...">` con sub-elemento `<at:comment type="ANULADA|CERRADA"/>` (desde julio 2022).
- **Paginación** (RFC 5005): `<link rel="first|prev|next|last">`. Máximo **500 entries por `.atom`**. Cada ZIP mensual contiene decenas/cientos de `.atom` encadenados.
- **Orden**: descendente por `<entry><updated>` (más reciente arriba).

Namespaces obligatorios (en `<cac-place-ext:ContractFolderStatus>`, **no** en `<feed>`):

| Prefijo | URI |
|---|---|
| `` (default) | `http://www.w3.org/2005/Atom` |
| `cac` | `urn:dgpe:names:draft:codice:schema:xsd:CommonAggregateComponents-2` |
| `cbc` | `urn:dgpe:names:draft:codice:schema:xsd:CommonBasicComponents-2` |
| `cac-place-ext` | `urn:dgpe:names:draft:codice-place-ext:schema:xsd:CommonAggregateComponents-2` |
| `cbc-place-ext` | `urn:dgpe:names:draft:codice-place-ext:schema:xsd:CommonBasicComponents-2` |
| `at` | `http://purl.org/atompub/tombstones/1.0` |

⚠ Estos URN son **DGPE-propios**, no los UBL/OASIS estándar. Parsers UBL "puros" no validan.

### 1.4 Identificador único

- `entry/id` (URI): formato `https://contrataciondelestado.es/feeds/.../entry/{N}` o
  `https://contrataciondelestado.es/sindicacion/licitacionesPerfilContratante/{slug}`.
  Es **estable** para el mismo expediente a lo largo del tiempo.
- Una misma `id` puede aparecer en múltiples `.atom` (PUB → EV → ADJ → RES); te quedas con la del `entry/updated` más reciente.
- `cbc:ContractFolderID` **no** es único globalmente (solo por órgano).

### 1.5 Estrategia de sync

**Sin filtrado server-side por fecha** (no hay `?since=…`). El servidor sí respeta `Last-Modified` / `If-Modified-Since` y `ETag` / `If-None-Match` sobre los ZIPs.

Estrategia híbrida recomendada:

1. **Bootstrap** (primera ejecución):
   - Descarga ZIPs anuales 2012 → año anterior.
   - Descarga ZIP del mes corriente.
   - Upsert masivo en Postgres.
2. **Incremental** (corridas siguientes desde Cloud Scheduler):
   - Re-descarga del **mes corriente** y **mes anterior** (las correcciones tardías y los tombstones llegan tarde).
   - Upsert con condición `updated_at > stored.updated_at` para no escribir si no hay cambios.
3. **Early-exit opcional**: como las entries vienen ordenadas desc por `updated`, al toparse con una `updated <= last_entry_updated` se puede dejar de procesar ese `.atom` para ahorrar I/O.

### 1.6 Mapeo CODICE → SQL (campos clave)

Listado canónico para una `<entry>` en canal 643. Origen: especificación oficial + auditoría del repo Python de referencia.

**Identificadores y meta Atom:**
- `entry/id` → `id` TEXT (clave parte de PK).
- `entry/updated` → `updated_at` TIMESTAMPTZ (high watermark).
- `entry/link/@href` → `url_detalle` TEXT (deeplink web).
- `entry/title` → `titulo` TEXT.
- `entry/summary` → `summary` TEXT.
- `ContractFolderStatus/cbc:ContractFolderID` → `expediente` TEXT.
- `ContractFolderStatus/cbc-place-ext:ContractFolderStatusCode` → `estado_code` TEXT (`PRE`/`PUB`/`EV`/`ADJ`/`RES`/`ANUL`).

**Órgano de contratación** (`LocatedContractingParty/Party`):
- `cac:PartyName/cbc:Name` → `organo_nombre`.
- `cac:PartyIdentification/cbc:ID[@schemeName="NIF"]` → `organo_nif`.
- `cac:PartyIdentification/cbc:ID[@schemeName="DIR3"]` → `organo_dir3`.
- `cac:PartyIdentification/cbc:ID[@schemeName="ID_PLATAFORMA"]` → `organo_id_plataforma`.
- `cac:PostalAddress/cbc:CityName` → `organo_ciudad`.
- `cac:PostalAddress/cbc:PostalZone` → `organo_cp` (⚠ es `PostalZone`, no `PostalCode`).
- `cac:Contact/cbc:ElectronicMail` → `organo_email`.
- `cbc:BuyerProfileURIID` → `organo_url_perfil`.
- `cac-place-ext:ParentLocatedParty` (recursivo) → `organo_jerarquia` TEXT (concat con ` > `).

**Objeto del contrato** (`cac:ProcurementProject`):
- `cbc:Name` → `objeto` TEXT.
- `cbc:TypeCode` → `tipo_contrato_code` (1=Suministros, 2=Servicios, 3=Obras, 21=Privado, 31=Concesión obras, 40=Concesión servicios…).
- `cbc:SubTypeCode` → `subtipo_code`.
- `cac:RequiredCommodityClassification/cbc:ItemClassificationCode` (0..n) → tabla `licitacion_cpv` (N:M).
- `cac:RealizedLocation/cbc:CountrySubentityCode` → `lugar_nuts`.
- `cac:RealizedLocation/cbc:CountrySubentity` → `lugar_nombre`.
- `cac:RealizedLocation/cac:Address/cbc:PostalCode` → `lugar_cp`.
- `cac:RealizedLocation/cac:Address/cbc:CityName` → `lugar_ciudad`.
- `cac:PlannedPeriod/cbc:DurationMeasure` + `@unitCode` → `duracion_valor`/`duracion_unidad` (DAY/MON/ANN).
- `cac:PlannedPeriod/cbc:StartDate` / `cbc:EndDate` → `plazo_inicio` / `plazo_fin`.

**Importes** (`cac:ProcurementProject/cac:BudgetAmount`):
- `cbc:EstimatedOverallContractAmount` → `valor_estimado` NUMERIC(18,2).
- `cbc:TotalAmount` → `presupuesto_con_iva`.
- `cbc:TaxExclusiveAmount` → `presupuesto_sin_iva`.
- atributo `@currencyID` → `moneda` (típicamente `EUR`).

⚠ **Cuidado**: en la misma entry pueden convivir `5989390,79` (coma) y `4949909.74` (punto). Normaliza siempre antes de `parseFloat`.

**Tramitación** (`cac:TenderingProcess`):
- `cbc:ProcedureCode` → `procedimiento_code` (1=Abierto, 2=Restringido, 3=Negociado con publicidad, 4=Negociado sin publicidad, 5=Diálogo competitivo, 6=Asociación innovación, 8=Abierto simplificado, 100=Basado en acuerdo marco).
- `cbc:UrgencyCode` → `urgencia_code` (1=Ordinaria, 2=Urgente, 3=Emergencia).
- `cbc:ContractingSystemCode` → `sistema_contratacion_code`.
- `cbc:SubmissionMethodCode` → `metodo_presentacion_code`.
- `cac:TenderSubmissionDeadlinePeriod/cbc:EndDate` + `cbc:EndTime` → `fecha_limite_ofertas` (combinar en TIMESTAMPTZ Europe/Madrid).
- `cac:DocumentAvailabilityPeriod/cbc:EndDate` → `fecha_limite_documentacion`.

**Resultado / adjudicación** (`cac:TenderResult`, **cardinalidad 0..n** — uno por lote):
- `cbc:ResultCode` → `result_code` (8=Adjudicado, 3=Desierto…).
- `cbc:AwardDate` → `fecha_adjudicacion`.
- `cbc:ReceivedTenderQuantity` → `num_ofertas` INT.
- `cbc:SMEAwardedIndicator` → `es_pyme` BOOLEAN (string `'true'`/`'false'`).
- `cac:WinningParty/cac:PartyName/cbc:Name` → `adjudicatario_nombre`.
- `cac:WinningParty/cac:PartyIdentification/cbc:ID` → `adjudicatario_nif`.
- `cac:AwardedTenderedProject/cbc:ProcurementProjectLotID` → `lote_id`.
- `cac:AwardedTenderedProject/cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount` → `importe_adj_sin_iva`.
- `cac:AwardedTenderedProject/cac:LegalMonetaryTotal/cbc:PayableAmount` → `importe_adj_con_iva`.

Como puede haber múltiples `TenderResult` (uno por lote adjudicado), conviene una tabla hija `licitacion_resultado`.

**Lotes** (`cac:ProcurementProjectLot`, 0..n):
- `cbc:ID` → `lote_id`.
- `cac:ProcurementProject/cbc:Name` → `objeto`.
- `cac:ProcurementProject/cac:BudgetAmount/*` → importes propios.
- `cac:ProcurementProject/cac:RequiredCommodityClassification/cbc:ItemClassificationCode` (0..n) → CPVs del lote.

Tabla hija `licitacion_lote`.

**Documentos** (`cac:LegalDocumentReference`, `cac:TechnicalDocumentReference`, `cac:AdditionalDocumentReference`):
- `cbc:ID` + `cac:Attachment/cac:ExternalReference/cbc:URI` → tabla `licitacion_documento(tipo, id_pliego, url)`.

**Publicaciones oficiales** (`cac-place-ext:ValidNoticeInfo`):
- `cbc-place-ext:NoticeTypeCode` → tipo (DOC_CN, DOC_CA…).
- `cac-place-ext:AdditionalPublicationStatus/cbc-place-ext:PublicationMediaName` → BOE/DOUE/BORM.
- `cac-place-ext:AdditionalPublicationDocumentReference/cbc:IssueDate` → `fecha_publicacion`.

**Financiación UE / NextGen**: `cac:TenderingTerms/cac:FundingProgram` o `cbc:FundingProgramCode`.

### 1.7 Quirks confirmados

1. **Decimales mixtos**: coma y punto coexisten en la misma entry. Normaliza siempre.
2. **`entry/updated` no cambia en correcciones técnicas** (spec apartado 3.3.1). Mitigación: reprocesar siempre los últimos 2–3 meses.
3. **Múltiples `<entry>` con la misma `id`**: quédate con la del `updated` más reciente.
4. **Catálogos cambiantes**: `SyndicationContractCode-2.04.gc` → `-2.07.gc` etc. Entries históricas llevan el `listURI` viejo.
5. **`PostalZone` ≠ `PostalCode`**: el órgano usa `PostalZone`, el lugar de ejecución usa `PostalCode`.
6. **Cardinalidades 0..n**: CPV, lotes, TenderResult, documentos, publicaciones.
7. **Zona horaria**: peninsular (`+01:00`/`+02:00`). Guarda en UTC.
8. **Encoding**: UTF-8 con ñ, acentos, comillas tipográficas.
9. **404 esperado** para meses futuros y años fuera de cobertura del canal.
10. **El ZIP del mes en curso se actualiza diariamente**; el del año cerrado es estático.
11. **Multiplataforma**: el canal 1044 contiene un **subconjunto reducido** de campos respecto al 643. Diseña el esquema permisivo (todo nullable salvo identificadores).

---

## 2. Stack técnico recomendado (Node.js + GCP)

### 2.1 Runtime y librerías

| Concern | Elección | Por qué |
|---|---|---|
| Runtime | **Node 22 LTS + TypeScript** | LTS estable, fetch nativo (undici interno), top-level await |
| Driver Postgres | **`postgres.js` (porsager)** | Pool integrado, prepared statements cacheados, soporte nativo `COPY FROM STDIN`, tagged templates |
| ORM | **Drizzle ORM + drizzle-kit** | Tipado fuerte, migraciones generadas, sintaxis cercana a SQL, integración nativa con `postgres.js` |
| XML streaming | **`sax`** (con `xmlns: true`) | Streaming SAX, namespaces correctos, sin build nativo |
| ZIP streaming | **`yauzl`** (`lazyEntries: true`) | Streaming sin descomprimir todo a disco; abre `.atom` uno a uno |
| HTTP | **`undici`** o **`fetch` nativo** | Streaming a disco, soporta `If-Modified-Since`/`If-None-Match` |
| Logger | **`pino` + `@google-cloud/pino-logging-gcp-config`** | JSON estructurado, mapeo nativo a Cloud Logging (severity, trace, labels, Error Reporting) |
| Test | **Vitest** | Rápido, ESM nativo, mocks integrados |

### 2.2 Patrón de upsert masivo con Drizzle

```ts
import { sql, getColumns } from 'drizzle-orm';

function buildConflictUpdateColumns<T extends PgTable, K extends keyof T['_']['columns']>(
  table: T, columns: K[],
) {
  const cls = getColumns(table);
  return columns.reduce((acc, col) => {
    acc[col] = sql.raw(`excluded.${cls[col].name}`);
    return acc;
  }, {} as Record<K, ReturnType<typeof sql.raw>>);
}

await db.insert(licitaciones)
  .values(batch)
  .onConflictDoUpdate({
    target: [licitaciones.source, licitaciones.id],
    set: buildConflictUpdateColumns(licitaciones, [
      'updatedAt', 'titulo', 'estado', 'payload', /* ... */
    ]),
    setWhere: sql`excluded.updated_at >= ${licitaciones.updatedAt}`, // sólo si más nueva
  });
```

Batch size 500–1000 filas. Límite duro: 65.535 parámetros por mensaje bind.

### 2.3 Locking — tabla `sync_locks` con heartbeat

```sql
CREATE TABLE sync_locks (
  name        text PRIMARY KEY,
  locked_at   timestamptz NOT NULL,
  heartbeat   timestamptz NOT NULL,
  instance_id text NOT NULL
);

-- Adquirir o robar lock expirado (>30 min sin heartbeat)
INSERT INTO sync_locks (name, locked_at, heartbeat, instance_id)
VALUES ($1, NOW(), NOW(), $2)
ON CONFLICT (name) DO UPDATE
  SET locked_at = EXCLUDED.locked_at,
      heartbeat = EXCLUDED.heartbeat,
      instance_id = EXCLUDED.instance_id
  WHERE sync_locks.heartbeat < NOW() - INTERVAL '30 minutes'
RETURNING instance_id;
```

Si `RETURNING instance_id != $2` → ya está bloqueado por otro proceso → salir. Heartbeat cada N segundos durante la ejecución. Release al finalizar (success o failure).

Alternativas descartadas:
- `pg_advisory_lock` a nivel sesión rompe con poolers en modo transaction.
- `--parallelism=1` de Cloud Run sólo controla tasks dentro de UNA execution, no entre executions distintas del scheduler.
- `attemptDeadline` de Scheduler sólo limita la respuesta HTTP, no la duración del job.

### 2.4 Sync state (cursor / watermark)

```sql
CREATE TABLE sync_state (
  source             text PRIMARY KEY,
  last_run_at        timestamptz NOT NULL,
  last_success_at    timestamptz,
  last_cursor        text,        -- 'YYYYMM' del último mes procesado completamente
  last_entry_updated timestamptz, -- max(entry/updated) visto
  last_error         text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb
);
```

### 2.5 Deploy GCP

- **Cloud Run Job** (no Service): task timeout hasta 7 días, escala a 0, perfecto para batch.
- **Cloud Scheduler** → HTTP POST a `https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run` con **OAuth** (no OIDC; OIDC es para Cloud Run Services).
- **Cloud SQL** Postgres 16: conexión vía unix socket `/cloudsql/PROJECT:REGION:INSTANCE` (más simple) o private IP / Direct VPC egress.
- **Secret Manager**: `DATABASE_URL` y otros secretos vía `--set-secrets`.

### 2.6 Logging estructurado

Campos especiales que Cloud Logging parsea automáticamente:
- `severity`, `message`, `time`
- `logging.googleapis.com/trace` (formato `projects/PROJECT/traces/TRACE_ID`)
- `logging.googleapis.com/labels` (objeto string→string)
- `logging.googleapis.com/insertId`

`@google-cloud/pino-logging-gcp-config` hace el mapping automático (incluye stack traces para Error Reporting). Cloud Run inyecta `CLOUD_RUN_JOB`, `CLOUD_RUN_EXECUTION`, `CLOUD_RUN_TASK_INDEX`, `CLOUD_RUN_TASK_ATTEMPT` como env vars — útiles para correlacionar.

---

## 3. Decisiones de diseño consolidadas

1. **PK compuesta `(source, id)`** desde el día 1 — facilita añadir Junta de Andalucía, Madrid CCAA, etc. en el futuro.
2. **JSONB `payload`** con el objeto CODICE parseado completo — preserva todos los campos no desnormalizados para análisis ad-hoc futuro.
3. **Tablas hijas** para cardinalidad 0..n (cpv, lote, resultado, documento).
4. **`organo_contratacion` denormalizado** dentro de `licitaciones` v1 (NIF, nombre, ciudad) + columnas opcionales JSON; **no** crear tabla maestra de órganos en v1 (complica el upsert y se puede derivar después con una vista materializada).
5. **Tombstones** en tabla `licitacion_deleted(source, id, deleted_at, reason)` + actualizar `licitaciones.estado_code = 'ANUL'` o flag.
6. **Modo bootstrap vs incremental** decidido por presencia/ausencia de `sync_state` para `source='placsp'`.
7. **Reprocesar siempre los últimos 2 meses** en incremental (para capturar correcciones técnicas que no actualizan `entry/updated`).
8. **Source code constante** `'placsp'` para canal 643. Futuro: `'placsp_agregadas'` (1044), `'jcca_andalucia'`, `'cm_madrid'`, etc.
9. **CPV en TEXT siempre** (nunca numérico — pierden el cero a la izquierda).
10. **Validadores NIF/CIF/CPV/NUTS** portados del repo de referencia (módulo `calidad/calidad_licitaciones.py`) en utilidad opcional.

---

## 4. Open items (no bloqueantes)

- ¿Vamos a almacenar cuerpos de pliegos (PDF)? **No en v1**; sólo URLs. Si más adelante hace falta, añadir un worker aparte.
- ¿Tabla maestra de órganos contratantes (deduplicada por NIF)? **No v1**, derivable por vista materializada.
- ¿Catálogos (tipos contrato, estado, procedimiento) como tablas? **No v1**, mapeo en memoria; v2 si hace falta multi-idioma.
- ¿Trigger near-real-time (cada 15 min vía Atom vivo)? **No v1**, sólo cron diario. Arquitectura ya lo permite (basta otra ruta del orchestrator).
