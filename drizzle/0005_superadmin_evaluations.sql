CREATE TYPE "public"."eval_phase" AS ENUM('mid', 'final');--> statement-breakpoint
CREATE TYPE "public"."eval_track" AS ENUM('gemma', 'open_source');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'superadmin';--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_evaluation_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before" text,
	"after" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"changed_by_email" text
);
--> statement-breakpoint
CREATE TABLE "team_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase" "eval_phase" NOT NULL,
	"team_id" uuid NOT NULL,
	"track" "eval_track",
	"score1" smallint,
	"score2" smallint,
	"score3" smallint,
	"score4" smallint,
	"score5" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "team_evaluations_phase_team_unique" UNIQUE("phase","team_id"),
	CONSTRAINT "team_evaluations_score1_range" CHECK ("team_evaluations"."score1" is null or "team_evaluations"."score1" between 1 and 5),
	CONSTRAINT "team_evaluations_score2_range" CHECK ("team_evaluations"."score2" is null or "team_evaluations"."score2" between 1 and 5),
	CONSTRAINT "team_evaluations_score3_range" CHECK ("team_evaluations"."score3" is null or "team_evaluations"."score3" between 1 and 5),
	CONSTRAINT "team_evaluations_score4_range" CHECK ("team_evaluations"."score4" is null or "team_evaluations"."score4" between 1 and 5),
	CONSTRAINT "team_evaluations_score5_range" CHECK ("team_evaluations"."score5" is null or "team_evaluations"."score5" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "team_evaluation_changes" ADD CONSTRAINT "team_evaluation_changes_evaluation_id_team_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."team_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_evaluation_changes" ADD CONSTRAINT "team_evaluation_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree ("email","attempted_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","attempted_at");--> statement-breakpoint
CREATE INDEX "team_evaluation_changes_evaluation_idx" ON "team_evaluation_changes" USING btree ("evaluation_id","changed_at");