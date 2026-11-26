# Employee Records and Self-Service setup

November 26, 2026 · Full Suite 0.2.0 preview · self-hosted

## Upgrade the existing installation

Stop the old host and retain its program folder. Make a verified encrypted whole-database backup using `recovery.mjs`; see OPERATIONS.md. Point `FIRMQUILL_DB` at the existing database, outside the application folder, then run the new `node host.mjs serve` or the existing launcher. The two portal addresses remain the same. Do not run two host versions against the same database.

`openStore` accepts Full Suite schema 1 and 2. On first open it transactionally creates the employee records, reviews, paystubs, corrections, benefits, evidence, retirement instructions, identity, invites and access tables, then sets `PRAGMA user_version=2`. Existing portable books, employee IDs, account IDs/password hashes, approvals, punches and time entries remain intact. Missing worker identities are created automatically. Existing ERP account scopes are retained. Reopening is idempotent.

Rehearse with a restored copy and alternate ports before selecting a live database. The former release cannot read schema 2; rollback uses the retained old program plus a restored pre-upgrade backup. New Full-only employee records are excluded from Lite transfer files. Backups include them. Nothing in this upgrade modifies FirmQuill Lite or payroll research.

## One employee, one worker identity, optional separate ERP account

1. In **Employee records → Add employee**, enter the employee's name and the existing payroll schema's required hourly rate, work state and locality. This creates the same employee used by timekeeping and payroll, and immediately provisions a worker account with no preset password. Existing employees receive a missing worker identity during migration. Create a company job under **Jobs & time** for clock-in.
2. Open **User access → Employee portal and separate ERP access**. Choose **Portal features** for the employee. Home is always available; Time, Pay, Reviews, Benefits, My Profile and Contacts are individually selectable. The server also denies disabled actions and file downloads. Close any open shift before disabling Time.
3. Choose **Worker setup invite**, enter a recognizable unique username, and issue the expiring single-use link. Give the link and username privately to the employee. The link is displayed once, uses a URL fragment, and contains no password. The employee chooses a password of at least 12 characters. Issuing another invite revokes unconsumed earlier invitations for that account. Password setup revokes its previous sessions. No directory configuration is required.
4. If ERP access is appropriate, choose **ERP permissions**, enable eligibility, and select the maximum allowed areas. Then choose **Separate ERP invite**. Select the duty role and a subset of those areas. The employee sets a separate ERP password using the ERP link. Worker credentials cannot authenticate to ERP, and ERP credentials cannot authenticate to the worker portal.
5. ERP authorization is the intersection of the employee's approved areas, the account's selected areas, assigned companies, and its duty role. Increasing an employee's ceiling does not widen a narrower account grant. A viewer remains read-only even when an area is selected. HR, Payroll and manager permissions retain their record-level limits. A standalone non-employee staff account can be created with **Add ERP user**, its own password, company assignments, role and explicit areas.

Disabling ERP eligibility revokes linked ERP sessions without disabling the worker login. Disabling an account or effective employment access revokes that identity's sessions. An inactive/terminated employee cannot obtain either portal's records. History is retained. A rehire reuses the original employee/provider link and may receive another worker invite; ERP access requires separate owner approval. A future-dated employment status takes effect on its date. Manager access is assigned using the employee manager link or an assigned manager account.

The admin and worker portals remain separate origins. The worker application combines records and the time clock, with the clock at the top of each enabled section. No employee data is placed in public assets, browser storage, a service worker, or public file URLs. Responses use `Cache-Control: no-store`.

## Brand the worker portal

In the ERP, sign in as owner, select a company, then open **Employee records → Worker portal branding**. Choose one of these modes:

- **FirmQuill default:** retain the original worker portal name and mark.
- **This company:** use an optional display name (otherwise use the company’s name) and a PNG or JPEG logo.
- **Parent company:** pick a company in the same workspace. Workers see that company’s own display name and logo, or its book name if a display name is not configured. Configure the parent’s logo on the parent’s own company record. This is a direct branding selection, not an ownership or financial relationship.

Branding appears after sign-in in the header and browser tab. The shared login, ERP portal and publisher terms retain their original branding. Workers never choose or receive another company’s settings. Changes appear on sign-in or refresh. The uploaded logo is optional, capped at 512 KiB and 2048 × 2048, and stored only in the Full Suite database and whole-database backups, not Lite exports.

## Profiles, contacts, projects, reviews and paystubs

**Employee records → Open record** manages department, title, location, hire date, employment status, direct supervisor, approved benefit groups and business contact assignments. Enter an effective date and reason for job/status/group changes. History retains previous and future values. Education and certifications have normal edit forms. **Assign projects** selects jobs from the existing project/job module and records start/end dates and role.

