// Deterministic scoring + text helpers for the dev-memory context pack.
// No DB access, no randomness; same inputs always produce the same scores.

import type { Phase } from "./types.js";

/** Risk keywords that signal an approval-gated or destructive intent. */
export const RISK_KEYWORDS: string[] = [
  "approval", "approve", "secret", "credential", "token", "password",
  "push", "force", "deploy", "release", "publish", "merge",
  "prod", "production", "delete", "drop", "destroy", "migration",
  "billing", "payment",
];

const STOPWORDS = new Set<string>([
  "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "with",
  "add", "fix", "update", "make", "use", "run", "into", "from", "this",
  "that", "is", "are", "be", "we", "it", "as", "at", "by",
]);

/** Lowercase, split on non-identifier chars, drop stopwords and 1-char tokens. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
  return raw
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Risk keywords present in the text (deduplicated, preserving keyword form). */
export function detectRiskTerms(text: string): string[] {
  const low = text.toLowerCase();
  return Array.from(new Set(RISK_KEYWORDS.filter((k) => low.includes(k))));
}

/** Best-effort GSD phase inference from the task wording. Defaults to "plan". */
export function inferPhase(text: string): Phase {
  const low = text.toLowerCase();
  if (/\b(ship|release|deploy|publish|merge)\b/.test(low)) return "ship";
  if (/\b(verify|test|review|validate|check)\b/.test(low)) return "verify";
  if (/\b(implement|build|write|execute|code)\b/.test(low)) return "execute";
  if (/\b(discuss|explore|investigate|understand|scope)\b/.test(low)) return "discuss";
  return "plan";
}

/** Crude token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---- File scoring -----------------------------------------------------------

export interface FileScoreInput {
  path: string;
  size: number;
  ftScore: number; // BM25 score from SurrealDB (0 if not a full-text hit)
  contentLower?: string;
}

/**
 * Score a candidate file for a task. Weighting (deterministic):
 *   + exact path match .......... 50
 *   + filename (basename) match . 30
 *   + filename contains term .... 18
 *   + path contains term ........ 10
 *   + full-text (BM25) hit ...... 12 + min(18, ftScore*4)
 *   + risk-term reference ....... 8 each
 *   - large-content penalty ..... -1 per 8KB over 16KB
 */
export function scoreFile(
  f: FileScoreInput,
  terms: string[],
  riskTerms: string[],
): number {
  const pathLower = f.path.toLowerCase();
  const base = pathLower.split("/").pop() ?? pathLower;
  const baseNoExt = base.replace(/\.[^.]+$/, "");
  let score = 0;

  for (const t of terms) {
    if (pathLower === t) score += 50;
    else if (base === t || baseNoExt === t) score += 30;
    else if (base.includes(t)) score += 18;
    else if (pathLower.includes(t)) score += 10;
  }

  if (f.ftScore > 0) score += 12 + Math.min(18, f.ftScore * 4);

  for (const r of riskTerms) {
    if (pathLower.includes(r) || f.contentLower?.includes(r)) score += 8;
  }

  const overKb = Math.max(0, f.size - 16384) / 8192;
  score -= overKb;

  return Math.round(score * 100) / 100;
}

// ---- Memory scoring ---------------------------------------------------------

export interface MemoryScoreInput {
  summary: string;
  text: string;
  ageDays: number;
}

/**
 * Score a remembered decision/evidence item. Weighting (deterministic):
 *   base ........................ 5  (remembered context always matters a little)
 *   + term match ................ 8 each
 *   + risk-term match ........... 6 each
 *   + recency ................... up to +20, linear decay over 30 days
 */
export function scoreMemory(
  m: MemoryScoreInput,
  terms: string[],
  riskTerms: string[],
): number {
  const hay = `${m.summary} ${m.text}`.toLowerCase();
  let score = 5;
  for (const t of terms) if (hay.includes(t)) score += 8;
  for (const r of riskTerms) if (hay.includes(r)) score += 6;
  score += Math.max(0, 20 - m.ageDays * (20 / 30));
  return Math.round(score * 100) / 100;
}

// ---- Agent run / tool-event scoring ----------------------------------------

export interface AgentRunScoreInput {
  taskGoal: string;
  summary: string;
  status: string;
  sourceAgent: string;
  ageDays: number;
}

/**
 * Score prior agent runs for a task. This is the agent-run relevance boost in
 * the context pack: recent runs from any agent with matching goal/summary text
 * are surfaced near the task context.
 */
export function scoreAgentRun(
  run: AgentRunScoreInput,
  terms: string[],
  riskTerms: string[],
): number {
  const hay = `${run.taskGoal} ${run.summary} ${run.status} ${run.sourceAgent}`.toLowerCase();
  let score = 3;
  for (const t of terms) if (hay.includes(t)) score += 7;
  for (const r of riskTerms) if (hay.includes(r)) score += 5;
  if (run.status.toLowerCase() === "failed" || run.status.toLowerCase() === "fail") score += 4;
  score += Math.max(0, 12 - run.ageDays * (12 / 14));
  return Math.round(score * 100) / 100;
}

