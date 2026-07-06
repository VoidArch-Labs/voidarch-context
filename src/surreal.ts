// Hosted SurrealDB connection + config loading for the dev-memory slice.
// Uses the official SurrealDB TypeScript SDK package ("surrealdb").

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Surreal } from "surrealdb";
import type { QueryResponse } from "surrealdb";
import { voidarchConfigEnv } from "./voidarch-config.js";
import type { DfcConfig } from "./types.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
// Embedded SurrealKV is a local file open — if it takes long, another process
// holds the single-process lock, so fail fast with a useful message instead.
const DEFAULT_EMBEDDED_CONNECT_TIMEOUT_MS = 10_000;
/** Zero-config default: embedded SurrealKV inside the target repo, no server. */
export const DEFAULT_EMBEDDED_URL = "surrealkv://.voidarch/db";
/** @deprecated pre-Voidarch data location; still used when it already exists on disk. */
export const LEGACY_EMBEDDED_URL = "surrealkv://.dfc/dev-memory";
const DEFAULT_QUERY_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_ATTEMPTS = 3;

/**
 * Plugin root (where .dfc/, hooks/, skills/, etc. live) — three levels up from
 * packages/voidarch-context/src/ (resolved from this file, not cwd). Kept as REPO_ROOT
 * for compat: callers outside this package (dfc-init.ts, dfc-dashboard.ts,
 * dfc-grok-build.ts) rely on it resolving to the plugin root, not this package.
 */
export const REPO_ROOT = resolve(moduleDir, "..", "..", "..");

/** This package's own root (packages/voidarch-context) — for schema/ and other package-local assets. */
export const PKG_ROOT = resolve(moduleDir, "..");

export interface ConfigOptions {
  repoRoot?: string;
}

/** Target repo root precedence for installed-plugin mode. */
export function resolveRepoRoot(explicit?: string): string {
  const raw =
    explicit ||
    process.env.DFC_TARGET_REPO_ROOT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.PWD ||
    process.cwd?.() ||
    REPO_ROOT;
  return resolve(raw);
}

/** Minimal KEY=VALUE .env parser (no dependency). Ignores blanks and # comments. */
export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * `.dfc/` directory to read config from. When the plugin is installed once and used
 * across multiple projects (each with its own DFC_REPO_ID/database), the project
 * actually being worked on must win over this script's own install location —
 * otherwise every consuming project would silently share the plugin's bundled
 * credentials/repo_id instead of its own. Prefers CLAUDE_PROJECT_DIR/.dfc/ when that
 * project has set one up; falls back to this script's own REPO_ROOT/.dfc/ otherwise
 * (plain CLI usage with no CLAUDE_PROJECT_DIR, or a project with no .dfc/ of its own).
 */
export function resolveDfcDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir && existsSync(join(projectDir, ".dfc"))) return join(projectDir, ".dfc");
  return join(REPO_ROOT, ".dfc");
}

/**
 * Merged KEY=VALUE view of config sources, lowest→highest precedence:
 * .nox/config.json (repo-local, no secrets) < surreal.example.env (template) <
 * surreal.env (real connection) < embed.env (embedding provider + key). Shared by
 * the SurrealDB config and the embedding-provider config so secrets live only in
 * gitignored files and never need to be passed on the command line. Callers
 * (loadConfig, resolveEmbedConfig) layer process.env on top of all of this.
 */
export function dfcFileEnv(repoRoot?: string): Record<string, string> {
  const pluginDfcDir = join(REPO_ROOT, ".dfc");
  const targetRoot = resolveRepoRoot(repoRoot);
  const targetDfcDir = join(targetRoot, ".dfc");
  const pluginEnv = {
    ...parseEnvFile(join(pluginDfcDir, "surreal.example.env")),
    ...parseEnvFile(join(pluginDfcDir, "surreal.env")),
    ...parseEnvFile(join(pluginDfcDir, "embed.env")),
  };
  const targetEnv =
    targetRoot === REPO_ROOT
      ? {}
      : {
          ...parseEnvFile(join(targetDfcDir, "surreal.example.env")),
          ...parseEnvFile(join(targetDfcDir, "surreal.env")),
          ...parseEnvFile(join(targetDfcDir, "embed.env")),
        };
  return {
    ...voidarchConfigEnv(targetRoot),
    ...pluginEnv,
    ...targetEnv,
  };
}

/** Embedded engine URL (SurrealKV/RocksDB/in-memory) — no server, no credentials. */
export function isEmbeddedUrl(url: string): boolean {
  return /^(mem|surrealkv(\+versioned)?|rocksdb):\/\//.test(url.trim());
}

/** Make a relative embedded path absolute against the target repo root, so
 *  `surrealkv://.dfc/dev-memory` in a committed env template works from any cwd. */
function absolutizeEmbeddedUrl(url: string, repoRoot: string): string {
  const m = /^((?:mem|surrealkv(?:\+versioned)?|rocksdb):\/\/)(.+)$/.exec(url.trim());
  if (!m) return url.trim();
  const [, scheme, path] = m;
  if (!path || path.startsWith("/") || scheme === "mem://") return url.trim();
  return `${scheme}${resolve(repoRoot, path)}`;
}

