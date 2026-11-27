# FirmQuill Full Suite

Version **0.6.5** · self-hosted Windows/Node 24 preview

See [company collaboration](COLLABORATION.md) for the knowledge base, messaging, shared drives, and employee permissions.

Read the illustrated, searchable [public setup guide](SETUP-GUIDE.html), or its [Markdown source](SETUP-GUIDE.md), to install, create the first administrator, initialize empty books or an approved company package, verify setup and diagnose setup failures.

For a fresh workspace, run `node host.mjs configure` from the extracted application folder and use the private loopback link printed by the host. After setup, run `node host.mjs start`. The existing **Start FirmQuill Full.cmd** launcher and terminal owner setup continue to work. Existing workspaces are never initialized again. The default database remains in the sibling `FirmQuill-data` folder; set `FIRMQUILL_DB` to an absolute path outside the program folder when needed.

Default local portals are http://127.0.0.1:4179/ (books) and http://127.0.0.1:4180/ (employee). Keep the host running. This public release contains no AI integration or external agent access. Default **Setup help** searches only the public setup guide and has no company-data access.

The full customer manual is separate from this public release. It is absent from this checkout, public help and the standard runtime package. Company-specific migration packages and handoffs are separate private data; never add them to this repository or download.

See [multi-line commercial documents](COMMERCE-LINES.md) and [reviewed migration formats](MIGRATION-FORMATS.md). The native QuickBooks Desktop IIF profile accepts a flat customer or vendor list only. Generic multi-line service CSV mappings and fictional fixtures do not establish native QuickBooks Online, Wave or ADP export-schema compatibility. The existing verified bank templates are retained. The built-in federal tax worksheet remains an estimate; the separate manual payroll workflow finalizes company-entered calculations but does not generate tax filings or payment instructions. The companion Lite upgrade remains single-operator. Payroll research is unchanged.

See [month-end close](MONTH-END-CLOSE.md) for dated close preparation, authorized sign-off, period locks and downloadable packets.

See [managed encrypted backups](MANAGED-BACKUPS.md) for optional daily and before-approved-write server archives. Both triggers are off by default.

## Download local support diagnostics

In the main portal, owners can open **Setup help → Local support diagnostics → Preview diagnostics**. The JSON download contains only installed application, Node and SQLite versions, a recognized schema version, and coded checks for expected schema parts. The preview is exactly what will be downloaded. It excludes application records, identities, logs, host paths and secrets, does not test external services or backup status, and is never sent or uploaded automatically.

## Manual payroll

In **Payroll**, an owner or an assigned payroll-role user with the Payroll area can define dated company rules and draft a pay run. The app supports a manually entered gross amount or approved time in the chosen period at recorded pay rates. Company rules start with gross wages and can apply a rate, flat amount or progressive pay-period brackets, with optional work location limits and period/calendar-year wage caps. Opening taxable wages support midyear setup. No statutory rules, overtime calculation, pre-tax benefits, filing forms or money movement are inferred.

Review amounts before finalizing. Approved time and tax versions are retained, stale drafts must be recalculated, and finalized runs cannot be posted twice. The PDF statement appears only in the intended employee's existing Pay portal when that feature is enabled. The CSV register and balanced journal worksheet are for review. Supply verified external chart account codes for the worksheet; it does not post to FirmQuill's ledger. Overlapping periods and edits to finalized runs are not supported.

Employer-entered Manual Payroll does not require a license or activation code.
Existing licensed payroll flags may still verify in an older signed code; they
are not a processing requirement. Existing optional private support activation is separate. The federal estimate
worksheet is not a Manual Payroll
rule source, and no defaults from the researched tax package are loaded.

Each effective rule version can record a descriptive jurisdiction, separate
employee versus employer treatment, all/regular/other earnings, whether its
basis includes or subtracts entered deductions, cent rounding (half up, down,
or up), and whether to skip partial periods. A jurisdiction label is for
documentation and exports; only existing work-state and work-locality filters
determine location scope. Use distinct IDs for independent taxes/payers/
jurisdictions: a newer version of the same ID supersedes the old one *before*
location filtering. The same ID carries its recorded prior taxable basis into
the next effective version. Review historical and opening wages before changing
a rule's identity or basis.

