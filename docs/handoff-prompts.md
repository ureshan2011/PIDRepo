# Personal Intelligence Dashboard — Handoff Prompts

This file breaks the **design-documentation** phase of the Personal Intelligence Dashboard (PID)
into **9 sequential tasks**, each sized for a single Claude Code (Sonnet 5) session. This phase
produces markdown design docs only — **no application code**.

## How to use

- Run the tasks **in order**. Task 1 establishes the canonical decisions in `README.md`; every
  later task begins by reading the docs that already exist, so the set stays consistent.
- Paste **one task block** (everything inside its `~~~` fence) into a fresh session.
- Each task commits and pushes to `claude/personal-intelligence-dashboard-us3k6b`, so any task
  can be resumed or re-run independently without breaking the others.
- Dependencies: Task 2 needs Task 1. Tasks 3–4 need 1–2. Task 5 needs 4. Tasks 6–8 need 1–5.
  Task 9 (review) runs last. Tasks 3, 4, 6, 7, 8 can be parallelized if you accept a review pass.

## Locked decisions (canon — every task restates these so a fresh session can't drift)

- **Stack**: Next.js (App Router) + TypeScript · SQLite via better-sqlite3 + Drizzle ORM ·
  Tailwind CSS + shadcn/ui · single full-stack app + background job worker in one codebase.
- **AI**: all LLM + embedding calls go to a **locally installed LM Studio** server via its
  OpenAI-compatible API (default `http://localhost:1234/v1`); model + base URL are user settings;
  no cloud AI by default.
- **Privacy-first, local-first**: raw data + all AI stay on-device; connectors opt-in per source.
- **Ingestion**: pluggable TypeScript `Connector` interface; a seeded sample-data connector ships
  first; real connectors (Graph, Google, Slack, GitHub, …) plug in later without rework.
- **Knowledge graph**: property graph in SQLite (`entities` + `edges`); embeddings in sqlite-vec;
  hybrid search = FTS5 keyword + vector similarity (RAG with citations).
- **Outlook** email/calendar is ingested by a self-configuring on-device collector (docs/15) that
  picks the best tap per account — **not** naive `.ost` scraping. See Task 5.
- All diagrams in **Mermaid** so GitHub renders them.

## Document map (15 docs + README)

| Doc | Title | Owning task |
|-----|-------|-------------|
| README.md | Vision, feature set, decisions, doc index | 1 |
| 01 | System architecture | 1 |
| 02 | Database schema | 2 |
| 03 | Knowledge graph design | 2 |
| 04 | Technology stack | 3 |
| 05 | API integrations | 4 |
| 06 | Security & privacy model | 4 |
| 07 | AI pipeline | 6 |
| 08 | UI wireframes | 7 |
| 09 | Dashboard components | 7 |
| 10 | Implementation roadmap | 8 |
| 11 | Scalability | 8 |
| 12 | Deployment | 8 |
| 13 | Open-source tools | 3 |
| 14 | Future AI capabilities | 6 |
| 15 | Outlook collector | 5 |

---

## Task 1 — Bootstrap + README + System Architecture

~~~text
You are working in the repo ureshan2011/PIDRepo. All work goes on branch
claude/personal-intelligence-dashboard-us3k6b — check it out (create if needed), commit, and push
with `git push -u origin claude/personal-intelligence-dashboard-us3k6b`.

PROJECT: "Personal Intelligence Dashboard" (PID) — a private, local-first, AI-powered second brain
and executive assistant for one user. It ingests personal data (Outlook calendar/email, tasks,
notes, documents, research papers, cloud storage, GitHub, Slack/Teams, bookmarks, finance, health,
travel, photos, contacts, RSS, news, weather, chat and AI-conversation history), organizes it into
a searchable knowledge graph, and surfaces: an Executive Overview, Knowledge Hub, AI Memory,
Research Assistant, Decision Support, Personal Analytics, Goal Tracking, AI Journal, Smart Search,
AI Insights, Weekly/Monthly Reviews, and an AI Assistant.

