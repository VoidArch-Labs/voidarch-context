# Voidarch Context

**Local-first repo memory, search, code-graph and context-pack engine for AI coding agents.**

Voidarch Context gives Claude Code, Codex and other coding agents persistent per-repository context without requiring a hosted service. It indexes source and documentation, stores durable memories and task state, builds a lightweight code graph, and assembles ranked context packs under an explicit token budget.

> **Status:** active development, version `0.1.0`. CI is configured to verify the implemented CLI surface from a packed consumer install. The project is not yet published as a stable npm release.

## What is implemented

- Embedded SurrealKV storage inside the target repository.
- BM25 document search and deterministic ranking heuristics.
- Local ONNX embeddings through `all-MiniLM-L6-v2`, with an optional approval-gated OpenAI-compatible endpoint.
- Tree-sitter code-graph extraction for TypeScript, TSX, JavaScript and Python, with regex fallback and file-level support for additional languages.
- Durable memories, tasks, blockers, run records and context-pack history.
- Scoped entities, immutable source episodes and temporal facts with provenance and review states.
- Scoped operational problem observations and reusable verified solution references, stored as immutable episode evidence.
- Markdown or JSON context packs with estimated token budgets.
- A local read-mostly status, search and context page.
- Claude Code command snippets and an `AGENTS.md` integration block.

## Verification

The GitHub Actions workflow is configured to run on Node 20 and 22 and verify:

1. TypeScript compilation.
2. `npm pack` package contents and binary resolution.
3. Installation of the tarball into a fresh temporary Git repository.
4. `init`, `ingest`, `graph build`, `remember`, `search`, `query`, `context` and `status` through the shipped `voidarch-context` binary.
5. Machine-readable context output and token-budget metadata.

The smoke test is available locally as:

```bash
npm ci
npm run typecheck
npm run smoke
```

## Install from source

```bash
git clone https://github.com/VoidArch-Labs/voidarch-context.git
cd voidarch-context
npm ci
npm link
voidarch-context help
```

Requires Node 20 or newer. Docker, Python and a Rust toolchain are not required.

## Quick start

```bash
cd your-repository
voidarch-context init
voidarch-context ingest
voidarch-context graph build
voidarch-context context "fix the authentication token refresh bug"
```

Optional semantic retrieval:

```bash
voidarch-context models install
voidarch-context embed --approve
```

The model download happens once and is cached locally. Remote embedding endpoints are opt-in and require explicit approval before paid calls.

## Main commands

| Command | Purpose |
|---|---|
| `voidarch-context init` | Create `.voidarch/config.json` and safe `.gitignore` entries |
| `voidarch-context ingest` | Index repository source and documentation |
| `voidarch-context search "..."` | Rank indexed document chunks |
| `voidarch-context graph build` | Build file, symbol and import relationships |
| `voidarch-context query "..."` | Search code-graph nodes and neighborhoods |
| `voidarch-context context "..."` | Produce a token-budgeted Markdown or JSON context pack |
| `voidarch-context knowledge ...` | Store/query entities, episodes and temporal facts |
| `voidarch-context operational observe ...` | Record scoped problem/outcome evidence |
| `voidarch-context operational search ...` | Query scoped operational observations |
| `voidarch-context operational solutions ...` | Retrieve successful reusable solution references |
| `voidarch-context remember --kind decision "..."` | Store a durable project memory |
| `voidarch-context memory list` | Inspect stored memories |
| `voidarch-context task ...` | Manage persistent task state |
| `voidarch-context blocker ...` | Manage blockers |
| `voidarch-context status` | Report freshness and record counts |
| `voidarch-context doctor` | Inspect database, graph, vectors and memory health |
| `voidarch-context serve` | Start the local read-mostly web page |

Run `voidarch-context help` for the complete command surface.

## Storage and privacy

| Path | Purpose | Commit? |
|---|---|---|
| `.voidarch/config.json` | Repository identity and embedding-provider choice | Optional |
| `.voidarch/db/` | Embedded database and durable memory | No |
| `.voidarch/runtime/` | Runtime state | No |
| `.voidarchignore` | Optional ingest exclusions | Optional |

- The embedded database stays in the repository directory.
- Local embeddings are the default.
- Remote endpoints are opt-in.
- Ingest skips dotenv files, lockfiles and secrets-shaped filenames.
- The web page binds to localhost.
- No telemetry is sent by the Context package.

## Architecture

```text
Repository files and docs
        │
        ├── ingest ──> embedded SurrealKV documents
        ├── graph build ──> files, symbols and import edges
        ├── remember/task/blocker ──> durable project state
        └── embed ──> optional local or approved remote vectors
                              │
Task query ──> ranking and neighborhood retrieval ──> token-budgeted context pack
```

The standalone repository is synchronized from the `packages/voidarch-context` workspace inside [Voidarch Studio](https://github.com/VoidArch-Labs/voidarch). Context remains independently usable and does not require Studio.

## Current limitations

- Embedded SurrealKV is single-process. Do not run a large ingest while `serve` holds the database lock.
- Tree-sitter symbol extraction is deepest for TypeScript, TSX, JavaScript and Python. Other languages currently receive file nodes unless an external graph engine is used.
- `.voidarchignore` supports simple globs without negation.
- Vector retrieval requires an explicit `embed` pass. Fresh repositories start with BM25 and deterministic heuristics.
- The local web page is read-mostly; management workflows live in the CLI.
- Stable npm publication and release automation are not yet complete.

## License

MIT
