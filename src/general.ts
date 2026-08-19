// General context plane engine: entities, immutable episodes, temporal facts.
// All writes route through the write-policy (write-policy.ts); nothing else may
// set a fact's lifecycle status. History is never deleted — supersession stamps
// valid_to and superseded_by inside one transaction.

import { createHash, randomUUID } from "node:crypto";
import type { Surreal } from "surrealdb";
import { ftSearchTerms, queryResult, queryResults } from "./surreal.js";
import {
  assertPromotionAllowed,
  classifyWrite,
  type FactStatus,
  type Sensitivity,
  type TrustLevel,
} from "./write-policy.js";

// ---- Types -------------------------------------------------------------------

export type EpisodeSource =
  | "conversation"
  | "tool"
  | "git"
  | "web"
  | "email"
  | "document"
  | "manual";

export const MAX_EPISODE_BYTES = 256 * 1024;
export const MAX_EPISODE_QUERY_LIMIT = 100;
export const MAX_FACT_QUERY_LIMIT = 200;

const EPISODE_SOURCES = new Set<EpisodeSource>([
  "conversation",
  "tool",
  "git",
  "web",
  "email",
  "document",
  "manual",
]);
const TRUST_LEVELS = new Set<TrustLevel>([
  "deterministic",
  "user_explicit",
  "agent_inference",
  "external_content",
]);
const FACT_STATUSES = new Set<FactStatus>([
  "candidate",
  "proposed",
  "confirmed",
  "disputed",
  "superseded",
  "invalidated",
]);
const SENSITIVITIES = new Set<Sensitivity>(["public", "internal", "personal", "secret"]);
const SENSITIVITY_ORDER: Sensitivity[] = ["public", "internal", "personal", "secret"];

export interface EpisodeRecord {
  id?: string;
  scope_id: string;
  source: EpisodeSource;
  source_ref: string; // e.g. session id, URL, commit sha, message id
  actor: string; // who/what produced it (user, agent name, tool name)
  trust: TrustLevel;
  content: string;
  content_hash: string;
  occurred_at: string; // ISO-8601
  ingested_at: string; // ISO-8601
}

export interface EntityRecord {
  id?: string;
  scope_id: string;
  entity_type: string; // person | organisation | project | ... | custom strings
  name: string;
  norm_name: string;
  aliases: string[];
  attrs: Record<string, unknown>;
  sensitivity: Sensitivity;
  status: "active" | "merged";
  merged_into?: string;
  search_text: string;
  created_at: string;
  updated_at: string;
}

export interface FactProvenance {
  episode_id?: string;
  method: string; // e.g. git-ingest | user-statement | llm-extraction | tool-record
  actor: string;
}

export interface FactRecord {
  id?: string;
  scope_id: string;
  subject_ref: string; // entity:<id> | repo:<id> | file:<repo>/<path> | symbol:<repo>/<key> | ...
  predicate: string;
  object_ref?: string;
  object_value?: unknown;
  statement: string; // human-readable form, FTS-indexed
  status: FactStatus;
  trust: TrustLevel;
  confidence: number; // 0..1
  sensitivity: Sensitivity;
  requires_human_review: boolean;
  injection_risk: boolean;
  provenance: FactProvenance;
  observed_at: string;
  valid_from: string;
  valid_to?: string;
  superseded_by?: string;
  contradicts: string[];
  fact_key: string; // sha256(scope|subject|predicate|object) — dedupe key
  policy_reason: string;
  created_at: string;
  updated_at: string;
}

// ---- Helpers -------------------------------------------------------------------

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const nowIso = (): string => new Date().toISOString();
const newId = (): string => randomUUID().replace(/-/g, "");

