// Deep metrics over the dev-memory database. dfc-status reports raw per-table
// row counts; this module answers "what happened lately": run activity, task
// and blocker state, memory growth, retrieval usage, staleness, tool activity.
// Every section degrades to zeros/empty when its table is missing or a query
// fails — metrics must never crash on a partially-migrated database.

import type { Surreal } from "surrealdb";
import { queryResult } from "./surreal.js";

export interface StaleSummary {
  id: string;
  summary: string;
  age_days: number;
}

export interface ToolActivityEntry {
  tool_name: string;
  count: number;
  ok: number;
  fail: number;
}

export interface DfcMetrics {
  repo_id: string;
  days: number;
  generated_at: string;
  /** Row counts per table (repo_id-scoped where the table carries repo_id). */
  tables: Record<string, number>;
  runs: {
    total: number;
    by_status: Record<string, number>;
    by_source_agent: Record<string, number>;
  };
  tasks: {
    by_status: Record<string, number>;
    oldest_open_age_days: number | null;
  };
  blockers: {
    open: number;
    resolved: number;
    oldest_open_age_days: number | null;
  };
  /** Created counts in the last 7/30 days per memory kind. */
  memories: Record<string, { last_7_days: number; last_30_days: number }>;
  retrieval: {
    total: number;
    last_7_days: number;
    avg_estimated_tokens: number | null;
  };
  stale: {
    open_tasks_over_14_days: { count: number; items: StaleSummary[] };
    open_blockers_over_7_days: { count: number; items: StaleSummary[] };
  };
  tool_activity: {
    total: number;
    by_tool: ToolActivityEntry[];
  };
}

/** Every table except `repo` carries repo_id (see schema/ + src/memory/graph.ts). */
const REPO_SCOPED_TABLES = [
  "file",
  "document",
  "doc_chunk",
  "decision",
  "evidence_item",
  "lesson",
  "snippet",
  "repo_fact",
  "blocker",
  "task",
  "context_pack",
  "agent_run",
  "tool_event",
  "verification_run",
  "approval",
  "graph_node",
  "graph_edge",
  "embedding_chunk",
] as const;

const MEMORY_TABLES: Record<string, string> = {
  decision: "decision",
  evidence: "evidence_item",
  lesson: "lesson",
  snippet: "snippet",
  repo_fact: "repo_fact",
};

const DAY_MS = 86_400_000;

