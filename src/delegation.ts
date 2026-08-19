// Delegation packs: purpose-specific context for a subagent (Hermes
// delegate_task `context` string, Claude Task prompt, Codex task brief).
// Built ON TOP of buildContextPack — deterministic retrieval, then reshaped
// around the delegation contract: objective, acceptance criteria, constraints,
// failed approaches, verification commands, write scope, privacy-safe ids.

import type { Surreal } from "surrealdb";
import { buildContextPack, type BuildContextPackOptions } from "./context-pack.js";
import type { ContextPack } from "./types.js";

export interface DelegationPackOptions extends BuildContextPackOptions {
  objective: string;
  acceptanceCriteria?: string[];
  /** Paths/globs the subagent may write; everything else is read-only. */
  writeScope?: string[];
  verificationCommands?: string[];
  branch?: string;
}

export interface DelegationPack {
  objective: string;
  acceptance_criteria: string[];
  repo: { repo_id: string; branch?: string };
  relevant_files: Array<{ path: string; excerpt: string }>;
  relevant_symbols: Array<{ label: string; source_file: string }>;
  constraints_and_decisions: string[];
  known_failed_approaches: string[];
  verification_commands: string[];
  write_scope: string[];
  entities: Array<{ ref: string; name: string; entity_type: string }>;
  facts: string[];
  open_blockers: string[];
  token_budget: ContextPack["token_budget"];
}

export async function buildDelegationPack(
  db: Surreal,
  repoId: string,
  opts: DelegationPackOptions,
): Promise<DelegationPack> {
  const pack = await buildContextPack(db, repoId, opts.objective, {
    ...opts,
    maxTokens: opts.maxTokens ?? 2000, // delegation packs are deliberately lean
  });
  // Lessons are the institutional "we tried X, it failed" memory; blockers are live.
  const failed = [
    ...pack.memory_context.lessons.map((l) => l.summary),
    ...pack.verification.last_failures,
  ];
  const constraints = [
    ...pack.memory_context.decisions.map((d) => d.summary),
    ...pack.memory_context.repo_facts.map((f) => f.summary),
    ...pack.workflow.approval_required.map((a) => `requires approval: ${a}`),
  ];
  return {
    objective: opts.objective,
    acceptance_criteria: opts.acceptanceCriteria ?? [],
    repo: { repo_id: repoId, branch: opts.branch },
    relevant_files: pack.repo_context.files.slice(0, 8).map((f) => ({ path: f.path, excerpt: f.excerpt })),
    relevant_symbols: pack.repo_context.symbols.slice(0, 8).map((s) => ({ label: s.label, source_file: s.source_file })),
    constraints_and_decisions: constraints.slice(0, 10),
    known_failed_approaches: failed.slice(0, 8),
    verification_commands: opts.verificationCommands ?? [],
    write_scope: opts.writeScope ?? [],
    entities: pack.general_context.entities.map((e) => ({ ref: e.ref, name: e.name, entity_type: e.entity_type })),
    facts: pack.general_context.facts.filter((f) => f.status === "confirmed").map((f) => f.statement),
    open_blockers: pack.state.open_blockers.map((b) => b.summary),
    token_budget: pack.token_budget,
  };
}

/** Render for agents that take a plain-text context block (Hermes delegate_task). */
export function formatDelegationPackText(p: DelegationPack): string {
  const sec = (title: string, lines: string[]): string =>
    lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}\n` : "";
  return [
    `OBJECTIVE: ${p.objective}`,
    `REPO: ${p.repo.repo_id}${p.repo.branch ? ` @ ${p.repo.branch}` : ""}`,
    sec("ACCEPTANCE CRITERIA", p.acceptance_criteria),
    sec("WRITE SCOPE (do not touch anything else)", p.write_scope),
    sec("RELEVANT FILES", p.relevant_files.map((f) => f.path)),
    sec("RELEVANT SYMBOLS", p.relevant_symbols.map((s) => `${s.label} (${s.source_file})`)),
    sec("CONSTRAINTS & DECISIONS", p.constraints_and_decisions),
    sec("KNOWN FAILED APPROACHES (do not repeat)", p.known_failed_approaches),
    sec("RELEVANT ENTITIES", p.entities.map((e) => `${e.name} (${e.entity_type})`)),
    sec("CONFIRMED FACTS", p.facts),
    sec("OPEN BLOCKERS", p.open_blockers),
    sec("VERIFY WITH", p.verification_commands),
  ]
    .filter(Boolean)
    .join("\n");
}
