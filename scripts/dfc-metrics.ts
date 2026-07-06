// voidarch-context metrics - deep metrics over the dev-memory database. Human-readable
// summary by default; --json prints compact JSON only.
//   voidarch-context metrics [--days 30] [--json]

import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { collectMetrics, type DfcMetrics } from "../src/metrics.js";
import { withDb } from "../src/surreal.js";

function printCounts(indent: string, counts: Record<string, number>): void {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    console.log(`${indent}(none)`);
    return;
  }
  for (const [key, n] of entries) console.log(`${indent}${key}: ${n}`);
}

function printHuman(m: DfcMetrics): void {
  console.log("voidarch-context metrics");
  console.log(`  repo_id:      ${m.repo_id}`);
  console.log(`  window:       last ${m.days} days`);
  console.log(`  generated_at: ${m.generated_at}`);

  console.log("  -- tables (rows) --");
  for (const [table, n] of Object.entries(m.tables)) {
    console.log(`    ${table.padEnd(18)} ${n}`);
  }

  console.log(`  -- runs (last ${m.days} days) --`);
  console.log(`    total: ${m.runs.total}`);
  console.log("    by status:");
  printCounts("      ", m.runs.by_status);
  console.log("    by source agent:");
  printCounts("      ", m.runs.by_source_agent);

  console.log("  -- tasks --");
  console.log("    by status:");
  printCounts("      ", m.tasks.by_status);
  console.log(`    oldest open: ${m.tasks.oldest_open_age_days ?? "n/a"} days`);

  console.log("  -- blockers --");
  console.log(`    open: ${m.blockers.open}, resolved: ${m.blockers.resolved}`);
  console.log(`    oldest open: ${m.blockers.oldest_open_age_days ?? "n/a"} days`);

  console.log("  -- memory growth (created) --");
  for (const [kind, g] of Object.entries(m.memories)) {
    console.log(`    ${kind.padEnd(10)} 7d: ${g.last_7_days}, 30d: ${g.last_30_days}`);
  }

  console.log("  -- retrieval (context packs) --");
  console.log(`    total: ${m.retrieval.total}, last 7 days: ${m.retrieval.last_7_days}`);
  console.log(`    avg estimated tokens: ${m.retrieval.avg_estimated_tokens ?? "n/a"}`);

  console.log("  -- stale --");
  console.log(`    open tasks > 14 days: ${m.stale.open_tasks_over_14_days.count}`);
  for (const item of m.stale.open_tasks_over_14_days.items) {
    console.log(`      [${item.age_days}d] ${item.summary}`);
  }
  console.log(`    open blockers > 7 days: ${m.stale.open_blockers_over_7_days.count}`);
  for (const item of m.stale.open_blockers_over_7_days.items) {
    console.log(`      [${item.age_days}d] ${item.summary}`);
  }

  console.log(`  -- tool activity (last ${m.days} days) --`);
  console.log(`    total events: ${m.tool_activity.total}`);
  for (const t of m.tool_activity.by_tool) {
    console.log(`    ${t.tool_name.padEnd(18)} ${t.count} (ok: ${t.ok}, fail: ${t.fail})`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const asJson = args.json === "true";
  const days = Number.parseInt(args.days ?? "", 10);
  const repoRoot = repoRootFromArgs(args);

  const metrics = await withDb(
    async (db, cfg) => collectMetrics(db, cfg.repoId, { days: Number.isFinite(days) ? days : undefined }),
    { repoRoot },
  );

  if (asJson) {
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    return;
  }
  printHuman(metrics);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
