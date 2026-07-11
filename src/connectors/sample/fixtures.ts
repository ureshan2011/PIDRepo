import type { NormalizedItem } from "../types";

/**
 * Versioned fixture bundle for the seed/sample connector (BUILD_SPEC §4). Realistic
 * fake data covering EVERY `items.type`. Dates are computed RELATIVE to `now` at
 * sync time (see {@link buildFixtureItems}) so "today's tasks/events" are always
 * populated for the daily briefing + Executive Overview.
 *
 * domainFields use the exact snake_case column names of the matching domain table
 * so the ingest service can upsert them generically. Two sentinel keys carry child
 * rows that live in their own tables:
 *   - `_segments`  (trip)            -> trip_segments
 *   - `_messages`  (ai_conversation) -> ai_conversation_messages
 * These are stripped by the ingest service before the parent-row upsert.
 */

/** Bump when the shape/content of the bundle changes (surfaced in item metadata). */
export const FIXTURE_VERSION = 1;

/** Stable id of the feeds registry row that all sample feed_items belong to. */
export const SAMPLE_FEED_ID = "SAMPLEFEED0000000000000001";
export const SAMPLE_FEED_URL = "https://example.com/blog/feed.xml";
export const SAMPLE_FEED_TITLE = "The Example Engineering Blog";
export const SAMPLE_FEED_SITE_URL = "https://example.com/blog";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Build the full, ordered fixture bundle with all dates relative to `now`. Called
 * once per `sync()` invocation; the ORDER and length are stable so `page_token`
 * paging is deterministic. External ids are date-independent so re-syncing after
 * time passes never creates duplicates.
 */
