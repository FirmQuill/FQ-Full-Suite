# Signed add-on installer, interface v1

This is the host installer and its fictional test fixtures. It does not include
or modify a paid AI runtime, Knowledge Base package, or Payroll package.

## Admission and owner flow

Provision the installation's existing entitlement verifier and protected
activation directory once. Set `FIRMQUILL_ADDON_PUBLISHER_PUBLIC_KEY` to the
trusted Ed25519 public PEM, or reuse the already configured
`FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY`. Keep verifiers and activation state
outside the application and package folder. Private signing keys belong only
to the issuer. No feature ID needs registration in the base application.

1. Drop an installation-bound signed `.fqaddon` into `packages` beside
   `host.mjs`. Existing `.fqpackage` handlers remain separate and unchanged.
2. Upload a matching signed `.fqlicense` in Version Upgrade.
3. In Packages, review the ID, revision, permissions and exact HTTPS origins,
   then explicitly Apply. A drop or license never activates a new package alone.
4. Declarative settings become available immediately. Initial service Apply
   approves its first start. A replacement or service-settings change is staged
   for separate owner restart approval.
5. Workspace writes default to individual review. A licensed
   `workspace.write.auto` capability makes an explicit owner-approved automatic
   write policy available. Package metadata alone cannot turn it on. A new
   runtime revision or approving owner resets it to review.

The host never overlays core files or imports package modules into the ERP
process. Accepted signed bytes are cached outside the application. Receipts
bind review to exact bytes, live grants and revision history. A lower revision
or conflicting bytes at the same high-water revision are rejected. Supervisor
rollback may restore only previously accepted exact bytes with a live grant.

### Administration pages and listeners

An installed, eligible package has an owner-only Administration page keyed by
package ID. Its optional signed `adminPage` field sets the display label (1–64
characters). Existing packages use their signed name. The page renders typed
settings, service controls, and per-package write approvals. Packages handles
installation, updates, restarts and removal. Removing an add-on drops its
approval, proposals and settings and preserves its signed revision high-water mark.

For a service with `adminPage`, `service.controls` and signed external routes,
the owner can save a distinct HTTPS origin and loopback socket. Start and Stop
affect this package's listening socket. Each host launch starts with the socket
closed. The operator's TLS proxy must preserve the public hostname. The existing
bounded HTTP forwarding, route permissions and AppContainer apply on that socket.
The host supplies the configured origin as `endpointOrigin` in owner controls.

### Delegated operations

Services with a signed `adminPage` use named operations for workspace access.
The owner selects a client, effective account, company and allowed actions.
`GET /api/addons/delegation?id=PACKAGE_ID` returns the available operations,
roles and current selection to the approving Corporate owner. For a broker read
the service sends `{clientId, operation, companyId, arguments}`. Writes also
carry the originating service's live authorization handle. The host constructs
the normal ERP request, uses the effective account's portal and returns the
operation's projected result. The host checks grants when proposing and again
when dispatching, including for automatic writes. The empty company scope
permits workspace status and first-company creation. Grant the new company's ID
before using project, task or journal operations.

An active composite license can authorize up to 16 package IDs. Include the
existing paid modules and all intended add-on grants when replacing it.

## Package format

A `.fqaddon` is UTF-8 JSON with exactly `signed` and `signature` fields. Both
are canonical unpadded base64url. `signed` contains the raw manifest bytes;
`signature` is an Ed25519 signature of those bytes.

The manifest has exactly these fields:

```json
{
  "format": "firmquill.addon.v1",
  "id": "a-new-feature",
  "name": "Publisher feature name",
  "revision": 1,
  "installationId": "64 lowercase hex characters",
  "compatibility": {"min": "0.6.5", "max": "0.6.5", "hostApi": 1},
  "type": "service",
  "permissions": ["settings", "service.runtime", "workspace.read", "workspace.write", "workspace.write.auto", "network.https"],
  "network": ["https://api.publisher-domain.com"],
  "settings": [{"key": "label", "label": "Label", "type": "string", "default": "", "maxLength": 80}],
  "files": {"service.mjs": {"sha256": "hash of decoded file bytes", "content": "base64url file bytes"}}
}
```

IDs are lowercase ASCII names, 3–64 characters. Compatibility uses inclusive
three-part versions and the fixed host API version. Settings support bounded
strings, booleans and signed 32-bit integers. A `settings` package has an empty
file object, empty network list, and only the `settings` permission.

Services have a fixed `service.mjs` entry and may bundle flat `.mjs` and `.json`
dependencies. No executable, native add-on, shell script, installation script,
path traversal, Windows device name or case-colliding file is admitted. Publisher
tooling must bundle SDK dependencies before signing. The host does not run npm
or download dependencies. Limits are 32 files, 1 MiB decoded content and a 2 MiB
envelope; each file hash is checked independently of the envelope signature.

## Signed license grants

