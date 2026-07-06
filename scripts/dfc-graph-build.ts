// voidarch-context graph build — build the repo graph into SurrealDB.
//
// Default engine is the NATIVE builder (src/graph-build.ts): Tree-sitter
// (WASM grammars, no native compilation) with regex fallback — file nodes +
// exported/top-level symbols + import edges, written through the same
// buildGraphPlan/importGraph pipeline the readers (query/context/status)
// consume. Works against the zero-config embedded database — no external
// binary, no credentials.
//
//   voidarch-context graph build [--repo-root /path] [--dry-run] [--json]
//
// The optional Rust engine (external `graphify-surreal` binary; deeper AST /
// semantic pass, hosted DB) remains available:
//
//   voidarch-context graph build --engine graphify-surreal [--deep] [--status|--query "q"]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { buildNativeGraph } from "../src/graph-build.js";
import { buildGraphPlan, currentGitCommit, importGraph } from "../src/graph.js";
import { loadConfig, withDb } from "../src/surreal.js";

const DEV_BUILD = join(homedir(), "Dev", "graphify-surreal", "target", "release", "graphify-surreal");

function resolveBinary(): string | undefined {
  const explicit = process.env.GRAPHIFY_SURREAL_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const onPath = spawnSync("which", ["graphify-surreal"], { encoding: "utf8" }).stdout.trim();
  if (onPath) return onPath;
  if (existsSync(DEV_BUILD)) return DEV_BUILD;
  return undefined;
}

async function nativeBuild(repoRoot: string, args: Record<string, string>): Promise<void> {
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const sourceAgent = normalizeSourceAgent(args.agent);
  const commit = currentGitCommit(repoRoot);
  const { graph, stats } = await buildNativeGraph(repoRoot, commit);

  if (dryRun) {
    if (asJson) console.log(JSON.stringify({ engine: "native", dryRun: true, ...stats }, null, 2));
    else console.log(`voidarch-context graph build (native/${stats.parser}, DRY RUN — no writes)\n  files: ${stats.files}\n  symbols: ${stats.symbols}\n  edges: ${stats.edges}`);
    return;
  }

  const imported = await withDb(async (db, cfg) => {
    const plan = buildGraphPlan(graph, cfg.repoId, sourceAgent, commit, new Date().toISOString());
    return importGraph(db, plan);
  }, { repoRoot });

  if (asJson) {
    console.log(JSON.stringify({ engine: "native", ...stats, ...imported }, null, 2));
    return;
  }
  console.log(`voidarch-context graph build (native/${stats.parser})`);
  console.log(`  snapshot:   ${imported.snapshotId} (fresh: ${imported.isFresh})`);
  console.log(`  nodes:      ${imported.nodes} (${stats.symbols} symbols)`);
  console.log(`  edges:      ${imported.edges}`);
  console.log(`  next:       voidarch-context query "<question>"`);
}

function rustBuild(repoRoot: string, args: Record<string, string>): void {
  const bin = resolveBinary();
  if (!bin) {
    console.error(
      "graphify-surreal binary not found. Set GRAPHIFY_SURREAL_BIN, put it on PATH, or build it:\n" +
        "  cargo build --release -p graphify-surreal   (in the graphify-surreal workspace)\n" +
        "Or drop --engine and use the built-in native builder.",
    );
    process.exit(2);
  }

  const cfg = loadConfig({ repoRoot });
  if (!cfg.url || !cfg.username || !cfg.password || /<[^>]+>/.test(cfg.url + cfg.username + cfg.password)) {
    console.error("The graphify-surreal engine needs hosted SurrealDB credentials (DFC_SURREAL_*). Use the default native engine for the embedded database.");
    process.exit(2);
  }

  // Same instance + the repo's OWN database, so TS readers see the graph directly.
  const env = {
    ...process.env,
    GRAPHIFY_SURREAL_URL: cfg.url,
    GRAPHIFY_SURREAL_NS: cfg.namespace,
    GRAPHIFY_SURREAL_DB: cfg.database,
    GRAPHIFY_SURREAL_USER: cfg.username,
    GRAPHIFY_SURREAL_PASS: cfg.password,
    GRAPHIFY_REPO_ID: cfg.repoId,
  };

  const run = (argv: string[]): number => {
    console.log(`graphify-surreal ${argv.join(" ")}  [db: ${cfg.database}]`);
    const res = spawnSync(bin, argv, { stdio: "inherit", env });
    return res.status ?? 1;
  };

  if (args.status === "true") process.exit(run(["status"]));
  if (args.query) process.exit(run(["query", args.query]));

  const initCode = run(["init-db"]);
  if (initCode !== 0) process.exit(initCode);
  const buildArgs = ["build", repoRoot];
  if (args.deep === "true") buildArgs.push("--deep");
  else buildArgs.push("--ast-only");
  const code = run(buildArgs);
  if (code === 0) run(["status"]);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFromArgs(args);
  const engine = args.engine || "native";
  if (engine === "graphify-surreal" || engine === "rust" || args.deep === "true") {
    rustBuild(repoRoot, args);
    return;
  }
  if (engine !== "native") {
    console.error(`Unknown --engine "${engine}" (native | graphify-surreal)`);
    process.exit(2);
  }
  await nativeBuild(repoRoot, args);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
