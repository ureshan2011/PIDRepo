import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema";

/**
 * Opens the single durable SQLite database, applies the required PRAGMAs, and
 * loads the `sqlite-vec` extension BEFORE any query runs. Exports both the
 * Drizzle instance (`db`) and the raw better-sqlite3 handle (`sqlite`) for the
 * hand-written vector/FTS SQL that Drizzle can't model.
 *
 * The connection is memoized on `globalThis` so Next.js dev hot-reload and the
 * worker process don't open competing handles within one runtime.
 */

const DB_PATH = process.env.PID_DB_PATH ?? "./pid.sqlite";

type PidConn = { sqlite: Database.Database; db: ReturnType<typeof drizzle<typeof schema>> };

const globalForDb = globalThis as unknown as { __pidConn?: PidConn };

function createConnection(): PidConn {
  const sqlite = new Database(DB_PATH);

  // Load the vector extension first — must happen before any query touches vec0.
  sqliteVec.load(sqlite);

  // Durability + concurrency pragmas (BUILD_SPEC §Phase 0 / §5).
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

const conn = globalForDb.__pidConn ?? createConnection();
if (process.env.NODE_ENV !== "production") {
  globalForDb.__pidConn = conn;
}

export const sqlite = conn.sqlite;
export const db = conn.db;
export { schema };