function isoDaysAgo(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

/** Whole days since `created` (ISO string or Date); null when unparseable. */
function ageDays(created: unknown, nowMs: number): number | null {
  if (created === null || created === undefined || created === "") return null;
  const t = created instanceof Date ? created.getTime() : Date.parse(String(created));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

async function countRows(
  db: Surreal,
  table: string,
  where: string,
  binds: Record<string, unknown>,
): Promise<number> {
  const rows = await queryResult<Array<{ n?: number }>>(
    db,
    `SELECT count() AS n FROM type::table($t)${where ? ` WHERE ${where}` : ""} GROUP ALL`,
    { t: table, ...binds },
  );
  return rows[0]?.n ?? 0;
}

/** `field` and `where` are internal constants, never user input. */
async function groupCounts(
  db: Surreal,
  table: string,
  field: string,
  where: string,
  binds: Record<string, unknown>,
): Promise<Record<string, number>> {
  const rows = await queryResult<Array<Record<string, unknown>>>(
    db,
    `SELECT ${field}, count() AS n FROM type::table($t) WHERE ${where} GROUP BY ${field}`,
    { t: table, ...binds },
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row[field];
    if (key === null || key === undefined || key === "") continue;
    out[String(key)] = Number(row.n ?? 0);
  }
  return out;
}

async function oldestAgeDays(
  db: Surreal,
  table: string,
  where: string,
  binds: Record<string, unknown>,
  nowMs: number,
): Promise<number | null> {
  const rows = await queryResult<Array<{ created_at?: unknown }>>(
    db,
    `SELECT created_at FROM type::table($t) WHERE ${where} ORDER BY created_at ASC LIMIT 1`,
    { t: table, ...binds },
  );
  return ageDays(rows[0]?.created_at, nowMs);
}

async function staleItems(
  db: Surreal,
  table: string,
  summaryField: string,
  where: string,
  binds: Record<string, unknown>,
  nowMs: number,
): Promise<{ count: number; items: StaleSummary[] }> {
  const count = await countRows(db, table, where, binds);
  const rows = await queryResult<Array<Record<string, unknown>>>(
    db,
    `SELECT id, ${summaryField} AS summary, created_at FROM type::table($t)
     WHERE ${where} ORDER BY created_at ASC LIMIT 5`,
    { t: table, ...binds },
  );
  const items = rows.map((row) => ({
    id: String(row.id ?? ""),
    summary: String(row.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    age_days: ageDays(row.created_at, nowMs) ?? 0,
  }));
  return { count, items };
}

export async function collectMetrics(
  db: Surreal,
  repoId: string,
  opts: { days?: number } = {},
): Promise<DfcMetrics> {
  const days = opts.days && opts.days > 0 ? opts.days : 30;
  const nowMs = Date.now();
  const cutoff = isoDaysAgo(nowMs, days);
  const iso7 = isoDaysAgo(nowMs, 7);
  const iso30 = isoDaysAgo(nowMs, 30);
  const repo = repoId;

  const metrics: DfcMetrics = {
    repo_id: repoId,
    days,
    generated_at: new Date(nowMs).toISOString(),
    tables: {},
    runs: { total: 0, by_status: {}, by_source_agent: {} },
    tasks: { by_status: {}, oldest_open_age_days: null },
    blockers: { open: 0, resolved: 0, oldest_open_age_days: null },
    memories: {},
    retrieval: { total: 0, last_7_days: 0, avg_estimated_tokens: null },
    stale: {
      open_tasks_over_14_days: { count: 0, items: [] },
      open_blockers_over_7_days: { count: 0, items: [] },
    },
    tool_activity: { total: 0, by_tool: [] },
  };

  // --- tables ---------------------------------------------------------------
  try {
    metrics.tables.repo = await countRows(db, "repo", "", {});
  } catch {
    metrics.tables.repo = 0;
  }
  for (const table of REPO_SCOPED_TABLES) {
    try {
      metrics.tables[table] = await countRows(db, table, "repo_id = $repo", { repo });
    } catch {
      metrics.tables[table] = 0;
    }
  }

  // --- runs (last `days`) -----------------------------------------------------
  try {
    const where = "repo_id = $repo AND created_at >= $cutoff";
    const binds = { repo, cutoff };
    metrics.runs.total = await countRows(db, "agent_run", where, binds);
    metrics.runs.by_status = await groupCounts(db, "agent_run", "status", where, binds);
    metrics.runs.by_source_agent = await groupCounts(db, "agent_run", "source_agent", where, binds);
  } catch {
    /* section degrades to zeros */
  }

  // --- tasks ------------------------------------------------------------------
  try {
    // Legacy context-pack audit rows carry no status — ignore them.
    metrics.tasks.by_status = await groupCounts(
      db,
      "task",
      "status",
      "repo_id = $repo AND status != NONE",
      { repo },
    );
    metrics.tasks.oldest_open_age_days = await oldestAgeDays(
      db,
      "task",
      "repo_id = $repo AND status = 'open'",
      { repo },
      nowMs,
    );
  } catch {
    /* section degrades to zeros */
  }

  // --- blockers ----------------------------------------------------------------
  try {
    const byStatus = await groupCounts(db, "blocker", "status", "repo_id = $repo", { repo });
    metrics.blockers.open = byStatus.open ?? 0;
    metrics.blockers.resolved = byStatus.resolved ?? 0;
    metrics.blockers.oldest_open_age_days = await oldestAgeDays(
      db,
      "blocker",
      "repo_id = $repo AND status = 'open'",
      { repo },
      nowMs,
    );
  } catch {
    /* section degrades to zeros */
  }

  // --- memories (created last 7/30 days per kind) --------------------------------
  for (const [kind, table] of Object.entries(MEMORY_TABLES)) {
    try {
      metrics.memories[kind] = {
        last_7_days: await countRows(db, table, "repo_id = $repo AND created_at >= $cutoff", {
          repo,
          cutoff: iso7,
        }),
        last_30_days: await countRows(db, table, "repo_id = $repo AND created_at >= $cutoff", {
          repo,
          cutoff: iso30,
        }),
      };
    } catch {
      metrics.memories[kind] = { last_7_days: 0, last_30_days: 0 };
    }
  }

  // --- retrieval (context packs) --------------------------------------------------
  try {
    metrics.retrieval.total = await countRows(db, "context_pack", "repo_id = $repo", { repo });
    metrics.retrieval.last_7_days = await countRows(
      db,
      "context_pack",
      "repo_id = $repo AND created_at >= $cutoff",
      { repo, cutoff: iso7 },
    );
    // dfc-context-pack persists a top-level `estimated_tokens`; average in JS so
    // rows missing the field (older packs) are simply skipped.
    const rows = await queryResult<Array<{ estimated_tokens?: unknown }>>(
      db,
      "SELECT estimated_tokens FROM context_pack WHERE repo_id = $repo",
      { repo },
    );
    const values = rows
      .map((r) => Number(r.estimated_tokens))
      .filter((n) => Number.isFinite(n));
    metrics.retrieval.avg_estimated_tokens = values.length
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : null;
  } catch {
    /* section degrades to zeros */
  }

  // --- stale ---------------------------------------------------------------------
  try {
    metrics.stale.open_tasks_over_14_days = await staleItems(
      db,
      "task",
      "goal",
      "repo_id = $repo AND status = 'open' AND created_at < $cutoff",
      { repo, cutoff: isoDaysAgo(nowMs, 14) },
      nowMs,
    );
  } catch {
    /* section degrades to zeros */
  }
  try {
    metrics.stale.open_blockers_over_7_days = await staleItems(
      db,
      "blocker",
      "summary",
      "repo_id = $repo AND status = 'open' AND created_at < $cutoff",
      { repo, cutoff: isoDaysAgo(nowMs, 7) },
      nowMs,
    );
  } catch {
    /* section degrades to zeros */
  }

  // --- tool activity (last `days`, top 10 tools, ok/fail split) ---------------------
  try {
    const rows = await queryResult<Array<{ tool_name?: unknown; success?: unknown; n?: number }>>(
      db,
      `SELECT tool_name, success, count() AS n FROM tool_event
       WHERE repo_id = $repo AND created_at >= $cutoff GROUP BY tool_name, success`,
      { repo, cutoff },
    );
    const byTool = new Map<string, ToolActivityEntry>();
    for (const row of rows) {
      const name = String(row.tool_name ?? "unknown");
      const n = Number(row.n ?? 0);
      const entry = byTool.get(name) ?? { tool_name: name, count: 0, ok: 0, fail: 0 };
      entry.count += n;
      if (row.success === true) entry.ok += n;
      if (row.success === false) entry.fail += n;
      byTool.set(name, entry);
      metrics.tool_activity.total += n;
    }
    metrics.tool_activity.by_tool = [...byTool.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  } catch {
    /* section degrades to zeros */
  }

  return metrics;
}
