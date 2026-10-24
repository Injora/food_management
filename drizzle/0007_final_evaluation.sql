ALTER TABLE "team_evaluations" DROP CONSTRAINT "team_evaluations_score1_range";--> statement-breakpoint
ALTER TABLE "team_evaluations" DROP CONSTRAINT "team_evaluations_score2_range";--> statement-breakpoint
ALTER TABLE "team_evaluations" DROP CONSTRAINT "team_evaluations_score3_range";--> statement-breakpoint
ALTER TABLE "team_evaluations" DROP CONSTRAINT "team_evaluations_score4_range";--> statement-breakpoint
ALTER TABLE "team_evaluations" DROP CONSTRAINT "team_evaluations_score5_range";--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD COLUMN "score6" smallint;--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_score6_range" CHECK ("team_evaluations"."score6" is null or "team_evaluations"."score6" between 1 and 10);--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_mid_scale" CHECK ("team_evaluations"."phase" <> 'mid' or ("team_evaluations"."score6" is null and greatest("team_evaluations"."score1", "team_evaluations"."score2", "team_evaluations"."score3", "team_evaluations"."score4", "team_evaluations"."score5") <= 5));--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_score1_range" CHECK ("team_evaluations"."score1" is null or "team_evaluations"."score1" between 1 and 10);--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_score2_range" CHECK ("team_evaluations"."score2" is null or "team_evaluations"."score2" between 1 and 10);--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_score3_range" CHECK ("team_evaluations"."score3" is null or "team_evaluations"."score3" between 1 and 10);--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_score4_range" CHECK ("team_evaluations"."score4" is null or "team_evaluations"."score4" between 1 and 10);--> statement-breakpoint
ALTER TABLE "team_evaluations" ADD CONSTRAINT "team_evaluations_score5_range" CHECK ("team_evaluations"."score5" is null or "team_evaluations"."score5" between 1 and 10);