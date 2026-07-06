// Local `.agent-runs` → SurrealDB bridge: shared types, parsing, redaction, and
// row mapping for the run-import slice.
//
// Data flow (one direction): Claude Code hooks (hooks/log-agent-run.sh) and the
// voidarch-context log-tool / voidarch-context log-run (internal) CLIs append to the local JSONL buffer under
// `.agent-runs/sessions/<id>/`; `voidarch-context import-runs` is the ONLY thing that reads
// that buffer and writes it to SurrealDB. Keeping the loggers DB-free means they
// (and their dry-run paths) work with no credentials.
//
// Row shapes below intentionally include exactly the columns that
// src/memory/context-pack.ts queries (tool_name, action, summary, success,
// created_at, source_agent, repo_id, …) so imported rows are immediately usable
// by /dfc-context, plus provenance/dedupe fields.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceAgent } from "./types.js";

// ---------------------------------------------------------------------------
// Source line shape — one JSON object per line in tools.jsonl.
// ---------------------------------------------------------------------------
export interface ToolEventLine {
  timestamp?: string;
  session_id?: string;
  run_id?: string;
  task_id?: string;
  gsd_phase?: string;
  agent?: string;
  subagent?: string;
  skill?: string;
  tool?: string;
  mcp_server?: string;
  mcp_tool?: string;
  command?: string;
  file?: string;
  files_read?: unknown;
  files_changed?: unknown;
  graph_used?: boolean;
  context7_used?: boolean;
  firecrawl_used?: boolean;
  gitkraken_used?: boolean;
  github_mcp_used?: boolean;
  jules_used?: boolean;
  approval_id?: string;
  approval_required?: boolean;
  approval_status?: string;
  result?: string;
  error?: string;
  // present on PreCompact / parse-error marker lines — these are NOT tool events
  hook?: string;
  event?: string;
}

export interface VerificationMarker {
  verified_at?: string;
  command?: string;
  status?: string;
  failures?: unknown;
  summary?: string;
}

export interface ApprovalMarker {
  tool_pattern?: string;
  expires_at?: string;
  single_use?: boolean;
  reason?: string;
  created_at?: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// Destination row shapes (the columns /dfc-context reads + provenance/dedupe).
// ---------------------------------------------------------------------------
export interface ToolEventRow {
  repo_id: string;
  source_agent: SourceAgent;
  session_id: string;
  tool_name: string;
  action: string;
  summary: string;
  success: boolean | null;
  command: string;
  file: string;
  mcp_server: string;
  mcp_tool: string;
  gsd_phase: string;
  graph_used: boolean;
  context7_used: boolean;
  firecrawl_used: boolean;
  gitkraken_used: boolean;
  github_mcp_used: boolean;
  jules_used: boolean;
  approval_required: boolean;
  approval_status: string;
  created_at: string;
  imported_at: string;
  import_source: string;
  event_hash: string;
}

export interface AgentRunRow {
  repo_id: string;
  source_agent: SourceAgent;
  session_id: string;
  task_goal: string;
  status: string;
  summary: string;
  event_count: number;
  tool_breakdown: Record<string, number>;
  started_at: string;
  ended_at: string;
  created_at: string;
  imported_at: string;
  import_source: string;
  run_hash: string;
}

export interface VerificationRunRow {
  repo_id: string;
  source_agent: SourceAgent;
  session_id: string;
  status: string;
  summary: string;
  failures: string[];
  command: string;
  created_at: string;
  imported_at: string;
  import_source: string;
  vrun_hash: string;
}

export interface ApprovalRow {
  repo_id: string;
  source_agent: SourceAgent;
  scope: string;
  tool_pattern: string;
  expires_at: string;
  single_use: boolean;
  reason: string;
  created_at: string;
  imported_at: string;
  import_source: string;
  approval_hash: string;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Mask common secret-bearing patterns so credentials never reach the DB. */
export function redact(value: string): string {
  if (!value) return "";
  return value
    // `Bearer <token>` first, so the token is masked before the generic
    // `authorization …` rule below would otherwise only catch the word "Bearer".
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{6,})\b/g, "***") // GitHub tokens
    .replace(
      /\b(pass(?:word|wd)?|secret|tokens?|api[_-]?keys?|access[_-]?keys?|authorization|auth[_-]?tokens?|client[_-]?secret|DFC_SURREAL_PASS)\b(\s*[=:]\s*|\s+)\S+/gi,
      "$1$2***",
    )
    .replace(/(--password|--token|-p)\s+\S+/gi, "$1 ***");
}

