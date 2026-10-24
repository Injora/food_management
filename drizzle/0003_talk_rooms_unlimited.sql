ALTER TABLE "rooms" DROP CONSTRAINT "rooms_capacity_positive";--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_occupancy_within_limit";--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "nominal_capacity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_hackathon_capacity_required" CHECK ("rooms"."session_id" <> 'hackathon' or "rooms"."nominal_capacity" is not null);--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_capacity_positive" CHECK ("rooms"."nominal_capacity" is null or "rooms"."nominal_capacity" > 0);--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_occupancy_within_limit" CHECK ("rooms"."occupancy" >= 0 and ("rooms"."nominal_capacity" is null or "rooms"."occupancy" <= "rooms"."nominal_capacity" + "rooms"."overflow_tolerance"));--> statement-breakpoint
-- Open-source talk rooms have no capacity limit: volunteers decide. Hackathon rooms keep theirs.
UPDATE "rooms" SET "nominal_capacity" = NULL, "updated_at" = now() WHERE "session_id" = 'talks';
