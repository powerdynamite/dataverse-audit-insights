import {
  type AttributeChange,
  type AuditEntry,
  type DiffRow,
  type RecordContext,
  OPERATION_NAMES
} from "../types";
import { MicrosoftDataverseService } from "../generated/services/MicrosoftDataverseService";

const ORG_URL: string =
  (import.meta.env.VITE_DATAVERSE_URL as string | undefined)?.replace(/\/$/, "") ??
  "https://org723efd4d.crm.dynamics.com";

// Optional boolean connector headers must be explicit false, not undefined.
// undefined → empty string → Boolean.Parse("") throws on connector backend.
const NO_META = false;
const NO_MIP  = false;

// System/calculated fields that cannot be set on create/update.
const SYSTEM_FIELDS = new Set([
  "statecode", "statuscode",
  "ownerid", "owningbusinessunit", "owningteam", "owninguser",
  "importsequencenumber", "overriddencreatedon",
  "createdon", "modifiedon", "createdonbehalfby", "modifiedonbehalfby",
  "timezoneruleversionnumber", "utcconversiontimezonecode",
  "versionnumber", "exchangerate"
]);

function listValue(data: Record<string, unknown>): Record<string, unknown>[] {
  const v = data["value"];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function isLookupValue(v: string | null): boolean {
  // Dataverse stores lookups in changedata as "entitytype,guid"
  if (!v) return false;
  const parts = v.split(",");
  return parts.length === 2 && /^[0-9a-fA-F-]{36}$/.test(parts[1].trim());
}

function coerceValue(v: string | null): unknown {
  if (v == null) return null;
  if (v === "True"  || v === "true")  return true;
  if (v === "False" || v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// ── EntitySet name ────────────────────────────────────────────────────────────

const entitySetCache = new Map<string, string>();

async function getEntitySetName(logicalName: string): Promise<string> {
  const cached = entitySetCache.get(logicalName);
  if (cached) return cached;

  // Note: EntityDefinitions does NOT support $top — removed.
  // $filter=LogicalName eq '...' returns exactly 1 row anyway.
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    "EntityDefinitions",
    undefined,
    "application/json",
    NO_META,
    NO_MIP,
    "EntitySetName",
    `LogicalName eq '${logicalName}'`
  );
  if (!result.success) throw new Error(`EntityDefinitions failed: ${JSON.stringify(result.error)}`);

  const rows = listValue(result.data);
  const setName = rows[0]?.EntitySetName as string | undefined;
  if (!setName) throw new Error(`EntitySetName not found for '${logicalName}'`);

  entitySetCache.set(logicalName, setName);
  return setName;
}

// ── Table search ─────────────────────────────────────────────────────────────

export interface TableMeta {
  logicalName: string;
  displayName: string;
  primaryNameAttr: string;
  entitySetName: string;
}

let tableCache: TableMeta[] | null = null;

export async function searchTables(query: string): Promise<TableMeta[]> {
  if (!tableCache) {
    const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
      ORG_URL,
      "EntityDefinitions",
      undefined,
      "application/json",
      NO_META,
      NO_MIP,
      "LogicalName,DisplayName,PrimaryNameAttribute,EntitySetName",
      "IsValidForAdvancedFind eq true and IsIntersect eq false"
    );
    if (!result.success) throw new Error(`Table search failed: ${JSON.stringify(result.error)}`);

    tableCache = listValue(result.data).map((row) => {
      const dn = row["DisplayName"] as { UserLocalizedLabel?: { Label?: string } } | null;
      return {
        logicalName:     String(row["LogicalName"] ?? ""),
        displayName:     dn?.UserLocalizedLabel?.Label ?? String(row["LogicalName"] ?? ""),
        primaryNameAttr: String(row["PrimaryNameAttribute"] ?? ""),
        entitySetName:   String(row["EntitySetName"] ?? "")
      };
    });
  }

  const q = query.toLowerCase();
  return tableCache
    .filter((t) => t.displayName.toLowerCase().includes(q) || t.logicalName.toLowerCase().includes(q))
    .slice(0, 15);
}

// ── Record search ─────────────────────────────────────────────────────────────

export async function searchRecordsByName(
  meta: TableMeta,
  query: string
): Promise<{ id: string; name: string }[]> {
  if (!meta.primaryNameAttr || !meta.entitySetName) return [];
  const safe = query.replace(/'/g, "''");
  const idField = `${meta.logicalName}id`;
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    meta.entitySetName,
    undefined,
    "application/json",
    NO_META,
    NO_MIP,
    `${idField},${meta.primaryNameAttr}`,
    `contains(${meta.primaryNameAttr},'${safe}')`,
    meta.primaryNameAttr,
    undefined,
    undefined,
    10
  );
  if (!result.success) throw new Error(`Record search failed: ${JSON.stringify(result.error)}`);
  return listValue(result.data).map((row) => ({
    id:   String(row[idField] ?? ""),
    name: String(row[meta.primaryNameAttr] ?? "(unnamed)")
  }));
}

export interface DeletedRecord {
  id: string;
  name: string;
  deletedOn: string;
}

export async function searchDeletedRecordsByName(
  meta: TableMeta,
  query: string
): Promise<DeletedRecord[]> {
  // Step 1: get distinct record IDs from Delete audit events for this table
  const nowIso = new Date().toISOString();
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    "audits",
    undefined,
    "application/json",
    NO_META,
    NO_MIP,
    "auditid,_objectid_value,createdon",
    `operation eq 3 and objecttypecode eq '${meta.logicalName}' and createdon le ${nowIso}`,
    "createdon desc",
    undefined,
    undefined,
    100
  );
  if (!result.success) return [];

  const rows = listValue(result.data);
  const deletedMap = new Map<string, string>(); // recordId → deletedOn
  for (const row of rows) {
    const id = String(row["_objectid_value"] ?? "");
    if (id && !deletedMap.has(id)) deletedMap.set(id, String(row["createdon"] ?? ""));
  }
  if (deletedMap.size === 0) return [];

  // Step 2: for each deleted record ID, find its name from the last Update/Create audit event
  // Query audit for non-Delete events on these records to extract the primary name from changedata
  const recordIds = [...deletedMap.keys()].slice(0, 20);
  const idFilter = recordIds.map((id) => `_objectid_value eq ${id}`).join(" or ");

  const nameResult = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    "audits",
    undefined,
    "application/json",
    NO_META,
    NO_MIP,
    "auditid,_objectid_value,changedata,operation",
    `(${idFilter}) and (operation eq 1 or operation eq 2) and createdon le ${nowIso}`,
    "createdon desc",
    undefined,
    undefined,
    200
  );

  const nameMap = new Map<string, string>(); // recordId → name
  if (nameResult.success) {
    for (const row of listValue(nameResult.data)) {
      const id = String(row["_objectid_value"] ?? "");
      if (!id || nameMap.has(id)) continue;
      try {
        const cd = row["changedata"] as string | null;
        if (cd) {
          const parsed = JSON.parse(cd) as { changedAttributes?: { logicalName: string; oldValue?: string | null; newValue?: string | null }[] };
          const hit = parsed.changedAttributes?.find((a) => a.logicalName === meta.primaryNameAttr);
          const name = String(hit?.newValue ?? hit?.oldValue ?? "");
          if (name) nameMap.set(id, name);
        }
      } catch { /* ignore */ }
    }
  }

  // Step 3: filter by query and build results
  const safe = query.toLowerCase();
  const out: DeletedRecord[] = [];
  for (const [id, deletedOn] of deletedMap) {
    const name = nameMap.get(id) ?? "";
    if (safe && !name.toLowerCase().includes(safe)) continue;
    out.push({ id, name: name || "(unnamed)", deletedOn });
    if (out.length >= 10) break;
  }
  return out;
}