Enter actual dollars for the actual full or partial period, with any confirmed
pre-tax deductions separately allocated to regular and other earnings. These
reduce net once; each enabled rule independently uses its chosen basis. No
automatic prorating, annualization, employee deduction schedules, benefit-plan
mapping, rate tables, filings, or transfers are provided. A period is chosen
explicitly, not inferred from its date length. Effective dates and calendar
caps use pay date; per-period caps and progressive bands run once on that
period's selected basis. Brackets round the final sum, not each band. The
versioned reviewed run and export include the exact rule settings and basis.
A balanced journal worksheet needs a deduction-payable account when a run
contains a deduction. This does not post to books.

The encrypted owner Lite-format transfer carries manual payroll rules, draft and finalized calculations, but not Full Suite employee-portal access or published PDF records. Use the whole encrypted Full Suite database backup to recover those together. Treat both backups as sensitive. Upgrade Lite and Full Suite together before moving version-2 calculations; prior builds may reject them. Existing version-1 rules and finalized records need no rewrite.

First-party source is under [MIT](LICENSE); see [component notices](THIRD-PARTY-NOTICES.md). Agreement acceptance remains separate from the source license. Source tests and release builder are included for local verification; see [test results](TEST-RESULTS.md). The public runtime ZIP is built from an explicit allowlist and contains only runtime files, licenses and public setup help.

### Optional passkeys

Supported local accounts can choose **Manage passkeys** after signing in and
accepting the Terms. Confirm your current FirmQuill password and follow your
browser or password manager’s prompt. Password sign-in still works. Passkeys
require the same registered portal hostname: use `http://localhost:<port>` on
the host itself or separately configured, trusted HTTPS portal hostnames over
the network. Numeric or cleartext LAN addresses can still use passwords, but
not passkeys. Changing the hostname requires enrolling again. Encrypted full
backups retain the public credentials recorded by FirmQuill, not device private
keys. After restoring an older backup, review enrolled passkeys in case it
predates a revocation.

### Shared staff time clock

Open **Time clock kiosk** in the owner portal, select the company, and **Create
station** for a single existing job. Open the employee portal's `/kiosk` page
on the shared computer (for example `http://127.0.0.1:4180/kiosk` on the
FirmQuill host). Use a dedicated browser profile with no signed-in accounts or
saved passwords. A separate computer needs the organization's configured HTTPS
employee portal. The one-time pairing code lasts 15 minutes and the resulting
browser pairing lasts 30 days. **Replace pairing** disconnects the old browser
immediately without changing its workers' PINs.

An active worker with the **Time** feature must first accept the current Terms
in their usual worker portal. The owner issues that worker a station-specific
10-digit PIN and shares it privately along with their worker ID. The kiosk
lets the worker clock in or out for the station job only; it does not open any
employee records. A punch made on another job uses the original station or the
ordinary portal. Punches use the host clock and the usual timesheet review.
The station job is a routing boundary, not a GPS or site-verification feature.
Badge/RFID readers are not part of this version.

Revoke a lost station or remove an individual worker's kiosk access in the
owner portal. Neither operation edits past punches or closes an open shift.
A restored older database may restore then-active station credentials; before
putting a restored host back on the network, replace each retained station
pairing or revoke it, and reissue PINs if their history is uncertain.

### Worker portal branding

In **Worker portal branding**, choose a PNG or JPEG and review the fitted
preview before saving. Larger images are reduced locally without cropping,
stretching, or losing PNG transparency. The original can be up to 20 MiB,
8,192 pixels per side, and 24 megapixels. Saved logos remain limited to
512 KiB and 2,048 pixels per side. No change is saved if you cancel.

### Private and group drives

In the company portal, open **Drives** for the selected company. Non-owner ERP
accounts need an explicit **Drives** area grant. The personal
drive is scoped to your login and company, not visible to other users or to
business owners acting as other users. Select a collaboration group to open its
drive; only current company members of that group may open it, and removing a
member immediately blocks future requests. Group files already downloaded to
another device are not recalled. The owner can manage membership but has no
automatic access to a group or another login's private drive. A server operator
with operating-system access to the database can still read it.

Create folders and upload/download files from either portal. In **Identity
connectors**, an owner can enable **Drives** in an employee's portal features.
Group sharing still requires membership. Files transfer as attachments only; the
app neither previews, edits, executes nor scans downloaded files. Only the
uploader can delete an item, and folders must be empty. The app prevents
overwriting an existing name. This preview supports up to 4 MiB per file, 16 MiB
of drive payloads and 4,096 entries across the server, with up to 12 folder levels.

