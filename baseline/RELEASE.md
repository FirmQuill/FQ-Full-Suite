# Lite delivery decision

**FirmQuill ERP Lite 0.1.0-preview.2 · November 25, 2026 · PREVIEW**

The runnable static application, readable source, Windows launcher, acceptance matrix, test suite, evidence register and recovery instructions are included. This preview can be evaluated with the two supplied synthetic companies or with new synthetic books. The original complete Lite acceptance gate remains open. The owner authorized this named preview as the Full Suite development baseline. Production payroll remains blocked.

## Release blockers

| Requirement | Delivered | What remains |
|---|---|---|
| Approved U.S. payroll, all 50 states and D.C. | Local time, approval, hourly estimates, restricted federal withholding and FICA worksheets; documented examples; final-output blocking | **0/51 state-level jurisdictions** approved for final payroll. Residence and worksite determination, overtime, deductions and benefits, complete state/local rules and employer taxes, approved gross-to-net, stubs, payroll journals, actual filing forms, bank-compatible production ACH, bank validation and independent payroll review remain open. |
| Local tax coverage | Issuer references for named local jurisdictions and reporting systems, with unknown districts blocked | No exhaustive effective-dated locality inventory or nationwide form coverage. |
| Wave and QuickBooks file interchange | Specific USD checking statement CSV adapters; Wave template evidence, Intuit format checks, preview, exact totals, duplicate recognition and export | Native vendor exports, broader record transfer and end-to-end vendor acceptance are unverified. No signed-in vendor account was used. |
| Desktop and phone browsers | Windows Edge tests at desktop and phone widths, touch/mobile emulation, encrypted restore and responsive navigation | Physical iOS/Android devices and other browser engines untested. |

## Current workflow boundaries

- Sales and purchase documents are single item or service lines in USD with integer quantities. Conversions fulfill, receive or invoice the full line. Receipts and bill payments support partial settlement. Credits return the full document. Combined invoices, partial shipments/returns, discounts, sales-tax determination and invoice emailing are outside this preview.
- Inventory uses moving-average value per item and location. Transfers and multi-component builds preserve carrying value. Assembly is a one-step build with explicit quantities. The preview does not schedule production orders or perform lot/serial tracking. Fixed assets use monthly straight-line book depreciation starting in the acquisition month. Tax depreciation and disposals have no implemented workflow.
- Job margins combine posted revenue, posted expenses and approved straight-time estimates. Overtime and payroll-to-job actual cost reconciliation remain open.
- The chart of accounts and one USD operating cash account are fixed. Manual journals use designated non-control accounts. Manual journal reversals retain source links. Corrections for completed sales and purchases use linked credits and returns. General correction coverage for every asset, assembly, reconciliation and intercompany event remains open. Review dates before closing a period. There is no reopen workflow.
- The four statements use the built-in chart and posting dates. Reporting groups support full aggregation and elimination of paired, unpaid intercompany service charges. Each paired entry identifies the other company. Other intercompany transaction types, settlements, investment/equity elimination, ownership changes, minority interests, exchange translation and a full statutory consolidation assessment remain open.
- Bank statements start from inception at zero and reconcile forward, with one-to-one matches of exact amounts to cash journals. Splits, fees combined with deposits, multiple accounts and bank-issued transaction identifiers need additional workflows. The CSV adapter cannot distinguish identical movements split across different overlapping files. Its preview exposes every proposed match.
- The vault encrypts a whole local snapshot. Maximum JSON payload is 32 MiB. All companies within one unlocked owner vault are accessible to that owner. Company filtering separates books. Individual role permissions belong to the later Full Suite.
- Backups preserve portable format v1, stable IDs, attachment bytes, links and history. A restored backup replaces a whole vault. No Lite-to-Full migration, Full-to-Lite snapshot, worker portal or Full Suite software has been built.

## Pin

The exact delivered preview is identified by the package version, the enclosed SHA256SUMS.txt and the ZIP digest supplied alongside the package. A future production baseline must be pinned separately after the Lite gate passes. The complete test record is in TEST-RESULTS.md.

