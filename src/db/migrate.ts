import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./client";

/**
 * Runs the generated Drizzle migrations, THEN applies the hand-written raw-SQL
 * virtual-table migration (FTS5 + vec0). Idempotent — safe to re-run.
 * Invoked via `pnpm db:migrate`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

function run(): void {
  console.log("[migrate] applying Drizzle migrations from", MIGRATIONS_DIR);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  console.log("[migrate] applying raw virtual-table migration (FTS5 + vec0)");
  const rawSql = readFileSync(join(MIGRATIONS_DIR, "virtual_tables.sql"), "utf8");
  sqlite.exec(rawSql);

  console.log("[migrate] done");
}

run();
