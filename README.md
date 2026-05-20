# licitaciones-sync

Sync de licitaciones publicas españolas (PLACSP) a Postgres. Pensado para correr como
job en Cloud Run disparado por Cloud Scheduler.

## Que hace

1. **Bootstrap** (primera ejecucion): descarga el historico completo del canal PLACSP
   `sindicacion_643` (perfiles del contratante, sin contratos menores) desde 2012 hasta
   el mes corriente y lo carga en la tabla `tenders`.
2. **Incremental** (ejecuciones posteriores): solo descarga el mes corriente + el mes
   anterior. El upsert por clave `(source, id)` con `ON CONFLICT DO UPDATE` garantiza
   que ejecutarlo N veces seguidas no duplica datos.
3. Marca como `deleted_at` las licitaciones que llegan como tombstones
   (`at:deleted-entry` con motivos `ANULADA` o `CERRADA`).
4. Evita solapamientos entre ejecuciones con un lock + heartbeat en `sync_locks`.
5. Escribe logs JSON estructurados que Cloud Logging parsea automaticamente.

## Estructura

```
src/
  index.ts     # entrypoint: applies migrations, runs sync(), shuts down
  env.ts       # env vars validados con zod
  logger.ts    # pino + preset GCP
  db.ts        # schema drizzle + helpers (upsert, lock, sync_state)
  placsp.ts    # download / extract / parse / map para PLACSP
  sync.ts      # pipeline principal end-to-end
tests/         # vitest (env / db integracion / placsp)
drizzle/       # migrations generadas
docker/        # Dockerfile multi-stage
infra/         # comandos gcloud para desplegar
```

3 tablas en Postgres:

- **`tenders`** — una fila por expediente. Campos planos para alertas/queries
  rapidas + `cpvs text[]`, `lots jsonb`, `results jsonb`, `documents jsonb` para
  cardinalidades 0..n, y `raw_payload jsonb` con el bloque CODICE intacto.
- **`sync_state`** — cursor `last_cursor` (`YYYYMM`), watermark y ultimo error por fuente.
- **`sync_locks`** — lock con heartbeat para evitar dos ejecuciones simultaneas.

La PK de `tenders` es `(source, id)`: la columna `source` esta ahi para anadir
otros origenes (Junta de Andalucia, CM Madrid, etc.) sin tener que migrar el esquema.

## Desarrollo local

Necesitas Node 22 y un Postgres (local o Docker).

```bash
# 1. dependencias
npm install

# 2. base de datos (usa tu Postgres local con db 'licitaciones')
# o levanta una con docker:
#   docker run -d --name lic-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -v lic-pg:/var/lib/postgresql/data postgres:16

# 3. aplica el schema
DATABASE_URL='postgres://postgres:postgres@localhost:5432/licitaciones' npm run db:migrate

# 4. ejecuta el sync (descarga ~6 min en mes corriente + mes anterior)
DATABASE_URL='postgres://postgres:postgres@localhost:5432/licitaciones' npm run sync

# 5. ver lo cargado
psql 'postgres://postgres:postgres@localhost:5432/licitaciones' -c \
  "SELECT source, count(*), max(updated_at) FROM tenders GROUP BY source;"
```

### Variables de entorno

| Variable | Default | Descripcion |
|---|---|---|
| `DATABASE_URL` | (requerido) | Connection string Postgres. Para Cloud SQL usa `postgresql://user:pass@/db?host=/cloudsql/PROJECT:REGION:INSTANCE`. |
| `CLOUDSQL_INSTANCE` | — | Identificador Cloud SQL (informativo). |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `PLACSP_USER_AGENT` | `sporttia-licitaciones-sync/1.0 ...` | User-Agent al contactar PLACSP. |
| `TMP_DIR` | `./tmp/placsp` | Carpeta para descargar ZIPs temporales (limpia al final). |
| `BATCH_SIZE` | `500` | Filas por upsert. |
| `LOCK_HEARTBEAT_INTERVAL_MS` | `60000` | Frecuencia de heartbeat del lock. |
| `LOCK_STALE_AFTER_MS` | `1800000` | Cuando se considera expirado un lock (30 min sin heartbeat). |
| `GOOGLE_CLOUD_PROJECT` | — | Si se setea, los logs incluyen `trace` con el formato `projects/.../traces/...`. |
| `RUN_MIGRATIONS` | `false` | `true` para aplicar migraciones drizzle al arranque (util en Cloud Run). |

### Tests

```bash
npm test          # ejecuta todo (los tests de db.test.ts tocan Postgres real)
npm run test:watch
npm run lint      # solo type-check
```

Los tests de `tests/db.test.ts` requieren un Postgres accesible en `DATABASE_URL`
(o `TEST_DATABASE_URL`). Por defecto usan `postgres://postgres:postgres@localhost:5432/licitaciones`.

## Anadir un nuevo proveedor en el futuro

Cuando llegue el momento de añadir Junta de Andalucia, CM Madrid, etc., el patron es:

1. Crear `src/andalucia.ts` con sus propias funciones `discoverPeriods`, `downloadZip`,
   `parseAtom`, `mapEntry` adaptadas al formato de esa plataforma (devuelven el mismo
   tipo `Tender` con `source = 'andalucia'`).
2. En `src/sync.ts`, refactorizar para invocar tambien el pipeline del nuevo proveedor
   (o crear `syncAndalucia` paralelo a `sync`).
3. En `src/index.ts`, llamar a ambos.

No hace falta tocar el schema ni los helpers de `db.ts`: la PK compuesta `(source, id)`
los aisla.

## Schema rapido

Lista de columnas mas usadas para el equipo que consume los datos:

| Para que | Columna |
|---|---|
| Identificador estable | `id` (entry URI) + `source` |
| Numero de expediente humano | `file_number` |
| Estado actual | `status_code` (`PRE`/`PUB`/`EV`/`ADJ`/`RES`/`ANUL`) |
| Organo contratante | `authority_name`, `authority_tax_id`, `authority_dir3` |
| Objeto | `title`, `subject`, `summary`, `contract_type_code` |
| CPV | `main_cpv` (atajo) o `cpvs text[]` (todos, indexado GIN) |
| Localizacion | `location_nuts`, `location_name`, `location_city` |
| Importes presupuesto | `estimated_value`, `budget_without_tax`, `budget_with_tax` |
| Procedimiento | `procedure_code`, `urgency_code` |
| Plazo de presentacion | `submission_deadline` (timestamptz Europe/Madrid) |
| Adjudicacion (resumen) | `award_date`, `awardee_name`, `awardee_tax_id`, `award_amount_without_tax`, `result_code` |
| Detalle por lote / por adjudicacion | `lots jsonb`, `results jsonb` |
| Documentos (pliegos, etc.) | `documents jsonb` |
| Todo el CODICE original | `raw_payload jsonb` |
| Tombstone | `deleted_at`, `deleted_reason` |

Indices ya creados: `updated_at DESC`, `status_code`, `authority_tax_id`,
`awardee_tax_id`, `main_cpv`, `cpvs` (GIN), `publication_date DESC`, `source`.

## Deploy en GCP

Ver [`infra/README.md`](./infra/README.md) para comandos `gcloud` paso a paso.

## Scripts utiles

- `scripts/debug-upsert.ts` — descarga el ZIP del mes corriente y ejecuta upserts en
  modo diagnostico para encontrar filas que fallan. Mantenerlo como herramienta de
  soporte para cuando aparezca un quirk nuevo en PLACSP.