The encrypted whole-server `.fqdb` recovery archive contains drive data, accounts
and membership together; it is not part of the portable Lite books package.
Treat the live SQLite file, its journals and any downloads as readable data.
Recovery still has a 64 MiB whole-database limit, not a per-drive limit; the
drive reserves headroom on writes but does not prevent growth elsewhere in the
application. Deletion does not erase old backups or all retained storage copies.

Optional: see [Private FTPS file transfer](FTPS-SETUP.md) to configure manual file copies to and from an organization-controlled explicit-TLS FTP server.

### Report builder

From the main portal, select a company and open **Report builder** (Reports
permission required). Configure a single-company packet from the posted ledger:
Balance sheet, Income statement, Cash flow and Trial balance. Pick sections and
their order, dates, account detail and applicable trial balance columns or class
filter. Review the preview first, then print it or choose **Save as PDF** in your
browser's print dialog. The CSV uses the same displayed values in decimal USD.
No report is automatically sent. Always check dates, completeness and the
recipient's requirements before sharing.

Templates are private to the account and company that created them. A template
stores names and report settings, never amounts or copies of ledger records.
The current ledger and permissions are checked again immediately before manual
export. Scoped project accounts see **Partial report** in the preview, PDF and
CSV; these results are not full-company figures. Filtered trial balance totals
are not whole-ledger totals. Cash flow covers only the operating cash account
and labels any unclassified movement. The builder does not include journals,
payroll, identifiers from source records, lender-specific form submission,
multi-company consolidation or certifications. The standard Reports screen
remains available for ordinary consolidated accounting reports.

### Busy sign-in periods
When several people sign in at once, local password sign-ins may wait briefly
instead of failing immediately. The wait is bounded; a busy message means the
user should pause briefly and try again, not refresh repeatedly. Company and
worker portal sign-ins share the same host's capacity. Single sign-on, identity
provider settings, the existing sign-in attempt limits, and ordinary workspace
permissions are unchanged. Check this on the intended hardware before relying
on it for a shift change.

### Optional signed offline support data (0.6.5)

FirmQuill Full Suite remains an Early Development build. The download does
not include a private manual or an issuer. A host administrator may install
a separately supplied 0.6.5 `.fqsupport` file by placing it in a protected
local folder outside the app, then pointing the host at it. The signed file
contains text documentation only. No scripts, code, branding or other
modules are installed or executed. It is verified again on each startup.

Use Windows PowerShell (replace the sample paths with your own):

```powershell
$env:FIRMQUILL_SIGNED_SUPPORT_PACKAGE = 'C:\FirmQuillProtected\site-065.fqsupport'
$env:FIRMQUILL_SUPPORT_PACKAGE_PUBLIC_KEY = 'C:\FirmQuillProtected\package-public.pem'
$env:FIRMQUILL_ENTITLEMENT_PUBLIC_KEY = 'C:\FirmQuillProtected\entitlement-public.pem'
$env:FIRMQUILL_MODULE_INSTALL_DIR = 'C:\FirmQuillProtected\activation'
node host.mjs
```

Keep the installation ID and activation directory from your initial setup.
Obtain both distinct, trusted Ed25519 **public** PEM keys and the matching
installation-bound package through your issuer's authorized channel. Never
put an issuer private key on the host. Restrict the folder to the host
operator and service account (configure NTFS permissions yourself on Windows).
A package alone does not activate anything. Only a signed license with the
existing private-support entitlement enables the installed owner manual,
after sign-in and Terms acceptance. Missing or rejected packages do not
interrupt ordinary use or public setup help. If signed package settings are
present, invalid packages do not select an older unsigned owner manual.
To remove or replace the package, stop the host, update these settings and
restart; this does not modify books or activation state.

### Public 0.6.5 AI removal and license compatibility

Stop the older host and use a freshly extracted application folder. Do not
overlay 0.6.5 onto an older program directory. Retain your separate database and
recovery archives. Existing AI integration records are not deleted, but no
AI integration routes, UI, or command-line adapter are included in 0.6.5.
A signed license alone cannot restore removed code. For a prior mixed
license containing an AI module, ask the issuer for a public-compatible
reissue for the supported entitlement; ordinary workflows do not need one.

### Optional manual package folder