function requiredText(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalIso(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO-8601 timestamp`);
  return value;
}

function clampConfidence(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("confidence must be a finite number");
  return Math.min(1, Math.max(0, value));
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function validateTrust(value: TrustLevel): TrustLevel {
  if (!TRUST_LEVELS.has(value)) throw new Error(`invalid trust level: ${String(value)}`);
  return value;
}

function validateSensitivity(value: Sensitivity): Sensitivity {
  if (!SENSITIVITIES.has(value)) throw new Error(`invalid sensitivity: ${String(value)}`);
  return value;
}

function allowedSensitivities(ceiling: Sensitivity): Sensitivity[] {
  const validated = validateSensitivity(ceiling);
  return SENSITIVITY_ORDER.slice(0, SENSITIVITY_ORDER.indexOf(validated) + 1);
}

function validateFactStatus(value: FactStatus): FactStatus {
  if (!FACT_STATUSES.has(value)) throw new Error(`invalid fact status: ${String(value)}`);
  return value;
}

function optionalRecord(
  value: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function objectKeyPart(objectRef?: string, objectValue?: unknown): string {
  return objectRef ?? JSON.stringify(objectValue ?? null);
}

export function factKey(scope: string, subject: string, predicate: string, objectRef?: string, objectValue?: unknown): string {
  return sha256(`${scope}|${subject}|${predicate}|${objectKeyPart(objectRef, objectValue)}`);
}

/** Stringify a SurrealDB RecordId (or passthrough) into "table:key" form without ⟨⟩. */
export function refOf(id: unknown): string {
  const s = String(id);
  return s.replace(/[⟨⟩`]/g, "");
}

/** Bare record key ("entity:abc" → "abc"); engine APIs traffic in bare keys. */
export function bareId(id: unknown): string {
  return refOf(id).replace(/^[a-z_]+:/, "");
}

function normalizeRow<T extends { id?: unknown }>(row: T): T {
  return { ...row, id: bareId(row.id) };
}

// ---- Episodes (immutable) ------------------------------------------------------

export async function recordEpisode(
  db: Surreal,
  input: Omit<EpisodeRecord, "id" | "content_hash" | "ingested_at" | "occurred_at"> & { occurred_at?: string },
): Promise<EpisodeRecord> {
  const scope_id = requiredText(input.scope_id, "scope_id", 512);
  const source_ref = requiredText(input.source_ref, "source_ref", 2048);
  const actor = requiredText(input.actor, "actor", 256);
  if (!EPISODE_SOURCES.has(input.source)) {
    throw new Error(`invalid episode source: ${String(input.source)}`);
  }
  const trust = validateTrust(input.trust);
  if (typeof input.content !== "string" || !input.content.trim()) {
    throw new Error("content is required");
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_EPISODE_BYTES) {
    throw new Error(`episode content exceeds ${MAX_EPISODE_BYTES} bytes`);
  }
  const occurred_at = optionalIso(input.occurred_at, "occurred_at");
  const content_hash = sha256(input.content);
  const existing = await queryResult<EpisodeRecord[]>(
    db,
    `SELECT *, type::string(id) AS id FROM episode WHERE scope_id = $scope AND content_hash = $hash LIMIT 1`,
    { scope: scope_id, hash: content_hash },
  );
  if (existing.length) return normalizeRow(existing[0]);
  const now = nowIso();
  const row: EpisodeRecord = {
    scope_id,
    source: input.source,
    source_ref,
    actor,
    trust,
    content: input.content,
    content_hash,
    occurred_at: occurred_at || now,
    ingested_at: now,
  };
  const id = newId();
  await queryResults(db, `CREATE type::record('episode', $id) CONTENT $row`, { id, row });
  return { ...row, id };
}

export interface QueryEpisodesOptions {
  source?: EpisodeSource;
  trusts?: TrustLevel[];
  terms?: string[];
  since?: string;
  until?: string;
  limit?: number;
}

/** Search immutable evidence. Callers must keep these rows visibly separate
 * from authoritative facts; trust/source metadata is always returned. */
export async function queryEpisodes(
  db: Surreal,
  scopeId: string,
  opts: QueryEpisodesOptions = {},
): Promise<EpisodeRecord[]> {
  const scope = requiredText(scopeId, "scope_id", 512);
  const limit = boundedLimit(opts.limit, 20, MAX_EPISODE_QUERY_LIMIT);
  const trusts = opts.trusts?.length ? opts.trusts.map(validateTrust) : [...TRUST_LEVELS];
  const where = ["scope_id = $scope", "trust IN $trusts"];
  const bindings: Record<string, unknown> = { scope, trusts };
  if (opts.source) {
    if (!EPISODE_SOURCES.has(opts.source)) throw new Error(`invalid episode source: ${String(opts.source)}`);
    where.push("source = $source");
    bindings.source = opts.source;
  }
  if (opts.since) {
    where.push("occurred_at >= $since");
    bindings.since = optionalIso(opts.since, "since");
  }
  if (opts.until) {
    where.push("occurred_at <= $until");
    bindings.until = optionalIso(opts.until, "until");
  }
  let rows: EpisodeRecord[];
  if (opts.terms?.length) {
    rows = await ftSearchTerms<EpisodeRecord & { ftScore?: number }>(
      db,
      `SELECT *, type::string(id) AS id, search::score(0) AS ftScore FROM episode
       WHERE ${where.join(" AND ")} AND content @0@ $q
       ORDER BY ftScore DESC LIMIT ${limit}`,
      bindings,
      opts.terms,
      (row) => String(row.id),
    );
  } else {
    rows = await queryResult<EpisodeRecord[]>(
      db,
      `SELECT *, type::string(id) AS id FROM episode
       WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC LIMIT ${limit}`,
      bindings,
    );
  }
  return rows.slice(0, limit).map(normalizeRow);
}

