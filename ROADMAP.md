# Dataverse Audit Insights — Product Roadmap

## What's Built Today

### Core Audit Engine
- **Record lookup** — search any audited table by display name, logical name, or GUID; resolves to a single record context
- **Full audit timeline** — retrieves complete event history via `RetrieveRecordChangeHistory` mapped to the `/audits` OData endpoint; surfaces Create, Update, Delete, and Access events with timestamps and user attribution
- **Interactive timeline filtering** — filter events by operation type (Create/Update/Delete/Access) and by specific field name; stat cards and field chips are clickable filters

### Field-Level Diff Viewer
- Before/after values shown side-by-side for every changed field in an Update event
- Friendly label resolution: choice fields show option labels, lookup fields show primary name instead of raw GUIDs
- Lookup detection: identifies navigational property fields and handles them separately at restore time

### Restore Capabilities
- **Selective field restore** — user picks individual fields from the diff; executes PATCH via scalar fields first, then lookup re-linking as a second PATCH using `@odata.bind` navigation property
- **Deleted record recreation** — recreates the record via POST preserving the original GUID; fields populated from the last audit snapshot
- **Audit annotation logging** — after any restore or recreate, writes a linked note on the target record documenting what was restored, by whom, and from which audit event

### Smart Guardrails
- System and internal fields excluded from restore (createdon, modifiedon, ownerid variants, etc.)
- Lookup fields flagged in the UI where automatic re-linking is ambiguous
- Failed write operations surface the full Dataverse API error message

### Power BI Dashboard (4 pages)
- **User Activity Overview** — who made changes, how many, across which tables; operation breakdown donut; activity-over-time line
- **Table & Entity Heatmap** — change frequency by table; field-churn matrix
- **Record Creation Trends** — creation volume over time; cumulative area chart
- **Compliance & Governance** — after-hours activity, bulk deletes, delete-by-user table

### Integration
- All API calls go through the `MicrosoftDataverseService` connector
- Power BI deep-link: launches the Code App pre-populated with `tableName` + `recordId` via query string

---

## Phase 1: Full Feature Set (Months 1–3)

### 1.1 Bulk Restore
- Select multiple records from a filtered timeline or search result
- Pre-execution summary: "Restoring N fields across M records" with per-record breakdown
- Batch executes field-level PATCHes in sequence; failures do not abort remaining records
- Progress indicator with per-record success/failure status
- Use case: a user bulk-edited 50 records with incorrect data and needs a full rollback

### 1.2 Restore Approval Workflow
- Restore requests are staged rather than immediately executed
- Admin selects fields → submits request → Power Automate triggers approval flow
- Approver receives Teams or email notification with full diff context (what will change, on which record)
- On approval, Code App executes the PATCH; on rejection, request is closed with reason logged
- Approval record linked to the restore annotation for complete traceability
- Required for regulated industries: banking, healthcare, government

### 1.3 Alert Flow Templates
- Importable Power Automate solution packages delivered alongside the managed solution
- Thresholds stored in a Dataverse settings table — configurable without code changes
- Included templates:
  - **Bulk delete alert** — triggers when a user deletes more than N records within a configurable window
  - **After-hours modification alert** — triggers on changes outside defined business hours
  - **High-risk table alert** — triggers on any write to a designated sensitive table (financial, HR, PII-tagged entities)
- Alerts post to Teams or send email; extensible to other connectors

### 1.4 Audit Export and Reporting
- Export full audit history for a record or table as Excel (structured) or PDF (formatted report)
- Export includes: timestamp, user, operation, field name, before value, after value
- Auto-generated monthly governance report: top changed tables, top users by volume, deletion counts
- Reports generated via scheduled Power Automate flow; stored to SharePoint or emailed to admins

### 1.5 Smart Restore Engine — Recycle Bin Integration
Unifies the Recycle Bin and audit-based restore into a single engine with automatic routing:

**Routing logic:**
- **Deletion within 30 days** → call `RestoreDeletedRecordsAsync` (`POST /api/data/v9.2/RestoreDeletedRecordsAsync`). Dataverse Recycle Bin API restores the record and all cascaded child records automatically — e.g. restoring a Project also restores its Tasks, Risks, and Resource Assignments. No manual child enumeration required.
- **Deletion older than 30 days** → fall back to recreate-from-audit: POST with original GUID, fields from last audit snapshot. Cascading child restore attempted via audit traversal (see below).
- **Field-level update** → always selective PATCH regardless of record age. Recycle Bin does not handle partial field rollbacks.