This host can read separately issued, signed data packages from `packages\` beside `host.mjs`. It does not load executable code,
rewrite the application, download anything, or enroll AI or tax automation.
Only Knowledge Base Markdown and reviewed schema-1 payroll rule templates are
supported today. Neither content package is included in the download.

1. Keep the activation directory and its owner-only permissions. Obtain a
   public-compatible, installation-bound `private-support` license for the canonical `full-suite-knowledge-base` package, or a
   time-limited `payroll-rule-template` license for that package. Activate it
   in Version Upgrade. Legacy `private-support` maps only to the existing
   Knowledge Base capability; unrelated entitlements do not admit other types.
2. From the issuer obtain the installation-bound `.fqpackage` file and the
   package signer’s authenticated Ed25519 **public** PEM, distinct from the
   entitlement verifier. Keep both verifiers outside the program and the
   drop folder. Never copy a private issuer key to the server.
3. For initial trust configuration only, start the host with the publisher
   verifier below. Keep the existing `FIRMQUILL_ENTITLEMENT_PUBLIC_KEY` and
   `FIRMQUILL_MODULE_INSTALL_DIR` settings. To store drops elsewhere, set
   `FIRMQUILL_PACKAGES_DIR` to a dedicated absolute directory.

   ```powershell
   $env:FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY = 'C:\FirmQuillProtected\package-publisher-public.pem'
   node host.mjs start
   ```
4. Create `packages` beside the application and place at most one
   `.fqpackage` per supported package ID there. Restrict folder writes to the
   host operator using protected NTFS permissions. Once trust is configured,
   routine package drops do not require editing configuration or restarting.
5. As owner, open **Packages → Review package folder**. Review IDs,
   types, revisions and eligibility. Select the eligible package(s), check the
   confirmation and choose **Apply selected packages**. A drop or a license
   alone never applies a new package. A separate confirmation is required.
6. Applied Knowledge Base content appears under **Setup help** for the
   authorized owner. **Payroll → Review payroll templates** lets an authorized
   company owner or payroll user review and explicitly copy selected rule
   suggestions. This does not overwrite existing codes, finalize runs, determine
   applicable taxes, or submit payments. Employer-entered Manual Payroll
   continues to work without a license.

The host restores only previously approved exact dropped bytes on restart.
For updates, replace the previous file with the issuer's higher signed
revision, then use the same owner review flow. A dropped new revision does
not change an already-running workspace before owner confirmation. If the
host restarts before you approve a changed drop, that new revision is not
loaded. A lower revision, a different manifest at the same revision, the
wrong installation/runtime, an invalid signature or a missing entitlement
cannot enable content. The host checks the live entitlement before use;
accepted content is immutable in memory. Missing or unverified drops do not
interfere with ordinary use. Folder mode does not fall back to a separately
configured unsigned or legacy signed owner manual.

The approved Knowledge Base catalog and Markdown can contain up to 1 MiB of
UTF-8. The optional payroll template uses one `templates.json` file up to
64 KiB, with reviewed, versioned rule suggestions only. Both use a signed JSON envelope with format
`firmquill.manual-package.v1`. The manifest signs the fixed package ID/type,
monotonically increasing integer version, exact runtime, installation ID,
entitlement name, and SHA-256 of each document. Keep
`manual-package-admission.v1.json` in the protected activation directory together
with its backup; restoring an older copy of that host directory restores its
older rollback history. A stale lock after a machine crash fails closed. Have
the host administrator verify all host processes are stopped before clearing
the stale lock; do not delete the high-water mark to admit older content.

### Workspace navigation and help

Company setup’s featured-workflow settings control which optional business
workflows are shown in the sidebar and overview. This is a navigation choice,
not a permission grant. Administration, Legal, Setup help and other separately
authorized role tools remain available.

Contextual question marks appear only for a matching, separately configured
article with active private-support access to that company, role, portal and
page. The public Setup help remains available without a license. The owner’s separate Packages page shows approved eligible content. Version
Upgrade only accepts a local signed license file and reports completion based on
the packages actually applied.

### Versioned add-on installer development

The feature-agnostic installer, signed grants, dynamic settings, contained Node
service interface and audited workspace broker are documented in
[ADDON-INSTALLER.md](ADDON-INSTALLER.md). Local acceptance uses signed fictional
payloads and disposable workspaces. Existing Knowledge Base, Payroll and AI
payloads were not changed; no release or production deployment is implied.
