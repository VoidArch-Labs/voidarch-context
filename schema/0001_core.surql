-- dev-flow-control dev-memory :: core tables (migration 0001)
-- Applied by `pnpm dfc:db:migrate` through the SurrealDB TypeScript SDK.
-- Tables are SCHEMALESS so the first slice can evolve without rigid migrations;
-- full-text indexes (migration 0002) only require the indexed field to exist.
-- All statements use IF NOT EXISTS so re-running is safe and non-destructive.

-- One row per indexed repository (id = type::thing('repo', <repo_id>)).
DEFINE TABLE IF NOT EXISTS repo SCHEMALESS;

-- One row per ingested repo text file (id = type::thing('file', sha256(repo_id:path))).
DEFINE TABLE IF NOT EXISTS file SCHEMALESS;

-- Reserved for chunked document text (populated by a later ingestion pass).
DEFINE TABLE IF NOT EXISTS doc_chunk SCHEMALESS;

-- Remembered decisions ("we chose X because Y").
DEFINE TABLE IF NOT EXISTS decision SCHEMALESS;

-- Remembered evidence / observations that should inform future planning.
DEFINE TABLE IF NOT EXISTS evidence_item SCHEMALESS;

-- Tasks a context pack was built for (lightweight audit trail).
DEFINE TABLE IF NOT EXISTS task SCHEMALESS;

-- Persisted context packs (history of what was assembled for each task).
DEFINE TABLE IF NOT EXISTS context_pack SCHEMALESS;

-- Verification runs (reserved; consumed by context packs as last_failures).
DEFINE TABLE IF NOT EXISTS verification_run SCHEMALESS;

-- Scoped approval records (reserved; surfaced as workflow.approval_available).
DEFINE TABLE IF NOT EXISTS approval SCHEMALESS;

-- Agent run summaries from Codex, Claude Code, or manual imports.
DEFINE TABLE IF NOT EXISTS agent_run SCHEMALESS;

-- Tool events emitted by agents while working on the repo.
DEFINE TABLE IF NOT EXISTS tool_event SCHEMALESS;