// ---- Entities --------------------------------------------------------------------

export interface UpsertEntityInput {
  scope_id: string;
  entity_type: string;
  name: string;
  aliases?: string[];
  attrs?: Record<string, unknown>;
  sensitivity?: Sensitivity;
}

/** Find by normalized name or alias within scope; merge aliases/attrs or create. */
export async function upsertEntity(db: Surreal, input: UpsertEntityInput): Promise<EntityRecord> {
  const scope_id = requiredText(input.scope_id, "scope_id", 512);
  const entity_type = requiredText(input.entity_type, "entity_type", 128);
  const name = requiredText(input.name, "name", 512);
  const sensitivity = validateSensitivity(input.sensitivity || "internal");
  if (input.aliases !== undefined && !Array.isArray(input.aliases)) {
    throw new Error("aliases must be an array");
  }
  const inputAliases = (input.aliases || []).map((alias) => requiredText(alias, "alias", 512));
  const inputAttrs = optionalRecord(input.attrs, "attrs");
  const norm = normalizeName(name);
  const found = await resolveEntity(db, scope_id, name, {
    exactOnly: true,
    maxSensitivity: "secret",
  });
  const now = nowIso();
  if (found) {
    const aliases = Array.from(
      new Set([...(found.aliases || []), ...inputAliases.map(normalizeName)]),
    ).filter((a) => a && a !== found.norm_name);
    const attrs = { ...(found.attrs || {}), ...inputAttrs };
    const currentSensitivity = validateSensitivity(found.sensitivity || "internal");
    const mergedSensitivity =
      SENSITIVITY_ORDER.indexOf(sensitivity) > SENSITIVITY_ORDER.indexOf(currentSensitivity)
        ? sensitivity
        : currentSensitivity;
    const search_text = [found.name, ...aliases, entity_type].join(" ");
    await queryResults(
      db,
      `UPDATE type::record('entity', $id) MERGE {
         aliases: $aliases, attrs: $attrs, sensitivity: $sensitivity,
         search_text: $search, updated_at: $now
       }`,
      { id: found.id, aliases, attrs, sensitivity: mergedSensitivity, search: search_text, now },
    );
    return {
      ...found,
      aliases,
      attrs,
      sensitivity: mergedSensitivity,
      search_text,
      updated_at: now,
    };
  }
  const aliases = inputAliases.map(normalizeName).filter((a) => a && a !== norm);
  const row: EntityRecord = {
    scope_id,
    entity_type,
    name,
    norm_name: norm,
    aliases,
    attrs: inputAttrs,
    sensitivity,
    status: "active",
    search_text: [name, ...aliases, entity_type].join(" "),
    created_at: now,
    updated_at: now,
  };
  const id = newId();
  await queryResults(db, `CREATE type::record('entity', $id) CONTENT $row`, { id, row });
  return { ...row, id };
}

/** Exact norm-name → alias → (optionally) FTS fallback, scoped. */
export async function resolveEntity(
  db: Surreal,
  scopeId: string,
  name: string,
  opts: { exactOnly?: boolean; maxSensitivity?: Sensitivity } = {},
): Promise<EntityRecord | null> {
  const scope = requiredText(scopeId, "scope_id", 512);
  const norm = normalizeName(requiredText(name, "name", 512));
  const sensitivities = allowedSensitivities(opts.maxSensitivity ?? "internal");
  const exact = await queryResult<EntityRecord[]>(
    db,
    `SELECT *, type::string(id) AS id FROM entity
     WHERE scope_id = $scope AND status = 'active' AND sensitivity IN $sensitivities
       AND (norm_name = $norm OR aliases CONTAINS $norm)
     LIMIT 1`,
    { scope, norm, sensitivities },
  );
  if (exact.length) return normalizeRow(exact[0]);
  if (opts.exactOnly) return null;
  const fts = await ftSearchTerms<EntityRecord & { ftScore?: number }>(
    db,
    `SELECT *, type::string(id) AS id, search::score(0) AS ftScore FROM entity
     WHERE scope_id = $scope AND status = 'active'
       AND sensitivity IN $sensitivities AND search_text @0@ $q
     ORDER BY ftScore DESC LIMIT 3`,
    { scope, sensitivities },
    norm.split(" ").filter(Boolean),
    (r) => String(r.id),
  );
  return fts[0] ? normalizeRow(fts[0]) : null;
}

