# Portable data format v1

A Lite backup is an authenticated encrypted envelope around UTF-8 JSON. The envelope format is `erp-lite-vault`, version 1. The plaintext root has `format: "fieldledger.erp"`, `schema: 1`, `edition: "Lite"`, `currency: "USD"`, a nonempty companies array and a groups array. The supported owner transfer is an encrypted whole-vault snapshot. See VAULT.md for cryptographic parameters, resource limits and conflict handling.

## Records and identities

Company, activity, source, entry, movement, attachment and group IDs are opaque UUID strings. Never use a display name, array position or document number as a cross-company key. Every financial reference resolves inside its owning company except explicit paired intercompany links and group membership. The history record for a document and that document share their activity ID. Journal entries and individual stock movements have their own IDs and carry a source activity ID. Company sequence numbers are display labels. A portable copy preserves existing IDs and sequence numbers.

| Collection | Stored relationships and units |
|---|---|
| companies | Independent ID, name, activities, featured modules, last sequence number and optional closed-through date |
| parties, items, jobs, employees | Stable IDs and local master records. Employee rates are USD cents per hour. |
| time | Employee and job IDs, ISO work date, integer minutes, rate snapshot, computed cost, approval flag and approval activity ID |
| docs | Company record number, type, date, contact, item, job, location, whole quantity, unit price and extended cents. Parent ID links each conversion, settlement or credit. applied and refund distinguish open balance from cash. |
| entries | Own ID, source activity, date, memo, cash-flow class, signed debit-positive cents per account, optional reversal or intercompany links. Every journal sums to zero. |
| moves | Item, location, source, date, signed whole units and signed carrying value in cents |
| assets | Acquisition activity ID, residual, cost, life in months and posted charge records |
| bank, reconciliations | Account-local original statement fields and deterministic source reference, matched journal ID, reconciled row IDs and balance controls |
| history | Source IDs, creation-order sequence, operation kind, date, description and operation-specific details. UI writes include a request ID; reversals and returns append linked records. |
| attachments | Stable ID, owner source ID, filename and base64-encoded bytes inside the encrypted vault. Per-file UI limit is 1 MB. |
| groups | Name, stable group ID and selected company IDs. Linked source postings remain in each company's books. Eliminations have deterministic IDs derived from original entry IDs and are reconstructed for the selected scope and cutoff. |

All financial amounts use JSON safe integers representing cents. Parsing dollars, multiplying quantities and prorating costs use integer arithmetic with range checks. A negative journal line is a credit. Monetary totals that exceed the exact integer range cause an error. Dates use ISO YYYY-MM-DD without time-zone conversion. USD and whole inventory units are the supported monetary and stock units.

## Rules and transfer boundaries

`core.mjs` accepts a complete state and an action, applies it to a detached working copy and returns the new state. A failure leaves the input intact. The UI validates the change and commits it through the vault adapter. Reporting and group consolidation read the posted records without writing into company books. Payroll and CSV adapters have no storage dependency.

On recovery the app authenticates the envelope, validates schema, links, monetary amounts, ledger balance and agreement with the inventory and AR/AP subledgers before committing. Unknown top-level format/schema combinations are rejected. This format has no implicit field conversion or live-book merge. Restoring an occupied vault replaces all its companies with owner confirmation. The vault protects data at rest. Its activity log is an application history, without independent tamper-evident attestation.

Full Suite migration and Full-only identity, roles, sessions and approval entities have no implemented mapping in this preview. A future authorized migration will need to validate attachment bytes, paired links and per-company report totals in both directions and explicitly inventory nonportable access data. The owner selected this preview as the Full Suite development baseline.

