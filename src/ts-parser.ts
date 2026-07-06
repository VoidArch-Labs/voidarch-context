// Tree-sitter (WASM) extraction for the native graph builder. Uses
// web-tree-sitter + prebuilt grammars from tree-sitter-wasms — no native
// compilation, keeping the no-Rust/no-node-gyp install promise. If the wasm
// runtime or a grammar fails to load, callers fall back to the regex
// extractors in graph-build.ts, so this module can never break `graph build`.

import { createRequire } from "node:module";
import type { Extracted } from "./graph-build.js";

const require = createRequire(import.meta.url);

// Minimal structural types for the web-tree-sitter surface we use — avoids a
// hard type dependency on the package's shipped .d.ts across versions.
interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number };
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
}
interface TSTree {
  rootNode: TSNode;
  delete?(): void;
}
interface TSParser {
  setLanguage(lang: unknown): void;
  parse(code: string): TSTree | null;
  delete?(): void;
}

const EXT_TO_GRAMMAR: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
};

let initFailed = false;
let runtimePromise: Promise<{ ParserCtor: new () => TSParser; LanguageLoader: { load(path: string): Promise<unknown> } }> | null = null;
const languages = new Map<string, unknown | null>(); // grammar name -> Language (null = load failed)

/** Load the web-tree-sitter runtime, tolerating both export shapes:
 *  0.24.x default-exports Parser (with static Language); 0.25+ named-exports
 *  { Parser, Language }. */
async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import("web-tree-sitter");
      const ParserCtor = mod.Parser ?? mod.default;
      await ParserCtor.init();
      const LanguageLoader = mod.Language ?? ParserCtor.Language;
      if (!LanguageLoader?.load) throw new Error("web-tree-sitter: no Language loader found");
      return { ParserCtor, LanguageLoader };
    })();
  }
  return runtimePromise;
}

async function getLanguage(grammar: string): Promise<unknown | null> {
  if (languages.has(grammar)) return languages.get(grammar) ?? null;
  try {
    const { LanguageLoader } = await getRuntime();
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
    const lang = await LanguageLoader.load(wasmPath);
    languages.set(grammar, lang);
    return lang;
  } catch {
    languages.set(grammar, null);
    return null;
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/** Recursively collect require("x") specifiers anywhere in the tree. */
function collectRequires(node: TSNode, out: string[]): void {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    const first = args?.namedChildren[0];
    if (fn?.text === "require" && first && first.type === "string") {
      out.push(stripQuotes(first.text));
    }
  }
  for (const child of node.namedChildren) collectRequires(child, out);
}

const JS_DECL_KINDS: Record<string, Extracted["symbols"][number]["kind"]> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "const",
  type_alias_declaration: "const",
  enum_declaration: "const",
};

function jsExportedSymbols(decl: TSNode, out: Extracted["symbols"]): void {
  const kind = JS_DECL_KINDS[decl.type];
  if (kind) {
    const name = decl.childForFieldName("name");
    if (name) out.push({ name: name.text, kind, line: decl.startPosition.row + 1 });
    return;
  }
  if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      if (!name || name.type !== "identifier") continue;
      const value = d.childForFieldName("value");
      const isFn = value?.type === "arrow_function" || value?.type === "function_expression" || value?.type === "function";
      out.push({ name: name.text, kind: isFn ? "function" : "const", line: d.startPosition.row + 1 });
    }
  }
}

function extractJsTree(root: TSNode): Extracted {
  const symbols: Extracted["symbols"] = [];
  const imports: string[] = [];
  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source");
      if (source) imports.push(stripQuotes(source.text));
    } else if (node.type === "export_statement") {
      const source = node.childForFieldName("source");
      if (source) imports.push(stripQuotes(source.text)); // export ... from "x"
      const decl = node.childForFieldName("declaration");
      if (decl) jsExportedSymbols(decl, symbols);
    }
  }
  collectRequires(root, imports);
  return { symbols, imports };
}

function pyModuleName(node: TSNode): string {
  // dotted_name / relative_import → path-ish specifier the resolver understands.
  const text = node.text.trim();
  if (text.startsWith(".")) {
    const m = /^(\.+)(.*)$/.exec(text);
    const ups = m ? m[1].length : 1;
    const rest = (m?.[2] ?? "").replace(/\./g, "/");
    return `${"../".repeat(ups - 1) || "./"}${rest}`;
  }
  return text.replace(/\./g, "/");
}

function extractPyTree(root: TSNode): Extracted {
  const symbols: Extracted["symbols"] = [];
  const imports: string[] = [];
  const pushDef = (node: TSNode) => {
    const name = node.childForFieldName("name");
    if (!name) return;
    const kind = node.type === "class_definition" ? "class" : "function";
    symbols.push({ name: name.text, kind, line: node.startPosition.row + 1 });
  };
  for (const node of root.namedChildren) {
    if (node.type === "function_definition" || node.type === "class_definition") pushDef(node);
    else if (node.type === "decorated_definition") {
      const def = node.childForFieldName("definition");
      if (def && (def.type === "function_definition" || def.type === "class_definition")) pushDef(def);
    } else if (node.type === "import_statement") {
      for (const child of node.namedChildren) {
        if (child.type === "dotted_name") imports.push(pyModuleName(child));
        else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          if (name) imports.push(pyModuleName(name));
        }
      }
    } else if (node.type === "import_from_statement") {
      const mod = node.childForFieldName("module_name");
      if (mod) imports.push(pyModuleName(mod));
    }
  }
  return { symbols, imports };
}

/**
 * Parse `content` with the grammar matching `ext` and extract symbols/imports.
 * Returns null when tree-sitter is unavailable, the grammar is unsupported, or
 * parsing fails — callers then use the regex extractors.
 */
export async function extractWithTreeSitter(ext: string, content: string): Promise<Extracted | null> {
  if (initFailed) return null;
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return null;
  try {
    const { ParserCtor } = await getRuntime();
    const lang = await getLanguage(grammar);
    if (!lang) return null;
    const parser = new ParserCtor();
    try {
      parser.setLanguage(lang);
      const tree = parser.parse(content);
      if (!tree) return null;
      try {
        return grammar === "python" ? extractPyTree(tree.rootNode) : extractJsTree(tree.rootNode);
      } finally {
        tree.delete?.(); // wasm-side memory is manual
      }
    } finally {
      parser.delete?.();
    }
  } catch {
    initFailed = true;
    return null;
  }
}

/** True once any grammar has successfully loaded (for engine reporting). */
export function treeSitterActive(): boolean {
  for (const lang of languages.values()) if (lang) return true;
  return false;
}