/** Filesystem data directory of an embedded URL (surrealkv://, rocksdb://), or null. */
export function embeddedDataDir(url: string): string | null {
  const m = /^(?:surrealkv(?:\+versioned)?|rocksdb):\/\/(.+)$/.exec(url.trim());
  return m ? m[1] : null;
}

export function loadConfig(options: ConfigOptions = {}): DfcConfig {
  const fileEnv = dfcFileEnv(options.repoRoot);
  const get = (k: string): string => (process.env[k] ?? fileEnv[k] ?? "").trim();

  // Zero-config default: a fresh clone with no env config gets a local embedded
  // database under the target repo — no server, no credentials. Repos indexed
  // before the Voidarch rename keep their existing .dfc/dev-memory data.
  const targetRoot = resolveRepoRoot(options.repoRoot);
  const legacyDefault =
    !existsSync(join(targetRoot, ".voidarch", "db")) &&
    existsSync(join(targetRoot, ".dfc", "dev-memory"));
  const rawUrl = get("DFC_SURREAL_URL") || (legacyDefault ? LEGACY_EMBEDDED_URL : DEFAULT_EMBEDDED_URL);
  return {
    url: isEmbeddedUrl(rawUrl)
      ? absolutizeEmbeddedUrl(rawUrl, resolveRepoRoot(options.repoRoot))
      : rawUrl,
    namespace: get("DFC_SURREAL_NS") || "dev_flow_control",
    database: get("DFC_SURREAL_DB") || "repo_dev_flow_control",
    repoId: get("DFC_REPO_ID") || "dev-flow-control",
    username: get("DFC_SURREAL_USER"),
    password: get("DFC_SURREAL_PASS"),
    authScope: normalizeAuthScope(get("DFC_SURREAL_AUTH_SCOPE") || "root"),
  };
}

const PLACEHOLDER = /<[^>]+>/;

