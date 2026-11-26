# Diagnose setup failures and retry safely

Article: setup-failures · Installed version: 0.3.0-preview.1 · Scope: public initial setup only.

## Package validation errors

Integrity mismatch: retain the failed private file and request a fresh approved package; do not edit its manifest to match corrupt bytes. Unsupported schema/version: use the matching application release or ask the preparer to regenerate the package. Unsafe filename, oversize data or unknown sections: ask the preparer for a compliant data-only package. Missing reference: correct source mapping and package preparation. Reconciliation mismatch: compare accepted counts and balances with the approved staging report before retrying. The destination remains available after a failed attempt.

## Destination and startup errors

Destination already exists or workspace initialized: use the existing workspace; packages never overwrite it. For a new company setup, choose a separate fresh database path. Permission denied: the host administrator checks the service identity and protected local directory. Busy database or port in use: stop the other host and retry; do not delete WAL files to clear a lock. Origin mismatch: use the exact configured portal hostname and have the operator check reverse-proxy headers. Owner login unavailable: check the correct books portal and existing owner credentials.

## Escalation

If retry remains blocked, stop repeated attempts and contact your designated company owner or FirmQuill support contact. Supply installed version 0.3.0-preview.1, relevant setup article ID, exact error, stage reached and redacted reproduction steps. Do not send passwords, bearer tokens, cookies, raw customer exports, employee evidence or paystubs. Production accounting, payroll, provider and feature questions are outside the default setup assistant; consult the separately delivered private manual and authorized support process.
