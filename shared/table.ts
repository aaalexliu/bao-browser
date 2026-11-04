const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function parseCsv(text: string): Record<string, string>[] {
  const rows = csvRows(text).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((cell, index) => sanitizeName(cell, index));
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
}

export function parseTable(value: unknown): Record<string, string>[] {
  if (Array.isArray(value)) {
    return value.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const record: Record<string, string> = {};
      for (const [key, cell] of Object.entries(row as Record<string, unknown>)) {
        const name = sanitizeName(key, 0);
        if (NAME_RE.test(name)) record[name] = cell == null ? "" : String(cell);
      }
      return [record];
    });
  }
  if (typeof value === "string") return parseCsv(value);
  return [];
}

function csvText(rows: string[][]): string {
  const esc = (value: string) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map((row) => row.map(esc).join(",")).join("\n") + "\n";
}

export function tableToCsv(columns: string[], rows: Record<string, string>[]): string {
  return csvText([columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))]);
}

export function mapCsv(text: string, map: (value: string, column: string) => string): string {
  const rows = csvRows(text);
  const header = rows.findIndex((row) => row.some((cell) => cell.trim()));
  if (header < 0 || rows.length <= header + 1) return text;
  const columns = rows[header]!.map((cell, index) => sanitizeName(cell, index));
  return csvText(rows.map((row, index) => index <= header ? row : row.map((cell, column) => map(cell, columns[column] ?? ""))));
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function sanitizeName(raw: string, index: number): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = /^[A-Za-z]/.test(cleaned) ? cleaned : `col_${index + 1}`;
  return NAME_RE.test(base) ? base : `col_${index + 1}`;
}
