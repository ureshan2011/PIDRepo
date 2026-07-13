# PID Outlook Collector

The standalone, **per-user Windows companion process** for PID's Outlook integration,
implementing the full design in [`../docs/15-outlook-collector.md`](../docs/15-outlook-collector.md).
It detects which Outlook flavor(s) are installed, classifies each configured account,
picks the right "tap" (with fallbacks), runs bounded backfill plus unattended
incremental sync, de-duplicates the same physical message seen via multiple taps,
expands calendar recurrence uniformly, and writes a WAL-mode SQLite **staging
database** that the main PID app reads read-only.

> **Windows-only at runtime.** The collector needs the Windows registry, Redemption /
> Extended MAPI (COM via `winax`), DPAPI, and the Windows Account Manager broker. It
> **builds and type-checks on any OS** (the native modules are lazy-loaded optional
> dependencies behind ambient type stubs), but it only *runs* on Windows.

This is a **separate package** from the main app: its own `package.json` /
`tsconfig.json`, its own `node_modules`. Installing or building the main app does not
touch it, and vice versa (the main `tsconfig.json` excludes `collector/`).

---

## What it is (architecture in one paragraph)

Outlook is not one integration — it is `(Outlook flavor) × (account type)`. The
collector owns that whole matrix: **Graph** is the strategic-primary tap for every
Microsoft-hosted account (pure HTTPS to `graph.microsoft.com`); **IMAP** (+ **CalDAV**)
taps non-Microsoft accounts *directly at their own provider* (Gmail is spoken to Google
over IMAP/CalDAV, never laundered through Microsoft); and **COM/Redemption** is a
local, no-network fallback used only for a specific, detectable condition (tenant
admin-consent wall `AADSTS90094`, POP's structural requirement, or on-prem
reachability failure). See docs/15 §3–§5 for the full decision algorithm.

## Prerequisites

- **Node.js ≥ 20** (uses global `fetch`).
- **pnpm** (repo uses pnpm 9).
- For the **COM/Redemption tap** only (optional — Graph/IMAP/CalDAV need none of this):
  - **Classic Outlook** installed with a loaded MAPI profile (New Outlook has no MAPI
    store — nothing for Redemption to log into).
  - **Redemption** (Dimastr RDO/Extended MAPI library) registered once per machine
    (`regsvr32 Redemption64.dll` for 64-bit Outlook). This is the only install step
    that may need admin rights, and only once — runtime store logon needs no elevation.
    See [`../docs/12-deployment.md`](../docs/12-deployment.md) "Installing the Outlook
    Collector".
- An **OAuth app registration** for the Graph and (for Gmail) Google flows — supply the
  public client ids via env (see below). These are native/loopback PKCE public clients,
  not confidential secrets.

## Build & run

```powershell
cd collector
pnpm install            # native optionalDependencies (winax, win-dpapi) are skipped on
                        # non-Windows and may warn — that is expected and fine.
pnpm build              # tsc -> dist/
pnpm start              # node dist/index.js   (foreground; normally the Task runs it)
# or, without a build step:
pnpm dev                # tsx src/index.ts
```

Environment (all optional; sensible defaults):

