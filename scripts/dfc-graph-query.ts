// voidarch-context graph query — rank graph nodes for a query + show their neighborhood edges.
//
//   voidarch-context graph query --q "SurrealDB context pack" --dry-run  # local graph.json
//   voidarch-context graph query --q "approval gate"                     # SurrealDB (BM25 + degree)
//   voidarch-context graph query --q "hooks" --limit 8 --json            # machine output

import {
  buildGraphPlan,
  currentGitCommit,
  findGraphFile,
  loadGraph,
  queryGraph,
  queryGraphLocal,
  type GraphQueryResult,
} from "../src/graph.js";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { loadConfig, withDb } from "../src/surreal.js";

function printResult(r: GraphQueryResult, dryRun: boolean): void {
  console.log(`voidarch-context graph query ${dryRun ? "(DRY RUN — local graph.json)" : "(SurrealDB)"}`);
  if (!r.nodes.length) {
    console.log("  (no matching graph nodes)");
    return;
  }
  console.log("  nodes:");
  for (const n of r.nodes) {
    console.log(`    [${n.score.toFixed(2)}] ${n.label} (${n.kind}, deg ${n.degree}) — ${n.source_file}${n.source_location ? `:${n.source_location}` : ""}`);
  }
  if (r.edges.length) {
    console.log("  neighborhood edges:");
    for (const e of r.edges.slice(0, 12)) {
      console.log(`    [${e.score.toFixed(2)}] ${e.src} --${e.relation}--> ${e.dst}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const q = (args.q || "").trim();
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const limit = args.limit ? Math.max(1, Number.parseInt(args.limit, 10) || 10) : 10;
  if (!q) {
    console.error("--q is required");
    process.exit(2);
  }
  const root = repoRootFromArgs(args);
  const cfg = loadConfig({ repoRoot: root });

  let result: GraphQueryResult;
  if (dryRun) {
    const file = findGraphFile(root);
    if (!file) {
      console.error("voidarch-context graph query — no graphify-out/graph.json found; run `/graphify` first.");
      if (asJson) process.stdout.write(`${JSON.stringify({ nodes: [], edges: [] })}\n`);
      return;
    }
    const plan = buildGraphPlan(
      loadGraph(file),
      cfg.repoId,
      normalizeSourceAgent(args.agent),
      currentGitCommit(root),
      new Date().toISOString(),
    );
    result = queryGraphLocal(plan, q, limit);
  } else {
    result = await withDb(async (db) => queryGraph(db, cfg.repoId, q, limit), { repoRoot: root });
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  printResult(result, dryRun);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
