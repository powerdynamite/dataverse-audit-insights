/** A single attribute change within one audit record. */
export interface AttributeChange {
  logicalName: string;
  oldValue: string | null;
  newValue: string | null;
  /** Friendly labels for choices/lookups, when present in changedata. */
  oldLabel?: string | null;
  newLabel?: string | null;
}

/** One audit event for a record (a create/update/delete with its field changes). */
export interface AuditEntry {
  auditId: string;
  operation: number; // 1 Create, 2 Update, 3 Delete, 4 Access
  operationName: string;
  action: number;
  createdOn: string; // ISO
  userId: string | null;
  userName: string | null;
  changes: AttributeChange[];
}

/** A field row in the diff screen, with restore selection state. */
export interface DiffRow {
  logicalName: string;
  oldValue: string | null;
  oldLabel: string | null;
  newValue: string | null;
  newLabel: string | null;
  selected: boolean;
}

export interface RecordContext {
  tableLogicalName: string;
  recordId: string;
}

export const OPERATION_NAMES: Record<number, string> = {
  1: "Create",
  2: "Update",
  3: "Delete",
  4: "Access",
  5: "Upsert"
};