// ── changedata parsing ────────────────────────────────────────────────────────

export function parseChangeData(raw: string | null | undefined): AttributeChange[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { changedAttributes?: unknown }).changedAttributes)
  ) return [];
  const attrs = (parsed as { changedAttributes: Array<Record<string, unknown>> }).changedAttributes;
  return attrs.map((a) => ({
    logicalName: String(a.logicalName ?? ""),
    oldValue:  a.oldValue  == null ? null : String(a.oldValue),
    newValue:  a.newValue  == null ? null : String(a.newValue),
    oldLabel:  a.oldName   == null ? null : String(a.oldName),
    newLabel:  a.newName   == null ? null : String(a.newName)
  }));
}

// ── Audit history ─────────────────────────────────────────────────────────────

export async function retrieveChangeHistory(ctx: RecordContext): Promise<AuditEntry[]> {
  // Include current timestamp in filter so the connector never serves a cached response.
  const nowIso = new Date().toISOString();
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    "audits",
    undefined,
    "application/json",
    NO_META,
    NO_MIP,
    "auditid,operation,action,createdon,_userid_value,changedata",
    `_objectid_value eq ${ctx.recordId} and createdon le ${nowIso}`,
    "createdon desc",
    "userid($select=fullname)"
  );
  if (!result.success) throw new Error(`Audit query failed: ${JSON.stringify(result.error)}`);
  return listValue(result.data).map(mapAuditRow);
}