/** Redact then hard-cap a string so we never dump huge payloads. */
export function clean(value: string | undefined, max: number): string {
  const r = redact((value ?? "").toString());
  return r.length <= max ? r : `${r.slice(0, max - 1)}…`;
}

/** Tolerant JSON parse; returns null instead of throwing. */
export function tryParse<T = unknown>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// `.agent-runs` discovery.
// ---------------------------------------------------------------------------

export function agentRunsDir(repoRoot: string): string {
  return join(repoRoot, ".agent-runs");
}

/** Session ids that have a tools.jsonl (or any session dir). */
export function listSessions(repoRoot: string, only?: string): string[] {
  const sessions = join(agentRunsDir(repoRoot), "sessions");
  if (!existsSync(sessions)) return [];
  let ids = readdirSync(sessions, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (only) ids = ids.filter((id) => id === only);
  return ids.sort();
}

export function sessionToolsPath(repoRoot: string, session: string): string {
  return join(agentRunsDir(repoRoot), "sessions", session, "tools.jsonl");
}

/** Read + parse a tools.jsonl, separating valid tool-event lines from skips. */
export function readToolLines(path: string): {
  events: ToolEventLine[];
  skipped: number;
  malformed: number;
} {
  if (!existsSync(path)) return { events: [], skipped: 0, malformed: 0 };
  const events: ToolEventLine[] = [];
  let skipped = 0;
  let malformed = 0;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const obj = tryParse<ToolEventLine>(line);
    if (!obj) {
      malformed++;
      continue;
    }
    // PreCompact markers and parse-error markers carry `hook` and no `tool`.
    if (!obj.tool) {
      skipped++;
      continue;
    }
    events.push(obj);
  }
  return { events, skipped, malformed };
}

// ---------------------------------------------------------------------------
// Mapping: source line → DB row.
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["Write", "Edit", "Read", "NotebookEdit", "Glob", "Grep"]);

export function deriveAction(line: ToolEventLine): string {
  const tool = line.tool ?? "";
  if (tool.startsWith("mcp__")) return line.mcp_tool || tool;
  if (tool === "Bash") {
    const first = (line.command ?? "").trim().split(/\s+/)[0] ?? "";
    return first || "bash";
  }
  if (FILE_TOOLS.has(tool)) return tool.toLowerCase();
  return tool;
}

export function deriveSummary(line: ToolEventLine): string {
  const tool = line.tool ?? "";
  if (tool === "Bash") return clean(line.command, 200);
  if (FILE_TOOLS.has(tool) && line.file) return clean(line.file, 200);
  if (tool.startsWith("mcp__")) return clean(`${line.mcp_server}.${line.mcp_tool}`, 200);
  return clean(line.file || tool, 200);
}

export function deriveSuccess(line: ToolEventLine): boolean | null {
  if (line.error && line.error.trim()) return false;
  if (line.result && /ok|success|done|pass/i.test(line.result)) return true;
  return null;
}

export function mapToolEvent(
  line: ToolEventLine,
  repoId: string,
  sourceAgent: SourceAgent,
  importSource: string,
): ToolEventRow {
  const created = line.timestamp || nowIso();
  const session = line.session_id || "";
  const tool = line.tool || "";
  const event_hash = sha256(
    [session, created, tool, line.command ?? "", line.file ?? ""].join("|"),
  );
  return {
    repo_id: repoId,
    source_agent: sourceAgent,
    session_id: session,
    tool_name: tool,
    action: deriveAction(line),
    summary: deriveSummary(line),
    success: deriveSuccess(line),
    command: clean(line.command, 500),
    file: clean(line.file, 300),
    mcp_server: line.mcp_server || "",
    mcp_tool: line.mcp_tool || "",
    gsd_phase: line.gsd_phase || "",
    graph_used: Boolean(line.graph_used),
    context7_used: Boolean(line.context7_used),
    firecrawl_used: Boolean(line.firecrawl_used),
    gitkraken_used: Boolean(line.gitkraken_used),
    github_mcp_used: Boolean(line.github_mcp_used),
    jules_used: Boolean(line.jules_used),
    approval_required: Boolean(line.approval_required),
    approval_status: line.approval_status || "",
    created_at: created,
    imported_at: nowIso(),
    import_source: importSource,
    event_hash,
  };
}

