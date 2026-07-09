# 11 — Scalability

Related: [README](../README.md) · [System architecture](01-system-architecture.md) ·
[Database schema](02-database-schema.md) · [Knowledge graph design](03-knowledge-graph-design.md) ·
[Technology stack](04-technology-stack.md) · [Implementation roadmap](10-implementation-roadmap.md) ·
[Deployment](12-deployment.md)

## Overview

The honest headline: **for a single user, SQLite is very likely sufficient for the entire useful
life of this product.** This document exists to prove that claim with numbers rather than assert
it, and to lay out — in graduated, trigger-conditioned steps, never as a pre-emptive rewrite — what
changes if a specific user turns out to be an outlier. The two premises worth stating up front,
because everything below follows from them:

1. PID has exactly **one writer** in the steady state most of the time — the background worker —
   and even during Phase 2's dual-tap Outlook backfill ([15-outlook-collector.md](15-outlook-collector.md#4-backfill-vs-incremental-taps-can-differ)),
   writes are batched, sequential, and bounded by real-world data-generation rates, not by another
   human's concurrent usage. A single person cannot generate write contention the way even a small
   team can.
2. PID stores extracted **text**, not raw binary content — `documents.file_path` points at a file
   that stays on disk ([02-database-schema.md](02-database-schema.md#domain-tables)); the SQLite
   file holds metadata, extracted text, chunks, and vectors, not attachments or photo blobs. This
   keeps the database's growth rate an order of magnitude below "every byte a user's digital life
   generates."

## Expected data volumes over 5 years

The table below models a **heavy** single user — someone who connects most available sources and
uses PID daily — deliberately sized generously so the rest of this document's conclusions hold for
the common case with margin to spare. A typical/light user should expect 20–40% of these figures.

| Source | `items.type` | Rate (heavy user) | 5-year total |
|---|---|---|---|
| Email | `email` | ~100/day (sent + received) | ~180,000 |
| Calendar | `event` | ~5,000/yr net-new (bounded recurrence window, [15](15-outlook-collector.md#55-calendar-recurrence-per-tap) keeps instances from accumulating unbounded) | ~25,000 |
| Tasks | `task` | ~15/day created | ~27,000 |
| Notes | `note` | ~5/day | ~9,000 |
| Documents/papers | `document` / `paper` | ~4/day imported | ~7,000 |
| Chat (Slack/Teams) | — (ingested as `items`, no dedicated domain table) | ~150/day | ~270,000 |
| GitHub (issues/PRs/commits) | — | ~20/day | ~36,000 |
| Photos (metadata + EXIF only) | `photo` | ~30/day | ~55,000 |
| Bookmarks | `bookmark` | ~5/day | ~9,000 |
| RSS/feed items | `feed_item` | ~50/day | ~90,000 |
| Finance transactions | `transaction` | ~10/day | ~18,000 |
| Health metrics | `health_metric` | ~20/day (daily-granularity aggregates) | ~36,000 |
| AI-conversation messages | — (`ai_conversation_messages`) | ~50/day | ~90,000 |
| Contacts | `contact` | mostly static | ~2,000 total |

**Total items over 5 years: roughly 850,000–1,000,000 for a heavy user**, more typically
150,000–350,000. SQLite's own documentation and community benchmarks routinely handle tables with
tens to hundreds of millions of rows; a million-row `items` table is not a stress case for the
engine — it is a stress case only for badly missing indexes, which
[02-database-schema.md](02-database-schema.md#core-tables) already avoids (`items_type_idx`,
`items_occurred_at_idx`, per-domain-table indexes).

## SQLite practical limits

| Dimension | SQLite's actual ceiling | PID's realistic 5-year usage | Headroom |
|---|---|---|---|
| Database file size | Documented up to 281 TB (page-count limit × max page size) | ~10–25 GB estimated (see [embedding storage math](#embedding-storage-math) below) | Enormous — bound by disk space, not the engine |
| Rows per table | No practical limit below billions | ~1M `items`, ~2M `chunks` | Enormous |
| `FTS5` index size | Scales linearly with indexed text; no hard cap | Indexed text (title+body) ~1–2 GB raw → FTS5 index of similar order | Query latency, not size, is the real constraint at this scale — a few ms to tens of ms for typical keyword queries |
| `sqlite-vec` vector count | No hard cap; `vec0` performs an exact brute-force scan per query (no ANN index built in as of the version pinned in [13-open-source-tools.md](13-open-source-tools.md)) | ~2,000,000 chunk vectors + ~100,000 entity vectors | Latency-bound, not capacity-bound — see below |
| Write concurrency | WAL mode: one writer, unlimited concurrent readers, readers never blocked by a writer | One worker process writing; the Next.js app's own user-triggered writes (task/note/goal CRUD) are small and infrequent | Comfortable — see [write concurrency](#write-concurrency-with-one-worker) |

### Write concurrency with one worker

`PRAGMA journal_mode = WAL` (set at connection time per
[04-technology-stack.md](04-technology-stack.md#database--search-layer-in-detail)) means readers
never block on a writer and vice versa; the only thing that can queue is a second *writer* behind an
in-flight write transaction. PID structurally has at most two write sources — the background worker
and the occasional user-initiated CRUD write from the app itself — and both go through
`better-sqlite3`'s synchronous, single-connection-per-process model. The realistic contention case
is a long transaction (e.g., a large Outlook backfill batch) holding the write lock while a user
tries to check off a task; this is why the collector's staging design
([15-outlook-collector.md](15-outlook-collector.md#42-merge-and-switch-over-algorithm)) hands off in
bounded batches rather than one giant transaction, and why the worker's own pipeline jobs
(`pipeline_chunk`, `pipeline_embed`, `pipeline_extract`) are chunked per-item, not per-sync-batch.
With that batching in place, worst-case writer-lock hold time is milliseconds, not seconds — a
non-issue at any realistic single-user write rate.

### Embedding storage math

Every embedding is a `FLOAT[768]` vector (matching the default `nomic-embed-text`-class model
dimension fixed in [02-database-schema.md](02-database-schema.md#core-tables)) — 768 × 4 bytes =
**3,072 bytes per vector**, plus `sqlite-vec`'s own small per-row overhead.

| Corpus | Count (5-yr heavy user) | Raw vector bytes |
|---|---|---|
| Chunk embeddings (`embeddings`, ~2 chunks/item average) | ~2,000,000 | ~6.1 GB |
| Entity embeddings (`entity_embeddings`, people/orgs/projects/topics) | ~100,000–150,000 | ~0.3–0.45 GB |
| **Total vector storage** | — | **~6.5 GB** |

Add the underlying text the vectors were derived from (`items.body` + `chunks.content`, which
duplicates the chunked portion of the body for retrieval-time convenience) at roughly 1.5–2 GB, the
FTS5 index at a comparable order of magnitude, and normal B-tree indexes at 10–20% overhead, and the
**whole-database total lands around 10–25 GB for a heavy 5-year single user** — comfortably inside
what a consumer SSD holds many times over, and well within SQLite's own headroom above.

### When vector search latency actually bites

`sqlite-vec`'s `vec0` virtual table (as pinned in
[13-open-source-tools.md](13-open-source-tools.md)) performs an **exact, brute-force distance scan**
per KNN query — there is no ANN (approximate nearest neighbor) index built in at the version PID
uses. That is the right tradeoff at PID's scale (exact results, zero index-build complexity, no
recall tuning) but it is the one place vector count directly drives query latency:

| Vector count | Approx. scan volume | Expected latency on a modern desktop CPU (SIMD-accelerated distance calc) |
|---|---|---|
| 100,000 (a fresh install, months of use) | ~300 MB | Single-digit milliseconds |
| 500,000 (1–2 years, moderate user) | ~1.5 GB | Tens of milliseconds |
| 2,000,000 (5-year heavy-user estimate above) | ~6 GB | Low hundreds of milliseconds |
| 5,000,000+ (well beyond this document's 5-year model) | ~15 GB+ | Approaching a second or more — this is the trigger, see below |

Search latency in the "low hundreds of milliseconds" range is entirely acceptable for a single
user's interactive Smart Search / RAG queries, which are not high-QPS by construction (one person
typing one query at a time). The practical mitigation available well before any migration is needed
is **pre-filtering the candidate set** — scoping a KNN query to a source, item type, or time window
via a `WHERE` clause on the joined `items`/`chunks` metadata before the vector scan, which
`sqlite-vec` supports natively — rather than always scanning the full corpus.

## When limits actually bite: trigger conditions

None of these are close for the 5-year heavy-user model above; they're listed so a real,
outlier-heavy install has a concrete, measurable signal to watch for rather than a vague sense that
"it might get slow eventually."

| Signal | Rough threshold | What it actually indicates |
|---|---|---|
| Database file size | Approaching 50–100 GB | Either an unusually heavy multi-decade user, or (more likely) a bug — an unbounded recurrence expansion, a chunking regression, or a missing `maintenance_vacuum` cadence |
| Vector search P95 latency | Sustained > 500 ms–1 s on a typical query | Vector count has crossed into the multi-million range, or pre-filtering isn't being applied where it should be |
| Graph traversal latency | Multi-hop (3+) recursive-CTE queries noticeably slow the AI Assistant / Decision Support sections | Edge count has reached the low millions — the exact trigger already defined in [03-knowledge-graph-design.md](03-knowledge-graph-design.md#when-and-why-to-migrate-to-a-dedicated-graph-db) |
| Writer-lock contention | Task/note CRUD from the UI visibly stalls during a sync | A backfill or pipeline job is running an oversized single transaction — first fix is batching, not a new database engine |
| A second concurrent writer appears | Multi-device sync, or a requirement for more than one person to use the same instance | This is a **requirements change**, not a scale problem — it invalidates the single-writer assumption this whole document rests on, and is the strongest legitimate reason to consider Postgres regardless of data volume |

## Graduated migration paths

Ordered from "do this first, costs nothing architecturally" to "last resort, real infrastructure
change." Each step is **independently optional** — most single-user installs will never need to
leave step 1.

### 1. WAL tuning and pragma optimization

**Trigger**: any early sign of slowdown, or none at all — this step is cheap enough to apply
proactively as part of the Phase 5 maintenance jobs
([10-implementation-roadmap.md](10-implementation-roadmap.md#phase-5--automation--insights)), not
something to wait on a trigger for.

- `PRAGMA cache_size` sized to a meaningful fraction of available RAM (SQLite's page cache).
- `PRAGMA mmap_size` enabled so read-heavy queries (search, graph traversal) benefit from
  memory-mapped I/O.
- `PRAGMA wal_autocheckpoint` tuned so the WAL file doesn't grow unbounded between checkpoints under
  a bursty ingestion pattern (e.g., a large Outlook backfill).
- Periodic `PRAGMA optimize` and incremental `VACUUM` (the `maintenance_vacuum` job type from
  [01-system-architecture.md](01-system-architecture.md#background-worker)) to keep the query
  planner's statistics fresh and reclaim space after large deletes (e.g., a superseded COM backfill
  per [15-outlook-collector.md](15-outlook-collector.md#42-merge-and-switch-over-algorithm)).
- Covering indexes added as real query patterns emerge, rather than speculatively.

**No architecture change.** Still one file, one process family, one engine.

### 2. Split databases / `ATTACH`-ed files

**Trigger**: one specific subsystem's I/O or size dominates the file — e.g., photo-metadata churn
from a nightly re-walk visibly affects unrelated query latency, or the whole-file backup described
in [12-deployment.md](12-deployment.md#backup-strategy-for-the-sqlite-file) has grown large enough that daily backups
are inconvenient — but overall volume is still well within SQLite's ceiling.

- Move a hot or cold subsystem to its own `.sqlite` file, `ATTACH DATABASE`-ed at connection time —
  candidates are the vector tables (`embeddings`, `entity_embeddings`) into a dedicated
  `vectors.sqlite`, or old years of `items`/`chunks` into a `pid-archive-<year>.sqlite` that's still
  queryable via a `UNION` view but backed up less frequently since it's effectively read-only.
- Still a single-process, single-writer, zero-network-hop model — this is a filesystem-layout change,
  not an engine change, and keeps every guarantee in
  [06-security-privacy-model.md](06-security-privacy-model.md#data-at-rest) intact.

### 3. PostgreSQL + pgvector

**Trigger**: either (a) a genuine requirement for **concurrent multi-writer access** — multiple
devices syncing to the same store, or more than one person using the instance, which breaks this
document's single-writer premise entirely — or (b) the vector corpus has grown well past the
multi-million mark from the [latency table above](#when-vector-search-latency-actually-bites) *and*
pre-filtering no longer keeps queries interactive, so a real ANN index (HNSW/IVFFlat, which pgvector
provides and `sqlite-vec` at PID's pinned version does not) becomes necessary rather than optional.

- This is the first step that requires **a second running local service** — which
  [04-technology-stack.md](04-technology-stack.md#overview) explicitly ruled out for the base
  design specifically because it isn't needed at PID's default scale. Crossing this line is a
  deliberate tradeoff, not a default upgrade path, and should be justified by a measured trigger
  above, not anticipatory scaling.
- Migration keeps the same logical schema (Drizzle supports Postgres); the practical work is
  `vec0`'s brute-force KNN syntax → `pgvector`'s `<->`/`<=>` operators and index definitions, and
  moving `better-sqlite3`'s synchronous connection model to an async pool.
- Still entirely self-hosted and local (or on a self-hosted server the user controls, per
  [12-deployment.md](12-deployment.md#optional-cloudself-hosted-deployment)) — this migration does
  not by itself change PID's privacy posture, only its infrastructure footprint.

### 4. Dedicated graph and/or vector stores

**Trigger**: the same conditions already specified in
[03-knowledge-graph-design.md](03-knowledge-graph-design.md#when-and-why-to-migrate-to-a-dedicated-graph-db)
— edge count in the low millions causing multi-hop traversal slowdowns, or a need for graph
algorithms SQL/recursive-CTEs can't express well (PageRank-style centrality, community detection,
weighted shortest path at scale) — this document does not redefine that trigger, only restates it
as the top of PID's migration ladder. The candidate order from that document
(**Kùzu** — embedded, no server process, first choice — then **Memgraph**/**Neo4j Community** as
server-based fallbacks) and its recommended nightly-mirror-before-cutover migration path both apply
unchanged here. The same logic applies symmetrically to vector search if step 3's pgvector still
isn't enough: a dedicated vector store (Qdrant, Chroma) as a nightly-mirrored read replica before any
write-path cutover.

**This is the last resort in the ladder, and realistically never reached by a single user's
organic 5-year data volume** — it is reached only by a requirements change (true multi-writer
access) or a genuinely unusual usage pattern (graph-algorithm needs, not just graph storage).

## Summary

| Step | Trigger | Architecture impact |
|---|---|---|
| WAL tuning | Proactive / any early slowdown | None — same file, same process |
| Split DBs | One subsystem dominates size/I/O | Filesystem layout only, still single-writer SQLite |
| Postgres + pgvector | Multi-writer requirement, or vector corpus past multi-million with pre-filtering insufficient | New local service; still self-hosted, still local-first if kept on-device or on a user-controlled server |
| Dedicated graph/vector store | Edge count in the low millions + slow multi-hop queries, or need for graph algorithms SQL can't express | Last resort; mirror-first migration, never a big-bang cutover of the only copy of a user's data |

The through-line: **every step above is optional, trigger-conditioned, and reversible in the sense
that SQLite remains the system of record until a mirror-based migration is proven necessary.** For
the realistic single-user data volumes modeled in this document, the expected outcome is that most
installs stay on step 0 (no tuning beyond defaults) or step 1 for their entire useful life.

## Cross-references

- [02-database-schema.md](02-database-schema.md) — the canonical DDL, including the `vec0` and
  `fts5` virtual tables this document's scaling math is built around.
- [03-knowledge-graph-design.md](03-knowledge-graph-design.md#when-and-why-to-migrate-to-a-dedicated-graph-db) —
  the graph-specific migration trigger and candidate list this document restates rather than
  duplicates.
- [04-technology-stack.md](04-technology-stack.md#database--search-layer-in-detail) — the WAL and
  connection-model choices this document assumes and tunes.
- [15-outlook-collector.md](15-outlook-collector.md) — the source of the largest single-source data
  volume (email) and the batching design that keeps its writes from becoming a contention point.
- [10-implementation-roadmap.md](10-implementation-roadmap.md) — where the WAL-tuning and
  maintenance-job work from step 1 above is actually scheduled (Phase 5).
- [12-deployment.md](12-deployment.md) — backup strategy, which interacts with database file size as
  discussed in [step 2](#2-split-databases--attach-ed-files) above.
