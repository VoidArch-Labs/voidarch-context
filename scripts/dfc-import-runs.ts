// voidarch-context import-runs — import the local `.agent-runs` buffer into SurrealDB memory.
//
//   voidarch-context import-runs --agent claude --dry-run        # parse + map, write nothing
//   voidarch-context import-runs --agent claude                  # import to SurrealDB
//   voidarch-context import-runs --agent codex --session <id>     # one session only
//   voidarch-context import-runs --agent claude --limit 50        # cap tool events
//   voidarch-context import-runs --agent claude --dry-run --json   # emit the full plan
//
// Reads hooks/log-agent-run.sh output (.agent-runs/sessions/<id>/tools.jsonl),
// plus verification.json, optional run.json, and scoped approval records. Maps to
// tool_event / agent_run / verification_run / approval rows, dedupes by content
// hash, and writes only what is new. Secrets are redacted and payloads capped in
// src/memory/runs.ts. The dry-run path needs no credentials.

import { Table } from "surrealdb";
import type { Surreal } from "surrealdb";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs as parseCliArgs, repoRootFromArgs } from "../src/cli.js";
import { loadConfig, queryResult, withDb } from "../src/surreal.js";
import type { SourceAgent } from "../src/types.js";
import {
  type AgentRunRow,
  type ApprovalRow,
  type ToolEventRow,
  type VerificationRunRow,
  deriveAgentRun,
  listSessions,
  mapApproval,
  mapToolEvent,
  mapVerification,
  readApprovals,
  readRunSummary,
  readToolLines,
  readVerification,
  sessionToolsPath,
} from "../src/runs.js";

interface Args {
  [key: string]: string | undefined;
  agent?: string;
  session?: string;
  limit?: string;
  task?: string;
  "dry-run"?: string;
  json?: string;
}

interface ImportPlan {
  toolEvents: ToolEventRow[];
  agentRuns: AgentRunRow[];
  verifications: VerificationRunRow[];
  approvals: ApprovalRow[];
  stats: {
    sessions: string[];
    skippedLines: number;
    malformedLines: number;
    limited: boolean;
  };
}

/** Pure: read `.agent-runs` and build all rows. No database access. */
export function buildPlan(
  repoRoot: string,
  repoId: string,
  sourceAgent: SourceAgent,
  opts: { session?: string; limit?: number; task?: string },
): ImportPlan {
  const importSource = `.agent-runs@${sourceAgent}`;
  const toolEvents: ToolEventRow[] = [];
  const agentRuns: AgentRunRow[] = [];
  const verifications: VerificationRunRow[] = [];
  const sessions = listSessions(repoRoot, opts.session);
  let skippedLines = 0;
  let malformedLines = 0;
  let limited = false;
  const cap = opts.limit && opts.limit > 0 ? opts.limit : Infinity;

  for (const session of sessions) {
    const { events, skipped, malformed } = readToolLines(sessionToolsPath(repoRoot, session));
    skippedLines += skipped;
    malformedLines += malformed;

    // tool events (respect the overall cap)
    const taken = events.slice(0, Math.max(0, cap - toolEvents.length));
    if (taken.length < events.length) limited = true;
    for (const line of taken) {
      toolEvents.push(mapToolEvent(line, repoId, sourceAgent, importSource));
    }

    // one agent_run per session (explicit run.json overrides the derived summary)
    if (events.length) {
      const explicit = readRunSummary(repoRoot, session);
      const run = deriveAgentRun(
        session,
        events,
        repoId,
        sourceAgent,
        importSource,
        explicit?.task_goal ?? opts.task ?? "",
      );
      if (explicit?.status) run.status = explicit.status;
      if (explicit?.summary) run.summary = explicit.summary;
      agentRuns.push(run);
    }

    // verification.json → verification_run
    const v = readVerification(repoRoot, session);
    if (v && (v.verified_at || v.command)) {
      verifications.push(mapVerification(session, v, repoId, sourceAgent, importSource));
    }

    if (toolEvents.length >= cap) {
      limited = limited || sessions.indexOf(session) < sessions.length - 1;
    }
  }

  // approvals: global + (optionally) the targeted session
  const approvals: ApprovalRow[] = readApprovals(repoRoot, opts.session).map(({ scope, marker }) =>
    mapApproval(scope, marker, repoId, sourceAgent, importSource),
  );

  return {
    toolEvents,
    agentRuns,
    verifications,
    approvals,
    stats: { sessions, skippedLines, malformedLines, limited },
  };
}

