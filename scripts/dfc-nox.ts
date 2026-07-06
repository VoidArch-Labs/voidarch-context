// voidarch-context serve — minimal Voidarch Context setup/status page. Local-only, no Studio controls.
//
//   voidarch-context serve [--repo-root /path/to/repo] [--port 4950]

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Surreal } from "surrealdb";
import { parseArgs, repoRootFromArgs } from "../src/cli.js";
import { buildContextPack } from "../src/context-pack.js";
import { queryDocChunks } from "../src/docs.js";
import { tokenize } from "../src/scoring.js";
import { ftSearchTerms, loadConfig, queryResult, PKG_ROOT, withDb } from "../src/surreal.js";
import { listEmbeddingModels, resolveEmbedConfig } from "../src/vectors.js";

process.env.DFC_SURREAL_CONNECT_TIMEOUT_MS ??= "8000";
process.env.DFC_SURREAL_CONNECT_ATTEMPTS ??= "1";
process.env.DFC_SURREAL_QUERY_TIMEOUT_MS ??= "15000";

const ASSET_DIR = join(PKG_ROOT, "page");
const COUNT_TABLES = [
  "file",
  "document",
  "doc_chunk",
  "decision",
  "evidence_item",
  "lesson",
  "snippet",
  "repo_fact",
  "task_note",
  "task",
  "blocker",
  "context_pack",
  "graph_node",
  "graph_edge",
  "embedding_model",
  "embedding_chunk",
] as const;

function git(repoRoot: string, ...argv: string[]): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...argv], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function text(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function mime(path: string): string {
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".js") return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

async function countTable(db: Surreal, table: string, repoId: string): Promise<number> {
  const rows = await queryResult<Array<{ c?: number }>>(
    db,
    "SELECT count() AS c FROM type::table($t) WHERE repo_id = $repo GROUP ALL",
    { t: table, repo: repoId },
  );
  return rows[0]?.c ?? 0;
}

async function collectStatus(repoRoot: string): Promise<Record<string, unknown>> {
  const cfg = loadConfig({ repoRoot });
  const embed = resolveEmbedConfig({ repoRoot });
  const head = git(repoRoot, "rev-parse", "HEAD");
  const branch = git(repoRoot, "branch", "--show-current") || "(detached)";
  const graphJson = join(repoRoot, "graphify-out", "graph.json");

  return await withDb(async (db, c) => {
    const counts: Record<string, number> = {};
    for (const table of COUNT_TABLES) {
      try {
        counts[table] = await countTable(db, table, c.repoId);
      } catch {
        counts[table] = 0;
      }
    }

    const modelRows = await listEmbeddingModels(db, c.repoId).catch(() => []);
    const currentModelRows = await queryResult<Array<{ c?: number }>>(
      db,
      "SELECT count() AS c FROM embedding_chunk WHERE repo_id = $repo AND embedding_model = $model GROUP ALL",
      { repo: c.repoId, model: embed.modelKey },
    ).catch(() => []);
    const embeddedForCurrentModel = currentModelRows[0]?.c ?? 0;
    const pendingForCurrentModel = Math.max(0, (counts.doc_chunk ?? 0) - embeddedForCurrentModel);

    const graphRows = await queryResult<Array<Record<string, unknown>>>(
      db,
      `SELECT built_at_commit, current_commit, is_fresh, node_count, edge_count, created_at
       FROM graph_snapshot WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 1`,
      { repo: c.repoId },
    ).catch(() => []);
    const latestGraph = graphRows[0] ?? null;

    return {
      repo: {
        root: repoRoot,
        id: cfg.repoId,
        branch,
        head,
      },
      database: {
        url: cfg.url.replace(/:\/\/[^@]*@/, "://***@"),
        namespace: cfg.namespace,
        database: cfg.database,
      },
      setup: [
        "pnpm install",
        "voidarch-context init",
        "voidarch-context ingest",
        "voidarch-context docs ingest",
        "voidarch-context embed",
        "voidarch-context context --task \"what do I need for this task?\"",
      ],
      counts,
      embeddings: {
        provider: embed.provider,
        model: embed.model,
        model_key: embed.modelKey,
        dimension: embed.dimension || "infer",
        cache_dir: embed.provider === "local" ? embed.cacheDir : undefined,
        paid: embed.paid,
        api_key_present: embed.apiKeyPresent,
        approved: embed.approved,
        available: embed.available,
        status: embed.reason,
        indexed_current_model: embeddedForCurrentModel,
        pending_current_model: pendingForCurrentModel,
        models: modelRows.map((m) => ({
          provider: m.provider,
          model: m.model,
          dimension: m.dimension,
          updated_at: m.updated_at,
        })),
      },
      graph: latestGraph ?? {
        present: existsSync(graphJson),
        updated_at: existsSync(graphJson) ? new Date(statSync(graphJson).mtimeMs).toISOString() : null,
        status: existsSync(graphJson) ? "graphify-out/graph.json exists; import it with voidarch-context graph import for DB freshness" : "not indexed",
      },
    };
  }, { repoRoot });
}

async function search(repoRoot: string, q: string): Promise<Record<string, unknown>> {
  const terms = Array.from(new Set(tokenize(q))).slice(0, 8);
  if (!terms.length) return { query: q, docs: [], files: [], memories: [] };

  return await withDb(async (db, cfg) => {
    const docs = await queryDocChunks(db, cfg.repoId, q, 8).catch(() => []);
    const files = await ftSearchTerms<{ path?: string; ext?: string; size?: number; content?: string; ftScore?: number }>(
      db,
      `SELECT path, ext, size, content, search::score(0) AS ftScore FROM file
       WHERE repo_id = $repo AND content @0@ $q
       ORDER BY ftScore DESC LIMIT 8`,
      { repo: cfg.repoId },
      terms,
      (r) => String(r.path ?? ""),
    ).catch(() => []);

    const memories: Array<Record<string, unknown>> = [];
    for (const table of ["decision", "evidence_item", "lesson", "snippet", "repo_fact", "task_note"]) {
      const rows = await queryResult<Array<Record<string, unknown>>>(
        db,
        `SELECT summary, tags, source_agent, created_at FROM type::table($t)
         WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 20`,
        { t: table, repo: cfg.repoId },
      ).catch(() => []);
      for (const row of rows) {
        const hay = `${row.summary ?? ""} ${(row.tags as unknown[])?.join?.(" ") ?? ""}`.toLowerCase();
        const score = terms.filter((term) => hay.includes(term)).length;
        if (score) memories.push({ kind: table, score, ...row });
      }
    }

    return {
      query: q,
      docs,
      files: files.map((f) => ({
        path: f.path,
        ext: f.ext,
        size: f.size,
        score: f.ftScore ?? 0,
        excerpt: String(f.content ?? "").slice(0, 240).replace(/\s+/g, " ").trim(),
      })),
      memories: memories.sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 10),
    };
  }, { repoRoot });
}

