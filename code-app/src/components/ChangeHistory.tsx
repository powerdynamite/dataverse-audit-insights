import { useMemo, useState } from "react";
import { type AuditEntry, type RecordContext } from "../types";
import { formatFieldName, formatDate, exportToCsv } from "../utils/format";

const PBI_URL =
  "https://app.powerbi.com/groups/me/reports/d00711d6-7697-408a-9287-fb11005fd6b8/page001useractivity?experience=power-bi";

export function ChangeHistory({
  ctx,
  entries,
  recordIsDeleted,
  onSelect,
  onBack,
  onRefresh,
  refreshing
}: {
  ctx: RecordContext;
  entries: AuditEntry[];
  recordIsDeleted: boolean;
  onSelect: (entry: AuditEntry) => void;
  onBack: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [filterOps,    setFilterOps]    = useState<Set<number>>(new Set());
  const [filterFields, setFilterFields] = useState<Set<string>>(new Set());

  function toggleOp(op: number) {
    setFilterOps(prev => {
      const next = new Set(prev);
      next.has(op) ? next.delete(op) : next.add(op);
      return next;
    });
  }

  function toggleField(field: string) {
    setFilterFields(prev => {
      const next = new Set(prev);
      next.has(field) ? next.delete(field) : next.add(field);
      return next;
    });
  }

  function clearFilters() {
    setFilterOps(new Set());
    setFilterFields(new Set());
  }

  const stats = useMemo(() => {
    const creates = entries.filter((e) => e.operation === 1).length;
    const updates = entries.filter((e) => e.operation === 2).length;
    const deletes = entries.filter((e) => e.operation === 3).length;
    const users   = new Set(entries.map((e) => e.userName ?? e.userId ?? "unknown")).size;

    const sorted = [...entries].sort((a, b) => a.createdOn.localeCompare(b.createdOn));
    const since  = sorted[0]                 ? formatDate(sorted[0].createdOn)               : null;
    const latest = sorted[sorted.length - 1] ? formatDate(sorted[sorted.length - 1].createdOn) : null;

    const fieldCounts = new Map<string, number>();
    entries.forEach((e) =>
      e.changes.forEach((c) => fieldCounts.set(c.logicalName, (fieldCounts.get(c.logicalName) ?? 0) + 1))
    );
    const topFields = [...fieldCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return { creates, updates, deletes, users, since, latest, topFields };
  }, [entries]);

  const filtered = useMemo(() => entries.filter((e) => {
    if (filterOps.size > 0 && !filterOps.has(e.operation)) return false;
    if (filterFields.size > 0 && !e.changes.some((c) => filterFields.has(c.logicalName))) return false;
    return true;
  }), [entries, filterOps, filterFields]);

  const filtersActive = filterOps.size > 0 || filterFields.size > 0;

  return (
    <div className="card">
      {/* ── Header ── */}
      <div className="row-between" style={{ marginBottom: 4 }}>
        <div>
          <div className="page-title">Change history</div>
          <div className="page-subtitle mono" style={{ marginTop: 4 }}>
            {ctx.tableLogicalName} · {ctx.recordId}
          </div>
        </div>
        <div className="row-gap">
          <button
            className="btn--pbi"
            onClick={() => window.open(PBI_URL, "_blank")}
            title="Open full analytics in Power BI"
          >
            ↗ Power BI Report
          </button>
          {entries.length > 0 && (
            <button
              onClick={() => exportToCsv(entries, ctx)}
              title="Export full audit history as CSV"
            >
              ↓ Export CSV
            </button>
          )}
          <button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
          <button onClick={onBack}>← New lookup</button>
        </div>
      </div>

      {/* ── Deleted record banner ── */}
      {recordIsDeleted && (
        <div className="banner banner--warn">
          <span className="banner__icon">🗑</span>
          <span>
            <strong>This record has been deleted.</strong> Open the Delete entry below to recreate it
            from its last known field values.
          </span>
        </div>
      )}

      {/* ── Analytics strip (clickable filters) ── */}
      {entries.length > 0 && (
        <>
          <div className="analytics-strip" style={{ marginTop: 16 }}>
            {/* Total — clears all op filters */}
            <button
              className={`stat-card stat-card--btn${filterOps.size === 0 && filterFields.size === 0 ? " stat-card--active" : ""}`}
              onClick={clearFilters}
              title="Show all events"
            >
              <div className="stat-card__value">{entries.length}</div>
              <div className="stat-card__label">Total events</div>
            </button>

            <button
              className={`stat-card stat-card--btn stat-card--blue${filterOps.has(2) ? " stat-card--active" : ""}`}
              onClick={() => toggleOp(2)}
              title="Filter by Updates"
            >
              <div className="stat-card__value">{stats.updates}</div>
              <div className="stat-card__label">Updates</div>
            </button>

            <button
              className={`stat-card stat-card--btn stat-card--green${filterOps.has(1) ? " stat-card--active" : ""}`}
              onClick={() => toggleOp(1)}
              title="Filter by Creates"
            >
              <div className="stat-card__value">{stats.creates}</div>
              <div className="stat-card__label">Creates</div>
            </button>

            {stats.deletes > 0 && (
              <button
                className={`stat-card stat-card--btn stat-card--red${filterOps.has(3) ? " stat-card--active" : ""}`}
                onClick={() => toggleOp(3)}
                title="Filter by Deletes"
              >
                <div className="stat-card__value">{stats.deletes}</div>
                <div className="stat-card__label">Deletes</div>
              </button>
            )}

            <div className="stat-card">
              <div className="stat-card__value">{stats.users}</div>
              <div className="stat-card__label">User{stats.users === 1 ? "" : "s"}</div>
            </div>
          </div>

          {stats.since && stats.latest && stats.since !== stats.latest && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              History from <strong>{stats.since}</strong> to <strong>{stats.latest}</strong>
            </div>
          )}

          {stats.topFields.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="top-fields__label">Most changed fields — click to filter</div>
              <div className="top-fields">
                {stats.topFields.map(([field, count]) => (
                  <button
                    key={field}
                    className={`field-chip field-chip--btn${filterFields.has(field) ? " field-chip--active" : ""}`}
                    onClick={() => toggleField(field)}
                    title={`Filter by ${field}`}
                  >
                    {formatFieldName(field)}
                    <span className="field-chip__count">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Active filter bar ── */}
          {filtersActive && (
            <div className="filter-bar">
              <span className="filter-bar__label">
                Showing {filtered.length} of {entries.length} event{entries.length === 1 ? "" : "s"}
                {filterOps.size > 0 && (
                  <> · {[...filterOps].map(op => op === 1 ? "Creates" : op === 2 ? "Updates" : "Deletes").join(", ")}</>
                )}
                {filterFields.size > 0 && (
                  <> · {[...filterFields].map(formatFieldName).join(", ")}</>
                )}
              </span>
              <button className="ghost" style={{ padding: "2px 8px", fontSize: 12 }} onClick={clearFilters}>
                ✕ Clear
              </button>
            </div>
          )}

          <div className="divider" />
        </>
      )}

      {/* ── Empty state ── */}
      {entries.length === 0 && (
        <div style={{ padding: "32px 0", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div className="muted">No change history found for this record.</div>
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Make sure auditing is enabled for the <strong>{ctx.tableLogicalName}</strong> table in your Dataverse environment.
          </div>
        </div>
      )}

      {/* ── No results after filtering ── */}
      {entries.length > 0 && filtered.length === 0 && (
        <div style={{ padding: "24px 0", textAlign: "center" }}>
          <div className="muted">No events match the selected filters.</div>
          <button className="ghost" style={{ marginTop: 8 }} onClick={clearFilters}>Clear filters</button>
        </div>
      )}

      {/* ── Timeline ── */}
      {filtered.length > 0 && (
        <ul className="timeline">
          {filtered.map((e) => (
            <li key={e.auditId}>
              <button className="timeline-item" onClick={() => onSelect(e)}>
                <span className={`pill op-${e.operation}`}>{e.operationName}</span>
                <span className="timeline-when">{formatDate(e.createdOn)}</span>
                <span className="timeline-who">{e.userName ?? e.userId ?? "Unknown user"}</span>
                <span className="timeline-count">
                  {e.changes.length} field{e.changes.length === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
