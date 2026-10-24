import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { eq, sql } from "drizzle-orm";
import Papa from "papaparse";
import { afterAll, beforeEach, describe, expect } from "vitest";

import { createDb, type Db } from "@/db";
import { rooms, users } from "@/db/schema";
import type { Role, SessionId } from "@/lib/domain";
import { AppError, type ErrorCode } from "@/lib/errors";
import type { Actor } from "@/server/auth/permissions";
import { loadBoard } from "@/server/services/board";
import { createTeam } from "@/server/services/teams";

config({ path: [".env.local", ".env"], quiet: true });

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

/** Integration suites run only against a real PostgreSQL database. */
export const describeDb = TEST_DB_URL ? describe : describe.skip;

export const parseRows = (text: string) => Papa.parse<string[]>(text, { skipEmptyLines: false }).data.filter((r, i, all) => i < all.length - 1 || r.some((c) => c !== ""));
export const readFixture = (name: string) => fs.readFileSync(path.join("tests", "fixtures", name), "utf8");

/**
 * Opens a pool for the suite and resets operational data before each test.
 * Rooms and sessions are reference data from the migration: occupancy is reset
 * by deleting allocations (the trigger keeps it in sync) and capacities are
 * restored to the published schedule.
 */
export function useTestDb() {
  const handle = TEST_DB_URL ? createDb(TEST_DB_URL, 20) : null;
  beforeEach(async () => {
    const db = handle!.db;
    await db.execute(sql`delete from room_allocations`);
    await db.execute(sql`delete from team_room_assignments`);
    await db.execute(sql`truncate audit_logs, check_ins, coupon_issuances, participants, teams, registration_imports, sessions, users restart identity cascade`);
    await db.execute(sql`delete from rooms where room_number like 'T%'`);
    await db.execute(
      sql`update rooms set overflow_tolerance = 3, nominal_capacity = case when session_id = 'talks' then null when room_number in ('403','405','503','504','505') then 40 else 60 end`,
    );
  });
  afterAll(async () => {
    await handle?.pool.end();
  });
  return {
    get db(): Db {
      return handle!.db;
    },
  };
}

let userSeq = 0;
export async function makeActor(db: Db, role: Role = "admin", password = "irrelevant-hash"): Promise<Actor> {
  const email = `${role}${++userSeq}@test.local`;
  const [u] = await db.insert(users).values({ email, name: `${role} ${userSeq}`, role, passwordHash: password }).returning();
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export async function expectAppError(promise: Promise<unknown>, code: ErrorCode) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

/** Registers a team of `size` named members through the real service. */
export async function makeTeam(db: Db, admin: Actor, name: string, size: number) {
  const members = Array.from({ length: size }, (_, i) => ({ name: `${name} Member ${i + 1}`, email: `${name.toLowerCase().replace(/\W+/g, "")}${i + 1}@test.local` }));
  const { teamId } = await createTeam(db, admin, { teamName: name, members, leaderIndex: 0 });
  const board = await loadBoard(db, admin, { teamIds: [teamId] });
  const team = board.teams[0];
  return { teamId, memberIds: team.members.map((m) => m.id), team };
}

export async function teamState(db: Db, actor: Actor, teamId: string) {
  const board = await loadBoard(db, actor, { teamIds: [teamId] });
  return board.teams[0];
}

export async function room(db: Db, session: SessionId, roomNumber: string) {
  const [r] = await db.select().from(rooms).where(sql`${rooms.sessionId} = ${session} and ${rooms.roomNumber} = ${roomNumber}`);
  if (!r) throw new Error(`No room ${roomNumber} in ${session}`);
  return r;
}

export async function setRoom(db: Db, id: string, nominalCapacity: number | null, overflowTolerance = 3) {
  await db.update(rooms).set({ nominalCapacity, overflowTolerance }).where(eq(rooms.id, id));
}