/** Insert only rows whose dedupe-hash is not already present. Returns inserted count. */
async function insertNew<T>(
  db: Surreal,
  table: string,
  hashField: string,
  hashOf: (row: T) => string,
  repoId: string,
  rows: T[],
): Promise<{ inserted: number; skipped: number }> {
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const hashes = rows.map(hashOf);
  const existingRows = await queryResult<Array<Record<string, unknown>>>(
    db,
    `SELECT ${hashField} FROM type::table($t) WHERE repo_id = $repo AND ${hashField} IN $hashes`,
    { t: table, repo: repoId, hashes },
  );
  const existing = new Set(existingRows.map((r) => String(r[hashField])));
  const fresh = rows.filter((r) => !existing.has(hashOf(r)));
  for (const row of fresh) {
    await db.create(new Table(table)).content(row as unknown as Record<string, unknown>);
  }
  return { inserted: fresh.length, skipped: rows.length - fresh.length };
}

function printSummary(plan: ImportPlan, dryRun: boolean): void {
  const { stats } = plan;
  console.log(`voidarch-context import-runs ${dryRun ? "(DRY RUN — no writes)" : ""}`.trim());
  console.log(`  sessions:        ${stats.sessions.length}${stats.sessions.length ? ` (${stats.sessions.join(", ")})` : ""}`);
  console.log(`  tool_event:      ${plan.toolEvents.length}${stats.limited ? " (capped by --limit)" : ""}`);
  console.log(`  agent_run:       ${plan.agentRuns.length}`);
  console.log(`  verification_run:${plan.verifications.length}`);
  console.log(`  approval:        ${plan.approvals.length}`);
  console.log(`  skipped lines:   ${stats.skippedLines} (non-tool markers)`);
  console.log(`  malformed lines: ${stats.malformedLines} (unparseable JSONL — skipped with warning)`);
  const sample = plan.toolEvents[0];
  if (sample) {
    console.log(
      `  sample event:    [${sample.created_at}] ${sample.tool_name} · ${sample.action} · ${sample.summary.slice(0, 60)}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)) as Args;
  const sourceAgent = normalizeSourceAgent(args.agent);
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const root = repoRootFromArgs(args as Record<string, string>);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error("--limit must be a positive integer");
    process.exit(2);
  }

  // repoId comes from config (no credentials needed to read it).
  const repoId = loadConfig({ repoRoot: root }).repoId;
  const plan = buildPlan(root, repoId, sourceAgent, {
    session: args.session,
    limit,
    task: args.task,
  });

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    if (dryRun) return;
  }

  if (dryRun) {
    printSummary(plan, true);
    if (plan.stats.malformedLines > 0) {
      console.warn(`warning: ${plan.stats.malformedLines} malformed JSONL line(s) were skipped.`);
    }
    return;
  }

  const total =
    plan.toolEvents.length + plan.agentRuns.length + plan.verifications.length + plan.approvals.length;
  if (total === 0) {
    console.log("voidarch-context import-runs — nothing to import (no .agent-runs activity found).");
    return;
  }

  const result = await withDb(async (db) => {
    const te = await insertNew(db, "tool_event", "event_hash", (r: ToolEventRow) => r.event_hash, repoId, plan.toolEvents);
    const ar = await insertNew(db, "agent_run", "run_hash", (r: AgentRunRow) => r.run_hash, repoId, plan.agentRuns);
    const vr = await insertNew(db, "verification_run", "vrun_hash", (r: VerificationRunRow) => r.vrun_hash, repoId, plan.verifications);
    const ap = await insertNew(db, "approval", "approval_hash", (r: ApprovalRow) => r.approval_hash, repoId, plan.approvals);
    return { te, ar, vr, ap };
  }, { repoRoot: root });

  printSummary(plan, false);
  console.log("  --- written to SurrealDB ---");
  console.log(`  tool_event:       +${result.te.inserted} new, ${result.te.skipped} already present`);
  console.log(`  agent_run:        +${result.ar.inserted} new, ${result.ar.skipped} already present`);
  console.log(`  verification_run: +${result.vr.inserted} new, ${result.vr.skipped} already present`);
  console.log(`  approval:         +${result.ap.inserted} new, ${result.ap.skipped} already present`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
