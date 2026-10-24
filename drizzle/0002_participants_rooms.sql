-- Participant-level operations: check-ins, lunch/snacks/dinner coupons per
-- participant, and session-scoped room allocations with a database-enforced
-- capacity limit. Replaces the team-level breakfast/lunch/dinner model; every
-- issuance made under the old model is already recorded in audit_logs.

ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'team_archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'participant_create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'participant_update';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'participant_withdraw';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'check_in';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'check_in_undo';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'room_assign';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'room_move';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'room_release';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'room_update';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'room_create';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE IF NOT EXISTS 'session_update';--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('lunch', 'snacks', 'dinner');--> statement-breakpoint
CREATE TYPE "public"."event_session_id" AS ENUM('talks', 'hackathon');--> statement-breakpoint

-- Audit log: keep the old meal of legacy rows in details, then switch columns.
ALTER TABLE "audit_logs" ADD COLUMN "coupon_type" "coupon_type";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "session_id" "event_session_id";--> statement-breakpoint
UPDATE "audit_logs"
  SET "details" = coalesce("details", '{}'::jsonb) || jsonb_build_object('legacyMealType', "meal_type"::text)
  WHERE "meal_type" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" DROP COLUMN "meal_type";--> statement-breakpoint
DROP TABLE "distributions";--> statement-breakpoint
DROP TABLE "meals";--> statement-breakpoint
DROP TYPE "public"."distribution_status";--> statement-breakpoint
DROP TYPE "public"."meal_type";--> statement-breakpoint

CREATE TABLE "registration_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"layout" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"summary" jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL
);--> statement-breakpoint
ALTER TABLE "registration_imports" ADD CONSTRAINT "registration_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Teams: size now comes from the member list. Legacy fields move to "source".
ALTER TABLE "teams" ADD COLUMN "registration_key" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "college" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "declared_member_count" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "declared_registered_count" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "source_import_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "source" jsonb;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "archived_reason" text;--> statement-breakpoint
UPDATE "teams" SET
  "registration_key" = 'legacy:' || "team_code",
  "declared_member_count" = "member_count",
  "source" = jsonb_build_object('legacy', jsonb_build_object(
    'memberCount', "member_count", 'leaderName', "team_leader_name", 'leaderEmail', "team_leader_email"));--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "registration_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_registration_key_unique" UNIQUE("registration_key");--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_team_name_key_unique";--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_member_count_positive";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "member_count";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "team_leader_name";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "team_leader_email";--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_source_import_id_registration_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."registration_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_team_name_key_idx" ON "teams" USING btree ("team_name_key");--> statement-breakpoint

CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_no" integer GENERATED ALWAYS AS IDENTITY (sequence name "participants_participant_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"external_id" text,
	"identity_key" text NOT NULL,
	"is_leader" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"source" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_participant_no_unique" UNIQUE("participant_no"),
	CONSTRAINT "participants_id_team_unique" UNIQUE("id","team_id"),
	CONSTRAINT "participants_team_identity_unique" UNIQUE("team_id","identity_key"),
	CONSTRAINT "participants_name_not_blank" CHECK (length(trim("participants"."name")) > 0)
);--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participants_one_leader_per_team" ON "participants" USING btree ("team_id") WHERE "participants"."is_leader" and "participants"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "participants_team_id_idx" ON "participants" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "participants_email_idx" ON "participants" USING btree ("email");--> statement-breakpoint

CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_by" uuid,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_reason" text,
	CONSTRAINT "check_ins_undo_consistency" CHECK (("check_ins"."undone_by" is null) or ("check_ins"."undone_at" is not null))
);--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_participant_team_fk" FOREIGN KEY ("participant_id","team_id") REFERENCES "public"."participants"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_ins_one_active_per_participant" ON "check_ins" USING btree ("participant_id") WHERE "check_ins"."undone_at" is null;--> statement-breakpoint
CREATE INDEX "check_ins_team_id_idx" ON "check_ins" USING btree ("team_id");--> statement-breakpoint

CREATE TABLE "coupon_issuances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"coupon_type" "coupon_type" NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"request_id" uuid,
	"reverted_at" timestamp with time zone,
	"reverted_by" uuid,
	"revert_reason" text,
	CONSTRAINT "coupon_issuances_revert_consistency" CHECK (("coupon_issuances"."reverted_at" is null) = ("coupon_issuances"."revert_reason" is null))
);--> statement-breakpoint
ALTER TABLE "coupon_issuances" ADD CONSTRAINT "coupon_issuances_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_issuances" ADD CONSTRAINT "coupon_issuances_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_issuances" ADD CONSTRAINT "coupon_issuances_participant_team_fk" FOREIGN KEY ("participant_id","team_id") REFERENCES "public"."participants"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_issuances_one_per_entitlement" ON "coupon_issuances" USING btree ("participant_id","coupon_type") WHERE "coupon_issuances"."reverted_at" is null;--> statement-breakpoint
CREATE INDEX "coupon_issuances_team_id_idx" ON "coupon_issuances" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "coupon_issuances_request_id_idx" ON "coupon_issuances" USING btree ("request_id");--> statement-breakpoint

