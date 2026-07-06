// voidarch-context blocker - blocker state on the `blocker` table (schema 0004).
//   voidarch-context blocker add --text "CI fails on Node 20" [--task goal] [--session s1] [--tags a,b]
//   voidarch-context blocker list [--all] [--json]        (default: open only)
//   voidarch-context blocker resolve --id blocker:abc [--note "bumped Node to 22"]
//   voidarch-context blocker get|delete --id blocker:abc

import { RecordId, StringRecordId, Table } from "surrealdb";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, positiveIntArg, repoRootFromArgs } from "../src/cli.js";
import { queryResult, withDb } from "../src/surreal.js";
import { detectRiskTerms, tokenize } from "../src/scoring.js";
import type { BlockerRecord } from "../src/types.js";

const SUBCOMMANDS = new Set(["add", "list", "resolve", "get", "delete"]);

function usage(msg: string): never {
  console.error(msg);
  console.error("usage: voidarch-context blocker <add|list|resolve|get|delete> [--text ...] [--id ...]");
  process.exit(2);
}

/** First sentence, capped at 140 chars (same rule as voidarch-context remember). */
function summarize(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const s = firstSentence.length <= 140 ? firstSentence : `${text.slice(0, 137)}...`;
  return s.trim();
}

function parseId(raw: string): RecordId | StringRecordId {
  return raw.includes(":") ? new StringRecordId(raw) : new RecordId("blocker", raw);
}

type Row = Partial<BlockerRecord> & { id?: unknown };

function printLine(r: Row): void {
  console.log(`${String(r.id)}  [${r.status ?? "?"}]  ${r.created_at ?? ""}  ${r.summary ?? ""}`);
}

async function main(): Promise<void> {
  const [sub = "", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!SUBCOMMANDS.has(sub)) usage(`unknown subcommand "${sub}"`);
  const repoRoot = repoRootFromArgs(args);
  const now = new Date().toISOString();

  await withDb(async (db, cfg) => {
    if (sub === "add") {
      const text = (args.text || "").trim();
      if (!text) usage("--text is required");
      const cliTags = (args.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const taskGoal = (args.task || "").trim();
      const sessionId = (args.session || "").trim();
      const doc: BlockerRecord = {
        repo_id: cfg.repoId,
        source_agent: normalizeSourceAgent(args.agent),
        text,
        summary: summarize(text),
        tags: Array.from(new Set([...detectRiskTerms(text), ...tokenize(text).slice(0, 5), ...cliTags])),
        status: "open",
        ...(taskGoal ? { task_goal: taskGoal } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        created_at: now,
        updated_at: now,
      };
      const created = await db.create(new Table("blocker")).content(doc as unknown as Record<string, unknown>);
      const rows = Array.isArray(created) ? (created as Row[]) : [created as Row];
      console.log(`created ${String(rows[0]?.id ?? "(created)")}`);
      return;
    }

    if (sub === "list") {
      const limit = positiveIntArg(args, "limit") ?? 50;
      const where =
        args.all === "true" ? "repo_id = $repo" : "repo_id = $repo AND status = 'open'";
      const rows = await queryResult<Row[]>(
        db,
        `SELECT * FROM blocker WHERE ${where} ORDER BY created_at DESC LIMIT $limit`,
        { repo: cfg.repoId, limit },
      );
      if (args.json === "true") { console.log(JSON.stringify(rows, null, 2)); return; }
      rows.forEach(printLine);
      return;
    }

    // resolve / get / delete need --id.
    const rawId = (args.id || "").trim();
    if (!rawId) usage("--id is required");
    const rid = parseId(rawId);

    if (sub === "get") {
      const rows = await queryResult<Row[]>(db, "SELECT * FROM $th", { th: rid });
      if (rows.length === 0) throw new Error(`not found: ${rawId}`);
      console.log(JSON.stringify(rows[0], null, 2));
      return;
    }

    if (sub === "resolve") {
      const note = (args.note || "").trim();
      const rows = await queryResult<Row[]>(
        db,
        "UPDATE $th SET status = 'resolved', resolved_at = $now, updated_at = $now, text = text + $suffix",
        { th: rid, now, suffix: note && note !== "true" ? `\n[resolved] ${note}` : "" },
      );
      if (rows.length === 0) throw new Error(`not found: ${rawId}`);
      console.log(`resolved ${String(rows[0]?.id)}`);
      return;
    }

    // delete
    const rows = await queryResult<Row[]>(db, "DELETE $th RETURN BEFORE", { th: rid });
    console.log(rows.length === 0 ? `not found: ${rawId}` : `deleted ${String(rows[0]?.id)}`);
  }, { repoRoot });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