THIS PHASE IS DESIGN DOCUMENTATION ONLY — write markdown, no application code, no package.json.

LOCKED DECISIONS (canon; record them in the README):
- Stack: Next.js (App Router) + TypeScript, SQLite via better-sqlite3 + Drizzle ORM,
  Tailwind CSS + shadcn/ui. Single full-stack app + background job worker in the same codebase.
- AI: ALL LLM and embedding calls go to a locally installed LM Studio server via its
  OpenAI-compatible API (default http://localhost:1234/v1). No cloud AI by default; model name and
  base URL are user-configurable settings.
- Privacy-first: all data stays on-device; connectors are opt-in per source.
- Data ingestion: pluggable TypeScript Connector interface; a seeded sample-data connector ships
  first, real connectors (Microsoft Graph, Google, Slack, GitHub, ...) plug in later.
- Knowledge graph: property graph in SQLite (entities + edges tables), embeddings in sqlite-vec,
  hybrid search = SQLite FTS5 keyword + vector similarity (RAG with citations).
- Outlook email/calendar is ingested by a self-configuring on-device collector (docs/15) that picks
  the best tap per account (Graph / IMAP / COM), NOT naive .ost scraping.
- All diagrams in Mermaid so GitHub renders them.

DELIVERABLES (this task only):
1. README.md — project vision, the feature set above, the locked decisions, and an index table
   linking to docs/01 through docs/15:
   01-system-architecture, 02-database-schema, 03-knowledge-graph-design, 04-technology-stack,
   05-api-integrations, 06-security-privacy-model, 07-ai-pipeline, 08-ui-wireframes,
   09-dashboard-components, 10-implementation-roadmap, 11-scalability, 12-deployment,
   13-open-source-tools, 14-future-ai-capabilities, 15-outlook-collector.
2. docs/01-system-architecture.md — layered architecture (UI -> API routes -> services ->
   ingestion/connectors -> storage; background worker; LM Studio as external local process;
   a "companion collector" for desktop-only sources like Outlook desktop and browser bookmarks).
   Include: a Mermaid component diagram, a Mermaid data-flow diagram (source -> connector ->
   normalized item -> chunking -> embedding -> knowledge graph -> dashboard), module boundaries,
   and how the 12 dashboard sections map onto services.

Style for all docs: overview first, then detail; tables for enumerable facts; skimmable headings;
cross-link related docs by relative path. Commit and push when done.
~~~

---

## Task 2 — Database Schema + Knowledge Graph Design

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b (already exists —
fetch and check it out). FIRST read README.md and docs/01-system-architecture.md; they define the
project (Personal Intelligence Dashboard) and locked decisions (Next.js + TypeScript +
SQLite/Drizzle, LM Studio local AI, sqlite-vec, connector architecture). Stay consistent with them.
Documentation only — no application code.

DELIVERABLES:
1. docs/02-database-schema.md — complete SQLite schema, presented BOTH as SQL DDL and as Drizzle
   ORM table sketches. Cover:
   - Core: sources, items (unified record for every ingested thing: type, source_id, external_id,
     title, body, timestamps, metadata JSON), chunks (text chunks per item), embeddings (sqlite-vec
     virtual table), items_fts (FTS5).
   - Domain tables: events, emails, tasks, notes, documents, papers, transactions, health_metrics,
     trips, contacts, photos_index, bookmarks, feeds/feed_items, ai_conversations.
   - App tables: goals, milestones, habits, habit_logs, journal_entries, insights,
     reviews (weekly/monthly), decisions (decision-support records), jobs (background queue),
     settings, sync_state (per-connector/per-tap cursors), and
     message_identity (cross-tap dedupe — RFC 5322 Message-ID as PK -> canonical item id +
     normalized content hash, so an item ingested by one tap, e.g. COM backfill, and another,
     e.g. Graph delta, collapses to a single row; referenced by docs/05 and docs/15).
   - Indexes, foreign keys, and a Mermaid ER diagram of the core + graph tables.
2. docs/03-knowledge-graph-design.md — property-graph model in SQLite:
   - entities table (typed: Person, Organization, Project, Paper, Topic, Place, Event, Tool,
     Goal...) and edges table (typed relations: mentions, authored_by, attended, relates_to,
     part_of, located_in, similar_to...), both with confidence + provenance columns.
   - Three linking mechanisms: deterministic extraction (e.g., email participants -> Person),
     LLM entity/relation extraction via LM Studio, and semantic links from embedding similarity
     above a threshold.
   - Entity resolution/deduplication strategy, graph query patterns in the app layer, visualization
     approach (Cytoscape.js), and when/why to migrate to a dedicated graph DB.
   - Mermaid diagram of the entity/edge type taxonomy.

Cross-link the two docs to each other and to docs/01. Commit and push.
~~~

---

## Task 3 — Technology Stack + Open-Source Tools

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. FIRST read
README.md, docs/01-system-architecture.md, docs/02-database-schema.md, and
docs/03-knowledge-graph-design.md for context and locked decisions (Next.js + TypeScript +
SQLite/Drizzle, LM Studio local AI, privacy-first). Documentation only — no application code.

DELIVERABLES:
1. docs/04-technology-stack.md — the chosen stack with rationale and rejected alternatives for each
   layer: framework (Next.js App Router), language (TypeScript), DB (SQLite + better-sqlite3 +
   Drizzle; sqlite-vec, FTS5), UI (Tailwind + shadcn/ui), charts, calendar UI, graph visualization,
   background jobs (in-process queue on the jobs table), file parsing (PDF/DOCX/PPTX), LM Studio
   (OpenAI-compatible client), packaging for desktop use. Include a summary table:
   layer | choice | why | alternative considered.
2. docs/13-open-source-tools.md — a curated catalog of recommended OSS libraries/frameworks grouped
   by concern: document parsing (e.g., pdf.js/pdf-parse, mammoth), embeddings/vector (sqlite-vec),
   visualization (Recharts/visx, Cytoscape.js, FullCalendar, cal-heatmap), ingestion (RSS parsers,
   ical parsers, IMAP libs, Redemption for the Classic-Outlook COM path), NLP helpers, testing
   (Vitest, Playwright), and adjacent self-hosted apps worth borrowing ideas from (Obsidian, Logseq,
   Memos, Firefly III, Immich) with a note on what each demonstrates. For every tool: name, license,
   one-line role in PID, maturity note.

Keep 04 opinionated (what WE use) and 13 broad (the menu). Cross-link both to docs/01 and docs/07
(AI pipeline — a planned file, link anyway). Commit and push.
~~~

---

## Task 4 — API Integrations + Security & Privacy Model

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. FIRST read README.md
and docs/01–04 for locked decisions (local-first, connector architecture, seeded sample data first,
LM Studio local AI). Documentation only — no application code.

DELIVERABLES:
1. docs/05-api-integrations.md — the connector layer design:
   - TypeScript Connector interface spec: id, displayName, auth() strategy, sync(cursor) returning
     normalized items + next cursor, rate-limit/backoff, error handling, incremental sync via
     sync_state. Show the interface as a code block (spec, not implementation).
   - The seed-data connector as the reference implementation concept.
   - Per-source integration design, one subsection each: Google Drive, OneDrive, Dropbox,
     GitHub (REST), Slack, Microsoft Teams (Graph), browser bookmarks (file-based), RSS/news,
     weather (Open-Meteo), finance (CSV import + optional bank-export formats), health (Google Fit /
     Apple Health export), travel (email parsing + manual), photos (local folder EXIF index),
     contacts (Graph/vCard), AI-conversation history (export import). For each: auth model, mechanism,
     data pulled, sync cadence, privacy notes.
   - Outlook email + calendar gets its OWN spec block — paste the following verbatim, then expand
     each bullet:

     ### Outlook email + calendar — design spec (self-configuring collector)

     DO NOT model this as "read the .ost file" or "one Outlook integration." Outlook is not a single
     source: it is (Outlook flavor x account type), and the right tap differs per account. A dedicated
     companion process (full design in docs/15) owns ingestion; the app only reads its SQLite.
     Local-first is defined by WHERE DATA LANDS AND IS PROCESSED (user disk + LM Studio), not by which
     wire we read — reading a mailbox via Graph/IMAP from an on-device collector IS local-first and
     honors "no third-party cloud middleman."

     Per-account tap precedence (full algorithm in docs/15):
     - Microsoft-hosted (M365 org, personal outlook.com) -> Microsoft GRAPH. Steady state:
       /messages/delta + /calendarView/delta polled every 1–5 min (NO webhooks — they need a public
       HTTPS endpoint). Auth: one-time interactive auth-code + PKCE loopback (system browser) or
       device code; scopes Mail.Read Calendars.Read offline_access; refresh token in DPAPI / Windows
       Credential Manager -> unattended for months. Org accounts may hit AADSTS90094 (admin-consent
       wall) -> fall back to COM (Classic only) or degrade loudly.
     - Gmail -> DIRECT IMAP to Google (IDLE + CONDSTORE) + CalDAV for calendar. Do NOT read via the
       local Outlook cache — New Outlook routes Gmail/IMAP through Microsoft's cloud (privacy
       inversion). Consumer app-passwords still work; OAuth preferred.
     - Other IMAP -> direct IMAP; calendar only if CalDAV is discoverable.
     - POP+PST / on-prem Exchange / org-consent-blocked -> COM via Redemption/Extended MAPI on CLASSIC
       Outlook (store logon; the Object Model Guard does NOT police it; no admin, no VSS). On-prem
       Exchange may alternatively use on-prem EWS. POP calendars exist ONLY in the local PST — COM is
       the only tap.
     - NEW OUTLOOK HAS NO LOCAL TAP: no COM; its EBWebView cache is ~7-day, undocumented,
       schema-drifting, locked. New Outlook accounts MUST resolve to a cloud/direct tap or degrade
       loudly. Never build on the EBWebView cache.
     - Do NOT build cloud ingestion on EWS: Exchange Online EWS default-disables Oct 1 2026, shuts
       down Apr 1 2027. On-prem EWS is unaffected.
     - Backfill vs incremental may use DIFFERENT taps: COM/OST for instant local historical backfill
       (Classic only) IN PARALLEL with Graph/IMAP authoritative-history backfill, then switch to
       Graph/IMAP delta for durable steady state. De-dupe across taps on the RFC 5322 Message-ID
       header (fallback: normalized content hash) via message_identity.

   - A summary table: source | mechanism | auth | direction | cadence (include one Outlook row per
     account x flavor case, kept honest about the New Outlook cliff).
