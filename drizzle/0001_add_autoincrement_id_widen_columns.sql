-- Postgres does not support reordering columns of an existing table. We want
-- the new bigserial `id` to be the first column for ergonomic reasons (CLI,
-- frontend, ORM exports), so this migration drops the previous tenders table
-- and recreates it from scratch.
--
-- Data note: any existing rows in `tenders` are lost on apply. This is safe
-- because the next sync run will re-fetch the data from PLACSP. The dependent
-- bookkeeping tables (`sync_state`, `sync_locks`) are intentionally untouched.

DROP TABLE IF EXISTS "tenders" CASCADE;--> statement-breakpoint

CREATE TABLE "tenders" (
  "id"                         bigserial PRIMARY KEY,
  "source"                     varchar(32) NOT NULL,
  "external_id"                text NOT NULL,
  "updated_at"                 timestamp with time zone NOT NULL,
  "ingested_at"                timestamp with time zone DEFAULT NOW() NOT NULL,

  "file_number"                text,
  "status_code"                text,

  "authority_name"             text,
  "authority_tax_id"           text,
  "authority_dir3"             text,
  "authority_platform_id"      text,
  "authority_city"             text,
  "authority_postal_code"      text,
  "authority_email"            text,
  "authority_profile_url"      text,
  "authority_hierarchy"        text,

  "title"                      text,
  "subject"                    text,
  "summary"                    text,
  "contract_type_code"         text,
  "subtype_code"               text,
  "main_cpv"                   text,
  "cpvs"                       text[] DEFAULT '{}'::text[] NOT NULL,
  "location_nuts"              text,
  "location_name"              text,
  "location_city"              text,
  "location_postal_code"       text,
  "duration_value"             integer,
  "duration_unit"              text,
  "period_start"               date,
  "period_end"                 date,

  "estimated_value"            numeric(18, 2),
  "budget_without_tax"         numeric(18, 2),
  "budget_with_tax"            numeric(18, 2),
  "currency"                   text DEFAULT 'EUR',

  "procedure_code"             text,
  "urgency_code"               text,
  "contracting_system_code"    text,
  "submission_method_code"     text,
  "submission_deadline"        timestamp with time zone,
  "documentation_deadline"     date,
  "publication_date"           date,

  "award_date"                 date,
  "award_amount_without_tax"   numeric(18, 2),
  "award_amount_with_tax"      numeric(18, 2),
  "awardee_name"               text,
  "awardee_tax_id"             text,
  "tender_count"               integer,
  "awardee_is_sme"             boolean,
  "result_code"                text,

  "detail_url"                 text,
  "deleted_at"                 timestamp with time zone,
  "deleted_reason"             text,

  "lots"                       jsonb DEFAULT '[]'::jsonb NOT NULL,
  "results"                    jsonb DEFAULT '[]'::jsonb NOT NULL,
  "documents"                  jsonb DEFAULT '[]'::jsonb NOT NULL,
  "raw_payload"                jsonb NOT NULL,

  CONSTRAINT "tenders_source_external_id_unique" UNIQUE ("source", "external_id")
);--> statement-breakpoint

CREATE INDEX "tenders_updated_idx"        ON "tenders" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenders_status_idx"         ON "tenders" USING btree ("status_code");--> statement-breakpoint
CREATE INDEX "tenders_authority_tax_idx"  ON "tenders" USING btree ("authority_tax_id");--> statement-breakpoint
CREATE INDEX "tenders_awardee_tax_idx"    ON "tenders" USING btree ("awardee_tax_id");--> statement-breakpoint
CREATE INDEX "tenders_main_cpv_idx"       ON "tenders" USING btree ("main_cpv");--> statement-breakpoint
CREATE INDEX "tenders_cpvs_gin"           ON "tenders" USING gin ("cpvs");--> statement-breakpoint
CREATE INDEX "tenders_publication_idx"    ON "tenders" USING btree ("publication_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenders_source_idx"         ON "tenders" USING btree ("source");
