// Build a compact, token-budgeted context pack for a task from SurrealDB.
// Read-only: queries the DB, scores candidates deterministically, and assembles
// the stable ContextPack JSON contract consumed by the /dfc-context skill.

import type { Surreal } from "surrealdb";
import type {
  ContextAgentRunEntry,
  ContextBlockerEntry,
  ContextDocChunkEntry,
  ContextFileEntry,
  ContextGraphEdgeEntry,
  ContextMemoryEntry,
  ContextPack,
  ContextSnippetEntry,
  ContextSymbolEntry,
  ContextTaskStateEntry,
  ContextToolEventEntry,
  ContextVectorChunkEntry,
  Phase,
} from "./types.js";
import {
  detectRiskTerms,
  estimateTokens,
  inferPhase,
  scoreAgentRun,
  scoreFile,
  scoreMemory,
  scoreToolEvent,
  tokenize,
} from "./scoring.js";
import { ftSearchTerms, queryResult } from "./surreal.js";
import { queryDocChunks } from "./docs.js";
import { neighborhoodEdges, queryGraphNodes } from "./graph.js";
import { queryVectors, resolveEmbedConfig } from "./vectors.js";

// Slightly higher than the file-only era to leave room for the hybrid channels;
// greedy budgeting still drops the lowest-priority items past this ceiling.
const TARGET_TOKENS = 3200;

/** Map a detected risk keyword to the human-readable gated action it implies. */
const RISK_TO_ACTION: Record<string, string> = {
  approval: "human approval gate",
  approve: "human approval gate",
  push: "git push to protected branch",
  force: "git push --force / --force-with-lease",
  deploy: "deploy to production",
  release: "release / publish",
  publish: "publish package",
  merge: "merge pull request",
  prod: "production change",
  production: "production change",
  secret: "access secrets",
  credential: "access credentials",
  token: "access tokens",
  delete: "destructive delete",
  drop: "drop database / table",
  destroy: "destructive operation",
  billing: "billing change",
  payment: "payment",
};

interface FileRow {
  path: string;
  ext: string;
  size: number;
  content: string;
  ftScore?: number;
}

interface MemoryRow {
  summary: string;
  text: string;
  tags: unknown;
  source_agent?: string;
  created_at: unknown;
  review_status?: string;
  confidence?: number;
  last_verified_at?: unknown;
  stale_reason?: string;
  superseded_by?: string;
}

interface SnippetRow extends MemoryRow {
  language?: string;
  source_path?: string;
}

interface BlockerRow {
  summary?: string;
  status?: string;
  task_goal?: string;
  session_id?: string;
  created_at: unknown;
}

interface TaskStateRow {
  goal?: string;
  status?: string;
  created_at: unknown;
}

interface AgentRunRow {
  source_agent?: string;
  task_goal?: string;
  status?: string;
  summary?: string;
  created_at: unknown;
}

interface ToolEventRow {
  source_agent?: string;
  tool_name?: string;
  action?: string;
  summary?: string;
  success?: boolean | null;
  created_at: unknown;
}

/** Normalize a SurrealDB datetime (Date or string) to an ISO string. */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v ?? "");
}

/** Build a short excerpt centered on the first matching term. */
function excerpt(content: string, terms: string[], max = 320): string {
  if (!content) return "";
  const low = content.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  const start = idx === -1 ? 0 : Math.max(0, idx - 60);
  return content.slice(start, start + max).replace(/\s+/g, " ").trim();
}

function lifecycleHint(r: MemoryRow): ContextMemoryEntry["lifecycle"] {
  const staleReason = String(r.stale_reason || "");
  const supersededBy = String(r.superseded_by || "");
  const review = String(r.review_status || "");
  const lastVerifiedAt = toIso(r.last_verified_at);
  return {
    status: supersededBy ? "superseded" : staleReason ? "stale" : review === "pending" ? "pending_review" : "active",
    confidence: typeof r.confidence === "number" ? r.confidence : undefined,
    last_verified_at: lastVerifiedAt || undefined,
    stale_reason: staleReason || undefined,
    superseded_by: supersededBy || undefined,
  };
}

