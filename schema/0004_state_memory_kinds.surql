-- dev-flow-control dev-memory :: state + memory kinds (migration 0004)
-- Adds:
--   1. New memory kinds : lesson, snippet, repo_fact (same shape as decision/evidence)
--   2. Blocker state    : blocker (status open|resolved, optional task/session links)
--   3. Indexes          : per-kind repo + FTS indexes following the 0002 pattern
--
-- The existing `task` table (0001) gains no DDL here — it is SCHEMALESS and task
-- state rows simply add `status` (open|in_progress|blocked|done) + `updated_at`.
-- Every statement uses IF NOT EXISTS; re-running is safe and non-destructive.

-- ===== 1. New memory kinds ===================================================
-- lesson    : "we learned X the hard way" — postmortem-grade guidance.
-- snippet   : reusable code fragment (fields: text=code, language, source_path).
-- repo_fact : stable fact about the repo ("CI needs Node 22", "schema lives in schema/").
DEFINE TABLE IF NOT EXISTS lesson    SCHEMALESS;
DEFINE TABLE IF NOT EXISTS snippet   SCHEMALESS;
DEFINE TABLE IF NOT EXISTS repo_fact SCHEMALESS;

DEFINE INDEX IF NOT EXISTS lesson_repo_idx    ON TABLE lesson    COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS snippet_repo_idx   ON TABLE snippet   COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS repo_fact_repo_idx ON TABLE repo_fact COLUMNS repo_id;

DEFINE INDEX IF NOT EXISTS lesson_summary_fts
  ON TABLE lesson COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS lesson_text_fts
  ON TABLE lesson COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS snippet_summary_fts
  ON TABLE snippet COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS snippet_text_fts
  ON TABLE snippet COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS repo_fact_summary_fts
  ON TABLE repo_fact COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS repo_fact_text_fts
  ON TABLE repo_fact COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- Also index decision/evidence full text (0002 only indexed their summaries).
DEFINE INDEX IF NOT EXISTS decision_text_fts
  ON TABLE decision COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS evidence_text_fts
  ON TABLE evidence_item COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- ===== 2. Blocker state ======================================================
-- One row per blocker. Shape (SCHEMALESS, by convention):
--   repo_id, source_agent, text, summary, tags[], status (open|resolved),
--   task_goal?, session_id?, created_at, updated_at, resolved_at?
DEFINE TABLE IF NOT EXISTS blocker SCHEMALESS;

DEFINE INDEX IF NOT EXISTS blocker_repo_idx   ON TABLE blocker COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS blocker_status_idx ON TABLE blocker COLUMNS repo_id, status;

DEFINE INDEX IF NOT EXISTS blocker_summary_fts
  ON TABLE blocker COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

-- ===== 3. Task state indexes =================================================
-- task rows (0001) now carry status; index the repo+status lookup used by
-- dfc:task list / dfc:metrics / the dashboard.
DEFINE INDEX IF NOT EXISTS task_repo_idx   ON TABLE task COLUMNS repo_id;
DEFINE INDEX IF NOT EXISTS task_status_idx ON TABLE task COLUMNS repo_id, status;
