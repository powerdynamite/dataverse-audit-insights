/**
 * Converts a Dataverse logical field name to a human-readable label.
 * e.g. "hl_assetname" → "Asset Name", "createdon" → "Created On"
 */
export function formatFieldName(logicalName: string): string {
  // Strip common 2–4 char publisher prefix (e.g. "hl_", "cr7_", "new_")
  const stripped = logicalName.replace(/^[a-z]{2,4}_/, "");
  // Split on underscores, title-case each word
  return stripped
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Format an ISO date string for display */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Escape a value for CSV (wraps in quotes, escapes internal quotes) */
function csvCell(value: string | null | undefined): string {
  const s = value ?? "";
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Export audit entries to a CSV file and trigger a browser download.
 * One row per field change — so an Update with 5 fields produces 5 rows.
 */
export function exportToCsv(
  entries: import("../types").AuditEntry[],
  ctx: import("../types").RecordContext
): void {
  const rows: string[] = [
    ["Date", "Operation", "User", "Field", "Old Value", "New Value"].map(csvCell).join(",")
  ];

  for (const entry of entries) {
    if (entry.changes.length === 0) {
      rows.push([
        formatDate(entry.createdOn),
        entry.operationName,
        entry.userName ?? entry.userId ?? "Unknown",
        "",
        "",
        ""
      ].map(csvCell).join(","));
    } else {
      for (const change of entry.changes) {
        rows.push([
          formatDate(entry.createdOn),
          entry.operationName,
          entry.userName ?? entry.userId ?? "Unknown",
          formatFieldName(change.logicalName),
          change.oldLabel ?? change.oldValue ?? "",
          change.newLabel ?? change.newValue ?? ""
        ].map(csvCell).join(","));
      }
    }
  }

  const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit_${ctx.tableLogicalName}_${ctx.recordId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
