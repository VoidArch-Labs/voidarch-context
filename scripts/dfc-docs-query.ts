// voidarch-context docs query — rank document chunks for a query.
//
//   voidarch-context docs query --q "SurrealDB memory architecture" --dry-run  # local, no DB
//   voidarch-context docs query --q "approval gates"                           # BM25 via SurrealDB
//   voidarch-context docs query --q "graph import" --limit 8 --json            # machine output
//
// Dry-run chunks the repo in-memory and scores deterministically (no BM25, no DB),
// so it works with no credentials. Live mode uses the doc_chunk BM25 full-text index.

import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { queryDocChunks, queryDocChunksLocal } from "../src/docs.js";
import { loadConfig, withDb } from "../src/surreal.js";
import type { ContextDocChunkEntry } from "../src/types.js";

function printResults(results: ContextDocChunkEntry[], dryRun: boolean): void {
  console.log(`voidarch-context docs query ${dryRun ? "(DRY RUN — local chunking, no DB)" : "(SurrealDB BM25)"}`);
  if (!results.length) {
    console.log("  (no matching document chunks)");
    return;
  }
  for (const r of results) {
    console.log(`  [${r.score.toFixed(2)}] ${r.source_path} › ${r.heading || "(preamble)"}#${r.chunk_index}`);
    console.log(`         ${r.excerpt.slice(0, 160)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const q = (args.q || "").trim();
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const sourceAgent = normalizeSourceAgent(args.agent);
  const limit = args.limit ? Math.max(1, Number.parseInt(args.limit, 10) || 10) : 10;
  if (!q) {
    console.error("--q is required");
    process.exit(2);
  }

  const repoRoot = repoRootFromArgs(args);
  const repoId = loadConfig({ repoRoot }).repoId;

  const results = dryRun
    ? queryDocChunksLocal(repoRoot, repoId, sourceAgent, q, limit, new Date().toISOString())
    : await withDb(async (db) => queryDocChunks(db, repoId, q, limit), { repoRoot });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(results)}\n`);
    return;
  }
  printResults(results, dryRun);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