**Cascading restore beyond 30 days:**
- For hierarchical data (Project → Tasks → Resources) outside the Recycle Bin window, the engine queries the audit log for child record deletions in the same time window as the parent deletion
- Presents a dependency tree in the UI: user reviews and selects which child records to also recreate
- Executes parent POST first (preserving GUID), then child POSTs with re-linked parent lookup fields

**UX:**
- Single "Restore" button; engine determines the correct path transparently
- Recycle Bin path: "This record is in the Recycle Bin. Restoring will also recover N child records."
- Fallback path: "Record is outside the 30-day window. Restoring from audit snapshot — child records shown below."

---

## Phase 2: Expand and Harden (Months 4–6)

### 2.1 Multi-Environment Consolidation
- Environment switcher in the Code App UI
- Cross-environment comparison: view audit history from UAT and compare field values against Prod for the same GUID
- Restore across environments: copy record state from one environment to another using the same PATCH/POST engine

### 2.2 GDPR and Compliance Pack
- **Right-to-erasure tracking** — log deletion requests and verify personal data fields were actually cleared; generate a completion certificate
- **Data retention policy enforcement** — flag records past a configurable retention window without deletion
- **Personal data access log** — surface Access-type audit events on records tagged as containing personal data; exportable as evidence
- New Power BI page: "GDPR & Data Retention" — erasure completion rates, retention violations, access frequency by user

### 2.3 Anomaly Detection Rules Engine
- Configurable rules stored in a Dataverse table: table scope, operation type, threshold, time window, action
- Power Automate evaluates rules on schedule; triggered rules create alert records in Dataverse
- Rule types: volume thresholds, user behavior patterns, field-specific change detection (e.g. creditlimit changed by more than X%)
- Dashboard widget showing triggered rules and trends; manageable by admins without touching code

### 2.4 Copilot Studio Integration
- Natural language audit queries: "Show me all changes to Account records in the last 7 days"
- Conversational restore: "Restore the email field on contact [GUID] to the value it had on [date]"
- Deployed as a Teams bot for Power Platform admins; authentication via Azure AD SSO
- Restore actions through Copilot route through the Approval Workflow when enabled (Phase 1.2)

---

## Phase 3: Commercialization (TBD)

Scope and timing to be defined. Candidate items:
- Managed solution packaging with environment-variable-driven configuration
- Licensing model: per-environment or per-tenant
- Onboarding wizard: guided setup for new environments
- Documentation site and admin guide
- Support SLA tiers

---

## Competitive Positioning

| Competitor | Their Gap | Our Advantage |
|---|---|---|
| Native Dataverse audit viewer | Read-only log; no restore, no analytics, no alerts | Full restore engine, diff viewer, governance workflows |
| Microsoft Recycle Bin | Deletion-only, all-or-nothing, no field-level rollback, 30-day limit, no analytics | Smart Restore Engine integrates Recycle Bin for recent deletes + extends it with cascading restore beyond 30 days + handles field-level updates in same UX |
| Microsoft Purview | Tenant-wide, expensive, not Dataverse-specific | Deploys in under 1 hour; purpose-built for Dataverse audit and restore |
| CoE Starter Kit | Adoption analytics only; no audit restore | Audit-focused with actual data recovery, approval workflows, anomaly alerting |
| Custom-built solutions | 200+ hours per organisation | Pre-built, tested, maintained; restore logic and guardrails already solved |

---

## Key Risks

| Risk | Mitigation |
|---|---|
| Microsoft ships native field-level restore | Audit viewer has been read-only for years with no announced restore roadmap. Approval workflows, anomaly detection, and GDPR pack go well beyond what Microsoft is likely to productize. |
| Recycle Bin API behaviour changes | `RestoreDeletedRecordsAsync` is GA on Dataverse v9.2. Pin to versioned endpoint. Snapshot-recreate fallback means the tool works regardless of Recycle Bin availability or window changes. |
| Code Apps stays in preview or is deprecated | Core restore logic is connector-based and portable to canvas apps or a custom portal if needed. |
| Audit log gaps (auditing not enabled) | Surface clear warnings when a table or field has no audit history. Document pre-requisites: audit must be enabled at environment, table, and field level. |
| Solo founder delivery bottleneck | Managed solution packaging makes deployment repeatable without founder involvement per customer. Prioritize phases that deliver standalone value. |
