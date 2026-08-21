import type { Surreal } from 'surrealdb';
import { queryResult } from './surreal.js';
import { recordEpisode, type EpisodeRecord } from './general.js';

export type OperationalOutcome = 'failed' | 'blocked' | 'succeeded' | 'workaround_succeeded';

export interface OperationalObservationInput {
  scope_id: string;
  problem_signature: string;
  symptom: string;
  scopes?: string[];
  actor: string;
  workflow_id?: string;
  capability_id?: string;
  outcome: OperationalOutcome;
  evidence_refs?: string[];
  solution_ref?: string;
  occurred_at?: string;
}

export interface OperationalObservationRecord {
  episode_id: string;
  scope_id: string;
  problem_signature: string;
  symptom: string;
  scopes: string[];
  actor: string;
  workflow_id?: string;
  capability_id?: string;
  outcome: OperationalOutcome;
  evidence_refs: string[];
  solution_ref?: string;
  occurred_at: string;
}

export interface QueryOperationalObservationsOptions {
  problemSignature?: string;
  activeScopes?: string[];
  limit?: number;
}

const PREFIX = 'voidarch:operational-observation:';
const SIGNATURE = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const OUTCOMES = new Set<OperationalOutcome>(['failed', 'blocked', 'succeeded', 'workaround_succeeded']);

function requiredText(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return text;
}

function uniqueStrings(values: string[] | undefined, field: string): string[] {
  const result = (values ?? []).map((value) => requiredText(value, field, 1024));
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates`);
  return [...result].sort();
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isFinite(value)) throw new Error('limit must be finite');
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

function validateSignature(value: unknown): string {
  const signature = requiredText(value, 'problem_signature', 128);
  if (!SIGNATURE.test(signature)) throw new Error('problem_signature must be a stable lowercase slug');
  return signature;
}

export async function recordOperationalObservation(
  db: Surreal,
  input: OperationalObservationInput,
): Promise<OperationalObservationRecord> {
  const scopeId = requiredText(input.scope_id, 'scope_id', 512);
  const problemSignature = validateSignature(input.problem_signature);
  const symptom = requiredText(input.symptom, 'symptom', 8192);
  const actor = requiredText(input.actor, 'actor', 256);
  if (!OUTCOMES.has(input.outcome)) throw new Error(`invalid operational outcome: ${String(input.outcome)}`);
  const scopes = uniqueStrings(input.scopes, 'scopes');
  const evidenceRefs = uniqueStrings(input.evidence_refs, 'evidence_refs');
  const workflowId = input.workflow_id ? requiredText(input.workflow_id, 'workflow_id', 512) : undefined;
  const capabilityId = input.capability_id ? requiredText(input.capability_id, 'capability_id', 512) : undefined;
  const solutionRef = input.solution_ref ? requiredText(input.solution_ref, 'solution_ref', 1024) : undefined;

  const payload = {
    problem_signature: problemSignature,
    symptom,
    scopes,
    actor,
    ...(workflowId ? { workflow_id: workflowId } : {}),
    ...(capabilityId ? { capability_id: capabilityId } : {}),
    ...(solutionRef ? { solution_ref: solutionRef } : {}),
    outcome: input.outcome,
    evidence_refs: evidenceRefs,
  };
  const episode = await recordEpisode(db, {
    scope_id: scopeId,
    source: 'tool',
    source_ref: `${PREFIX}${problemSignature}`,
    actor,
    trust: 'deterministic',
    content: JSON.stringify(payload),
    occurred_at: input.occurred_at,
  });
  return { episode_id: String(episode.id), scope_id: scopeId, ...payload, occurred_at: episode.occurred_at };
}

function parseObservation(episode: EpisodeRecord): OperationalObservationRecord | undefined {
  if (!episode.source_ref.startsWith(PREFIX)) return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(episode.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const signature = typeof payload.problem_signature === 'string' ? payload.problem_signature : '';
  const outcome = payload.outcome as OperationalOutcome;
  if (!SIGNATURE.test(signature) || !OUTCOMES.has(outcome)) return undefined;
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((item): item is string => typeof item === 'string') : [];
  const evidenceRefs = Array.isArray(payload.evidence_refs)
    ? payload.evidence_refs.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    episode_id: String(episode.id),
    scope_id: episode.scope_id,
    problem_signature: signature,
    symptom: String(payload.symptom ?? ''),
    scopes,
    actor: String(payload.actor ?? episode.actor),
    ...(typeof payload.workflow_id === 'string' ? { workflow_id: payload.workflow_id } : {}),
    ...(typeof payload.capability_id === 'string' ? { capability_id: payload.capability_id } : {}),
    ...(typeof payload.solution_ref === 'string' ? { solution_ref: payload.solution_ref } : {}),
    outcome,
    evidence_refs: evidenceRefs,
    occurred_at: episode.occurred_at,
  };
}

export async function queryOperationalObservations(
  db: Surreal,
  scopeId: string,
  options: QueryOperationalObservationsOptions = {},
): Promise<OperationalObservationRecord[]> {
  const scope = requiredText(scopeId, 'scope_id', 512);
  const signature = options.problemSignature === undefined ? undefined : validateSignature(options.problemSignature);
  const fetchLimit = Math.max(boundedLimit(options.limit), 50);
  const where = ["scope_id = $scope", "source = 'tool'"];
  const bindings: Record<string, unknown> = { scope, limit: Math.min(500, fetchLimit * 5) };
  if (signature !== undefined) {
    where.push('source_ref = $sourceRef');
    bindings.sourceRef = `${PREFIX}${signature}`;
  }
  const rows = await queryResult<EpisodeRecord[]>(
    db,
    `SELECT *, type::string(id) AS id FROM episode
     WHERE ${where.join(' AND ')}
     ORDER BY occurred_at DESC LIMIT $limit`,
    bindings,
  );
  const active = options.activeScopes === undefined ? undefined : new Set(uniqueStrings(options.activeScopes, 'activeScopes'));
  return rows
    .map(parseObservation)
    .filter((row): row is OperationalObservationRecord => Boolean(row))
    .filter((row) => signature === undefined || row.problem_signature === signature)
    .filter((row) => active === undefined || row.scopes.every((scopeTag) => active.has(scopeTag)))
    .slice(0, boundedLimit(options.limit));
}


export async function queryOperationalSolutions(
  db: Surreal,
  scopeId: string,
  options: QueryOperationalObservationsOptions = {},
): Promise<OperationalObservationRecord[]> {
  const rows = await queryOperationalObservations(db, scopeId, options);
  return rows.filter((row) =>
    Boolean(row.solution_ref)
    && (row.outcome === 'succeeded' || row.outcome === 'workaround_succeeded'),
  );
}