| Var | Purpose |
|---|---|
| `PID_GRAPH_CLIENT_ID` | Azure AD app (multi-tenant + consumers) client id for Graph |
| `PID_GRAPH_AUTHORITY` | default `https://login.microsoftonline.com` |
| `PID_GOOGLE_CLIENT_ID` / `PID_GOOGLE_CLIENT_SECRET` | Google OAuth native-app client (Gmail IMAP/CalDAV) |
| `PID_COLLECTOR_STAGING_DB` | override the staging DB path |
| `PID_COLLECTOR_HOME` / `LOCALAPPDATA` | base data dir |
| `PID_BACKFILL_DAYS` | historical backfill horizon (default ~3650) |
| `PID_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

## One-time account setup (OAuth consent)

```powershell
pnpm setup              # tsx src/index.ts --setup
```

This is the **only** user-initiated step (docs/15 §9). It enumerates and classifies
your accounts, lets you add a bare Gmail/IMAP account that has no OS-level discovery
path, and runs the matching consent flow per account:

- **EXO / personal Microsoft / hybrid** → Microsoft Graph auth-code + PKCE loopback
  (or device-code for a headless session).
- **Gmail** → Google OAuth loopback *directly to Google* (app-password fallback).
- **Other IMAP** → OAuth if available, else an app password.
- **POP** → nothing to consent; read locally via Classic Outlook COM.

Every refresh token / app password is sealed with **DPAPI (CurrentUser)** — only an
opaque reference is written to disk. Nothing after setup is ever re-prompted; backfill,
incremental sync, recurrence expansion, and cross-tap dedupe are all unattended.

## Install as a Scheduled Task (unattended, per-user)

```powershell
pnpm build
pnpm run install-task     # registers "\PID\OutlookCollector" and starts it now
pnpm run uninstall-task   # stop + delete the task
```

The task (docs/15 §6.1, docs/12) is deliberately:

- **"At log on"** of your specific user — never "at system startup".
- **LeastPrivilege** — *no* "Run with highest privileges" (Redemption needs no admin;
  elevation would UAC-prompt every logon and break "unattended").
- **InteractiveToken** — *not* "run whether user is logged on or not" (that batch logon
  has no interactive desktop and would break COM/MAPI — docs/15 §6.3).
- **Restart on failure** 3× at 1-minute intervals.
- **Never a SYSTEM service** (Session-0 isolation has no interactive desktop and cannot
  unseal your DPAPI tokens — docs/15 §6.3 / §9).

A single-instance lock (90 s stale threshold, 30 s heartbeat) means a second logon /
fast-user-switch launch exits immediately instead of double-syncing.

## Staging DB location & pointing the main app at it

Default path: `%LOCALAPPDATA%\PID\Collector\collector-staging.sqlite` (WAL mode).

The main app reads it via the `outlook-collector` shim connector. Configure a source of
connector `outlook-collector` whose `config.stagingDbPath` is that absolute path — e.g.
matching the dev seed in `src/db/dev/seed-outlook-demo.ts`:

```jsonc
{ "connectorId": "outlook-collector",
  "config": { "stagingDbPath": "C:\\Users\\<you>\\AppData\\Local\\PID\\Collector\\collector-staging.sqlite" } }
```

The collector is the **single writer**; the shim opens it **read-only**. The four
staging tables (`collector_sync_state`, `collector_staging_items`,
`collector_message_identity`, `collector_account_health`) and the `normalized_item`
JSON shape are copied **verbatim** from `src/connectors/outlook/staging.ts` and MUST
stay in lockstep with it — see the note atop `src/staging/writer.ts`.

## Security & egress model (summary)

- **Local-first**: every byte of data and all processing stay on your machine. Only
  opt-in HTTPS/IMAP/CalDAV calls to **the account's own provider** leave the PC; the
  COM tap makes **zero** network calls. Full ledger: docs/15 §8.2.
- **Secrets**: refresh tokens / app passwords are **DPAPI-sealed (CurrentUser)** and
  never written to the staging DB, config, or logs (docs/15 §8.1). A copied SQLite file
  is useless without your user's DPAPI key.
- **Gmail privacy inversion**: Gmail is always tapped *directly at Google*, never via
  New Outlook's Microsoft-backed cache (docs/15 §8.3) — a hard rule, not a preference.

## What it deliberately does NOT do (docs/15 §9)

No `.ost`/`.pst` scraping; no New Outlook EBWebView cache reads; no raw COM against the
Object Model Guard (always Redemption RDO); no SYSTEM service; no EWS against Exchange
Online (on-prem EWS only, as a fallback); no Graph/Teams webhooks (polling only); no
third-party cloud middleman or MCP-style broker; and no manual export/click after the
one-time setup.

## Module map

```
src/
  index.ts            entrypoint: lock -> detect -> classify -> select -> backfill+incremental
  config.ts log.ts lock.ts model.ts
  platform/           registry.ts wam.ts redemption.ts dpapi.ts native.ts  (Windows-native, lazy)
  detect.ts accounts.ts tap-selector.ts                                    (§3.1–§3.4)
  auth/               pkce.ts graph-oauth.ts imap-oauth.ts token-store.ts   (§3.4/§7.2/§8.1)
  taps/               graph.ts imap.ts caldav.ts com.ts ews.ts dispatch.ts types.ts
  engines/            backfill.ts incremental.ts recurrence.ts             (§4/§5.5/§6.4)
  staging/            writer.ts dedupe.ts                                  (§5.2/§5.4)
  health.ts           status state machine + re-consent                   (§7)
  schedule/           install.ts task.xml                                 (§6.1)
  types/              ambient .d.ts for winax / win-dpapi
```
