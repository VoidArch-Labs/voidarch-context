// .voidarch/config.json — the target repo's own Voidarch Context config, written by
// `voidarch-context init` / `voidarch-context config embedding <provider>`. Read as the
// LOWEST-priority config source: process.env > .dfc/*.env files (legacy) >
// .voidarch/config.json. Never holds secrets (no API keys) — just repoId, embedding
// provider choice, schema version, created timestamp.
//
// Legacy compat: repos initialized before the Voidarch rename used `.nox/config.json`.
// Reads fall back to that path; writes always target `.voidarch/config.json`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VOIDARCH_CONFIG_SCHEMA_VERSION = 1;

export interface VoidarchConfig {
  repoId: string;
  embedding: { provider: "local" | "openai-compatible" };
  createdAt: string;
  schemaVersion: number;
}

export function voidarchConfigPath(repoRoot: string): string {
  return join(repoRoot, ".voidarch", "config.json");
}

/** @deprecated legacy pre-rename config location; read-only fallback. */
function legacyConfigPath(repoRoot: string): string {
  return join(repoRoot, ".nox", "config.json");
}

/** Read `.voidarch/config.json` (falling back to legacy `.nox/config.json`) for
 *  `repoRoot`, or null if absent/unparseable. */
export function readVoidarchConfig(repoRoot: string): VoidarchConfig | null {
  const candidates = [voidarchConfigPath(repoRoot), legacyConfigPath(repoRoot)];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      return parsed as VoidarchConfig;
    } catch {
      continue;
    }
  }
  return null;
}

/** Flattened KEY=VALUE view of the repo config, for merging as the lowest-priority
 *  config source alongside the legacy .dfc env files. Only maps fields that have a direct
 *  env-var equivalent; never invents secrets. "openai-compatible" maps to the existing
 *  DFC_EMBED_PROVIDER=openai value (legacy internal env name) — same paid gate, no new
 *  provider. */
export function voidarchConfigEnv(repoRoot: string): Record<string, string> {
  const cfg = readVoidarchConfig(repoRoot);
  if (!cfg) return {};
  const out: Record<string, string> = {};
  if (cfg.repoId) out.DFC_REPO_ID = cfg.repoId;
  if (cfg.embedding?.provider === "openai-compatible") out.DFC_EMBED_PROVIDER = "openai";
  else if (cfg.embedding?.provider === "local") out.DFC_EMBED_PROVIDER = "local";
  return out;
}

export function writeVoidarchConfig(repoRoot: string, cfg: VoidarchConfig): void {
  const path = voidarchConfigPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}