function normalizeAuthScope(value: string): DfcConfig["authScope"] {
  const scope = value.trim().toLowerCase();
  if (scope === "root" || scope === "namespace" || scope === "database") return scope;
  throw new Error("DFC_SURREAL_AUTH_SCOPE must be root, namespace, or database");
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Throw a clear error if required fields are missing or still placeholders. */
export function assertUsableConfig(cfg: DfcConfig): void {
  const missing: string[] = [];
  const required: Array<[string, string]> = isEmbeddedUrl(cfg.url)
    ? [["DFC_SURREAL_URL", cfg.url]] // embedded engines need no credentials
    : [
        ["DFC_SURREAL_URL", cfg.url],
        ["DFC_SURREAL_USER", cfg.username],
        ["DFC_SURREAL_PASS", cfg.password],
      ];
  for (const [name, value] of required) {
    if (!value || PLACEHOLDER.test(value)) missing.push(name);
  }
  if (missing.length) {
    throw new Error(
      `Missing/placeholder SurrealDB config: ${missing.join(", ")}. ` +
        `Copy .dfc/surreal.example.env to .dfc/surreal.env and fill in real values, ` +
        `or set the matching environment variables.`,
    );
  }
}

/** Connect, select namespace/database, authenticate. Caller closes the handle.
 *  Embedded URLs (surrealkv://, rocksdb://, mem://) load the @surrealdb/node
 *  engine lazily and skip authentication — the database lives inside the repo. */
/** Construct an (unconnected) client with the embedded Node engines loaded when
 *  the URL needs them. Callers that manage their own connect flow (migrate) use
 *  this instead of `new Surreal()` so embedded URLs work everywhere. */
export async function createClient(cfg: DfcConfig): Promise<Surreal> {
  if (!isEmbeddedUrl(cfg.url)) return new Surreal();
  const { createNodeEngines } = await import("@surrealdb/node");
  return new Surreal({ engines: createNodeEngines() });
}

/** SurrealDB FULLTEXT `@0@` ANDs every token in the query string, so joining
 *  all task terms into one query returns zero rows whenever any single term is
 *  missing from a document. Run the query once per term (OR semantics), merge
 *  rows by key, and sum BM25 scores. `sql` must bind the term as `$q`. */
export async function ftSearchTerms<T extends { ftScore?: number }>(
  db: Surreal,
  sql: string,
  bindings: Record<string, unknown>,
  terms: string[],
  keyOf: (row: T) => string,
): Promise<T[]> {
  const map = new Map<string, T>();
  for (const q of terms) {
    const rows = await queryResult<T[]>(db, sql, { ...bindings, q });
    for (const r of rows) {
      const k = keyOf(r);
      const prev = map.get(k);
      if (prev) prev.ftScore = (prev.ftScore ?? 0) + (r.ftScore ?? 0);
      else map.set(k, { ...r, ftScore: r.ftScore ?? 0 });
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.ftScore ?? 0) - (a.ftScore ?? 0));
}

/** Ordered schema migrations — shared with scripts/dfc-db-migrate.ts. */
export const MIGRATIONS = [
  "schema/0001_core.surql",
  "schema/0002_indexes.surql",
  "schema/0003_documents_graph_vectors.surql",
  "schema/0004_state_memory_kinds.surql",
  "schema/0005_task_note.surql",
];

let schemaEnsured = false;

/** Fresh embedded DBs (the keyless default) have no schema until a migrate runs.
 *  Probe once per process and auto-apply migrations so `voidarch-context init && voidarch-context ingest`
 *  works in a repo that has never run `voidarch-context db migrate`. Embedded-only: remote
 *  servers are managed explicitly via the migrate command. */
async function ensureSchema(db: Surreal): Promise<void> {
  if (schemaEnsured) return;
  const info = await queryResult<{ tables?: Record<string, unknown> }>(db, "INFO FOR DB");
  if (!info?.tables?.file) {
    for (const rel of MIGRATIONS) {
      await queryResults(db, readFileSync(join(PKG_ROOT, rel), "utf8"));
    }
  }
  schemaEnsured = true;
}

export async function connect(cfg: DfcConfig): Promise<Surreal> {
  const embedded = isEmbeddedUrl(cfg.url);
  const timeoutMs = numberEnv(
    "DFC_SURREAL_CONNECT_TIMEOUT_MS",
    embedded ? DEFAULT_EMBEDDED_CONNECT_TIMEOUT_MS : DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const attempts = numberEnv("DFC_SURREAL_CONNECT_ATTEMPTS", DEFAULT_CONNECT_ATTEMPTS);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const db = await createClient(cfg);
    try {
      await withTimeout("SurrealDB connect", db.connect(cfg.url), timeoutMs);
      if (!embedded) await withTimeout("SurrealDB signin", authenticate(db, cfg), timeoutMs);
      await withTimeout("SurrealDB use", db.use({ namespace: cfg.namespace, database: cfg.database }), timeoutMs);
      if (embedded) await ensureSchema(db);
      return db;
    } catch (err) {
      lastError = err;
      try {
        await db.close();
      } catch {
        /* ignore failed cleanup between connection attempts */
      }
      if (attempt < attempts) await sleep(1_000 * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  if (embedded && /timed out/.test(message)) {
    throw new Error(
      `Embedded SurrealDB connect timed out (${cfg.url}). SurrealKV allows only ONE ` +
        `process at a time — another dfc command (or the dashboard) probably holds the ` +
        `lock (LOCK file in the data directory). Wait for it to finish or kill it; note ` +
        `a killed process can leave the database locked for a short while. ` +
        `Timeout is overridable via DFC_SURREAL_CONNECT_TIMEOUT_MS (current: ${timeoutMs}ms).`,
    );
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function authenticate(db: Surreal, cfg: DfcConfig): Promise<void> {
  if (cfg.authScope === "database") {
    await db.signin({
      namespace: cfg.namespace,
      database: cfg.database,
      username: cfg.username,
      password: cfg.password,
    });
    return;
  }

  if (cfg.authScope === "namespace") {
    await db.signin({
      namespace: cfg.namespace,
      username: cfg.username,
      password: cfg.password,
    });
    return;
  }

  await db.signin({ username: cfg.username, password: cfg.password });
}

function queryErrorMessage(response: QueryResponse, index: number): string {
  if (response.success) return "";
  const error = response.error as unknown;
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message)
      : JSON.stringify(error);
  return `SurrealDB statement ${index} failed: ${message}`;
}

/**
 * Normalize SurrealDB SDK query responses into raw statement results. The SDK's
 * `.responses()` shape carries `{ success, result }`; callers should not repeat
 * that indexing and error handling throughout scripts.
 */
export async function queryResults<R extends unknown[] = unknown[]>(
  db: Surreal,
  query: string,
  bindings?: Record<string, unknown>,
): Promise<R> {
  const timeoutMs = numberEnv("DFC_SURREAL_QUERY_TIMEOUT_MS", DEFAULT_QUERY_TIMEOUT_MS);
  const responses = (await withTimeout(
    "SurrealDB query",
    db.query<R>(query, bindings).responses(),
    timeoutMs,
  )) as QueryResponse<unknown>[];
  return responses.map((response, index) => {
    if (!response.success) throw new Error(queryErrorMessage(response, index));
    return response.result;
  }) as R;
}

export async function queryResult<T>(
  db: Surreal,
  query: string,
  bindings?: Record<string, unknown>,
): Promise<T> {
  const [first] = await queryResults<[T]>(db, query, bindings);
  return first;
}

/**
 * Run `fn` against a connected, authenticated client and always close the
 * connection afterwards (even on error).
 */
export async function withDb<T>(
  fn: (db: Surreal, cfg: DfcConfig) => Promise<T>,
  options: ConfigOptions = {},
): Promise<T> {
  const cfg = loadConfig(options);
  assertUsableConfig(cfg);
  const db = await connect(cfg);
  try {
    return await fn(db, cfg);
  } finally {
    try {
      await db.close();
    } catch {
      /* ignore close errors; connection may already be gone */
    }
  }
}
