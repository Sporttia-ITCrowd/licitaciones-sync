# Despliegue en Google Cloud — Cloud Run Job + Cloud Scheduler

Documento operativo para desplegar `licitaciones-sync` en GCP. Asume que ya tienes
un proyecto GCP, `gcloud` configurado y permisos de Owner/Editor sobre el proyecto.

> Sustituye las variables `$PROJECT`, `$REGION`, `$INSTANCE`, `$DB_USER`, `$DB_PASS`,
> `$REPO` por los valores reales antes de ejecutar los comandos.

## 1. Variables base

```bash
export PROJECT=tu-proyecto-gcp
export REGION=europe-west1
export INSTANCE=licitaciones-db
export REPO=sync
export JOB_NAME=licitaciones-sync
export DB_NAME=licitaciones
export DB_USER=licitaciones_app
export DB_PASS='$(openssl rand -base64 24)'   # genera uno aleatorio

gcloud config set project $PROJECT
gcloud config set run/region $REGION
```

## 2. Habilitar APIs (una sola vez por proyecto)

```bash
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

## 3. Crear el repositorio de Artifact Registry (una sola vez)

```bash
gcloud artifacts repositories create $REPO \
  --repository-format=docker \
  --location=$REGION \
  --description="Imagenes Docker para sincronizaciones"
```

## 4. Crear Cloud SQL Postgres (una sola vez)

```bash
gcloud sql instances create $INSTANCE \
  --database-version=POSTGRES_16 \
  --tier=db-custom-2-7680 \
  --region=$REGION \
  --storage-type=SSD \
  --storage-size=50GB \
  --storage-auto-increase \
  --backup \
  --backup-start-time=03:00

# crea la base
gcloud sql databases create $DB_NAME --instance=$INSTANCE

# crea el usuario aplicativo
gcloud sql users create $DB_USER --instance=$INSTANCE --password="$DB_PASS"
```

## 5. Guardar el connection string en Secret Manager

El formato Unix-socket para Cloud SQL:
`postgresql://USER:PASS@/DBNAME?host=/cloudsql/PROJECT:REGION:INSTANCE`

```bash
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@/${DB_NAME}?host=/cloudsql/${PROJECT}:${REGION}:${INSTANCE}"

echo -n "$DATABASE_URL" | gcloud secrets create database-url --data-file=-
```

## 6. Service accounts y permisos (una sola vez)

```bash
# Service account que ejecuta el job
gcloud iam service-accounts create sync-runner \
  --display-name="Licitaciones sync runner"

SA_RUNNER="sync-runner@${PROJECT}.iam.gserviceaccount.com"

# Permite que el job lea el secret y se conecte a Cloud SQL
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_RUNNER" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_RUNNER" \
  --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_RUNNER" \
  --role="roles/logging.logWriter"

# Service account que el scheduler usa para invocar el job
gcloud iam service-accounts create scheduler-invoker \
  --display-name="Cloud Scheduler invoker"

SA_INVOKER="scheduler-invoker@${PROJECT}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA_INVOKER" \
  --role="roles/run.invoker"
```

## 7. Build & push de la imagen (cada vez que cambia el codigo)

```bash
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/licitaciones-sync:latest"

gcloud builds submit \
  --tag="$IMAGE" \
  --region=$REGION \
  -f docker/Dockerfile \
  .
```

> Tambien vale `docker buildx build --platform=linux/amd64 -t $IMAGE -f docker/Dockerfile . && docker push $IMAGE`
> si prefieres usar tu Docker local con auth contra Artifact Registry.

## 8. Crear / actualizar el Cloud Run Job

```bash
gcloud run jobs create $JOB_NAME \
  --image="$IMAGE" \
  --region=$REGION \
  --service-account="$SA_RUNNER" \
  --set-cloudsql-instances="${PROJECT}:${REGION}:${INSTANCE}" \
  --set-secrets="DATABASE_URL=database-url:latest" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT},LOG_LEVEL=info,RUN_MIGRATIONS=true" \
  --task-timeout=2h \
  --parallelism=1 \
  --max-retries=1 \
  --memory=2Gi \
  --cpu=2
```

> Para actualizar usa `gcloud run jobs update $JOB_NAME --image="$IMAGE"`.
>
> `RUN_MIGRATIONS=true` aplica las migraciones de Drizzle al inicio.
> Tras la primera ejecucion puedes quitarlo (no daña si se deja, pero ahorra latencia).

## 9. Ejecutar el job manualmente (verificacion)

```bash
gcloud run jobs execute $JOB_NAME --region=$REGION
```

Para ver logs:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="licitaciones-sync"' \
  --limit=50 --format=json | jq '.[] | {ts:.timestamp, sev:.severity, msg:.jsonPayload.message}'
```

## 10. Programar con Cloud Scheduler (diario a las 04:00 Madrid)

```bash
gcloud scheduler jobs create http licitaciones-sync-daily \
  --location=$REGION \
  --schedule="0 4 * * *" \
  --time-zone="Europe/Madrid" \
  --uri="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB_NAME}:run" \
  --http-method=POST \
  --oauth-service-account-email="$SA_INVOKER" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --attempt-deadline=30m \
  --max-retry-attempts=2
```

> El parametro `--attempt-deadline` es el timeout del **dispatcher HTTP** de Scheduler;
> no limita la duracion del job en si (eso lo hace `--task-timeout` del job).

## 11. Verificacion post-deploy

```bash
# Estado del scheduler
gcloud scheduler jobs describe licitaciones-sync-daily --location=$REGION

# Ultimas 5 ejecuciones del job
gcloud run jobs executions list --job=$JOB_NAME --region=$REGION --limit=5

# Estado de la BD
gcloud sql connect $INSTANCE --user=$DB_USER --database=$DB_NAME
# dentro del psql:
#   SELECT count(*) FROM tenders;
#   SELECT * FROM sync_state;
```

## 12. Operativa diaria

| Accion | Comando |
|---|---|
| Forzar una ejecucion ahora | `gcloud run jobs execute $JOB_NAME --region=$REGION` |
| Pausar el cron | `gcloud scheduler jobs pause licitaciones-sync-daily --location=$REGION` |
| Reanudar el cron | `gcloud scheduler jobs resume licitaciones-sync-daily --location=$REGION` |
| Ver logs en tiempo real | `gcloud beta run jobs logs tail $JOB_NAME --region=$REGION` |
| Resetear el watermark (re-bootstrap) | `psql ... -c "DELETE FROM sync_state WHERE source='placsp';"` |

## 13. Coste estimado

- Cloud SQL Postgres db-custom-2-7680: ~70 €/mes (24/7).
- Cloud Run Job: <1 €/mes (corre 6-10 min/dia).
- Cloud Scheduler: gratis hasta 3 jobs.
- Egress: depende del trafico contra PLACSP (~100-200 MB/dia → <1 €/mes).

Total estimado: ~75 €/mes.

Si quieres reducir Cloud SQL, considera `db-f1-micro` o `db-g1-small` para arrancar
y subir despues si las queries de alertas/analisis lo piden.
