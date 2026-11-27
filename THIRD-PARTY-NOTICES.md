# Distribution audit

Runtime imports are first-party relative modules and Node.js built-ins, including node:sqlite. Node.js and its SQLite implementation are separately installed prerequisites, not bundled here. shared/ contains the first-party FirmQuill Lite baseline. Playwright is a separately installed test-only tool, not a shipped runtime. The repository does not redistribute Node, Playwright, browser binaries or third-party fonts. No separately attributed copied snippet was identified. Branding/images are excluded from MIT.

This is an inventory of identified shipping components, not a license grant for excluded material. Preserve each applicable notice when repackaging.

## Full Suite WebAuthn runtime

The optional passkey feature bundles SimpleWebAuthn Server 14.1.0 and Browser 14.0.0 with pinned dependencies, prebuilt for Node 24 and modern browsers. The distributed license texts for those and all linked dependencies are in `vendor/PASSKEY-LICENSES.txt`. Users do not install npm packages or contact a CDN to use the feature.
