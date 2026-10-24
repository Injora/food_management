import { describe, expect, it } from "vitest";

import { parseMlhRows } from "@/lib/mlh";

describe("parseMlhRows", () => {
  it("reads the MLH export columns and normalises status", () => {
    expect(
      parseMlhRows([
        ["fullname", "team_name", "status"],
        ["  Asha   Rao ", " Byte Force ", "Checked-In"],
        ["", "x", "registered"],
        ["Ravi", "", "canceled"],
      ]),
    ).toEqual([
      { fullName: "Asha Rao", teamName: "Byte Force", status: "checked-in" },
      { fullName: "Ravi", teamName: "", status: "canceled" },
    ]);
  });

  it("rejects a file without name and status columns", () => {
    expect(() => parseMlhRows([["team", "email"], ["a", "b"]])).toThrow(/header/);
  });
});