function mapAuditRow(row: Record<string, unknown>): AuditEntry {
  const userObj = row["userid"] as Record<string, unknown> | undefined;
  return {
    auditId:       String(row["auditid"] ?? ""),
    operation:     Number(row["operation"] ?? 0),
    operationName: OPERATION_NAMES[Number(row["operation"] ?? 0)] ?? `Op ${row["operation"]}`,
    action:        Number(row["action"] ?? 0),
    createdOn:     String(row["createdon"] ?? ""),
    userId:        row["_userid_value"] != null ? String(row["_userid_value"]) : null,
    userName:      userObj?.fullname != null ? String(userObj.fullname) : null,
    changes:       parseChangeData(row["changedata"] as string | null | undefined)
  };
}

// ── Diff rows ─────────────────────────────────────────────────────────────────

export function buildDiffRows(entry: AuditEntry): DiffRow[] {
  return entry.changes.map((c) => ({
    logicalName: c.logicalName,
    oldValue:    c.oldValue,
    oldLabel:    c.oldLabel ?? null,
    newValue:    c.newValue,
    newLabel:    c.newLabel ?? null,
    selected:    false
  }));
}

// ── Restore (Update events) ───────────────────────────────────────────────────

export async function restoreFields(ctx: RecordContext, rows: DiffRow[]): Promise<string[]> {
  const selected = rows.filter((r) => r.selected);
  if (selected.length === 0) return [];

  const body: Record<string, unknown> = {};
  for (const r of selected) {
    if (isLookupValue(r.oldValue)) continue;
    body[r.logicalName] = coerceValue(r.oldValue);
  }
  if (Object.keys(body).length === 0) return [];

  const entitySet = await getEntitySetName(ctx.tableLogicalName);
  const result = await MicrosoftDataverseService.UpdateOnlyRecordWithOrganization(
    "return=representation",
    "application/json",
    "*",
    ORG_URL,
    entitySet,
    ctx.recordId,
    body,
    NO_META
  );
  if (!result.success) throw new Error(`Restore PATCH failed: ${JSON.stringify(result.error)}`);

  await writeRestoreNote(ctx, Object.keys(body));
  return Object.keys(body);
}

async function writeRestoreNote(ctx: RecordContext, fields: string[]): Promise<void> {
  const entitySet = await getEntitySetName(ctx.tableLogicalName);
  const note: Record<string, unknown> = {
    subject:  "Audit restore",
    notetext: `Restored fields [${fields.join(", ")}] on ${ctx.tableLogicalName} ${ctx.recordId} via Audit Restore app.`,
    [`objectid_${ctx.tableLogicalName}@odata.bind`]: `/${entitySet}(${ctx.recordId})`
  };
  try {
    const r = await MicrosoftDataverseService.CreateRecordWithOrganization(
      "return=representation", "application/json", ORG_URL, "annotations", note, NO_META
    );
    if (!r.success) throw new Error(r.error?.message);
  } catch (e) {
    console.warn("Restore note failed (non-fatal):", e);
  }
}

// ── Navigation property resolver ─────────────────────────────────────────────
// The OData navigation property name for a lookup is NOT always the same as the
// field's logical name. Query RelationshipDefinitions to get the exact name.

const navPropCache = new Map<string, string>();

