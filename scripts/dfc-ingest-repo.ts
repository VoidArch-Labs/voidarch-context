// voidarch-context ingest - scan repo text files and upsert them into SurrealDB.

import { ingestRepo } from "../src/ingest.js";
import { withDb } from "../src/surreal.js";
import { normalizeSourceAgent } from "../src/agents.js";
import { parseArgs, positiveIntArg, repoRootFromArgs } from "../src/cli.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceAgent = normalizeSourceAgent(args.agent);
  const repoRoot = repoRootFromArgs(args);
  const maxWrites = positiveIntArg(args, "limit");
  await withDb(async (db, cfg) => {
    console.log(`ingesting ${cfg.repoId} from ${repoRoot} as ${sourceAgent} ...`);
    const stats = await ingestRepo(db, cfg.repoId, repoRoot, sourceAgent, { maxWrites });
    console.log(
      `ingest complete: scanned ${stats.scanned}, ingested ${stats.ingested}, skipped ${stats.skipped}, unchanged ${stats.unchanged}, limited ${stats.limited}`,
    );
  }, { repoRoot });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