**Contacts & field rules** configures business contacts, company HR/Payroll fallbacks, location-specific fallbacks and employee field rules. Rules are edit, request or view; the server enforces them. Employees update permitted contact/credential fields or submit a correction request. HR reviews corrections and records a decision and reason. Manager views omit private contact fields and benefits group history. A contact removed from one assignment falls back to a valid location or company contact.

HR and the employee's assigned manager may create performance reviews. Unpublished drafts stay with their author (owners retain administrative oversight). **Publish review** records publisher and timestamp and makes the review immutable. Employees can read published reviews and acknowledge receipt; they cannot alter the review. Acknowledgement is receipt, not agreement.

Payroll or the owner opens the employee record and selects **Publish finalized paystub**. Supply a real finalized PDF, period dates, pay date and source, and explicitly confirm it is finalized. The PDF limit is 2 MiB. Only the employee, assigned-company Payroll and the owner can download that file. Managers and HR do not acquire paystub access through supervision. The worker's Pay tab offers the PDF to save or print. The app does not invent pay amounts or treat the inherited payroll preview as finalized payroll.

## Configure benefits

HR or the owner uses **Benefits administration**. For an HR ERP account, grant Employee records and Benefits administration as appropriate. Assign an active company HR workflow owner under benefits settings before sending special cases.

- Configure the company IANA time zone and company initial-enrollment opening/closing offsets from hire date.
- Add eligible groups with unique explicit priorities; the lower number applies first. A group can have its own hire-relative policy. Assign the employee's group IDs in their profile.
- Add plan years with coverage start/end dates. Add offerings with category, eligible groups, waiver setting, tiers and employee/employer costs. The form supports common tiers; advanced configuration supports more.
- Add an open-enrollment window for each group and plan year: opening date, election deadline and separate coverage effective date. Dates are inclusive company-local calendar dates. Different groups can have different windows.
- Use **Advanced configuration** for individual overrides and the complete configuration shape. Individual initial override wins, then the first eligible group with a policy, then the company default. Each card shows which rule applied.

Eligible initial and open cards are created independently when the employee views benefits. Each has its own draft, version, elections/waivers, submission receipt, history, status and effective dates. Saving/submitting 2028 Open Enrollment cannot modify or close 2027 Initial Enrollment. Submitted snapshots retain the actual offerings and rule even if configuration later changes. Drafts refresh from current employer configuration. HR sees overlapping changed coverage as a conflict and must explicitly review any replacement; no silent overwrite occurs.

Initial cards normally correspond to a plan year containing the hire date; an explicit individual override supports a different configured enrollment instance. If no eligible offerings/windows are configured, the Benefits tab explains that and other app sections still work. No carrier record is changed by an election in this local workflow. HR confirms enrollment after its enrollment process is complete.

## Special enrollment

The employee enters an event, event date and requested change, plus supporting evidence when requested. A receipt is returned and the case appears in the assigned HR queue. Employees can track status and respond to requests for more information. HR records information requests or a human eligibility decision and reason. Approval also specifies the plan year, election deadline and coverage effective date, and creates its own special instance.

No legal eligibility, approval or denial is calculated automatically. The configured HR owner reviews the applicable plan and jurisdictional requirements. Evidence is restricted to that employee, assigned case HR owner and owner; managers, other employees, Payroll and unassigned HR cannot download it. Up to five files can accompany a message, each at most 2 MiB, in PDF/PNG/JPEG/plain-text formats. Total case attachment count is limited. A protected download endpoint retrieves bytes from SQLite; no public upload folder is used.

Notifications and routing are in-app. No email transport or automatic email is enabled. Employees receive a visible receipt immediately. No evidence or sensitive details are sent by email.

## 401(k) and other employer plans

Configure each plan independently of health enrollment: eligibility groups, self-service flag, permitted pre-tax/Roth options, percent/amount units, contribution bounds, lead time, optional opening/closing schedule, requested-date or future-month effective rule, workflow owner and controlling system. Amounts use cents internally and USD in the worker form; contribution percentages permit up to two decimal places.

An employee request receives a receipt and remains pending until reviewed. Payroll/HR can export a provider/payroll handoff CSV and keep it pending until confirmation is actually recorded. Recording provider confirmation requires a reason; it does not execute a provider API or change investments/balances. Current, pending, future and historical changes remain visible, separately for each tax treatment.

