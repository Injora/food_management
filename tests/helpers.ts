import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import Papa from "papaparse";
import { afterAll, beforeEach, describe, expect } from "vitest";

import { createDb, type Db } from "@/db";
import { users } from "@/db/schema";
import { AppError, type ErrorCode } from "@/lib/errors";
import type { ImportOptionsInput, ParsedTable } from "@/lib/csv-import";
import type { Role } from "@/lib/meals";
import type { Actor } from "@/server/auth/permissions";

config({ path: [".env.local", ".env"], quiet: true });

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

/** Integration suites run only against a real PostgreSQL database. */
export const describeDb = TEST_DB_URL ? describe : describe.skip;

export function parseCsv(text: string): ParsedTable {
  const [headers, ...rows] = Papa.parse<string[]>(text.trim(), { skipEmptyLines: "greedy" }).data;
  return { headers, rows };
}

export const readSample = (name: string) => parseCsv(fs.readFileSync(path.join("samples", name), "utf8"));

/** Opens a pool for the suite and truncates all data before each test. */
export function useTestDb() {
  const handle = TEST_DB_URL ? createDb(TEST_DB_URL, 12) : null;
  beforeEach(async () => {
    await handle!.db.execute(sql`truncate audit_logs, distributions, teams, sessions, users restart identity cascade`);
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

export const SPEC_CSV = `team_code,team_name,team_leader_name,team_leader_email,member_count
T001,Byte Builders,Aarav,aarav@example.com,4
T002,Neural Ninjas,Diya,diya@example.com,3
T003,Code Pirates,Rohan,rohan@example.com,5`;

export const columnOptions: ImportOptionsInput = {
  mapping: {
    teamName: "team_name",
    teamCode: "team_code",
    leaderName: "team_leader_name",
    leaderEmail: "team_leader_email",
    memberCount: "member_count",
    memberNameColumns: [],
  },
  countMode: "column",
  rowsPerTeam: "one",
  groupBy: "team_name",
  maxTeamSize: 10,
};