async function getNavigationPropertyName(
  referencingEntity: string,
  referencingAttribute: string
): Promise<string> {
  const key = `${referencingEntity}:${referencingAttribute}`;
  const cached = navPropCache.get(key);
  if (cached) return cached;

  // Correct endpoint: entity-scoped ManyToOneRelationships, NOT global RelationshipDefinitions.
  // Global RelationshipDefinitions does not expose ReferencingEntity as a filterable property.
  const entityPath = `EntityDefinitions(LogicalName='${referencingEntity}')/ManyToOneRelationships`;
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    entityPath,
    undefined,
    "application/json",
    NO_META,
    NO_MIP,
    "ReferencingEntityNavigationPropertyName,ReferencingAttribute",
    `ReferencingAttribute eq '${referencingAttribute}'`
  );
  if (!result.success) throw new Error(`ManyToOneRelationships failed: ${JSON.stringify(result.error)}`);

  const rows = listValue(result.data);
  const navProp = rows[0]?.ReferencingEntityNavigationPropertyName as string | undefined;
  if (!navProp) throw new Error(`No nav property found for ${referencingEntity}.${referencingAttribute}. Rows: ${JSON.stringify(rows)}`);

  navPropCache.set(key, navProp);
  return navProp;
}

// ── Lookup entity-set resolver ────────────────────────────────────────────────

async function resolveLookupEntitySet(entityType: string): Promise<string> {
  // 1. Try treating entityType as a logical name → get its entity set name
  try {
    return await getEntitySetName(entityType);
  } catch { /* fall through */ }

  // 2. entityType might already be the entity set name (changedata is inconsistent).
  //    Check the table cache populated by searchTables.
  if (tableCache) {
    const hit = tableCache.find(
      (t) => t.entitySetName.toLowerCase() === entityType.toLowerCase()
    );
    if (hit) return hit.entitySetName;
  }

  // 3. Fetch once if cache is empty, then retry
  if (!tableCache) {
    await searchTables(""); // populates tableCache as a side-effect
    const loaded = tableCache as TableMeta[] | null;
    const hit = (loaded ?? []).find(
      (t) => t.entitySetName.toLowerCase() === entityType.toLowerCase()
    );
    if (hit) return hit.entitySetName;
  }

  // 4. Last resort: use as-is and let Dataverse reject if wrong
  return entityType;
}

// ── Smart Restore Engine ──────────────────────────────────────────────────────

export interface RecreateResult {
  linkedLookups:  string[];
  skippedLookups: string[];
  skippedSystem:  string[];
  restoredFields: string[];
}

export interface SmartRestoreResult {
  method: "recycle-bin" | "audit-snapshot";
  childRecordsRestored: boolean;
  orphanedChildrenRelinked: number;
  recreateDetail?: RecreateResult;
}

/** True if the deletion happened within the Dataverse 30-day Recycle Bin window. */
export function isWithinRecycleBinWindow(deletedOnIso: string): boolean {
  const deletedMs    = new Date(deletedOnIso).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - deletedMs < thirtyDaysMs;
}

/**
 * Call the Dataverse Recycle Bin API to restore a deleted record.
 * Also restores cascaded child records automatically.
 * POST /api/data/v9.2/RestoreDeletedRecordsAsync
 */
async function restoreViaRecycleBin(ctx: RecordContext): Promise<void> {
  const body = {
    Target: {
      "@odata.type": `Microsoft.Dynamics.CRM.${ctx.tableLogicalName}`,
      [`${ctx.tableLogicalName}id`]: ctx.recordId
    }
  };
  const result = await MicrosoftDataverseService.CreateRecordWithOrganization(
    "return=representation",
    "application/json",
    ORG_URL,
    "RestoreDeletedRecordsAsync",
    body,
    NO_META
  );
  if (!result.success) {
    throw new Error(`Recycle Bin API failed: ${JSON.stringify(result.error)}`);
  }
}

interface ChildRelationship { childTable: string; lookupField: string; }

// Cache so we only fetch relationships once per parent entity type
const relationshipCache = new Map<string, ChildRelationship[]>();

