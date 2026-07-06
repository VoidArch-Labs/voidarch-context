# Voidarch Context — product page

## Hero

**Give your AI coding agent a memory that survives the context window.**

*Voidarch Context is a drop-in, local-first memory and repo-query engine for AI coding agents. Index your repo, remember decisions, and hand any agent a perfect context pack — in one npm install, with no Docker, no Python, and no API key.*

## Target users

- **Claude Code / Codex power users** tired of re-explaining their repo every session.
- **Teams running multiple agents** (CLI agents, CI bots, review agents) that need one shared, agent-neutral repo memory.
- **Privacy-sensitive developers** who want retrieval + embeddings without sending code to a cloud API.
- **Plugin/tool builders** who want a context engine as a library (`@voidarch/context` exports its ingest, graph, vectors, and context-pack modules).

## Core benefits

1. **Minutes to useful.** `npm i -g @voidarch/context && voidarch-context init && voidarch-context ingest` — then `context "<task>"` prints an agent-ready Markdown pack.
2. **Local-first by default.** Embedded database inside the repo, local ONNX embeddings, zero required keys, zero telemetry.
3. **Agent-neutral.** One memory that Claude Code, Codex, and any future agent read and write through the same CLI.
4. **Durable memory, not just search.** Decisions, lessons, snippets, repo facts, task notes — recorded once, retrieved every session after.
5. **Token-budgeted context packs.** Files, symbols, docs, graph neighbors, memories, and open blockers ranked and trimmed to a max-token budget.

## Features

### Repo indexing
Default-deny text ingestion (secrets and lockfiles never stored), incremental by content hash, `.voidarchignore` excludes.

### Code graph
Built-in native graph builder (`graph build`): Tree-sitter parsing (WASM grammars — no native compilation) extracts file nodes, exported symbols, and import edges straight from your sources, with regex fallback; no external tools. Or import a deeper externally-built graph; `query "..."` ranks nodes by BM25 + degree and shows the neighborhood edges — "what touches this?" in one command.

### Docs search
`search "..."` ranks Markdown/doc chunks (BM25 full-text, or a keyless local dry-run mode with no DB at all).

### Memory
`remember --kind decision|evidence|lesson|snippet|repo_fact|task_note`, full CRUD via `memory`, plus `task` and `blocker` tracking, garbage collection, and a `doctor` health report.

### Vectors & embeddings
Local MiniLM embeddings out of the box; optional OpenAI-compatible endpoint (base URL + model + key + optional dimensions), always approval-gated so paid calls never happen by accident.

### Context packs
`context "<task>"` assembles everything above into one Markdown or JSON pack with a token budget — the single artifact you hand your agent.

### Local info page
`serve` hosts a local status/search/context page over the same embedded DB.

## Setup example

```bash
npm install -g @voidarch/context
cd your-repo
voidarch-context init
voidarch-context ingest
voidarch-context remember --kind decision "We use pnpm workspaces; never npm-install in subpackages."
voidarch-context context "add rate limiting to the API gateway"
```

## Works with Claude Code and Codex

- **Claude Code:** `voidarch-context snippets` prints a ready-to-paste slash command (`.claude/commands/voidarch-context.md`) — `/voidarch-context <task>` builds and injects a context pack.
- **Codex & AGENTS.md agents:** the same command prints an AGENTS.md block instructing agents to pull a context pack before non-trivial tasks and record memories as they work.

## Local-first / privacy

Your code never leaves your machine. The database is an embedded file store inside your repo (gitignored), embeddings run locally by default, and remote embedding endpoints are explicit, opt-in, and approval-gated. Ingest refuses dotenv files and secret-shaped names by design.

## Voidarch Context vs. Voidarch Studio

| | Voidarch Context | Voidarch Studio |
|---|---|---|
| What | Memory / query / context engine | Agent orchestration control room *(coming soon)* |
| Form | npm package + CLI + local page | Desktop app + dashboard *(coming soon)* |
| Owns | Indexing, graph, vectors, memory, context packs | Worktrees, terminals, agent launching, provider routing, hooks, observability, GitHub/Vercel |
| Needs the other? | No — fully standalone | Yes — Studio builds on Context |

## FAQ

**Do I need an API key?** No. Local embeddings are the default. Keys are only needed if you opt into an OpenAI-compatible endpoint.

**Do I need Docker or a database server?** No. The database is embedded (SurrealKV) and lives in `.voidarch/db/` inside your repo.

**How big is the local model?** ~90 MB, downloaded once and cached (`models install`).

**Can several repos share one memory?** Each repo gets its own database by default; a hosted SurrealDB can be configured for shared multi-machine memory.

**What gets committed?** Only `.voidarch/config.json` (no secrets) and optional `.voidarchignore`; the database is gitignored.

**I used the old Nox/dfc tooling — do I migrate?** No. Legacy `.nox`/`.dfc` paths and `NOX_*` env vars are read as deprecated fallbacks automatically.

## Roadmap

- More Tree-sitter grammars in the native graph builder (today: TS/TSX/JS/Python; other languages get file nodes) plus call-graph edges.
- Richer semantic retrieval defaults (auto-embed on ingest, hybrid ranking).
- First-class Claude Code plugin package.
- Memory sync/export between machines.
- Voidarch Studio (coming soon): orchestration control room with context packs attached to agent runs.
