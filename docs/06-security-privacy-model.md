# 06 — Security & Privacy Model

Related: [README](../README.md) · [System architecture](01-system-architecture.md) ·
[Database schema](02-database-schema.md) · [API integrations](05-api-integrations.md) ·
[Outlook collector](15-outlook-collector.md) (planned)

## Overview

PID's entire value proposition rests on a claim it has to keep proving in the design, not just
assert once in the README: that a single-user, local-first product with no PID cloud is genuinely
more private than the SaaS alternatives it replaces, even where it has to talk to the network at all
(OAuth, Graph, IMAP, GitHub, ...). This document is the threat model and the concrete controls that
back that claim — what can go wrong, what PID does about it, and where the honest edge cases are
(the New Outlook privacy inversion chief among them).

The short version: **data stays on-device, AI stays on-device, egress is opt-in and enumerable per
account, and every credential lives in the OS's own secret store — never in the SQLite file.**
Everything below expands one piece of that sentence.

## Threat model

| Threat | Vector | Primary mitigation |
|---|---|---|
| Cloud exposure of personal data | A connector (or a future feature) sends ingested content to a third-party server the user didn't explicitly consent to. | No PID cloud exists at all. Every connector is opt-in per source (`sources.enabled`), egress is enumerated per account (see the [egress ledger](#egress-and-the-privacy-inversion) below), and there is no telemetry channel to exfiltrate through. |
| Device theft / physical access | Someone gets the laptop/desktop and tries to read the SQLite file or extract cached credentials. | OS-level disk encryption is the assumed baseline (see [data-at-rest](#data-at-rest)); an optional SQLCipher-encrypted database adds a second layer independent of OS disk encryption; secrets are never stored in the database file itself, only OS-native credential stores. |
| Over-permissioned tokens | A connector requests broader OAuth scopes than it needs, so a compromised token exposes more than the feature requires. | Every connector requests the minimum scope for its stated purpose (e.g. `Mail.Read`, not `Mail.ReadWrite`; `Contacts.Read`, not full contacts access) — see the per-source auth models in [05-api-integrations.md](05-api-integrations.md). Scopes are documented per connector so a scope creep is a visible diff, not a silent addition. |
| Prompt injection via ingested content | A malicious or adversarially-crafted document, email, or web page the user ingests contains text engineered to hijack the AI Assistant's instructions when retrieved into a RAG prompt. | Ingested content is always treated as **data**, never as **instructions** — see [prompt-injection mitigations](#prompt-injection-mitigations) below, and the prompt-template catalog in [07-ai-pipeline.md](07-ai-pipeline.md) (planned) for how retrieval results are framed in every prompt. |
| Credential leakage via logs/exports | A refresh token or API key ends up in a log file, crash dump, or a user-initiated export/backup. | Secrets never enter application logs (structured logging redacts known secret-shaped fields); backups/exports (see [backup and export](#backup-and-export)) cover the SQLite file and user content only — never the OS credential store. |
| Malicious or buggy connector code | A third-party or future connector reads/writes data outside its declared scope, or a compromised dependency exfiltrates data. | The `Connector` interface ([05-api-integrations.md](05-api-integrations.md)) is the *only* way ingestion code touches the system — connectors receive a scoped `ConnectorAccount`, not raw database access; the module-boundary rule in [01-system-architecture.md](01-system-architecture.md#module-boundaries) keeps connectors from depending on Services or Storage internals. |
| Compromised or malicious local network peer | Something else on the LAN intercepts traffic between PID and LM Studio, or between PID and a cloud API. | LM Studio traffic defaults to `localhost` (no LAN exposure unless the user explicitly reconfigures it — see [LM Studio locality](#lm-studio-locality)); all cloud-API egress uses TLS to the provider's own endpoint, matching what any other native client (Outlook, a browser) would already do. |

## Principles

- **Local-first.** All ingested content, all derived artifacts (chunks, embeddings, entities, edges,
  insights), and the entire knowledge graph live in one SQLite file on the user's own disk. There is
  no PID-operated backend of any kind.
- **No telemetry.** PID does not phone home usage analytics, crash reports, or feature-usage data to
  any PID-controlled or third-party analytics service. If diagnostic logging is ever added, it stays
  local (a log file on disk) and is never transmitted anywhere by default.
- **Opt-in egress.** Every network call PID ever makes beyond `localhost` is caused by a connector the
  user explicitly enabled and authenticated (`sources.enabled = 1`), talking to that source's own
  provider. Disabling a connector stops its egress immediately; there is no background "keep syncing
  in case you re-enable it" behavior.

## Data-at-rest

PID assumes the OS provides disk encryption as the baseline — BitLocker on Windows, FileVault on
macOS, LUKS on Linux — the same assumption every local-first desktop app (Obsidian, a password
manager's local vault, etc.) makes, and does not attempt to reimplement full-disk encryption itself.

On top of that baseline, PID offers an **optional SQLCipher-encrypted database** as a second,
independent layer: the same SQLite file, transparently encrypted at the page level with a
user-supplied passphrase, so the data is protected even in scenarios where OS disk encryption is
absent, misconfigured, or the disk is mounted/read by another OS instance. This is opt-in (not the
default) because it trades off convenience — a per-launch or per-session passphrase prompt for a
tool designed to run unattended — against defense-in-depth; the implementation note lives in
[04-technology-stack.md](04-technology-stack.md) (planned) alongside the `better-sqlite3` /
SQLCipher-build tooling decision.

## Secrets handling

No secret — OAuth client secret, access token, refresh token, API key, app password — is ever written
to the SQLite database, to `sources.config` (which is explicitly documented as **non-secret**
connector settings in [05-api-integrations.md](05-api-integrations.md)), or to any log file. Every
secret is handed instead to the OS's native credential store:

| Platform | Store used |
|---|---|
| Windows | DPAPI-protected storage / Windows Credential Manager |
| macOS | Keychain |
| Linux | Secret Service API (e.g. GNOME Keyring, KWallet) via `libsecret` |

The application and the companion collector each hold only an opaque reference (an account
identifier) that the OS resolves back to the actual secret at call time, scoped to the local user
account — so a copy of the SQLite file alone, without the originating machine and user profile, is
never sufficient to authenticate as the user against any connected provider. This is the same
mechanism named explicitly in the Outlook collector's design (refresh tokens sealed via DPAPI /
Windows Credential Manager, [15-outlook-collector.md](15-outlook-collector.md)) and applies uniformly
to every OAuth-based connector in [05-api-integrations.md](05-api-integrations.md), not just Outlook.

## LM Studio locality

All AI — chat completions, embeddings, extraction — is served by a locally installed LM Studio
instance via its OpenAI-compatible API, defaulting to `http://localhost:1234/v1`
([README](../README.md#locked-decisions-canon), [01-system-architecture.md](01-system-architecture.md)).
This is a privacy control as much as an architecture choice: no prompt, no retrieved document chunk,
and no piece of personal context ever leaves the machine to reach an LLM, because there is no cloud
LLM in the default configuration. The base URL and model name are user-configurable settings
specifically so an advanced user *could* point PID at another machine on their own LAN (e.g. a
beefier home server also running LM Studio) — that remains local-first because it stays inside a
network the user controls, as opposed to a third-party-operated inference API. Pointing PID at a
cloud LLM endpoint is technically possible given that same configurability, but is explicitly not the
default and is called out here as the one setting that, if changed, breaks the local-first guarantee
this document otherwise makes unconditionally.

## Egress and the privacy inversion

> Privacy inversion (must be documented and honored): the New Outlook client syncs Gmail/IMAP
> accounts THROUGH Microsoft's cloud by default, so reading a user's local Outlook is LESS private
> than our collector talking IMAP directly to Google — we therefore tap non-Microsoft accounts at the
> source, not via Outlook. Maintain an explicit egress-per-account-tap ledger: for each account,
> record exactly which endpoint its tap contacts (Graph -> Microsoft; IMAP/CalDAV -> the
> mail/calendar provider directly; COM/OST -> nothing leaves the device), and assert that the only
> data leaving the PC is the same provider traffic Outlook itself already generates — no third party,
> no cloud copy of message content, and OAuth refresh tokens sealed at rest via DPAPI / Windows
> Credential Manager.

This paragraph is PID's sharpest concrete illustration of why "local-first" has to be defined by
*where data lands and is processed*, not by a naive rule like "never make a network call." New
Outlook's own Gmail/IMAP support works by routing the account's mail through a Microsoft-operated
backend — meaning a tool that ingested Gmail by reading New Outlook's local state would actually be
laundering Google mail content through Microsoft's cloud, a strictly *worse* privacy posture than
just talking IMAP to Google directly. PID's tap-selection design in
[05-api-integrations.md](05-api-integrations.md#outlook-email-and-calendar--design-spec-self-configuring-collector)
and [15-outlook-collector.md](15-outlook-collector.md) exists specifically to avoid this trap: every
non-Microsoft account is tapped at its own provider, never proxied through Outlook's cloud plumbing.

The general principle this generalizes to beyond Outlook: **every connector's egress target must be
the account's own provider, never an intermediary PID doesn't control** — the same rule that keeps
Slack traffic going to Slack's API and GitHub traffic going to GitHub's API in
[05-api-integrations.md](05-api-integrations.md), rather than through any aggregation layer.

### Egress-per-account-tap ledger

PID maintains this ledger conceptually as a per-`sources`-row property (surfaced in Settings ->
Connections, [09-dashboard-components.md](09-dashboard-components.md), planned, via the
`ConnectionHealthList` component) so a user can see, per configured account, exactly which endpoint
its tap contacts and confirm no data is routed anywhere unexpected:

| Account / connector | Tap | Endpoint contacted | What leaves the PC |
|---|---|---|---|
| Outlook — Microsoft-hosted (M365 org / outlook.com) | Graph | `graph.microsoft.com` | Mail/calendar delta requests — Microsoft, the account's own host. |
| Outlook — Gmail | Direct IMAP + CalDAV | `imap.gmail.com` / Google CalDAV endpoint | IMAP/CalDAV traffic — Google, the account's own host. Never routed through Microsoft. |
| Outlook — other IMAP provider | Direct IMAP (+ CalDAV) | The provider's own IMAP/CalDAV host | Standard mail-client protocol traffic to that provider only. |
| Outlook — POP+PST / on-prem Exchange / org-consent-blocked | COM/OST (Redemption/Extended MAPI) | None (local process call to the running Outlook client) | Nothing — no network egress at all for this tap. |
| Google Drive | Drive API | `www.googleapis.com` | File metadata + content for files the user granted access to. |
| OneDrive | Graph | `graph.microsoft.com` | File metadata + content, same account boundary as Outlook Graph. |
| Dropbox | Dropbox API | `api.dropboxapi.com` | File metadata + content for the connected app scope. |
| GitHub | REST API | `api.github.com` | Read-only issue/PR/commit/release data for repos the user added. |
| Slack | Web API / Socket Mode | `slack.com` (the user's own workspace) | Message/channel data the user's own Slack app is installed to read. |
| Microsoft Teams | Graph | `graph.microsoft.com` | Chat/channel message data, tenant-consent gated. |
| Google Fit | REST API | `www.googleapis.com` | Aggregated activity/body metrics. |
| Weather (Open-Meteo) | REST API | `api.open-meteo.com` | A static lat/lon only — no account, no history. |
| RSS/news | HTTP poll | Each feed's own host | Standard feed-reader HTTP traffic per feed. |
| Browser bookmarks, finance CSV, Apple Health export, vCard, AI-conversation import, photos | File-based / filesystem | None | Nothing — these sources never touch the network. |

Every row above resolves to exactly the same provider traffic a native client for that account would
already generate on the user's behalf — reading Gmail over IMAP is what any IMAP mail client does;
polling Graph delta is what Outlook itself does under the hood for a Microsoft-hosted account. PID
introduces no new third party into any of these paths, and OAuth refresh tokens for every
OAuth-based row are sealed at rest via the platform credential store described in
[secrets handling](#secrets-handling) — DPAPI / Windows Credential Manager on Windows, Keychain on
macOS, Secret Service on Linux.

## Prompt-injection mitigations

Every dashboard section that does RAG over ingested content (Smart Search, AI Assistant, Research
Assistant, and the generation jobs cataloged in [07-ai-pipeline.md](07-ai-pipeline.md), planned) is
retrieving text PID does not control the authorship of — an email, a web page's content, a document a
third party sent the user. That content can contain text deliberately crafted to look like an
instruction to the model ("ignore previous instructions and ..."). PID's mitigations, layered rather
than relying on any single one:

- **Structural separation of instructions from data.** Every prompt template in the AI Orchestration
  Service ([01-system-architecture.md](01-system-architecture.md#module-boundaries)) places retrieved
  chunks inside a clearly delimited, explicitly labeled context block (e.g. fenced and tagged as
  "retrieved content, not instructions") separate from the system/instruction prompt, and the system
  prompt explicitly tells the model that retrieved content is untrusted data to reason *about*, never
  directives to follow.
- **No tool-execution capability inside RAG-answering prompts.** The AI Assistant's retrieval-answer
  path has no access to any action-taking tool (no ability to send an email, modify a file, call a
  connector) — a successful injection in this path can at worst produce a misleading *answer*, not an
  unwanted *action*. Any future agentic capability that *does* take actions (docs/14, planned) is
  designed with a separate, explicit user-confirmation gate before execution, never triggered directly
  from unreviewed retrieved content.
- **Citations force traceability.** Every RAG answer is required to cite the specific `items` it drew
  from ([07-ai-pipeline.md](07-ai-pipeline.md), planned); a user can always see which ingested item
  produced a suspicious claim and investigate or exclude that source.
- **Source-level trust is not automatically escalated to instruction-level trust**, even for sources
  the user chose to connect — an ingested email is data with a known provenance (`items.source_id`),
  not a message from the operator of PID, and prompts are constructed to reflect that distinction
  consistently.
- **Extraction jobs (entity/relation extraction) are similarly scoped:** the LLM is asked to extract
  structured facts about the text, not to execute anything the text says, and extraction output is
  written only to `entities`/`edges` with `confidence` and `provenance` — never allowed to alter
  `sources`, `sync_state`, or connector configuration.

## Backup and export

Because the entire durable state of the product is one SQLite file
([02-database-schema.md](02-database-schema.md#overview)), backup is structurally simple: copying
that file (plus, if SQLCipher is enabled, the passphrase held separately by the user — never stored
alongside the file) is a complete backup. PID's backup/export surface covers:

- **Full-database backup** — a straightforward file copy/snapshot, optionally scheduled by the
  background worker (`maintenance` job type, [01-system-architecture.md](01-system-architecture.md#background-worker))
  to a user-chosen local or user-controlled-cloud-storage destination (e.g. the user's own OneDrive
  folder) — the choice of destination is the user's, not a PID-operated backup service.
- **Selective export** — per-section or per-query export (e.g. "export this Weekly Review," "export
  these search results") to portable formats (Markdown, JSON, CSV where tabular) for sharing outside
  PID, deliberately excluding OS-credential-store contents, which never leave the credential store by
  any export path.
- **Restore** is the inverse of backup: replacing the SQLite file and re-authenticating any connector
  whose token didn't survive the credential-store migration (e.g. a restore onto a new machine) —
  each such connector surfaces as `needs_consent`, the same status used for expired Outlook Graph
  consent, so restore failures are visible per-account rather than silent.

## Single-user auth for the local web UI

PID is designed for exactly one user on one machine, but the Next.js app still serves an HTTP
interface (`localhost` by default) that needs *some* access control, since "runs on localhost" alone
doesn't prevent another local process, a browser tab from a different site, or another user on a
shared machine from reaching it:

- **Default posture:** the app binds to `127.0.0.1` only — never `0.0.0.0` — so it is unreachable from
  the network unless the user deliberately reconfigures binding (e.g. to access the dashboard from a
  phone on the same LAN).
- **Local session auth:** a single local passphrase (or OS-native auth, e.g. Windows Hello, where the
  packaging layer supports it — see [12-deployment.md](12-deployment.md), planned) gates the web UI
  session, protecting against another OS-level user account or a browser-based CSRF/DNS-rebinding
  attempt reaching the API routes. This is intentionally a single shared-secret model, not a
  multi-user account system — there is exactly one user by design ([README](../README.md)).
  - **CSRF/DNS-rebinding hardening**: API routes validate the request's `Origin`/`Host` header against
    the expected local origin, since a malicious page in the browser could otherwise attempt
    same-origin-looking requests to `localhost`.
- **If the user opts into LAN or remote exposure** (e.g. reverse-proxied through Tailscale to check
  the dashboard from a phone, per [12-deployment.md](12-deployment.md), planned), the same passphrase
  gate applies, and the deployment doc's recommendation is a private overlay network (Tailscale/VPN)
  over any form of public exposure — consistent with this doc's no-public-endpoint stance for every
  connector tap.

## Cross-references

- [05-api-integrations.md](05-api-integrations.md) — the `Connector` interface, per-source auth
  models, and the full Outlook tap-precedence spec this doc's egress ledger summarizes.
- [15-outlook-collector.md](15-outlook-collector.md) (planned) — token storage detail, the
  degrade-loudly health-status UX, and the full egress-per-account-tap ledger scoped to Outlook
  accounts specifically.
- [02-database-schema.md](02-database-schema.md) — `sources` (per-account connector registry and
  status), `sync_state` (per-tap cursor and health), and `message_identity` (cross-tap dedupe) — the
  tables this document's controls are enforced around.
- [07-ai-pipeline.md](07-ai-pipeline.md) (planned) — prompt-template catalog referenced in the
  [prompt-injection mitigations](#prompt-injection-mitigations) section above.
- [01-system-architecture.md](01-system-architecture.md) — the companion collector, LM Studio as an
  external local process, and the module-boundary rules this doc's threat model assumes hold.
