# Bank statement interchange

**Lite 0.1.0-preview.2** supports a single USD checking-account statement per file. The two profiles implement a shared three-column CSV with product-specific dates. Local synthetic tests and the vendor documentation establish the format. Acceptance by a signed-in Wave or QuickBooks tenant remains untested.

| Profile | Input into Lite | Output from Lite | Date | Amount |
|---|---|---|---|---|
| Wave Accounting, US | Checking statement prepared in Wave's three-column upload layout | CSV for the Wave statement upload and column-mapping screen | YYYY-MM-DD | Signed decimal dollars. Deposits positive, withdrawals negative. |
| QuickBooks Online, US | Checking statement prepared in the Intuit three-column manual bank-upload layout | CSV for QuickBooks Online's bank transaction upload and mapping screen | DD/MM/YYYY | Same sign convention. Check the selected date layout and signs in the QuickBooks preview. |

A CSV downloaded from either product must already match the selected profile or be deliberately mapped to it by the owner. A vendor's upload layout does not establish the format of its own export reports. Lite's profiles do not read Wave's full accounting ZIP, QuickBooks Desktop company backups, IIF, QBO/OFX, PDFs or Excel files. Invoices, purchase bills, customer/vendor IDs, chart mappings, attachments, historical tax detail and payroll records require other transfer workflows. Live sync and complete product migration have no verified coverage in this build. [Wave's accounting export](https://support.waveapps.com/hc/en-us/articles/4411360860692-Download-your-account-data)

## Input contract

Use UTF-8, commas and the exact header `Date,Description,Amount`. Each transaction occupies one line. Two consecutive quote marks encode one literal quote in a quoted field. An optional initial BOM and LF or CRLF line endings are supported. Use signed decimal dollars with at most two decimal places. Keep consistent dates, English descriptions with at least one letter, and one currency per file. Blank transaction lines, control characters, formula prefixes, zero movements and unknown columns produce an error. A failed preview returns no rows.

The Wave workbook limits dates to 2000-01-01 through today and individual amounts to one billion dollars in magnitude. The Lite adapter caps Wave files at 2,000,000 bytes and 10,000 transactions. QuickBooks files are capped at 350,000 bytes and 999 transactions plus the header. The profile follows Intuit's recommended DD/MM/YYYY ordering even in the U.S. Choose English descriptions and review any embedded digits on the QuickBooks mapping screen. Lite preserves descriptions verbatim, including references already present in their text. [Wave CSV template and instructions](https://support.waveapps.com/hc/en-us/articles/208621626-Upload-a-bank-or-credit-card-statement-in-csv-format) · [Wave CSV troubleshooting](https://support.waveapps.com/hc/en-us/articles/208622596-What-to-do-if-Wave-can-t-read-your-statement-in-CSV-format) · [Intuit US bank upload requirements](https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_US_en_US)

## Review, references and totals

1. Select the destination company and checking account. Use a complete statement with known opening and closing balances.
2. Preview the file. Check the date, description and sign of each movement. The adapter returns all rows, new rows, matching rows, total deposits, total withdrawals and net movement.
3. Compare the statement opening balance plus the **entire file** net to the statement closing balance. A matching figure validates the statement arithmetic. Separately match the bank movements to the company's cash journals, accounting for outstanding items and opening-balance differences.
4. Confirm the import after reviewing matching rows. Persist only new rows in the selected company/account. Keep the generated reference with each original movement to recognize it on replay. A formatted export is readable plaintext and belongs with the owner's protected files.
5. When importing into Wave or QuickBooks, choose the correct USD checking account and check the receiving product's preview and dates. Compare statement totals again after import. The receiving product handles categorization and posting.

The three-column format has no bank-assigned ID column. Lite's deterministic source reference encodes the normalized date, exact description, signed cents and occurrence number within that date/description/amount group. Identical rows in the same file retain their multiplicity. Repeat imports and reordered rows match previous refs within the same account. Two different identical transactions split between separate files are ambiguous. Use a single authoritative statement covering those movements and review the match count. Changing the description changes the reference. Never use the derived reference to infer a cross-company match.

## Evidence

- Inspected Wave's official spreadsheet, its **3-Column Upload Format** sheet, cell order, date window and amount rules. The downloaded template's SHA-256 was `30B9BAB1EFC88D7D535A8CC3C618CEF88A000D5481308E7D6F6284A05762F127`. The XLSX is an evidence source for the layout. Customers exchange CSV. [Wave-published template](https://d1hzvs60s6jsjg.cloudfront.net/downloads/Wave-Transaction-Import-Template.xlsx)
- Checked Intuit's three-column specification and its signed example of a $100 payment and $200 deposit, adapted to a zero-padded date. The test produces a net $100 increase. [Intuit formatting example](https://quickbooks.intuit.com/learn-support/en-global/help-article/bank-transactions/format-csv-files-excel-bank-transactions-quickbooks/L4BjLWckq_ROW_en) · [Intuit US file requirements](https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/manually-upload-transactions-quickbooks-online/L0rE9OXBz_US_en_US)
- Seven automated adapter tests exercised quoting, references, validity, replay, profiles, bounds, independent opening and closing balances, integer cents and overflow. Run `node --test tests/interop.test.mjs` in the extracted package directory.
- Full-product acceptance remains open. It needs native source export fixtures for each claimed record type, agreed date/field maps, an actual upload/download with a synthetic company in each vendor product and reconciliation to that company's original balances. The released evidence covers the bank-statement adapters only.

