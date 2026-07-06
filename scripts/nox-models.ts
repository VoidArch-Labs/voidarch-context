// voidarch-context models status|install — inspect / warm the embedding model.
//   voidarch-context models status   keyless: prints provider/model/cache/available state
//   voidarch-context models install  keyless (local provider): downloads+caches the local
//                        model via a single bounded embed call; no-op / error
//                        guidance for other providers (never calls a paid API).

import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { embedText, resolveEmbedConfig } from "../src/vectors.js";

async function status(repoRoot: string): Promise<void> {
  const cfg = resolveEmbedConfig({ repoRoot });
  console.log("voidarch-context models status");
  console.log(`  provider:   ${cfg.provider}`);
  console.log(`  model:      ${cfg.model || "(none)"}`);
  console.log(`  dimension:  ${cfg.dimension || "(infer from first vector)"}`);
  if (cfg.provider === "local") console.log(`  cache:      ${cfg.cacheDir}`);
  if (cfg.provider === "ollama" || cfg.provider === "openai") console.log(`  host:       ${cfg.host}`);
  console.log(`  paid:       ${cfg.paid}${cfg.paid ? `  (key=${cfg.apiKeyPresent}, approved=${cfg.approved})` : ""}`);
  console.log(`  available:  ${cfg.available}`);
  console.log(`  status:     ${cfg.reason}`);
}

async function install(repoRoot: string): Promise<void> {
  const cfg = resolveEmbedConfig({ repoRoot });
  if (cfg.provider !== "local") {
    console.log(
      `voidarch-context models install only downloads the local model (current provider: "${cfg.provider}"). ` +
        `Run \`voidarch-context config embedding local\` first, or install manually for provider "${cfg.provider}".`,
    );
    return;
  }
  console.log(`voidarch-context models install — downloading/caching ${cfg.model} to ${cfg.cacheDir} ...`);
  const started = Date.now();
  await embedText(cfg, "voidarch-context model warmup"); // single bounded call: triggers first-use download + cache
  console.log(`  done in ${Date.now() - started}ms — model cached, ready for keyless use.`);
}

async function main(): Promise<void> {
  const [sub] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const repoRoot = repoRootFromArgs(args);
  if (sub === "install") return install(repoRoot);
  if (sub === "status" || !sub) return status(repoRoot);
  console.error(`usage: voidarch-context models <status|install>`);
  process.exit(2);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