async function getRemoveLinkChildren(parentTable: string): Promise<ChildRelationship[]> {
  const cached = relationshipCache.get(parentTable);
  if (cached) return cached;

  // Use the RelationshipDefinitions flat collection — supports standard OData filtering
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    ORG_URL,
    "RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    undefined, "application/json", NO_META, NO_MIP,
    "ReferencingEntity,ReferencingAttribute,CascadeConfiguration",
    `ReferencedEntity eq '${parentTable}'`,
    undefined, undefined, undefined, 100
  );

  const rels: ChildRelationship[] = [];
  if (result.success) {
    for (const r of listValue(result.data)) {
      const cascadeDelete = (r["CascadeConfiguration"] as Record<string, unknown>)?.["Delete"] as string | undefined;
      if (cascadeDelete === "RemoveLink" || cascadeDelete === "NoCascade") {
        rels.push({
          childTable:  String(r["ReferencingEntity"] ?? ""),
          lookupField: String(r["ReferencingAttribute"] ?? "")
        });
      }
    }
  }
  relationshipCache.set(parentTable, rels);
  return rels;
}

/**
 * After the parent is restored, find children orphaned via RemoveLink and re-link them.
 *
 * Strategy (changedata-free):
 * RemoveLink system updates generate audit rows (op=2) with changedata=false.
 * We detect them by: (1) getting the child relationship map from RelationshipDefinitions,
 * (2) querying audit for op=2 events on each child entity type in a ±120s window,
 * (3) PATCHing the lookup field back — but ONLY if the field is currently null
 *     (prevents overwriting legitimate re-assignments made since the delete).
 */
async function relinkOrphanedChildren(
  ctx: RecordContext,
  deletedOnIso: string
): Promise<number> {
  const nowIso     = new Date().toISOString();
  const deleteMs   = new Date(deletedOnIso).getTime();
  const winStart   = new Date(deleteMs - 30_000).toISOString();
  const winEnd     = new Date(deleteMs + 120_000).toISOString(); // async ops can lag

  // Get all RemoveLink child relationships for this entity
  const relationships = await getRemoveLinkChildren(ctx.tableLogicalName);
  if (relationships.length === 0) return 0;

  const parentEntitySet = await getEntitySetName(ctx.tableLogicalName);
  let relinked = 0;

  for (const { childTable, lookupField } of relationships) {
    if (!childTable || !lookupField) continue;

    // Find child record IDs from audit Update events in the time window
    const auditResult = await MicrosoftDataverseService.ListRecordsWithOrganization(
      ORG_URL, "audits", undefined, "application/json", NO_META, NO_MIP,
      "auditid,_objectid_value",
      `operation eq 2 and objecttypecode eq '${childTable}' and createdon ge ${winStart} and createdon le ${winEnd} and createdon le ${nowIso}`,
      undefined, undefined, undefined, 100
    );
    if (!auditResult.success) continue;

    const seen = new Set<string>();
    for (const auditRow of listValue(auditResult.data)) {
      const childRecordId = String(auditRow["_objectid_value"] ?? "");
      if (!childRecordId || seen.has(childRecordId)) continue;
      seen.add(childRecordId);

      try {
        const childEntitySet = await getEntitySetName(childTable);

        // Verify the lookup is currently null before re-linking
        // (avoids overwriting a legitimate re-assignment)
        const current = await MicrosoftDataverseService.ListRecordsWithOrganization(
          ORG_URL, childEntitySet, childRecordId,
          "application/json", NO_META, NO_MIP,
          `_${lookupField}_value`
        );
        if (!current.success) continue;
        const currentLookup = current.data[`_${lookupField}_value`];
        // Only re-link if the lookup is currently empty
        if (currentLookup !== null && currentLookup !== undefined && currentLookup !== "") continue;

        const patchBody: Record<string, unknown> = {
          [`${lookupField}@odata.bind`]: `/${parentEntitySet}(${ctx.recordId})`
        };
        const patchResult = await MicrosoftDataverseService.UpdateOnlyRecordWithOrganization(
          "return=representation", "application/json", "*",
          ORG_URL, childEntitySet, childRecordId, patchBody, NO_META
        );
        if (patchResult.success) relinked++;
      } catch { /* non-fatal */ }
    }
  }

  return relinked;
}

