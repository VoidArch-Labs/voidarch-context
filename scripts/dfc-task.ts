// voidarch-context task - task state on the existing `task` table.
//   voidarch-context task add --goal "Ship CRUD scripts" [--status open] [--tags a,b]
//   voidarch-context task list [--status open|in_progress|blocked|done] [--all] [--json]
//   voidarch-context task update --id task:abc --status in_progress [--goal "..."]
//   voidarch-context task done --id task:abc
//   voidarch-context task get|delete --id task:abc
// Legacy rows (context-pack audit trail) have goal but no status; the default
// list excludes them, --all shows them.

import { RecordId, StringRecordId, Table } from "surrealdb";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, positiveIntArg, repoRootFromArgs } from "../src/cli.js";
import { queryResult, withDb } from "../src/surreal.js";
import { detectRiskTerms, tokenize } from "../src/scoring.js";
import type { TaskStateRecord, TaskStatus } from "../src/types.js";

const SUBCOMMANDS = new Set(["add", "list", "update", "done", "get", "delete"]);
const STATUSES = new Set<TaskStatus>(["open", "in_progress", "blocked", "done"]);

function usage(msg: string): never {
  console.error(msg);
  console.error("usage: voidarch-context task <add|list|update|done|get|delete> [--goal ...] [--id ...] [--status ...]");
  process.exit(2);
}

function parseStatus(raw: string): TaskStatus {
  const s = raw.trim().toLowerCase() as TaskStatus;
  if (!STATUSES.has(s)) usage(`--status must be one of ${[...STATUSES].join("|")}`);
  return s;
}

function parseId(raw: string): RecordId | StringRecordId {
  return raw.includes(":") ? new StringRecordId(raw) : new RecordId("task", raw);
}

type Row = Partial<TaskStateRecord> & { id?: unknown };

function printLine(r: Row): void {
  console.log(`${String(r.id)}  [${r.status ?? "legacy"}]  ${r.created_at ?? ""}  ${r.goal ?? ""}`);
}

async function main(): Promise<void> {
  const [sub = "", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!SUBCOMMANDS.has(sub)) usage(`unknown subcommand "${sub}"`);
  const repoRoot = repoRootFromArgs(args);
  const now = new Date().toISOString();

  await withDb(async (db, cfg) => {
    if (sub === "add") {
      const goal = (args.goal || "").trim();
      if (!goal) usage("--goal is required");
      const cliTags = (args.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const doc: TaskStateRecord = {
        repo_id: cfg.repoId,
        source_agent: normalizeSourceAgent(args.agent),
        goal,
        status: args.status ? parseStatus(args.status) : "open",
        tags: Array.from(new Set([...detectRiskTerms(goal), ...tokenize(goal).slice(0, 5), ...cliTags])),
        created_at: now,
        updated_at: now,
      };
      const created = await db.create(new Table("task")).content(doc as unknown as Record<string, unknown>);
      const rows = Array.isArray(created) ? (created as Row[]) : [created as Row];
      console.log(`created ${String(rows[0]?.id ?? "(created)")}`);
      return;
    }

    if (sub === "list") {
      const limit = positiveIntArg(args, "limit") ?? 50;
      let where = "repo_id = $repo AND status != NONE AND status != 'done'";
      const bindings: Record<string, unknown> = { repo: cfg.repoId, limit };
      if (args.status) {
        where = "repo_id = $repo AND status = $status";
        bindings.status = parseStatus(args.status);
      } else if (args.all === "true") {
        where = "repo_id = $repo";
      }
      const rows = await queryResult<Row[]>(
        db,
        `SELECT * FROM task WHERE ${where} ORDER BY created_at DESC LIMIT $limit`,
        bindings,
      );
      if (args.json === "true") { console.log(JSON.stringify(rows, null, 2)); return; }
      rows.forEach(printLine);
      return;
    }

    // update / done / get / delete need --id.
    const rawId = (args.id || "").trim();
    if (!rawId) usage("--id is required");
    const rid = parseId(rawId);

    if (sub === "get") {
      const rows = await queryResult<Row[]>(db, "SELECT * FROM $th", { th: rid });
      if (rows.length === 0) throw new Error(`not found: ${rawId}`);
      console.log(JSON.stringify(rows[0], null, 2));
      return;
    }

    if (sub === "update" || sub === "done") {
      const patch: Record<string, unknown> = { updated_at: now };
      if (sub === "done") {
        patch.status = "done";
        patch.done_at = now;
      } else {
        if (args.status) patch.status = parseStatus(args.status);
        const goal = (args.goal || "").trim();
        if (goal) patch.goal = goal;
        if (Object.keys(patch).length === 1) usage("update needs --status and/or --goal");
      }
      const rows = await queryResult<Row[]>(db, "UPDATE $th MERGE $patch", { th: rid, patch });
      if (rows.length === 0) throw new Error(`not found: ${rawId}`);
      console.log(`${sub === "done" ? "done" : "updated"} ${String(rows[0]?.id)}`);
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
