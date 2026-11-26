# Install and launch FirmQuill Full Suite

Article: install-launch · Installed version: 0.5.0-preview.1 · Scope: public initial setup only. Verified against host.mjs, server.mjs and the local setup tests.

## Prerequisites

Extract the entire standard program download. Use the tested Node 24.22.3 runtime, a protected local data directory outside the program folder, and distinct free ports for the books and worker portals. The application works locally without AI, a cloud account or an MCP client. Keep the private company package and separate customer manual outside the public program folder.

## Launch

For the illustrated first-launch wizard, open PowerShell in the extracted program directory and run `node host.mjs configure` against a fresh destination. Open the one-time private loopback URL printed by that command; it expires after 30 minutes. Choose empty setup or upload a private .fqsetup.json package, preview, enter the first owner details and confirm initialization. After success, stop the configuration host with Ctrl+C and run `node host.mjs start`. Normal terminal setup remains available through Start FirmQuill Full.cmd or `node host.mjs start`.

Normal startup uses a sibling FirmQuill-data/books.sqlite database unless FIRMQUILL_DB names another absolute path outside the program folder. The default books portal is http://127.0.0.1:4179/ and the worker portal is http://127.0.0.1:4180/. Leave the host running while using either portal. Stop it with Ctrl+C. Start it again with the same data path to retain initialized books and accounts.

## Existing installations

Retain the current program and verified backup before upgrading. Point the new program at a verified copy of the existing database for rehearsal. Existing companies never reapply a setup package. Do not create demo data in an existing workspace and do not run two hosts against the same database. Your host administrator should handle deployment-specific HTTPS and backup configuration.

## Initial problems

Node missing: install or select the runtime, then retry. Port already used: stop a previous host or configure two distinct available ports. Database inside program folder: choose a protected outside location. Cannot reach portal: confirm the host process is running and use the shown URL. For unresolved setup issues, give your designated support contact the installed version and redacted exact error; omit passwords, tokens and customer exports.
