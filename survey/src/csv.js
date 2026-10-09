function escapeCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(columns, rows) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => escapeCell(row[col])).join(","));
  return [header, ...body].join("\n") + "\n";
}
