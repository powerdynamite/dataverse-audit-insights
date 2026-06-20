# Dataverse Audit Insights

Turns the Dataverse `audit` table into an active governance + adoption intelligence
layer — a Power BI dashboard plus a record-level restore Canvas App. Free stack only
(Power BI + Dataverse + Power Apps), and portable across environments via a single
parameter.

## Contents

```
AuditInsights.pbip                 Power BI project (open in Power BI Desktop)
  AuditInsights.Report/            4-page report (User Activity, Tables, Trends, Compliance)
  AuditInsights.SemanticModel/     Star schema + DAX, sourced from the Dataverse Web API
canvas-app/CANVAS_APP_BUILD.md     Build guide for the record restore app
docs/SETUP.md                      Per-environment config + .pbit export steps
dist/                              Place exported AuditInsights.pbit here
```

## Architecture

```
Dataverse audit table
   ├─ Power BI  →  Web API OData (/api/data/v9.2/audits), parameterized URL
   │              changedata JSON parsed in Power Query → star schema → dashboard
   └─ Canvas App → RetrieveRecordChangeHistory (custom connector) → diff + restore
```

Key fact: the `audit` table is **not** exposed via the Dataverse/TDS connector, so
the model uses the **Web API** endpoint. See `docs/SETUP.md`.

## Quick start

1. Enable auditing in the target environment (see `docs/SETUP.md`).
2. Open `AuditInsights.pbip`, set the `DataverseEnvironmentUrl` parameter, sign in,
   refresh.
3. (Optional) Build the Canvas App from `canvas-app/CANVAS_APP_BUILD.md`.

## Status

- Power BI project files: authored by hand (TMDL/M/visual JSON). Validate on first
  open in Power BI Desktop — DAX measures and TMDL were not machine-validated
  because the Power BI modeling MCP was not connected in the build session.
- Canvas App: build guide (the `.msapp` is built in Power Apps Studio).
- Tested against environment data: pending — the build environment had auditing off
  (0 audit rows). Verify against a populated environment.
