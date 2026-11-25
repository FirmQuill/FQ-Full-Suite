# Test results

**0.1.0-preview.2 · November 25, 2026 · 35 passed, 0 failed, 0 skipped in the full run**

Windows NT 10.0.26300, Node.js 24.22.3 and Microsoft Edge 158.0.4370.33. Tests used real Web Crypto, a real service worker and real IndexedDB where specified. Profiles, passwords, books, contacts and statement records were synthetic. Two preview servers bound to loopback for the independent browser journeys. The packaged Windows launcher also returned HTTP 200 at its documented project subpath.

| Suite | Passed | Observed evidence |
|---|---:|---|
| core.test.mjs | 12 | Checked exact decimal parsing and overflow bounds, independent service/product expected balances, cross-company foreign-ID rejection, numbering, full and partial settlements, returns, inventory/GL agreement, warehouse transfers, assembly atomicity, depreciation rounding and residual, period close, replay rejection, journal reversal, consolidation, reconciliation and snapshot links. |
| interop.test.mjs | 7 | Tested public bank-upload layouts with synthetic records, quoting, duplicate occurrence IDs, overlapping/reordered input, round-trip with the local parser, signed totals, invalid dates, rejected spreadsheet controls, size and numeric bounds. |
| payroll-rules.test.mjs | 9 | Exercised federal component calculations using official examples, wage thresholds, all six withholding schedule variants, W-4 adjustments, unsupported years and rejection for every state/DC jurisdiction. |
| vault.test.mjs | 6 | Exercised wrong passwords, modified ciphertext/headers, failed schema and saves, atomic revisions, locked access, occupied-vault replacement, cross-tab conflicts, scoped database names and recovery in actual Edge. |
| browser.test.mjs | 1 end-to-end case | Emulated desktop and phone sizes; selected mixed setup activities and created a fresh company; completed service quote through collection using controls; verified printable record; visited every module; selected a reporting group; calculated a blocked federal worksheet; previewed/imported/replayed/matched/reconciled a statement; disconnected, reloaded, unlocked and edited; verified company isolation, manual and five-minute inactivity locking; restored the downloaded encrypted file into a fresh mobile-sized context. |
| **Total** | **35** | **The tested workflows passed. Production payroll and full-product vendor interoperability remain unaccepted.** |

## Accounting control figures

All numbers below are USD for the reproducible sample dataset before additional edits.

| Control | Northline Studio | Alder Supply |
|---|---:|---:|
| Operating cash | 15,420.00 | 9,948.00 |
| Trade receivables | 1,850.00 | 0.00 |
| Trade payables | 0.00 | 500.00 |
| Inventory | 0.00 | 800.00 |
| Net income including the intercompany service | 4,795.00 | 123.00 |
| Trial balance difference | 0.00 | 0.00 |

The $125.00 service charge created linked receivable/revenue and expense/payable entries in the two books. The consolidated report eliminated all four intercompany balances. Net income totaled $4,918.00. Serialized company records compared byte-for-byte equal before and after reading the group report. The service job showed $4,850.00 revenue, $180.00 posted expenses, $160.00 approved estimated labor and $4,510.00 margin.

The browser privacy check searched all eleven cached application responses, the downloaded encrypted backup, captured console messages and request URLs for a newly entered synthetic contact. It found zero plaintext matches. The browser test also found zero localStorage or sessionStorage entries. A separate test read the IndexedDB object store and compared its sole record to the encrypted envelope. These observations cover the exercised browser path. The at-rest threat model and exclusions are in VAULT.md.

## Reproduce

From the extracted folder, run `node --test tests/*.test.mjs` using Node 24. The dependency-free run executes 33 cases. To run all 35 on this laptop from PowerShell with the Codex-supplied runtime on PATH:

```powershell
$env:ERP_LITE_BROWSER_EXE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:ERP_LITE_PLAYWRIGHT = Join-Path (Split-Path (Split-Path (Get-Command node).Source)) 'node_modules\playwright'
node --test tests/*.test.mjs
```

If using a separate Node installation, point ERP_LITE_PLAYWRIGHT to an installed Playwright package. Browser automation is a test dependency only. Optional ERP_LITE_QA_DIR directs synthetic desktop and phone screenshots into an existing directory.

## Outstanding verification

Physical-phone/browser-engine testing, recovery of a large vault near quota, native vendor import/export against synthetic tenants, complete state/local payroll, actual form validation, bank-file acceptance and independent payroll review remain open. See RELEASE.md and PAYROLL-COVERAGE.md for the released scope. Full Suite tests have not started.

Brand upgrade verification additionally opened a synthetic original-release vault and restored its encrypted backup using the FirmQuill module. Both states compared equal, including stable IDs and balances.