function lifecyclePenalty(lifecycle: ContextMemoryEntry["lifecycle"]): number {
  if (lifecycle?.status === "superseded") return 0.15;
  if (lifecycle?.status === "stale") return 0.35;
  if (lifecycle?.status === "pending_review") return 0.75;
  return 1;
}

function buildQueryPlan(
  goal: string,
  terms: string[],
  riskTerms: string[],
): ContextPack["query_plan"] {
  const lower = goal.toLowerCase();
  const mode =
    riskTerms.length ? "safety" :
    /\b(fail|error|debug|test|ci|regression)\b/.test(lower) ? "debug" :
    /\b(graph|dependency|impact|architecture|call|symbol)\b/.test(lower) ? "graph" :
    /\b(decision|lesson|memory|remember|why)\b/.test(lower) ? "memory" :
    /\b(similar|semantic|related|context)\b/.test(lower) ? "semantic" :
    "hybrid";

  return {
    mode,
    terms,
    risk_terms: riskTerms,
    channels: [
      { channel: "files", reason: "BM25 and path matches anchor task-specific code.", target_items: 20 },
      { channel: "docs", reason: "Documentation chunks capture setup and product rules.", target_items: 8 },
      { channel: "memory", reason: "Durable decisions, evidence, lessons, and repo facts preserve prior context.", target_items: 10 },
      { channel: "graph", reason: "Graph nodes and neighborhoods expose symbols, dependencies, and freshness.", target_items: 8 },
      { channel: "vectors", reason: "Local embeddings add semantic recall when indexed chunks exist.", target_items: 6 },
      { channel: "state", reason: "Open tasks and blockers prevent stale or conflicting work.", target_items: 10 },
      { channel: "runs", reason: "Recent runs and tool events explain verification and failure history.", target_items: 8 },
    ],
  };
}

