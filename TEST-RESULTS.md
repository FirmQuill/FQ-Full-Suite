# Employee upgrade verification

November 26, 2026 · FirmQuill Full Suite 0.2.0 preview

**89 tests passed; 0 failed; 0 skipped.** Final run completed in 35.34 seconds on this Windows laptop with Node 24.22.3, SQLite and Microsoft Edge 158.0.4370.33. Playwright came from the installed local runtime. Tests used temporary fictional databases, real loopback HTTP listeners and actual Edge sessions.

Command, with installed Playwright/Edge paths supplied through the existing `FIRMQUILL_` and `ERP_LITE_` browser environment variables:

```powershell
node --test --test-concurrency=2 tests/*.test.mjs lite-tests/core.test.mjs lite-tests/interop.test.mjs lite-tests/payroll-rules.test.mjs lite-tests/vault.test.mjs
```

Complete final output: `verification.log`. The older report is retained at `baseline/FULL-0.1-TEST-RESULTS.md`.

## Verified workflows

| Area | Evidence |
|---|---|
| Upgrade | Schema 1 to 2 preserves original employee/account IDs, hashes, books and punches; creates missing workers without default passwords; repeated migrations retain history. |
| Worker app | Combined records/time app, single-use password setup and renewal (including an already signed-in page), local login/clock without an IdP, original corrections/approvals retained. |
| Feature flags | Actual admin forms, worker navigation and server projections agree; disabled actions/files are denied; open shifts block Time disabling. |
| Separate ERP | Actual flags, invite/setup, independent passwords, cross-portal credential denial, Directory-only navigation/API scope, role checks, area ceiling/grant intersection, immediate ERP revocation with continuing worker access. |
| ERP projection | Restricted Jobs & time renders real time/names without hourly rates/costs. Authorized journals retain source references; other-area attachments and embedded payroll history are omitted. |
| Employee records | Actual contact/profile/education/certification/project forms; edit/request/view rules; correction decisions; effective-dated and future history, scheduled deactivation and backdated separation after rehire; contact fallbacks. |
| Reviews | Author-private drafts; other HR/manager draft denial; publish metadata; immutable published review and employee acknowledgement; company/employee denial. |
| Paystubs | Permissioned finalized PDF publishing and exact-byte authenticated download in actual UI; no generated earnings; employee/Payroll/owner visibility; HR/manager/cross-company denial. |
| Enrollment | Actual warehouse worker submits 2028 open first, then 2027 initial; separate choices and receipts. Reverse order, independent waivers, override/group priority, company-local deadline, immutable submissions and explicit HR coverage conflicts also tested. |
| Special cases | Actual evidence upload/receipt reaches assigned HR UI; information request and employee reply; restricted evidence and human decisions with reason/deadline/effective date. |
| Retirement | Pending receipt, independent schedules/options/limits/precision, payroll confirmation and date-selected deduction instructions, provider export stays pending, current/future/historical transitions and closed-payroll protection. |
| Provisioning | Scoped stable IDs, repeat sync, explicit email-conflict review, manager/group mapping without ERP elevation, deactivation/session revocation, rehire preservation, encrypted secrets and safe sync-history outcomes. |
| SCIM HTTP | SCIM media type, Users create/list/filter/pagination/update/PATCH/deactivation, token rotation and company scope, malformed requests, invite/login/clock, immediate revocation and rehire retaining original punch. |
| Federation | Deterministic provider fixtures verify RS256 signature, issuer/audience/expiry/nonce/state/browser binding/PKCE, separate reviewed worker/ERP subject links, and disabled ERP flags/account denial without worker elevation. |
| Recovery/regression | Authenticated whole-database recovery, consistent WAL snapshot, existing-destination protection, encrypted Lite transfers, unchanged pinned shared-file hashes, inherited accounting/reconciliation/inventory/federal worksheet/encrypted-vault checks. |

Worker portal/browser checks ran at 390px and 1280px; the existing admin suite used 1440px. No page errors or document-wide horizontal overflow were found. Screenshots were visually inspected. The mobile Benefits screenshot shows both submitted cards and pending 401(k); desktop evidence shows assigned HR routing. Tests closed their servers and browser contexts.

## Evidence limits

No live AD, Entra/other issuer, SCIM client, carrier or retirement credentials were supplied. Live certificate/trust-chain rejection, AD read-only ACLs and provider interoperability require deployment-specific validation. AD uses TLS Bind/Search without certificate overrides. OIDC supports code/PKCE and RS256; SCIM is the documented Users subset, without Groups/Bulk/provider-specific extensions.

No external provider mutation or production payroll execution occurred. The inherited payroll is a preview; this release supplies real finalized-PDF publishing and a permissioned effective-deduction instruction/export bridge. Health elections require HR confirmation; external retirement requests stay pending until recorded confirmation. No automatic legal eligibility decision or email notification runs.

Migration ran on synthetic upgrade fixtures, not a selected business database. First startup against an existing schema-1 database applies the tested migration; retain a pre-upgrade backup. PDFs/evidence live in SQLite. The inherited 64 MiB recovery limit, protected host storage and separate connector-key backup are documented in OPERATIONS.md. Filesystem administrators can alter the database; application audit is not independent attestation.

Nothing was published. FirmQuill Lite and 2027 payroll research were left unchanged.
