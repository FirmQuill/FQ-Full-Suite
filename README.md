# FirmQuill Full Suite

Version **0.5.0-preview.1** · self-hosted Windows/Node 24 preview

Read the illustrated, searchable [public setup guide](SETUP-GUIDE.html), or its [Markdown source](SETUP-GUIDE.md), to install, create the first administrator, initialize empty books or an approved company package, verify setup and diagnose setup failures.

For a fresh workspace, run `node host.mjs configure` from the extracted application folder and use the private loopback link printed by the host. After setup, run `node host.mjs start`. The existing **Start FirmQuill Full.cmd** launcher and terminal owner setup continue to work. Existing workspaces are never initialized again. The default database remains in the sibling `FirmQuill-data` folder; set `FIRMQUILL_DB` to an absolute path outside the program folder when needed.

Default local portals are http://127.0.0.1:4179/ (books) and http://127.0.0.1:4180/ (employee). Keep the host running. All workflows work without an AI account. Optional customer-selected agents receive only deliberately granted company/type fields and submit proposed additions for owner approval. Default **Setup help** searches only the public setup guide and has no company-data access.

The reusable full customer manual is delivered separately for migration or support customers. It is absent from this checkout, public help and the standard runtime package. Company-specific migration packages and handoffs are separate private data; never add them to this repository or download.

See [multi-line commercial documents](COMMERCE-LINES.md) and [reviewed migration formats](MIGRATION-FORMATS.md). The native QuickBooks Desktop IIF profile accepts a flat customer or vendor list only. Generic multi-line service CSV mappings and fictional fixtures do not establish native QuickBooks Online, Wave or ADP export-schema compatibility. The existing verified bank templates are retained. The built-in federal tax worksheet remains an estimate; the separate manual payroll workflow finalizes company-entered calculations but does not generate tax filings or payment instructions. The companion Lite upgrade remains single-operator. Payroll research is unchanged.

## Manual payroll

In **Payroll**, an owner or an assigned payroll-role user with the Payroll area can define dated company rules and draft a pay run. The app supports a manually entered gross amount or approved time in the chosen period at recorded pay rates. Company rules start with gross wages and can apply a rate, flat amount or progressive pay-period brackets, with optional work location limits and period/calendar-year wage caps. Opening taxable wages support midyear setup. No statutory rules, overtime calculation, pre-tax benefits, filing forms or money movement are inferred.

Review amounts before finalizing. Approved time and tax versions are retained, stale drafts must be recalculated, and finalized runs cannot be posted twice. The PDF statement appears only in the intended employee's existing Pay portal when that feature is enabled. The CSV register and balanced journal worksheet are for review. Supply verified external chart account codes for the worksheet; it does not post to FirmQuill's ledger. Overlapping periods and edits to finalized runs are not supported.

The encrypted owner Lite-format transfer carries manual payroll rules, draft and finalized calculations, but not Full Suite employee-portal access or published PDF records. Use the whole encrypted Full Suite database backup to recover those together. Treat both backups as sensitive.

First-party source is under [MIT](LICENSE); see [component notices](THIRD-PARTY-NOTICES.md). Agreement acceptance remains separate from the source license. Source tests and release builder are included for local verification; see [test results](TEST-RESULTS.md). The public runtime ZIP is built from an explicit allowlist and contains only runtime files, licenses and public setup help.
