# ERP Lite acceptance matrix

Baseline under development: 0.1.0-preview.2. USD, US calendar dates. A passing synthetic scenario is evidence only for the behavior exercised. See TEST-RESULTS.md for executed checks and RELEASE.md for the release decision.

| Area | Acceptance scenario for release |
|---|---|
| Local delivery | Run only from this dedicated Windows project. Package static source, instructions, test evidence and a version checksum. No publishing. |
| Vault | Create and unlock a password vault. Reject a wrong password and modified ciphertext. Lock manually and after inactivity. Restore an authenticated backup without overwriting a live vault by accident. Inspect durable browser storage, logs and cache for private data. |
| Offline and layout | Set up once from a project subpath, disconnect, reload and perform a durable transaction. Exercise desktop and phone layouts. |
| Workspaces | Create service and product books, choose mixed activities, preview recommendations and change the featured modules. Company switching must preserve independent settings, IDs, numbers, balances and stock. |
| Sell | Create customer and service or product; link quote, order, fulfillment, invoice and collection. Apply credits, accept returns and reconcile customer balances and stock. |
| Buy | Create vendor, order, receipt, bill and disbursement. Apply vendor credit and return purchased goods. Reconcile AP, inventory and receipt clearing. |
| Jobs | Record employee time by job, approve time, associate actual costs and billed revenue, inspect job margin. |
| Stock and warehouse | Receive at a location, transfer, adjust, fulfill and return. Reject insufficient quantity or value. Reconcile valuation to GL. |
| Assembly | Consume components, create finished stock, conserve total value, reject missing components. |
| Fixed assets | Acquire an asset, capitalize purchase and post periodic depreciation with residual value and useful-life limits. |
| Accounting | Chart, balanced journals, linked reversal, AR/AP detail, statement CSV import, reconciliation and period close. Reject unbalanced, duplicate or closed-period postings. |
| Statements | Compute trial balance, balance sheet, income statement and cash flow from dated journals using exact monetary arithmetic. Drill into source records. |
| Groups | Compare selected companies, identify both sides of an intercompany transaction and post group-only eliminations. Reconcile consolidated totals to member balances plus eliminations. |
| Wave / QuickBooks | Document product, direction, official format and field profile. Preview and deduplicate. Reconcile opening figures and totals. Verify with actual supported product files. |
| Payroll | Approve time, calculate gross through net, approve run, issue stubs and post a balanced payroll journal. Validate federal, all 50 states, DC and applicable local rules and actual forms for effective tax year. Verify ACH format with specifications and receiving bank. Only generate files; never transmit or imply paid/filed status. Independently review before production. Deny final export if coverage is incomplete. |
| Portability | Version format and retain stable cross-references, records, history, and attachment identity. Keep calculations independent of persistence. Authenticate sensitive backups. |
| Full Suite gate | Deliver completed, accessible Lite baseline first. If only a preview is possible, stop. |
| Full Suite acceptance (planning only) | Reuse exact Lite core; test shared DB, roles, company isolation, admin, approvals, audit, duplicate posting, simultaneous edits and worker-only access. Trace clock corrections and approvals into payroll. Compare two-way migration, links, attachments and reconciliations, test recovery; document nonportable identity records. Deliver source, worker portal and operating instructions separately. |

Handoff amendment: the owner requested FirmQuill branding and authorized Full Suite development from the delivered preview. Production acceptance remains open.