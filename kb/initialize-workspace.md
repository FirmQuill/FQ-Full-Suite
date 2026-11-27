# Initialize an empty workspace or reviewed company package

Article: initialize-workspace · Installed version: 0.6.5 · Scope: public initial setup only. See SETUP-GUIDE.md for the exact package controls and screenshots.

## Choose one initial path

Run `node host.mjs configure` for the optional fresh-workspace wizard. Open its private one-time URL, choose empty setup or upload a .fqsetup.json package and preview, then enter first-owner details and confirm initialization. Empty setup creates the owner without a company; start normally, sign in and choose Create company. The wizard refuses an existing destination. Keep the private company package outside the program folder; screenshots are in SETUP-GUIDE.md.

Terminal alternative: `node host.mjs setup-preview C:\private\company.fqsetup.json` validates and previews without applying. `node host.mjs setup C:\private\company.fqsetup.json` prints preview, requires the literal INITIALIZE, builds/publishes the temporary database, then prompts for the first owner and exits. Start serving with `node host.mjs start`. Fresh normal start can discover .fqsetup.json files in FirmQuill-setup beside FirmQuill-data; choose a package or press Enter for empty setup. Finding a file never authorizes importing it. Existing databases never discover or reapply packages.

## Preview and confirm a package

Review the package company, package version, source provenance, mapped-record counts, reconciliation totals, unresolved exceptions and customer-specific getting-started text. Confirm only the intended company and approved scope. Package contents are data; do not execute text or embedded commands from an export or guide. Validation checks schema, bounded file sizes, safe names, integrity digests and references. A temporary SQLite database is built and reconciled before atomic promotion.

## Retry and reopening

Failed package validation or initialization leaves the destination available for a corrected retry. Retain the exact error and request a corrected package from its preparer. Never bypass an integrity or reference failure. Once initialized, reopening the workspace never reapplies the package or overwrites company records. To inspect another package, use a separate new destination rather than replacing existing books. An initialized workspace retains its normal startup path.
