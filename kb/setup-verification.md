# Verify initial setup and handoff

Article: setup-verification · Installed version: 0.6.0-preview.1 · Scope: public initial setup only. Detailed feature instructions belong to the separately delivered private customer manual.

## Verify the result

Sign in to the books portal and confirm the intended company name. For an empty company, verify that no demonstration records were inserted. For a package, compare the displayed company and imported scope with its manifest, reconciliation and handoff guide. Check source namespaces, accepted and skipped counts, rejected rows, applicable amounts and unresolved exceptions. A balanced technical import is not evidence that unsupported source fields were migrated.

## Confirm persistence

Sign out, stop the host with Ctrl+C, restart using the same database path and sign in again. Confirm the same company and expected records remain and the package is not imported a second time. Keep the original private package and source exports in separate protected locations. Keep customer-specific files out of source control, public downloads and the program directory.

## Handoff and support

Record the installed version, approved migrated scope, exceptions and owner of every unresolved item. Follow the customer-specific getting-started guide for the first workflow. Your designated company owner or support contact supplies the separate private manual. The built-in default support search contains setup guidance only, retrieves exact installed-version articles locally and has no company-data access. If it lacks an answer, escalate with the article ID, installed version, exact error and redacted reproduction steps. No support destination or credentials are invented by this software.