async function fetchMemory(
  db: Surreal,
  table: "decision" | "evidence_item" | "lesson" | "repo_fact" | "task_note",
  repoId: string,
  terms: string[],
  riskTerms: string[],
  now: number,
): Promise<ContextMemoryEntry[]> {
  const rows = await queryResult<MemoryRow[]>(
    db,
    `SELECT summary, text, tags, source_agent, created_at, review_status, confidence,
            last_verified_at, stale_reason, superseded_by FROM type::table($t)
     WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 40`,
    { t: table, repo: repoId },
  );
  return rows
    .map((r) => {
      const createdIso = toIso(r.created_at);
      const ageDays = createdIso
        ? Math.max(0, (now - new Date(createdIso).getTime()) / 86_400_000)
        : 9999;
      const summary = r.summary || (r.text || "").slice(0, 120);
      const lifecycle = lifecycleHint(r);
      const baseScore = scoreMemory(
        { summary, text: r.text || "", ageDays },
        terms,
        riskTerms,
      );
      return {
        summary,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        source_agent: r.source_agent || "manual",
        created_at: createdIso,
        lifecycle,
        reason: `${table} memory matched task terms; lifecycle=${lifecycle?.status ?? "active"}`,
        score: Math.round(baseScore * lifecyclePenalty(lifecycle) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

async function fetchSnippets(
  db: Surreal,
  repoId: string,
  terms: string[],
  riskTerms: string[],
  now: number,
): Promise<ContextSnippetEntry[]> {
  const rows = await queryResult<SnippetRow[]>(
    db,
    `SELECT summary, text, tags, source_agent, language, source_path, created_at, review_status,
            confidence, last_verified_at, stale_reason, superseded_by FROM snippet
     WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 40`,
    { repo: repoId },
  );
  return rows
    .map((r) => {
      const createdIso = toIso(r.created_at);
      const ageDays = createdIso
        ? Math.max(0, (now - new Date(createdIso).getTime()) / 86_400_000)
        : 9999;
      const summary = r.summary || (r.text || "").slice(0, 120);
      const lifecycle = lifecycleHint(r);
      const baseScore = scoreMemory(
        { summary, text: r.text || "", ageDays },
        terms,
        riskTerms,
      );
      return {
        summary,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        source_agent: r.source_agent || "manual",
        created_at: createdIso,
        lifecycle,
        reason: `snippet memory matched task terms; lifecycle=${lifecycle?.status ?? "active"}`,
        excerpt: excerpt(r.text || "", terms),
        language: r.language || undefined,
        source_path: r.source_path || undefined,
        score: Math.round(baseScore * lifecyclePenalty(lifecycle) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

async function fetchOpenBlockers(db: Surreal, repoId: string): Promise<ContextBlockerEntry[]> {
  const rows = await queryResult<BlockerRow[]>(
    db,
    `SELECT summary, status, task_goal, session_id, created_at FROM blocker
     WHERE repo_id = $repo AND status = 'open' ORDER BY created_at DESC LIMIT 10`,
    { repo: repoId },
  );
  return rows.map((r) => ({
    summary: r.summary || "",
    status: r.status || "open",
    created_at: toIso(r.created_at),
    task_goal: r.task_goal || undefined,
    session_id: r.session_id || undefined,
  }));
}

async function fetchOpenTasks(db: Surreal, repoId: string): Promise<ContextTaskStateEntry[]> {
  const rows = await queryResult<TaskStateRow[]>(
    db,
    `SELECT goal, status, created_at FROM task
     WHERE repo_id = $repo AND status IN ['open', 'in_progress', 'blocked']
     ORDER BY created_at DESC LIMIT 10`,
    { repo: repoId },
  );
  return rows.map((r) => ({
    goal: r.goal || "",
    status: r.status || "open",
    created_at: toIso(r.created_at),
  }));
}

async function fetchAgentRuns(
  db: Surreal,
  repoId: string,
  terms: string[],
  riskTerms: string[],
  now: number,
): Promise<ContextAgentRunEntry[]> {
  const rows = await queryResult<AgentRunRow[]>(
    db,
    `SELECT source_agent, task_goal, status, summary, created_at FROM agent_run
     WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 30`,
    { repo: repoId },
  );
  return rows
    .map((r) => {
      const createdIso = toIso(r.created_at);
      const ageDays = createdIso
        ? Math.max(0, (now - new Date(createdIso).getTime()) / 86_400_000)
        : 9999;
      const entry = {
        source_agent: r.source_agent || "manual",
        task_goal: r.task_goal || "",
        status: r.status || "",
        summary: r.summary || "",
        created_at: createdIso,
      };
      return {
        ...entry,
        score: scoreAgentRun(
          {
            taskGoal: entry.task_goal,
            summary: entry.summary,
            status: entry.status,
            sourceAgent: entry.source_agent,
            ageDays,
          },
          terms,
          riskTerms,
        ),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

async function fetchToolEvents(
  db: Surreal,
  repoId: string,
  terms: string[],
  riskTerms: string[],
  now: number,
): Promise<ContextToolEventEntry[]> {
  const rows = await queryResult<ToolEventRow[]>(
    db,
    `SELECT source_agent, tool_name, action, summary, success, created_at FROM tool_event
     WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 40`,
    { repo: repoId },
  );
  return rows
    .map((r) => {
      const createdIso = toIso(r.created_at);
      const ageDays = createdIso
        ? Math.max(0, (now - new Date(createdIso).getTime()) / 86_400_000)
        : 9999;
      const entry = {
        source_agent: r.source_agent || "manual",
        tool_name: r.tool_name || "",
        action: r.action || "",
        summary: r.summary || "",
        success: typeof r.success === "boolean" ? r.success : null,
        created_at: createdIso,
      };
      return {
        ...entry,
        score: scoreToolEvent(
          {
            toolName: entry.tool_name,
            action: entry.action,
            summary: entry.summary,
            sourceAgent: entry.source_agent,
            success: entry.success,
            ageDays,
          },
          terms,
          riskTerms,
        ),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export interface BuildContextPackOptions {
  repoRoot?: string;
  allowPaidEmbeddings?: boolean;
  /** Token budget ceiling for greedy packing (default TARGET_TOKENS = 3200). */
  maxTokens?: number;
  /** Include memory_context (decisions/evidence/lessons/repo_facts/snippets/task_notes). Default true. */
  includeMemory?: boolean;
  /** Include repo_context.graph_neighborhood + symbols. Default true. */
  includeGraph?: boolean;
}

export async function buildContextPack(
  db: Surreal,
  repoId: string,
  task: string,
  opts: BuildContextPackOptions = {},
): Promise<ContextPack> {
  const targetTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : TARGET_TOKENS;
  const includeMemory = opts.includeMemory !== false;
  const includeGraph = opts.includeGraph !== false;
  const goal = task.trim();
  const phase: Phase = inferPhase(goal);
  const terms = Array.from(new Set(tokenize(goal))).slice(0, 12);
  const riskTerms = detectRiskTerms(goal);
  const queryPlan = buildQueryPlan(goal, terms, riskTerms);

  // --- candidate files: full-text hits + filename/path-substring hits ---
  const fileMap = new Map<string, FileRow>();

  if (terms.length) {
    const ftRows = await ftSearchTerms<FileRow>(
      db,
      `SELECT path, ext, size, content, search::score(0) AS ftScore FROM file
       WHERE repo_id = $repo AND content @0@ $q
       ORDER BY ftScore DESC LIMIT 20`,
      { repo: repoId },
      terms,
      (r) => r.path,
    );
    for (const r of ftRows) {
      fileMap.set(r.path, r);
    }
  }

  for (const t of terms) {
    const rows = await queryResult<FileRow[]>(
      db,
      `SELECT path, ext, size, content FROM file
       WHERE repo_id = $repo AND string::contains(string::lowercase(path), $t)
       LIMIT 10`,
      { repo: repoId, t },
    );
    for (const r of rows) {
      if (!fileMap.has(r.path)) fileMap.set(r.path, { ...r, ftScore: 0 });
    }
  }

  const scoredFiles: ContextFileEntry[] = Array.from(fileMap.values())
    .map((r) => ({
      path: r.path,
      ext: r.ext,
      size: r.size,
      score: scoreFile(
        {
          path: r.path,
          size: r.size,
          ftScore: r.ftScore ?? 0,
          contentLower: (r.content || "").toLowerCase(),
        },
        terms,
        riskTerms,
      ),
      excerpt: excerpt(r.content || "", terms),
    }))
    .sort((a, b) => b.score - a.score);

  // --- remembered decisions + evidence (memory_context; skippable via includeMemory) ---
  const now = Date.now();
  let decisions: ContextMemoryEntry[] = [];
  let evidence: ContextMemoryEntry[] = [];
  let lessons: ContextMemoryEntry[] = [];
  let repoFacts: ContextMemoryEntry[] = [];
  let snippets: ContextSnippetEntry[] = [];
  let taskNotes: ContextMemoryEntry[] = [];
  if (includeMemory) {
    decisions = await fetchMemory(db, "decision", repoId, terms, riskTerms, now);
    evidence = await fetchMemory(db, "evidence_item", repoId, terms, riskTerms, now);
    // New-kind tables (0004/0005) may not exist pre-migration; degrade to [] like docChunks.
    try {
      lessons = await fetchMemory(db, "lesson", repoId, terms, riskTerms, now);
    } catch {
      lessons = [];
    }
    try {
      repoFacts = await fetchMemory(db, "repo_fact", repoId, terms, riskTerms, now);
    } catch {
      repoFacts = [];
    }
    try {
      snippets = await fetchSnippets(db, repoId, terms, riskTerms, now);
    } catch {
      snippets = [];
    }
    try {
      taskNotes = await fetchMemory(db, "task_note", repoId, terms, riskTerms, now);
    } catch {
      taskNotes = [];
    }
  }
  let openBlockers: ContextBlockerEntry[] = [];
  try {
    openBlockers = await fetchOpenBlockers(db, repoId);
  } catch {
    openBlockers = [];
  }
  let openTasks: ContextTaskStateEntry[] = [];
  try {
    openTasks = await fetchOpenTasks(db, repoId);
  } catch {
    openTasks = [];
  }
  const recentRuns = await fetchAgentRuns(db, repoId, terms, riskTerms, now);
  const recentToolEvents = await fetchToolEvents(db, repoId, terms, riskTerms, now);

  // --- hybrid retrieval channels (graceful: empty/absent tables degrade to []) ---
  let docChunks: ContextDocChunkEntry[] = [];
  try {
    docChunks = await queryDocChunks(db, repoId, goal, 8);
  } catch {
    docChunks = [];
  }

  let symbols: ContextSymbolEntry[] = [];
  let graphEdges: ContextGraphEdgeEntry[] = [];
  try {
    if (!includeGraph) throw new Error("graph channel disabled");
    const hits = await queryGraphNodes(db, repoId, terms, riskTerms, 8);
    symbols = hits.map((h) => ({
      label: h.label,
      kind: h.kind,
      source_file: h.source_file,
      source_location: h.source_location,
      score: h.score,
    }));
    graphEdges = await neighborhoodEdges(db, repoId, hits.map((h) => h.node_key), 12);
  } catch {
    symbols = [];
    graphEdges = [];
  }

  // Vector channel is optional and only runs when an embedding provider is available
  // (it must embed the query). No provider → no vector context, no error.
  let vectorChunks: ContextVectorChunkEntry[] = [];
  try {
    const embedCfg = resolveEmbedConfig({ repoRoot: opts.repoRoot });
    if (embedCfg.available && (!embedCfg.paid || opts.allowPaidEmbeddings !== false)) {
      vectorChunks = await queryVectors(db, embedCfg, repoId, goal, 6);
    }
  } catch {
    vectorChunks = [];
  }

  // --- recent verification failures ---
  const verificationRows = await queryResult<Array<{ summary: string; failures: unknown }>>(
    db,
    `SELECT summary, failures, created_at FROM verification_run
     WHERE repo_id = $repo AND status = 'fail'
     ORDER BY created_at DESC LIMIT 3`,
    { repo: repoId },
  );
  const lastFailures: string[] = [];
  for (const v of verificationRows) {
    if (Array.isArray(v.failures) && v.failures.length) {
      lastFailures.push(...(v.failures as string[]));
    } else if (v.summary) {
      lastFailures.push(v.summary);
    }
  }

  // --- workflow approval hints ---
  const approvalRequired = Array.from(
    new Set(riskTerms.map((r) => RISK_TO_ACTION[r]).filter((x): x is string => Boolean(x))),
  );
  const approvalRows = await queryResult<Array<{ tool_pattern: string; expires_at: unknown }>>(
    db,
    `SELECT tool_pattern, expires_at FROM approval WHERE repo_id = $repo`,
    { repo: repoId },
  );
  const nowIso = new Date().toISOString();
  const approvalAvailable = approvalRows
    .filter((a) => {
      const exp = toIso(a.expires_at);
      return !exp || exp > nowIso; // ISO-8601 UTC strings compare lexically
    })
    .map((a) => a.tool_pattern)
    .filter(Boolean);

  // --- assemble + token-budget (greedy by score: files, then decisions, then evidence) ---
  const dropped: string[] = [];
  const pack: ContextPack = {
    task: { goal, phase },
    query_plan: queryPlan,
    repo_context: { files: [], symbols: [], graph_neighborhood: [] },
    document_context: { chunks: [] },
    vector_context: { chunks: [] },
    memory_context: { decisions: [], evidence: [], lessons: [], repo_facts: [], snippets: [], task_notes: [] },
    state: { open_blockers: [], open_tasks: [] },
    verification: { last_failures: lastFailures.slice(0, 5) },
    workflow: { approval_required: approvalRequired, approval_available: approvalAvailable },
    agent_context: { recent_runs: [], recent_tool_events: [] },
    token_budget: {
      target_tokens: targetTokens,
      estimated_tokens: 0,
      dropped_items: dropped,
    },
  };

  let tokens = estimateTokens(
    JSON.stringify({ task: pack.task, verification: pack.verification, workflow: pack.workflow }),
  );

  for (const f of scoredFiles) {
    const cost = estimateTokens(f.path + f.excerpt);
    if (tokens + cost > targetTokens) {
      dropped.push(`file:${f.path}`);
      continue;
    }
    pack.repo_context.files.push(f);
    tokens += cost;
  }
  for (const s of symbols) {
    const cost = estimateTokens(`${s.label} ${s.source_file}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`symbol:${s.label}`);
      continue;
    }
    pack.repo_context.symbols.push(s);
    tokens += cost;
  }
  for (const dc of docChunks) {
    const cost = estimateTokens(`${dc.source_path} ${dc.excerpt}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`doc:${dc.source_path}#${dc.chunk_index}`);
      continue;
    }
    pack.document_context.chunks.push(dc);
    tokens += cost;
  }
  for (const d of decisions) {
    const cost = estimateTokens(d.summary);
    if (tokens + cost > targetTokens) {
      dropped.push(`decision:${d.summary.slice(0, 40)}`);
      continue;
    }
    pack.memory_context.decisions.push(d);
    tokens += cost;
  }
  for (const e of evidence) {
    const cost = estimateTokens(e.summary);
    if (tokens + cost > targetTokens) {
      dropped.push(`evidence:${e.summary.slice(0, 40)}`);
      continue;
    }
    pack.memory_context.evidence.push(e);
    tokens += cost;
  }
  for (const l of lessons) {
    const cost = estimateTokens(l.summary);
    if (tokens + cost > targetTokens) {
      dropped.push(`lesson:${l.summary.slice(0, 40)}`);
      continue;
    }
    pack.memory_context.lessons.push(l);
    tokens += cost;
  }
  for (const rf of repoFacts) {
    const cost = estimateTokens(rf.summary);
    if (tokens + cost > targetTokens) {
      dropped.push(`repo_fact:${rf.summary.slice(0, 40)}`);
      continue;
    }
    pack.memory_context.repo_facts.push(rf);
    tokens += cost;
  }
  for (const sn of snippets) {
    const cost = estimateTokens(`${sn.summary} ${sn.excerpt}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`snippet:${sn.summary.slice(0, 40)}`);
      continue;
    }
    pack.memory_context.snippets.push(sn);
    tokens += cost;
  }
  for (const tn of taskNotes) {
    const cost = estimateTokens(tn.summary);
    if (tokens + cost > targetTokens) {
      dropped.push(`task_note:${tn.summary.slice(0, 40)}`);
      continue;
    }
    pack.memory_context.task_notes.push(tn);
    tokens += cost;
  }
  for (const b of openBlockers) {
    const cost = estimateTokens(`${b.summary} ${b.task_goal ?? ""}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`blocker:${b.summary.slice(0, 40)}`);
      continue;
    }
    pack.state.open_blockers.push(b);
    tokens += cost;
  }
  for (const t of openTasks) {
    const cost = estimateTokens(`${t.goal} ${t.status}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`task_state:${t.goal.slice(0, 40)}`);
      continue;
    }
    pack.state.open_tasks.push(t);
    tokens += cost;
  }
  for (const ge of graphEdges) {
    const cost = estimateTokens(`${ge.src} ${ge.relation} ${ge.dst}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`graph_edge:${ge.relation}`);
      continue;
    }
    pack.repo_context.graph_neighborhood.push(ge);
    tokens += cost;
  }
  for (const v of vectorChunks) {
    const cost = estimateTokens(v.excerpt);
    if (tokens + cost > targetTokens) {
      dropped.push(`vector:${v.source_id}`);
      continue;
    }
    pack.vector_context.chunks.push(v);
    tokens += cost;
  }
  for (const r of recentRuns) {
    const cost = estimateTokens(`${r.task_goal} ${r.summary}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`agent_run:${r.summary.slice(0, 40) || r.task_goal.slice(0, 40)}`);
      continue;
    }
    pack.agent_context.recent_runs.push(r);
    tokens += cost;
  }
  for (const e of recentToolEvents) {
    const cost = estimateTokens(`${e.tool_name} ${e.action} ${e.summary}`);
    if (tokens + cost > targetTokens) {
      dropped.push(`tool_event:${e.tool_name}:${e.action}`.slice(0, 60));
      continue;
    }
    pack.agent_context.recent_tool_events.push(e);
    tokens += cost;
  }

  pack.token_budget.estimated_tokens = tokens;
  return pack;
}

// ---- Markdown rendering (default output for the `nox` bin's `voidarch-context context`) ------

function mdList(lines: string[]): string {
  return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "_none_";
}

/**
 * Render a ContextPack as compact Markdown: Files, Symbols, Doc chunks, Memories,
 * Graph, State, Verification hint — with a token estimate at the top. Keeps this
 * pasteable into any agent chat without needing to parse JSON.
 */
export function formatContextPackMarkdown(pack: ContextPack): string {
  const out: string[] = [];
  out.push(`# Context pack: ${pack.task.goal}`);
  out.push(
    `_phase: ${pack.task.phase} · ~${pack.token_budget.estimated_tokens} tokens (budget ${pack.token_budget.target_tokens})_`,
  );

  out.push("\n## Files");
  out.push(
    mdList(
      pack.repo_context.files
        .slice(0, 20)
        .map((f) => `\`${f.path}\` (score ${f.score}) — ${f.excerpt.slice(0, 140)}`),
    ),
  );

  out.push("\n## Symbols");
  out.push(
    mdList(
      pack.repo_context.symbols
        .slice(0, 12)
        .map((s) => `\`${s.label}\` (${s.kind}) — ${s.source_file}${s.source_location ? `:${s.source_location}` : ""}`),
    ),
  );

  out.push("\n## Doc chunks");
  out.push(
    mdList(
      pack.document_context.chunks
        .slice(0, 10)
        .map((c) => `${c.source_path} § ${c.heading || "(top)"} — ${c.excerpt.slice(0, 140)}`),
    ),
  );

  out.push("\n## Memories");
  const memLines: string[] = [];
  const memSection = (label: string, items: ContextMemoryEntry[]) => {
    for (const m of items.slice(0, 5)) memLines.push(`[${label}] ${m.summary}`);
  };
  memSection("decision", pack.memory_context.decisions);
  memSection("evidence", pack.memory_context.evidence);
  memSection("lesson", pack.memory_context.lessons);
  memSection("repo_fact", pack.memory_context.repo_facts);
  memSection("snippet", pack.memory_context.snippets);
  memSection("task_note", pack.memory_context.task_notes);
  out.push(mdList(memLines));

  out.push("\n## Graph");
  out.push(
    mdList(
      pack.repo_context.graph_neighborhood
        .slice(0, 10)
        .map((g) => `${g.src} —${g.relation}→ ${g.dst}`),
    ),
  );
  if (pack.vector_context.chunks.length) {
    out.push(
      mdList(
        pack.vector_context.chunks.slice(0, 6).map((v) => `(vector) ${v.source_id} — ${v.excerpt.slice(0, 140)}`),
      ),
    );
  }

  out.push("\n## State");
  const stateLines = [
    ...pack.state.open_blockers.map((b) => `blocker: ${b.summary}`),
    ...pack.state.open_tasks.map((t) => `task (${t.status}): ${t.goal}`),
  ];
  out.push(mdList(stateLines));

  out.push("\n## Verification hint");
  out.push(
    pack.verification.last_failures.length
      ? mdList(pack.verification.last_failures.slice(0, 5))
      : "_no recent verification failures on record_",
  );
  if (pack.workflow.approval_required.length) {
    out.push(`\n**Approval required:** ${pack.workflow.approval_required.join(", ")}`);
  }

  return `${out.join("\n")}\n`;
}