CREATE TABLE "event_sessions" (
	"id" "event_session_id" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_sessions_time_order" CHECK ("event_sessions"."ends_at" > "event_sessions"."starts_at")
);--> statement-breakpoint

CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" "event_session_id" NOT NULL,
	"room_number" text NOT NULL,
	"nominal_capacity" integer NOT NULL,
	"overflow_tolerance" integer DEFAULT 3 NOT NULL,
	"occupancy" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_session_number_unique" UNIQUE("session_id","room_number"),
	CONSTRAINT "rooms_id_session_unique" UNIQUE("id","session_id"),
	CONSTRAINT "rooms_capacity_positive" CHECK ("rooms"."nominal_capacity" > 0),
	CONSTRAINT "rooms_tolerance_range" CHECK ("rooms"."overflow_tolerance" >= 0 and "rooms"."overflow_tolerance" <= 50),
	CONSTRAINT "rooms_occupancy_within_limit" CHECK ("rooms"."occupancy" >= 0 and "rooms"."occupancy" <= "rooms"."nominal_capacity" + "rooms"."overflow_tolerance")
);--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_session_id_event_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."event_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "team_room_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" "event_session_id" NOT NULL,
	"team_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	CONSTRAINT "team_room_assignments_session_team_unique" UNIQUE("session_id","team_id"),
	CONSTRAINT "team_room_assignments_session_team_room_unique" UNIQUE("session_id","team_id","room_id")
);--> statement-breakpoint
ALTER TABLE "team_room_assignments" ADD CONSTRAINT "team_room_assignments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_room_assignments" ADD CONSTRAINT "team_room_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_room_assignments" ADD CONSTRAINT "team_room_assignments_room_session_fk" FOREIGN KEY ("room_id","session_id") REFERENCES "public"."rooms"("id","session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_room_assignments_room_id_idx" ON "team_room_assignments" USING btree ("room_id");--> statement-breakpoint

CREATE TABLE "room_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" "event_session_id" NOT NULL,
	"room_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" uuid,
	CONSTRAINT "room_allocations_session_participant_unique" UNIQUE("session_id","participant_id")
);--> statement-breakpoint
ALTER TABLE "room_allocations" ADD CONSTRAINT "room_allocations_allocated_by_users_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_allocations" ADD CONSTRAINT "room_allocations_participant_team_fk" FOREIGN KEY ("participant_id","team_id") REFERENCES "public"."participants"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_allocations" ADD CONSTRAINT "room_allocations_team_assignment_fk" FOREIGN KEY ("session_id","team_id","room_id") REFERENCES "public"."team_room_assignments"("session_id","team_id","room_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_allocations_room_id_idx" ON "room_allocations" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_allocations_team_id_idx" ON "room_allocations" USING btree ("team_id");--> statement-breakpoint

-- rooms.occupancy is maintained here, in the same statement as every
-- allocation change. The UPDATE takes the room's row lock, so concurrent
-- allocations to one room serialise, and rooms_occupancy_within_limit rejects
-- any change that would take the room past nominal capacity + tolerance.
CREATE FUNCTION "room_allocations_sync_occupancy"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "rooms" SET "occupancy" = "occupancy" + 1 WHERE "id" = NEW."room_id";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "rooms" SET "occupancy" = "occupancy" - 1 WHERE "id" = OLD."room_id";
  ELSIF NEW."room_id" IS DISTINCT FROM OLD."room_id" THEN
    UPDATE "rooms" SET "occupancy" = "occupancy" - 1 WHERE "id" = OLD."room_id";
    UPDATE "rooms" SET "occupancy" = "occupancy" + 1 WHERE "id" = NEW."room_id";
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "room_allocations_sync_occupancy"
  AFTER INSERT OR DELETE OR UPDATE OF "room_id" ON "room_allocations"
  FOR EACH ROW EXECUTE FUNCTION "room_allocations_sync_occupancy"();--> statement-breakpoint

-- Event configuration from the published schedule (times in IST, UTC+05:30).
-- Capacities and tolerance are editable by an admin in Settings.
INSERT INTO "event_sessions" ("id", "name", "starts_at", "ends_at") VALUES
  ('talks', 'Open-source talks', '2026-10-24 12:00:00+05:30', '2026-10-24 13:30:00+05:30'),
  ('hackathon', 'Hackathon', '2026-10-24 16:00:00+05:30', '2026-10-25 04:00:00+05:30')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "rooms" ("session_id", "room_number", "nominal_capacity", "overflow_tolerance", "sort_order") VALUES
  ('talks', '401', 60, 3, 1),
  ('talks', '402', 60, 3, 2),
  ('talks', '501', 60, 3, 3),
  ('hackathon', '401', 60, 3, 1),
  ('hackathon', '402', 60, 3, 2),
  ('hackathon', '501', 60, 3, 3),
  ('hackathon', '502', 60, 3, 4),
  ('hackathon', '403', 40, 3, 5),
  ('hackathon', '405', 40, 3, 6),
  ('hackathon', '503', 40, 3, 7),
  ('hackathon', '504', 40, 3, 8),
  ('hackathon', '505', 40, 3, 9)
ON CONFLICT ("session_id", "room_number") DO NOTHING;
