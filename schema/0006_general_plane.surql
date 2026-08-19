-- voidarch-context :: general context plane (migration 0006)
-- Adds the all-purpose temporal knowledge layer alongside the repo-development
-- plane (0001-0005):
--   1. entity  : durable typed things (person, org, project, device, ...) with
--                aliases and free-form attrs — new human concepts need NO migration
--                (entity_type is an open string, attrs is schemaless).
--   2. episode : IMMUTABLE source observations (a message, a tool output, a web
--                page). Never updated, never deleted; everything derived points
--                back here as evidence.
--   3. fact    : derived knowledge with temporal validity, provenance, confidence,
--                and a write-policy status lifecycle
--                (candidate → proposed → confirmed; disputed/superseded/invalidated).
--                History is preserved: supersession stamps valid_to, never deletes.
--
-- Cross-plane references use string refs by convention:
--   entity:<id>, repo:<repo_id>, file:<repo_id>/<path>,
--   symbol:<repo_id>/<node_key>, task:<id>, doc:<repo_id>/<path>
-- so a fact can relate a person to a repo symbol without new DDL.
--
-- SCHEMALESS + IF NOT EXISTS throughout, matching 0001-0005; re-running is safe
-- and strictly non-destructive.

-- ===== 1. Entities ===========================================================
-- Shape (by convention): scope_id, entity_type, name, norm_name, aliases[],
-- attrs{}, sensitivity (public|internal|personal|secret), status (active|merged),
-- merged_into?, search_text, created_at, updated_at.
DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;

DEFINE INDEX IF NOT EXISTS entity_scope_idx      ON TABLE entity COLUMNS scope_id;
DEFINE INDEX IF NOT EXISTS entity_type_idx       ON TABLE entity COLUMNS scope_id, entity_type;
DEFINE INDEX IF NOT EXISTS entity_norm_name_idx  ON TABLE entity COLUMNS scope_id, norm_name;

DEFINE INDEX IF NOT EXISTS entity_search_fts
  ON TABLE entity COLUMNS search_text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- ===== 2. Episodes (immutable evidence) ======================================
-- Shape: scope_id, source (conversation|tool|git|web|email|document|manual),
-- source_ref, actor, trust (deterministic|user_explicit|agent_inference|external_content),
-- content, content_hash, occurred_at, ingested_at.
DEFINE TABLE IF NOT EXISTS episode SCHEMALESS;

DEFINE INDEX IF NOT EXISTS episode_scope_idx ON TABLE episode COLUMNS scope_id;
DEFINE INDEX IF NOT EXISTS episode_hash_idx  ON TABLE episode COLUMNS scope_id, content_hash;

DEFINE INDEX IF NOT EXISTS episode_content_fts
  ON TABLE episode COLUMNS content
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- ===== 3. Facts (temporal, evidenced, lifecycle-governed) ====================
-- Shape: scope_id, subject_ref, predicate, object_ref?, object_value?, statement,
-- status (candidate|proposed|confirmed|disputed|superseded|invalidated),
-- trust, confidence (0..1), sensitivity, provenance { episode_id, method, actor },
-- observed_at, valid_from, valid_to?, superseded_by?, contradicts[],
-- fact_key (dedupe key: scope+subject+predicate+object), created_at, updated_at.
DEFINE TABLE IF NOT EXISTS fact SCHEMALESS;

DEFINE INDEX IF NOT EXISTS fact_scope_idx    ON TABLE fact COLUMNS scope_id;
DEFINE INDEX IF NOT EXISTS fact_subject_idx  ON TABLE fact COLUMNS scope_id, subject_ref;
DEFINE INDEX IF NOT EXISTS fact_key_idx      ON TABLE fact COLUMNS scope_id, fact_key;
DEFINE INDEX IF NOT EXISTS fact_status_idx   ON TABLE fact COLUMNS scope_id, status;

DEFINE INDEX IF NOT EXISTS fact_statement_fts
  ON TABLE fact COLUMNS statement
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;
