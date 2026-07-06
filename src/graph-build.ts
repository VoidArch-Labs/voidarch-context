// Native (pure-TypeScript) repo graph builder — Voidarch Context's own
// `graph build` engine. No Rust binary, no Tree-sitter: regex-level extraction
// of file nodes, exported/top-level symbols, and import edges, emitted in the
// same GraphifyGraph shape the import pipeline (buildGraphPlan/importGraph)
// and readers (query/context/status) already consume.
//
// ponytail: regex extraction, not a parser — good enough for module-level
// structure; upgrade path is a Tree-sitter pass emitting the same shape.

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { listRepoFiles } from "./ingest.js";
import type { GraphifyGraph } from "./graph.js";

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".rb", ".java", ".kt", ".c", ".h", ".cpp", ".hpp"]);
const DOC_EXT = new Set([".md", ".mdx", ".txt"]);
const MAX_BYTES = 256 * 1024; // match ingest's cap; bigger files are noise here

interface Extracted {
  symbols: Array<{ name: string; kind: "function" | "class" | "const"; line: number }>;
  imports: string[]; // raw import specifiers
}

/** JS/TS: import/export-from/require specifiers + exported declarations. */
function extractJs(content: string): Extracted {
  const symbols: Extracted["symbols"] = [];
  const imports: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^\s*(?:import|export)\s[^"']*?\sfrom\s+["']([^"']+)["']/.exec(line) ?? /^\s*import\s+["']([^"']+)["']/.exec(line);
    if (m) imports.push(m[1]);
    for (const r of line.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) imports.push(r[1]);
    m = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
    if (m) symbols.push({ name: m[1], kind: "function", line: i + 1 });
    m = /^\s*export\s+(?:default\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) symbols.push({ name: m[1], kind: "class", line: i + 1 });
    m = /^\s*export\s+(?:const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) symbols.push({ name: m[1], kind: "const", line: i + 1 });
  }
  return { symbols, imports };
}

/** Python: top-level def/class + import targets (dotted → path-ish). */
function extractPy(content: string): Extracted {
  const symbols: Extracted["symbols"] = [];
  const imports: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
    if (m) symbols.push({ name: m[1], kind: "function", line: i + 1 });
    m = /^class\s+([A-Za-z_]\w*)/.exec(line);
    if (m) symbols.push({ name: m[1], kind: "class", line: i + 1 });
    m = /^\s*from\s+([.\w]+)\s+import\s/.exec(line) ?? /^\s*import\s+([.\w]+)/.exec(line);
    if (m) imports.push(m[1].replace(/\./g, "/"));
  }
  return { symbols, imports };
}

/** Other code languages: no symbols/imports (file nodes only). */
const EMPTY: Extracted = { symbols: [], imports: [] };

function extract(ext: string, content: string): Extracted {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return extractJs(content);
  if (ext === ".py") return extractPy(content);
  return EMPTY;
}

const JS_RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** Resolve a relative import specifier to a repo-relative file path, or null
 *  (bare package specifiers and unresolvable paths are dropped). */
function resolveImport(root: string, fromRel: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith(".")) {
    // Python-style root-relative module (a/b → a/b.py or a/b/__init__.py).
    if (known.has(`${spec}.py`)) return `${spec}.py`;
    if (known.has(`${spec}/__init__.py`)) return `${spec}/__init__.py`;
    return null; // bare specifier = external dep; not a repo edge
  }
  const base = resolve(root, dirname(fromRel), spec);
  for (const suffix of JS_RESOLVE_SUFFIXES) {
    // ".js" specifiers in ESM-TS repos actually point at ".ts" sources.
    const candidates = suffix === "" && /\.js$/.test(base)
      ? [base, base.replace(/\.js$/, ".ts")]
      : [base + suffix];
    for (const cand of candidates) {
      const rel = relative(root, cand).replace(/\\/g, "/");
      if (known.has(rel)) return rel;
    }
  }
  return null;
}

export interface NativeBuildStats {
  files: number;
  symbols: number;
  edges: number;
}

/** Build a GraphifyGraph from the repo's own sources. `builtAtCommit` stamps
 *  freshness (pass currentGitCommit(root)). */
export function buildNativeGraph(root: string, builtAtCommit: string): { graph: GraphifyGraph; stats: NativeBuildStats } {
  const files = listRepoFiles(root)
    .filter((f) => {
      const ext = extname(f).toLowerCase();
      if (!CODE_EXT.has(ext) && !DOC_EXT.has(ext)) return false;
      try {
        return statSync(f).size <= MAX_BYTES;
      } catch {
        return false;
      }
    })
    .map((f) => relative(root, f).replace(/\\/g, "/"))
    .sort();
  const known = new Set(files);

  const nodes: NonNullable<GraphifyGraph["nodes"]> = [];
  const links: NonNullable<GraphifyGraph["links"]> = [];
  let symbolCount = 0;

  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    const isDoc = DOC_EXT.has(ext);
    nodes.push({
      id: rel,
      label: rel,
      norm_label: rel.toLowerCase(),
      file_type: isDoc ? "document" : "code",
      source_file: rel,
      _origin: "voidarch-native",
    });
    if (isDoc) continue;

    let content: string;
    try {
      content = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const { symbols, imports } = extract(ext, content);

    for (const s of symbols) {
      symbolCount++;
      const id = `${rel}#${s.name}`;
      nodes.push({
        id,
        // "()" suffix marks function-ish labels as kind=symbol for deriveNodeKind.
        label: s.kind === "function" ? `${s.name}()` : s.name,
        norm_label: s.name.toLowerCase(),
        file_type: "code",
        source_file: rel,
        source_location: `L${s.line}`,
        _origin: "voidarch-native",
      });
      links.push({ source: rel, target: id, relation: "declares", weight: 1, source_file: rel });
    }

    const seen = new Set<string>();
    for (const spec of imports) {
      const target = resolveImport(root, rel, spec, known);
      if (!target || target === rel || seen.has(target)) continue;
      seen.add(target);
      links.push({ source: rel, target, relation: "imports", weight: 1, source_file: rel });
    }
  }

  return {
    graph: { nodes, links, hyperedges: [], built_at_commit: builtAtCommit },
    stats: { files: files.length, symbols: symbolCount, edges: links.length },
  };
}
