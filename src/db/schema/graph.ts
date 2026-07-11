import { AnySQLiteColumn, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { items } from "./core";

/**
 * Property-graph tables — schema migrated in Phase 0, populated in Phase 3.
 * Transcribed from BUILD_SPEC §3.2.
 */

export interface ProvenanceEntry {
  itemId: string;
  method: string;
  confidence: number;
  extractedAt: number;
}

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(), // ULID
    // Person|Organization|Project|Paper|Topic|Place|Event|Tool|Goal|...
    type: text("type").notNull(),
    name: text("name").notNull(),
    aliases: text("aliases", { mode: "json" }).$type<string[]>(),
    description: text("description"),
    attributes: text("attributes", { mode: "json" }).$type<Record<string, unknown>>(),
    // set when merged (dedupe); self-reference, no cascade
    canonicalEntityId: text("canonical_entity_id").references(
      (): AnySQLiteColumn => entities.id,
    ),
    confidence: real("confidence").notNull().default(1.0),
    mentionCount: integer("mention_count").notNull().default(0),
    provenance: text("provenance", { mode: "json" }).$type<ProvenanceEntry[]>(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    entitiesTypeNameIdx: index("entities_type_name_idx").on(t.type, t.name),
    entitiesCanonicalIdx: index("entities_canonical_idx").on(t.canonicalEntityId),
  }),
);

export const edges = sqliteTable(
  "edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // CHECK enforced via raw SQL in the generated migration.
    srcKind: text("src_kind", { enum: ["entity", "item"] }).notNull(),
    srcId: text("src_id").notNull(), // polymorphic, NOT a SQL FK (Graph Service enforces)
    dstKind: text("dst_kind", { enum: ["entity", "item"] }).notNull(),
    dstId: text("dst_id").notNull(),
    // mentions|authored_by|attended|relates_to|part_of|located_in|similar_to|...
    relation: text("relation").notNull(),
    weight: real("weight").notNull().default(1.0),
    confidence: real("confidence").notNull().default(1.0),
    method: text("method").notNull(), // deterministic|llm_extraction|embedding_similarity
    primarySourceItemId: text("primary_source_item_id").references(() => items.id, {
      onDelete: "set null",
    }),
    provenance: text("provenance", { mode: "json" }).$type<ProvenanceEntry[]>(),
    attributes: text("attributes", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    edgesSrcIdx: index("edges_src_idx").on(t.srcKind, t.srcId),
    edgesDstIdx: index("edges_dst_idx").on(t.dstKind, t.dstId),
    edgesRelationIdx: index("edges_relation_idx").on(t.relation),
  }),
);

export const entityEmbeddingMeta = sqliteTable("entity_embedding_meta", {
  entityId: text("entity_id")
    .primaryKey()
    .references(() => entities.id, { onDelete: "cascade" }),
  modelName: text("model_name").notNull(),
  dims: integer("dims").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