2. docs/06-security-privacy-model.md — threat model (cloud exposure, device theft,
   over-permissioned tokens, prompt-injection via ingested content), principles (local-first, no
   telemetry, opt-in egress), data-at-rest (OS disk encryption baseline, SQLCipher option), secrets
   handling (OS credential store / DPAPI, never in the DB), LM Studio locality, prompt-injection
   mitigations for RAG over untrusted ingested content, backup/export, and single-user auth for the
   local web UI. Include this paragraph verbatim in the egress section, then expand it:

     Privacy inversion (must be documented and honored): the New Outlook client syncs Gmail/IMAP
     accounts THROUGH Microsoft's cloud by default, so reading a user's local Outlook is LESS private
     than our collector talking IMAP directly to Google — we therefore tap non-Microsoft accounts at
     the source, not via Outlook. Maintain an explicit egress-per-account-tap ledger: for each account,
     record exactly which endpoint its tap contacts (Graph -> Microsoft; IMAP/CalDAV -> the
     mail/calendar provider directly; COM/OST -> nothing leaves the device), and assert that the only
     data leaving the PC is the same provider traffic Outlook itself already generates — no third
     party, no cloud copy of message content, and OAuth refresh tokens sealed at rest via DPAPI /
     Windows Credential Manager.

Cross-link 05 <-> 06 <-> 15, and both to docs/02 (sync_state, message_identity, sources tables).
Commit and push.
~~~

