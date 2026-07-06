// voidarch-context db migrate - apply schema/0001_core.surql then schema/0002_indexes.surql
// through the SurrealDB SDK. Prints applied file names; fails clearly on error.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import {
  assertUsableConfig,
  authenticate,
  createClient,
  isEmbeddedUrl,
  loadConfig,
  queryResults,
  PKG_ROOT,
  MIGRATIONS,
} from "../src/surreal.js";



function ident(name: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} must be a simple SurrealDB identifier: ${name}`);
  }
  return name;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFromArgs(args);
  const cfg = loadConfig({ repoRoot });
  assertUsableConfig(cfg);

  const embedded = isEmbeddedUrl(cfg.url);
  const db = await createClient(cfg);
  await db.connect(cfg.url);
  try {
    if (!embedded) await authenticate(db, cfg);

    if (embedded || cfg.authScope === "root") {
      const ns = ident(cfg.namespace, "DFC_SURREAL_NS");
      const database = ident(cfg.database, "DFC_SURREAL_DB");
      await queryResults(db, `DEFINE NAMESPACE IF NOT EXISTS ${ns}`);
      await queryResults(db, `USE NS ${ns}; DEFINE DATABASE IF NOT EXISTS ${database}`);
      console.log(`ensured namespace/database: ${cfg.namespace}/${cfg.database}`);
    }

    await db.use({ namespace: cfg.namespace, database: cfg.database });

    for (const rel of MIGRATIONS) {
      const surql = readFileSync(join(PKG_ROOT, rel), "utf8");
      try {
        await queryResults(db, surql);
        console.log(`applied: ${rel}`);
      } catch (err) {
        console.error(`FAILED applying ${rel}: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    console.log("migration complete");
  } finally {
    await db.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
