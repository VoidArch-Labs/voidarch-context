-- dev-flow-control dev-memory :: analyzer + indexes (migration 0002)
-- Defines the text analyzer first, then the full-text (BM25) indexes that depend
-- on it, then a few plain indexes to keep repo-scoped lookups fast.
-- Idempotent: every statement uses IF NOT EXISTS.

-- Text analyzer shared by every full-text index. Tokenizes on whitespace, case
-- boundaries, camelCase and punctuation, then lowercases, strips non-ASCII, and
-- applies English stemming so "logging" matches "log".
DEFINE ANALYZER IF NOT EXISTS dfc_text
  TOKENIZERS blank, class, camel, punct
  FILTERS lowercase, ascii, snowball(english);

-- Full-text indexes (BM25 scoring + highlight support).
DEFINE INDEX IF NOT EXISTS file_content_fts
  ON TABLE file COLUMNS content
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS doc_chunk_text_fts
  ON TABLE doc_chunk COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS decision_summary_fts
  ON TABLE decision COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS evidence_summary_fts
  ON TABLE evidence_item COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS task_goal_fts
  ON TABLE task COLUMNS goal
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS context_pack_goal_fts
  ON TABLE context_pack COLUMNS goal
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS verification_summary_fts
  ON TABLE verification_run COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- Plain secondary indexes for repo-scoped filtering.
DEFINE INDEX IF NOT EXISTS file_repo_idx          ON TABLE file             COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS decision_repo_idx      ON TABLE decision         COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS evidence_repo_idx      ON TABLE evidence_item    COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS task_repo_idx          ON TABLE task             COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS context_pack_repo_idx  ON TABLE context_pack     COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS verification_repo_idx  ON TABLE verification_run COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS approval_repo_idx      ON TABLE approval         COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS agent_run_repo_idx     ON TABLE agent_run        COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS tool_event_repo_idx    ON TABLE tool_event       COLUMNS repo_id;

DEFINE INDEX IF NOT EXISTS decision_agent_idx     ON TABLE decision         COLUMNS source_agent;
DEFINE INDEX IF NOT EXISTS evidence_agent_idx     ON TABLE evidence_item    COLUMNS source_agent;
DEFINE INDEX IF NOT EXISTS agent_run_agent_idx    ON TABLE agent_run        COLUMNS source_agent;
DEFINE INDEX IF NOT EXISTS tool_event_agent_idx   ON TABLE tool_event       COLUMNS source_agent;