export function buildFixtureItems(now: number): NormalizedItem[] {
  // Anchor "today" to local start-of-day so due-today / overdue windows read cleanly.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today0 = startOfToday.getTime();

  const items: NormalizedItem[] = [];

  // ------------------------------------------------------------------ emails
  items.push(
    {
      type: "email",
      externalId: "email-1001",
      tap: "manual",
      title: "Q3 planning doc ready for your review",
      body: "Hi — I've drafted the Q3 planning doc. Could you review the goals section before our sync tomorrow? The budget numbers still need a second pair of eyes.",
      bodyFormat: "text",
      occurredAt: now - 3 * HOUR,
      metadata: { sample: true },
      domainFields: {
        message_id: "<q3-planning-1001@example.com>",
        thread_id: "thread-42",
        from_address: "maya@example.com",
        from_name: "Maya Okafor",
        to_addresses: ["you@example.com"],
        cc_addresses: [],
        folder: "INBOX",
        is_read: 0,
        has_attachments: 1,
        importance: "high",
      },
    },
    {
      type: "email",
      externalId: "email-1002",
      tap: "manual",
      title: "Your invoice from CloudHost is available",
      body: "Your monthly invoice of $42.00 is now available. No action needed — this is an automated receipt.",
      bodyFormat: "text",
      occurredAt: now - 26 * HOUR,
      domainFields: {
        message_id: "<invoice-9921@cloudhost.example>",
        thread_id: null,
        from_address: "billing@cloudhost.example",
        from_name: "CloudHost Billing",
        to_addresses: ["you@example.com"],
        folder: "INBOX",
        is_read: 1,
        has_attachments: 0,
        importance: "normal",
      },
    },
    {
      type: "email",
      externalId: "email-1003",
      tap: "manual",
      title: "Re: Conference talk proposal",
      body: "Great news — the committee accepted your talk! We'll follow up with scheduling details next week. Please confirm your availability.",
      bodyFormat: "text",
      occurredAt: now - 5 * DAY,
      domainFields: {
        message_id: "<talk-accept-3310@confs.example>",
        thread_id: "thread-88",
        from_address: "program@confs.example",
        from_name: "DevConf Program",
        to_addresses: ["you@example.com"],
        folder: "INBOX",
        is_read: 1,
        has_attachments: 0,
        importance: "high",
      },
    },
  );

  // ------------------------------------------------------------------ events
  items.push(
    {
      type: "event",
      externalId: "event-2001",
      tap: "manual",
      title: "Team standup",
      body: "Daily engineering standup. Share blockers and today's focus.",
      occurredAt: today0 + 9 * HOUR + 30 * MIN,
      domainFields: {
        start_at: today0 + 9 * HOUR + 30 * MIN,
        end_at: today0 + 9 * HOUR + 45 * MIN,
        all_day: 0,
        location: "Zoom",
        organizer_email: "maya@example.com",
        attendees: ["you@example.com", "maya@example.com", "sam@example.com"],
        status: "confirmed",
        response_status: "accepted",
        calendar_uid: "uid-standup-2001@example.com",
      },
    },
    {
      type: "event",
      externalId: "event-2002",
      tap: "manual",
      title: "Lunch with Priya",
      body: "Catch-up lunch to talk through the mentorship program.",
      occurredAt: today0 + 12 * HOUR + 30 * MIN,
      domainFields: {
        start_at: today0 + 12 * HOUR + 30 * MIN,
        end_at: today0 + 13 * HOUR + 30 * MIN,
        all_day: 0,
        location: "Cafe Verde",
        organizer_email: "you@example.com",
        attendees: ["you@example.com", "priya@example.com"],
        status: "confirmed",
        response_status: "accepted",
        calendar_uid: "uid-lunch-2002@example.com",
      },
    },
    {
      type: "event",
      externalId: "event-2003",
      tap: "manual",
      title: "Q3 planning sync",
      body: "Review the Q3 planning doc and lock objectives.",
      occurredAt: today0 + 1 * DAY + 15 * HOUR,
      domainFields: {
        start_at: today0 + 1 * DAY + 15 * HOUR,
        end_at: today0 + 1 * DAY + 16 * HOUR,
        all_day: 0,
        location: "Room 4B",
        organizer_email: "maya@example.com",
        attendees: ["you@example.com", "maya@example.com"],
        status: "confirmed",
        response_status: "tentative",
        calendar_uid: "uid-q3sync-2003@example.com",
      },
    },
    {
      type: "event",
      externalId: "event-2004",
      tap: "manual",
      title: "Dentist appointment",
      body: "Routine cleaning.",
      occurredAt: today0 + 3 * DAY + 10 * HOUR,
      domainFields: {
        start_at: today0 + 3 * DAY + 10 * HOUR,
        end_at: today0 + 3 * DAY + 11 * HOUR,
        all_day: 0,
        location: "Downtown Dental",
        status: "confirmed",
        response_status: "accepted",
        calendar_uid: "uid-dentist-2004@example.com",
      },
    },
  );

  // ------------------------------------------------------------------- tasks
  items.push(
    {
      type: "task",
      externalId: "task-3001",
      tap: "manual",
      title: "Review Q3 planning doc",
      body: "Read Maya's draft and leave comments on the goals + budget sections.",
      occurredAt: today0 + 17 * HOUR,
      domainFields: {
        status: "open",
        priority: "high",
        due_at: today0 + 17 * HOUR, // due today
        project: "Planning",
      },
    },
    {
      type: "task",
      externalId: "task-3002",
      tap: "manual",
      title: "Submit expense report",
      body: "Upload receipts for last week's conference travel.",
      occurredAt: today0 - 2 * DAY,
      domainFields: {
        status: "open",
        priority: "medium",
        due_at: today0 - 2 * DAY, // overdue
        project: "Admin",
      },
    },
    {
      type: "task",
      externalId: "task-3003",
      tap: "manual",
      title: "Renew domain registration",
      body: "example.dev renews soon — confirm auto-renew is on.",
      occurredAt: today0 - 12 * HOUR,
      domainFields: {
        status: "open",
        priority: "low",
        due_at: today0 - 12 * HOUR, // overdue (earlier today window)
        project: "Admin",
      },
    },
    {
      type: "task",
      externalId: "task-3004",
      tap: "manual",
      title: "Prepare conference talk outline",
      body: "Draft the section headings and a rough time budget for each.",
      occurredAt: today0 + 4 * DAY,
      domainFields: {
        status: "in_progress",
        priority: "high",
        due_at: today0 + 4 * DAY, // upcoming
        project: "Talks",
      },
    },
    {
      type: "task",
      externalId: "task-3005",
      tap: "manual",
      title: "Book flights for offsite",
      body: "Compare fares and book before prices rise.",
      occurredAt: today0 + 6 * DAY,
      domainFields: {
        status: "open",
        priority: "medium",
        due_at: today0 + 6 * DAY, // upcoming
        project: "Travel",
      },
    },
    {
      type: "task",
      externalId: "task-3006",
      tap: "manual",
      title: "Archive old project repos",
      body: "Clean up dormant repositories from last year.",
      occurredAt: now - 10 * DAY,
      domainFields: {
        status: "done",
        priority: "low",
        due_at: today0 - 5 * DAY,
        completed_at: now - 4 * DAY,
        project: "Admin",
      },
    },
  );

  // ------------------------------------------------------------------- notes
  items.push(
    {
      type: "note",
      externalId: "note-4001",
      tap: "manual",
      title: "Ideas for Q3 goals",
      body: "- Ship the search feature\n- Reduce onboarding time to under 5 minutes\n- Start a monthly engineering newsletter\n- Explore local-first sync",
      bodyFormat: "markdown",
      occurredAt: now - 2 * DAY,
      domainFields: {
        notebook: "Work",
        tags: ["planning", "goals"],
        pinned: 1,
      },
    },
    {
      type: "note",
      externalId: "note-4002",
      tap: "manual",
      title: "Reading list",
      body: "Books and papers to get through this quarter. Prioritise the retrieval-augmented generation survey.",
      bodyFormat: "text",
      occurredAt: now - 9 * DAY,
      domainFields: {
        notebook: "Personal",
        tags: ["reading"],
        pinned: 0,
      },
    },
  );

  // ---------------------------------------------------------------- documents
  items.push({
    type: "document",
    externalId: "doc-5001",
    tap: "filesystem",
    title: "Q3 Planning Draft.pdf",
    body: "Q3 planning draft covering objectives, key results, staffing, and a preliminary budget. Section 3 outlines the search initiative and its dependencies.",
    occurredAt: now - 1 * DAY,
    domainFields: {
      file_path: "/Documents/Planning/Q3 Planning Draft.pdf",
      mime_type: "application/pdf",
      file_size_bytes: 348_112,
      page_count: 12,
      checksum: "sha256:aa11bb22cc33",
    },
  });

  // ------------------------------------------------------------------- papers
  items.push(
    {
      type: "paper",
      externalId: "paper-6001",
      tap: "api",
      title: "Dense Passage Retrieval for Open-Domain Question Answering",
      body: "We introduce a dense retrieval approach that learns embeddings from question-passage pairs and outperforms traditional sparse methods on open-domain QA.",
      url: "https://arxiv.org/abs/2004.04906",
      occurredAt: now - 30 * DAY,
      domainFields: {
        authors: ["Vladimir Karpukhin", "Barlas Oguz", "Sewon Min"],
        venue: "EMNLP",
        year: 2020,
        doi: "10.18653/v1/2020.emnlp-main.550",
        arxiv_id: "2004.04906",
        citation_count: 3200,
        abstract:
          "A dense retrieval method using dual-encoder embeddings for open-domain question answering.",
      },
    },
    {
      type: "paper",
      externalId: "paper-6002",
      tap: "api",
      title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
      body: "RAG combines a parametric seq2seq model with a non-parametric retriever over a dense vector index, improving factuality on knowledge-intensive tasks.",
      url: "https://arxiv.org/abs/2005.11401",
      occurredAt: now - 28 * DAY,
      domainFields: {
        authors: ["Patrick Lewis", "Ethan Perez", "Aleksandra Piktus"],
        venue: "NeurIPS",
        year: 2020,
        doi: "10.5555/3495724.3496517",
        arxiv_id: "2005.11401",
        citation_count: 5400,
        abstract: "Combining parametric and non-parametric memory for knowledge-intensive NLP.",
      },
    },
  );

  // ------------------------------------------------------------- transactions
  items.push(
    {
      type: "transaction",
      externalId: "txn-7001",
      tap: "api",
      title: "CloudHost monthly plan",
      body: "Recurring hosting subscription.",
      occurredAt: now - 26 * HOUR,
      domainFields: {
        amount_cents: -4200,
        currency: "USD",
        account: "Checking",
        category: "Software",
        merchant: "CloudHost",
        transaction_date: today0 - 1 * DAY,
      },
    },
    {
      type: "transaction",
      externalId: "txn-7002",
      tap: "api",
      title: "Cafe Verde",
      body: "Lunch.",
      occurredAt: now - 4 * HOUR,
      domainFields: {
        amount_cents: -1850,
        currency: "USD",
        account: "Credit Card",
        category: "Dining",
        merchant: "Cafe Verde",
        transaction_date: today0,
      },
    },
    {
      type: "transaction",
      externalId: "txn-7003",
      tap: "api",
      title: "Paycheck",
      body: "Monthly salary deposit.",
      occurredAt: now - 3 * DAY,
      domainFields: {
        amount_cents: 520_000,
        currency: "USD",
        account: "Checking",
        category: "Income",
        merchant: "Acme Corp Payroll",
        transaction_date: today0 - 3 * DAY,
      },
    },
  );

  // ------------------------------------------------------------ health_metrics
  items.push(
    {
      type: "health_metric",
      externalId: "health-8001",
      tap: "api",
      title: "Steps",
      body: "Daily step count.",
      occurredAt: now - 2 * HOUR,
      domainFields: {
        metric_type: "steps",
        value: 8421,
        unit: "steps",
        recorded_at: now - 2 * HOUR,
        source_device: "Fitness Band",
      },
    },
    {
      type: "health_metric",
      externalId: "health-8002",
      tap: "api",
      title: "Resting heart rate",
      body: "Morning resting heart rate.",
      occurredAt: today0 + 7 * HOUR,
      domainFields: {
        metric_type: "resting_heart_rate",
        value: 58,
        unit: "bpm",
        recorded_at: today0 + 7 * HOUR,
        source_device: "Fitness Band",
      },
    },
    {
      type: "health_metric",
      externalId: "health-8003",
      tap: "api",
      title: "Sleep duration",
      body: "Hours slept last night.",
      occurredAt: today0 + 6 * HOUR,
      domainFields: {
        metric_type: "sleep_hours",
        value: 7.2,
        unit: "hours",
        recorded_at: today0 + 6 * HOUR,
        source_device: "Fitness Band",
      },
    },
  );

  // -------------------------------------------------------------------- trip
  items.push({
    type: "trip",
    externalId: "trip-9001",
    tap: "manual",
    title: "Company offsite — Lisbon",
    body: "Annual engineering offsite. Flights + hotel booked.",
    occurredAt: today0 + 14 * DAY,
    domainFields: {
      destination: "Lisbon, Portugal",
      start_date: today0 + 14 * DAY,
      end_date: today0 + 18 * DAY,
      status: "booked",
      _segments: [
        {
          segment_type: "flight",
          start_at: today0 + 14 * DAY + 8 * HOUR,
          end_at: today0 + 14 * DAY + 12 * HOUR,
          confirmation_code: "FL7A2K",
          details: { carrier: "AirEx", flight_no: "AX188", seat: "14C" },
        },
        {
          segment_type: "hotel",
          start_at: today0 + 14 * DAY + 15 * HOUR,
          end_at: today0 + 18 * DAY + 11 * HOUR,
          confirmation_code: "HT9931",
          details: { hotel: "Baixa Grand", nights: 4 },
        },
      ],
    },
  });

  // ----------------------------------------------------------------- contacts
  items.push(
    {
      type: "contact",
      externalId: "contact-1101",
      tap: "manual",
      title: "Maya Okafor",
      body: "Engineering manager. Works on planning + infra.",
      domainFields: {
        display_name: "Maya Okafor",
        emails: ["maya@example.com"],
        phones: ["+1-555-0142"],
        company: "Acme Corp",
      },
    },
    {
      type: "contact",
      externalId: "contact-1102",
      tap: "manual",
      title: "Priya Nair",
      body: "Mentorship program lead.",
      domainFields: {
        display_name: "Priya Nair",
        emails: ["priya@example.com"],
        phones: [],
        company: "Acme Corp",
      },
    },
  );

  // ------------------------------------------------------------------- photo
  items.push({
    type: "photo",
    externalId: "photo-1201",
    tap: "filesystem",
    title: "Whiteboard sketch — search architecture",
    body: "Photo of the whiteboard from the architecture discussion.",
    occurredAt: now - 6 * DAY,
    domainFields: {
      file_path: "/Photos/2025/whiteboard-search-arch.jpg",
      taken_at: now - 6 * DAY,
      gps_lat: 38.7223,
      gps_lon: -9.1393,
      camera_model: "Pixel 8",
      width: 4032,
      height: 3024,
      perceptual_hash: "phash:9f3a1c7b",
    },
  });

  // --------------------------------------------------------------- bookmarks
  items.push(
    {
      type: "bookmark",
      externalId: "bookmark-1301",
      tap: "manual",
      title: "sqlite-vec: vector search in SQLite",
      body: "Extension bringing vector similarity search to SQLite.",
      url: "https://github.com/asg017/sqlite-vec",
      occurredAt: now - 7 * DAY,
      domainFields: {
        url: "https://github.com/asg017/sqlite-vec",
        folder_path: "/Dev/Tools",
        favicon_url: "https://github.com/favicon.ico",
      },
    },
    {
      type: "bookmark",
      externalId: "bookmark-1302",
      tap: "manual",
      title: "Local-first software",
      body: "Essay on local-first software principles.",
      url: "https://www.inkandswitch.com/local-first/",
      occurredAt: now - 20 * DAY,
      domainFields: {
        url: "https://www.inkandswitch.com/local-first/",
        folder_path: "/Reading",
        favicon_url: null,
      },
    },
  );

  // -------------------------------------------------------------- feed_items
  items.push(
    {
      type: "feed_item",
      externalId: "feeditem-1401",
      tap: "rss",
      title: "Shipping a local vector index",
      body: "How we added on-device semantic search without a cloud dependency, and what we learned about embedding batching.",
      url: "https://example.com/blog/local-vector-index",
      occurredAt: now - 1 * DAY,
      domainFields: {
        feed_id: SAMPLE_FEED_ID,
        url: "https://example.com/blog/local-vector-index",
        published_at: now - 1 * DAY,
        author: "The Example Team",
      },
    },
    {
      type: "feed_item",
      externalId: "feeditem-1402",
      tap: "rss",
      title: "Designing a crash-safe sync cursor",
      body: "A deep dive into idempotent upserts and post-commit cursor advancement for resumable connectors.",
      url: "https://example.com/blog/crash-safe-cursor",
      occurredAt: now - 4 * DAY,
      domainFields: {
        feed_id: SAMPLE_FEED_ID,
        url: "https://example.com/blog/crash-safe-cursor",
        published_at: now - 4 * DAY,
        author: "The Example Team",
      },
    },
  );

  // -------------------------------------------------------- ai_conversation
  items.push({
    type: "ai_conversation",
    externalId: "aiconv-1501",
    tap: "manual",
    title: "Brainstorm: search ranking",
    body: "A conversation about how to blend keyword and vector search scores for the new search feature.",
    occurredAt: now - 8 * HOUR,
    domainFields: {
      model_name: "qwen2.5-14b-instruct",
      started_at: now - 8 * HOUR,
      ended_at: now - 8 * HOUR + 20 * MIN,
      message_count: 4,
      _messages: [
        {
          role: "system",
          content: "You are a helpful search-ranking assistant.",
          token_count: 12,
          created_at: now - 8 * HOUR,
        },
        {
          role: "user",
          content: "How should I combine BM25 and cosine similarity into one ranking?",
          token_count: 18,
          created_at: now - 8 * HOUR + 1 * MIN,
        },
        {
          role: "assistant",
          content:
            "A common approach is reciprocal rank fusion: rank by each signal separately, then sum 1/(k+rank). It avoids score-scale mismatch between BM25 and cosine.",
          token_count: 44,
          created_at: now - 8 * HOUR + 2 * MIN,
        },
        {
          role: "user",
          content: "Great — what k do people use?",
          token_count: 9,
          created_at: now - 8 * HOUR + 3 * MIN,
        },
      ],
    },
  });

  // Stamp the fixture version into every item's metadata.
  for (const it of items) {
    it.metadata = { ...(it.metadata ?? {}), fixtureVersion: FIXTURE_VERSION };
  }

  return items;
}

/** Total number of items in the bundle (constant; drives deterministic paging). */
export function fixtureCount(): number {
  // Length is independent of `now`; use epoch 0 to count cheaply.
  return buildFixtureItems(0).length;
}
