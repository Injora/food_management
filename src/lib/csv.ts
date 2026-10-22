/**
 * Serialises rows as RFC 4180 CSV. Cells that a spreadsheet would execute as
 * a formula (=, +, -, @, tab, CR) are prefixed with an apostrophe.
 */
export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows.map((row) => row.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}

function escapeCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
