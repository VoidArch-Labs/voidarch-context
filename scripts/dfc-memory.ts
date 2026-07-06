// voidarch-context memory - unified CRUD over the memory kinds.
//   voidarch-context memory add    --kind lesson --text "..." [--tags a,b] [--task goal]
//   voidarch-context memory add    --kind snippet --file src/x.ts --language ts --path src/x.ts
//   voidarch-context memory list   --kind repo_fact [--limit 20] [--json]
//   voidarch-context memory search --kind decision --query "surrealdb" [--limit 10]
//   voidarch-context memory get|update|delete --kind lesson --id lesson:abc123
//   voidarch-context memory list|get|delete --kind context   (context packs, read/delete only)

import { readFileSync } from "node:fs";
import { RecordId, StringRecordId, Table } from "surrealdb";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, positiveIntArg, repoRootFromArgs, type CliArgs } from "../src/cli.js";
import { queryResult, withDb } from "../src/surreal.js";
import { detectRiskTerms, tokenize } from "../src/scoring.js";
import type { MemoryRecord } from "../src/types.js";

const KIND_TABLES: Record<string, string> = {
  decision: "decision",
  evidence: "evidence_item",
  lesson: "lesson",
  snippet: "snippet",
  repo_fact: "repo_fact",
  task_note: "task_note",
  context: "context_pack",
};
const SUBCOMMANDS = new Set(["add", "list", "search", "get", "update", "delete"]);
const CONTEXT_SUBCOMMANDS = new Set(["list", "get", "delete"]);

function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: voidarch-context memory <add|list|search|get|update|delete> --kind <decision|evidence|lesson|snippet|repo_fact|task_note|context> [flags]",
  );
  process.exit(2);
}

/** First sentence, capped at 140 chars (same rule as voidarch-context remember). */
function summarize(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const s = firstSentence.length <= 140 ? firstSentence : `${text.slice(0, 137)}...`;
  return s.trim();
}

/** Accept `table:xyz` (full form) or bare `xyz` ids. */
function parseId(raw: string, table: string): RecordId | StringRecordId {
  return raw.includes(":") ? new StringRecordId(raw) : new RecordId(table, raw);
}