export async function searchEntities(
  db: Surreal,
  scopeId: string,
  terms: string[],
  limit = 8,
  maxSensitivity: Sensitivity = "internal",
): Promise<EntityRecord[]> {
  const scope = requiredText(scopeId, "scope_id", 512);
  const bounded = boundedLimit(limit, 8, 100);
  const sensitivities = allowedSensitivities(maxSensitivity);
  const rows = await ftSearchTerms<EntityRecord & { ftScore?: number }>(
    db,
    `SELECT *, type::string(id) AS id, search::score(0) AS ftScore FROM entity
     WHERE scope_id = $scope AND status = 'active'
       AND sensitivity IN $sensitivities AND search_text @0@ $q
     ORDER BY ftScore DESC LIMIT ${bounded}`,
    { scope, sensitivities },
    terms,
    (r) => String(r.id),
  );
  return rows.slice(0, bounded).map(normalizeRow);
}

// ---- Facts -------------------------------------------------------------------------

export interface AssertFactInput {
  scope_id: string;
  subject_ref: string;
  predicate: string;
  object_ref?: string;
  object_value?: unknown;
  statement: string;
  trust: TrustLevel;
  confidence?: number;
  sensitivity?: Sensitivity;
  provenance: FactProvenance;
  observed_at?: string;
  valid_from?: string;
}

export interface AssertFactResult {
  fact: FactRecord;
  /** True when this call re-observed an existing identical fact. */
  reobserved: boolean;
  /** Confirmed facts (same subject+predicate, different object) this contradicts. */
  contradicted: FactRecord[];
  /** Confirmed facts auto-superseded (deterministic-over-deterministic only). */
  superseded: FactRecord[];
}

/**
 * Assert a fact under the write policy. Never deletes or silently overwrites:
 *  - identical fact (same key, live status) → refresh observed_at / max confidence.
 *  - contradiction of a confirmed fact → deterministic new over deterministic old
 *    auto-supersedes in one transaction; anything else lands as proposed with
 *    contradicts[] populated and BOTH facts kept.
 */
