# Create the first administrator and sign in

Article: first-admin · Installed version: 0.5.0-preview.1 · Scope: public initial setup only. Verified against host.mjs and server.mjs.

## Prerequisites

Run the host in an interactive terminal with its protected data directory configured. A fresh installation has no preset username, password or company. A company package carries data, not executable setup instructions or a replacement owner password.

## Create the first owner

Run `node host.mjs configure` for the illustrated wizard and open its one-time private loopback URL. Choose empty setup or preview the private package first, then enter owner username, display name, private password of at least 12 characters and matching confirmation. Review the selected scope and initialize. After success, stop the configuration host with Ctrl+C and start the normal host with `node host.mjs start`. Keep the one-time URL private.

Alternatively run `node host.mjs start` and follow the interactive terminal prompts; hidden password entry is intentional. `node host.mjs init` creates the owner without serving, then `node host.mjs serve` launches it. Init refuses to replace an existing owner. A noninteractive terminal cannot supply owner prompts.

## Sign in and verify

Open the books URL printed by the host, enter the owner username and password, and sign in. Use the books portal for this owner account. The worker portal accepts separate worker identities. A new empty installation offers initial company setup. If a reviewed package was selected during launch, verify its company and handoff totals before entering new work. Sign out after the check. On restart, sign in again with the same owner account.

## Common errors and escalation

Passwords differ: rerun the prompt and enter the same private password twice. Password too short: choose a longer password. An owner is already configured: use the original owner login and existing workspace; do not try to overwrite it. Cannot sign in: confirm the correct books URL, username and running host. Repeated failures trigger a temporary throttle. Ask the designated host administrator for account recovery; the public support assistant cannot read accounts or recover passwords.