/** Collapse a session's tool events into one agent_run summary. */
export function deriveAgentRun(
  session: string,
  events: ToolEventLine[],
  repoId: string,
  sourceAgent: SourceAgent,
  importSource: string,
  taskGoal = "",
): AgentRunRow {
  const times = events.map((e) => e.timestamp || "").filter(Boolean).sort();
  const started = times[0] || nowIso();
  const ended = times[times.length - 1] || started;
  const breakdown: Record<string, number> = {};
  let errors = 0;
  for (const e of events) {
    const t = e.tool || "unknown";
    breakdown[t] = (breakdown[t] ?? 0) + 1;
    if (e.error && e.error.trim()) errors++;
  }
  const parts = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([t, n]) => `${t}×${n}`);
  const status = errors > 0 ? "completed_with_errors" : "completed";
  const summary = `${events.length} tool events (${parts.join(", ") || "none"})${
    errors ? `; ${errors} error(s)` : ""
  }`;
  return {
    repo_id: repoId,
    source_agent: sourceAgent,
    session_id: session,
    task_goal: taskGoal,
    status,
    summary,
    event_count: events.length,
    tool_breakdown: breakdown,
    started_at: started,
    ended_at: ended,
    created_at: ended, // most-recent activity → sorts first in context-pack
    imported_at: nowIso(),
    import_source: importSource,
    run_hash: sha256(`agent_run|${repoId}|${session}|${started}`),
  };
}

export function mapVerification(
  session: string,
  m: VerificationMarker,
  repoId: string,
  sourceAgent: SourceAgent,
  importSource: string,
): VerificationRunRow {
  const created = m.verified_at || nowIso();
  const command = clean(m.command, 300);
  // The hook marker only records that a verification command RAN, not its
  // pass/fail outcome — so default to "ran" (never "fail"), which keeps
  // context-pack's `status = 'fail'` last_failures query honest.
  const status = (m.status || "ran").toLowerCase();
  const failures = Array.isArray(m.failures) ? (m.failures as string[]).map((f) => clean(String(f), 200)) : [];
  return {
    repo_id: repoId,
    source_agent: sourceAgent,
    session_id: session,
    status,
    summary: m.summary ? clean(m.summary, 200) : command || "verification ran",
    failures,
    command,
    created_at: created,
    imported_at: nowIso(),
    import_source: importSource,
    vrun_hash: sha256(`verification|${repoId}|${session}|${created}|${command}`),
  };
}

export function mapApproval(
  scope: string,
  m: ApprovalMarker,
  repoId: string,
  sourceAgent: SourceAgent,
  importSource: string,
): ApprovalRow {
  const created = m.created_at || nowIso();
  const pattern = m.tool_pattern || "";
  const expires = m.expires_at || "";
  return {
    repo_id: repoId,
    source_agent: sourceAgent,
    scope,
    tool_pattern: pattern,
    expires_at: expires,
    single_use: Boolean(m.single_use),
    reason: clean(m.reason, 200),
    created_at: created,
    imported_at: nowIso(),
    import_source: importSource,
    approval_hash: sha256(`approval|${repoId}|${scope}|${pattern}|${expires}`),
  };
}

/** Read all approval markers (global + per-session). */
export function readApprovals(repoRoot: string, session?: string): Array<{ scope: string; marker: ApprovalMarker }> {
  const out: Array<{ scope: string; marker: ApprovalMarker }> = [];
  const dirs: Array<[string, string]> = [["global", join(agentRunsDir(repoRoot), "approvals")]];
  if (session) {
    dirs.push([session, join(agentRunsDir(repoRoot), "sessions", session, "approvals")]);
  }
  for (const [scope, dir] of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const m = tryParse<ApprovalMarker>(readFileSync(join(dir, name), "utf8"));
      if (m && m.tool_pattern) out.push({ scope, marker: m });
    }
  }
  return out;
}

/** Read a session's verification.json marker if present. */
export function readVerification(repoRoot: string, session: string): VerificationMarker | null {
  const p = join(agentRunsDir(repoRoot), "sessions", session, "verification.json");
  if (!existsSync(p)) return null;
  return tryParse<VerificationMarker>(readFileSync(p, "utf8"));
}

/** Read an optional explicit run.json summary (written by voidarch-context log-run (internal)). */
export function readRunSummary(repoRoot: string, session: string): { task_goal?: string; status?: string; summary?: string } | null {
  const p = join(agentRunsDir(repoRoot), "sessions", session, "run.json");
  if (!existsSync(p)) return null;
  return tryParse(readFileSync(p, "utf8"));
}

/** mtime epoch seconds, or 0. */
export function mtime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return 0;
  }
}
