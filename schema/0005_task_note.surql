-- dev-flow-control dev-memory :: task_note memory kind (migration 0005)
-- 6th memory kind alongside decision/evidence/lesson/snippet/repo_fact:
--   task_note : freeform running notes tied to a task (progress, TODOs, context
--   the agent wants to keep across turns without the weight of a decision).
-- Same shape/pattern as lesson/snippet/repo_fact (0004). IF NOT EXISTS throughout;
-- re-running is safe and non-destructive.

DEFINE TABLE IF NOT EXISTS task_note SCHEMALESS;

DEFINE INDEX IF NOT EXISTS task_note_repo_idx ON TABLE task_note COLUMNS repo_id;

DEFINE INDEX IF NOT EXISTS task_note_summary_fts
  ON TABLE task_note COLUMNS summary
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS task_note_text_fts
  ON TABLE task_note COLUMNS text
  FULLTEXT ANALYZER dfc_text BM25 HIGHLIGHTS;
