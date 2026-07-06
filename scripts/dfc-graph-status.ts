// voidarch-context graph status — report graph freshness + counts.
//
//   voidarch-context graph status --dry-run   # read graphify-out/graph.json + git HEAD, no DB
//   voidarch-context graph status             # latest persisted snapshot from SurrealDB
//   voidarch-context graph status --json      # machine output

import { graphStatusDb, graphStatusLocal, type GraphStatus } from "../src/graph.js";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { loadConfig, withDb } from "../src/surreal.js";

function printStatus(s: GraphStatus, dryRun: boolean): void {
  console.log(`voidarch-context graph status ${dryRun ? "(DRY RUN — local graph.json)" : "(SurrealDB snapshot)"}`);
  console.log(`  configured:      ${s.configured}`);
  console.log(`  built_at_commit: ${s.built_at_commit || "(unknown)"}`);
  console.log(`  current_commit:  ${s.current_commit || "(unknown)"}`);
  console.log(`  fresh vs HEAD:   ${s.is_fresh}`);
  console.log(`  nodes:           ${s.node_count}`);
  console.log(`  edges:           ${s.edge_count}`);
  console.log(`  hyperedges:      ${s.hyperedge_count}`);
  if (Object.keys(s.kind_counts).length) {
    console.log(`  node kinds:      ${Object.entries(s.kind_counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (Object.keys(s.relation_counts).length) {
    console.log(`  edge relations:  ${Object.entries(s.relation_counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  console.log(`  note:            ${s.note}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const root = repoRootFromArgs(args);
  const cfg = loadConfig({ repoRoot: root });

  const status = dryRun
    ? graphStatusLocal(root)
    : await withDb(async (db) => graphStatusDb(db, cfg.repoId, root), { repoRoot: root });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  printStatus(status, dryRun);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
