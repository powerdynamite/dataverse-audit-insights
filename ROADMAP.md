# Dataverse Audit Insights — Roadmap

## What the Code App Does Today

- **Record lookup** — search any audited table/record by entity name + record ID
- **Change history timeline** — shows all Create/Update/Delete/Access events for a record
- **Field-level diff viewer** — before/after values with friendly labels for choices/lookups
- **Selective field restore** — pick specific fields and PATCH old values back to the record
- **Deleted record recreation** — recreate deleted records preserving original GUID
- **Audit annotation logging** — creates notes on restored records for traceability
- **Smart guardrails** — system fields excluded, lookup fields flagged as manual, failed writes surface full error messages
- **Power BI integration** — launches from Power BI with table name + record ID via query params

---

## Phase 1: Build the Full Feature Set (Months 1–3)

### 1.1 Bulk Restore
- Select multiple records from audit history → batch restore with progress indicator
- Show summary before executing: "Restoring 47 fields across 12 records"
- Use case: someone bulk-edited 50 records incorrectly, need to roll all back

### 1.2 Restore Approval Workflow
- Restore requests go through a Power Automate approval flow before executing
- Admin selects fields → submits restore request → manager approves in Teams/email → Code App executes
- Audit trail: approval record linked to the restore annotation
- Critical for regulated industries (banking, healthcare, government)

### 1.3 Alert Flow Templates
- Power Automate flows triggered by audit patterns:
  - **Bulk delete detection** — alert if user deletes > N records in 1 hour
  - **After-hours modification** — alert on changes outside configurable business hours
  - **High-risk table changes** — alert on modifications to sensitive tables
- Delivered as importable flow packages alongside the Code App solution
- Configurable thresholds stored in a Dataverse settings table

### 1.4 Audit Export & Reporting
- Export audit history for a record/table as PDF or Excel
- Include before/after diff, timestamps, user info, operation type
- Auto-generated monthly governance report per environment

---

## Phase 2: Expand & Harden (Months 4–6)

### 2.1 Multi-Environment Consolidation
- Single Code App instance spanning Dev/UAT/Prod
- Cross-environment restore: view history from one env, compare with another
- Environment switcher in the Code App UI

### 2.2 GDPR & Compliance Pack
- Right-to-erasure tracking: log and verify personal data deletion requests
- Data retention policy enforcement: flag records past retention window
- Personal data access log: who viewed what personal data and when
- New Power BI page: "GDPR & Data Retention"

### 2.3 Anomaly Detection Rules Engine
- Configurable governance rules stored in a Dataverse table
- Power Automate evaluates rules on a schedule
- Dashboard widget showing triggered rules and trends

### 2.4 Copilot Studio Integration
- Natural language audit queries: "Show me all changes to Account records last week"
- Conversational restore: "Restore the email field on contact record X to yesterday's value"
- Deployed as a Teams bot for admins

---

## Competitive Advantage

| Competitor | Gap | Our Edge |
|---|---|---|
| Native Dataverse audit viewer | No restore, no analytics | Full restore + governance measures |
| Microsoft Purview | Tenant-level, expensive, complex | Dataverse-specific, deploys in 1 hour |
| Custom-built solutions | Each org builds from scratch (200+ hours) | Pre-built, tested, maintained |
| CoE Starter Kit | Adoption analytics only, no audit restore | Audit-focused with actual restore capability |

---

## Key Risks

| Risk | Mitigation |
|---|---|
| Microsoft builds native restore | Unlikely — audit viewer has been minimal for years. Governance analytics + approval workflows go beyond restore |
| Code Apps stays in preview | Maintain canvas app alternative. If Code Apps GA, first-mover advantage |
| Solo founder bottleneck | Managed solution packaging makes deployment repeatable |

---

## Future (Phase 4: Months 10–12)

- Adjacent products: Power Platform Adoption Insights, Copilot Studio Analytics
- SaaS model: hosted dashboard-as-a-service for smaller orgs
- Partner program: other Power Platform consultancies resell with their governance services

> Phase 3 (packaging & commercialization) — to be defined.
