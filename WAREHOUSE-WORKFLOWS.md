# FirmQuill Full Suite warehouse tools

In **Assets & pallets**, allocate existing ledger stock to a tracked unit. These tools run on the company’s own Full Suite host:

- **Print label** shows a human-readable tracking ID, unit name, stock location and current shelf/bin. Print from the dialog on your operating system’s configured printer. This label does not encode a barcode; an existing keyboard-style scanner can still enter compatible IDs.
- **Set bin** assigns a shelf within the unit’s ledger location without posting stock. A location move clears the current shelf until it is assigned again, even if the unit comes back.
- **Record lot / serial** annotates packed products. Serial rows represent one item and cannot be active twice for that product in the same company. Use **Release trace** with a reason after confirming the identified product is no longer packed; the record stays in history. Expiry is a review indicator, not an automatic stock removal, and the trace list flags discrepancies after unpacking or counts. A trace is not a regulatory recall certificate or a substitute for verifying physical inventory.
- **Set reorder rule** uses current stock in a named ledger location. At or below the threshold, the suggestion is the difference to the target. Zero threshold and target disables the rule. Suggestions do not create commitments or send orders.

Regular sales, movements and approved counts remain the only stock-changing workflows. Metadata travels inside the same encrypted vault backup and compatible portable transfers. Test workflows with sample inventory before using operational data.

## Shared workflows

- **Draft pick** from a packed unit, then an account with asset approval rights can approve or reject the list. An account with asset management rights can confirm or cancel it. Open allocations on the same pallet version cannot exceed packed quantities, and a changed pallet needs a new list. A picked confirmation records operational intent; it does not unpack, transfer, or ship stock. Use the existing asset and ledger actions separately for the real movement.
- **Schedule count** from Assets & pallets selects one or more active units and an account already granted audit access. The assignee can start it on or after its date in the audit portal. Starting captures the current expected contents; the existing observe/submit/review workflow handles discrepancies. Asset approvers can see started sessions and review them. An unaffiliated auditor cannot see or start another auditor’s assignment. Dates use the Full Suite host’s UTC calendar; there is no outbound reminder.
- Full Suite database backups retain the new shared records. Lite portable exports retain compatible bin, trace and reorder metadata with site account IDs removed. Pick lists and auditor assignments remain in Full Suite; the export reports this boundary.

This is a source workflow reference, not a replacement for the downloadable setup guide.
