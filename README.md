# FirmQuill Full Suite

Version **0.3.0-preview.1** · self-hosted Windows/Node 24 preview

Read the illustrated, searchable [public setup guide](SETUP-GUIDE.html), or its [Markdown source](SETUP-GUIDE.md), to install, create the first administrator, initialize empty books or an approved company package, verify setup and diagnose setup failures.

For a fresh workspace, run `node host.mjs configure` from the extracted application folder and use the private loopback link printed by the host. After setup, run `node host.mjs start`. The existing **Start FirmQuill Full.cmd** launcher and terminal owner setup continue to work. Existing workspaces are never initialized again. The default database remains in the sibling `FirmQuill-data` folder; set `FIRMQUILL_DB` to an absolute path outside the program folder when needed.

Default local portals are http://127.0.0.1:4179/ (books) and http://127.0.0.1:4180/ (employee). Keep the host running. All workflows work without an AI account. Optional customer-selected agents receive only deliberately granted company/type fields and submit proposed additions for owner approval. Default **Setup help** searches only the public setup guide and has no company-data access.

The reusable full customer manual is delivered separately for migration or support customers. It is absent from this checkout, public help and the standard runtime package. Company-specific migration packages and handoffs are separate private data; never add them to this repository or download.

Generic migration mappings and fictional fixtures do not establish native QuickBooks, Wave or ADP export-schema compatibility. The existing verified bank templates are retained. Final payroll and tax filing remain outside this preview's verified scope. FirmQuill Lite and payroll research are unchanged.

First-party source is under [MIT](LICENSE); see [component notices](THIRD-PARTY-NOTICES.md). Agreement acceptance remains separate from the source license. Source tests and release builder are included for local verification; see [test results](TEST-RESULTS.md). The public runtime ZIP is built from an explicit allowlist and contains only runtime files, licenses and public setup help.
