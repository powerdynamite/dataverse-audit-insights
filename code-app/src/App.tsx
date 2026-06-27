import { useEffect, useMemo, useState } from "react";
import { type AuditEntry, type DiffRow, type RecordContext } from "./types";
import {
  retrieveChangeHistory,
  buildDiffRows,
  restoreFields,
  smartDeleteRestore,
  type SmartRestoreResult
} from "./services/auditService";
import { RecordLookup } from "./components/RecordLookup";
import { ChangeHistory } from "./components/ChangeHistory";
import { FieldDiff } from "./components/FieldDiff";
import { BulkRestore } from "./components/BulkRestore";

type View = "lookup" | "history" | "diff" | "bulk";

function readLaunchParams(): RecordContext {
  const p = new URLSearchParams(window.location.search);
  return {
    tableLogicalName: p.get("table") ?? "",
    recordId: p.get("id") ?? ""
  };
}

export function App() {
  const launch = useMemo(readLaunchParams, []);
  const [view, setView]               = useState<View>("lookup");
  const [ctx, setCtx]                 = useState<RecordContext>(launch);
  const [entries, setEntries]         = useState<AuditEntry[]>([]);
  const [selected, setSelected]       = useState<AuditEntry | null>(null);
  const [rows, setRows]               = useState<DiffRow[]>([]);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [restoreResult, setRestoreResult]         = useState<string | null>(null);
  const [smartRestoreResult, setSmartRestoreResult] = useState<SmartRestoreResult | null>(null);
  const [bulkEntries, setBulkEntries]             = useState<AuditEntry[]>([]);

  async function load(target: RecordContext) {
    setBusy(true); setError(null);
    try {
      const history = await retrieveChangeHistory(target);
      // Dataverse emits two audit rows per delete (entity + cascade cleanup).
      // Deduplicate: keep first entry per (operation, createdOn) pair.
      const seen = new Set<string>();
      const deduped = history.filter((e) => {
        // Normalise to the second — Dataverse sometimes emits two rows with
        // the same wall-clock second but different sub-second fractions.
        const key = `${e.operation}|${e.createdOn.slice(0, 19)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setCtx(target); setEntries(deduped); setView("history");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (launch.tableLogicalName && /^[0-9a-fA-F-]{36}$/.test(launch.recordId)) {
      void load(launch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openDiff(entry: AuditEntry) {
    setSelected(entry);
    setRows(buildDiffRows(entry));
    setRestoreResult(null);
    setSmartRestoreResult(null);
    setView("diff");
  }

  function toggle(logicalName: string) {
    setRows((rs) => rs.map((r) =>
      r.logicalName === logicalName ? { ...r, selected: !r.selected } : r
    ));
  }

  function toggleAll(select: boolean) {
    setRows((rs) => rs.map((r) => ({ ...r, selected: select })));
  }

  async function doRestore() {
    setBusy(true); setError(null);
    try {
      const written = await restoreFields(ctx, rows);
      setRestoreResult(
        written.length
          ? `Restored ${written.length} field(s): ${written.join(", ")}. A note was logged on the record.`
          : "No writable fields were selected (lookups must be restored manually)."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function doSmartRestore() {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const result = await smartDeleteRestore(ctx, selected.createdOn, rows);
      setSmartRestoreResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  // Detect if the record is likely deleted (most recent audit event is Delete)
  const recordIsDeleted = entries.length > 0 && entries[0].operation === 3;

  return (
    <>
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__logo">◈</span>
          <div>
            <span className="app-header__title">Audit Restore</span>
            <span className="app-header__tagline">Dataverse Record History &amp; Restore</span>
          </div>
        </div>
        {ctx.tableLogicalName && (
          <span className="app-header__env">{ctx.tableLogicalName}</span>
        )}
      </header>

      <div className="app">
        {error && <div className="app-banner app-banner--err">{error}</div>}

        {view === "lookup" && (
          <RecordLookup initial={ctx} onLoad={load} busy={busy} />
        )}

        {view === "history" && (
          <ChangeHistory
            ctx={ctx}
            entries={entries}
            recordIsDeleted={recordIsDeleted}
            onSelect={openDiff}
            onBulkRestore={(selected) => { setBulkEntries(selected); setView("bulk"); }}
            onBack={() => setView("lookup")}
            onRefresh={() => void load(ctx)}
            refreshing={busy}
          />
        )}

        {view === "bulk" && (
          <BulkRestore
            ctx={ctx}
            entries={bulkEntries}
            onBack={() => setView("history")}
          />
        )}

        {view === "diff" && selected && (
          <FieldDiff
            entry={selected}
            rows={rows}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onRestore={doRestore}
            onSmartRestore={doSmartRestore}
            onBack={() => setView("history")}
            busy={busy}
            restoreResult={restoreResult}
            smartRestoreResult={smartRestoreResult}
          />
        )}
      </div>
    </>
  );
}
