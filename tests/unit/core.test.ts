import { describe, expect, it } from "vitest";

import { capacityErrorMessage, effectiveMax, evaluateFit, roomLevel, suggestRooms } from "@/lib/capacity";
import { toCsv } from "@/lib/csv";
import { checkInStatus } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { assertPermission, can, type Actor } from "@/server/auth/permissions";

describe("room capacity with a ±3 tolerance", () => {
  const room = (occupancy: number, nominalCapacity = 60, overflowTolerance = 3) => ({ occupancy, nominalCapacity, overflowTolerance });

  // The decision table from the event brief.
  it.each([
    [59, 60, 4, 63, "allow"],
    [60, 60, 3, 63, "allow"],
    [61, 60, 3, 64, "reject"],
    [57, 60, 5, 62, "allow"],
    [40, 40, 4, 44, "reject"],
  ] as const)("%i/%i + %i → %i: %s", (occupancy, capacity, incoming, projected, decision) => {
    const fit = evaluateFit(room(occupancy, capacity), incoming);
    expect(fit.projected).toBe(projected);
    expect(fit.decision === "reject" ? "reject" : "allow").toBe(decision);
  });

  it("distinguishes fitting, overflow and rejection", () => {
    expect(evaluateFit(room(42), 18).decision).toBe("fits");
    expect(evaluateFit(room(42), 19).decision).toBe("overflow");
    expect(evaluateFit(room(42), 22).decision).toBe("reject");
    expect(effectiveMax(room(0, 40))).toBe(43);
    expect(evaluateFit(room(0, 40, 0), 41).decision).toBe("reject");
  });

  it("labels room levels", () => {
    expect(roomLevel(room(10))).toBe("open");
    expect(roomLevel(room(52))).toBe("near");
    expect(roomLevel(room(60))).toBe("full");
    expect(roomLevel(room(61))).toBe("overflow");
    expect(roomLevel(room(63))).toBe("max");
  });

  it("suggests rooms with nominal space before overflow rooms", () => {
    const rooms = [
      { id: "a", ...room(58) }, // 4 would need the tolerance
      { id: "b", ...room(30) },
      { id: "c", ...room(62) }, // no space
      { id: "d", ...room(50) },
    ];
    expect(suggestRooms(rooms, 4).map((o) => [o.room.id, o.decision])).toEqual([
      ["b", "fits"],
      ["d", "fits"],
      ["a", "overflow"],
    ]);
    expect(suggestRooms(rooms, 4, "b").map((o) => o.room.id)).toEqual(["d", "a"]);
    expect(suggestRooms(rooms, 40)).toEqual([]);
  });

  it("never rejects an unlimited (talk) room and ranks it with the roomiest", () => {
    const unlimited = { occupancy: 500, nominalCapacity: null, overflowTolerance: 3 };
    expect(evaluateFit(unlimited, 100)).toEqual({ decision: "fits", projected: 600 });
    expect(roomLevel(unlimited)).toBe("unlimited");
    expect(suggestRooms([{ id: "a", ...room(10) }, { id: "u", ...unlimited }], 4).map((o) => o.room.id)).toEqual(["u", "a"]);
  });

  it("uses the required error wording", () => {
    expect(capacityErrorMessage("401", 3)).toEqual({
      title: "Maximum capacity reached for Room 401.",
      message: "Room capacity limit reached, including the 3-person tolerance. Please allocate this team to another room.",
    });
  });
});

describe("check-in status", () => {
  it("derives status from member counts", () => {
    expect(checkInStatus(0, 4)).toBe("none");
    expect(checkInStatus(1, 4)).toBe("partial");
    expect(checkInStatus(3, 4)).toBe("partial");
    expect(checkInStatus(4, 4)).toBe("full");
    expect(checkInStatus(0, 0)).toBe("none");
  });
});

describe("toCsv", () => {
  it("quotes separators and neutralises spreadsheet formulas", () => {
    expect(toCsv([["a,b", 'say "hi"', null, 4], ["=SUM(A1)", "@cmd", "-1+1", "ok"]])).toBe(
      `"a,b","say ""hi""",,4\r\n'=SUM(A1),'@cmd,'-1+1,ok\r\n`,
    );
  });
});

describe("permissions", () => {
  const admin: Actor = { id: "1", email: "a@x", name: "A", role: "admin" };
  const volunteer: Actor = { id: "2", email: "o@x", name: "O", role: "organizer" };

  it("lets volunteers run the desk but not administer", () => {
    for (const p of ["board:view", "checkin:write", "checkin:undo", "coupons:issue", "rooms:allocate", "rooms:reassign", "teams:view"] as const) {
      expect(can(volunteer, p)).toBe(true);
    }
    for (const p of ["coupons:revert", "rooms:configure", "teams:edit", "teams:import", "reports:view", "users:manage"] as const) {
      expect(can(volunteer, p)).toBe(false);
      expect(can(admin, p)).toBe(true);
    }
  });

  it("distinguishes unauthenticated from forbidden", () => {
    const codeOf = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return (e as AppError).code;
      }
      return null;
    };
    expect(codeOf(() => assertPermission(null, "checkin:write"))).toBe("UNAUTHORIZED");
    expect(codeOf(() => assertPermission(volunteer, "rooms:configure"))).toBe("FORBIDDEN");
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
