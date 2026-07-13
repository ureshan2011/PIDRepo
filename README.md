# Personal Intelligence Dashboard (PID)

A private, **local-first**, AI-powered second brain and executive assistant — built for a single
user, running entirely on that user's own machine.

PID ingests the sprawl of a modern digital life — email and calendar, tasks and notes, documents
and research papers, cloud storage, code, chat, bookmarks, finance, health, travel, photos,
contacts, news and weather, and even the user's own AI-conversation history — and turns it into a
single, searchable **knowledge graph**. On top of that graph it surfaces twelve dashboard sections
that answer the two questions a second brain exists for: *what's going on*, and *what should I do
about it*.

> **Status**: Phase 0 (Scaffold), Phase 1 (MVP), and the first slice of Phase 2 (file import +
> document parsing, plus the Outlook Collector — both the main-app shim connector and the standalone
> Windows companion process) are implemented. The Next.js application lives at the repository root
> alongside the design docs. **[docs/QUICKSTART.md](docs/QUICKSTART.md) has a 5-command setup +
> feature-by-feature verification checklist** — start there. See
> [Document map](#document-map) below for the full design set and
> [implementation roadmap](docs/10-implementation-roadmap.md) for what's next.

---

## Vision

Most "personal assistant" products fail one of two ways: they ship your data to a cloud you don't
control, or they're a dumb search box over a pile of files. PID is built to avoid both failure
modes by taking two decisions as non-negotiable from day one:

1. **All data stays on-device.** There is no PID cloud. Every connector is opt-in, per source, and
   every byte of ingested content — raw, chunked, embedded, or graphed — lives in a local SQLite
   database.
2. **All AI is local AI.** PID does not call a cloud LLM API. Every summarization, extraction,
   embedding, and chat completion is served by a locally installed **LM Studio** instance running
   on the same machine (or LAN), via its OpenAI-compatible API.

Everything else in the design — the connector architecture, the knowledge graph, the dashboard —
exists to make those two constraints feel like *more* capability, not less.

## Feature set

PID organizes ingested data into a knowledge graph and surfaces it through twelve dashboard
sections:

| Section | Purpose |
|---|---|
| Executive Overview | At-a-glance daily/weekly brief: what's urgent, what's due, what changed. |
| Knowledge Hub | Unified, faceted browser over every ingested item (notes, docs, papers, emails, ...). |
| AI Memory | Durable, queryable memory of facts, preferences, and past AI conversations. |
| Research Assistant | Literature review, paper summarization, and citation-backed Q&A over documents/papers. |
| Decision Support | Structured records of decisions, options, and rationale, with graph-linked context. |
| Personal Analytics | Trends and metrics across time (health, finance, productivity, habits). |
| Goal Tracking | Goals, milestones, and habits, linked to the activity that actually moves them. |
| AI Journal | Guided, AI-assisted journaling with prompts drawn from the day's ingested context. |
| Smart Search | Hybrid keyword + semantic search with citations, across every source. |
| AI Insights | Proactively surfaced patterns, anomalies, and connections found in the graph. |
| Weekly/Monthly Reviews | Automated retrospectives synthesized from the period's ingested data. |
| AI Assistant | Conversational interface with RAG over the full knowledge graph. |

Ingested sources (each behind its own opt-in connector): Outlook calendar/email, tasks, notes,
documents, research papers, cloud storage, GitHub, Slack/Teams, browser bookmarks, finance,
health, travel, photos, contacts, RSS/news, weather, and chat/AI-conversation history.

## Locked decisions (canon)

These decisions are settled and binding on every design document in this repository. Later docs
assume them; they are not re-litigated per-doc.

| Area | Decision |
|---|---|
| Application stack | Next.js (App Router) + TypeScript. Single full-stack app plus a background job worker, in the same codebase. |
| Database | SQLite via `better-sqlite3` + Drizzle ORM. |
| UI | Tailwind CSS + shadcn/ui. |
| AI runtime | All LLM and embedding calls go to a **locally installed LM Studio** server via its OpenAI-compatible API (default `http://localhost:1234/v1`). No cloud AI by default. Model name and base URL are user-configurable settings. |
| Privacy model | All data stays on-device. Every connector is opt-in, per source. |
| Ingestion | A pluggable TypeScript `Connector` interface. A seeded sample-data connector ships first; real connectors (Microsoft Graph, Google, Slack, GitHub, ...) plug in later without rework. |
| Knowledge graph | A property graph modeled in SQLite (`entities` + `edges` tables). Embeddings stored via `sqlite-vec`. |
| Search | Hybrid search: SQLite FTS5 keyword search + vector similarity, combined for RAG answers with citations. |
| Outlook ingestion | A self-configuring, on-device **companion collector** (see [Outlook collector](docs/15-outlook-collector.md)) that picks the best tap per account — Microsoft Graph, IMAP, or COM/Outlook-Desktop automation — never naive `.ost` file scraping. |
| Diagrams | All diagrams in this documentation set are Mermaid, so they render natively on GitHub. |

## Document map

| Doc | Title | Covers |
|---|---|---|
| [README.md](README.md) | This file | Vision, feature set, locked decisions, doc index |
| [01](docs/01-system-architecture.md) | System architecture | Layered architecture, component + data-flow diagrams, module boundaries, section-to-service mapping |
| [02](docs/02-database-schema.md) | Database schema | SQLite/Drizzle schema for core, domain, and app tables; ER diagram |
| [03](docs/03-knowledge-graph-design.md) | Knowledge graph design | Entity/edge model, linking mechanisms, resolution, visualization |
| [04](docs/04-technology-stack.md) | Technology stack | Full stack breakdown, versions, rationale per choice |
| [05](docs/05-api-integrations.md) | API integrations | Connector interface, per-source integration details, auth |
| [06](docs/06-security-privacy-model.md) | Security & privacy model | Threat model, encryption, credential storage, egress policy |
| [07](docs/07-ai-pipeline.md) | AI pipeline | LM Studio integration, prompting, RAG, extraction pipelines |
| [08](docs/08-ui-wireframes.md) | UI wireframes | Wireframes and layout for the twelve dashboard sections |
| [09](docs/09-dashboard-components.md) | Dashboard components | Shared component library, composition patterns |
| [10](docs/10-implementation-roadmap.md) | Implementation roadmap | Phased build plan, milestones |
| [11](docs/11-scalability.md) | Scalability | Growth limits of the SQLite-first design and mitigations |
| [12](docs/12-deployment.md) | Deployment | Local install, packaging, updates |
| [13](docs/13-open-source-tools.md) | Open-source tools | Third-party libraries and tools relied upon |
| [14](docs/14-future-ai-capabilities.md) | Future AI capabilities | Roadmap for deeper agentic/AI features |
| [15](docs/15-outlook-collector.md) | Outlook collector | Companion collector design: tap selection, dedupe, sync state |

## Repository layout (design-documentation phase)

```text
PIDRepo/
├── README.md
└── docs/
    ├── 01-system-architecture.md
    ├── 02-database-schema.md
    ├── ...
    └── 15-outlook-collector.md
```

No application code or `package.json` exists yet — this phase produces design documentation only.
Implementation begins per the plan in
[10-implementation-roadmap.md](docs/10-implementation-roadmap.md).
