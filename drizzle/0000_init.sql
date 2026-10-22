CREATE TYPE "public"."audit_action" AS ENUM('csv_import', 'team_create', 'team_update', 'team_delete', 'member_count_correction', 'coupon_issue', 'coupon_reversal', 'coupon_quantity_correction', 'user_create', 'user_update');--> statement-breakpoint
CREATE TYPE "public"."distribution_status" AS ENUM('pending', 'issued');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'dinner');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'organizer');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"action" "audit_action" NOT NULL,
	"team_id" uuid,
	"team_label" text,
	"meal_type" "meal_type",
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"meal_type" "meal_type" NOT NULL,
	"coupon_quantity" integer NOT NULL,
	"status" "distribution_status" DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"issue_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distributions_team_meal_unique" UNIQUE("team_id","meal_type"),
	CONSTRAINT "distributions_quantity_positive" CHECK ("distributions"."coupon_quantity" > 0),
	CONSTRAINT "distributions_issued_consistency" CHECK (("distributions"."status" = 'issued') = ("distributions"."issued_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"type" "meal_type" PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "meals_sort_order_unique" UNIQUE("sort_order")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_name" text NOT NULL,
	"team_name_key" text NOT NULL,
	"team_code" text NOT NULL,
	"team_leader_name" text,
	"team_leader_email" text,
	"member_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_team_name_key_unique" UNIQUE("team_name_key"),
	CONSTRAINT "teams_team_code_unique" UNIQUE("team_code"),
	CONSTRAINT "teams_member_count_positive" CHECK ("teams"."member_count" > 0),
	CONSTRAINT "teams_name_not_blank" CHECK (length(trim("teams"."team_name")) > 0),
	CONSTRAINT "teams_code_not_blank" CHECK (length(trim("teams"."team_code")) > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'organizer' NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_meal_type_meals_type_fk" FOREIGN KEY ("meal_type") REFERENCES "public"."meals"("type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_team_id_idx" ON "audit_logs" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "distributions_meal_status_idx" ON "distributions" USING btree ("meal_type","status");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");