CREATE TABLE "team_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"team_id" uuid,
	"submitted_at" text,
	"team_name" text NOT NULL,
	"leader_name" text,
	"title" text,
	"description" text,
	"repo_url" text,
	"ps_match" text,
	"matched_statement" text,
	"notes" text,
	"file_name" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_submissions_repo_https" CHECK ("team_submissions"."repo_url" is null or "team_submissions"."repo_url" like 'https://%')
);
--> statement-breakpoint
ALTER TABLE "team_submissions" ADD CONSTRAINT "team_submissions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_submissions_team_idx" ON "team_submissions" USING btree ("team_id");