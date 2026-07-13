# Quickstart — verify what's built

5 commands to a running app, then a checklist to verify every feature shipped so far.
Everything below works **without LM Studio** — LM Studio only upgrades the AI briefing
from a fallback list to a real generated one. Nothing else depends on it.

## 1. Run it

```bash
pnpm install
pnpm db:migrate
pnpm db:seed          # seeds settings + registers the sample data source
pnpm dev &             # app at http://localhost:3000
pnpm worker &          # background job processor — required, run it too
```

Log in with passphrase **`pid-dev`** (the dev default; see `.env.local.example` to change it).

The worker is what actually processes the seed data into tasks/notes/events/chunks —
without it running, Overview/Tasks/Notes will look empty. Give it ~10–15 seconds after
`db:seed` before checking the UI.

## 2. Verify each feature

| # | Feature | How to check |
|---|---|---|
| 1 | **Auth gate** | Open an incognito tab to `/overview` while logged out → redirects to `/login`. |
| 2 | **Seed connector + worker pipeline** | Settings → Connections → "Sample Data" shows status `OK`. Refresh a few times if it's still syncing. |
| 3 | **Executive Overview** | `/overview` shows today's tasks, today's events, and a briefing card (real AI text if LM Studio is running, otherwise a "Briefing unavailable — showing raw highlights" fallback list — both count as working). |
| 4 | **Tasks CRUD** | `/tasks` → create a task, mark it done, delete it. Refresh the page — changes persist. |
| 5 | **Notes CRUD** | `/notes` → create, edit, pin, delete a note. |
| 6 | **Goals + milestones** | `/goals` → create a goal, add a milestone, mark it done → progress % updates. |
| 7 | **Document upload + parsing** | `/documents` → drag in a `.pdf`, `.docx`, `.pptx`, `.txt`, or `.md` file. Status flips `Pending → Parsed` within a few seconds (worker must be running). |
| 8 | **Settings / LM Studio health** | `/settings` shows the configured LM Studio URL + model names. `curl http://localhost:3000/api/health/lm-studio` returns `reachable:false` if LM Studio isn't running (not a crash) — that's correct degrade-loudly behavior. |
| 9 | **Crash-safe sync (optional, more involved)** | Kill the worker mid-sync (`kill %2` right after `db:seed`), restart it (`pnpm worker &`), confirm item counts in Settings → Connections don't duplicate. |
| 10 | **Outlook cross-tap dedupe (optional, dev-only)** | `pnpm db:seed:outlook && pnpm worker` (briefly) → Settings → Connections shows an "Outlook (collector)" source; the demo proves one email seen via two taps collapses to a single item (see terminal output / DB, not user-facing UI yet). |

## 3. Optional: turn on real AI

Install [LM Studio](https://lmstudio.ai), load a chat model and an embedding model, start
its local server (default `http://localhost:1234/v1`), then set the model names on
`/settings`. Refresh `/overview` — the briefing card switches from the fallback list to a
real generated summary, and Documents you uploaded start getting embedded (check
`/settings` → LM Studio health for `reachable:true`).

## 4. Not yet testable here

- **The actual Windows Outlook Collector** (`collector/` package) — Windows-only at
  runtime (registry, Outlook COM, DPAPI). Build/run/install instructions are in
  `collector/README.md`; test it on a real Windows machine with an Outlook account.
- **Real connectors beyond the seed** (GitHub, Google Drive, etc.) and **Phase 3+**
  (knowledge graph, Smart Search, Insights, AI Assistant) — not built yet.

## Troubleshooting

- **Blank Overview/Tasks after seeding** → the worker isn't running or hasn't caught up
  yet. `pnpm worker` must run continuously alongside `pnpm dev` in development.
- **Port already in use** → something else is bound to 3000; stop it or edit the `dev`/
  `start` scripts in `package.json`.
- **Wrong passphrase** → dev default is `pid-dev` unless you've set `PID_PASSPHRASE_HASH`
  in `.env.local`.
- **Start fresh** → stop both processes, delete `pid.sqlite*` and `uploads/`, repeat step 1.
