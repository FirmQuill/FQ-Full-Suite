# FirmQuill Full Suite
**Local preview 0.1.0-preview.1 · November 25, 2026**

The company-hosted edition runs two sites from one local process and shares business records through SQLite. The books portal has company assignments, individual accounts, approval queues, audit history and encrypted Lite transfers. The worker portal handles clock-in, clock-out, personal timesheets and corrections. Both sites require the host to be running.

## Start on this Windows laptop

1. Extract the entire ZIP. Double-click **Start FirmQuill Full.cmd**. The launcher uses this laptop’s installed Node runtime. For another host, install Node 24.22.3 (the tested runtime) and run `node host.mjs start` from the extracted directory. Runtime dependencies are included in Node.
2. On first start, enter an owner username, display name and a password of at least 12 characters at the terminal. Password entry is hidden. The package contains no preset logins or business data.
3. Open **http://127.0.0.1:4179/** for the books. For an existing Lite vault, use **Import from Lite** while the workspace is empty. Alternatively select **Create company**. The owner chooses between these paths. An existing company prevents a later whole-vault import into that database.
4. In **User access**, create the individual accounts, select their roles and assign companies. Create jobs and employees under **Jobs & time** before assigning a worker login. Link each worker to one employee in one company.
5. Open **http://127.0.0.1:4180/** for workers. The worker signs in, chooses a company job and clocks in. Clock out submits the shift for review. On the main site the assigned manager opens **Approvals**, reviews the punches and approves or rejects. Use **Refresh** in an already open tab to see changes.
6. Stop the process with Ctrl+C in the launcher. Restarting preserves books and accounts. Each user signs in again.

By default the database is **FirmQuill-data/books.sqlite**, in a sibling directory next to the extracted application folder. The launcher creates that directory on first use. To choose an existing protected data directory set FIRMQUILL_DB to an absolute file path before starting. The host refuses a database path inside its program folder.

## Roles and access

| Account | Available work |
|---|---|
| Owner | All companies, individual user administration, group definitions, intercompany charges, approvals, audit, encrypted import and export |
| Manager | Read and post directly to assigned books, maintain company settings, close periods, review financial and worker submissions, view assigned-company audit |
| Bookkeeper | Work within assigned books. Directory records, jobs, time, quotes, sales orders, purchase orders and attachments save directly. Financial postings and other controlled operations enter the approval queue. |
| Viewer | Read assigned books, reports and available document exports |
| Worker | Separate portal, company job choices, own punches, own time and corrections |

A manager’s decision revalidates the pending financial operation against the current books. Closed periods, insufficient stock and invalid balances still block posting. A revision conflict asks the user to refresh and review the latest state before entering or approving the change. Stable request IDs and a transaction covering books, approval, deduplication and audit protect against a repeated financial posting. The audit screen displays the latest 500 visible events. The SQLite audit table retains older events. A host administrator with filesystem access can alter the database. The audit is an application record, without independent attestation.

Workers can propose corrected intervals with a reason. Managers see the original and proposed times. Approving a correction replaces the effective approved minutes, preserves the original punches and prior values, and feeds the same approved-time rows used by the inherited federal payroll worksheet. The host records the worker timezone with each shift. It allocates elapsed whole minutes across local dates, including tested daylight-saving transitions. Approved intervals range from one minute through 24 hours. Shorter or longer recorded shifts require correction. Use synthetic time for evaluation. Payroll rules for rounding, overtime, breaks and multi-jurisdiction allocation remain open.

Disable a worker account to revoke its active sessions. An open punch stays attached to its original login. To complete it, re-enable that identity, record clock-out, request any necessary correction, and have a manager review it. Company and employee reassignment is blocked while a shift is open.

## Hosting, updates and recovery

See **OPERATIONS.md** for host installation, secure origins, parameters, backup, recovery and updates. See **TRANSFERS.md** for Lite migration and returning an encrypted snapshot to Lite. A disaster-recovery backup includes accounts and worker history. A Lite snapshot contains the portable books and approved time.

## Exact Lite baseline and readiness

Full Suite was built after delivery of **FirmQuill ERP Lite 0.1.0-preview.2**. Its ZIP SHA-256 is `17b21ad3e63ea4cd4e9072baf8a346eccb8ef235763b5ed2977dea1131e10bf3`. Every file in `shared/` came from the delivered ZIP’s dist directory. The test suite verifies all these bytes against the Lite manifest. The main and worker interfaces are under `web/`. Server operations invoke the same portable accounting, time validation, reconciliation and reporting rules as Lite.

**This is a preview for synthetic books.** Verified federal worksheet components are available. Final payroll, tax forms, approved gross-to-net posting, bank-file generation and independent payroll review are outstanding. Final state-level payroll coverage is 0/51. The Lite limits for sales, asset and stock workflows, vendor-file coverage, consolidation and physical-device testing are inherited. Refer to `baseline/RELEASE.md`, `baseline/PAYROLL-COVERAGE.md` and `baseline/INTEROPERABILITY.md` for details. The user authorized the preview as a development baseline. **TEST-RESULTS.md** reports the Full Suite evidence.

This handoff includes the runnable code and test sources. No external account, deployment or hosted service was created.