async function contextPreview(repoRoot: string, task: string, allowPaidEmbeddings: boolean): Promise<Record<string, unknown>> {
  return await withDb(async (db, cfg) => {
    const pack = await buildContextPack(db, cfg.repoId, task, { repoRoot, allowPaidEmbeddings });
    return {
      task: pack.task,
      query_plan: pack.query_plan,
      paid_embeddings_allowed: allowPaidEmbeddings,
      token_budget: pack.token_budget,
      counts: {
        files: pack.repo_context.files.length,
        symbols: pack.repo_context.symbols.length,
        docs: pack.document_context.chunks.length,
        vectors: pack.vector_context.chunks.length,
        memories:
          pack.memory_context.decisions.length +
          pack.memory_context.evidence.length +
          pack.memory_context.lessons.length +
          pack.memory_context.repo_facts.length +
          pack.memory_context.snippets.length +
          pack.memory_context.task_notes.length,
        state: pack.state.open_blockers.length + pack.state.open_tasks.length,
        runs: pack.agent_context.recent_runs.length + pack.agent_context.recent_tool_events.length,
      },
      pack,
    };
  }, { repoRoot });
}

async function handle(req: IncomingMessage, res: ServerResponse, repoRoot: string): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });

  try {
    if (url.pathname === "/api/status") return json(res, 200, await collectStatus(repoRoot));
    if (url.pathname === "/api/search") return json(res, 200, await search(repoRoot, url.searchParams.get("q") || ""));
    if (url.pathname === "/api/context") {
      const task = (url.searchParams.get("task") || "").trim();
      if (!task) return json(res, 400, { error: "task is required" });
      return json(res, 200, await contextPreview(repoRoot, task, url.searchParams.get("allowPaidEmbeddings") === "1"));
    }

    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const path = join(ASSET_DIR, rel);
    if (!path.startsWith(ASSET_DIR) || !existsSync(path)) return text(res, 404, "not found");
    return text(res, 200, readFileSync(path, "utf8"), mime(path));
  } catch (err) {
    return json(res, 500, { error: (err as Error).message });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootFromArgs(args);
  const port = Number.parseInt(args.port || "4950", 10) || 4950;
  const server = createServer((req, res) => void handle(req, res, repoRoot));
  server.listen(port, "127.0.0.1", () => {
    console.log(`Voidarch Context setup/status page: http://127.0.0.1:${port}`);
    console.log(`Repo: ${repoRoot}`);
  });
}

try {
  await main();
} catch (err) {
  console.error((err as Error)?.message ?? String(err));
  process.exit(1);
}
