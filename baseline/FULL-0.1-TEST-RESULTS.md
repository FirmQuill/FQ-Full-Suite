# Full Suite acceptance results

**FirmQuill Full Suite 0.1.0-preview.1 · November 25, 2026**

The combined final run passed **51 tests**, including 35 inherited Lite regression cases and 16 Full Suite cases. Zero failures or skips. Tests used synthetic companies, employees, financial transactions, passwords and bank records on Windows, Node 24.22.3 and Microsoft Edge 158.0.4370.33.

| Requirement | Executed check and outcome |
|---|---|
| Exact baseline | Verified every shared build file against the SHA-256 manifest from the separately delivered FirmQuill Lite 0.1.0-preview.2 ZIP. The byte-identical accounting, payroll, statement and validation modules passed the inherited regression cases. |
| Company and payroll parity | The server retained both synthetic company objects exactly. Northline and Alder reported cash of $15,420.00 and $9,948.00. The browser’s consolidated report showed $4,918.00 net income after eliminations. The shared federal routine returned $11.16 employee Social Security for $180.00 of specified taxable wages. Every state and D.C. continued to block final payroll. Complete payroll parity cannot be evaluated until the Lite production payroll gap is closed. |
| Main portal | Browser journey imported an encrypted Lite file into an empty owner workspace, confirmed preview balances, opened reports, created a company-assigned bookkeeper, submitted a journal, approved it from a separate owner session and inspected audit. Downloaded encrypted snapshot decrypted with matching company IDs and balances. |
| Access enforcement | Direct server checks denied out-of-company posting, viewer writes, manager account administration, nonowner transfers, worker access to the main portal, and requests with missing CSRF or a mismatched origin. Disabling a user revoked their existing session. Stale account updates were rejected. |
| Concurrent work and replay | Simultaneous writers using one base revision produced one commit and one HTTP 409. Repeating the committed request preserved the new balance and revision. A second financial submission remained pending until an authorized reviewer approved it. Reapproval did not create another journal. |
| Worker and manager portals | In Edge at 390×844 and desktop width, workers clocked in and out, requested corrections and saw manager decisions. Two reviews changed approved minutes from 75 to 40. Only the final 40 minutes contributed to the active time list. Original punches and previous correction records remained available. |
| Time rules | Six worker-domain cases covered company and employee boundaries, duplicate clocks, stale punches, midnight/DST elapsed time, abnormal duration, rejected/approved corrections, closed periods and overlaps. Approved time feeds the inherited straight-time worksheet. |
| Migration | Encrypted transfers preserved company boundaries, IDs, attachments, postings, control totals and reporting groups. Incorrect credentials, tampering, dangling references and occupied targets were rejected. Transfer documentation distinguishes portable books and Full-only records. |
| Disaster recovery | Recovery restored the committed SQLite snapshot including all seven populated application tables, roles, credential hashes, worker records and approvals. Uncommitted data was excluded. A recovered instance accepted the original accounts and returned the original books. Wrong passwords, tampered archives and existing destinations failed closed. |
| Local launcher | Tested the packaged Windows command against a disposable empty database. First-run setup prompted for an owner and masked password. Both sites returned HTTP 200 on their configured loopback ports. |

## Reproduce the combined run

From the Full Suite package directory, using the tested Node 24.22.3 runtime and installed Playwright, set both sets of browser variables. The Lite baseline tests use the older names.

```powershell
$env:ERP_LITE_BROWSER_EXE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$env:ERP_LITE_PLAYWRIGHT = Join-Path (Split-Path (Split-Path (Get-Command node).Source)) 'node_modules\playwright'
$env:FIRMQUILL_BROWSER_EXE = $env:ERP_LITE_BROWSER_EXE
$env:FIRMQUILL_PLAYWRIGHT = $env:ERP_LITE_PLAYWRIGHT
node --test lite-tests/*.test.mjs tests/*.test.mjs
```

For another Node installation, point the Playwright variables to its installed package. The test process needs loopback access and permission to open headless Edge with temporary synthetic profiles. Playwright is optional for operating the apps. The final full run includes the recovery fixture passing the current shift ID when clocking out, as required by the server’s stale-punch protection.

## Verification limits

The company-network TLS example is documented for the host operator. Verification used local loopback, desktop Edge and mobile emulation; physical iOS/Android, WAN hosting, large concurrent workloads, independent security audit, large-database recovery beyond 64 MiB and independent payroll review were outside the executed tests. The preview has no production tax filing or direct-deposit file output. The supported vendor interoperability remains the two documented bank-statement CSV profiles, with end-to-end acceptance by vendor tenants unverified.