export async function assertFact(db: Surreal, input: AssertFactInput): Promise<AssertFactResult> {
  const scope_id = requiredText(input.scope_id, "scope_id", 512);
  const subject_ref = requiredText(input.subject_ref, "subject_ref", 2048);
  const predicate = requiredText(input.predicate, "predicate", 256);
  const statement = requiredText(input.statement, "statement", 64 * 1024);
  const trust = validateTrust(input.trust);
  const sensitivity = validateSensitivity(input.sensitivity || "internal");
  const method = requiredText(input.provenance?.method, "provenance.method", 256);
  const actor = requiredText(input.provenance?.actor, "provenance.actor", 256);
  if (input.object_ref !== undefined && input.object_value !== undefined) {
    throw new Error("provide only one of object_ref or object_value");
  }
  if (input.object_ref === undefined && input.object_value === undefined) {
    throw new Error("object_ref or object_value is required");
  }
  const object_ref = input.object_ref === undefined
    ? undefined
    : requiredText(input.object_ref, "object_ref", 2048);
  const observed_at = optionalIso(input.observed_at, "observed_at");
  const valid_from = optionalIso(input.valid_from, "valid_from");
  const now = nowIso();
  const key = factKey(scope_id, subject_ref, predicate, object_ref, input.object_value);

  const live = await queryResult<FactRecord[]>(
    db,
    `SELECT *, type::string(id) AS id FROM fact
     WHERE scope_id = $scope AND fact_key = $key
       AND status IN ['candidate', 'proposed', 'confirmed', 'disputed']
     LIMIT 1`,
    { scope: scope_id, key },
  );
  if (live.length) {
    const f = normalizeRow(live[0]);
    const confidence = Math.max(clampConfidence(f.confidence, 0), clampConfidence(input.confidence, 0.5));
    await queryResults(
      db,
      `UPDATE type::record('fact', $id) MERGE { observed_at: $now, confidence: $conf, updated_at: $now }`,
      { id: f.id, now, conf: confidence },
    );
    return { fact: { ...f, observed_at: now, confidence }, reobserved: true, contradicted: [], superseded: [] };
  }

  const conflictingRaw = await queryResult<FactRecord[]>(
    db,
    `SELECT *, type::string(id) AS id FROM fact
     WHERE scope_id = $scope AND subject_ref = $subject AND predicate = $predicate
       AND status = 'confirmed' AND fact_key != $key AND valid_to = NONE`,
    { scope: scope_id, subject: subject_ref, predicate, key },
  );
  const conflicting = conflictingRaw.map(normalizeRow);

  const baseClassification = classifyWrite({
    trust,
    predicate,
    sensitivity,
  });
  const classification = classifyWrite({
    trust,
    predicate,
    sensitivity,
    contradictsConfirmed: conflicting.length > 0,
  });

  // Deterministic truth replacing deterministic truth (branch moved, test re-ran)
  // is the one contradiction we resolve automatically — atomically.
  const autoSupersede =
    conflicting.length > 0 &&
    baseClassification.autoConfirm &&
    trust === "deterministic" &&
    conflicting.every((c) => c.trust === "deterministic");

  const id = newId();
  const row: FactRecord = {
    scope_id,
    subject_ref,
    predicate,
    object_ref,
    object_value: input.object_value,
    statement,
    status: autoSupersede ? "confirmed" : classification.initialStatus,
    trust,
    confidence: clampConfidence(input.confidence, classification.autoConfirm ? 0.95 : 0.5),
    sensitivity,
    requires_human_review: autoSupersede ? false : classification.requiresHumanReview,
    injection_risk: classification.injectionRisk,
    provenance: { episode_id: input.provenance.episode_id, method, actor },
    observed_at: observed_at || now,
    valid_from: valid_from || now,
    contradicts: autoSupersede ? [] : conflicting.map((c) => String(c.id)),
    fact_key: key,
    policy_reason: autoSupersede
      ? "deterministic supersession of deterministic prior value"
      : classification.reason,
    created_at: now,
    updated_at: now,
  };

  if (autoSupersede) {
    // One transaction: create the new fact and close out the old ones together.
    const closes = conflicting
      .map((_, i) => `UPDATE type::record('fact', $old${i}) MERGE { status: 'superseded', valid_to: $now, superseded_by: $newRef, updated_at: $now };`)
      .join("\n");
    const bindings: Record<string, unknown> = { id, row, now, newRef: `fact:${id}` };
    conflicting.forEach((c, i) => (bindings[`old${i}`] = c.id));
    await queryResults(
      db,
      `BEGIN TRANSACTION;\nCREATE type::record('fact', $id) CONTENT $row;\n${closes}\nCOMMIT TRANSACTION;`,
      bindings,
    );
    return { fact: { ...row, id }, reobserved: false, contradicted: [], superseded: conflicting };
  }

  await queryResults(db, `CREATE type::record('fact', $id) CONTENT $row`, { id, row });
  return { fact: { ...row, id }, reobserved: false, contradicted: conflicting, superseded: [] };
}

/**
 * Promote/resolve a fact's lifecycle. Confirming a fact that contradicts others
 * supersedes those others in the same transaction (valid_to stamped, kept forever).
 */
