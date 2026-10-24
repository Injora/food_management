import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { COUPON_TYPES, ROLES, SESSION_IDS } from "../lib/domain";

export const userRoleEnum = pgEnum("user_role", ROLES);
export const couponTypeEnum = pgEnum("coupon_type", COUPON_TYPES);
export const sessionIdEnum = pgEnum("event_session_id", SESSION_IDS);
export const auditActionEnum = pgEnum("audit_action", [
  "csv_import",
  "team_create",
  "team_update",
  "team_delete",
  // Legacy values from the team-level meal model (kept so old rows stay valid).
  "member_count_correction",
  "coupon_issue",
  "coupon_reversal",
  "coupon_quantity_correction",
  "user_create",
  "user_update",
  "team_archive",
  "participant_create",
  "participant_update",
  "participant_withdraw",
  "check_in",
  "check_in_undo",
  "room_assign",
  "room_move",
  "room_release",
  "room_update",
  "room_create",
  "session_update",
  "mlh_import",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// ---------------------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const registrationImports = pgTable("registration_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileName: text("file_name").notNull(),
  layout: text("layout").notNull(),
  mode: text("mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
  /** Validation issues shown to the organizer at import time (capped). */
  issues: jsonb("issues").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
});

/**
 * The latest registration list exported from the MLH portal, kept as-is for
 * comparison with the website's participants. Replaced wholesale on upload;
 * matching to participants happens at read time, so it never goes stale.
 */
export const mlhRegistrations = pgTable(
  "mlh_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    position: integer("position").notNull(),
    fullName: text("full_name").notNull(),
    teamName: text("team_name").notNull().default(""),
    status: text("status").notNull(),
    fileName: text("file_name").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("mlh_registrations_position_idx").on(t.position)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamCode: text("team_code").notNull().unique(),
    teamName: text("team_name").notNull(),
    // Case/space/punctuation-insensitive form of team_name, for search and
    // duplicate warnings. Not unique: two different teams may share a name.
    teamNameKey: text("team_name_key").notNull(),
    // Identity used to recognise the same registration on re-import
    // (leader email, else leader phone, else team name + leader name).
    registrationKey: text("registration_key").notNull().unique(),
    college: text("college"),
    // As stated in the registration file; the real size is the member list.
    declaredMemberCount: integer("declared_member_count"),
    declaredRegisteredCount: integer("declared_registered_count"),
    sourceImportId: uuid("source_import_id").references(() => registrationImports.id, { onDelete: "set null" }),
    source: jsonb("source").$type<Record<string, unknown>>(),
    // Teams with operational history are archived, never deleted.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedReason: text("archived_reason"),
    ...timestamps,
  },
  (t) => [
    index("teams_team_name_key_idx").on(t.teamNameKey),
    check("teams_name_not_blank", sql`length(trim(${t.teamName})) > 0`),
    check("teams_code_not_blank", sql`length(trim(${t.teamCode})) > 0`),
  ],
);

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable, human-friendly id shown as P-0001.
    participantNo: integer("participant_no").generatedAlwaysAsIdentity().notNull().unique(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    // Participant id from the registration file, when it has one.
    externalId: text("external_id"),
    // Matching key within the team on re-import (external id, email, phone or name).
    identityKey: text("identity_key").notNull(),
    isLeader: boolean("is_leader").notNull().default(false),
    position: integer("position").notNull().default(0),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    source: jsonb("source").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    // Target of the composite foreign keys that pin records to the right team.
    unique("participants_id_team_unique").on(t.id, t.teamId),
    unique("participants_team_identity_unique").on(t.teamId, t.identityKey),
    uniqueIndex("participants_one_leader_per_team")
      .on(t.teamId)
      .where(sql`${t.isLeader} and ${t.withdrawnAt} is null`),
    index("participants_team_id_idx").on(t.teamId),
    index("participants_email_idx").on(t.email),
    check("participants_name_not_blank", sql`length(trim(${t.name})) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Attendance and coupons
// ---------------------------------------------------------------------------

export const checkIns = pgTable(
  "check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    participantId: uuid("participant_id").notNull(),
    teamId: uuid("team_id").notNull(),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).defaultNow().notNull(),
    checkedInBy: uuid("checked_in_by").references(() => users.id, { onDelete: "set null" }),
    // Undone check-ins are kept as history.
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by").references(() => users.id, { onDelete: "set null" }),
    undoReason: text("undo_reason"),
  },
  (t) => [
    foreignKey({
      name: "check_ins_participant_team_fk",
      columns: [t.participantId, t.teamId],
      foreignColumns: [participants.id, participants.teamId],
    }).onDelete("restrict"),
    // At most one live check-in per participant.
    uniqueIndex("check_ins_one_active_per_participant").on(t.participantId).where(sql`${t.undoneAt} is null`),
    index("check_ins_team_id_idx").on(t.teamId),
    check("check_ins_undo_consistency", sql`(${t.undoneBy} is null) or (${t.undoneAt} is not null)`),
  ],
);

export const couponIssuances = pgTable(
  "coupon_issuances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    participantId: uuid("participant_id").notNull(),
    teamId: uuid("team_id").notNull(),
    couponType: couponTypeEnum("coupon_type").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    // Client-generated per confirmation, so a retried request is recognised.
    requestId: uuid("request_id"),
    // Reverted issuances are kept as history and free the entitlement again.
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertedBy: uuid("reverted_by").references(() => users.id, { onDelete: "set null" }),
    revertReason: text("revert_reason"),
  },
  (t) => [
    foreignKey({
      name: "coupon_issuances_participant_team_fk",
      columns: [t.participantId, t.teamId],
      foreignColumns: [participants.id, participants.teamId],
    }).onDelete("restrict"),
    // One live coupon per participant per meal: the entitlement can't be used twice.
    uniqueIndex("coupon_issuances_one_per_entitlement")
      .on(t.participantId, t.couponType)
      .where(sql`${t.revertedAt} is null`),
    index("coupon_issuances_team_id_idx").on(t.teamId),
    index("coupon_issuances_request_id_idx").on(t.requestId),
    check(
      "coupon_issuances_revert_consistency",
      sql`(${t.revertedAt} is null) = (${t.revertReason} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Sessions, rooms and allocations
// ---------------------------------------------------------------------------

export const eventSessions = pgTable(
  "event_sessions",
  {
    id: sessionIdEnum("id").primaryKey(),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check("event_sessions_time_order", sql`${t.endsAt} > ${t.startsAt}`)],
);

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: sessionIdEnum("session_id")
      .notNull()
      .references(() => eventSessions.id, { onDelete: "restrict" }),
    roomNumber: text("room_number").notNull(),
    // Null = no capacity limit (open-source talk rooms). Hackathon rooms must have one.
    nominalCapacity: integer("nominal_capacity"),
    overflowTolerance: integer("overflow_tolerance").notNull().default(3),
    // Maintained by a trigger on room_allocations, never by application code.
    occupancy: integer("occupancy").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique("rooms_session_number_unique").on(t.sessionId, t.roomNumber),
    unique("rooms_id_session_unique").on(t.id, t.sessionId),
    check("rooms_capacity_positive", sql`${t.nominalCapacity} is null or ${t.nominalCapacity} > 0`),
    check("rooms_hackathon_capacity_required", sql`${t.sessionId} <> 'hackathon' or ${t.nominalCapacity} is not null`),
    check("rooms_tolerance_range", sql`${t.overflowTolerance} >= 0 and ${t.overflowTolerance} <= 50`),
    // The hard guarantee: no transaction can commit a room above its limit.
    check(
      "rooms_occupancy_within_limit",
      sql`${t.occupancy} >= 0 and (${t.nominalCapacity} is null or ${t.occupancy} <= ${t.nominalCapacity} + ${t.overflowTolerance})`,
    ),
  ],
);

/** A team sits in exactly one room per session. */
export const teamRoomAssignments = pgTable(
  "team_room_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: sessionIdEnum("session_id").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    roomId: uuid("room_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("team_room_assignments_session_team_unique").on(t.sessionId, t.teamId),
    unique("team_room_assignments_session_team_room_unique").on(t.sessionId, t.teamId, t.roomId),
    foreignKey({
      name: "team_room_assignments_room_session_fk",
      columns: [t.roomId, t.sessionId],
      foreignColumns: [rooms.id, rooms.sessionId],
    }).onDelete("restrict"),
    index("team_room_assignments_room_id_idx").on(t.roomId),
  ],
);

