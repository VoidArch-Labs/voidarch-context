// voidarch-context config embedding local|openai-compatible — writes the embedding provider
// choice into .voidarch/config.json (creates it via the same defaults as `voidarch-context init`
// if missing). Never writes API keys — those stay in env vars or legacy .dfc/embed.env.
//
//   voidarch-context config embedding local
//   voidarch-context config embedding openai-compatible

import { basename } from "node:path";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { VOIDARCH_CONFIG_SCHEMA_VERSION, voidarchConfigPath, readVoidarchConfig, writeVoidarchConfig } from "../src/voidarch-config.js";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function main(): void {
  const [choice] = process.argv.slice(2);
  if (choice !== "local" && choice !== "openai-compatible") {
    console.error("usage: voidarch-context config embedding <local|openai-compatible>");
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(3));
  const repoRoot = repoRootFromArgs(args);
  const existing = readVoidarchConfig(repoRoot);

  writeVoidarchConfig(repoRoot, {
    repoId: existing?.repoId || slugify(basename(repoRoot)),
    embedding: { provider: choice },
    createdAt: existing?.createdAt || new Date().toISOString(),
    schemaVersion: VOIDARCH_CONFIG_SCHEMA_VERSION,
  });

  console.log(`voidarch-context config embedding — ${voidarchConfigPath(repoRoot)} set to "${choice}"`);
  if (choice === "openai-compatible") {
    console.log(
      "  note: still requires VOIDARCH_EMBED_API_KEY (or OPENAI_API_KEY) + approval " +
        "(VOIDARCH_EMBED_APPROVED=1 or --approve) via env vars or legacy .dfc/embed.env — " +
        "this only sets the default provider.",
    );
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
