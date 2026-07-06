// Graph memory: import graphify's knowledge graph into SurrealDB + query/status.
//
// Source: graphify-out/graph.json (networkx node-link JSON: nodes + links +
// hyperedges + built_at_commit). The first implementation uses a unified node/edge
// model — graph_node.kind distinguishes file/module/symbol/concept/rationale and
// graph_edge.relation distinguishes contains/calls/imports/references/... — which
// maps cleanly onto graphify and stays simple and reliable.
//
// Import is delete-then-insert scoped to repo_id so the graph_node/graph_edge tables
// always reflect the latest graph; graph_snapshot + graph_import_run keep history.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Table, type Surreal } from "surrealdb";
import { ftSearchTerms, queryResult, queryResults } from "./surreal.js";
import { detectRiskTerms, scoreGraphNode, tokenize } from "./scoring.js";
import type {
  ContextGraphEdgeEntry,
  GraphEdgeRecord,
  GraphHyperedgeRecord,
  GraphNodeRecord,
  GraphSnapshotRecord,
  SourceAgent,
} from "./types.js";

// ---- graphify JSON shapes (defensive: every field optional) -----------------
interface GraphifyNode {
  id?: string;
  label?: string;
  norm_label?: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  community?: number;
  _origin?: string;
}
interface GraphifyLink {
  source?: string;
  target?: string;
  relation?: string;
  weight?: number;
  confidence?: string;
  confidence_score?: number;
  source_file?: string;
  source_location?: string;
}
interface GraphifyHyperedge {
  id?: string;
  label?: string;
  nodes?: string[];
  relation?: string;
  confidence?: string;
  confidence_score?: number;
  source_file?: string;
}
export interface GraphifyGraph {
  nodes?: GraphifyNode[];
  links?: GraphifyLink[];
  hyperedges?: GraphifyHyperedge[];
  graph?: { hyperedges?: GraphifyHyperedge[] };
  built_at_commit?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Locate graphify-out/graph.json under `root`, or null if absent. */
export function findGraphFile(root: string): string | null {
  const p = join(root, "graphify-out", "graph.json");
  return existsSync(p) ? p : null;
}

export function loadGraph(path: string): GraphifyGraph {
  return JSON.parse(readFileSync(path, "utf8")) as GraphifyGraph;
}

/** Best-effort current git HEAD (short-circuits to "" when git is unavailable). */
export function currentGitCommit(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Classify a graphify node into a coarse kind for scoring + filtering. */
export function deriveNodeKind(n: GraphifyNode): string {
  const ft = (n.file_type || "").toLowerCase();
  const label = n.label || "";
  if (ft === "concept") return "concept";
  if (ft === "rationale") return "rationale";
  if (/\(\)\s*$/.test(label)) return "symbol";
  if (ft === "document") return "document";
  const base = (n.source_file || "").split("/").pop() ?? "";
  if (/\.[a-z0-9]+$/i.test(label) || (base && label === base)) return "file";
  return ft === "code" ? "module" : ft || "node";
}

export interface GraphPlan {
  snapshot: GraphSnapshotRecord;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  hyperedges: GraphHyperedgeRecord[];
}

/** Pure: turn a parsed graphify graph into snapshot + node/edge/hyperedge rows. */
export function buildGraphPlan(
  graph: GraphifyGraph,
  repoId: string,
  sourceAgent: SourceAgent,
  currentCommit: string,
  now: string,
): GraphPlan {
  const rawNodes = graph.nodes ?? [];
  const rawLinks = graph.links ?? [];
  const rawHyper = graph.hyperedges ?? graph.graph?.hyperedges ?? [];
  const builtAt = graph.built_at_commit ?? "";

  // degree = number of links touching a node id (proximity / impact signal).
  const degree = new Map<string, number>();
  for (const l of rawLinks) {
    if (l.source) degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    if (l.target) degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const snapshotId = sha256(`${repoId}:${builtAt}:${rawNodes.length}:${rawLinks.length}`).slice(0, 24);

  const kindCounts: Record<string, number> = {};
  const nodes: GraphNodeRecord[] = [];
  for (const n of rawNodes) {
    const nodeKey = n.id ?? n.label ?? "";
    if (!nodeKey) continue;
    const kind = deriveNodeKind(n);
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    const label = n.label ?? nodeKey;
    nodes.push({
      repo_id: repoId,
      source_agent: sourceAgent,
      snapshot_id: snapshotId,
      node_key: nodeKey,
      label,
      norm_label: n.norm_label ?? label,
      kind,
      file_type: n.file_type ?? "",
      source_file: n.source_file ?? "",
      source_location: n.source_location ?? "",
      community: typeof n.community === "number" ? n.community : null,
      origin: n._origin ?? "",
      degree: degree.get(nodeKey) ?? 0,
      search_text: `${label} ${n.source_file ?? ""} ${n.norm_label ?? ""}`.trim(),
      created_at: now,
    });
  }

  const relationCounts: Record<string, number> = {};
  const edges: GraphEdgeRecord[] = [];
  for (const l of rawLinks) {
    if (!l.source || !l.target) continue;
    const relation = l.relation ?? "related";
    relationCounts[relation] = (relationCounts[relation] ?? 0) + 1;
    edges.push({
      repo_id: repoId,
      source_agent: sourceAgent,
      snapshot_id: snapshotId,
      src_key: l.source,
      dst_key: l.target,
      relation,
      weight: typeof l.weight === "number" ? l.weight : 1,
      confidence: l.confidence ?? "",
      confidence_score: typeof l.confidence_score === "number" ? l.confidence_score : 0,
      source_file: l.source_file ?? "",
      source_location: l.source_location ?? "",
      created_at: now,
    });
  }

  const hyperedges: GraphHyperedgeRecord[] = [];
  for (const h of rawHyper) {
    const hyperKey = h.id ?? h.label ?? "";
    if (!hyperKey) continue;
    hyperedges.push({
      repo_id: repoId,
      source_agent: sourceAgent,
      snapshot_id: snapshotId,
      hyper_key: hyperKey,
      label: h.label ?? hyperKey,
      relation: h.relation ?? "",
      members: Array.isArray(h.nodes) ? h.nodes : [],
      confidence: h.confidence ?? "",
      confidence_score: typeof h.confidence_score === "number" ? h.confidence_score : 0,
      source_file: h.source_file ?? "",
      created_at: now,
    });
  }

  const snapshot: GraphSnapshotRecord = {
    repo_id: repoId,
    source_agent: sourceAgent,
    snapshot_id: snapshotId,
    built_at_commit: builtAt,
    current_commit: currentCommit,
    is_fresh: Boolean(builtAt) && builtAt === currentCommit,
    node_count: nodes.length,
    edge_count: edges.length,
    hyperedge_count: hyperedges.length,
    relation_counts: relationCounts,
    kind_counts: kindCounts,
    created_at: now,
  };

  return { snapshot, nodes, edges, hyperedges };
}

export interface ImportGraphStats {
  snapshotId: string;
  nodes: number;
  edges: number;
  hyperedges: number;
  isFresh: boolean;
}

/** Replace the repo's graph rows with this plan; append snapshot + import_run. */
export async function importGraph(db: Surreal, plan: GraphPlan): Promise<ImportGraphStats> {
  const repo = plan.snapshot.repo_id;
  // Literal table names (matches the proven DELETE pattern in docs.ts / vectors.ts).
  await queryResults(db, `DELETE graph_node WHERE repo_id = $repo`, { repo });
  await queryResults(db, `DELETE graph_edge WHERE repo_id = $repo`, { repo });
  await queryResults(db, `DELETE graph_hyperedge WHERE repo_id = $repo`, { repo });
  for (const n of plan.nodes) {
    await db.create(new Table("graph_node")).content(n as unknown as Record<string, unknown>);
  }
  for (const e of plan.edges) {
    await db.create(new Table("graph_edge")).content(e as unknown as Record<string, unknown>);
  }
  for (const h of plan.hyperedges) {
    await db.create(new Table("graph_hyperedge")).content(h as unknown as Record<string, unknown>);
  }
  await db.create(new Table("graph_snapshot")).content(plan.snapshot as unknown as Record<string, unknown>);
  await db.create(new Table("graph_import_run")).content({
    repo_id: repo,
    source_agent: plan.snapshot.source_agent,
    snapshot_id: plan.snapshot.snapshot_id,
    built_at_commit: plan.snapshot.built_at_commit,
    is_fresh: plan.snapshot.is_fresh,
    nodes: plan.nodes.length,
    edges: plan.edges.length,
    hyperedges: plan.hyperedges.length,
    created_at: plan.snapshot.created_at,
  });

  return {
    snapshotId: plan.snapshot.snapshot_id,
    nodes: plan.nodes.length,
    edges: plan.edges.length,
    hyperedges: plan.hyperedges.length,
    isFresh: plan.snapshot.is_fresh,
  };
}

// ---- Query ------------------------------------------------------------------

export interface GraphNodeHit {
  node_key: string;
  label: string;
  kind: string;
  source_file: string;
  source_location: string;
  degree: number;
  score: number;
}

interface GraphNodeRow {
  node_key?: string;
  label?: string;
  norm_label?: string;
  kind?: string;
  source_file?: string;
  source_location?: string;
  degree?: number;
  ftScore?: number;
}

function scoreNodeRows(rows: GraphNodeRow[], terms: string[], riskTerms: string[], limit: number): GraphNodeHit[] {
  return rows
    .map((r) => ({
      node_key: r.node_key || "",
      label: r.label || "",
      kind: r.kind || "",
      source_file: r.source_file || "",
      source_location: r.source_location || "",
      degree: r.degree ?? 0,
      score: scoreGraphNode(
        {
          label: r.label || "",
          normLabel: r.norm_label || r.label || "",
          sourceFile: r.source_file || "",
          kind: r.kind || "",
          ftScore: r.ftScore ?? 0,
          degree: r.degree ?? 0,
        },
        terms,
        riskTerms,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Live: rank graph nodes for the query terms (BM25 + label/file substring). */
export async function queryGraphNodes(
  db: Surreal,
  repoId: string,
  terms: string[],
  riskTerms: string[],
  limit: number,
): Promise<GraphNodeHit[]> {
  const map = new Map<string, GraphNodeRow>();
  if (terms.length) {
    const ftRows = await ftSearchTerms<GraphNodeRow>(
      db,
      `SELECT node_key, label, norm_label, kind, source_file, source_location, degree, search::score(0) AS ftScore
       FROM graph_node WHERE repo_id = $repo AND search_text @0@ $q ORDER BY ftScore DESC LIMIT 30`,
      { repo: repoId },
      terms,
      (r) => String(r.node_key ?? ""),
    );
    for (const r of ftRows) if (r.node_key) map.set(r.node_key, r);
  }
  for (const t of terms) {
    const rows = await queryResult<GraphNodeRow[]>(
      db,
      `SELECT node_key, label, norm_label, kind, source_file, source_location, degree FROM graph_node
       WHERE repo_id = $repo
         AND (string::contains(string::lowercase(label), $t)
              OR string::contains(string::lowercase(source_file), $t))
       LIMIT 10`,
      { repo: repoId, t },
    );
    for (const r of rows) if (r.node_key && !map.has(r.node_key)) map.set(r.node_key, { ...r, ftScore: 0 });
  }
  return scoreNodeRows([...map.values()], terms, riskTerms, limit);
}

const RELATION_WEIGHT: Record<string, number> = {
  defines: 6, calls: 6, imports: 5, imports_from: 5, implements: 5,
  test: 5, depends_on: 5, contains: 3, references: 3, owns: 4,
};

function edgeScore(relation: string, bothInSet: boolean): number {
  return Math.round(((RELATION_WEIGHT[relation] ?? 2) + (bothInSet ? 3 : 0)) * 100) / 100;
}

/** Live: edges touching any of `nodeKeys` (the impact/proximity neighborhood). */
export async function neighborhoodEdges(
  db: Surreal,
  repoId: string,
  nodeKeys: string[],
  limit: number,
): Promise<ContextGraphEdgeEntry[]> {
  if (!nodeKeys.length) return [];
  const keySet = new Set(nodeKeys);
  const rows = await queryResult<Array<{ src_key?: string; dst_key?: string; relation?: string; source_file?: string }>>(
    db,
    `SELECT src_key, dst_key, relation, source_file FROM graph_edge
     WHERE repo_id = $repo AND (src_key IN $keys OR dst_key IN $keys) LIMIT 200`,
    { repo: repoId, keys: nodeKeys },
  );
  return rows
    .map((r) => {
      const relation = r.relation || "related";
      const both = keySet.has(r.src_key || "") && keySet.has(r.dst_key || "");
      return {
        src: r.src_key || "",
        dst: r.dst_key || "",
        relation,
        source_file: r.source_file || "",
        score: edgeScore(relation, both),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface GraphQueryResult {
  nodes: GraphNodeHit[];
  edges: ContextGraphEdgeEntry[];
}

export async function queryGraph(db: Surreal, repoId: string, q: string, limit: number): Promise<GraphQueryResult> {
  const terms = Array.from(new Set(tokenize(q))).slice(0, 12);
  const riskTerms = detectRiskTerms(q);
  const nodes = await queryGraphNodes(db, repoId, terms, riskTerms, limit);
  const edges = await neighborhoodEdges(db, repoId, nodes.map((n) => n.node_key), limit * 2);
  return { nodes, edges };
}

/** Dry-run query: build the plan locally and score in-memory (no DB). */
export function queryGraphLocal(plan: GraphPlan, q: string, limit: number): GraphQueryResult {
  const terms = Array.from(new Set(tokenize(q))).slice(0, 12);
  const riskTerms = detectRiskTerms(q);
  const rows: GraphNodeRow[] = plan.nodes.map((n) => ({
    node_key: n.node_key,
    label: n.label,
    norm_label: n.norm_label,
    kind: n.kind,
    source_file: n.source_file,
    source_location: n.source_location,
    degree: n.degree,
    ftScore: 0,
  }));
  const nodes = scoreNodeRows(rows, terms, riskTerms, limit);
  const keySet = new Set(nodes.map((n) => n.node_key));
  const edges = plan.edges
    .filter((e) => keySet.has(e.src_key) || keySet.has(e.dst_key))
    .map((e) => ({
      src: e.src_key,
      dst: e.dst_key,
      relation: e.relation,
      source_file: e.source_file,
      score: edgeScore(e.relation, keySet.has(e.src_key) && keySet.has(e.dst_key)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2);
  return { nodes, edges };
}

// ---- Status -----------------------------------------------------------------

export interface GraphStatus {
  configured: boolean;
  built_at_commit: string;
  current_commit: string;
  is_fresh: boolean;
  node_count: number;
  edge_count: number;
  hyperedge_count: number;
  relation_counts: Record<string, number>;
  kind_counts: Record<string, number>;
  note: string;
}

/** Dry-run status: read graph.json + git HEAD, no DB. */
export function graphStatusLocal(root: string): GraphStatus {
  const file = findGraphFile(root);
  const current = currentGitCommit(root);
  if (!file) {
    return {
      configured: false,
      built_at_commit: "",
      current_commit: current,
      is_fresh: false,
      node_count: 0,
      edge_count: 0,
      hyperedge_count: 0,
      relation_counts: {},
      kind_counts: {},
      note: "no graphify-out/graph.json found — run `/graphify` or `graphify update .`",
    };
  }
  const plan = buildGraphPlan(loadGraph(file), "(local)", "manual", current, new Date().toISOString());
  return {
    configured: true,
    built_at_commit: plan.snapshot.built_at_commit,
    current_commit: current,
    is_fresh: plan.snapshot.is_fresh,
    node_count: plan.snapshot.node_count,
    edge_count: plan.snapshot.edge_count,
    hyperedge_count: plan.snapshot.hyperedge_count,
    relation_counts: plan.snapshot.relation_counts,
    kind_counts: plan.snapshot.kind_counts,
    note: plan.snapshot.is_fresh
      ? "graph matches current HEAD"
      : `graph built at ${plan.snapshot.built_at_commit.slice(0, 8) || "(unknown)"} — stale vs HEAD ${current.slice(0, 8)}; refresh with /graphify`,
  };
}

/** Live status: latest persisted snapshot + table counts. */
export async function graphStatusDb(db: Surreal, repoId: string, root: string): Promise<GraphStatus> {
  const snaps = await queryResult<GraphSnapshotRecord[]>(
    db,
    `SELECT * FROM graph_snapshot WHERE repo_id = $repo ORDER BY created_at DESC LIMIT 1`,
    { repo: repoId },
  );
  const current = currentGitCommit(root);
  const snap = snaps[0];
  if (!snap) {
    return {
      configured: false,
      built_at_commit: "",
      current_commit: current,
      is_fresh: false,
      node_count: 0,
      edge_count: 0,
      hyperedge_count: 0,
      relation_counts: {},
      kind_counts: {},
      note: "no graph_snapshot rows — run `voidarch-context graph import`",
    };
  }
  return {
    configured: true,
    built_at_commit: snap.built_at_commit,
    current_commit: current,
    is_fresh: Boolean(snap.built_at_commit) && snap.built_at_commit === current,
    node_count: snap.node_count,
    edge_count: snap.edge_count,
    hyperedge_count: snap.hyperedge_count,
    relation_counts: snap.relation_counts ?? {},
    kind_counts: snap.kind_counts ?? {},
    note:
      snap.built_at_commit === current
        ? "persisted graph matches current HEAD"
        : `persisted graph built at ${(snap.built_at_commit || "(unknown)").slice(0, 8)} — re-import after /graphify`,
  };
}
