// voidarch-context memory gc — garbage-collect stale vector rows.
//
//   voidarch-context memory gc --dry-run   # report orphan/mismatched embeddings (no deletes)
//   voidarch-context memory gc             # delete them
//
// Removes embedding_chunk rows whose source doc_chunk content hash no longer exists,
// and embeddings whose dimension disagrees with their registered model. Resilient:
// with no SurrealDB credentials it reports "not configured" and exits 0.

import type { Surreal } from "surrealdb";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { assertUsableConfig, connect, loadConfig } from "../src/surreal.js";
import { findGcCandidates, runGc } from "../src/vectors.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === "true";
  const asJson = args.json === "true";
  const repoRoot = repoRootFromArgs(args);
  const cfg = loadConfig({ repoRoot });

  console.log(`voidarch-context memory gc ${dryRun ? "(DRY RUN — no deletes)" : ""}`.trim());

  try {
    assertUsableConfig(cfg);
  } catch (err) {
    console.log(`  database not configured — nothing to scan (${(err as Error).message.split(".")[0]}).`);
    if (asJson) process.stdout.write(`${JSON.stringify({ configured: false, orphans: 0, mismatched: 0 })}\n`);
    return;
  }

  let db: Surreal | null = null;
  try {
    db = await connect(cfg);
    const candidates = await findGcCandidates(db, cfg.repoId);
    if (dryRun) {
      console.log(`  orphan embeddings (source chunk gone): ${candidates.orphans}`);
      console.log(`  dimension-mismatched embeddings:       ${candidates.mismatched}`);
      if (asJson) process.stdout.write(`${JSON.stringify({ configured: true, ...candidates, orphanHashes: undefined })}\n`);
      return;
    }
    const result = await runGc(db, cfg.repoId);
    console.log(`  orphans removed:    ${result.orphansRemoved}`);
    console.log(`  mismatched removed: ${result.mismatchedRemoved}`);
    if (asJson) process.stdout.write(`${JSON.stringify({ configured: true, ...result })}\n`);
  } finally {
    if (db) {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
