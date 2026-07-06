// voidarch-context sync - one-way copy of this repo's memory between two SurrealDB instances.
// Push the current config DB to a target (`--to <url>`) or pull from a source
// (`--from <url>`). Same namespace/database as the current config on both ends.
//
// NOTE: SurrealKV holds a single-process LOCK — an embedded database (source or
// target) must not be in use by another dfc command or dashboard while syncing.

import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { upsertBatches, type UpsertBatchRow } from "../src/batch.js";
import {
  assertUsableConfig,
  connect,
  isEmbeddedUrl,
  loadConfig,
  queryResult,
} from "../src/surreal.js";
import type { DfcConfig } from "../src/types.js";
import { resolve } from "node:path";
import type { RecordId } from "surrealdb";

// ponytail: mirrors REPO_SCOPED_TABLES in src/memory/metrics.ts (not exported
// there; do not touch other files). "repo" added so the target gets the repo row.
const SYNC_TABLES = [
  "repo",
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

const HELP = `voidarch-context sync - one-way copy of this repo's memory between SurrealDB instances

Usage:
  voidarch-context sync --to <url>     push from current config DB to <url>
  voidarch-context sync --from <url>   pull from <url> into current config DB

Options:
  --user <u> / --pass <p>  credentials for the OTHER (remote) end
                           (or DFC_SYNC_USER / DFC_SYNC_PASS env);
                           skipped for embedded URLs (surrealkv://, rocksdb://, mem://)
  --dry-run                print per-table row counts that would sync, write nothing
  --repo-root <path>       target repo root (same as other dfc scripts)

Copies rows WHERE repo_id = <current repo id> for each repo-scoped table,
upserting by record id. Namespace/database: same as current config.

WARNING: SurrealKV allows only ONE process per data directory (LOCK file).
Make sure no other dfc command or dashboard is using an embedded database
involved in the sync.`;

/** Relative embedded paths (surrealkv://.dfc/x) resolve against the repo root. */
function absolutizeUrl(url: string, repoRoot: string): string {
  const m = /^((?:surrealkv(?:\+versioned)?|rocksdb):\/\/)([^/].*)$/.exec(url.trim());
  return m ? `${m[1]}${resolve(repoRoot, m[2])}` : url.trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const to = args.to;
  const from = args.from;
  if (Boolean(to) === Boolean(from) || to === "true" || from === "true") {
    console.log(HELP);
    throw new Error("Pass exactly one of --to <url> or --from <url>.");
  }
  const dryRun = args["dry-run"] === "true";
  const repoRoot = repoRootFromArgs(args);

  const localCfg = loadConfig({ repoRoot });
  assertUsableConfig(localCfg);

  const otherUrl = absolutizeUrl((to || from) as string, repoRoot);
  const otherCfg: DfcConfig = {
    ...localCfg,
    url: otherUrl,
    username: args.user || process.env.DFC_SYNC_USER || "",
    password: args.pass || process.env.DFC_SYNC_PASS || "",
  };
  if (!isEmbeddedUrl(otherUrl)) assertUsableConfig(otherCfg);

  const [sourceCfg, targetCfg] = to ? [localCfg, otherCfg] : [otherCfg, localCfg];
  console.log(`Sync ${sourceCfg.url} -> ${targetCfg.url}`);
  console.log(`Namespace: ${localCfg.namespace}  Database: ${localCfg.database}  Repo ID: ${localCfg.repoId}${dryRun ? "  (dry run)" : ""}`);

  const source = await connect(sourceCfg);
  try {
    const target = dryRun ? null : await connect(targetCfg);
    try {
      let total = 0;
      for (const table of SYNC_TABLES) {
        let rows: Array<Record<string, unknown> & { id: RecordId }> = [];
        try {
          rows = await queryResult(
            source,
            "SELECT * FROM type::table($t) WHERE repo_id = $repo",
            { t: table, repo: localCfg.repoId },
          );
        } catch {
          // table missing on source — nothing to sync
        }
        if (target && rows.length) {
          const batch: UpsertBatchRow[] = rows.map(({ id, ...record }) => ({ id, record }));
          await upsertBatches(target, batch, 50);
        }
        total += rows.length;
        console.log(`${table}: ${rows.length}${dryRun ? " (would sync)" : ""}`);
      }
      console.log(`Total: ${total} row(s)${dryRun ? " would sync" : " synced"}`);
    } finally {
      await target?.close().catch(() => {});
    }
  } finally {
    await source.close().catch(() => {});
  }
}

try {
  await main();
  process.exit(0); // explicit: embedded engine keeps the event loop alive otherwise
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