/**
 * Smart restore for Delete events.
 * Phase 1: Restore the parent (Recycle Bin ≤30 days, else audit snapshot).
 * Phase 2: Re-link any children orphaned via RemoveLink relationships.
 *
 * Handles both relationship types:
 * - Parental/Cascade → children deleted + auto-restored by Recycle Bin
 * - RemoveLink       → children orphaned (lookup cleared) → re-linked by phase 2
 */
export async function smartDeleteRestore(
  ctx: RecordContext,
  deletedOnIso: string,
  rows: DiffRow[]
): Promise<SmartRestoreResult> {
  let method: SmartRestoreResult["method"];
  let childRecordsRestored = false;
  let recreateDetail: RecreateResult | undefined;

  if (isWithinRecycleBinWindow(deletedOnIso)) {
    try {
      await restoreViaRecycleBin(ctx);
      method = "recycle-bin";
      childRecordsRestored = true;
    } catch {
      // Recycle Bin unavailable — fall through to snapshot
      const detail = await recreateRecord(ctx, rows);
      method = "audit-snapshot";
      recreateDetail = detail;
    }
  } else {
    const detail = await recreateRecord(ctx, rows);
    method = "audit-snapshot";
    recreateDetail = detail;
  }

  // Phase 2: re-link orphaned children regardless of restore method
  const orphanedChildrenRelinked = await relinkOrphanedChildren(ctx, deletedOnIso);

  return { method, childRecordsRestored, orphanedChildrenRelinked, recreateDetail };
}

export async function recreateRecord(
  ctx: RecordContext,
  rows: DiffRow[]
): Promise<RecreateResult> {
  const scalarBody: Record<string, unknown> = {};
  const pendingLookups: Array<{ logicalName: string; entitySet: string; guid: string }> = [];
  const linkedLookups:  string[] = [];
  const skippedLookups: string[] = [];
  const skippedSystem:  string[] = [];
  const restoredFields: string[] = [];

  for (const r of rows) {
    const val = r.oldValue;
    if (!val) continue;
    if (r.logicalName.endsWith("_base")) continue;
    if (SYSTEM_FIELDS.has(r.logicalName)) { skippedSystem.push(r.logicalName); continue; }
    if (isLookupValue(val)) {
      const parts      = val.split(",");
      const entityType = parts[0].trim();
      const lookupGuid = parts[1].trim();
      try {
        const resolvedSet = await resolveLookupEntitySet(entityType);
        pendingLookups.push({ logicalName: r.logicalName, entitySet: resolvedSet, guid: lookupGuid });
      } catch {
        skippedLookups.push(r.logicalName);
      }
      continue;
    }
    scalarBody[r.logicalName] = coerceValue(val);
    restoredFields.push(r.logicalName);
  }

  // Preserve original GUID — Dataverse honours the PK field on POST.
  scalarBody[`${ctx.tableLogicalName}id`] = ctx.recordId;

  // Step 1: Create the record with scalar (non-lookup) fields.
  const entitySet = await getEntitySetName(ctx.tableLogicalName);
  const createResult = await MicrosoftDataverseService.CreateRecordWithOrganization(
    "return=representation", "application/json", ORG_URL, entitySet, scalarBody, NO_META
  );
  if (!createResult.success) throw new Error(`Recreate failed: ${JSON.stringify(createResult.error)}`);

  // Step 2: PATCH each lookup separately.
  // The Power Apps connector cannot forward `@` characters in JSON keys, so
  // `field@odata.bind` fails. Instead we pass the raw GUID as the field value —
  // the connector recognises lookup fields and routes the GUID correctly.
  for (const lk of pendingLookups) {
    let linked = false;

    try {
      const navProp = await getNavigationPropertyName(ctx.tableLogicalName, lk.logicalName);
      const r = await MicrosoftDataverseService.UpdateOnlyRecordWithOrganization(
        "return=representation", "application/json", "*",
        ORG_URL, entitySet, ctx.recordId,
        { [`${navProp}@odata.bind`]: `/${lk.entitySet}(${lk.guid})` },
        NO_META
      );
      if (r.success) linked = true;
    } catch { /* skipped */ }

    if (linked) {
      linkedLookups.push(lk.logicalName);
    } else {
      skippedLookups.push(lk.logicalName);
    }
  }

  return { linkedLookups, skippedLookups, skippedSystem, restoredFields };
}
