import type { SourceAgent } from "./types.js";

const VALID_SOURCE_AGENTS = new Set<SourceAgent>(["manual", "codex", "claude", "grok-build"]);

export function normalizeSourceAgent(value?: string, fallback: SourceAgent = "manual"): SourceAgent {
  const raw = (value || process.env.DFC_SOURCE_AGENT || fallback).trim().toLowerCase();
  if (VALID_SOURCE_AGENTS.has(raw as SourceAgent)) return raw as SourceAgent;
  throw new Error('--agent must be one of "manual", "codex", "claude", or "grok-build"');
}