export async function setFactStatus(
  db: Surreal,
  factId: string,
  to: FactStatus,
  opts: { actor: string; humanApproved?: boolean },
): Promise<FactRecord> {
  const normalizedId = bareId(requiredText(factId, "factId", 512));
  const targetStatus = validateFactStatus(to);
  const actor = requiredText(opts.actor, "actor", 256);
  const rows = await queryResult<FactRecord[]>(
    db,
    `SELECT *, type::string(id) AS id FROM fact WHERE id = type::record('fact', $id) LIMIT 1`,
    { id: normalizedId },
  );
  const fact = rows[0] ? normalizeRow(rows[0]) : undefined;
  if (!fact) throw new Error(`fact ${normalizedId} not found`);
  assertPromotionAllowed({
    from: fact.status,
    to: targetStatus,
    requiresHumanReview: Boolean(fact.requires_human_review),
    humanApproved: Boolean(opts.humanApproved),
  });
  const now = nowIso();
  const statements: string[] = [
    `UPDATE type::record('fact', $id) MERGE { status: $to, updated_at: $now, reviewed_by: $actor };`,
  ];
  const bindings: Record<string, unknown> = { id: normalizedId, to: targetStatus, now, actor };
  if (targetStatus === "confirmed") {
    // Resolve against the CURRENT confirmed value, not only the contradictions
    // captured when this proposal was created. Another proposal may have been
    // reviewed in the meantime.
    statements.push(
      `UPDATE fact MERGE {
         status: 'superseded', valid_to: $now,
         superseded_by: $selfRef, updated_at: $now
       } WHERE scope_id = $scope AND subject_ref = $subject
         AND predicate = $predicate AND fact_key != $factKey
         AND status = 'confirmed' AND valid_to = NONE;`,
    );
    bindings.selfRef = `fact:${normalizedId}`;
    bindings.scope = fact.scope_id;
    bindings.subject = fact.subject_ref;
    bindings.predicate = fact.predicate;
    bindings.factKey = fact.fact_key;
  }
  if (targetStatus === "invalidated" || targetStatus === "superseded") {
    statements[0] = `UPDATE type::record('fact', $id) MERGE { status: $to, valid_to: $now, updated_at: $now, reviewed_by: $actor };`;
  }
  await queryResults(db, `BEGIN TRANSACTION;\n${statements.join("\n")}\nCOMMIT TRANSACTION;`, bindings);
  return { ...fact, status: targetStatus, updated_at: now };
}

export interface QueryFactsOptions {
  subjectRef?: string;
  predicate?: string;
  /** Point-in-time view: only facts valid at this ISO instant. */
  asOf?: string;
  /** Minimum lifecycle bar; default only confirmed facts. */
  statuses?: FactStatus[];
  /** Exclude anything above this sensitivity ceiling. */
  maxSensitivity?: Sensitivity;
  terms?: string[];
  limit?: number;
}

export function sensitivityAllowed(s: Sensitivity, ceiling: Sensitivity): boolean {
  return SENSITIVITY_ORDER.indexOf(s) <= SENSITIVITY_ORDER.indexOf(ceiling);
}

export async function queryFacts(
  db: Surreal,
  scopeId: string,
  opts: QueryFactsOptions = {},
): Promise<FactRecord[]> {
  const scope = requiredText(scopeId, "scope_id", 512);
  const statuses = opts.statuses ?? ["confirmed"];
  if (!statuses.length) throw new Error("statuses must not be empty");
  statuses.forEach(validateFactStatus);
  const limit = boundedLimit(opts.limit, 20, MAX_FACT_QUERY_LIMIT);
  const ceiling = validateSensitivity(opts.maxSensitivity ?? "internal");
  const sensitivities = allowedSensitivities(ceiling);
  const where: string[] = [
    "scope_id = $scope",
    "status IN $statuses",
    "sensitivity IN $sensitivities",
  ];
  const bindings: Record<string, unknown> = { scope, statuses, sensitivities };
  if (opts.subjectRef) {
    where.push("subject_ref = $subject");
    bindings.subject = opts.subjectRef;
  }
  if (opts.predicate) {
    where.push("predicate = $predicate");
    bindings.predicate = opts.predicate;
  }
  if (opts.asOf) {
    // ISO-8601 UTC strings compare lexically.
    where.push("valid_from <= $asOf AND (valid_to = NONE OR valid_to > $asOf)");
    bindings.asOf = optionalIso(opts.asOf, "asOf");
  }
  let rows: FactRecord[];
  if (opts.terms?.length) {
    rows = await ftSearchTerms<FactRecord & { ftScore?: number }>(
      db,
      `SELECT *, type::string(id) AS id, search::score(0) AS ftScore FROM fact
       WHERE ${where.join(" AND ")} AND statement @0@ $q
       ORDER BY ftScore DESC LIMIT ${limit * 2}`,
      bindings,
      opts.terms,
      (r) => String(r.id),
    );
  } else {
    rows = await queryResult<FactRecord[]>(
      db,
      `SELECT *, type::string(id) AS id FROM fact
       WHERE ${where.join(" AND ")} ORDER BY observed_at DESC LIMIT ${limit * 2}`,
      bindings,
    );
  }
  return rows.slice(0, limit);
}