---

## Task 5 — Outlook Collector (docs/15)

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. FIRST read README.md
and docs/01, 02, 05, 06 for context. You are DESIGNING (not building) the ingestion companion for a
privacy-first, local-first Personal Intelligence Dashboard (Next.js + TypeScript + SQLite; all AI via
local LM Studio; runs on the user's Windows desktop). Produce ONE markdown design doc at
docs/15-outlook-collector.md: interfaces, algorithms as pseudocode, data schemas, state machines,
failure UX. NO application code, NO other files.

## Hard constraints (from the user, non-negotiable)
- No mocked data. No manual exports/clicks after one-time setup. No third-party cloud middleman /
  MCP-like broker. Data + all intelligence stay on-device. Unattended, incremental; captures bodies +
  metadata + calendar recurrences + history.
- "Local-first" = data lands & is processed on the user's disk + LM Studio. Reading a mailbox via
  Graph/IMAP FROM the on-device collector is compliant and often MORE private than scraping the local
  app.

## Verified 2026 landscape you must design around
- New Outlook (olk.exe): NO COM, NO VSTO/VBA — only sandboxed Office.js. Its local EBWebView cache is
  ~7-day, undocumented, schema-drifting, single-process-locked -> NOT a source. Treat New Outlook as
  "no local tap; must use cloud/direct or degrade loudly."
- Classic Outlook (outlook.exe): COM works, but the Object Model Guard is flaky in 2026 for
  out-of-process callers and the programmatic-access registry override is ignored in newer M365 builds.
  THEREFORE always read via Redemption RDO / Extended MAPI store logon, which the Guard does NOT police
  -> no prompts, no dependence on AV status, no admin, no VSS snapshot. Only use VSS+libpff for
  orphaned/offline PST/OST when Outlook is not running.
- COM requires the interactive desktop + a MAPI profile -> the collector runs as a per-USER STA process
  launched at LOGON (Scheduled Task, restart-on-failure), NOT a Session-0/SYSTEM service.
- Microsoft-hosted -> Graph: auth-code+PKCE loopback or device code; scopes Mail.Read Calendars.Read
  offline_access; refresh token via DPAPI/Credential Manager; /messages/delta + /calendarView/delta
  polled 1–5 min (NO webhooks — need a public endpoint). Watch the Graph calendarView delta pagination
  dedupe bug. Org accounts may hit AADSTS90094 -> COM fallback (Classic) or degrade.
- Gmail -> DIRECT IMAP (IDLE + CONDSTORE) + CalDAV; New Outlook routes Gmail through MS cloud (privacy
  inversion) so direct is more private AND more robust. POP accounts keep the calendar ONLY in the
  local PST (IMAP tap silently misses it) -> COM. Do NOT build on EWS for cloud (EXO EWS off Oct 1 2026
  / shutdown Apr 1 2027); on-prem EWS OK.
- Classic Outlook is winding down (consumer already defaults to New; enterprise opt-out to Mar 2027;
  support ~2029) -> COM/OST is a LEGACY FALLBACK, never the strategic primary.

## The doc MUST contain
1. Architecture overview: single per-user logon-launched STA process, writes the SQLite the app reads;
   component diagram (Detector, Classifier, Tap-selector, Backfill engine, Incremental engine,
   Health/UX surfacer) — Mermaid.
2. Full per-account decision algorithm as pseudocode: detect flavor(s) via registry/process/paths ->
   enumerate & classify accounts (EXO_ORG / PERSONAL_MSA / GMAIL_IMAP / OTHER_IMAP / POP_PST /
   ON_PREM_EXCH) -> choose tap with fallbacks. Cover the Redemption-vs-Graph choice explicitly and WHEN
   each wins.
3. Backfill vs incremental: how they can use DIFFERENT taps (COM/OST instant local backfill on Classic
   in parallel with Graph/IMAP authoritative-history backfill; then Graph/IMAP delta for steady state).
   Show the merge and the switch-over.
4. Identity & watermark handling: per-tap native IDs (Graph id / IMAP UIDVALIDITY+UID+MODSEQ /
   MAPI EntryID+StoreID) PLUS a cross-tap canonical key = RFC 5322 Message-ID (fallback: normalized
   content hash) to de-dupe when backfill tap != incremental tap. Define the SQLite sync_state and
   message_identity schemas (consistent with docs/02). Calendar recurrence per tap (Graph server-side
   expansion via /calendarView; COM IncludeRecurrences sorted+bounded + GetRecurrencePattern; store
   master RRULE + windowed expansion).
5. Unattended/scheduling model: logon Scheduled Task, restart policy, single-instance lock, poll
   cadences, backoff, and why NOT a SYSTEM service.
6. Degrade-loudly UX: per-account health enum (OK / STALE / AUTH_FAILED / NEEDS_CONSENT /
   TAP_UNAVAILABLE) with last_success_at + reason; token-revocation re-consent flow; explicit
   New-Outlook-cliff and AADSTS90094 messaging. Never serve silently-stale data as fresh.
7. Security/privacy: token storage (DPAPI/Credential Manager), egress-per-account-tap ledger (which
   provider each tap contacts), and the New-Outlook-routes-Gmail-through-MS inversion (cross-link
   docs/06).
8. Explicit "what we deliberately do NOT do" list (EWS for cloud, EBWebView cache as source, OOM
   direct, SYSTEM service, VSS as baseline, webhooks).

Cross-link to docs/05, 06, 02, 01. Commit and push.
~~~

---

## Task 6 — AI Pipeline + Future AI Capabilities

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. FIRST read README.md
and docs/01–06 (whatever exists) for locked decisions. Critical canon: ALL AI runs through a locally
installed LM Studio server via its OpenAI-compatible API (default http://localhost:1234/v1) — chat
completions AND /v1/embeddings; model + base URL are user settings; no cloud AI by default.
Documentation only — no application code.

DELIVERABLES:
1. docs/07-ai-pipeline.md — the full pipeline design:
   - LM Studio integration: OpenAI-compatible client config, recommended model classes (a small
     instruct model for classification/tagging, a larger one for briefings/summaries; an embedding
     model like nomic-embed-text), context-window budgeting, structured-output strategy (JSON mode /
     schema-constrained prompts), graceful degradation when LM Studio is not running.
   - Ingestion pipeline: normalize -> chunk -> embed -> FTS index -> entity/relation extraction ->
     knowledge-graph linking (reference docs/03). Mermaid flow diagram. NOTE: email/calendar items
     arrive from the Outlook Collector (docs/15) already normalized to `items`; the pipeline treats
     them like any other source — chunk, embed, extract entities (participants -> Person, meetings ->
     Event).
   - RAG smart search: hybrid retrieval (FTS5 + sqlite-vec) -> merge/rerank -> grounded answer with
     citations to items. Include how the example queries are answered ("What did I work on last
     Thursday?", "Which papers discussed cybersickness?").
   - Generation jobs: daily briefing, AI journal, weekly/monthly reviews, paper summarization/
     literature review, decision support (pros/cons, risks, cost-benefit, recommendation + confidence),
     insights/anomaly detection, AI Memory (preference and fact extraction into the knowledge graph,
     recalled via retrieval at prompt time).
   - Prompt-template catalog: for each job above, the inputs, retrieval strategy, output schema, and
     trigger (scheduled vs on-demand). Feedback loop (thumbs up/down stored and used to tune prompts).
2. docs/14-future-ai-capabilities.md — the beyond-MVP vision: autonomous agents (inbox triage agent,
   research scout, scheduling negotiator), predictive personal intelligence (workload forecasting,
   habit-drift alerts, spend prediction), proactive interventions, multi-agent orchestration patterns,
   local fine-tuning/LoRA on personal writing style, and the safety/consent guardrails each capability
   requires. Order by feasibility.

Cross-link to docs/03 and docs/06 (prompt-injection section). Commit and push.
~~~

---

## Task 7 — UI Wireframes + Dashboard Components

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. FIRST read README.md
and docs/01, 04, 07 for the feature set and stack (Next.js + Tailwind + shadcn/ui; charts;
Cytoscape.js graph view). Documentation only — no application code.

Design requirements canon: modern, minimal, dark/light mode, responsive, mobile-friendly, fast,
highly visual, interactive, privacy-first. UI includes cards, charts, timelines, heatmaps, calendar
views, kanban boards, knowledge-graph visualization, interactive analytics.

DELIVERABLES:
1. docs/08-ui-wireframes.md — text-based wireframes that render on GitHub (ASCII box layouts inside
   fenced code blocks; Mermaid for flows). Cover:
   - App shell: sidebar nav, top bar (global search, theme toggle, a sync-status indicator), content
     area; mobile layout variant. Include a Settings -> Connections screen showing per-account health
     (OK / STALE / AUTH_FAILED / NEEDS_CONSENT / TAP_UNAVAILABLE) with a re-consent CTA — the
     "degrade loudly" surface from docs/15.
   - One wireframe per section: Executive Overview (today's schedule, deadlines, important emails,
     priority tasks, AI daily briefing, weather, attention items, productivity score), Knowledge Hub
     (project/research/teaching/personal/finance/travel/ideas/reading collections + graph view),
     Research Assistant, Decision Support, Personal Analytics, Goal Tracking (goal -> milestones
     progress), AI Journal, Smart Search (natural-language query + cited results), AI Insights,
     Weekly/Monthly Review, AI Assistant chat.
   - Navigation flow (Mermaid), empty states, dark/light notes, responsive breakpoints.
2. docs/09-dashboard-components.md — component inventory mapped to the wireframes:
   - Layout components (Shell, Sidebar, TopBar, PageHeader), primitives from shadcn/ui, and
     PID-specific components: BriefingCard, AgendaTimeline, TaskKanban, DeadlineList, ProductivityGauge,
     WeatherTile, StatTile, TrendChart, HabitHeatmap, SpendingBreakdown, GoalProgressCard,
     MilestoneTimeline, KnowledgeGraphView, EntityCard, SearchBar, CitedAnswer, PaperSummaryCard,
     DecisionMatrix, InsightFeed, JournalEntry, ReviewReport, AssistantChat, ConnectionHealthList
     (the per-account sync-health surface).
   - For each: purpose, data contract (the API route/service it reads, referencing docs/01 and docs/02
     tables), key props, chart type where relevant, loading/empty/error states.
   - A table mapping dashboard section -> components -> data sources.

Cross-link 08 <-> 09. Commit and push.
~~~

---

## Task 8 — Roadmap + Scalability + Deployment

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. FIRST read README.md
and ALL existing docs (01–09, 13, 14, 15) — these three docs must be consistent with everything
already written. Documentation only — no application code.

DELIVERABLES:
1. docs/10-implementation-roadmap.md — phased plan from MVP to production, each phase with scope,
   deliverables, exit criteria, and rough effort:
   Phase 0 scaffold (Next.js app, DB migrations, settings, LM Studio client);
   Phase 1 MVP (Executive Overview, tasks/notes/goals CRUD, seed connector, daily briefing);
   Phase 2 ingestion & documents (file import, PDF/DOCX parsing, first real connectors — including the
     Outlook Collector from docs/15 as the first real connector);
   Phase 3 knowledge graph + smart search (embeddings, entities/edges, RAG search UI);
   Phase 4 analytics, journal, weekly/monthly reviews;
   Phase 5 automation & insights (auto-tagging, dedup, scheduled jobs, insight feed);
   Phase 6 assistant & agents (chat assistant, decision support, early autonomous agents).
   Include a Mermaid gantt or flow diagram and an explicit "definition of MVP done".
2. docs/11-scalability.md — realistic single-user scale analysis: expected data volumes per source
   over 5 years, SQLite practical limits (DB size, FTS5, sqlite-vec vector counts, write concurrency
   with one worker), embedding storage math, when limits actually bite, and graduated migration paths
   (WAL tuning -> split DBs -> Postgres+pgvector -> dedicated graph/vector stores) with the trigger
   condition for each. Keep it honest: SQLite is likely sufficient for years.
3. docs/12-deployment.md — deployment for both targets:
   - Local (primary): Windows desktop PC alongside LM Studio — Node process via pm2 or NSSM/Task
     Scheduler, first-run setup, LM Studio configuration (server on, models loaded), backup strategy
     for the SQLite file, updating. Cover installing the Outlook Collector (docs/15) as a PER-USER LOGON
     Scheduled Task (NOT a service), and the Redemption dependency for the Classic-COM tap.
   - Optional cloud/self-hosted: Docker Compose (app + volume), reverse proxy + auth (Tailscale/VPN
     recommended over public exposure), what changes about the privacy posture (reference docs/06), and
     how LM Studio is replaced or tunneled in that mode.

Cross-link to docs/04, 06, and 15. Commit and push.
~~~

---

## Task 9 — Final consistency review + polish

~~~text
Repo ureshan2011/PIDRepo, branch claude/personal-intelligence-dashboard-us3k6b. This is a
REVIEW-AND-FIX pass over a completed documentation set for the Personal Intelligence Dashboard. Read
README.md and every file in docs/ (01–15).

DO:
1. Verify all 15 docs exist and match the README index (titles, filenames, links). Fix the index if
   anything drifted.
2. Check cross-doc consistency and fix discrepancies in place: table names between docs/02 and
   everything that references them (esp. sync_state and message_identity used by docs/05 and docs/15);
   entity/edge types between docs/03 and docs/07; connector list between docs/05 and the sources in
   docs/02; the Outlook tap precedence between docs/05 and docs/15; component names between docs/08 and
   docs/09 (incl. ConnectionHealthList); the per-account health enum
   (OK/STALE/AUTH_FAILED/NEEDS_CONSENT/TAP_UNAVAILABLE) between docs/08, 09, and 15; phase names
   between docs/10 and the README. The locked decisions in README.md win any conflict (Next.js +
   TypeScript + SQLite/Drizzle, LM Studio local AI at an OpenAI-compatible endpoint, sqlite-vec + FTS5
   hybrid search, connector interface with seeded sample data, Outlook collector picks a tap per
   account).
3. Validate every Mermaid block renders: run `npx -y @mermaid-js/mermaid-cli` against each extracted
   diagram if the environment allows, otherwise carefully lint syntax by eye (quoting of labels with
   special characters like parentheses and slashes is the usual breakage). Fix broken diagrams.
4. Verify every relative link between docs resolves to a real file.
5. Fix typos, heading-level inconsistencies, and duplicated content (replace duplication with a
   cross-link to the owning doc).

DO NOT add new sections, new docs, or application code. Summarize what you fixed in the commit message.
Commit and push to the branch.
~~~
