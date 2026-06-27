import { type AuditEntry, type DiffRow } from "../types";
import { type SmartRestoreResult, isWithinRecycleBinWindow } from "../services/auditService";
import { formatFieldName, formatDate } from "../utils/format";

function isLookupRow(r: DiffRow): boolean {
  const check = (v: string | null) => {
    if (!v) return false;
    const parts = v.split(",");
    return parts.length === 2 && /^[0-9a-fA-F-]{36}$/.test(parts[1].trim());
  };
  return check(r.oldValue) || check(r.newValue);
}

function CellValue({ value, label, accent }: { value: string | null; label: string | null; accent?: "old" | "new" }) {
  const display = label ?? value;
  if (!display) return <em className="cell-empty">(empty)</em>;
  const cls = accent === "old" ? "cell-old" : accent === "new" ? "cell-new" : undefined;
  return <span className={cls}>{display}</span>;
}

export function FieldDiff({
  entry,
  rows,
  onToggle,
  onToggleAll,
  onRestore,
  onSmartRestore,
  onBack,
  busy,
  restoreResult,
  smartRestoreResult
}: {
  entry: AuditEntry;
  rows: DiffRow[];
  onToggle: (logicalName: string) => void;
  onToggleAll: (select: boolean) => void;
  onRestore: () => void;
  onSmartRestore: () => void;
  onBack: () => void;
  busy: boolean;
  restoreResult: string | null;
  smartRestoreResult: SmartRestoreResult | null;
}) {
  const isDelete = entry.operation === 3;
  const isCreate = entry.operation === 1;
  const isUpdate = entry.operation === 2;
  const inRecycleBin = isDelete && isWithinRecycleBinWindow(entry.createdOn);

  const selectableRows = rows.filter((r) => !isLookupRow(r));
  const selectedCount  = rows.filter((r) => r.selected).length;
  const allSelected    = selectableRows.length > 0 && selectableRows.every((r) => r.selected);

  const lookupCount = rows.filter(isLookupRow).length;
  const writableCount = rows.filter((r) => !isLookupRow(r) && r.oldValue).length;

  return (
    <div className="card">
      {/* ── Header ── */}
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div className="diff-header">
          <div className="row-gap" style={{ marginBottom: 6 }}>
            <span className={`pill op-${entry.operation}`}>{entry.operationName}</span>
            <span className="page-title" style={{ fontSize: 16 }}>Field changes</span>
          </div>
          <div className="diff-meta">
            {formatDate(entry.createdOn)} · {entry.userName ?? entry.userId ?? "Unknown user"}
          </div>
        </div>
        <button onClick={onBack}>← History</button>
      </div>

      {/* ── Event-type context banners ── */}
      {isDelete && !smartRestoreResult && inRecycleBin && (
        <div className="banner banner--ok">
          <span className="banner__icon">♻</span>
          <div>
            <strong>This record is in the Recycle Bin.</strong> Deleted {formatDate(entry.createdOn)} — within the 30-day window.
            Restoring will also recover related child records (tasks, notes, activities) automatically.
          </div>
        </div>
      )}
      {isDelete && !smartRestoreResult && !inRecycleBin && (
        <div className="banner banner--warn">
          <span className="banner__icon">🗑</span>
          <div>
            <strong>This record was deleted and is outside the 30-day Recycle Bin window.</strong>{" "}
            It will be recreated from the audit snapshot below with the same record ID.
            {lookupCount > 0 && <> Relationship fields ({lookupCount}) must be re-linked manually.</>}
          </div>
        </div>
      )}

      {isCreate && (
        <div className="banner banner--info">
          <span className="banner__icon">ℹ</span>
          <div>
            <strong>Create event.</strong> "Previous value" is empty — the record didn't exist before.
            Selecting fields and restoring will <em>clear those fields to empty</em> on the live record.
          </div>
        </div>
      )}

      {isUpdate && (
        <div className="banner banner--info">
          <span className="banner__icon">✏️</span>
          <div>
            <strong>Update event.</strong> Highlighted rows changed in this edit.
            Tick the fields you want to roll back, then click <strong>Restore</strong>.
          </div>
        </div>
      )}

      {/* ── Smart restore success ── */}
      {smartRestoreResult && (
        <div className="banner banner--ok">
          <span className="banner__icon">✅</span>
          <div>
            {smartRestoreResult.method === "recycle-bin" ? (
              <>
                <strong>Record restored from Recycle Bin.</strong>{" "}
                Child records (tasks, notes, activities) were also recovered automatically.
              </>
            ) : (
              <>
                <strong>Record recreated from audit snapshot.</strong>{" "}
                {smartRestoreResult.recreateDetail && (
                  <>
                    {smartRestoreResult.recreateDetail.restoredFields.length} field(s) written
                    {smartRestoreResult.recreateDetail.linkedLookups.length > 0 &&
                      `, ${smartRestoreResult.recreateDetail.linkedLookups.length} relationship(s) re-linked`}.
                    {smartRestoreResult.recreateDetail.skippedLookups.length > 0 && (
                      <details className="recreate-detail">
                        <summary style={{ color: "#d97706" }}>
                          ⚠ {smartRestoreResult.recreateDetail.skippedLookups.length} relationship(s) need manual re-linking
                        </summary>
                        <ul>
                          {smartRestoreResult.recreateDetail.skippedLookups.map((f) => (
                            <li key={f}>{formatFieldName(f)} <span className="mono">({f})</span></li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Restore success ── */}
      {restoreResult && (
        <div className="banner banner--ok">
          <span className="banner__icon">✅</span>
          <span>{restoreResult}</span>
        </div>
      )}

      {/* ── Bulk select controls ── */}
      {(isUpdate || isCreate) && !restoreResult && selectableRows.length > 0 && (
        <div className="bulk-controls">
          <button onClick={() => onToggleAll(!allSelected)}>
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          <span className="muted">{selectedCount} of {selectableRows.length} field{selectableRows.length === 1 ? "" : "s"} selected</span>
        </div>
      )}

      {/* ── Diff table ── */}
      <table className="diff">
        <thead>
          <tr>
            {!isDelete && <th style={{ width: 36 }}></th>}
            <th>Field</th>
            <th>Previous value</th>
            {!isDelete && <th>Current value</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const lookup  = isLookupRow(r);
            const changed = r.oldValue !== r.newValue;
            const disabled = isDelete || lookup;
            return (
              <tr key={r.logicalName} className={changed && isUpdate ? "diff-row--changed" : ""}>
                {!isDelete && (
                  <td>
                    <input
                      type="checkbox"
                      checked={r.selected}
                      disabled={disabled}
                      onChange={() => onToggle(r.logicalName)}
                    />
                  </td>
                )}
                <td>
                  <div className="field-name-primary">
                    {formatFieldName(r.logicalName)}
                    {lookup && (
                      <span className="tag tag--lookup">
                        {isDelete ? "Will re-link" : "Relationship"}
                      </span>
                    )}
                  </div>
                  <div className="field-name-logical">{r.logicalName}</div>
                </td>
                <td>
                  <CellValue
                    value={r.oldValue}
                    label={r.oldLabel}
                    accent={changed && isUpdate ? "old" : undefined}
                  />
                </td>
                {!isDelete && (
                  <td>
                    <CellValue
                      value={r.newValue}
                      label={r.newLabel}
                      accent={changed && isUpdate ? "new" : undefined}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* ── Action footer ── */}
      {!smartRestoreResult && !restoreResult && (
        <div className="diff-footer">
          {isDelete && (
            <>
              <span className="diff-footer__note">
                {inRecycleBin
                  ? "Child records will be recovered automatically"
                  : `${writableCount} field${writableCount === 1 ? "" : "s"} will be written${lookupCount > 0 ? ` · ${lookupCount} relationship field${lookupCount === 1 ? "" : "s"} skipped` : ""}`
                }
              </span>
              <button className="primary btn--green" disabled={busy} onClick={onSmartRestore}>
                {busy
                  ? (inRecycleBin ? "Restoring…" : "Recreating…")
                  : (inRecycleBin ? "Restore via Recycle Bin" : "Recreate from audit snapshot")
                }
              </button>
            </>
          )}

          {(isUpdate || isCreate) && (
            <>
              <span className="diff-footer__note">
                {selectedCount} field{selectedCount === 1 ? "" : "s"} selected to restore
              </span>
              <button
                className="primary"
                disabled={selectedCount === 0 || busy}
                onClick={onRestore}
              >
                {busy ? "Restoring…" : isCreate ? "Clear selected fields" : "Restore to previous values"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
