import Papa from "papaparse";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type RawSheet = { name: string; rows: string[][] };

/**
 * Reads a CSV or Excel registration file into raw rows of strings, one entry
 * per worksheet (a CSV is one sheet). Works in the browser and in Node.
 * Header detection happens later (prepareTable).
 */
export async function readRegistrationFile(fileName: string, bytes: Uint8Array): Promise<RawSheet[]> {
  if (bytes.byteLength === 0) throw new Error("The file is empty.");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("The file is larger than 10 MB.");
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".xlsx")) {
    const { default: readXlsxFile } = await import("read-excel-file/universal");
    const sheets = await readXlsxFile(bytes.slice().buffer);
    const result = sheets
      .map((s) => ({
        name: s.sheet,
        rows: s.data.map((r) => r.map((c) => (c == null ? "" : c instanceof Date ? c.toISOString() : String(c)))),
      }))
      .filter((s) => s.rows.some((r) => r.some((c) => c.trim() !== "")));
    if (result.length === 0) throw new Error("The workbook has no data.");
    return result;
  }
  if (lower.endsWith(".xls")) {
    throw new Error("Old .xls files are not supported. Save the sheet as .xlsx or CSV and try again.");
  }

  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const fatal = parsed.errors.find((e) => e.code === "MissingQuotes");
  if (fatal) throw new Error(`Row ${(fatal.row ?? 0) + 1} has an unbalanced quote; fix the file and try again.`);
  // Papa leaves a trailing empty row for files ending in a newline.
  const rows = parsed.data;
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  if (rows.length === 0) throw new Error("The file has no rows.");
  return [{ name: fileName, rows }];
}
