# Dataverse Audit Insights — Technical Implementation Plan

> Companion document for [Issue #1: Roadmap — Code App Commercialization Phase 1 & 2](https://github.com/powerdynamite/dataverse-audit-insights/issues/1)

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Phase 1 Implementation](#2-phase-1-implementation)
   - [1.1 Bulk Restore](#21-bulk-restore)
   - [1.2 Restore Approval Workflow](#22-restore-approval-workflow)
   - [1.3 Alert Flow Templates](#23-alert-flow-templates)
   - [1.4 Audit Export & Reporting](#24-audit-export--reporting)
3. [Phase 2 Implementation](#3-phase-2-implementation)
   - [2.1 Multi-Environment Consolidation](#31-multi-environment-consolidation)
   - [2.2 GDPR & Compliance Pack](#32-gdpr--compliance-pack)
   - [2.3 Anomaly Detection Rules Engine](#33-anomaly-detection-rules-engine)
   - [2.4 Copilot Studio Integration](#34-copilot-studio-integration)
4. [Dataverse Custom Tables Schema](#4-dataverse-custom-tables-schema)
5. [Solution Packaging & ALM](#5-solution-packaging--alm)
6. [Dependency & Risk Matrix](#6-dependency--risk-matrix)

---

## 1. Current Architecture Summary

### Tech Stack
- **Frontend:** React 18.3 + TypeScript 5.6 + Vite 5.4
- **SDK:** `@microsoft/power-apps ^0.3.1` (Power Apps Code App preview)
- **API:** Dataverse Web API (OData v9.2) via generated `MicrosoftDataverseService`
- **Analytics:** Power BI semantic model (star schema: `Fact_Audit`, `Fact_FieldChange`, dimensions)

### Component Architecture
```
App.tsx                    Three-view state machine: lookup → history → diff
├── RecordLookup.tsx       Table autocomplete + record GUID search
├── ChangeHistory.tsx      Timeline + analytics strip + filtering
└── FieldDiff.tsx          Before/after diff table + restore/recreate actions

services/
└── auditService.ts        Core service (413 lines):
                           - retrieveChangeHistory()   → OData audit query
                           - parseChangeData()          → JSON changedata parser
                           - restoreFields()            → PATCH old values back
                           - recreateRecord()           → POST + lookup PATCH
                           - getEntitySetName()         → metadata cache
                           - getNavigationPropertyName()→ relationship resolver

types.ts                   AttributeChange, AuditEntry, DiffRow, RecordContext
utils/format.ts            formatFieldName(), formatDate()
```

### Current Capabilities
- Single-record audit history lookup
- Field-level diff with before/after values
- Selective field restore (PATCH) for update/create events
- Deleted record recreation preserving original GUID
- Lookup field re-linking via navigation properties
- Annotation logging for traceability
- Power BI launch integration via URL params

### Key Constraints
- Code App runs inside Power Apps (preview) — all Dataverse calls go through `MicrosoftDataverseService` connector
- The connector does NOT support `@` characters in JSON keys natively — workarounds exist for `@odata.bind`
- `RetrieveRecordChangeHistory` function is not used directly; instead, raw `audits` entity is queried via OData
- Large column values in `AttributeAuditDetail` are capped at ~5KB (truncated with `…`)
- Web API batch requests (`$batch`) use `multipart/mixed` with CRLF line endings — max 1,000 operations per batch

---

## 2. Phase 1 Implementation

### 2.1 Bulk Restore

**Goal:** Select multiple records from audit history and batch-restore fields with a progress indicator.

#### 2.1.1 UI Changes

**New view: `BulkRestore.tsx`**

Add a fourth view to the `App.tsx` state machine: `"bulk"`. Accessible from the `ChangeHistory` component via a new "Bulk Restore" button that appears when multiple update events exist.

```
App.tsx views: lookup → history → diff (existing)
                                 → bulk (new)
```

**BulkRestore component design:**

| Section | Description |
|---------|-------------|
| Record selector | Multi-select list of audit entries (grouped by record if querying across records) |
| Preview panel | Summary: "Restoring 47 fields across 12 records" |
| Confirmation dialog | Shows exact fields per record before executing |
| Progress bar | Real-time progress: `3 of 12 records restored` with per-record status (success/fail/skipped) |
| Result summary | Final report with counts, failures, and annotation links |

**New types in `types.ts`:**

```typescript
export interface BulkRestoreItem {
  ctx: RecordContext;
  entry: AuditEntry;
  fields: DiffRow[];        // pre-selected fields to restore
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  error?: string;
}

export interface BulkRestoreJob {
  items: BulkRestoreItem[];
  progress: number;          // 0 to items.length
  startedAt: string;
  completedAt?: string;
}
```

#### 2.1.2 Service Layer Changes

**New function in `auditService.ts`: `bulkRestoreFields()`**

```typescript
export async function bulkRestoreFields(
  items: BulkRestoreItem[],
  onProgress: (index: number, status: BulkRestoreItem['status'], error?: string) => void
): Promise<BulkRestoreJob>
```

**Implementation approach — sequential with progress callbacks:**

The Dataverse Web API `$batch` endpoint supports up to 1,000 operations per request, with atomic change sets. However, the Power Apps connector (`MicrosoftDataverseService`) does not expose a raw `$batch` method. Two options:

| Approach | Pros | Cons |
|----------|------|------|
| **A. Sequential PATCH (recommended for v1)** | Works with existing connector; per-record progress/error reporting; no partial failures | Slower for large batches; one HTTP call per record |
| **B. Direct `$batch` via `fetch()`** | Faster; atomic change sets | Requires bypassing connector; CORS/auth complexity; harder error handling |

**Recommendation:** Start with **Approach A** (sequential PATCH). Each restore calls the existing `restoreFields()` function per record, reporting progress via callback. This is reliable, debuggable, and aligns with the existing connector pattern. Migrate to `$batch` in Phase 2 if performance becomes an issue.

**Concurrency control:** Process sequentially (not parallel) to avoid Dataverse throttling (429 responses). Add exponential backoff on 429 with max 3 retries.

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxRetries) throw e;
      const is429 = String(e).includes('429') || String(e).includes('Too Many');
      if (!is429) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error('unreachable');
}
```

#### 2.1.3 Multi-Record Audit Query

Currently `retrieveChangeHistory()` queries audits for a single `_objectid_value`. For bulk restore across records on the same table, add:

```typescript
export async function retrieveBulkChangeHistory(
  tableLogicalName: string,
  recordIds: string[]
): Promise<Map<string, AuditEntry[]>>
```

This uses an OData `$filter` with `_objectid_value eq ... or _objectid_value eq ...` (batched in groups of 15 to stay under URL length limits).

#### 2.1.4 Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `BulkRestoreItem`, `BulkRestoreJob` types |
| `src/services/auditService.ts` | Add `bulkRestoreFields()`, `retrieveBulkChangeHistory()`, `withRetry()` |
| `src/components/BulkRestore.tsx` | New component: multi-select, preview, progress, results |
| `src/components/ChangeHistory.tsx` | Add "Bulk Restore" button linking to bulk view |
| `src/App.tsx` | Add `"bulk"` view to state machine |
| `src/styles.css` | Progress bar, multi-select list, summary card styles |

---

### 2.2 Restore Approval Workflow

**Goal:** Restore requests go through a Power Automate approval flow before the PATCH executes.

#### 2.2.1 Architecture

This feature spans two systems: the Code App (request submission) and Power Automate (approval orchestration).

```
┌─────────────┐     POST      ┌──────────────────┐    Approval    ┌──────────────┐
│  Code App   │ ─────────────→│  Dataverse Table  │ ──────────────→│ Power Automate│
│  (React)    │               │  RestoreRequest   │               │  Approval     │
│             │  poll status  │                   │  approved →   │  Flow         │
│             │ ←─────────────│                   │ ←──────────── │               │
│             │               │                   │   execute     │               │
└─────────────┘               └──────────────────┘  PATCH restore └──────────────┘
                                                        │
                                                        ↓
                                                  ┌──────────────┐
                                                  │  Annotation   │
                                                  │  (audit note) │
                                                  └──────────────┘
```

#### 2.2.2 New Dataverse Table: `hl_restorerequest`

| Column | Type | Description |
|--------|------|-------------|
| `hl_restorerequestid` | Uniqueidentifier (PK) | Auto-generated |
| `hl_name` | Single Line (Text) | Auto-generated summary ("Restore 3 fields on account X") |
| `hl_targetentity` | Single Line | Target table logical name |
| `hl_targetrecordid` | Single Line | Target record GUID |
| `hl_fieldspayload` | Multiple Lines (Text) | JSON: `[{logicalName, oldValue, newValue}]` |
| `hl_requestedby` | Lookup (systemuser) | Requesting user |
| `hl_requestedon` | DateTime | Submission timestamp |
| `hl_status` | Choice | Pending (0), Approved (1), Rejected (2), Executed (3), Failed (4) |
| `hl_approvedby` | Lookup (systemuser) | Approving user |
| `hl_approvedon` | DateTime | Approval timestamp |
| `hl_executionresult` | Multiple Lines | JSON result or error message |
| `hl_isbukrestore` | Boolean | Whether this is part of a bulk operation |

#### 2.2.3 Code App Changes

Add an approval mode toggle to `FieldDiff.tsx`:

```typescript
// New state in App.tsx
const [approvalMode, setApprovalMode] = useState<boolean>(false);
```

When `approvalMode` is true, clicking "Restore" does NOT call `restoreFields()`. Instead it:

1. Serializes selected fields into JSON payload
2. Creates a new `hl_restorerequest` record via `MicrosoftDataverseService.CreateRecordWithOrganization()`
3. Shows a "Request submitted — pending approval" banner with the request ID
4. Optionally polls the request status every 10 seconds (or uses a manual "Check status" button)

**New service function:**

```typescript
export async function submitRestoreRequest(
  ctx: RecordContext,
  rows: DiffRow[],
  approvalRequired: boolean
): Promise<{ requestId: string; status: string }>

export async function checkRestoreRequestStatus(
  requestId: string
): Promise<{ status: string; executionResult?: string }>
```

#### 2.2.4 Power Automate Flow: `Audit Restore Approval`

**Trigger:** Dataverse → "When a row is added" → Table: `hl_restorerequest`, Filter: `hl_status eq 0`

**Steps:**

1. **Parse JSON** — Extract `hl_fieldspayload` into field array
2. **Get row** — Fetch requesting user details for the approval email
3. **Start and wait for an approval** — Type: "Approve/Reject – First to respond"
   - Title: `Audit Restore Request: {hl_name}`
   - Assigned to: configurable admin group (environment variable)
   - Details: formatted field change summary with before/after values
4. **Condition: Outcome = Approve**
   - **Yes branch:**
     - Update `hl_restorerequest` → status = Approved, approvedby, approvedon
     - For each field in payload → PATCH target record
     - Create annotation on target record
     - Update `hl_restorerequest` → status = Executed, executionresult = success JSON
   - **No branch:**
     - Update `hl_restorerequest` → status = Rejected
     - Send rejection notification email

**Delivery:** Exported as a managed solution component alongside the Code App.

#### 2.2.5 Files Changed

| File | Change |
|------|--------|
| `src/services/auditService.ts` | Add `submitRestoreRequest()`, `checkRestoreRequestStatus()` |
| `src/components/FieldDiff.tsx` | Add approval mode toggle + request submission UI |
| `src/App.tsx` | Add `approvalMode` state, pass to FieldDiff |
| `src/types.ts` | Add `RestoreRequest` type |
| Power Automate | New flow: `Audit Restore Approval` |
| Dataverse | New table: `hl_restorerequest` with columns above |

---

### 2.3 Alert Flow Templates

**Goal:** Pre-built Power Automate flows that detect audit anomalies and alert administrators.

#### 2.3.1 Configuration Table: `hl_auditalertconfig`

| Column | Type | Description |
|--------|------|-------------|
| `hl_auditalertconfigid` | PK | Auto-generated |
| `hl_name` | Text | Alert rule name |
| `hl_alerttype` | Choice | BulkDelete (0), AfterHours (1), HighRiskTable (2), Custom (3) |
| `hl_threshold` | Integer | e.g., 10 for "more than 10 deletes" |
| `hl_timewindowminutes` | Integer | Evaluation window (e.g., 60 = 1 hour) |
| `hl_targettables` | Text | Comma-separated logical names (or `*` for all) |
| `hl_businesshoursstart` | Text | "08:00" — for after-hours alerts |
| `hl_businesshoursend` | Text | "18:00" |
| `hl_notificationemails` | Text | Semicolon-separated email addresses |
| `hl_notificationteams` | Text | Teams channel webhook URL (optional) |
| `hl_isenabled` | Boolean | Active/inactive toggle |

#### 2.3.2 Flow Templates

**Flow 1: Bulk Delete Detection**

| Property | Value |
|----------|-------|
| Trigger | Recurrence (every 15 minutes) |
| Logic | Query `audits` where `operation eq 3` AND `createdon ge {now - timewindow}`, group by `_userid_value`, count. If any user exceeds threshold → alert |
| Alert | Adaptive Card to Teams channel + email with user, count, table names |

Implementation approach:
```
Recurrence (15 min)
  → List rows: hl_auditalertconfig (filter: hl_alerttype eq 0 AND hl_isenabled eq true)
  → For each config:
      → List rows: audits (filter: operation eq 3 AND createdon ge {utcNow - window})
      → Compose: group by userid, count
      → Condition: any count > threshold
        → Yes: Send email + Teams notification
```

**Flow 2: After-Hours Modification**

| Property | Value |
|----------|-------|
| Trigger | Recurrence (every 30 minutes) |
| Logic | Check current time against `hl_businesshoursstart`/`hl_businesshoursend`. If outside hours, query recent audits. If any found → alert |
| Alert | Email + Teams with record details, user, table |

**Flow 3: High-Risk Table Changes**

| Property | Value |
|----------|-------|
| Trigger | Dataverse → "When a row is added" → Table: `audit` |
| Logic | Check if `objecttypecode` is in the configured `hl_targettables` list. If yes → immediate alert |
| Alert | Real-time email + Teams notification |
| Target tables (default) | `systemuser`, `role`, `businessunit`, `team`, `fieldsecurityprofile` |

#### 2.3.3 Delivery

All three flows are packaged into the managed solution as solution-aware cloud flows. Environment variables control:
- Default notification recipients
- Teams webhook URL
- Business hours timezone

The `hl_auditalertconfig` table ships with seed data (3 default configurations) that the customer can customize.

#### 2.3.4 Files Changed

| Artifact | Change |
|----------|--------|
| Dataverse | New table: `hl_auditalertconfig` |
| Power Automate | 3 new flows (solution-aware) |
| Solution | Environment variables for recipients, webhook, timezone |
| `docs/` | Alert configuration guide |

---

### 2.4 Audit Export & Reporting

**Goal:** Export audit history as PDF or Excel with before/after diffs, timestamps, and user info.

#### 2.4.1 Implementation Approach

The Code App runs in the browser — PDF/Excel generation happens client-side. No server needed.

| Library | Purpose | Bundle Impact |
|---------|---------|---------------|
| **SheetJS (xlsx)** | Excel export — `.xlsx` file generation | ~200KB gzipped |
| **jsPDF + jspdf-autotable** | PDF export — tabular audit report | ~150KB gzipped |

Add as dependencies:
```json
{
  "xlsx": "^0.18.5",
  "jspdf": "^2.5.1",
  "jspdf-autotable": "^3.8.2"
}
```

#### 2.4.2 Export Service: `exportService.ts`

```typescript
export async function exportToExcel(
  ctx: RecordContext,
  entries: AuditEntry[],
  options?: { includeRawJson?: boolean }
): Promise<Blob>

export async function exportToPdf(
  ctx: RecordContext,
  entries: AuditEntry[],
  options?: { title?: string; includeHeader?: boolean }
): Promise<Blob>

export async function generateGovernanceReport(
  environmentUrl: string,
  dateRange: { from: string; to: string }
): Promise<Blob>
```

#### 2.4.3 Excel Format

| Sheet | Columns |
|-------|---------|
| **Audit Events** | Audit ID, Operation, Action, Changed Date, Changed By, Field Count |
| **Field Changes** | Audit ID, Field Name, Previous Value, New Value, Previous Label, New Label |
| **Summary** | Total events, creates, updates, deletes, unique users, date range, top changed fields |

#### 2.4.4 PDF Format

```
┌────────────────────────────────────────────────────────┐
│  AUDIT HISTORY REPORT                                  │
│  Table: account  ·  Record: 3fa85f64-...               │
│  Generated: Jun 25, 2026  ·  Events: 47                │
├────────────────────────────────────────────────────────┤
│  SUMMARY                                               │
│  Updates: 32  |  Creates: 1  |  Deletes: 0             │
│  Users: 3  |  Period: Jan 2026 – Jun 2026              │
├────────────────────────────────────────────────────────┤
│  EVENT LOG                                             │
│  ┌──────────┬───────────┬──────────┬─────────────────┐ │
│  │ Date     │ Operation │ User     │ Fields Changed  │ │
│  ├──────────┼───────────┼──────────┼─────────────────┤ │
│  │ Jun 25   │ Update    │ J. Smith │ name, email     │ │
│  │ ...      │ ...       │ ...      │ ...             │ │
│  └──────────┴───────────┴──────────┴─────────────────┘ │
│                                                        │
│  FIELD-LEVEL CHANGES (per event)                       │
│  ┌───────────┬───────────────┬───────────────────────┐ │
│  │ Field     │ Previous      │ New                   │ │
│  │ name      │ Contoso Ltd   │ Contoso Inc           │ │
│  └───────────┴───────────────┴───────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

#### 2.4.5 Governance Report (Monthly)

The "Governance Report" is a broader PDF summarizing an environment's audit posture. It queries:
- Total audit events per table (top 10)
- Most active users (top 10)
- Delete operations by table
- After-hours activity count
- High-risk table modifications

This reuses the existing `audits` OData query but with table-level aggregation. Add an environment-level query:

```typescript
export async function queryEnvironmentAuditSummary(
  dateRange: { from: string; to: string }
): Promise<EnvironmentAuditSummary>
```

#### 2.4.6 UI Integration

Add export buttons to `ChangeHistory.tsx`:

```
[↗ Power BI Report] [📥 Excel] [📄 PDF] [↻ Refresh] [← New lookup]
```

Download is triggered via `URL.createObjectURL(blob)` + a hidden `<a>` element click.

#### 2.4.7 Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `xlsx`, `jspdf`, `jspdf-autotable` dependencies |
| `src/services/exportService.ts` | New: Excel/PDF/governance report generation |
| `src/components/ChangeHistory.tsx` | Add export buttons to header row |
| `src/types.ts` | Add `EnvironmentAuditSummary` type |
| `src/styles.css` | Export button styles |

---

## 3. Phase 2 Implementation

### 3.1 Multi-Environment Consolidation

**Goal:** Single Code App instance that can query audit data across Dev/UAT/Prod Dataverse environments.

#### 3.1.1 Architecture

Currently `ORG_URL` is hardcoded from `VITE_DATAVERSE_URL` env var. Multi-environment requires:

1. **Environment registry table:** `hl_auditenvironment`
2. **Environment switcher UI:** Dropdown in the app header
3. **Cross-environment auth:** Each environment needs its own Dataverse connection reference in the solution

```
┌──────────────────────────────────────────────────────┐
│ App Header                                            │
│ ◈ Audit Restore  [▼ Production ▾]  account           │
│                   ├─ Production                       │
│                   ├─ UAT                              │
│                   └─ Development                      │
└──────────────────────────────────────────────────────┘
```

#### 3.1.2 New Table: `hl_auditenvironment`

| Column | Type | Description |
|--------|------|-------------|
| `hl_auditenvironmentid` | PK | |
| `hl_name` | Text | Display name ("Production", "UAT") |
| `hl_environmenturl` | Text | `https://org-prod.crm.dynamics.com` |
| `hl_connectionreference` | Text | Connection reference logical name |
| `hl_isdefault` | Boolean | Default environment on app load |
| `hl_order` | Integer | Display sort order |

#### 3.1.3 Service Layer Changes

Refactor `auditService.ts` to accept `orgUrl` as a parameter instead of reading from module-level constant:

```typescript
// Before (current):
const ORG_URL = import.meta.env.VITE_DATAVERSE_URL;

// After:
export function createAuditService(orgUrl: string) {
  return {
    retrieveChangeHistory: (ctx: RecordContext) => { /* uses orgUrl */ },
    restoreFields: (ctx: RecordContext, rows: DiffRow[]) => { /* uses orgUrl */ },
    // ... all functions scoped to orgUrl
  };
}
```

This is a significant refactor — every function that calls `MicrosoftDataverseService` needs to accept the org URL dynamically. Use a React context to provide the active environment's service instance.

#### 3.1.4 Cross-Environment Comparison

New component: `EnvironmentCompare.tsx`

- Side-by-side diff of a record's current state across two environments
- Queries the same record ID in both environments
- Highlights field-level differences
- Useful for debugging "UAT has the right data but Prod doesn't"

#### 3.1.5 Auth Considerations

Each Dataverse environment requires its own connection reference in the Power Apps solution. The Code App uses the `@microsoft/power-apps` SDK which authenticates via the hosting Power App's connection. Multi-environment requires:

- Multiple Dataverse connection references in the solution manifest
- The `power.config.json` needs to declare multiple `connectorInstances`
- At runtime, the app selects which connection to use based on the environment picker

**Risk:** The Power Apps Code App SDK (`@microsoft/power-apps ^0.3.1`) may not support switching connection references at runtime. If not, a workaround is to use separate `fetch()` calls with delegated auth tokens. This needs prototyping.

#### 3.1.6 Files Changed

| File | Change |
|------|--------|
| `src/services/auditService.ts` | Refactor to accept `orgUrl` parameter (factory pattern) |
| `src/contexts/EnvironmentContext.tsx` | New: React context for active environment |
| `src/components/EnvironmentSwitcher.tsx` | New: dropdown in header |
| `src/components/EnvironmentCompare.tsx` | New: side-by-side cross-env diff |
| `src/App.tsx` | Wrap in `EnvironmentProvider`, wire up switcher |
| `power.config.json` | Multiple connector instances |
| Dataverse | New table: `hl_auditenvironment` |

---

### 3.2 GDPR & Compliance Pack

**Goal:** Right-to-erasure tracking, data retention enforcement, personal data access logging.

#### 3.2.1 New Tables

**`hl_erasurerequest`** — tracks GDPR deletion requests

| Column | Type | Description |
|--------|------|-------------|
| `hl_erasurerequestid` | PK | |
| `hl_subjectidentifier` | Text | Data subject email/ID |
| `hl_requestedon` | DateTime | When the request was received |
| `hl_deadline` | DateTime | Compliance deadline (default: request + 30 days) |
| `hl_status` | Choice | Received (0), InProgress (1), Completed (2), Overdue (3) |
| `hl_tablesprocessed` | Text (Multi) | JSON: which tables were checked/cleared |
| `hl_completedby` | Lookup (systemuser) | |
| `hl_completedon` | DateTime | |
| `hl_notes` | Text (Multi) | Admin notes |

**`hl_retentionpolicy`** — data retention rules

| Column | Type | Description |
|--------|------|-------------|
| `hl_retentionpolicyid` | PK | |
| `hl_name` | Text | Policy name |
| `hl_targettable` | Text | Dataverse table logical name |
| `hl_retentiondays` | Integer | Max age in days |
| `hl_action` | Choice | Flag (0), Archive (1), Delete (2) |
| `hl_isenabled` | Boolean | |

#### 3.2.2 Code App: GDPR Dashboard Page

Add a new top-level view to `App.tsx`: `"gdpr"`. Accessible from a navigation tab in the header.

**GDPR Dashboard sections:**

1. **Erasure Requests** — Table showing all `hl_erasurerequest` records with status, deadline, traffic-light indicators
2. **Retention Violations** — Records in audited tables that exceed their `hl_retentionpolicy` retention window
3. **Personal Data Access Log** — Filtered audit view showing `operation eq 4` (Access) events on tables likely containing PII (configurable list)

#### 3.2.3 Power Automate Flows

**Flow: Erasure Deadline Monitor**
- Trigger: Recurrence (daily)
- Logic: Query `hl_erasurerequest` where `hl_deadline le utcNow()` AND `hl_status ne 2`
- Action: Update status to Overdue, send alert email

**Flow: Retention Policy Enforcer**
- Trigger: Recurrence (weekly)
- Logic: For each enabled `hl_retentionpolicy`, query target table for records older than `hl_retentiondays`
- Action: Flag records (add to a "retention flagged" view) or log for manual review

#### 3.2.4 Files Changed

| File | Change |
|------|--------|
| `src/components/GdprDashboard.tsx` | New: erasure requests, retention, access log |
| `src/services/gdprService.ts` | New: CRUD for erasure requests, retention policy queries |
| `src/App.tsx` | Add "gdpr" view + navigation |
| `src/types.ts` | Add `ErasureRequest`, `RetentionPolicy` types |
| Dataverse | New tables: `hl_erasurerequest`, `hl_retentionpolicy` |
| Power Automate | 2 new flows: deadline monitor, retention enforcer |

---

### 3.3 Anomaly Detection Rules Engine

**Goal:** Configurable governance rules evaluated on a schedule with automated responses.

#### 3.3.1 Rules Table: `hl_governancerule`

| Column | Type | Description |
|--------|------|-------------|
| `hl_governanceruleid` | PK | |
| `hl_name` | Text | Rule name |
| `hl_description` | Text (Multi) | What this rule detects |
| `hl_ruletype` | Choice | Threshold (0), Pattern (1), Comparison (2) |
| `hl_metric` | Choice | ModificationsPerHour (0), DeletesPerDay (1), UniqueUsersPerTable (2), FieldChangesPerRecord (3) |
| `hl_operator` | Choice | GreaterThan (0), LessThan (1), Equals (2) |
| `hl_thresholdvalue` | Decimal | Numeric threshold |
| `hl_evaluationwindow` | Integer | Minutes |
| `hl_targettables` | Text | Comma-separated or `*` |
| `hl_actiontype` | Choice | Email (0), Teams (1), Block (2), EmailAndTeams (3) |
| `hl_recipients` | Text | Email/webhook targets |
| `hl_isenabled` | Boolean | |
| `hl_lastrun` | DateTime | Last evaluation timestamp |
| `hl_lasttriggered` | DateTime | Last time rule fired |

**`hl_governancerulelog`** — execution history

| Column | Type | Description |
|--------|------|-------------|
| `hl_governancerulelogid` | PK | |
| `hl_ruleid` | Lookup (hl_governancerule) | Which rule |
| `hl_evaluatedon` | DateTime | When |
| `hl_triggered` | Boolean | Did it fire? |
| `hl_metricvalue` | Decimal | Actual measured value |
| `hl_details` | Text (Multi) | JSON: offending users/records |

#### 3.3.2 Evaluation Engine (Power Automate)

**Flow: Governance Rules Evaluator**

| Property | Value |
|----------|-------|
| Trigger | Recurrence (every 15 minutes) |
| Logic | List all enabled `hl_governancerule` records. For each: query `audits` with appropriate filter, compute metric, compare to threshold, log result, fire action if triggered |

The evaluation logic per metric:

```
ModificationsPerHour:
  → COUNT(audits WHERE createdon >= now-window AND operation IN (1,2,3))
  → If count > threshold → trigger

DeletesPerDay:
  → COUNT(audits WHERE createdon >= now-24h AND operation eq 3 AND objecttypecode IN targettables)

UniqueUsersPerTable:
  → COUNT(DISTINCT _userid_value FROM audits WHERE createdon >= now-window)

FieldChangesPerRecord:
  → MAX(changes.length) across audit entries in window
```

#### 3.3.3 Dashboard Widget

Add to `ChangeHistory.tsx` or a new `GovernanceDashboard.tsx`:

- **Active rules count** with enabled/disabled toggle
- **Recent triggers** — last 10 rule firings with details
- **Trend sparkline** — rule trigger frequency over last 30 days (rendered with CSS/SVG, no charting library)

#### 3.3.4 Files Changed

| Artifact | Change |
|----------|--------|
| Dataverse | New tables: `hl_governancerule`, `hl_governancerulelog` |
| Power Automate | New flow: `Governance Rules Evaluator` |
| `src/components/GovernanceDashboard.tsx` | New: rules list, trigger history, trend |
| `src/services/governanceService.ts` | New: CRUD for rules, query logs |
| `src/App.tsx` | Add governance view to navigation |

---

### 3.4 Copilot Studio Integration

**Goal:** Natural language audit queries and conversational restore via a Teams bot.

#### 3.4.1 Architecture

```
┌───────────┐    NL query    ┌────────────────┐   API call    ┌──────────────┐
│  Teams     │ ─────────────→│ Copilot Studio │ ────────────→ │ Dataverse    │
│  (User)    │               │  Agent         │               │ Web API      │
│            │  Adaptive     │                │  audit data   │              │
│            │ ←─────────────│  Topics +      │ ←──────────── │              │
│            │  Card reply   │  Actions       │               │              │
└───────────┘               └────────────────┘               └──────────────┘
```

#### 3.4.2 Copilot Studio Agent: "Audit Assistant"

**Topics:**

| Topic | Trigger Phrases | Action |
|-------|----------------|--------|
| Query audit history | "Show changes to [table] [record]", "What changed on [table] last week" | Query `audits` with parsed entity/date filters, return Adaptive Card |
| Restore field | "Restore [field] on [table] [record] to yesterday's value" | Find matching audit entry, submit `hl_restorerequest` (approval flow) |
| Environment status | "How many audit events today", "Who made the most changes" | Query aggregated audit summary, return formatted text |
| GDPR check | "Show erasure requests", "Any overdue deletion requests" | Query `hl_erasurerequest`, return status list |

#### 3.4.3 Custom Actions (Dataverse Plugins)

Copilot Studio connects to Dataverse via **Copilot plugins** (tools). Create low-code plugins:

**Plugin 1: `GetAuditHistory`**
- Input: `tableName` (string), `recordId` (string, optional), `days` (int, default 7)
- Output: JSON array of audit events
- Implementation: Dataverse Custom API that wraps the `audits` OData query

**Plugin 2: `SubmitRestoreRequest`**
- Input: `tableName`, `recordId`, `fieldName`, `targetDate`
- Output: `requestId`, `status`
- Implementation: Creates `hl_restorerequest` record, returns ID

**Plugin 3: `GetAuditSummary`**
- Input: `dateRange` (string: "today", "this week", "this month")
- Output: JSON summary (event counts, top users, top tables)
- Implementation: Aggregation query on `audits` table

#### 3.4.4 Adaptive Card Templates

Design Adaptive Cards for rich Teams responses:

```json
{
  "type": "AdaptiveCard",
  "body": [
    { "type": "TextBlock", "text": "Audit History: Account - Contoso", "weight": "Bolder" },
    { "type": "FactSet", "facts": [
      { "title": "Total Events", "value": "47" },
      { "title": "Last Change", "value": "Jun 25, 2026 2:30 PM" },
      { "title": "Changed By", "value": "John Smith" }
    ]},
    { "type": "ActionSet", "actions": [
      { "type": "Action.OpenUrl", "title": "Open in Audit App", "url": "..." },
      { "type": "Action.Submit", "title": "Restore Last Change", "data": { "action": "restore" } }
    ]}
  ]
}
```

#### 3.4.5 Delivery

- Copilot Studio agent exported as a solution component
- Requires Copilot Studio standalone license (not the Teams plan — Teams plan doesn't support Dataverse connectors)
- Agent published to Teams for admin users
- Custom APIs deployed as part of the managed solution

#### 3.4.6 Files Changed

| Artifact | Change |
|----------|--------|
| Copilot Studio | New agent: "Audit Assistant" with 4 topics |
| Dataverse | 3 Custom APIs (low-code plugins) |
| Solution | Adaptive Card templates as web resources |
| `docs/` | Copilot setup and licensing guide |

---

## 4. Dataverse Custom Tables Schema

Summary of all new Dataverse tables introduced across both phases:

| Table | Phase | Purpose |
|-------|-------|---------|
| `hl_restorerequest` | 1.2 | Restore approval workflow requests |
| `hl_auditalertconfig` | 1.3 | Alert rule configuration |
| `hl_auditenvironment` | 2.1 | Multi-environment registry |
| `hl_erasurerequest` | 2.2 | GDPR right-to-erasure tracking |
| `hl_retentionpolicy` | 2.2 | Data retention rules |
| `hl_governancerule` | 2.3 | Anomaly detection rules |
| `hl_governancerulelog` | 2.3 | Rule evaluation history |

**Naming convention:** All tables use the `hl_` publisher prefix (matching the solution publisher). All columns follow Dataverse naming standards: `hl_{tablename}id` for PK, `hl_{columnname}` for custom columns.

---

## 5. Solution Packaging & ALM

### 5.1 Managed Solution Structure

```
AuditInsights_managed.zip
├── Code App (PCF component)
├── Power BI report (embedded or linked)
├── Custom tables (7 tables)
├── Security roles
│   ├── Audit Insights Admin (full CRUD on all custom tables)
│   └── Audit Insights User (read audit, create restore requests)
├── Power Automate flows (6 flows)
│   ├── Audit Restore Approval
│   ├── Bulk Delete Alert
│   ├── After-Hours Alert
│   ├── High-Risk Table Alert
│   ├── Erasure Deadline Monitor
│   └── Governance Rules Evaluator
├── Copilot Studio agent
├── Custom APIs (3 plugins)
├── Environment variables
│   ├── NotificationRecipients
│   ├── TeamsWebhookUrl
│   ├── BusinessHoursTimezone
│   ├── DefaultApprovalGroup
│   └── DataverseEnvironmentUrl
└── Connection references
    └── Dataverse connection
```

### 5.2 Build & Deploy Pipeline

```
1. Developer builds locally
     pac pcf push (Code App)
     pac solution export --path ./solution --managed

2. CI/CD (GitHub Actions)
     npm run build (Code App)
     pac solution pack --type managed
     pac solution check (Solution Checker)
     Upload artifact

3. Deployment
     pac solution import --path AuditInsights_managed.zip
     Post-import: configure environment variables
```

### 5.3 Version Strategy

Use semantic versioning: `MAJOR.MINOR.PATCH`
- Phase 1 features ship as `1.x.0`
- Phase 2 features ship as `2.x.0`
- Bug fixes increment PATCH

---

## 6. Dependency & Risk Matrix

### Implementation Dependencies

```
Phase 1.1 (Bulk Restore) ←── no dependencies, start immediately
Phase 1.2 (Approval)     ←── depends on: hl_restorerequest table
Phase 1.3 (Alerts)       ←── depends on: hl_auditalertconfig table
Phase 1.4 (Export)        ←── no dependencies, can parallel with 1.1

Phase 2.1 (Multi-Env)    ←── depends on: auditService refactor (breaking)
Phase 2.2 (GDPR)         ←── depends on: hl_erasurerequest, hl_retentionpolicy tables
Phase 2.3 (Anomaly)      ←── depends on: hl_governancerule table
Phase 2.4 (Copilot)      ←── depends on: Custom APIs, hl_restorerequest from 1.2
```

### Recommended Build Order

```
Month 1: 1.1 (Bulk Restore) + 1.4 (Export) — in parallel
Month 2: 1.2 (Approval Workflow) + 1.3 (Alert Templates) — in parallel
Month 3: Testing, solution packaging, documentation
Month 4: 2.1 (Multi-Environment) — breaking refactor, do first
Month 5: 2.2 (GDPR) + 2.3 (Anomaly Detection) — in parallel
Month 6: 2.4 (Copilot Studio) — depends on custom APIs from 2.3
```

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Code Apps stays in preview | Medium | High | Maintain canvas app fallback; PCF component can be repackaged as standard control |
| Power Apps connector doesn't support `$batch` | High | Low | Use sequential PATCH (already planned for v1); direct `fetch()` as fallback |
| `@microsoft/power-apps` SDK limits multi-env auth | Medium | Medium | Prototype early in Month 4; fallback to separate app instances per env |
| Copilot Studio licensing costs deter customers | Medium | Medium | Make it an optional add-on; core features work without it |
| Dataverse API throttling on bulk operations | Medium | Medium | Sequential processing with retry/backoff (implemented in 1.1) |
| Large audit histories (>10K events) degrade PDF export | Low | Medium | Paginate OData queries; stream PDF generation; add date-range filter |
| Customer environments lack auditing enabled | High | Low | Pre-flight check on app load; clear error message with setup link |

---

## References

### Microsoft Documentation
- [Retrieve audit change history (Web API)](https://learn.microsoft.com/power-apps/developer/data-platform/auditing/retrieve-audit-data)
- [Execute batch operations (Web API)](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api)
- [Optimize bulk operations](https://learn.microsoft.com/power-apps/developer/data-platform/optimize-performance-create-update)
- [React controls & platform libraries (PCF)](https://learn.microsoft.com/power-apps/developer/component-framework/react-controls-platform-libraries)
- [Power Automate approvals](https://learn.microsoft.com/power-automate/get-started-approvals)
- [Dataverse GDPR DSR guide](https://learn.microsoft.com/power-platform/admin/dataverse-privacy-dsr-guide)
- [Solution packaging & ALM](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm)
- [Copilot Studio plugins architecture](https://learn.microsoft.com/microsoft-copilot-studio/copilot-plugins-architecture)
- [Low-code plugins for Copilot](https://learn.microsoft.com/power-apps/maker/data-platform/low-code-plugins-copilot-studio)
- [Managed vs unmanaged solutions](https://learn.microsoft.com/power-platform/alm/solution-packager-tool)

### Libraries
- [SheetJS (xlsx)](https://docs.sheetjs.com/) — Excel generation
- [jsPDF](https://github.com/parallax/jsPDF) — PDF generation
- [jspdf-autotable](https://github.com/simonbengtsson/jsPDF-AutoTable) — PDF table rendering
