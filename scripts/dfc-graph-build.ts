// voidarch-context graph build - build the repo graph DIRECTLY into SurrealDB using the Rust
// graphify-surreal binary (no python graphify → graph.json → voidarch-context graph import chain).
//
//   voidarch-context graph build [--repo-root /path/to/repo] [--deep] [--status|--query "q"]
//
// The binary writes graph_node/graph_edge/graph_snapshot rows in the SAME shape the
// TS readers (voidarch-context context, voidarch-context graph query, dashboard) already consume, into the
// target repo's own DFC database. Binary resolution: $GRAPHIFY_SURREAL_BIN, then
// PATH, then the local dev build.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { loadConfig } from "../src/surreal.js";

const DEV_BUILD = join(homedir(), "Dev", "graphify-surreal", "target", "release", "graphify-surreal");

function resolveBinary(): string | undefined {
  const explicit = process.env.GRAPHIFY_SURREAL_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const onPath = spawnSync("which", ["graphify-surreal"], { encoding: "utf8" }).stdout.trim();
  if (onPath) return onPath;
  if (existsSync(DEV_BUILD)) return DEV_BUILD;
  return undefined;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFromArgs(args);
  const bin = resolveBinary();
  if (!bin) {
    console.error(
      "graphify-surreal binary not found. Set GRAPHIFY_SURREAL_BIN, put it on PATH, or build it:\n" +
        "  cargo build --release -p graphify-surreal   (in the graphify-surreal workspace)",
    );
    process.exit(2);
  }

  const cfg = loadConfig({ repoRoot });
  if (!cfg.url || !cfg.username || !cfg.password || /<[^>]+>/.test(cfg.url + cfg.username + cfg.password)) {
    console.error("No usable SurrealDB credentials for this repo (.dfc/surreal.env). Run voidarch-context init / db:check first.");
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

  if (args.status === "true") {
    process.exit(run(["status"]));
  }
  if (args.query) {
    process.exit(run(["query", args.query]));
  }

  // Default flow: ensure tables/indexes exist, then AST-build straight into SurrealDB.
  // --deep opts into the agent-harness semantic pass (external executors; slower).
  const initCode = run(["init-db"]);
  if (initCode !== 0) process.exit(initCode);
  const buildArgs = ["build", repoRoot];
  if (args.deep === "true") buildArgs.push("--deep");
  else buildArgs.push("--ast-only");
  const code = run(buildArgs);
  if (code === 0) run(["status"]);
  process.exit(code);
}

main();