export interface ToolEventScoreInput {
  toolName: string;
  action: string;
  summary: string;
  sourceAgent: string;
  success: boolean | null;
  ageDays: number;
}

export function scoreToolEvent(
  event: ToolEventScoreInput,
  terms: string[],
  riskTerms: string[],
): number {
  const hay = `${event.toolName} ${event.action} ${event.summary} ${event.sourceAgent}`.toLowerCase();
  let score = 2;
  for (const t of terms) if (hay.includes(t)) score += 5;
  for (const r of riskTerms) if (hay.includes(r)) score += 4;
  if (event.success === false) score += 3;
  score += Math.max(0, 8 - event.ageDays * (8 / 7));
  return Math.round(score * 100) / 100;
}

// ---- Document-chunk scoring (Stage 1) --------------------------------------

export interface DocChunkScoreInput {
  sourcePath: string;
  sourceTitle: string;
  heading: string;
  text: string;
  summary: string;
  ftScore: number; // BM25 score from SurrealDB (0 if not a full-text hit)
}

/**
 * Score a candidate document chunk for a task. Weighting (deterministic):
 *   base ........................ 2
 *   + path/title term match ..... 6 each (exact path basename match 14)
 *   + heading term match ........ 8 each
 *   + body/summary term match ... 4 each
 *   + full-text (BM25) hit ...... 10 + min(16, ftScore*4)
 *   + risk-term reference ....... 5 each
 */
export function scoreDocChunk(
  c: DocChunkScoreInput,
  terms: string[],
  riskTerms: string[],
): number {
  const pathLower = c.sourcePath.toLowerCase();
  const base = pathLower.split("/").pop() ?? pathLower;
  const headingLower = c.heading.toLowerCase();
  const titleLower = c.sourceTitle.toLowerCase();
  const body = `${c.text} ${c.summary}`.toLowerCase();
  let score = 2;

  for (const t of terms) {
    if (base === t || base.replace(/\.[^.]+$/, "") === t) score += 14;
    else if (pathLower.includes(t) || titleLower.includes(t)) score += 6;
    if (headingLower.includes(t)) score += 8;
    if (body.includes(t)) score += 4;
  }

  if (c.ftScore > 0) score += 10 + Math.min(16, c.ftScore * 4);
  for (const r of riskTerms) if (body.includes(r) || headingLower.includes(r)) score += 5;

  return Math.round(score * 100) / 100;
}

// ---- Graph-node scoring (Stage 2) ------------------------------------------

export interface GraphNodeScoreInput {
  label: string;
  normLabel: string;
  sourceFile: string;
  kind: string;
  ftScore: number;
  degree: number; // edge count touching this node (proximity / impact)
}

/**
 * Score a candidate graph node for a task. Weighting (deterministic):
 *   base ........................ 2
 *   + exact label/symbol match .. 24 (basename, with or without "()")
 *   + label contains term ....... 10 each
 *   + source-file path match .... 6 each
 *   + full-text (BM25) hit ...... 8 + min(14, ftScore*4)
 *   + symbol/module impact ...... +3 (callable symbol kinds)
 *   + degree (proximity/impact) . up to +8, log-scaled
 *   + risk-term reference ....... 5 each
 */
export function scoreGraphNode(
  n: GraphNodeScoreInput,
  terms: string[],
  riskTerms: string[],
): number {
  const labelLower = n.label.toLowerCase();
  const bareLabel = labelLower.replace(/\(\)$/, "");
  const normLower = n.normLabel.toLowerCase();
  const fileLower = n.sourceFile.toLowerCase();
  const fileBase = fileLower.split("/").pop() ?? fileLower;
  let score = 2;

  for (const t of terms) {
    if (bareLabel === t || normLower === t) score += 24;
    else if (labelLower.includes(t) || normLower.includes(t)) score += 10;
    if (fileBase === t || fileBase.replace(/\.[^.]+$/, "") === t) score += 6;
    else if (fileLower.includes(t)) score += 4;
  }

  if (n.ftScore > 0) score += 8 + Math.min(14, n.ftScore * 4);
  if (/symbol|function|method|class|callable/.test(n.kind.toLowerCase())) score += 3;
  if (n.degree > 0) score += Math.min(8, Math.log2(n.degree + 1) * 2.2);
  for (const r of riskTerms) if (labelLower.includes(r) || fileLower.includes(r)) score += 5;

  return Math.round(score * 100) / 100;
}

// ---- Vector similarity (Stage 3) -------------------------------------------

/**
 * Cosine similarity between two equal-length numeric vectors. Returns 0 for
 * mismatched lengths, empty vectors, or a zero-magnitude vector. Deterministic:
 * no randomness, same inputs always produce the same value.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
