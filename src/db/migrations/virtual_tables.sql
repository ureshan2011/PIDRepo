-- Hand-written raw-SQL migration for the three virtual tables + FTS triggers.
-- Drizzle Kit cannot model vec0 / fts5 virtual tables, so `db:migrate` applies
-- this file AFTER the generated Drizzle migrations. Everything here is idempotent
-- (IF NOT EXISTS) so re-running is harmless. From BUILD_SPEC §3.1 / §3.2.

-- sqlite-vec chunk embeddings; rowid == chunks.id set explicitly on insert.
-- 768 = default nomic-embed-text dim (build-time constant).
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(embedding FLOAT[768]);

-- sqlite-vec entity embeddings (populated Phase 3).
CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(embedding FLOAT[768]);

-- FTS5 external-content index over items (items keeps its implicit integer rowid).
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title, body, content='items', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
