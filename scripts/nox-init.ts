// voidarch-context init — scaffold `.voidarch/config.json` in the TARGET repo +
// gitignore entries. Idempotent: re-running updates nothing that already matches
// and never clobbers legacy .dfc/*.env files (those keep full precedence over
// .voidarch/config.json).
//
//   voidarch-context init [--repo-root /path/to/repo] [--repo-id my-repo]

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { VOIDARCH_CONFIG_SCHEMA_VERSION, voidarchConfigPath, readVoidarchConfig, writeVoidarchConfig } from "../src/voidarch-config.js";

const GITIGNORE_LINES = [".voidarch/db/", ".voidarch/runtime/", ".dfc/dev-memory/", ".dfc/*.env", "!.dfc/*.example.env"];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function ensureGitignore(repoRoot: string): { added: string[]; already: boolean } {
  const path = join(repoRoot, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !existingLines.has(l));
  if (!missing.length) return { added: [], already: true };
  const block = (existing && !existing.endsWith("\n") ? "\n" : "") + "\n# voidarch-context\n" + missing.join("\n") + "\n";
  appendFileSync(path, block);
  return { added: missing, already: false };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFromArgs(args);
  const repoId = args["repo-id"] || slugify(basename(repoRoot));

  const existing = readVoidarchConfig(repoRoot);
  if (existing) {
    console.log(`voidarch-context init — already initialized: ${voidarchConfigPath(repoRoot)}`);
    console.log(`  repoId:     ${existing.repoId}`);
    console.log(`  embedding:  ${existing.embedding?.provider ?? "local"}`);
    console.log(`  createdAt:  ${existing.createdAt}`);
  } else {
    writeVoidarchConfig(repoRoot, {
      repoId,
      embedding: { provider: "local" },
      createdAt: new Date().toISOString(),
      schemaVersion: VOIDARCH_CONFIG_SCHEMA_VERSION,
    });
    console.log(`voidarch-context init — wrote ${voidarchConfigPath(repoRoot)} (repoId: ${repoId}, embedding: local)`);
  }

  const gi = ensureGitignore(repoRoot);
  if (gi.already) console.log("  .gitignore: already covered");
  else console.log(`  .gitignore: +${gi.added.length} entries (${gi.added.join(", ")})`);

  console.log(`
Next: voidarch-context ingest   (index the repo)
      voidarch-context context "<task>"   (build a context pack)`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
