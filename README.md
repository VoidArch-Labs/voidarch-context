# Voidarch Context

**Drop-in local memory, repo-query, and context-pack engine for AI coding agents — no Docker, no Python, no API key.**

## Why it exists

AI coding agents burn tokens re-discovering the same repo facts every session and forget every decision the moment the context window closes. Voidarch Context gives any agent (Claude Code, Codex, or your own) a persistent, local, per-repo brain: indexed files, a code graph, searchable docs, vector embeddings, and durable memories (decisions, lessons, task notes) — assembled on demand into a single token-budgeted context pack.

Everything runs locally: an embedded database inside your repo and a local embedding model. Nothing leaves your machine unless you explicitly configure a remote endpoint.

## Install

```bash
npm install -g @voidarch/context      # global CLI
# or per-repo:
npm install --save-dev @voidarch/context
npx voidarch-context help
```

Requires Node 20+. No Docker, no Python, no Rust toolchain.

## 3-minute quickstart

```bash
cd your-repo
voidarch-context init                      # writes .voidarch/config.json + .gitignore entries
voidarch-context ingest                    # index the repo (files, docs)
voidarch-context context "fix the auth token refresh bug"
```

That's it — the third command prints a Markdown context pack (relevant files, symbols, doc excerpts, memories, open tasks/blockers) ready to paste into any agent. Optional next steps:

```bash
voidarch-context models install            # pre-download the local embedding model (~90 MB, one-time)
voidarch-context embed --approve           # embed indexed content for semantic retrieval
voidarch-context serve                     # local info/search page at http://localhost:4950
```

## CLI commands

| Command | What it does |
|---|---|
| `voidarch-context init` | Scaffold `.voidarch/config.json` + `.gitignore` entries |
| `voidarch-context ingest` | Index repo text files into the embedded DB |
| `voidarch-context search "..."` | Rank document chunks for a query (BM25 full-text) |
| `voidarch-context query "..."` | Rank code-graph nodes + neighborhood edges |
| `voidarch-context context "..."` | Build a token-budgeted Markdown/JSON context pack |
| `voidarch-context remember --kind decision "..."` | Record a durable memory (`decision`, `evidence`, `lesson`, `snippet`, `repo_fact`, `task_note`) |
| `voidarch-context memory list` / `memory search "..."` | Browse / search stored memories |
| `voidarch-context status` | Counts + freshness across all channels |
| `voidarch-context serve` | Local self-hosted info/search/context page |
| `voidarch-context doctor` | Health report across DB, ingest, docs, graph, vectors, memory |

More: `task`, `blocker`, `metrics`, `sync`, `embed`, `docs <ingest|query>`, `graph <build|import|query|status>`, `db <status|migrate>`, `models <status|install>`, `config embedding <local|openai-compatible>`, `snippets`. Run `voidarch-context help` for the full surface.

## Embeddings

### Local (default, keyless)

The default embedding provider is a local ONNX model (`all-MiniLM-L6-v2`) run via `@huggingface/transformers`. It downloads and caches automatically on first use, or explicitly:

```bash
voidarch-context models status     # provider/model/cache state
voidarch-context models install    # pre-download + warm the cache
```

No API key, no network calls after the one-time model download.

### OpenAI-compatible endpoint (optional)

Point at any OpenAI-compatible embeddings API (OpenAI, local inference servers, gateways):

```bash
voidarch-context config embedding openai-compatible
export VOIDARCH_EMBED_BASE_URL="https://api.openai.com"   # or your endpoint
export VOIDARCH_EMBED_MODEL="text-embedding-3-small"
export VOIDARCH_EMBED_API_KEY="sk-..."                     # or OPENAI_API_KEY
export VOIDARCH_EMBED_DIMENSIONS="1536"                    # optional
voidarch-context embed --approve                            # paid calls always need explicit approval
```

Paid embedding calls are gated: they run only with `--approve` or `VOIDARCH_EMBED_APPROVED=1`, so you can never bill an API key by accident. Switch back anytime with `voidarch-context config embedding local`.

