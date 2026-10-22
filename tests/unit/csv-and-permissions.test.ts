import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/csv";
import { AppError } from "@/lib/errors";
import { assertPermission, can, type Actor } from "@/server/auth/permissions";
import { hashPassword, verifyPassword } from "@/server/auth/password";

describe("toCsv", () => {
  it("quotes separators and neutralises spreadsheet formulas", () => {
    expect(toCsv([["a,b", 'say "hi"', null, 4], ["=SUM(A1)", "@cmd", "-1+1", "ok"]])).toBe(
      `"a,b","say ""hi""",,4\r\n'=SUM(A1),'@cmd,'-1+1,ok\r\n`,
    );
  });
});

describe("permissions", () => {
  const admin: Actor = { id: "1", email: "a@x", name: "A", role: "admin" };
  const organizer: Actor = { id: "2", email: "o@x", name: "O", role: "organizer" };

  it("lets organizers issue but not administer", () => {
    expect(can(organizer, "distribution:issue")).toBe(true);
    expect(can(organizer, "teams:view")).toBe(true);
    for (const p of ["distribution:correct", "teams:edit", "teams:import", "reports:view", "users:manage"] as const) {
      expect(can(organizer, p)).toBe(false);
      expect(can(admin, p)).toBe(true);
    }
  });

  it("distinguishes unauthenticated from forbidden", () => {
    expect(() => assertPermission(null, "distribution:issue")).toThrow(AppError);
    try {
      assertPermission(null, "distribution:issue");
    } catch (e) {
      expect((e as AppError).code).toBe("UNAUTHORIZED");
    }
    try {
      assertPermission(organizer, "teams:import");
    } catch (e) {
      expect((e as AppError).code).toBe("FORBIDDEN");
    }
  });
});

describe("password hashing", () => {
  it("verifies the right password only", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});
