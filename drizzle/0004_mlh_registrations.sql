ALTER TYPE "public"."audit_action" ADD VALUE 'mlh_import';--> statement-breakpoint
CREATE TABLE "mlh_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"full_name" text NOT NULL,
	"team_name" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"file_name" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" uuid
);
--> statement-breakpoint
ALTER TABLE "mlh_registrations" ADD CONSTRAINT "mlh_registrations_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mlh_registrations_position_idx" ON "mlh_registrations" USING btree ("position");