## What files it creates

| Path | Purpose | Commit? |
|---|---|---|
| `.voidarch/config.json` | repoId + embedding provider choice (no secrets) | yes (optional) |
| `.voidarch/db/` | embedded SurrealKV database (all indexed data + memories) | no (gitignored by `init`) |
| `.voidarchignore` | optional gitignore-style excludes for ingest | yes |
| `.gitignore` additions | keeps the DB and legacy env files out of git | yes |

Legacy repos initialized before the Voidarch rename (`.nox/config.json`, `.dfc/dev-memory/`, `.noxignore`, `NOX_EMBED_*` env vars) keep working — old paths are read as deprecated fallbacks; new writes go to `.voidarch/`.

## Privacy / local-first

- Embedded database lives inside your repo; no server, no cloud, no telemetry.
- Local embeddings by default; remote embedding endpoints are opt-in and approval-gated.
- Ingest is default-deny by extension and skips dotenv files, lockfiles, and secrets-shaped names.
- The info page (`serve`) binds locally and reads only your repo's own database.

## Using with Claude Code

Run `voidarch-context snippets` and paste the printed slash command into `.claude/commands/voidarch-context.md`:

```markdown
---
description: Build a Voidarch Context pack for the current task
---

Run `npx voidarch-context context "$ARGUMENTS"` and use the Markdown output as
context for the rest of this task. If it reports open blockers or required
approvals, surface those to the user before proceeding.
```

Then `/voidarch-context <task>` inside Claude Code builds and injects a context pack. Have the agent record durable facts with `voidarch-context remember --kind decision "..."` as it works.

## Using with Codex / AGENTS.md

`voidarch-context snippets` also prints an AGENTS.md block. Add it to your repo's `AGENTS.md` so Codex (and any AGENTS.md-aware agent) knows to run:

```bash
npx voidarch-context context "<short task description>"   # before non-trivial tasks
npx voidarch-context remember --kind lesson "..."          # to record what it learned
```

## Local info page

```bash
voidarch-context serve --port 4950
```

Serves a local page with repo status, memory browsing, doc search, and context-pack building — a read-mostly window into the same embedded DB the CLI uses.

## Voidarch Context vs. Voidarch Studio

- **Voidarch Context** (this package): the memory/query/context engine. If it indexes, retrieves, remembers, searches, or explains repo context — it's Context. Standalone, agent-neutral, installable in minutes.
- **[Voidarch Studio](https://github.com/code-shame/voidarch)**: the orchestration control room built on top — worktrees, terminals, agent launching, provider routing, hooks, observability, GitHub/Vercel integrations. Studio *uses* Context; Context never needs Studio.

## Troubleshooting

- **`Embedded SurrealDB connect timed out`** — SurrealKV allows one process at a time; another command (or `serve`) holds the lock. Wait or kill it. A killed process can hold the lock briefly.
- **`tsx: command not found`** — install dependencies (`npm install`); the CLI runs its TypeScript scripts via the bundled `tsx`.
- **Empty search/context results** — run `voidarch-context ingest` first; check `voidarch-context status` for per-channel counts and `voidarch-context doctor` for a full health report.
- **Local model download slow/blocked** — `voidarch-context models install` shows progress; the cache persists, it's one-time per machine.
- **Old `.dfc`/`.nox` repo** — nothing to migrate; legacy paths are auto-detected. New repos get `.voidarch/`.

## MVP limitations

- Graph building (`graph build`) shells out to an optional external producer; without it, `query` falls back to imported graph data or returns empty — `search`, `context`, and memory work regardless.
- `.voidarchignore` supports simple globs only (no negation).
- Single-process embedded DB: don't run `serve` and a big `ingest` simultaneously.
- Semantic (vector) retrieval requires an explicit `embed` pass; fresh repos start with BM25 + heuristics.
- The info page is read-mostly; management UX lives in the CLI.
