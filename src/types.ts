// Shared types for the dev-flow-control SurrealDB dev-memory slice.

export type MemoryKind = "decision" | "evidence" | "lesson" | "snippet" | "repo_fact" | "task_note";
export type SourceAgent = "manual" | "codex" | "claude" | "grok-build";
export type Phase = "discuss" | "plan" | "execute" | "verify" | "ship";

/** Resolved connection + scope configuration (env overrides the .dfc files). */
export interface DfcConfig {
  url: string;
  namespace: string;
  database: string;
  repoId: string;
  username: string;
  password: string;
  authScope: "root" | "namespace" | "database";
}

/** A single ingested repo text file. */
export interface FileRecord {
  repo_id: string;
  source_agent: SourceAgent;
  path: string;
  ext: string;
  size: number;
  mtime: string; // ISO-8601
  content: string;
  content_hash: string; // sha256 of content
  ingested_at: string; // ISO-8601
}

/** A remembered decision/evidence/lesson/snippet/repo-fact item. */
export interface MemoryRecord {
  repo_id: string;
  source_agent: SourceAgent;
  text: string;
  summary: string;
  tags: string[];
  task_goal?: string;
  language?: string; // snippet kind only
  source_path?: string; // snippet kind only
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
}

export type TaskStatus = "open" | "in_progress" | "blocked" | "done";

/** Task state row (`task` table; legacy context-pack audit rows carry no status). */
export interface TaskStateRecord {
  repo_id: string;
  source_agent: SourceAgent;
  goal: string;
  status: TaskStatus;
  tags: string[];
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  done_at?: string; // ISO-8601
}

/** Blocker state row (`blocker` table, schema 0004). */
export interface BlockerRecord {
  repo_id: string;
  source_agent: SourceAgent;
  text: string;
  summary: string;
  tags: string[];
  status: "open" | "resolved";
  task_goal?: string;
  session_id?: string;
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  resolved_at?: string; // ISO-8601
}

// ---- Context-pack output shape (stable JSON contract for /dfc-context) ----

export interface ContextFileEntry {
  path: string;
  ext: string;
  size: number;
  score: number;
  excerpt: string;
}

export interface ContextMemoryEntry {
  summary: string;
  tags: string[];
  source_agent: SourceAgent | string;
  created_at: string;
  score: number;
  lifecycle?: {
    status: "active" | "pending_review" | "stale" | "superseded";
    confidence?: number;
    last_verified_at?: string;
    stale_reason?: string;
    superseded_by?: string;
  };
  reason?: string;
}

/** Snippet memory entry: memory shape + code excerpt and optional provenance. */
export interface ContextSnippetEntry extends ContextMemoryEntry {
  excerpt: string;
  language?: string;
  source_path?: string;
}

/** Open blocker surfaced as live state (not a similarity hit). */
export interface ContextBlockerEntry {
  summary: string;
  status: string;
  created_at: string;
  task_goal?: string;
  session_id?: string;
}

/** Non-done task surfaced as live state. */
export interface ContextTaskStateEntry {
  goal: string;
  status: string;
  created_at: string;
}

export interface ContextAgentRunEntry {
  source_agent: SourceAgent | string;
  task_goal: string;
  status: string;
  summary: string;
  created_at: string;
  score: number;
}

export interface ContextToolEventEntry {
  source_agent: SourceAgent | string;
  tool_name: string;
  action: string;
  summary: string;
  success: boolean | null;
  created_at: string;
  score: number;
}

// ---- Document memory (Stage 1) ----------------------------------------------

/** A single heading-scoped markdown chunk (stored in the `doc_chunk` table). */
export interface DocChunkRecord {
  repo_id: string;
  source_agent: SourceAgent;
  source_type: string; // readme | agents | doc | template | skill | agent_md | markdown
  source_path: string;
  source_title: string;
  heading: string;
  chunk_index: number;
  text: string;
  summary: string;
  token_estimate: number;
  content_hash: string; // sha256 of text
  created_at: string;
  updated_at: string;
}

/** Parent document row (one per ingested source file; `document` table). */
export interface DocumentRecord {
  repo_id: string;
  source_agent: SourceAgent;
  source_type: string;
  source_path: string;
  source_title: string;
  chunk_count: number;
  token_estimate: number;
  content_hash: string; // sha256 of full file content
  created_at: string;
  updated_at: string;
}

// ---- Graph memory (Stage 2) -------------------------------------------------

export interface GraphSnapshotRecord {
  repo_id: string;
  source_agent: SourceAgent;
  snapshot_id: string;
  built_at_commit: string;
  current_commit: string;
  is_fresh: boolean; // built_at_commit === current_commit
  node_count: number;
  edge_count: number;
  hyperedge_count: number;
  relation_counts: Record<string, number>;
  kind_counts: Record<string, number>;
  created_at: string;
}

