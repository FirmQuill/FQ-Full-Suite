# FirmQuill Full Suite 0.3.0-preview.1 verification

November 26, 2026. Windows, Node 24.22.3, SQLite and Microsoft Edge 158.0.4370.33.

**123 tests passed, 0 failed, 0 skipped** in 66.21 seconds. Full output is in verification.log. Tests use temporary fictional databases and real loopback HTTP/browser sessions.

The final suite covers inherited accounting/stock/bank/report rules, pinned Lite bytes, employee and worker workflows, terms assent and worker branding; owner-only multi-source staging, mappings/profiles, duplicate conflicts and cross-source candidates, row errors, independent balance checks and unresolved reports; package schema/filename/size/hash/reference validation, temporary initialization, safe retry, races and restart without reimport; scoped agent reads/proposals, human approval, revocation, MCP and recovery; default setup-only retrieval, exact version/article citations, missing-guidance escalation and explicit private documentation opt-in; and strict distribution allowlists with private-file canaries.

A copy of the existing five-company fictional Harborline database retained every original table's business rows through two restarts and encrypted recovery. Versioned agreement hash receipts may be backfilled by the already-preserved terms migration. Existing source databases were not opened for writes.

The public guide has 12 actual setup PNGs. The separate private manual has 20 articles and 44 actual PNGs with captions and alt text. Its offline browser verification checked search, article selection, image decode, escalation, no external requests and no page errors. Private documentation is absent from the default help catalog and public runtime build.

Verified import coverage is explicit generic CSV mapping plus inherited QuickBooks/Wave bank templates. Native accounting/payroll export adapters remain unverified. Official export availability/steps and exact sanitized-sample requirements are in the separate implementation coverage matrix. Tax, inventory and complex document conversion are exceptions; archived payroll is isolated from live employees, payroll execution and YTD tax calculations. No live identity/AI/payroll provider or customer export was used.

For source tests, set FIRMQUILL_PLAYWRIGHT and ERP_LITE_PLAYWRIGHT to the installed Playwright module path; set FIRMQUILL_BROWSER_EXE and ERP_LITE_BROWSER_EXE to the Edge executable. FIRMQUILL_HARBORLINE_FIXTURE must point to a disposable fictional five-company SQLite fixture. Run:

```powershell
node --test --test-concurrency=2 tests/*.test.mjs lite-tests/core.test.mjs lite-tests/interop.test.mjs lite-tests/payroll-rules.test.mjs lite-tests/vault.test.mjs
```

Normal startup remains node host.mjs start or Start FirmQuill Full.cmd. Fresh browser setup is node host.mjs configure. See SETUP-GUIDE.html for exact setup instructions. The runtime ZIP excludes source tests and developer/manual documentation; the source checkout includes the tests and release builder.
