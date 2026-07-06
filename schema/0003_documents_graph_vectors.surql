-- dev-flow-control dev-memory :: documents + graph + vectors (migration 0003)
-- Adds three retrieval channels on top of the BM25 file/decision/evidence core:
--   1. Document memory : heading-chunked markdown (document + doc_chunk)
--   2. Graph memory    : graphify nodes/edges/hyperedges + snapshots
--   3. Vector memory   : approval-gated embeddings (embedding_model + embedding_chunk)
--
-- SurrealDB remains the single shared backend. Every table is SCHEMALESS and every
-- statement uses IF NOT EXISTS, so re-running is safe and strictly non-destructive
-- (no DROP / REMOVE / DELETE). The `dfc_text` analyzer is defined in migration 0002;
-- this migration assumes 0001 + 0002 ran first (the runner applies them in order).

-- ===== 1. Document memory ====================================================
-- `doc_chunk` already exists (0001) and already carries the doc_chunk_text_fts BM25
-- index (0002); this migration REUSES doc_chunk as the chunk table and only adds a
-- parent `document` row plus secondary/summary indexes. (The roadmap's conceptual
-- "document_chunk" maps onto the pre-reserved doc_chunk table to avoid duplication.)
DEFINE TABLE IF NOT EXISTS document SCHEMALESS;

-- retrieval_run: optional audit trail of doc/graph/vector retrievals.
DEFINE TABLE IF NOT EXISTS retrieval_run SCHEMALESS;

DEFINE INDEX IF NOT EXISTS document_repo_idx      ON TABLE document      COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS document_hash_idx      ON TABLE document      COLUMNS content_hash;
DEFINE INDEX IF NOT EXISTS document_path_idx      ON TABLE document      COLUMNS repo_id, source_path;
DEFINE INDEX IF NOT EXISTS doc_chunk_repo_idx     ON TABLE doc_chunk     COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS doc_chunk_hash_idx     ON TABLE doc_chunk     COLUMNS content_hash;
DEFINE INDEX IF NOT EXISTS doc_chunk_path_idx     ON TABLE doc_chunk     COLUMNS repo_id, source_path;
DEFINE INDEX IF NOT EXISTS retrieval_run_repo_idx ON TABLE retrieval_run COLUMNS repo_id;

-- Full-text on chunk summaries (chunk text already indexed by doc_chunk_text_fts in 0002).
DEFINE INDEX IF NOT EXISTS doc_chunk_summary_fts
  ON TABLE doc_chunk COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- ===== 2. Graph memory =======================================================
-- Working tables for graphify knowledge-graph facts. The first implementation uses
-- a UNIFIED node/edge model (kind + relation fields) rather than one table per edge
-- kind: it maps cleanly onto graphify's node-link JSON, stays simple and reliable,
-- and still distinguishes file/module/symbol/concept/rationale nodes (graph_node.kind)
-- and contains/defines/calls/imports/references/implements/test/dependency/ownership
-- edges (graph_edge.relation). Granular per-kind edge tables remain a future option.
DEFINE TABLE IF NOT EXISTS graph_snapshot   SCHEMALESS; -- one row per import (commit, counts, freshness)
DEFINE TABLE IF NOT EXISTS graph_node       SCHEMALESS; -- files, modules, symbols, concepts, rationale
DEFINE TABLE IF NOT EXISTS graph_edge       SCHEMALESS; -- contains/defines/calls/imports/references/...
DEFINE TABLE IF NOT EXISTS graph_hyperedge  SCHEMALESS; -- god-node groupings (participate_in / form)
DEFINE TABLE IF NOT EXISTS graph_import_run SCHEMALESS; -- audit trail of dfc:graph:import invocations

DEFINE INDEX IF NOT EXISTS graph_snapshot_repo_idx   ON TABLE graph_snapshot   COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS graph_node_repo_idx       ON TABLE graph_node       COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS graph_node_kind_idx       ON TABLE graph_node       COLUMNS repo_id, kind;
DEFINE INDEX IF NOT EXISTS graph_node_key_idx        ON TABLE graph_node       COLUMNS repo_id, node_key;
DEFINE INDEX IF NOT EXISTS graph_node_file_idx       ON TABLE graph_node       COLUMNS repo_id, source_file;
DEFINE INDEX IF NOT EXISTS graph_edge_repo_idx       ON TABLE graph_edge       COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS graph_edge_src_idx        ON TABLE graph_edge       COLUMNS repo_id, src_key;
DEFINE INDEX IF NOT EXISTS graph_edge_dst_idx        ON TABLE graph_edge       COLUMNS repo_id, dst_key;
DEFINE INDEX IF NOT EXISTS graph_edge_rel_idx        ON TABLE graph_edge       COLUMNS repo_id, relation;
DEFINE INDEX IF NOT EXISTS graph_hyperedge_repo_idx  ON TABLE graph_hyperedge  COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS graph_import_run_repo_idx ON TABLE graph_import_run COLUMNS repo_id;

-- Full-text over a denormalized search_text (label + source_file + summary) for dfc:graph:query.
DEFINE INDEX IF NOT EXISTS graph_node_search_fts
  ON TABLE graph_node COLUMNS search_text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- ===== 3. Vector memory (approval-gated) =====================================
-- Embeddings are an OPTIONAL retrieval channel. The embedding provider must be
-- explicit (DFC_EMBED_PROVIDER) and paid APIs require approval; dfc:embed never
-- calls a paid service silently. This migration is intentionally DIMENSION-AGNOSTIC:
-- it does NOT define an MTREE/HNSW vector index (those need a fixed dimension).
-- Similarity is computed with deterministic cosine over the stored `embedding`
-- array; once a provider+dimension is pinned, a per-model MTREE index can be added
-- (DEFINE INDEX ... FIELDS embedding MTREE DIMENSION <n> DIST COSINE) — see docs.
DEFINE TABLE IF NOT EXISTS embedding_model SCHEMALESS; -- registry: provider + model + dimension
DEFINE TABLE IF NOT EXISTS embedding_chunk SCHEMALESS; -- one embedded chunk (text + vector)

DEFINE INDEX IF NOT EXISTS embedding_model_repo_idx  ON TABLE embedding_model COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS embedding_model_key_idx   ON TABLE embedding_model COLUMNS repo_id, provider, model;
DEFINE INDEX IF NOT EXISTS embedding_chunk_repo_idx  ON TABLE embedding_chunk COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS embedding_chunk_hash_idx  ON TABLE embedding_chunk COLUMNS content_hash;
DEFINE INDEX IF NOT EXISTS embedding_chunk_model_idx ON TABLE embedding_chunk COLUMNS repo_id, embedding_model;
DEFINE INDEX IF NOT EXISTS embedding_chunk_src_idx   ON TABLE embedding_chunk COLUMNS repo_id, source_type, source_id;
