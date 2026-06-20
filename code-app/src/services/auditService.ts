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

// ── Recreate (Delete events) ──────────────────────────────────────────────────

export interface RecreateResult {
  linkedLookups:  string[];
  skippedLookups: string[];
  skippedSystem:  string[];
  restoredFields: string[];
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