export interface GraphNodeRecord {
  repo_id: string;
  source_agent: SourceAgent;
  snapshot_id: string;
  node_key: string; // graphify node id (stable within a snapshot)
  label: string;
  norm_label: string;
  kind: string; // file | module | symbol | concept | rationale | ...
  file_type: string; // graphify file_type
  source_file: string;
  source_location: string;
  community: number | null;
  origin: string; // graphify _origin (ast | ...)
  degree: number; // edges touching this node (precomputed for proximity/impact scoring)
  search_text: string; // denormalized: label + source_file + summary
  created_at: string;
}

export interface GraphEdgeRecord {
  repo_id: string;
  source_agent: SourceAgent;
  snapshot_id: string;
  src_key: string;
  dst_key: string;
  relation: string; // contains | defines | calls | imports | imports_from | references | implements | test | depends_on | owns | ...
  weight: number;
  confidence: string;
  confidence_score: number;
  source_file: string;
  source_location: string;
  created_at: string;
}

export interface GraphHyperedgeRecord {
  repo_id: string;
  source_agent: SourceAgent;
  snapshot_id: string;
  hyper_key: string;
  label: string;
  relation: string; // participate_in | form | ...
  members: string[];
  confidence: string;
  confidence_score: number;
  source_file: string;
  created_at: string;
}

// ---- Vector memory (Stage 3) ------------------------------------------------

export interface EmbeddingModelRecord {
  repo_id: string;
  provider: string;
  model: string;
  dimension: number;
  created_at: string;
  updated_at: string;
}

export interface EmbeddingChunkRecord {
  repo_id: string;
  source_type: string; // doc_chunk | file | decision | evidence_item | ...
  source_id: string;
  chunk_id: string;
  text: string;
  embedding: number[];
  embedding_model: string; // "<provider>:<model>"
  embedding_dimension: number;
  provider: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

// ---- Hybrid context-pack entries (Stage 4) ----------------------------------

export interface ContextSymbolEntry {
  label: string;
  kind: string;
  source_file: string;
  source_location: string;
  score: number;
}

export interface ContextGraphEdgeEntry {
  src: string;
  dst: string;
  relation: string;
  source_file: string;
  score: number;
}

export interface ContextDocChunkEntry {
  source_path: string;
  source_title: string;
  heading: string;
  chunk_index: number;
  excerpt: string;
  score: number;
}

export interface ContextVectorChunkEntry {
  source_type: string;
  source_id: string;
  chunk_id: string;
  excerpt: string;
  similarity: number;
  score: number;
}

// ---- General-plane entries (Stage 5, migration 0006) -------------------------

export interface ContextEntityEntry {
  ref: string; // entity:<id>
  name: string;
  entity_type: string;
  aliases: string[];
  score: number;
}

export interface ContextFactEntry {
  subject_ref: string;
  predicate: string;
  object: string; // object_ref or rendered object_value
  statement: string;
  status: string; // confirmed facts only unless includeCandidates
  confidence: number;
  observed_at: string;
  provenance_method: string;
  score: number;
}

/** Immutable evidence recalled from a source episode. Never authoritative. */
export interface ContextEpisodeEntry {
  ref: string;
  source: string;
  source_ref: string;
  actor: string;
  trust: string;
  content: string;
  occurred_at: string;
  score: number;
}

export interface ContextPack {
  task: { goal: string; phase: Phase };
  query_plan?: {
    mode: "hybrid" | "semantic" | "graph" | "memory" | "debug" | "safety";
    terms: string[];
    risk_terms: string[];
    channels: Array<{ channel: string; reason: string; target_items: number }>;
  };
  repo_context: {
    files: ContextFileEntry[];
    symbols: ContextSymbolEntry[];
    graph_neighborhood: ContextGraphEdgeEntry[];
  };
  document_context: { chunks: ContextDocChunkEntry[] };
  vector_context: { chunks: ContextVectorChunkEntry[] };
  memory_context: {
    decisions: ContextMemoryEntry[];
    evidence: ContextMemoryEntry[];
    lessons: ContextMemoryEntry[];
    repo_facts: ContextMemoryEntry[];
    snippets: ContextSnippetEntry[];
    task_notes: ContextMemoryEntry[];
  };
  /** General plane (entities + temporal facts); empty pre-0006 or when disabled. */
  general_context: {
    entities: ContextEntityEntry[];
    facts: ContextFactEntry[];
    episodes: ContextEpisodeEntry[];
  };
  state: {
    open_blockers: ContextBlockerEntry[];
    open_tasks: ContextTaskStateEntry[];
  };
  verification: { last_failures: string[] };
  workflow: { approval_required: string[]; approval_available: string[] };
  agent_context: {
    recent_runs: ContextAgentRunEntry[];
    recent_tool_events: ContextToolEventEntry[];
  };
  token_budget: {
    target_tokens: number;
    estimated_tokens: number;
    dropped_items: string[];
  };
}
