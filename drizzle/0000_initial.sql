CREATE TABLE "sync_locks" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone NOT NULL,
	"heartbeat" timestamp with time zone NOT NULL,
	"instance_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"source" varchar(32) PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_cursor" varchar(16),
	"last_entry_updated" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "tenders" (
	"source" varchar(32) NOT NULL,
	"id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"file_number" text,
	"status_code" varchar(16),
	"authority_name" text,
	"authority_tax_id" varchar(32),
	"authority_dir3" varchar(32),
	"authority_platform_id" text,
	"authority_city" text,
	"authority_postal_code" varchar(16),
	"authority_email" text,
	"authority_profile_url" text,
	"authority_hierarchy" text,
	"title" text,
	"subject" text,
	"summary" text,
	"contract_type_code" varchar(8),
	"subtype_code" varchar(16),
	"main_cpv" varchar(16),
	"cpvs" text[] DEFAULT '{}'::text[] NOT NULL,
	"location_nuts" varchar(16),
	"location_name" text,
	"location_city" text,
	"location_postal_code" varchar(16),
	"duration_value" integer,
	"duration_unit" varchar(8),
	"period_start" date,
	"period_end" date,
	"estimated_value" numeric(18, 2),
	"budget_without_tax" numeric(18, 2),
	"budget_with_tax" numeric(18, 2),
	"currency" varchar(3) DEFAULT 'EUR',
	"procedure_code" varchar(8),
	"urgency_code" varchar(8),
	"contracting_system_code" varchar(8),
	"submission_method_code" varchar(8),
	"submission_deadline" timestamp with time zone,
	"documentation_deadline" date,
	"publication_date" date,
	"award_date" date,
	"award_amount_without_tax" numeric(18, 2),
	"award_amount_with_tax" numeric(18, 2),
	"awardee_name" text,
	"awardee_tax_id" varchar(32),
	"tender_count" integer,
	"awardee_is_sme" boolean,
	"result_code" varchar(8),
	"detail_url" text,
	"deleted_at" timestamp with time zone,
	"deleted_reason" varchar(16),
	"lots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	CONSTRAINT "tenders_source_id_pk" PRIMARY KEY("source","id")
);
--> statement-breakpoint
CREATE INDEX "tenders_updated_idx" ON "tenders" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenders_status_idx" ON "tenders" USING btree ("status_code");--> statement-breakpoint
CREATE INDEX "tenders_authority_tax_idx" ON "tenders" USING btree ("authority_tax_id");--> statement-breakpoint
CREATE INDEX "tenders_awardee_tax_idx" ON "tenders" USING btree ("awardee_tax_id");--> statement-breakpoint
CREATE INDEX "tenders_main_cpv_idx" ON "tenders" USING btree ("main_cpv");--> statement-breakpoint
CREATE INDEX "tenders_cpvs_gin" ON "tenders" USING gin ("cpvs");--> statement-breakpoint
CREATE INDEX "tenders_publication_idx" ON "tenders" USING btree ("publication_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenders_source_idx" ON "tenders" USING btree ("source");