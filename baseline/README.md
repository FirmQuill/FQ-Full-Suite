# FirmQuill ERP Lite

**Local preview · 0.1.0-preview.2 · November 25, 2026**

This package is a working preview for synthetic books. Read RELEASE.md for the open payroll and interoperability gates. The browser application has no subscription, backend, sign-in provider or runtime package dependencies.

## Open on this Windows laptop

1. If working from the ZIP, extract the entire folder.
2. Double-click **Start ERP Lite.cmd**. The launcher uses the installed Node runtime on this laptop. On another computer it can use Node.js 24 on PATH. The equivalent command from this directory is `node serve.mjs`.
3. Open **http://127.0.0.1:4178/fieldledger-lite/** in Edge. Keep the same address and browser profile each time. The launcher serves only the static application files and listens only on this computer. Ctrl+C stops it.
4. Choose **Use sample companies** for synthetic service and product books, or enter your own synthetic company name. Choose a password of at least 12 characters and keep a recoverable copy.
5. Wait for **Available offline** in the desktop toolbar. On a phone-sized display this indicator is hidden to make room for the company picker. The service worker needs one complete online or loopback setup. After setup the same browser can reload the app and save changes offline. Opening index.html from Explorer bypasses the HTTP origin required for this workflow.

## Try the sample books

- **Northline Studio** has a design job, approved employee time, an invoice, a partial collection, a workstation and an intercompany charge. On Overview, the opening sample shows $15,420.00 cash and $1,850.00 owed by customers.
- **Alder Supply** received forty trays, sold eight and paid part of its vendor bill. Warehouse shows thirty-two trays worth $800.00. In Assembly, build a boxed tray using an existing tray. A transfer changes location while preserving carrying value.
- In **Reports**, select **Northline & Alder**, choose a date range covering January 2026 and apply. Compare both companies, then inspect the group-only elimination entries below the statements. Consolidated net income is $4,918.00 in the initial scenario.
- In **Directory**, add a contact and an item or service before starting a new quote or purchase order. Use each document’s next-step button to carry its references forward. Select the record number for source details, attachments and a printable document. Sales credits and vendor credits reverse the entire document, including a cash refund for any settled amount. Record those steps only when the underlying events have occurred.
- In **Company setup**, change the activities and featured workflows. All modules remain accessible from the navigation. Each company uses its own chronological creation sequence for record numbers. Posting dates may differ from creation order.
- In **Banking**, preview a three-column statement CSV, enter its opening and closing balances, review new and repeated lines, then match each new line to a posted cash entry. Reconcile in statement-date order. The first reconciliation begins at zero and must include the opening cash movement. Later reconciliations use the previous closing balance.
- In **Payroll**, use a synthetic employee’s federal worksheet. Supply the pay date, taxable wage bases, prior wages and W-4 elections. The approved-time figure is a straight-time estimate. The worksheet shows the verified federal components and explains why final output is blocked.

## Back up and restore

Under **Company setup**, choose **Download backup**. The encrypted file includes all company books, settings, group definitions and attachments as of the current tab’s last successful save. After editing in another tab, lock and reopen before downloading the latest revision. Store backups separately from the browser profile. Clearing site data can remove the only local copy.

To recover into a fresh browser profile, open the app, select **Restore backup**, choose the encrypted file and enter its password. To replace an occupied vault, unlock it, save a current backup, open **Company setup → Restore backup**, and acknowledge replacement. The destination keeps its existing password. Failed authentication and validation leave the committed vault intact. Lock clears the application display and key references. Inactivity locks after five minutes.

Plaintext bank CSVs, printed documents and attachments are explicit user exports. Their downloaded copies are outside the encrypted vault. Employee setup accepts a name, hourly rate and work jurisdiction. This preview has no production SSN or bank-account intake.

## GitHub Pages preparation

The readable modules in `dist/` are both the source and runnable build. No bundler, install step, server API or absolute root path is needed. For a future publication authorized by the owner, copy **only the contents of dist/**, including `.nojekyll`, to a branch root or its `docs/` folder. Select that branch and folder under **Settings → Pages → Deploy from a branch**. The entry file belongs directly in the chosen folder. Keep backups, attachments, exports, employee data and passwords outside the published tree. This handoff was tested at a local project subpath. No publication was performed. [GitHub Pages publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

A phone requires its own secure origin and local vault. On a phone, 127.0.0.1 refers to that phone. A plain HTTP connection to this laptop’s LAN address cannot provide the secure service-worker setup. Native iOS Safari and Android device verification remain open. [Service worker setup and HTTPS](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)

## Package contents

| Path | Purpose |
|---|---|
| dist/ | Entire static application, versioned core, tax components, CSV adapter, vault and service worker |
| tests/ | Core, banking, payroll, browser, security and recovery checks using synthetic records |
| ACCEPTANCE.md / TEST-RESULTS.md | Requested acceptance scenarios and actual verification |
| RELEASE.md | Release decision and functional boundaries |
| PAYROLL-COVERAGE.md | Federal, state, D.C. and selected local evidence with release status |
| INTEROPERABILITY.md | Supported vendor products, formats, fields and evidence limits |
| PORTABLE-FORMAT.md / VAULT.md | Stable IDs, schema, encryption, locking, recovery and design limits |
| SHA256SUMS.txt | Pinned SHA-256 for each release file except the manifest itself |

Brand update — FirmQuill uses the supplied Headquarters SVG and PNG. The local URL, database name, cache prefix and portable schema identifier retain their original values so upgrading in the same browser opens the existing vault. New encrypted backups use .firmquill. Restore also accepts .fieldledger files.