Existing `firmquill.activation.v1` licenses can add an `addons` array. Add-on-only
licenses use `modules: []`. They require the usual edition/installation binding,
`licenseId`, `issuedAt` and `expiresAt` and may grant up to 16 package IDs:

```json
{"id":"a-new-feature","minRevision":1,"maxRevision":3,"permissions":["settings","service.runtime","workspace.read","workspace.write","workspace.write.auto","network.https"]}
```

The package's permissions must be a subset of its active grant. Grants are
checked before admission, every broker operation and every owner action.
Older, undated or same-issued conflicting add-on license replacements are
rejected at both upload and legacy activation entry points. No legacy module
replacement policy was broadened for this work.

## Node service interface

The Windows supervisor must verify an AppContainer token, zero network
capabilities, child-process restrictions, a one-process kill-on-close job and
denied access to the ERP core/database before resuming Node. The trusted
supervisor, copied Node executable and fixed runner are hash-checked. The
runtime also uses Node permissions, a minimal environment and bounded pipes.
Node permissions are defense in depth; they are not the isolation boundary.
No ordinary-process fallback exists. Unsupported platforms fail closed.

The fixed Node policy uses a standard zero-capability AppContainer, a private
low-integrity desktop on the current window station, a metadata-only inherited
station handle, and detached execution with redirected pipes. The current
station's ACL is verified unchanged. Named window-station creation is not used:
[Windows reserves a specified station name for Administrators](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowstationw).
Node's preserve-symlinks loader flags avoid ancestor-directory metadata probes;
the trusted host first verifies every admitted path is canonical and link-free.
These flags do not grant additional file access. LPAC is not a retry/fallback
policy; this Node build's LPAC Winsock initialization did not pass acceptance.

```js
export async function activate(context) {
  // context.apiVersion === 1
  // context.settings: signed-schema, owner-entered settings
  // context.dataDirectory: private storage isolated by revision/settings
  return {
    async health() { return true; },
    async handle(input) {
      return context.request('workspace.read', {path: '/api/session'});
    }
  };
}
```

The context broker supports `https`, `workspace.read` and `workspace.write`.
Bundled AI SDKs can use a broker-backed HTTP adapter. HTTPS destinations must
match the reviewed signed origins; public DNS is pinned per request, private
addresses and redirects are denied, and requests/responses are bounded.
Mutating provider requests and workspace writes require a fully admitted
instance. Streaming provider transport and native/Python executables are not
part of this Node v1 interface.

Workspace requests use the ERP's existing business API authorization and
transactions. They can read books and accounts, post ledger actions, create
employees and use the other registered workspace routes. The host checks the
approving owner's current account, auth version and Terms on each dispatch.
Host sessions and CSRF values stay in the parent. Host authentication,
licensing, installer and credential-provisioning endpoints are excluded.

Writes are immutable proposals tied to the originating runtime digest. Review
mode requires exact-digest owner confirmation. Automatic mode dispatches them
under the separately approved policy. An execution intent is persisted before
dispatch, so an interrupted write is never silently replayed. Reads, write
attempts/outcomes and owner installer approvals appear in the ordinary audit
trail with add-on identity, delegated owner, route and correlation ID; request
bodies, credentials and response content are not copied into audit metadata.

Service replacement stops the old instance before starting the candidate.
Private data is separated by signed revision/settings; bounded data migration
copies the stopped instance's data. Failed start/health/persistence restores the
accepted instance where its live grant and Windows supervisor permit it. The
books remain owned by the ERP process throughout.

## Verification status

Run the required positive Windows gates on a disposable install:

```powershell
$env:FIRMQUILL_NATIVE_TEST = '1'
node --test tests/addon-windows-supervisor.test.mjs
node --test tests/addon-service-host.test.mjs
node --test tests/addon-service-lifecycle.test.mjs
```

The original Win32 5 was a launcher API choice, not a requirement to run the ERP
as Administrator. A controlled launch matrix also identified `CREATE_NO_WINDOW`
as the cause of `0xC0000142`; detached execution starts this Node build under
the verified AppContainer. Actual guest startup and cleanup passed on Windows
build 10.0.26300.0, Node 24.22.3, session 1, with an interactive standard-user
token. The compiler is the installed .NET Framework 4.x x64 `csc.exe`; state and
runtime folders must support verified private NTFS ACLs. The ERP remains under
its ordinary account.

The source/model tests are not substitutes for the positive signed lifecycle
gate. That gate requires actual v1 execution, settings/private-data persistence
across a sequential host restart, a signed unhealthy v2, and recovery of v1
without changing an unrelated fictional ledger entry. Its JSON proof records
the exact package hashes and each completed stage. This gate passed on the
standard-user test host with a real signed fictional Node service, without a
mock supervisor. Cached v1 also survived another restart after the drop files
were removed. Feature-level behavior and
automation rules belong to the feature package and its owner settings. The
delegated operation catalog in `addon-delegation.mjs` defines the host grants.