/** One row per participant seated in a room for a session. */
export const roomAllocations = pgTable(
  "room_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: sessionIdEnum("session_id").notNull(),
    roomId: uuid("room_id").notNull(),
    teamId: uuid("team_id").notNull(),
    participantId: uuid("participant_id").notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).defaultNow().notNull(),
    allocatedBy: uuid("allocated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    // A participant is in at most one room per session (any room in another session).
    unique("room_allocations_session_participant_unique").on(t.sessionId, t.participantId),
    foreignKey({
      name: "room_allocations_participant_team_fk",
      columns: [t.participantId, t.teamId],
      foreignColumns: [participants.id, participants.teamId],
    }).onDelete("restrict"),
    // Members can only be seated in their team's room for that session.
    foreignKey({
      name: "room_allocations_team_assignment_fk",
      columns: [t.sessionId, t.teamId, t.roomId],
      foreignColumns: [teamRoomAssignments.sessionId, teamRoomAssignments.teamId, teamRoomAssignments.roomId],
    }).onDelete("restrict"),
    index("room_allocations_room_id_idx").on(t.roomId),
    index("room_allocations_team_id_idx").on(t.teamId),
  ],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

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
    couponType: couponTypeEnum("coupon_type"),
    sessionId: sessionIdEnum("session_id"),
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
export type Participant = typeof participants.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
