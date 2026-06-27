import { useEffect, useRef, useState } from "react";
import { type RecordContext } from "../types";
import { searchTables, searchRecordsByName, searchDeletedRecordsByName, type TableMeta } from "../services/auditService";

export function RecordLookup({
  initial,
  onLoad,
  busy
}: {
  initial: RecordContext;
  onLoad: (ctx: RecordContext) => void;
  busy: boolean;
}) {
  const [tableQuery, setTableQuery]       = useState(initial.tableLogicalName);
  const [tableSuggs, setTableSuggs]       = useState<TableMeta[]>([]);
  const [selectedTable, setSelectedTable] = useState<TableMeta | null>(null);
  const [tableLoading, setTableLoading]   = useState(false);

  const [recordQuery, setRecordQuery]       = useState("");
  const [recordSuggs, setRecordSuggs]       = useState<{ id: string; name: string; deleted?: boolean; deletedOn?: string }[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<{ id: string; name: string; deleted?: boolean } | null>(null);
  const [recordLoading, setRecordLoading]   = useState(false);
  const [guidFallback, setGuidFallback]     = useState("");

  const [searchErr, setSearchErr] = useState<string | null>(null);

  const tableRef  = useRef<HTMLDivElement>(null);
  const recordRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function close(e: MouseEvent) {
      if (tableRef.current  && !tableRef.current.contains(e.target as Node))  setTableSuggs([]);
      if (recordRef.current && !recordRef.current.contains(e.target as Node)) setRecordSuggs([]);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  async function doTableSearch() {
    if (!tableQuery.trim()) return;
    setTableLoading(true); setSearchErr(null); setTableSuggs([]);
    try {
      const res = await searchTables(tableQuery.trim());
      setTableSuggs(res);
      if (res.length === 0) setSearchErr(`No tables found matching "${tableQuery}". Try a different name.`);
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : String(e));
    } finally { setTableLoading(false); }
  }

  async function doRecordSearch() {
    if (!selectedTable || !recordQuery.trim()) return;
    setRecordLoading(true); setSearchErr(null); setRecordSuggs([]);
    try {
      const [active, deleted] = await Promise.all([
        searchRecordsByName(selectedTable, recordQuery.trim()),
        searchDeletedRecordsByName(selectedTable, recordQuery.trim())
      ]);
      const activeResults = active.map((r) => ({ ...r, deleted: false as const }));
      const deletedResults = deleted.map((r) => ({ id: r.id, name: r.name, deleted: true as const, deletedOn: r.deletedOn }));
      const combined = [...activeResults, ...deletedResults];
      setRecordSuggs(combined);
      if (combined.length === 0)
        setSearchErr(`No ${selectedTable.displayName} records found matching "${recordQuery}". Try the GUID field below.`);
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : String(e));
    } finally { setRecordLoading(false); }
  }

  function pickTable(meta: TableMeta) {
    setSelectedTable(meta);
    setTableQuery(`${meta.displayName} (${meta.logicalName})`);
    setTableSuggs([]);
    setSelectedRecord(null); setRecordQuery(""); setGuidFallback("");
    setSearchErr(null);
  }

  function pickRecord(rec: { id: string; name: string }) {
    setSelectedRecord(rec);
    setRecordQuery(rec.name);
    setRecordSuggs([]);
    setSearchErr(null);
  }

  function clearTable() {
    setSelectedTable(null); setTableQuery("");
    setTableSuggs([]); setSelectedRecord(null);
    setRecordQuery(""); setGuidFallback(""); setSearchErr(null);
  }

  const guidValid    = /^[0-9a-fA-F-]{36}$/.test(guidFallback.trim());
  const effectiveRec = selectedRecord ?? (guidValid ? { id: guidFallback.trim(), name: guidFallback.trim() } : null);
  const canLoad      = selectedTable !== null && effectiveRec !== null;

  const step = !selectedTable ? 1 : !effectiveRec ? 2 : 3;

  return (
    <div className="card">
      <div className="page-title">Find a record</div>
      <div className="page-subtitle">Search for a Dataverse table and record to view its complete change history.</div>

      {!selectedTable && (
        <div className="welcome-hero">
          <span className="welcome-hero__icon">📋</span>
          <div>
            <div className="welcome-hero__title">Record Audit Trail</div>
            <p className="welcome-hero__text">
              Search any Dataverse table and record to see a full timeline of who changed what and when.
              Restore previous field values or recreate a deleted record — all from one place.
            </p>
            <div className="welcome-hero__features">
              <span>Full audit timeline</span>
              <span>Field-level diff</span>
              <span>Restore previous values</span>
              <span>Recreate deleted records</span>
            </div>
          </div>
        </div>
      )}

      {searchErr && (
        <div className="banner banner--warn">
          <span className="banner__icon">⚠</span>
          <span>{searchErr}</span>
        </div>
      )}

      <div className="step-list">
        {/* ── Step 1: Table ── */}
        <div className={`step ${step === 1 ? "step--active" : "step--done"}`}>
          <div className="step__num">{step > 1 ? "✓" : "1"}</div>
          <div className="step__body">
            <div className="step__title">Choose a table</div>
            <div className="search-wrap" ref={tableRef}>
              <div className="search-input-row">
                <input
                  value={tableQuery}
                  onChange={(e) => { setTableQuery(e.target.value); if (selectedTable) clearTable(); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void doTableSearch(); }}
                  placeholder="e.g. Asset, Contact, Account — press Enter"
                />
                <button onClick={() => void doTableSearch()} disabled={tableLoading}>
                  {tableLoading ? "Searching…" : "Search"}
                </button>
                {selectedTable && (
                  <button className="search-clear" onClick={clearTable} title="Clear selection">✕</button>
                )}
              </div>
              {tableSuggs.length > 0 && (
                <ul className="suggestions">
                  {tableSuggs.map((t) => (
                    <li key={t.logicalName} onMouseDown={() => pickTable(t)}>
                      <span className="sugg-primary">{t.displayName}</span>
                      <span className="sugg-secondary">{t.logicalName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!selectedTable && (
              <div className="search-hint">Type a display name or logical name, then press Enter or Search.</div>
            )}
          </div>
        </div>

        {/* ── Step 2: Record ── */}
        <div className={`step ${step === 2 ? "step--active" : step > 2 ? "step--done" : ""}`}>
          <div className="step__num">{step > 2 ? "✓" : "2"}</div>
          <div className="step__body">
            <div className="step__title">Find a record</div>
            {selectedTable ? (
              <>
                <div className="search-wrap" ref={recordRef}>
                  <div className="search-input-row">
                    <input
                      value={recordQuery}
                      onChange={(e) => { setRecordQuery(e.target.value); setSelectedRecord(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") void doRecordSearch(); }}
                      placeholder={`Search ${selectedTable.displayName} by name — press Enter`}
                      autoFocus
                    />
                    <button onClick={() => void doRecordSearch()} disabled={recordLoading}>
                      {recordLoading ? "Searching…" : "Search"}
                    </button>
                    {selectedRecord && (
                      <button className="search-clear"
                        onClick={() => { setSelectedRecord(null); setRecordQuery(""); }} title="Clear">✕</button>
                    )}
                  </div>
                  {recordSuggs.length > 0 && (
                    <ul className="suggestions">
                      {recordSuggs.map((r) => (
                        <li key={r.id} onMouseDown={() => pickRecord(r)} className={r.deleted ? "sugg--deleted" : ""}>
                          <span className="sugg-primary">
                            {r.name}
                            {r.deleted && <span className="tag tag--deleted">Deleted</span>}
                          </span>
                          <span className="sugg-secondary mono">{r.id}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div style={{ margin: "12px 0 6px" }} className="muted">
                  Or paste a Record ID directly
                </div>
                <input
                  value={guidFallback}
                  onChange={(e) => { setGuidFallback(e.target.value); setSelectedRecord(null); setRecordQuery(""); }}
                  placeholder="00000000-0000-0000-0000-000000000000"
                />
              </>
            ) : (
              <div className="muted">Complete step 1 first.</div>
            )}
          </div>
        </div>

        {/* ── Step 3: Load ── */}
        <div className={`step ${step === 3 ? "step--active" : ""}`}>
          <div className="step__num">3</div>
          <div className="step__body">
            <div className="step__title">View change history</div>
            <button
              className="primary"
              disabled={!canLoad || busy}
              onClick={() => {
                if (selectedTable && effectiveRec)
                  onLoad({ tableLogicalName: selectedTable.logicalName, recordId: effectiveRec.id });
              }}
            >
              {busy ? "Loading…" : "Load history →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
