// Document memory: heading-first markdown chunking + idempotent ingest + query.
//
// Sources: README.md, AGENTS.md, docs/**, templates/**, skills/**/SKILL.md,
// agents/*.md, and .claude/skills/**/SKILL.md. Unlike the repo-file ingester this
// walker intentionally descends into `.claude/` (to reach skill docs) but still
// skips `.dfc/` so it can never read surreal.env, plus node_modules / .git /
// graphify-out / .agent-runs / build output. Only .md/.mdx files are ever read.
//
// Chunks are stored in the pre-reserved `doc_chunk` table (BM25-indexed in 0002);
// a parent `document` row tracks the whole-file hash so unchanged files are skipped.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import { batchesOf, sizeFromEnv, upsertBatches } from "./batch.js";
import { ftSearchTerms, queryResult, queryResults } from "./surreal.js";
import { detectRiskTerms, estimateTokens, scoreDocChunk, tokenize } from "./scoring.js";
import type {
  ContextDocChunkEntry,
  DocChunkRecord,
  DocumentRecord,
  SourceAgent,
} from "./types.js";

const MAX_FILE_BYTES = 512 * 1024; // 512 KB per markdown file
const TARGET_CHARS = 1200; // compact target per chunk (~300 tokens)
const HARD_CAP_CHARS = 4000; // hard cap: larger sections are sub-split
const DEFAULT_DOC_CHUNK_BATCH_SIZE = 1;
const DEFAULT_DOCUMENT_WRITE_BATCH_SIZE = 1;

// Directories never walked for docs. NOTE: `.claude` is intentionally NOT here
// (skills live there); `.dfc` IS here (never read surreal.env).
const SKIP_DIRS = new Set<string>([
  ".git", "node_modules", "graphify-out", ".agent-runs", "dist", "build",
  "out", "coverage", ".next", ".turbo", ".cache", ".dfc", "vendor",
  ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);

const SKIP_REL_DIR_PREFIXES = [
  ".claude/worktrees",
  ".codex/worktrees",
  ".agent-worktrees",
];

function isSkippedDir(root: string, full: string, name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  const rel = relative(root, full).replace(/\\/g, "/");
  return SKIP_REL_DIR_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface DocSource {
  absPath: string;
  relPath: string;
  sourceType: string;
}

/** Classify a markdown file by repo location, or return null to skip it. */
export function classifyDoc(relPath: string): string | null {
  const p = relPath.replace(/\\/g, "/");
  const base = p.split("/").pop() ?? p;
  if (!/\.mdx?$/i.test(base)) return null;
  if (p === "README.md") return "readme";
  if (p === "AGENTS.md") return "agents";
  if (/(^|\/)\.claude\/skills\/.+\/SKILL\.mdx?$/i.test(p)) return "skill";
  if (/(^|\/)skills\/.+\/SKILL\.mdx?$/i.test(p)) return "skill";
  if (p.startsWith("docs/")) return "doc";
  if (p.startsWith("templates/")) return "template";
  if (/^agents\/.+\.mdx?$/i.test(p)) return "agent_md";
  return "markdown";
}

function walk(root: string, dir: string, acc: DocSource[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedDir(root, full, entry.name)) continue;
      walk(root, full, acc);
    } else if (entry.isFile()) {
      const relPath = relative(root, full).replace(/\\/g, "/");
      const sourceType = classifyDoc(relPath);
      if (sourceType) acc.push({ absPath: full, relPath, sourceType });
    }
  }
}

/** Discover all ingestible markdown sources under `root`, sorted for determinism. */
export function discoverDocSources(root: string): DocSource[] {
  const acc: DocSource[] = [];
  walk(root, root, acc);
  return acc.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export interface RawChunk {
  heading: string;
  text: string;
}

/** Hard-split an oversized section into compact sub-chunks at paragraph boundaries. */
function splitBySize(heading: string, text: string): RawChunk[] {
  if (text.length <= HARD_CAP_CHARS) return [{ heading, text }];
  const paras = text.split(/\n{2,}/);
  const out: RawChunk[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ heading, text: t });
    buf = "";
  };
  for (const para of paras) {
    if (buf && buf.length + para.length + 2 > TARGET_CHARS) flush();
    if (para.length > HARD_CAP_CHARS) {
      flush();
      for (let i = 0; i < para.length; i += HARD_CAP_CHARS) {
        const slice = para.slice(i, i + HARD_CAP_CHARS).trim();
        if (slice) out.push({ heading, text: slice });
      }
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  flush();
  return out;
}

/** Split markdown into heading-scoped chunks, then hard-cap oversized sections. */
export function chunkMarkdown(content: string): RawChunk[] {
  const lines = content.split(/\r?\n/);
  const out: RawChunk[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push(...splitBySize(heading, text));
    buf = [];
  };
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
    }
    buf.push(line);
  }
  flush();
  return out;
}

