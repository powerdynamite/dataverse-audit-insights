# Audit Insights — Setup & Per-Environment Configuration

This solution is environment-agnostic. To run it against any Dataverse environment
you change **one parameter** (the environment URL). Below: first-time setup, pointing
at a new environment, and exporting the distributable template.

---

## Prerequisites (per environment)

1. **Auditing must be enabled**, or the dashboard will be empty.
   - Power Platform Admin Center → Environment → Settings → Audit and logs →
     **Audit settings** → Start auditing = On.
   - Enable auditing on the tables you care about (table settings → Auditing).
   - Without this, the `audit` table has no rows.
2. **Power BI Desktop** (free) to open the `.pbip`.
3. An account with **read access to the Web API** for the target environment
   (System Administrator or a role with audit read privilege).

> Note: the `audit` table is **not** available through the standard Dataverse
> connector (TDS endpoint). This report deliberately uses the **Web API OData**
> endpoint (`/api/data/v9.2/audits`). This is expected — do not switch it to the
> Dataverse connector.

---

## First-time open

1. Open `AuditInsights.pbip` in Power BI Desktop.
2. **Transform data → Edit parameters** (or Home → Manage parameters):
   - `DataverseEnvironmentUrl` → your org URL, e.g. `https://org723efd4d.crm.dynamics.com`
     (no trailing slash, no `/api/...`).
   - `AuditHistoryDays` → how many days of history to load (default 365).
3. **Close & Apply**. When prompted for credentials on the Web API source, choose
   **Organizational account** and sign in.
4. Let the refresh complete. All four pages populate.

---

## Point at a different environment

1. Home → **Transform data → Edit parameters**.
2. Set `DataverseEnvironmentUrl` to the new org URL.
3. **Close & Apply** → sign in with an account for that environment → refresh.

That's the entire repoint. Nothing else is hardcoded — every query reads the
parameter (`AuditInsights.SemanticModel/definition/expressions.tmdl`).

---

## Scheduled refresh (Power BI Service, free/Pro)

1. Publish the report to a workspace.
2. In the dataset settings, set credentials for the Web API source (OAuth2 /
   organizational account).
3. Configure scheduled refresh (up to 8/day on Pro). No gateway needed for the
   cloud Web API source.
4. *(Optional)* enable **incremental refresh** on `Fact_Audit` / `Fact_FieldChange`
   using `CreatedDate` and the `AuditHistoryDays` window, so each refresh pulls only
   new audit rows.

---

## Export the distributable template (.pbit)

To hand the report to another org without your data:
1. In Power BI Desktop with the report open: **File → Export → Power BI template**.
2. Save as `dist/AuditInsights.pbit`.
3. When someone opens the `.pbit`, Power BI prompts for `DataverseEnvironmentUrl`
   and `AuditHistoryDays` before loading — clean one-time configuration.

---

## Pages

| Page | What it answers |
|---|---|
| User Activity Overview | Who is most active; activity over time; operation mix |
| Table & Entity Heatmap | Which tables/fields change most; create vs update vs delete |
| Record Creation Trends | Adoption — new records over time, by table, cumulative |
| Compliance & Governance | After-hours activity, bulk deletes, deletes by user, audit detail |

---

## Companion Canvas App

For record-level investigation and **restore**, see
`../canvas-app/CANVAS_APP_BUILD.md`. The Compliance page's detail table is the
launch point (passes table + record id to the app via URL).

---

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| All visuals blank | Auditing not enabled, or `AuditHistoryDays` window predates any activity |
| Web API sign-in loops | Use **Organizational account** auth, not Anonymous/Windows |
| "Access is denied" on audits | Account lacks audit read privilege — use an admin role |
| Slow first refresh | Large audit volume — lower `AuditHistoryDays`, or enable incremental refresh |
| Model won't open / TMDL error | See the auto-remediation table in the powerbi-scaffold skill; TMDL was hand-authored and may need a minor fix on first load |
