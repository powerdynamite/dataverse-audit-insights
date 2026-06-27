import { useState } from "react";
import { type AuditEntry, type DiffRow, type RecordContext } from "../types";
import { buildDiffRows, restoreFields } from "../services/auditService";
import { formatFieldName, formatDate } from "../utils/format";

type EntryStatus = "pending" | "running" | "done" | "error";

interface BulkItem {
  entry: AuditEntry;
  rows: DiffRow[];
  status: EntryStatus;
  result: string | null;
  errorMsg: string | null;
}

function toggleRow(items: BulkItem[], itemIdx: number, logicalName: string): BulkItem[] {
  return items.map((it, i) =>
    i !== itemIdx ? it : {
      ...it,
      rows: it.rows.map((r) =>
        r.logicalName === logicalName ? { ...r, selected: !r.selected } : r
      )
    }
  );
}

function toggleAllRows(items: BulkItem[], itemIdx: number, select: boolean): BulkItem[] {
  return items.map((it, i) =>
    i !== itemIdx ? it : {
      ...it,
      rows: it.rows.map((r) => ({ ...r, selected: select }))
    }
  );
}

export function BulkRestore({
  ctx,
  entries,
  onBack
}: {
  ctx: RecordContext;
  entries: AuditEntry[];
  onBack: () => void;
}) {
  const [items, setItems] = useState<BulkItem[]>(() =>
    entries.map((entry) => ({
      entry,
      rows: buildDiffRows(entry).map((r) => ({ ...r, selected: true })),
      status: "pending" as EntryStatus,
      result: null,
      errorMsg: null
    }))
  );
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  const totalFields = items.reduce(
    (sum, it) => sum + it.rows.filter((r) => r.selected).length,
    0
  );
  const doneCount    = items.filter((it) => it.status === "done").length;
  const errorCount   = items.filter((it) => it.status === "error").length;

  async function execute() {
    setRunning(true);
    for (let i = 0; i < items.length; i++) {
      if (items[i].rows.filter((r) => r.selected).length === 0) {
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "done", result: "No fields selected — skipped." } : it
          )
        );
        continue;
      }
      setItems((prev) =>
        prev.map((it, idx) => (idx === i ? { ...it, status: "running" } : it))
      );
      try {
        const written = await restoreFields(ctx, items[i].rows);
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? {
                  ...it,
                  status: "done",
                  result: written.length
                    ? `Restored ${written.length} field(s): ${written.map(formatFieldName).join(", ")}`
                    : "No writable fields (lookups must be restored manually)."
                }
              : it
          )
        );
      } catch (e) {
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? { ...it, status: "error", errorMsg: e instanceof Error ? e.message : String(e) }
              : it
          )
        );
      }
    }
    setRunning(false);
    setDone(true);
  }

  return (
    <div className="card">
      {/* Header */}
      <div className="row-between" style={{ marginBottom: 16 }}>
        <div>
          <div className="page-title">Bulk Restore</div>
          <div className="page-subtitle mono" style={{ marginTop: 4 }}>
            {ctx.tableLogicalName} · {ctx.recordId}
          </div>
        </div>
        <button onClick={onBack} disabled={running}>← Back to history</button>
      </div>

      {/* Summary bar */}
      {!done && (
        <div className="bulk-summary-bar">
          <span>
            <strong>{items.length}</strong> audit event{items.length === 1 ? "" : "s"} selected
            &nbsp;·&nbsp;
            <strong>{totalFields}</strong> field{totalFields === 1 ? "" : "s"} will be restored
          </span>
          <button
            className="primary"
            onClick={execute}
            disabled={running || totalFields === 0}
          >
            {running ? "Restoring…" : `Restore ${totalFields} field${totalFields === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {/* Done summary */}
      {done && (
        <div className={`banner ${errorCount > 0 ? "banner--warn" : "banner--ok"}`} style={{ marginBottom: 16 }}>
          <span className="banner__icon">{errorCount > 0 ? "⚠" : "✓"}</span>
          <span>
            <strong>{doneCount} of {items.length} events processed.</strong>
            {errorCount > 0 && <> {errorCount} failed — see details below.</>}
          </span>
        </div>
      )}

      {/* Entry cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
        {items.map((item, itemIdx) => {
          const selectableRows = item.rows.filter((r) => !r.logicalName.endsWith("_base"));
          const selectedCount  = selectableRows.filter((r) => r.selected).length;
          const allSelected    = selectedCount === selectableRows.length;

          return (
            <div key={item.entry.auditId} className={`bulk-entry bulk-entry--${item.status}`}>
              {/* Entry header */}
              <div className="bulk-entry__head">
                <div className="row-gap">
                  <span className={`bulk-status-dot bulk-status-dot--${item.status}`} />
                  <span className={`pill op-${item.entry.operation}`}>{item.entry.operationName}</span>
                  <span style={{ fontSize: 13, color: "var(--mid)" }}>{formatDate(item.entry.createdOn)}</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{item.entry.userName ?? item.entry.userId ?? "Unknown"}</span>
                </div>
                {item.status === "pending" && !running && (
                  <div className="row-gap" style={{ gap: 8 }}>
                    <button
                      className="ghost"
                      style={{ fontSize: 12, padding: "2px 8px" }}
                      onClick={() => setItems((prev) => toggleAllRows(prev, itemIdx, !allSelected))}
                    >
                      {allSelected ? "Deselect all" : "Select all"}
                    </button>
                    <span style={{ fontSize: 12, color: "var(--mid)" }}>
                      {selectedCount} of {selectableRows.length} fields
                    </span>
                  </div>
                )}
                {item.status === "running" && (
                  <span style={{ fontSize: 12, color: "var(--primary)" }}>Restoring…</span>
                )}
                {item.status === "done" && (
                  <span style={{ fontSize: 12, color: "var(--green)", fontWeight: 500 }}>✓ Done</span>
                )}
                {item.status === "error" && (
                  <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 500 }}>✗ Failed</span>
                )}
              </div>

              {/* Result / error */}
              {item.result && (
                <div style={{ fontSize: 12, color: "var(--mid)", padding: "4px 0 0 28px" }}>
                  {item.result}
                </div>
              )}
              {item.errorMsg && (
                <div style={{ fontSize: 12, color: "var(--red)", padding: "4px 0 0 28px" }}>
                  {item.errorMsg}
                </div>
              )}

              {/* Field checkboxes — only when pending */}
              {item.status === "pending" && !running && selectableRows.length > 0 && (
                <div className="bulk-entry__fields">
                  {selectableRows.map((row) => (
                    <label key={row.logicalName} className="bulk-field-row">
                      <input
                        type="checkbox"
                        checked={row.selected}
                        onChange={() => setItems((prev) => toggleRow(prev, itemIdx, row.logicalName))}
                      />
                      <span className="bulk-field-name">{formatFieldName(row.logicalName)}</span>
                      {row.oldValue != null && (
                        <span className="cell-old">{row.oldLabel ?? row.oldValue}</span>
                      )}
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>→</span>
                      {row.newValue != null && (
                        <span className="cell-new">{row.newLabel ?? row.newValue}</span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {done && (
        <div style={{ marginTop: 20, textAlign: "right" }}>
          <button className="primary" onClick={onBack}>← Back to history</button>
        </div>
      )}
    </div>
  );
}
