# Encrypted local vault

Use a password of at least 12 characters and store it somewhere you can recover. Every company in one vault shares the owner's password. Losing both the password and access to an unlocked session prevents recovery. Clearing site data or moving to a different browser, profile, origin, port or project path can make the local vault unavailable. Keep a downloaded encrypted backup outside the browser.

## Backup and recovery

Finish saving before downloading a backup. The backup contains the last successful save in the current tab. If another tab has made changes, lock and reopen the vault before downloading. Backups contain all companies, including sensitive fields, inside one authenticated ciphertext.

An empty destination can import the encrypted backup with its original password. Recovery authenticates the file, checks the app's record format and saves it as a fresh vault revision. Wrong passwords, changed ciphertext and unsupported formats fail before the write. Reopen the restored vault and compare company names, record counts and accounting totals with the source.

The module also supports deliberate replacement of an occupied destination when the caller supplies the unlocked, current destination session. Make a separate backup of that destination first. Replacement uses its existing password and invalidates older sessions. Callers can omit this operation from the interface and restrict recovery to an empty destination.

## Format and boundaries

The database name begins with `erp-lite:v1:` and includes the app directory. One IndexedDB object store named `sealed` contains one key named `current`. Its value and a downloaded backup have the same envelope format. Plaintext company names, payroll details, document numbers, passwords and keys are absent from the envelope. Header fields disclose the format, version, iteration count, random salt, revision token and nonce. Ciphertext length can reveal the approximate size of the books.

Version 1 derives a nonextractable AES-256 key using PBKDF2-HMAC-SHA-256, a random 128-bit salt and 600,000 iterations. Each encryption uses a fresh random 96-bit IV and a 128-bit GCM authentication tag. Additional authenticated data binds the envelope type, version, work factor, salt and revision token. The payload is UTF-8 JSON with a 32 MiB limit before encryption. The app's record format has its own version and validator. [Web Cryptography API](https://www.w3.org/TR/webcrypto/) [OWASP PBKDF2 work factors](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2)

Each save encrypts a complete snapshot in memory. A read-write IndexedDB transaction compares the current revision token and writes the new envelope atomically. A stale writer receives an error and must unlock again to load the winning revision. A storage or quota failure leaves the previous committed revision available. Cross-tab edits are never merged. [Indexed Database API transactions](https://www.w3.org/TR/IndexedDB-3/#transactions)

The key and decrypted state exist in memory during an unlocked session. Locking drops the module's references. The interface must also clear its own references, forms and rendered data. JavaScript cannot guarantee immediate memory erasure. The vault is designed for protection at rest. A compromised device, extension or same-origin script with access to an unlocked session can read the books. Keep the app on an origin you control. A password reset service and backdoor key do not exist.

## Executed checks

On November 25, 2026, six test cases passed with Node 24.22.3 and a disposable headless Microsoft Edge profile on the Windows laptop. The browser case used real IndexedDB and Web Crypto under loopback HTTP. All records and passwords in these tests were synthetic.

| Check | Observed result |
|---|---|
| Create, update, lock and reopen | Weak password rejected. Reopened records matched the committed state. Locked access and a wrong password failed. A fresh IV and revision were used for the second save. |
| Backup authentication and schema | Changes to ciphertext, salt, IV and revision were rejected. Unsupported version, changed work factor, extra field, wrong password, failed validator and oversized input left the fresh destination empty. |
| Occupied destination | Recovery required a current unlocked destination session. Replacement retained the destination password and invalidated old tabs. |
| Competing edits | One of two concurrent writes won; a rejected schema change left its revision intact. |
| Interrupted save | An injected storage failure left the previous payload and backup intact; a subsequent retry succeeded. |
| Real browser | Two tabs shared the same scoped vault and rejected a stale write. Direct inspection returned only its encrypted envelope. A sibling app path had separate storage. A failed recovery wrote nothing. A valid recovery reopened with matching data. |

From the release folder, run `node --test tests/vault.test.mjs` for the five dependency-free tests. Set `ERP_LITE_BROWSER_EXE` to an installed Edge or Chromium executable to include the sixth check. It uses Playwright from the Node module search path or from the absolute package directory specified by `ERP_LITE_PLAYWRIGHT`. This test dependency is optional for running the ERP itself. The browser test opens only a temporary test profile and a loopback server.
