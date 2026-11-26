# FirmQuill transfers and database recovery

Choose a **portable snapshot** to move books between editions. Choose a **Full Suite recovery archive** to recover the entire company installation, including its users, permissions and worker records.

| File | Includes | Who can create or restore it |
|---|---|---|
| `.firmquill` portable snapshot, including supported older `.fieldledger` backups | All companies in the vault, settings, stable record IDs, documents, entries, balances, approved time, business history, bank matches, assets, inventory, attachments and consolidation groups | Lite vault owner or signed-in Full Suite owner |
| `.fqdb` database recovery archive | The entire shared SQLite database, including password hashes, company assignments, audit, pending approvals, request IDs, original punches and correction history | Operator with local database access and a private recovery password |

## Choose an onboarding path

- Use **Portable transfers → Preview Lite backup** in an empty Full Suite database for a compatible encrypted FirmQuill books snapshot. Preview company counts and balances, then confirm the import. This does not merge into existing books or copy worker portal history, paystubs, reviews, benefit elections, or login credentials.
- Use **whole-database recovery** below when moving a company from one compatible Full Suite host to another. It restores the installation, including Full Suite-only records and logins, into a fresh database path. It is not a file upload into a live company.
- The QuickBooks Online US and Wave US exchange here is for supported checking-statement CSVs. It is not a full company-file converter. For other apps, have the source owner export the required records, determine field and account mappings on a test copy, and reconcile balances and open items before using migrated books.

## Move Lite books into Full Suite

1. Open the source vault in Lite and download an encrypted backup under **Company setup**. Keep its password and a separate copy of the original backup. For the supplied January 2026 sample, record each company's cash, open receivables, inventory, net income and trial balance before transfer.
2. Set up a fresh Full Suite database and create the initial owner login. Leave the company list empty. Even a configured company with zero transactions makes that destination ineligible. The preview never merges or overwrites existing books.
3. Sign in to the main Full Suite application as the owner. Select the Lite transfer, choose the encrypted file and enter its password. Use loopback on the host or company-controlled HTTPS. The Full Suite server receives the encrypted envelope and its password during this operation so it can authenticate the backup and validate the incoming state.
4. Inspect the preview by company. Compare the IDs, documents, employees, journals, attachments, attachment bytes, history length and displayed control balances. The January sample starts with cash of $15,420.00 in Northline Studio and $9,948.00 in Alder Supply. Both trial balance differences are zero.
5. Confirm the reviewed import. The encrypted file digest binds the confirmation to that file. The server checks the destination revision and emptiness before it commits the complete import. A stale preview requires another review.
6. Reopen both companies and check the January reports. Select their reporting group and verify $4,918.00 consolidated net income in the initial sample. Open a source document and its attachment. Assign each Full Suite user to the intended companies and link workers to their employee records.

All books transfer as one unit, so cross-company pair IDs and consolidation membership travel together. The transfer retains timestamps, integer cents and attachment bytes. The shared Lite validator checks the core records, stock and AR/AP control accounts. The transfer also checks intercompany partners and canonical attachment encoding. Its state limit is the Lite vault's 32 MiB of UTF-8 JSON, including base64 attachments.

## Open a Full Suite snapshot in Lite

1. In the main application, sign in as the owner and use the encrypted Lite snapshot export. Choose a new password of at least 12 characters. The transfer uses the delivered Lite vault implementation.
2. Open Lite in a fresh browser profile, choose **Restore backup**, select the downloaded file and enter its password. For an occupied Lite vault, save its current backup first and use Lite's explicit owner replacement workflow.
3. Reconcile company count, document and attachment counts, company reports, approved time and consolidation totals against the Full Suite source. The restored books are an independent copy. Edits in one copy do not propagate to the other.

Portable snapshots include the business effect of approved activity in the shared books. Full Suite logins, passwords, assigned roles, access mappings, approval queues, request deduplication records, host audit events, raw worker punches and correction metadata live in separate Full Suite tables. Use a Full Suite recovery archive to retain those records. Both editions continue to block final payroll output under the preview release gate.

## Back up the company-hosted database

Use the same Node.js installation as the application. The recovery utility requires Node 24.16 or newer in the 24.x line and was tested with Node 24.22.3 on Windows. Choose a local filesystem supporting hard links, such as NTFS. The destination directory must already exist. The dedicated archive extension is `.fqdb`.

From the Full Suite package directory, substitute the actual database path and a fresh backup filename. The command prompts for a recovery password twice and suppresses terminal echo.

```powershell
node recovery.mjs backup 'D:\FirmQuillData\company.sqlite' 'E:\FirmQuillBackups\company-2026-11-25.fqdb'
```

The operator can stop the application first for an offline backup. With the application running, a single SQLite read transaction captures a consistent committed database image, including committed write-ahead-log pages. A change committed after the read snapshot begins belongs to the next backup. The utility checks the FirmQuill application marker, version, required tables, foreign keys and SQLite integrity before archiving. It serializes the database in memory, encrypts it with AES-256-GCM using a fresh salt, IV and a scrypt-derived key, flushes the ciphertext and publishes a new file without overwriting any existing archive. [Node SQLite serialization](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html)

Back up the whole database before updating the suite and retain the matching package and host configuration. Store the encrypted archive and recoverable password separately. Test a restore periodically. This utility currently supports a **64 MiB SQLite image**. It holds the image in memory and uses about 128 MiB of working memory for scrypt in addition to the database buffers. Free space for the complete restored database is required. A larger database needs a separately validated recovery procedure.

## Recover into a new database

1. Use a host-controlled encrypted volume and an operator-only recovery directory. SQLite data and its ordinary WAL/SHM files contain readable records on disk. Apply OS folder permissions for the service identity and backup operator. The recovery password protects the archive.
2. Stop the target application. Choose a new filename ending in `.sqlite` or `.db`. Keep the original database and sidecars together. An existing target or an existing sidecar for the selected name causes the command to stop.
3. Run the restore and supply the archive password at the hidden prompt.

```powershell
node recovery.mjs restore 'E:\FirmQuillBackups\company-2026-11-25.fqdb' 'D:\FirmQuillRecovery\restored.sqlite'
```

4. The utility authenticates the full archive before writing decrypted bytes. It verifies the restored image in a temporary file inside the destination directory, then publishes the complete database under the fresh name. If the host suffers an abrupt power failure, a `.firmquill-*.partial` file may remain in that protected directory.
5. Point a separate local instance at the restored database. Sign in with an existing owner account and compare the books, staff assignments, pending approvals, original punches and correction history. A restarted service has fresh browser sessions. After verifying the recovery point, use the recovered database path when starting the company service.

## Executed checks

Run `node --test tests/transfer.test.mjs` from the package root. Four synthetic tests passed. They exercised the actual Lite vault format in both directions, compared all records including binary attachment bytes and consolidation output, and rejected tampering, wrong passwords, foreign links, unexpected data sections and occupied destinations. Database recovery used the Full Suite schema and a populated WAL. It restored all seven business, identity, approval and worker tables row-for-row, verified the restored credential hash, excluded an in-flight uncommitted write and rejected attempts to overwrite the active database.
