# 13 — Open-Source Tools

Related: [README](../README.md) · [System architecture](01-system-architecture.md) ·
[Technology stack](04-technology-stack.md) · [AI pipeline](07-ai-pipeline.md) (planned) ·
[API integrations](05-api-integrations.md) (planned) · [Outlook collector](15-outlook-collector.md)
(planned)

## Overview

[04-technology-stack.md](04-technology-stack.md) is opinionated: it says what PID uses. This
document is the broad menu those choices were picked from — every library and adjacent project
worth knowing about per concern, whether or not PID ships it, plus a shortlist of self-hosted apps
whose design is worth studying. For every tool: **name, license, one-line role in PID** (or "not
used — reference only"), and a **maturity note**.

Licensing matters here more than in most stacks: PID is a local-first, privacy-first product a user
installs and runs on their own machine, so copyleft obligations (AGPL, GPL) and non-OSS/commercial
tools are called out explicitly rather than glossed over — several entries below (Redemption,
Obsidian) are intentionally **not** open source and are included because the rest of the design
depends on or references them.

## Document parsing

| Tool | License | Role in PID | Maturity |
|---|---|---|---|
| **pdf-parse** | MIT | Chosen PDF-to-text extractor for documents/papers ingestion ([04-technology-stack.md](04-technology-stack.md)). | Small, stable wrapper around `pdfjs-dist`; widely used, low maintenance churn. |
| **pdfjs-dist** (PDF.js) | Apache-2.0 | Lower-level fallback when layout-aware extraction is needed beyond what `pdf-parse` gives. | Mozilla-maintained, powers Firefox's built-in PDF viewer — very mature. |
| **mammoth** | BSD-2-Clause | Chosen DOCX-to-HTML/text converter, preserves heading/list structure. | Mature, narrow scope, low churn; the de facto standard for this job in Node. |
| **officeparser** | MIT | Chosen unified PPTX (and DOCX/XLSX/PDF) text extractor. | Smaller community than mammoth/pdf-parse; treated as the primary PPTX path with a custom fallback (below) for anything it misses. |
| **JSZip** | MIT / GPL-3.0 (dual) | Fallback path: PPTX/DOCX are zip archives of XML; unzip directly when `officeparser` can't handle a file. | Very mature, extremely widely used. |
| **fast-xml-parser** | MIT | Paired with JSZip to walk raw slide/paragraph XML in the fallback path above. | Mature, actively maintained, fast. |
| **tesseract.js** | Apache-2.0 | Not used by default; optional OCR pass for scanned PDFs/image-only documents, gated behind a user setting given its CPU cost. | Mature WASM port of Tesseract OCR; slow but reliable on-device. |
| **exifr** | MIT | EXIF/GPS metadata extraction for the photos connector (`photos_index.gps_lat/lon`, `taken_at`, `camera_model` — [02-database-schema.md](02-database-schema.md)). | Actively maintained, fast, pure JS. |

## Embeddings / vector search

| Tool | License | Role in PID | Maturity |
|---|---|---|---|
| **sqlite-vec** | MIT / Apache-2.0 (dual) | Chosen vector index — `vec0` virtual tables inside the same SQLite file (`embeddings`, `entity_embeddings` — [02-database-schema.md](02-database-schema.md)). | Younger project (successor to `sqlite-vss`) but under active development by the same author who maintains widely-used SQLite tooling; the single-file, no-server property is the deciding factor over raw maturity. |
| **usearch** | Apache-2.0 | Not used; a faster/alternative embedded ANN library considered if `sqlite-vec` KNN performance becomes a bottleneck at scale (see [11-scalability.md](11-scalability.md), planned). | Mature, benchmark-focused, multi-language bindings. |
| **hnswlib-node** | Apache-2.0 | Not used; classic HNSW ANN option, evaluated and passed over because it requires managing a separate on-disk index file outside SQLite. | Mature C++ core with a stable Node binding. |
| **`@xenova/transformers`** (Transformers.js) | Apache-2.0 | Not used for inference (all embedding/chat calls go through LM Studio per the README's local-AI decision); noted here as the option if PID ever needs an in-process JS fallback embedder with no external server at all. | Actively maintained, runs ONNX models fully in-process (WASM/WebGPU). |

## Visualization

| Tool | License | Role in PID | Maturity |
|---|---|---|---|
| **Recharts** | MIT | Chosen charting library for Personal Analytics, Goal Tracking, and Reviews trend charts. | Mature, large community, stable API. |
| **visx** | MIT | Not the default; kept for bespoke/complex charts standard Recharts compositions can't express cleanly. | Airbnb-maintained, D3-based primitives; more code per chart but no ceiling on customization. |
| **D3** | ISC | Foundational — underlies visx and several calendar/graph libraries; not used directly except for one-off custom visualizations. | Extremely mature, the reference implementation for most of this category. |
| **Cytoscape.js** | MIT | Chosen graph-visualization engine for the Knowledge Hub's graph view ([03-knowledge-graph-design.md](03-knowledge-graph-design.md#visualization-approach-cytoscapejs)). | Mature, long-running project with a large plugin ecosystem. |
| **cytoscape-fcose** | MIT | Chosen default force-directed layout plugin ("what's near this entity" browsing). | Actively maintained, the current best-in-class fast CoSE variant for Cytoscape. |
| **cytoscape-dagre** | MIT | Chosen hierarchical layout for `Goal -> Project -> Task` / `part_of` chains. | Stable, widely used Cytoscape layout plugin. |
| **cytoscape.js-elk** | MIT | Alternative hierarchical layout considered alongside dagre for denser hierarchies. | Wraps the mature Eclipse Layout Kernel; heavier but more layout options. |
| **FullCalendar** (core + `daygrid`/`timegrid`/`list`/`interaction` plugins) | MIT (free plugin set only) | Chosen calendar UI for calendar-derived dashboard views. | Very mature, the standard open-source JS calendar; only the MIT-licensed plugin tier is used — premium plugins (e.g. resource timelines) are explicitly avoided. |
| **react-big-calendar** | MIT | Not used; simpler alternative considered and passed over for weaker drag-and-drop and recurrence rendering. | Mature, smaller feature set than FullCalendar. |
| **cal-heatmap** | MIT | Chosen for GitHub-style contribution heatmaps — habit streaks (Goal Tracking) and journal-entry density (AI Journal). | Actively maintained, purpose-built for exactly this visualization. |
| **react-force-graph** | MIT | Not used; WebGL-based alternative to Cytoscape.js noted for very large graphs, if entity-count growth ever makes Cytoscape's canvas rendering the bottleneck. | Actively maintained, good performance ceiling, smaller layout-plugin ecosystem than Cytoscape. |
| **Sigma.js** | MIT | Not used; similar WebGL-performance rationale as react-force-graph. | Mature, used by Gephi-adjacent tooling. |

## Ingestion

| Tool | License | Role in PID | Maturity |
|---|---|---|---|
| **rss-parser** | MIT | Chosen parser for the RSS/news connector (`feeds`/`feed_items` — [02-database-schema.md](02-database-schema.md)). | Mature, simple, handles RSS 2.0/Atom/JSON Feed. |
| **node-ical** | MIT | Chosen iCalendar (`.ics`) parser — CalDAV-sourced calendars and any `.ics` import path. | Actively maintained, handles RRULE expansion needed for `events.recurrence_rule`. |
| **ical.js** | MPL-2.0 | Alternative iCalendar parser considered; Mozilla-maintained (used in Thunderbird), more spec-complete but heavier API surface. | Mature, MPL-2.0 is a weak-copyleft file-level license — compatible with local-only distribution. |
| **imapflow** | MIT | Chosen IMAP client for the email connector's IMAP tap ([15-outlook-collector.md](15-outlook-collector.md), planned) — modern async/await API. | Actively maintained by the Nodemailer author; verify license terms at implementation time, as sibling projects from the same author use dual-licensing for some use cases. |
| **mailparser** | MIT | Chosen MIME parser — turns raw IMAP-fetched RFC 5322 messages into the structured shape `emails` needs (`from_address`, `to_addresses`, attachments). | Mature, same maintainer/ecosystem as imapflow, well-tested against real-world mail. |
| **@microsoft/microsoft-graph-client** | MIT | Chosen SDK for the Microsoft Graph tap (Outlook mail/calendar, OneDrive) — the primary tap per [15-outlook-collector.md](15-outlook-collector.md) (planned). | Microsoft-maintained, actively developed alongside the Graph API itself. |
| **googleapis** | Apache-2.0 | Chosen SDK for the Google connector (Gmail, Calendar, Drive). | Google-maintained, comprehensive, standard choice. |
| **openid-client** | MIT | Chosen OAuth2/OIDC client for connector auth flows (Microsoft Graph, Google, Slack). | Mature, spec-conformant, widely used in Node auth stacks. |
| **Redemption** | **Proprietary / commercial** (per-developer license; not OSS) | Referenced, not bundled: the COM automation library the companion collector's classic-Outlook-desktop tap uses to read MAPI items without triggering Outlook's security prompts, when neither Graph nor IMAP is available for an account ([01-system-architecture.md](01-system-architecture.md#the-companion-collector), [15-outlook-collector.md](15-outlook-collector.md), planned). | Long-standing, de facto standard for this exact problem in the Windows/Outlook-automation community; called out explicitly because it is the one required non-OSS dependency in the whole stack, and only loaded on the desktop-collector's COM-tap code path. |
| **node-imap** | MIT | Not the default; classic callback-based IMAP client kept as a fallback if imapflow's newer API proves unsuitable for a specific server's quirks. | Very mature, effectively feature-frozen. |

## NLP helpers

| Tool | License | Role in PID | Maturity |
|---|---|---|---|
| **wink-nlp** | MIT | Chosen for sentence/paragraph boundary detection during chunking ([01-system-architecture.md](01-system-architecture.md#data-flow-diagram)) — fast, dependency-free tokenization ahead of the embedding step. | Actively maintained, designed for exactly this kind of lightweight pre-LLM NLP. |
| **compromise** | MIT | Considered for lightweight POS tagging / date-phrase detection to assist deterministic extraction ([03-knowledge-graph-design.md](03-knowledge-graph-design.md#1-deterministic-extraction)) ahead of the LLM extraction pass. | Mature, small, no model download required (unlike spaCy-class tools). |
| **franc** | MIT | Considered for language detection, to route non-English content appropriately in chunking/prompting. | Mature, no dependencies, works fully offline. |
| **natural** | MIT | Considered for classic stemming/tokenization utilities; broader and heavier than wink-nlp, kept as a fallback rather than the default. | Long-running project, large surface area, uneven maintenance across its many modules. |
| **gpt-tokenizer** | MIT | Chosen for token-count estimation when sizing chunks against the LM Studio model's context budget ([03-knowledge-graph-design.md](03-knowledge-graph-design.md#2-llm-entityrelation-extraction-lm-studio)). | Actively maintained, pure JS, no native bindings — matters for cross-platform Electron packaging. |

## Testing

| Tool | License | Role in PID | Maturity |
|---|---|---|---|
| **Vitest** | MIT | Chosen unit/service-layer test runner — fast, native ESM/TS support, shares config idiom with the Vite ecosystem Next.js tooling increasingly assumes. | Actively maintained, now the default choice across most modern TS/React stacks. |
| **Playwright** | Apache-2.0 | Chosen end-to-end test runner — drives the packaged Electron shell and the plain browser mode identically. | Microsoft-maintained, mature, strong multi-browser and Electron support. |
| **@testing-library/react** | MIT | Chosen for component-level tests of shared dashboard components ([09-dashboard-components.md](09-dashboard-components.md), planned). | Mature, the de facto standard for behavior-driven React component testing. |
| **msw** (Mock Service Worker) | MIT | Chosen for mocking LM Studio's OpenAI-compatible endpoint and connector-source APIs in tests, so tests don't require a running LM Studio instance. | Actively maintained, widely adopted for exactly this network-boundary-mocking use case. |

## Adjacent self-hosted apps worth borrowing ideas from

These are not dependencies — they're reference products whose design PID's docs draw on. Each note
below says specifically what to look at, not just "it's similar."

| App | License | What it demonstrates |
|---|---|---|
| **Obsidian** | **Proprietary freeware** (not OSS; free for personal use, paid for commercial/sync) | The single-user, local-first, plain-files-you-own product philosophy PID's README explicitly echoes, plus a mature plugin/graph-view UX (its graph view is a direct visual reference point for [03-knowledge-graph-design.md](03-knowledge-graph-design.md#visualization-approach-cytoscapejs)). Included for UX-pattern reference only — no code or license obligations apply. |
| **Logseq** | AGPL-3.0 | An open-source, block-based outliner with a built-in local graph database and daily-journal-as-primary-interface pattern — directly relevant to PID's AI Journal section and its "everything is a node in a graph" model. |
| **Memos** (usememos/memos) | MIT | A minimal, fast, self-hosted note/journal app — a useful reference for keeping the Knowledge Hub's quick-capture flow lightweight rather than over-featured. |
| **Firefly III** | AGPL-3.0 | A mature self-hosted personal-finance manager — its category/budget modeling and transaction-import UX are the closest existing analog to PID's `transactions` domain table and Personal Analytics finance views. |
| **Immich** | AGPL-3.0 | A mature self-hosted photo/video library with on-device ML (face/object recognition, EXIF-based timeline) — the closest analog to PID's `photos_index` table and a strong reference for doing ML-assisted indexing entirely locally, mirroring PID's LM-Studio-only AI constraint. |

**A note on copyleft.** Logseq, Firefly III, and Immich are AGPL-3.0 — a strong copyleft license.
None of their code is used in PID; they are cited as design references only. If any future
implementation phase considers vendoring or adapting code (not just ideas) from an AGPL project,
that decision needs explicit review against [06-security-privacy-model.md](06-security-privacy-model.md)
(planned) and the project's own licensing goals before it happens.

## Cross-references

- [04-technology-stack.md](04-technology-stack.md) — the opinionated subset of this catalog PID
  actually ships, with per-layer rationale and rejected alternatives.
- [01-system-architecture.md](01-system-architecture.md) — the module boundaries these tools plug
  into (ingestion/connectors, pipeline, background worker, storage).
- [03-knowledge-graph-design.md](03-knowledge-graph-design.md) — the graph model behind the
  Cytoscape.js entry above.
- [07-ai-pipeline.md](07-ai-pipeline.md) (planned) — where the NLP-helper and tokenizer entries above
  are used in the chunk/embed/extract pipeline.
- [15-outlook-collector.md](15-outlook-collector.md) (planned) — full detail on the IMAP/Graph/COM
  taps that motivate the ingestion-section entries above, including Redemption.
