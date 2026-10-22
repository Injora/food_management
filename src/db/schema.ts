import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { DISTRIBUTION_STATUSES, MEAL_TYPES, ROLES } from "../lib/meals";

export const mealTypeEnum = pgEnum("meal_type", MEAL_TYPES);
export const distributionStatusEnum = pgEnum("distribution_status", DISTRIBUTION_STATUSES);
export const userRoleEnum = pgEnum("user_role", ROLES);
export const auditActionEnum = pgEnum("audit_action", [
  "csv_import",
  "team_create",
  "team_update",
  "team_delete",
  "member_count_correction",
  "coupon_issue",
  "coupon_reversal",
  "coupon_quantity_correction",
  "user_create",
  "user_update",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: userRoleEnum("role").notNull().default("organizer"),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [check("users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 of the cookie token; the raw token is never stored.
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const meals = pgTable("meals", {
  type: mealTypeEnum("type").primaryKey(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().unique(),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamName: text("team_name").notNull(),
    // Case/space/punctuation-insensitive form of team_name. Unique so that
    // "Code Pirates" and "code-pirates" can't become two teams.
    teamNameKey: text("team_name_key").notNull().unique(),
    teamCode: text("team_code").notNull().unique(),
    teamLeaderName: text("team_leader_name"),
    teamLeaderEmail: text("team_leader_email"),
    memberCount: integer("member_count").notNull(),
    ...timestamps,
  },
  (t) => [
    check("teams_member_count_positive", sql`${t.memberCount} > 0`),
    check("teams_name_not_blank", sql`length(trim(${t.teamName})) > 0`),
    check("teams_code_not_blank", sql`length(trim(${t.teamCode})) > 0`),
  ],
);

export const distributions = pgTable(
  "distributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    mealType: mealTypeEnum("meal_type")
      .notNull()
      .references(() => meals.type),
    couponQuantity: integer("coupon_quantity").notNull(),
    status: distributionStatusEnum("status").notNull().default("pending"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    // Client-generated id of the request that issued this meal, so a retried
    // request (e.g. after a dropped connection) is recognised as a replay.
    issueRequestId: uuid("issue_request_id"),
    ...timestamps,
  },
  (t) => [
    unique("distributions_team_meal_unique").on(t.teamId, t.mealType),
    index("distributions_meal_status_idx").on(t.mealType, t.status),
    check("distributions_quantity_positive", sql`${t.couponQuantity} > 0`),
    check(
      "distributions_issued_consistency",
      sql`(${t.status} = 'issued') = (${t.issuedAt} IS NOT NULL)`,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    // Snapshot so the log stays readable if the user is later removed.
    actorEmail: text("actor_email"),
    action: auditActionEnum("action").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    teamLabel: text("team_label"),
    mealType: mealTypeEnum("meal_type"),
    reason: text("reason"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("audit_logs_created_at_idx").on(t.createdAt),
    index("audit_logs_team_id_idx").on(t.teamId),
  ],
);

export type User = typeof users.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Distribution = typeof distributions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