function extractTitle(content: string, relPath: string): string {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+)/);
    if (m && m[1]) return m[1].trim();
  }
  return relPath.split("/").pop() ?? relPath;
}

function summarize(raw: RawChunk): string {
  const body = raw.text.replace(/^#{1,6}\s+.*(?:\r?\n|$)/, "").trim();
  const firstLine = (body || raw.text).split(/\n/).find((l) => l.trim()) ?? "";
  return (firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 157)}...`).trim();
}

export interface PlannedDocument {
  document: DocumentRecord;
  chunks: DocChunkRecord[];
}

export interface DocPlan {
  documents: PlannedDocument[];
  stats: {
    sources: number;
    documents: number;
    chunks: number;
    deduped: number;
    skipped: number;
    totalTokens: number;
  };
}

/** Pure: walk the repo, chunk every doc, dedupe by content hash. No DB access. */
export function buildDocPlan(
  root: string,
  repoId: string,
  sourceAgent: SourceAgent,
  now: string,
): DocPlan {
  const sources = discoverDocSources(root);
  const seen = new Set<string>();
  const documents: PlannedDocument[] = [];
  let chunks = 0;
  let deduped = 0;
  let skipped = 0;
  let totalTokens = 0;

  for (const src of sources) {
    let content: string;
    try {
      if (statSync(src.absPath).size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      content = readFileSync(src.absPath, "utf8");
    } catch {
      skipped++;
      continue;
    }
    if (!content.trim()) {
      skipped++;
      continue;
    }

    const title = extractTitle(content, src.relPath);
    const kept: DocChunkRecord[] = [];
    for (const raw of chunkMarkdown(content)) {
      const hash = sha256(raw.text);
      if (seen.has(hash)) {
        deduped++;
        continue;
      }
      seen.add(hash);
      const tokenEstimate = estimateTokens(raw.text);
      totalTokens += tokenEstimate;
      kept.push({
        repo_id: repoId,
        source_agent: sourceAgent,
        source_type: src.sourceType,
        source_path: src.relPath,
        source_title: title,
        heading: raw.heading,
        chunk_index: kept.length,
        text: raw.text,
        summary: summarize(raw),
        token_estimate: tokenEstimate,
        content_hash: hash,
        created_at: now,
        updated_at: now,
      });
    }

    if (!kept.length) {
      skipped++;
      continue;
    }
    chunks += kept.length;
    documents.push({
      document: {
        repo_id: repoId,
        source_agent: sourceAgent,
        source_type: src.sourceType,
        source_path: src.relPath,
        source_title: title,
        chunk_count: kept.length,
        token_estimate: kept.reduce((a, c) => a + c.token_estimate, 0),
        content_hash: sha256(content),
        created_at: now,
        updated_at: now,
      },
      chunks: kept,
    });
  }

  return {
    documents,
    stats: { sources: sources.length, documents: documents.length, chunks, deduped, skipped, totalTokens },
  };
}

export interface IngestDocsStats {
  documents: number;
  chunks: number;
  unchanged: number;
  limited: number;
}

export interface IngestDocsOptions {
  maxDocuments?: number;
}

/** Idempotent ingest: skip unchanged files, else replace their chunks atomically. */
export async function ingestDocs(
  db: Surreal,
  plan: DocPlan,
  options: IngestDocsOptions = {},
): Promise<IngestDocsStats> {
  const repoId = plan.documents[0]?.document.repo_id;
  const existing = repoId
    ? await queryResult<Array<{ source_path?: string; content_hash?: string }>>(
        db,
        `SELECT source_path, content_hash FROM document WHERE repo_id = $repo`,
        { repo: repoId },
      )
    : [];
  const existingByPath = new Map(
    existing
      .filter((row) => row.source_path && row.content_hash)
      .map((row) => [row.source_path as string, row.content_hash as string]),
  );

  const changed = plan.documents.filter((pd) => {
    const { source_path, content_hash } = pd.document;
    return existingByPath.get(source_path) !== content_hash;
  });
  const unchanged = plan.documents.length - changed.length;
  const selected = options.maxDocuments ? changed.slice(0, options.maxDocuments) : changed;
  const limited = changed.length - selected.length;
  const chunkBatchSize = sizeFromEnv("DFC_DOC_CHUNK_BATCH_SIZE", DEFAULT_DOC_CHUNK_BATCH_SIZE);
  const documentBatchSize = sizeFromEnv("DFC_DOCUMENT_WRITE_BATCH_SIZE", DEFAULT_DOCUMENT_WRITE_BATCH_SIZE);
  const documentWrites: Array<{ id: RecordId; record: DocumentRecord }> = [];
  let chunks = 0;

  for (const pd of selected) {
    const { repo_id, source_path } = pd.document;
    // Replace this file's chunks wholesale so shrinking files don't leave orphans.
    await queryResults(
      db,
      `DELETE doc_chunk WHERE repo_id = $repo AND source_path = $path`,
      { repo: repo_id, path: source_path },
    );

    for (const batch of batchesOf(pd.chunks, chunkBatchSize)) {
      await upsertBatches(
        db,
        batch.map((c) => ({
          id: new RecordId("doc_chunk", sha256(`${c.repo_id}:${c.source_path}:${c.chunk_index}`)),
          record: c as unknown as Record<string, unknown>,
        })),
        batch.length,
      );
      chunks += batch.length;
    }

    const dkey = sha256(`${repo_id}:${source_path}`);
    documentWrites.push({ id: new RecordId("document", dkey), record: pd.document });
  }

  for (const batch of batchesOf(documentWrites, documentBatchSize)) {
    await upsertBatches(
      db,
      batch.map(({ id, record }) => ({
        id,
        record: record as unknown as Record<string, unknown>,
      })),
      batch.length,
    );
  }

  return { documents: documentWrites.length, chunks, unchanged, limited };
}

interface DocChunkRow {
  source_path?: string;
  source_title?: string;
  heading?: string;
  chunk_index?: number;
  text?: string;
  summary?: string;
  ftScore?: number;
}

function excerpt(content: string, terms: string[], max = 280): string {
  if (!content) return "";
  const low = content.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  const start = idx === -1 ? 0 : Math.max(0, idx - 50);
  return content.slice(start, start + max).replace(/\s+/g, " ").trim();
}

function scoreAndSlice(
  rows: DocChunkRow[],
  terms: string[],
  riskTerms: string[],
  limit: number,
): ContextDocChunkEntry[] {
  return rows
    .map((r) => {
      const text = r.text || "";
      return {
        source_path: r.source_path || "",
        source_title: r.source_title || "",
        heading: r.heading || "",
        chunk_index: typeof r.chunk_index === "number" ? r.chunk_index : 0,
        excerpt: excerpt(text || r.summary || "", terms),
        score: scoreDocChunk(
          {
            sourcePath: r.source_path || "",
            sourceTitle: r.source_title || "",
            heading: r.heading || "",
            text,
            summary: r.summary || "",
            ftScore: r.ftScore ?? 0,
          },
          terms,
          riskTerms,
        ),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Live query: BM25 over chunk text + heading/path substring fallback, then score. */
export async function queryDocChunks(
  db: Surreal,
  repoId: string,
  q: string,
  limit: number,
): Promise<ContextDocChunkEntry[]> {
  const terms = Array.from(new Set(tokenize(q))).slice(0, 12);
  const riskTerms = detectRiskTerms(q);
  const map = new Map<string, DocChunkRow>();
  const keyOf = (r: DocChunkRow) => `${r.source_path}#${r.chunk_index}`;

  if (terms.length) {
    const ftRows = await ftSearchTerms<DocChunkRow>(
      db,
      `SELECT source_path, source_title, heading, chunk_index, text, summary, search::score(0) AS ftScore
       FROM doc_chunk WHERE repo_id = $repo AND text @0@ $q ORDER BY ftScore DESC LIMIT 40`,
      { repo: repoId },
      terms,
      keyOf,
    );
    for (const r of ftRows) map.set(keyOf(r), r);
  }

  for (const t of terms) {
    const rows = await queryResult<DocChunkRow[]>(
      db,
      `SELECT source_path, source_title, heading, chunk_index, text, summary FROM doc_chunk
       WHERE repo_id = $repo
         AND (string::contains(string::lowercase(heading), $t)
              OR string::contains(string::lowercase(source_path), $t))
       LIMIT 10`,
      { repo: repoId, t },
    );
    for (const r of rows) {
      const k = keyOf(r);
      if (!map.has(k)) map.set(k, { ...r, ftScore: 0 });
    }
  }

  return scoreAndSlice([...map.values()], terms, riskTerms, limit);
}

/** Dry-run query: chunk the repo locally and score in-memory (no DB, no BM25). */
export function queryDocChunksLocal(
  root: string,
  repoId: string,
  sourceAgent: SourceAgent,
  q: string,
  limit: number,
  now: string,
): ContextDocChunkEntry[] {
  const terms = Array.from(new Set(tokenize(q))).slice(0, 12);
  const riskTerms = detectRiskTerms(q);
  const plan = buildDocPlan(root, repoId, sourceAgent, now);
  const rows: DocChunkRow[] = plan.documents.flatMap((d) =>
    d.chunks.map((c) => ({
      source_path: c.source_path,
      source_title: c.source_title,
      heading: c.heading,
      chunk_index: c.chunk_index,
      text: c.text,
      summary: c.summary,
      ftScore: 0,
    })),
  );
  return scoreAndSlice(rows, terms, riskTerms, limit);
}