function buildTags(text: string, extra?: string): string[] {
  const cli = (extra ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return Array.from(new Set([...detectRiskTerms(text), ...tokenize(text).slice(0, 5), ...cli]));
}

type Row = MemoryRecord & { id?: unknown };

function printLine(r: Row): void {
  const tags = (r.tags ?? []).join(",");
  console.log(`${String(r.id)}  ${r.created_at}  ${r.summary}${tags ? `  [${tags}]` : ""}`);
}

function requireArg(args: CliArgs, key: string): string {
  const v = (args[key] || "").trim();
  if (!v || v === "true") usage(`--${key} is required`);
  return v;
}

async function main(): Promise<void> {
  const [sub = "", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!SUBCOMMANDS.has(sub)) usage(`unknown subcommand "${sub}"`);
  const kind = (args.kind || "").toLowerCase();
  const table = KIND_TABLES[kind];
  if (!table) usage(`--kind must be one of ${Object.keys(KIND_TABLES).join("|")}`);
  if (kind === "context" && !CONTEXT_SUBCOMMANDS.has(sub)) {
    usage(`--kind context supports only ${[...CONTEXT_SUBCOMMANDS].join("|")} (adds happen via voidarch-context context)`);
  }
  const repoRoot = repoRootFromArgs(args);
  const now = new Date().toISOString();

  await withDb(async (db, cfg) => {
    if (sub === "add") {
      const text = (args.file ? readFileSync(args.file, "utf8") : args.text || "").trim();
      if (!text) usage("--text (or --file) is required");
      const taskGoal = (args.task || "").trim();
      const doc: MemoryRecord = {
        repo_id: cfg.repoId,
        source_agent: normalizeSourceAgent(args.agent),
        text,
        summary: summarize(text),
        tags: buildTags(text, args.tags),
        ...(taskGoal ? { task_goal: taskGoal } : {}),
        ...(kind === "snippet" && args.language ? { language: args.language } : {}),
        ...(kind === "snippet" && args.path ? { source_path: args.path } : {}),
        created_at: now,
        updated_at: now,
      };
      const created = await db.create(new Table(table)).content(doc as unknown as Record<string, unknown>);
      const rows = Array.isArray(created) ? (created as Row[]) : [created as Row];
      console.log(`created ${String(rows[0]?.id ?? "(created)")}`);
      return;
    }

    if (sub === "list") {
      const limit = positiveIntArg(args, "limit") ?? 20;
      if (kind === "context") {
        const rows = await queryResult<Array<Record<string, unknown>>>(
          db,
          "SELECT id, goal, phase, estimated_tokens, created_at FROM context_pack WHERE repo_id = $repo ORDER BY created_at DESC LIMIT $limit",
          { repo: cfg.repoId, limit },
        );
        if (args.json === "true") { console.log(JSON.stringify(rows, null, 2)); return; }
        for (const r of rows) {
          console.log(`${String(r.id)}  ${String(r.created_at)}  ~${String(r.estimated_tokens ?? "?")}tok  ${String(r.goal ?? "")}`);
        }
        return;
      }
      const rows = await queryResult<Row[]>(
        db,
        `SELECT * FROM ${table} WHERE repo_id = $repo ORDER BY created_at DESC LIMIT $limit`,
        { repo: cfg.repoId, limit },
      );
      if (args.json === "true") { console.log(JSON.stringify(rows, null, 2)); return; }
      rows.forEach(printLine);
      return;
    }

    if (sub === "search") {
      const q = requireArg(args, "query");
      const limit = positiveIntArg(args, "limit") ?? 10;
      let rows = await queryResult<Row[]>(
        db,
        `SELECT * FROM ${table} WHERE repo_id = $repo AND (summary @@ $q OR text @@ $q) LIMIT $limit`,
        { repo: cfg.repoId, q, limit },
      );
      if (rows.length === 0) {
        // ponytail: substring fallback when BM25 finds nothing (fresh index, stemming miss)
        rows = await queryResult<Row[]>(
          db,
          `SELECT * FROM ${table} WHERE repo_id = $repo AND string::contains(string::lowercase(text), $q) LIMIT $limit`,
          { repo: cfg.repoId, q: q.toLowerCase(), limit },
        );
      }
      if (args.json === "true") { console.log(JSON.stringify(rows, null, 2)); return; }
      rows.forEach(printLine);
      return;
    }

    // get / update / delete all need --id.
    const rid = parseId(requireArg(args, "id"), table);

    if (sub === "get") {
      const rows = await queryResult<Row[]>(db, "SELECT * FROM $th", { th: rid });
      if (rows.length === 0) throw new Error(`not found: ${args.id}`);
      console.log(JSON.stringify(rows[0], null, 2));
      return;
    }

    if (sub === "update") {
      const patch: Record<string, unknown> = { updated_at: now };
      const text = (args.text || "").trim();
      if (text) {
        patch.text = text;
        patch.summary = summarize(text);
      }
      if (args.tags) patch.tags = buildTags(text, args.tags);
      const taskGoal = (args.task || "").trim();
      if (taskGoal) patch.task_goal = taskGoal;
      if (Object.keys(patch).length === 1) usage("update needs at least one of --text/--tags/--task");
      const rows = await queryResult<Row[]>(db, "UPDATE $th MERGE $patch", { th: rid, patch });
      if (rows.length === 0) throw new Error(`not found: ${args.id}`);
      console.log(`updated ${String(rows[0]?.id)}`);
      return;
    }

    // delete
    const rows = await queryResult<Row[]>(db, "DELETE $th RETURN BEFORE", { th: rid });
    console.log(rows.length === 0 ? `not found: ${args.id}` : `deleted ${String(rows[0]?.id)}`);
  }, { repoRoot });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