For FirmQuill-controlled settings, confirmation creates an effective-dated deduction instruction. **Payroll → View effective deductions** selects the most recent effective confirmed instruction for each employee/plan/tax treatment on the chosen pay date. **Benefits administration** has the pending/export/review queue. Closed payroll/books are protected. The inherited app has no production gross-to-net/deduction processor; this upgrade supplies a permissioned review/export/instruction bridge, not a new payroll engine. Apply instructions through the actual payroll process and verify results there.

## Optional directory provisioning, federation and SCIM

Connector management is owner-only under **Identity connectors** and scoped to the selected company. Profile provisioning and authentication are separate. A provisioned person can use a local invite, configured federation, or both. No directory password is imported into employee accounts.

**Active Directory:** choose encrypted LDAP, a certificate-matching hostname, port (normally 636), search base, filter and dedicated read-only bind identity. Grant read-only directory permissions in AD. The Windows adapter uses `System.DirectoryServices.Protocols`, TLS with normal Windows certificate validation, no certificate override, no referral chasing and only Bind/Search operations. An untrusted/mismatched certificate must fail; there is no plaintext fallback. Approve mappings for stable ID, name, business email, department, title, location, manager and groups. Password/credential attributes are prohibited. Test connection, preview, review conflicts, explicitly link existing employees when appropriate, then sync. Creating a new person requires explicitly approved required payroll defaults; the app never guesses pay rates.

Repeat syncs match stable provider ID within connector and company, preserving local credentials/time/history. Email-only matches are review conflicts. A manager reference resolves after linked people are synchronized. Explicit group mappings assign approved benefits groups and may suggest an ERP duty. Suggestions do not create or elevate ERP access; that requires separate owner flags and an ERP account. Deactivation disables linked access and revokes sessions; rehire retains history. An open shift stays attached to its original account.

**OIDC:** configure the exact HTTPS issuer, client ID and optional encrypted client secret. Register the worker and/or ERP callback shown in the connector form. The implementation uses authorization code + PKCE, issuer/audience/signature/expiry/nonce/state checks, RS256 and a separate browser binding cookie. Use **Review identity link** to link the stable provider subject (`sub`) to the reviewed employee and portal. ERP links additionally require an active separately provisioned ERP account with enabled, permitted areas. The same provider subject can have separately approved worker and ERP links; a missing ERP link does not reuse the worker's privileges. Local login works if the provider is unavailable. Other OIDC algorithms and provider-specific extensions are not implemented.

**SCIM:** create a company SCIM connector, approve field/group mappings and new-person payroll defaults, then rotate a company/connector bearer token. Configure the displayed `/api/scim/<connector-id>` base URL in the provisioning client. Tokens are shown once and stored only as hashes. Users supports create/read/list/filter/replace/PATCH/deactivation, pagination, enterprise fields, discovery schema endpoints and SCIM JSON responses. Delete deactivates; it does not erase the employee. Disabled connectors reject tokens. Token rotation revokes the old token immediately. Group resource provisioning, bulk operations, provider-specific schema extensions and automated ERP grants are not implemented; group mappings are explicit configuration/profile provisioning.

Connector secrets use AES-GCM with a host key outside the application folder. See OPERATIONS.md for the key's protected location, Windows permissions and separate backup/recovery. Do not log proxy request bodies, Authorization headers, cookies or OIDC query parameters. Sync history contains safe operation outcomes and counts, not directory passwords or evidence.

## Fictional demo and automated checks

Normal startup contains no seeded company and no preset logins. To create a separate fictional demonstration database:

```powershell
node demo.mjs --create C:\FirmQuill-demo\fictional.sqlite
$env:FIRMQUILL_DB='C:\FirmQuill-demo\fictional.sqlite'
node host.mjs serve
```

The CLI refuses an existing database and an application-folder path. It prompts privately for a password you choose. Six visibly fictional demo users share that explicitly chosen test password: `demo-owner`, `demo-worker`, `demo-other-worker`, `demo-manager`, `demo-hr`, `demo-payroll`. Never seed this fixture into business data. Its 2027 initial and 2028 open windows are intentionally available around creation time to demonstrate independent submissions, not legal plan guidance. No paystub earnings are generated. Review and project samples are clearly marked fictional.

Run backend tests with `node --test tests/*.test.mjs`. Browser tests require Playwright and an installed Chromium/Edge executable, configured through `FIRMQUILL_PLAYWRIGHT` / `FIRMQUILL_BROWSER_EXE` (or the existing `ERP_LITE_` equivalents). Tests create and clean up temporary fictional databases. TEST-RESULTS.md records the checks run for this delivery. Live AD certificate/ACL, Entra or other OIDC issuer, SCIM-client interoperability, TLS reverse proxy, carrier and retirement-provider workflows still require deployment-specific validation and credentials.
