# 05 — API Integrations

Related: [README](../README.md) · [System architecture](01-system-architecture.md) ·
[Database schema](02-database-schema.md) · [Security & privacy model](06-security-privacy-model.md) ·
[Outlook collector](15-outlook-collector.md) (planned)

## Overview

Every ingested source in PID plugs into the app through one pluggable TypeScript **`Connector`**
interface (see the [locked decisions](../README.md#locked-decisions-canon)). A connector's only job
is: authenticate, fetch what changed since last time, and normalize it into the polymorphic `items`
shape defined in [02-database-schema.md](02-database-schema.md#core-tables). Everything downstream —
chunking, embedding, entity extraction, graph linking, search — is source-agnostic and lives outside
the connector (see the [data-flow diagram](01-system-architecture.md#data-flow-diagram)).

This doc covers, in order:

1. The `Connector` interface spec (the contract every source implements).
2. The seed-data connector, which ships first and is the reference implementation concept every real
   connector is written against.
3. Per-source integration design for every non-Outlook source in the feature set.
4. Outlook email + calendar, which gets its own spec block because — unlike every other source — it
   is not one integration but a per-account tap-selection problem, owned by a dedicated companion
   process ([15-outlook-collector.md](15-outlook-collector.md), planned).
5. A summary table of every source's mechanism, auth, direction, and cadence.

One row in `sources` ([02-database-schema.md](02-database-schema.md#core-tables)) is one
`(connector_id, account_id)` pair — a connector can be configured against multiple accounts (two
Gmail addresses, three GitHub orgs), each getting its own `sources` row, its own `sync_state` rows,
and its own opt-in/opt-out toggle.

## The `Connector` interface

All connectors — sample, cloud, file-based, and the Outlook collector's app-facing shim — implement
the same TypeScript contract. This is a **spec**, not an implementation: it defines the shape every
connector must satisfy, matched one-to-one against the `sources` and `sync_state` columns it reads
and writes.

```ts
// connectors/types.ts — the Connector contract every source implements.

/** Matches sources.category in docs/02. */
type SourceCategory =
  | "email" | "calendar" | "tasks" | "notes" | "documents" | "papers" | "cloud_storage"
  | "code" | "chat" | "bookmarks" | "finance" | "health" | "travel" | "photos" | "contacts"
  | "feed" | "weather" | "ai_conversation" | "sample";

/** Matches sync_state.tap in docs/02. */
type Tap = "graph" | "imap" | "com" | "caldav" | "rss" | "api" | "filesystem" | "manual";

/** Matches sync_state.direction in docs/02. */
type SyncDirection = "backfill" | "incremental";

/** How a connector proves who it's acting as. Exactly one strategy per connector, chosen at
 *  configure-time; the concrete secret is never persisted by the connector itself (see docs/06). */
type AuthStrategy =
  | { kind: "oauth2"; authorizationUrl: string; tokenUrl: string; scopes: string[]; pkce: true }
  | { kind: "device_code"; scopes: string[] }
  | { kind: "api_key"; headerName: string }
  | { kind: "file_based"; description: string }     // e.g. browser bookmarks file, CSV import, vCard
  | { kind: "none" };                                 // e.g. Open-Meteo (no auth), seed-data connector

/** One configured instance of a connector — mirrors a `sources` row. */
interface ConnectorAccount {
  sourceId: string;         // sources.id
  accountId: string;        // sources.account_id — email, org/user slug, folder path, ...
  config: Record<string, unknown>;   // sources.config (non-secret; secrets live in the OS credential store, docs/06)
}

/** Opaque per-resource sync position — mirrors one sync_state row's cursor_type/cursor_value. */
interface SyncCursor {
  resource: string;          // sync_state.resource, e.g. "mail" | "calendar" | "files" | "repo"
  tap: Tap;                  // sync_state.tap
  direction: SyncDirection;  // sync_state.direction
  cursorType: "delta_link" | "uidvalidity_uid_modseq" | "watermark" | "page_token" | null;
  cursorValue: string | null;
}

/** The common shape every connector normalizes into — a pre-insert view of an `items` row plus
 *  the type-specific extension columns for its domain table (docs/02). */
interface NormalizedItem {
  type: string;              // items.type
  externalId: string;        // items.external_id — native id from this tap
  tap: Tap;                  // written to item_external_ids.tap
  title?: string;
  body?: string;
  bodyFormat?: "text" | "markdown" | "html";
  url?: string;
  occurredAt?: number;       // epoch ms
  contentHash?: string;      // for change detection / message_identity fallback identity
  metadata?: Record<string, unknown>;
  domainFields?: Record<string, unknown>;   // columns for the matching domain table, e.g. emails.*, events.*
  isDeleted?: boolean;       // tombstone from the source (maps to items.is_deleted)
}

interface SyncBatch {
  items: NormalizedItem[];
  nextCursor: SyncCursor;         // persisted back to sync_state after the batch commits
  hasMore: boolean;               // true if the connector should be called again before sleeping
}

/** Structured errors so the worker can decide retry vs. surface-to-user without string-matching. */
class ConnectorError extends Error {
  constructor(
    public readonly kind:
      | "auth_expired"       // refresh failed — needs re-consent (sources.status = 'needs_consent')
      | "auth_denied"        // e.g. AADSTS90094 admin-consent wall — needs a fallback tap or user action
      | "rate_limited"       // caller should back off and retry; may carry retryAfterMs
      | "tap_unavailable"    // e.g. Outlook not running, network down — transient, keep last-known-good
      | "not_found"          // resource deleted/moved upstream
      | "unknown",
    message: string,
    public readonly retryAfterMs?: number,
  ) { super(message); }
}

interface RateLimitPolicy {
  strategy: "fixed_window" | "token_bucket" | "provider_header_driven"; // e.g. Retry-After / X-RateLimit-*
  maxRequestsPerWindow?: number;
  windowMs?: number;
  backoff: { kind: "exponential"; baseMs: number; maxMs: number; jitter: true };
}

interface Connector {
  /** Stable id, matches sources.connector_id, e.g. "google-drive", "github", "outlook-collector". */
  readonly id: string;
  readonly displayName: string;
  readonly category: SourceCategory;
  readonly rateLimitPolicy: RateLimitPolicy;

  /** Declares how this connector authenticates; the app renders the matching consent/setup UI. */
  auth(): AuthStrategy;

  /** One-time (or re-run-on-demand) setup: exchange a code for tokens, validate a file path, etc.
   *  Persists non-secret config to sources.config; hands secrets to the OS credential store (docs/06). */
  configure(accountId: string, input: Record<string, unknown>): Promise<ConnectorAccount>;

  /** Cheap health check used by Settings -> Connections and the worker's pre-flight check.
   *  Returns the same status enum as sources.status / sync_state.status in docs/02. */
  testConnection(account: ConnectorAccount): Promise<{
    status: "ok" | "stale" | "auth_failed" | "needs_consent" | "tap_unavailable";
    reason?: string;
  }>;

  /** Pull one batch of changes since `cursor` (null means "from the beginning" — a backfill).
   *  Called repeatedly by the worker until hasMore is false; each call's nextCursor is persisted to
   *  sync_state immediately after the batch's items commit, so a crash mid-sync re-resumes from the
   *  last durably-committed cursor rather than re-fetching or dropping items. */
  sync(account: ConnectorAccount, cursor: SyncCursor | null): Promise<SyncBatch>;
}
```

### Incremental sync via `sync_state`

Every `sync()` call is scoped to one `(source_id, resource, tap, direction)` tuple — exactly the
unique key on `sync_state` in [02-database-schema.md](02-database-schema.md#app-tables). The
Connector Manager (see [01-system-architecture.md](01-system-architecture.md#module-boundaries))
loads the matching `sync_state` row (or treats a missing row as "no cursor, start a backfill"),
calls `sync(account, cursor)`, and on success writes `nextCursor` back to that same row along with
`last_success_at`. On failure it writes `status`/`status_reason`/`last_attempt_at` without moving the
cursor, so the next run retries from the same durable position. This is also what lets **backfill and
incremental use different taps concurrently** for the same resource (one `sync_state` row per tap —
see the Outlook spec below and [15-outlook-collector.md](15-outlook-collector.md) for the fullest
example of this pattern).

### Rate limiting, backoff, and error handling

- Every connector declares a `rateLimitPolicy`; the worker's job runner (docs/01) enforces it
  centrally rather than trusting each connector to self-throttle, so one misbehaving connector can't
  starve the LM Studio embedding queue or another connector's sync.
- `ConnectorError.kind === "rate_limited"` triggers exponential backoff with jitter, respecting a
  provider's `Retry-After` header when present (GitHub, Slack, Graph all send one).
- `auth_expired` / `auth_denied` set `sources.status` and the corresponding `sync_state.status` to
  `needs_consent` or `auth_failed` and stop retrying until the user re-authenticates — PID never
  silently serves stale data as fresh (the same "degrade loudly" principle detailed in
  [15-outlook-collector.md](15-outlook-collector.md)).
- `tap_unavailable` (e.g. a filesystem path is unmounted, LAN weather API unreachable) marks the
  source `stale` and retries on the next scheduled interval without alarming the user.

## The seed-data connector (reference implementation concept)

`connectors/sample/` is the **first connector PID ships**, and every later connector is written by
copying its shape, not by inventing a new one. It has `auth(): { kind: "none" }`, no network calls,
and a fixed, versioned bundle of realistic fake data (emails, events, tasks, notes, a few papers, a
handful of transactions, health metrics, a trip, contacts, bookmarks, feed items, and an AI
conversation) covering every `items.type` in [02-database-schema.md](02-database-schema.md#domain-tables).
Its `sync()` deterministically pages through that bundle using a `page_token` cursor, so it exercises
the exact incremental-sync and `sync_state` machinery a real connector uses, without needing any
credentials, network access, or real personal data before the user has connected anything. Concretely
it proves out, for every connector written after it:

- The `NormalizedItem` -> `items` + domain-table insert path.
- Cursor persistence and resumability (kill the worker mid-sync, restart, confirm no duplicates and
  no gaps).
- The full pipeline (chunk -> embed -> extract -> graph-link,
  [01-system-architecture.md](01-system-architecture.md#data-flow-diagram)) end to end against
  content that looks like every dashboard section's real data.

Because it satisfies the same `Connector` interface as everything else, disabling it and enabling a
real connector is a one-line change in `sources` — no rework anywhere else in the app, which is the
whole point of the interface (see the [README](../README.md#locked-decisions-canon)).

## Per-source integration design

### Google Drive

| | |
|---|---|
| Auth | OAuth2 + PKCE, scope `drive.readonly` (or `drive.file` if the user restricts to app-picked files). |
| Mechanism | Google Drive API v3: `files.list` with a `startPageToken` / `changes.list` for incremental sync. |
| Data pulled | File metadata (name, mimeType, modifiedTime, path via parents), plus content for text-extractable types (Docs export to text/markdown, PDFs, plain text) — binary/media files are indexed by metadata only. |
| Cadence | Incremental every 15 min via `changes.list`; full re-list monthly to catch missed changes. |
| Privacy notes | Read-only scope; PID never writes back to Drive. Only file content the user has explicitly granted access to (via the OAuth consent screen's folder/file picker where offered) is fetched. |

### OneDrive

| | |
|---|---|
| Auth | Microsoft Graph OAuth2 + PKCE, scope `Files.Read`. Shares the Graph auth plumbing used by the Outlook collector (see below) but is a **separate** `sources` row/connector — a user can grant Files.Read without granting Mail.Read. |
| Mechanism | Graph `/me/drive/root/delta` — the same delta-link pattern as Outlook's Graph tap, polled every 15 min. |
| Data pulled | File metadata + downloadable content for text-extractable types, same policy as Google Drive. |
| Cadence | 15 min delta poll. |
| Privacy notes | Read-only scope; token stored in the OS credential store (docs/06), never in `sources.config`. |

### Dropbox

| | |
|---|---|
| Auth | OAuth2 (Dropbox does not support PKCE-only public clients as cleanly as Google/MS; a short-lived code + refresh token flow is used), scope `files.metadata.read` + `files.content.read`. |
| Mechanism | Dropbox API `/2/files/list_folder` + `/2/files/list_folder/continue` with a persisted cursor. |
| Data pulled | Same metadata + text-extractable-content policy as Google Drive/OneDrive. |
| Cadence | 15 min cursor-based poll. |
| Privacy notes | Read-only app permissions; scoped to a user-chosen root folder where Dropbox's app-folder permission model allows it, to minimize the sync surface. |

### GitHub (REST)

| | |
|---|---|
| Auth | Personal access token (fine-grained, read-only: `repo:read`, `read:org`) stored via `api_key` strategy, or GitHub App installation token if the user opts into org-wide install. |
| Mechanism | REST API v3: `GET /repos/{owner}/{repo}/issues`, `/pulls`, `/commits`, `/releases`, filtered by `since` per resource; `ETag`/`If-None-Match` used to cut rate-limit spend on unchanged pages. |
| Data pulled | Issues, PRs (with review/comment counts, not full diff bodies by default), commit messages, releases — treated as `items.type = "document"`-adjacent code artifacts under `category: "code"`. |
| Cadence | 10 min poll for watched repos; respects GitHub's primary (5000/hr authenticated) and secondary rate limits via the shared backoff policy. |
| Privacy notes | Token scoped to read-only, revocable independently of any other PID connector; private-repo access is explicit per repo the user adds. |

### Slack

| | |
|---|---|
| Auth | OAuth2 via a Slack app the user installs into their own workspace; scopes `channels:history`, `channels:read`, `users:read` (bot token, not a user token, to avoid impersonation). |
| Mechanism | Slack Web API `conversations.history` / `conversations.list` with cursor-based pagination; real-time updates optionally via Socket Mode (no public webhook endpoint required, consistent with PID never exposing a public HTTPS listener — see the Outlook Graph note below for why that constraint matters generally). |
| Data pulled | Messages from channels the user has joined and explicitly enabled per-channel, thread replies, reactions counts (not per-user reaction identity beyond what's needed for entity linking). |
| Cadence | Socket Mode push where available; otherwise 5 min poll. |
| Privacy notes | Workspace-admin approval may be required for the app install — this is a workspace policy the user's Slack admin controls, not a PID cloud dependency; PID itself never sees the message outside the user's own machine. |

### Microsoft Teams (Graph)

| | |
|---|---|
| Auth | Microsoft Graph OAuth2 + PKCE, scopes `Chat.Read`, `ChannelMessage.Read.All` (the latter requires tenant admin consent in most orgs — degrades loudly to "not available" if denied, same pattern as the Outlook Graph tap's AADSTS90094 handling). |
| Mechanism | Graph `/me/chats/{id}/messages/delta` and `/teams/{id}/channels/{id}/messages/delta`. |
| Data pulled | Chat and channel messages, participants, timestamps — normalized into the same `items.type = "chat"`-style shape as Slack so Knowledge Hub treats both uniformly. |
| Cadence | 5 min delta poll (no webhooks, same public-endpoint constraint as Outlook Graph). |
| Privacy notes | Org-consent-gated by design; PID surfaces `needs_consent` rather than attempting any workaround when the tenant blocks the scope. |

### Browser bookmarks (file-based)

| | |
|---|---|
| Auth | None — reads a local file. |
| Mechanism | The companion collector (already running for desktop-only sources per [01-system-architecture.md](01-system-architecture.md#the-companion-collector)) reads the browser's local bookmarks store directly off disk (e.g. Chrome/Edge's JSON `Bookmarks` file, Firefox's `places.sqlite`) — never a browser extension API or cloud sync account. |
| Data pulled | Title, URL, folder path, date added. |
| Cadence | On file-change (filesystem watch) or every 30 min poll fallback. |
| Privacy notes | Purely local file read; nothing leaves the device; no browser-vendor account is involved. |

### RSS / news

| | |
|---|---|
| Auth | None (public feeds) or feed-specific HTTP basic auth if the user adds a private feed. |
| Mechanism | Standard RSS/Atom polling using `ETag`/`Last-Modified`/`If-Modified-Since` (stored on the `feeds` row per [02-database-schema.md](02-database-schema.md#domain-tables): `feeds.etag`, `feeds.last_modified`) to avoid re-downloading unchanged feeds. |
| Data pulled | `feed_items`: title, URL, published date, author, summary/body where the feed includes full content. |
| Cadence | Per-feed `poll_interval_minutes` (default 60, user-adjustable per feed). |
| Privacy notes | Outbound requests are to the feed's own host, not a PID-operated aggregator; no reading history is sent anywhere beyond the plain HTTP fetch every feed reader makes. |

### Weather (Open-Meteo)

| | |
|---|---|
| Auth | None — Open-Meteo's free tier requires no API key. |
| Mechanism | Simple REST GET against the Open-Meteo forecast endpoint, parameterized by the user's configured lat/lon (entered manually or resolved once via geocoding, then cached — no continuous location tracking). |
| Data pulled | Current conditions + short-range forecast, surfaced by the Executive Overview's `WeatherTile` (docs/09, planned) — not stored as `items` rows (it's ephemeral display data, not durable knowledge-graph content), so it has no `sources`/`sync_state` row. |
| Cadence | Hourly refresh, cached in-memory/short-TTL. |
| Privacy notes | Only a static lat/lon leaves the device, to a weather API with no PID account attached. |

### Finance (CSV import + optional bank-export formats)

| | |
|---|---|
| Auth | None — user-initiated file import; no bank credentials are ever requested or stored (no "Plaid-style" aggregator). |
| Mechanism | User exports a statement from their bank/card portal (CSV, OFX, or QFX) and imports it through the UI; the connector parses the file, maps columns (with a saved per-institution mapping profile for repeat imports), and de-duplicates against existing `transactions` rows by `(account, transaction_date, amount_cents, merchant)` fuzzy match. |
| Data pulled | `transactions`: amount, currency, account, category (rule-based auto-categorization, user-correctable), merchant, date. |
| Cadence | Manual, user-triggered per import; no polling (`direction` is always `backfill` in `sync_state` terms — each import is a bounded batch, not a live cursor). |
| Privacy notes | The strongest privacy posture in the source list: zero network egress. Bank data touches only the user's disk and browser during the manual export/import round trip. |

### Health (Google Fit / Apple Health export)

| | |
|---|---|
| Auth | Google Fit: OAuth2, scope `fitness.activity.read` + `fitness.body.read`. Apple Health: file-based only (Apple provides no personal-use read API) — the user exports the Health app's XML archive and imports it through the UI, same pattern as finance CSV import. |
| Mechanism | Google Fit: REST `users.dataset.aggregate` for step/sleep/heart-rate aggregates. Apple Health: one-time (or repeat, user-triggered) XML export parse. |
| Data pulled | `health_metrics`: steps, sleep minutes, heart rate, weight, keyed by `metric_type` + `recorded_at` + `source_device`. |
| Cadence | Google Fit: daily poll. Apple Health export: manual, user-triggered (no live API exists to poll). |
| Privacy notes | Health data is treated as maximally sensitive: never included in any future telemetry, excluded by default from any exported/shared insight unless the user explicitly opts a health-derived insight into a review. |

### Travel (email parsing + manual)

| | |
|---|---|
| Auth | Reuses whatever email tap is already configured for the account (Outlook collector or a direct IMAP connector) — travel has no separate auth of its own; manual entries need none. |
| Mechanism | A rule/pattern-based parser runs over already-ingested `emails` items (airline/hotel/rail confirmation formats, iCal attachments) to extract `trips`/`trip_segments`; the user can also create/edit a trip manually in the UI. LLM-assisted extraction (via LM Studio, docs/07) fills gaps the rule-based parser misses, e.g. free-text itinerary emails. |
| Data pulled | `trips` (destination, dates, status) and `trip_segments` (flight/hotel/car/train, confirmation code, JSON details). |
| Cadence | Runs as part of the normal pipeline pass over new email items (docs/01's data-flow diagram) — no independent cursor of its own; `direction` is effectively "derived," not a distinct `sync_state` row. |
| Privacy notes | No new egress: this is a local extraction step over data already on-device from the email tap. |

### Photos (local folder EXIF index)

| | |
|---|---|
| Auth | None — reads user-designated local folders. |
| Mechanism | Filesystem walk + EXIF/XMP metadata extraction over one or more folders the user points PID at (no cloud photo library account, e.g. no Google Photos/iCloud API dependency in the base design). |
| Data pulled | `photos_index`: file path, taken-at, GPS lat/lon (if present in EXIF), camera model, dimensions, and a perceptual hash (for near-duplicate detection) — the image bytes themselves are never copied into the SQLite database, only indexed in place. |
| Cadence | Filesystem watch where the OS supports it, plus a nightly full re-walk to catch offline-drive changes. |
| Privacy notes | Fully local; GPS EXIF data is sensitive and is treated the same as health data — never surfaced in a shared export without explicit confirmation. |

### Contacts (Graph / vCard)

| | |
|---|---|
| Auth | Graph: OAuth2 + PKCE, scope `Contacts.Read` (shares Graph auth plumbing with the Outlook collector, separate `sources` row). vCard: file-based, none. |
| Mechanism | Graph `/me/contacts/delta`. vCard: user exports/imports a `.vcf` file (e.g. from Google Contacts, iCloud, a phone) through the UI. |
| Data pulled | `contacts`: display name, emails, phones, company; linked to a `Person` entity in the knowledge graph (`contacts.entity_id`, see [03-knowledge-graph-design.md](03-knowledge-graph-design.md)) so contact records and email/meeting participants resolve to the same graph node. |
| Cadence | Graph: 30 min delta poll. vCard: manual, user-triggered. |
| Privacy notes | Contact data (especially phone numbers) is excluded from any future cloud-AI fallback path by policy — see [06-security-privacy-model.md](06-security-privacy-model.md). |

### AI-conversation history (export import)

| | |
|---|---|
| Auth | None — file-based import. |
| Mechanism | The user exports their conversation history from a third-party AI chat tool (JSON export formats vary by vendor) and imports it through the UI; a per-vendor format adapter normalizes each into `ai_conversations` + `ai_conversation_messages`. |
| Data pulled | Conversation metadata (model name, started/ended timestamps) and full message turns (`role`, `content`), feeding the AI Memory dashboard section (docs/01's service map). |
| Cadence | Manual, user-triggered; no live polling (no third-party chat vendor's conversation history is fetched over an ongoing API connection by default). |
| Privacy notes | This is, by construction, a local-only import of data the user already exported themselves — no new vendor account or token is ever created by PID for this source. |

### Outlook email + calendar — design spec (self-configuring collector)

DO NOT model this as "read the .ost file" or "one Outlook integration." Outlook is not a single
source: it is (Outlook flavor x account type), and the right tap differs per account. A dedicated
companion process (full design in docs/15) owns ingestion; the app only reads its SQLite. Local-first
is defined by WHERE DATA LANDS AND IS PROCESSED (user disk + LM Studio), not by which wire we read —
reading a mailbox via Graph/IMAP from an on-device collector IS local-first and honors "no
third-party cloud middleman."

Per-account tap precedence (full algorithm in docs/15):

- Microsoft-hosted (M365 org, personal outlook.com) -> Microsoft GRAPH. Steady state:
  `/messages/delta` + `/calendarView/delta` polled every 1-5 min (NO webhooks — they need a public
  HTTPS endpoint). Auth: one-time interactive auth-code + PKCE loopback (system browser) or device
  code; scopes `Mail.Read Calendars.Read offline_access`; refresh token in DPAPI / Windows Credential
  Manager -> unattended for months. Org accounts may hit AADSTS90094 (admin-consent wall) -> fall
  back to COM (Classic only) or degrade loudly.
- Gmail -> DIRECT IMAP to Google (IDLE + CONDSTORE) + CalDAV for calendar. Do NOT read via the local
  Outlook cache — New Outlook routes Gmail/IMAP through Microsoft's cloud (privacy inversion).
  Consumer app-passwords still work; OAuth preferred.
- Other IMAP -> direct IMAP; calendar only if CalDAV is discoverable.
- POP+PST / on-prem Exchange / org-consent-blocked -> COM via Redemption/Extended MAPI on CLASSIC
  Outlook (store logon; the Object Model Guard does NOT police it; no admin, no VSS). On-prem
  Exchange may alternatively use on-prem EWS. POP calendars exist ONLY in the local PST — COM is the
  only tap.
- NEW OUTLOOK HAS NO LOCAL TAP: no COM; its EBWebView cache is ~7-day, undocumented, schema-drifting,
  locked. New Outlook accounts MUST resolve to a cloud/direct tap or degrade loudly. Never build on
  the EBWebView cache.
- Do NOT build cloud ingestion on EWS: Exchange Online EWS default-disables Oct 1 2026, shuts down
  Apr 1 2027. On-prem EWS is unaffected.
- Backfill vs incremental may use DIFFERENT taps: COM/OST for instant local historical backfill
  (Classic only) IN PARALLEL with Graph/IMAP authoritative-history backfill, then switch to
  Graph/IMAP delta for durable steady state. De-dupe across taps on the RFC 5322 Message-ID header
  (fallback: normalized content hash) via `message_identity`.

**Expanded, per bullet:**

- **This is not "one Outlook integration."** In the `Connector` interface terms above, the app-facing
  side of Outlook ingestion is a thin shim connector (`id: "outlook-collector"`) whose `sync()` just
  reads rows the companion process has already written to its own local SQLite and hands them to the
  pipeline as `NormalizedItem`s — all account-classification, tap selection, auth, backfill/delta
  merge, and dedupe logic lives in the companion process, documented end-to-end in
  [15-outlook-collector.md](15-outlook-collector.md). Every other connector in this document runs
  in-process inside the main app; Outlook is the one deliberate exception, because desktop-only taps
  (COM) require a per-user interactive desktop session the main Next.js server process doesn't have
  (see [01-system-architecture.md](01-system-architecture.md#the-companion-collector)).
- **"Local-first" is about data landing and processing, not wire choice.** A Graph or IMAP call made
  *by the on-device collector, to the account's own provider* keeps every byte of processing and
  storage on the user's disk; it is categorically different from routing that same mailbox through a
  third-party SaaS backend PID doesn't control. This distinction is why the Graph and direct-IMAP taps
  below are both compliant with PID's local-first principle even though they cross the network — see
  the egress ledger in [06-security-privacy-model.md](06-security-privacy-model.md#egress-and-the-privacy-inversion).
- **Microsoft-hosted accounts use Graph as the steady-state tap.** Polling (not webhooks) is a hard
  requirement because PID runs no public HTTPS endpoint for any account, ever — Graph subscriptions
  need one, so they're architecturally out regardless of convenience. The refresh token is sealed in
  DPAPI/Windows Credential Manager (never in `sources.config` or any table — see docs/06), which is
  what makes months of unattended sync possible without re-prompting the user. AADSTS90094 (tenant
  admin hasn't consented to the requested scopes) is treated as an expected steady-state outcome for
  org accounts, not an error to retry past — the collector falls back to COM on Classic Outlook, or
  else marks the account `needs_consent` and surfaces it in Settings -> Connections rather than
  looping silently.
- **Gmail is tapped directly, never through the local Outlook cache.** This is the single most
  important tap decision in the whole design: New Outlook's Gmail/IMAP support is itself implemented
  by routing the account's mail through Microsoft's cloud, so reading Gmail "via Outlook" would
  silently hand Google mail content to a Microsoft-operated backend — a privacy *regression* relative
  to talking IMAP straight to Google. IMAP IDLE (push) plus CONDSTORE (efficient incremental sync via
  MODSEQ) gives near-real-time sync without polling; CalDAV covers the calendar leg. App passwords
  remain supported for accounts without 2FA-compatible OAuth set up, but OAuth is preferred and is
  what the setup flow defaults to.
- **Any other IMAP provider follows the same direct-tap pattern** as Gmail, with the caveat that
  CalDAV calendar discovery is provider-dependent (some IMAP-only providers have no calendar product
  at all) — the collector probes for CalDAV and degrades to "mail only" rather than failing the whole
  account.
- **COM is the tap of last resort, not a shortcut.** It only runs against **Classic** Outlook
  (`outlook.exe`), via Redemption RDO / Extended MAPI rather than raw COM Automation, specifically
  because Redemption is not policed by the Object Model Guard — avoiding the security-prompt dialogs
  and antivirus-state dependency that plague naive COM automation. It requires no admin rights and no
  VSS snapshot for a live mailbox (VSS is reserved for the narrow case of an offline/orphaned
  PST/OST — see docs/15). POP accounts are the one case where COM is not merely preferred but
  *structurally necessary*: a POP account's calendar exists only inside the local PST, so there is no
  cloud tap that could ever see it.
- **New Outlook is a dead end as a data source, full stop.** Its EBWebView-based local cache is an
  implementation detail of the web-view shell, not a stable API: ~7-day retention, no published
  schema, and known to drift between builds. Any account running under New Outlook is routed to
  whichever cloud/direct tap its account type calls for (Graph or IMAP) exactly as if Outlook weren't
  installed at all; if no such tap is available for some reason, the account is marked
  `tap_unavailable` and surfaced honestly rather than silently starved of updates.
  This is also forward-looking: consumer Outlook already defaults to New Outlook, and Classic's
  support horizon is finite (enterprise opt-out through Mar 2027, support through ~2029 — see
  [15-outlook-collector.md](15-outlook-collector.md)), so COM is explicitly a *legacy fallback*, never
  the strategic primary tap.
- **EWS is excluded from the cloud design on a deadline, not a preference.** Exchange Online disables
  EWS by default starting October 1, 2026 and shuts it down entirely April 1, 2027 — building the
  steady-state cloud tap on EWS today would mean shipping a design with a known expiration date.
  On-premises Exchange is unaffected by that retirement and may still use on-prem EWS where Graph
  isn't reachable (e.g. no hybrid modern-auth setup).
- **Backfill and incremental are allowed to run on different taps at once**, each getting its own
  `sync_state` row (`source_id, resource, tap, direction`) — e.g. a brand-new Classic-Outlook account
  might run a COM backfill (`tap = 'com', direction = 'backfill'`) to get years of history onto disk
  instantly, in parallel with a Graph authoritative-history backfill (`tap = 'graph', direction =
  'backfill'`) that will eventually supersede it, while a Graph delta sync (`tap = 'graph', direction
  = 'incremental'`) is already running steady-state for anything arriving *after* setup. Because two
  taps can report the same physical email, every inbound message is deduplicated against
  `message_identity` (keyed on the RFC 5322 `Message-ID` header, falling back to a normalized content
  hash for messages with missing/malformed headers) **before** an `items` row is created — see
  [02-database-schema.md](02-database-schema.md#app-tables) for the exact schema and
  [15-outlook-collector.md](15-outlook-collector.md) for the full merge/switch-over algorithm.

## Summary table

| Source | Mechanism | Auth | Direction | Cadence |
|---|---|---|---|---|
| Sample/seed data | In-process fixture bundle | none | backfill (one-shot) | on first run / manual reset |
| Google Drive | Drive API v3 `changes.list` | OAuth2 + PKCE | incremental | 15 min (monthly full re-list) |
| OneDrive | Graph `/me/drive/root/delta` | OAuth2 + PKCE | incremental | 15 min |
| Dropbox | Dropbox API cursor-based `list_folder` | OAuth2 | incremental | 15 min |
| GitHub | REST v3, `since`-filtered + ETag | Fine-grained PAT / GitHub App token | incremental | 10 min |
| Slack | Web API + Socket Mode | OAuth2 (bot token) | incremental | push (Socket Mode) or 5 min poll |
| Microsoft Teams | Graph `/messages/delta` (chat + channel) | OAuth2 + PKCE (tenant-consent gated) | incremental | 5 min |
| Browser bookmarks | Companion collector reads local bookmarks file | none | incremental | filesystem watch / 30 min |
| RSS/news | HTTP poll with ETag/Last-Modified | none (per-feed basic auth optional) | incremental | per-feed (default 60 min) |
| Weather | Open-Meteo REST | none | incremental (ephemeral, not stored as items) | hourly |
| Finance | CSV/OFX/QFX file import | none | backfill (per import) | manual |
| Health — Google Fit | REST aggregate API | OAuth2 | incremental | daily |
| Health — Apple Health | XML export file import | none | backfill (per import) | manual |
| Travel | Derived from ingested email + manual entry | reuses email tap's auth | derived (no independent cursor) | pipeline pass over new email items |
| Photos | Local filesystem walk + EXIF | none | incremental | filesystem watch + nightly re-walk |
| Contacts — Graph | Graph `/me/contacts/delta` | OAuth2 + PKCE | incremental | 30 min |
| Contacts — vCard | `.vcf` file import | none | backfill (per import) | manual |
| AI-conversation history | Vendor-export JSON file import | none | backfill (per import) | manual |
| Outlook — Microsoft-hosted (M365 org / outlook.com) | Graph `/messages/delta` + `/calendarView/delta` | OAuth2 auth-code+PKCE or device code, refresh token in DPAPI/Credential Manager | incremental (+ optional parallel COM/Graph backfill) | poll 1-5 min |
| Outlook — Gmail account | Direct IMAP (IDLE+CONDSTORE) + CalDAV | OAuth2 (app password fallback) | incremental | push (IDLE) |
| Outlook — other IMAP account | Direct IMAP (+ CalDAV if discoverable) | OAuth2 or app password | incremental | push (IDLE) or short poll |
| Outlook — POP+PST / on-prem Exchange / org-consent-blocked | COM via Redemption/Extended MAPI (Classic Outlook only) | Windows store logon (no separate credential) | backfill + incremental (COM is the only tap) | poll (collector-scheduled) |
| Outlook — New Outlook, no resolvable cloud/direct tap | None available — `tap_unavailable`, degrade loudly | n/a | n/a | n/a (surfaced in Settings -> Connections, never silently stale) |

## Cross-references

- [02-database-schema.md](02-database-schema.md) — canonical schema for `sources`, `sync_state`,
  `item_external_ids`, and `message_identity`, all referenced throughout this doc.
- [06-security-privacy-model.md](06-security-privacy-model.md) — the threat model, secrets handling,
  and the egress-per-account-tap ledger that governs every auth strategy and tap named above.
- [15-outlook-collector.md](15-outlook-collector.md) (planned) — full design of the companion process
  this doc's Outlook section only summarizes: the account-classification algorithm, backfill/delta
  merge, identity/watermark handling, and degrade-loudly UX.
- [01-system-architecture.md](01-system-architecture.md) — where the Connector Manager, pipeline, and
  companion collector sit in the overall architecture.
