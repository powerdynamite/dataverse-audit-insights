# Audit Restore — Power Apps Code App (React + TypeScript)

Record-level audit history viewer and **field-level restore** for Dataverse, built
as a **Power Apps Code App** (React + Vite + the `@microsoft/power-apps` SDK).
Companion to the Power BI Audit Insights dashboard.

> **Licensing / preview note:** Power Apps Code Apps are in **preview** and generally
> require a **Power Apps Premium** license. This is the path you chose over the free
> canvas app (`../canvas-app/CANVAS_APP_BUILD.md`, kept as the no-cost alternative).

---

## What it does

1. Loads a record's change history via the Dataverse **`RetrieveRecordChangeHistory`**
   message.
2. Shows a timeline of create/update/delete events; pick one to see a field-by-field
   diff (old vs new, with friendly labels for choices).
3. Select fields → **Restore** writes the old values back via the Web API and logs an
   annotation (note) on the record for traceability.

Launches standalone (manual lookup) or from Power BI with `?table=<logical>&id=<guid>`.

---

## Project structure

```
code-app/
  package.json, vite.config.ts, tsconfig.json, index.html
  power.config.json            # pac code app metadata (appId filled by pac code init)
  .env.example                 # VITE_DATAVERSE_URL for local dev
  src/
    main.tsx                   # React entry, wraps app in PowerProvider
    PowerProvider.tsx          # initializes the Power Apps SDK (fallback for local dev)
    App.tsx                    # view state machine: lookup -> history -> diff
    types.ts                   # AuditEntry / AttributeChange / DiffRow
    services/auditService.ts   # RetrieveRecordChangeHistory + changedata parse + restore
    components/                # RecordLookup, ChangeHistory, FieldDiff
    styles.css
```

---

## Setup

### 1. Prerequisites
- Node 18+, `npm i`
- Power Platform CLI: `pac install latest` (or via VS Code Power Platform Tools)
- Power Apps Premium license; Code Apps enabled in the target environment.

### 2. Initialize the code app
```bash
cd code-app
npm install
pac auth create --environment https://org723efd4d.crm.dynamics.com
pac code init --displayName "Audit Restore"   # fills power.config.json appId
```

### 3. Add data sources (generates typed connector services)
```bash
# Dataverse connector — used for the restore (update) + EntityDefinitions
pac code add-data-source --apiId /providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps

# Custom connector for RetrieveRecordChangeHistory (see below), once created:
pac code add-data-source --apiId <your-custom-connector-id>
```
This generates `src/Models` + `src/Services`. In `auditService.ts`, swap the
`webApi(...)` calls for the generated service methods (the response shapes already
match the parsing). The direct Web API path remains as the local-dev fallback.

### 4. Custom connector for audit history
`RetrieveRecordChangeHistory` isn't a standard connector action, so create a custom
connector (same as the canvas guide, Part 1):
- Host `org723efd4d.crm.dynamics.com`, base `/api/data/v9.2`, OAuth2 (Entra,
  `Dynamics CRM / user_impersonation`).
- Action GET `/RetrieveRecordChangeHistory(Target=@p1)?@p1={target}`.

### 5. Run / push
```bash
npm run dev          # local dev (set sessionStorage 'dv_token' or wire MSAL)
pac code push        # publish to Power Platform
```

---

## Local dev auth

`auditService.getAccessToken()` reads a bearer token from
`sessionStorage["dv_token"]` for local testing. Get one quickly with:
```bash
pac org who                       # confirm env
# obtain a token (e.g. via az/MSAL) for resource https://org723efd4d.crm.dynamics.com
```
Then in the browser console: `sessionStorage.setItem("dv_token", "<token>")`.
In production the SDK/connector handles auth — no raw token.

---

## Portability

- Local/standalone: change `VITE_DATAVERSE_URL` in `.env`.
- Published: `pac code init`/`push` targets whatever environment `pac auth` points at;
  re-run against another environment to deploy there. Connections re-bind on import.

---

## Power BI launch wiring

On the Compliance page, build a URL column:
`<published app url>?table=[TableLogical]&id=[ObjectId]`
Set its data category to **Web URL** and surface as a button in the detail table
(`p4v08`). Clicking opens this app pre-loaded to that record's history (`App.tsx`
reads the `table` / `id` query params and auto-loads).

---

## Restore guardrails (implemented)

- **Deletes**: restore disabled — no live record to write into.
- **Lookups** (`"entity,guid"` values): flagged `lookup — manual`, checkbox disabled
  (needs `@odata.bind`; out of scope for one-click restore).
- **Failures are loud**: a failed write surfaces the Web API error; it never silently
  partially-succeeds. The annotation note is best-effort and logged if it fails.

---

## Verification

1. `npm run build` → type-checks and bundles.
2. With a token set, load `hl_asset` + a record id that has history → timeline renders.
3. Open an Update → diff shows old/new (choices show labels like `Laptop → Other`).
4. Select a text field → Restore → record reverts, success banner, note created.
5. From Power BI, click a record's app link → app auto-loads that record.
