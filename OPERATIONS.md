# FirmQuill Full Suite operations

## Install and configure

Use one company-controlled host with Node 24.22.3, local disk and an operating-system identity dedicated to the application. Keep the program, data and encrypted backup directories separate. Give the service account read access to program files and read/write access to its data directory. Limit access to the data directory to the service identity and designated administrators. The SQLite file, WAL and rollback files can contain readable business and worker records. Protect their volume and recovery staging directories with OS disk encryption and filesystem permissions. The application encrypts portable files and recovery archives. It does not configure the host’s disk protection.

Extract the program. Set FIRMQUILL_DB to an absolute local SQLite file path. Run `node host.mjs init` interactively as the service identity to create the first owner. The command refuses to replace an initialized owner. To start an initialized installation use `node host.mjs serve`. The Windows launcher combines first-time setup and start. An operator may use the company’s service manager to run the serve command at startup, with the same working directory, Node path, environment and filesystem identity. Use a single host process for the pair of portals. Store the database on a local filesystem that supports locking and recovery hard links. SQLite WAL relies on same-host shared memory. [SQLite write-ahead logging](https://sqlite.org/wal.html)

| Variable | Default | Purpose |
|---|---|---|
| FIRMQUILL_DB | ../FirmQuill-data/books.sqlite relative to program | Database path for both portals |
| FIRMQUILL_MAIN_PORT | 4179 | Books loopback listener |
| FIRMQUILL_WORKER_PORT | 4180 | Worker loopback listener |
| FIRMQUILL_MAIN_ORIGIN | Local books address | Exact public HTTPS origin for books when self-hosted |
| FIRMQUILL_WORKER_ORIGIN | Local worker address | Distinct public HTTPS origin for workers when self-hosted |
| FIRMQUILL_TIMEZONE | America/Denver | IANA time zone used when a shift begins; recorded with the shift |

For a company network installation, supply both distinct HTTPS origins and put the company’s TLS reverse proxy on the same machine as the application. Configure name resolution and certificates under the company’s control. Send books traffic to the main loopback port and worker traffic to the worker loopback port. Preserve the public Host header and browser Origin header. Browser requests must use the configured scheme and hostname. Serve each portal at the root of its own origin. Disable caching and request-body or cookie logging on these routes. For migration, allow up to 48 MiB JSON requests. No TLS proxy was provisioned or tested against a live network in this handoff.

Example routing for an operator using Caddy, after substituting company-controlled names and configuring trusted certificates. [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

```caddyfile
books.example.com {
    reverse_proxy 127.0.0.1:4179
}
time.example.com {
    reverse_proxy 127.0.0.1:4180
}
```

Use FIRMQUILL_MAIN_ORIGIN=https://books.example.com and FIRMQUILL_WORKER_ORIGIN=https://time.example.com for that example. Port numbers may be included for HTTPS on a nondefault port. Each portal uses its own HttpOnly session cookie, strict same-site policy and server-side authorization. Public HTTPS origins enable Secure cookies. Authenticated writes require an exact origin and a CSRF token. Role or assignment changes revoke previous sessions. Sessions are in memory and expire after 30 minutes without an authenticated request or 12 hours absolute. The books UI also signs out after five minutes without interaction.

## Back up and test recovery

1. Use `node recovery.mjs backup "D:/FirmQuill-data/books.sqlite" "D:/FirmQuill-backups/office-2026-11-25.fqdb"` with the actual paths. Choose a new archive name. Enter and confirm the recovery password privately at the terminal. This creates an authenticated, encrypted snapshot of a consistent committed SQLite view including WAL transactions.
2. Keep the password and a copy of the archive recoverable on separate protected media. Monitor backup success and periodically rehearse restoration. Current recovery tooling accepts a database image up to 64 MiB. Portable books are capped at 32 MiB. Monitor the database as audit and clock records grow.
3. Restore to a **new** path on a protected volume using `node recovery.mjs restore "D:/FirmQuill-backups/office-2026-11-25.fqdb" "D:/FirmQuill-recovery/rehearsal.sqlite"`. The destination directory must exist. Recovery checks authentication, schema marker, database integrity and foreign keys, and refuses an existing database or sidecar.
4. Start an isolated instance pointed at the restored database, using different loopback ports and no public routing. Sign in with an account from the backup. Compare company IDs, contact and journal counts, control totals, approvals, recent shifts and audit history. Restoring includes the credential hashes, role assignments and pending reviews as of the snapshot.
5. For actual cutover, stop the active host, retain the original files, point FIRMQUILL_DB to the verified restored copy, then start one host. Have staff sign in again. Keep distinct backup names and record the snapshot time so later changes can be identified.

The Full database backup can be made while the application is running. Transferring only a live SQLite file can omit committed rows in its WAL. The portable Lite snapshot intentionally omits logins and pending Full workflow records. Use the whole database backup for host recovery.

## Update and roll back

Save and verify an encrypted whole-database backup first. Extract the new version beside the current program. Read its release notes and compare its archive checksum before using the data. Rehearse the update against a restored copy on alternate ports. Verify owner and worker login, approved time, a company report and encrypted export. For cutover, stop the old host and start the new program with the verified database path and original portal settings. Keep the previous program and pre-update archive. This preview accepts schema version 1 and refuses an unknown version. An upgrade that changes schema needs a version-specific migration before cutover. To roll back, restore the pre-update archive to a fresh path and start the retained previous release against it. Newer work after the backup must be reconciled separately.

## Troubleshooting

- **Cannot sign in**. Use the portal corresponding to the account role. A disabled account or expired session requires an owner to restore access or a fresh sign-in. Ten unsuccessful attempts on a username trigger a five-minute throttle. The host also throttles bursts from one client address. Behind a single proxy, clients share the proxy address for that limit.
- **Company list is empty**. An owner can assign the account to companies in User access. Worker accounts need an actual employee link. A new owner workspace can accept an encrypted Lite import.
- **Workspace changed**. Refresh the app and check the posted record or approval queue before retrying. Concurrent writes use a workspace-wide revision. Two edits to different companies may still require a refresh.
- **Origin mismatch or absent session on HTTPS**. Verify the configured origins and proxy route for each portal. Use the matching public hostname and keep the hostname stable.
- **Local port in use**. Choose a free port and update its corresponding proxy target. Keep both portal ports distinct.

