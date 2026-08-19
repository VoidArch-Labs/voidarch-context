// General context plane: entities, episodes, temporal facts + write policy.
// Runs against an embedded in-memory SurrealDB (mem://) — real schema, real queries.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Surreal } from "surrealdb";
import { connect, queryResult } from "../src/surreal.js";
import {
  MAX_EPISODE_BYTES,
  assertFact,
  queryFacts,
  queryEpisodes,
  recordEpisode,
  resolveEntity,
  searchEntities,
  setFactStatus,
  upsertEntity,
} from "../src/general.js";
import {
  assertPromotionAllowed,
  canTransition,
  classifyWrite,
} from "../src/write-policy.js";

const SCOPE = "test-scope";
let db: Surreal;

before(async () => {
  db = await connect({
    url: "mem://",
    namespace: "voidarch_test",
    database: "general_plane",
    repoId: "test",
    username: "",
    password: "",
    authScope: "root",
  });
});

after(async () => {
  await db.close();
});

// ---- write-policy (pure) ----

test("policy: deterministic non-sensitive auto-confirms", () => {
  const c = classifyWrite({ trust: "deterministic", predicate: "has_commit", sensitivity: "internal" });
  assert.equal(c.initialStatus, "confirmed");
  assert.equal(c.autoConfirm, true);
});

test("policy: external content never auto-confirms and flags injection risk", () => {
  const c = classifyWrite({ trust: "external_content", predicate: "works_at", sensitivity: "internal" });
  assert.equal(c.initialStatus, "candidate");
  assert.equal(c.autoConfirm, false);
  assert.equal(c.injectionRisk, true);
  assert.equal(c.requiresHumanReview, true);
});

test("policy: sensitive predicate needs human review even from the user", () => {
  const c = classifyWrite({ trust: "user_explicit", predicate: "prefers_dark_mode", sensitivity: "internal" });
  assert.equal(c.initialStatus, "proposed");
  assert.equal(c.requiresHumanReview, true);
});

test("policy: contradiction of confirmed fact forces review", () => {
  const c = classifyWrite({
    trust: "user_explicit",
    predicate: "works_at",
    sensitivity: "internal",
    contradictsConfirmed: true,
  });
  assert.equal(c.initialStatus, "proposed");
});

test("policy: terminal states have no exits; illegal promotion throws", () => {
  assert.equal(canTransition("superseded", "confirmed"), false);
  assert.equal(canTransition("invalidated", "confirmed"), false);
  assert.throws(() =>
    assertPromotionAllowed({ from: "proposed", to: "confirmed", requiresHumanReview: true, humanApproved: false }),
  );
});

// ---- entities ----

test("entity: upsert creates, second upsert merges aliases instead of duplicating", async () => {
  const a = await upsertEntity(db, {
    scope_id: SCOPE,
    entity_type: "person",
    name: "Ada Lovelace",
    aliases: ["Ada"],
  });
  const b = await upsertEntity(db, {
    scope_id: SCOPE,
    entity_type: "person",
    name: "ada lovelace",
    aliases: ["Countess of Lovelace"],
  });
  assert.equal(a.id, b.id);
  assert.ok(b.aliases.includes("ada"));
  assert.ok(b.aliases.includes("countess of lovelace"));
});

test("entity: resolve by alias and by fuzzy search", async () => {
  const byAlias = await resolveEntity(db, SCOPE, "Ada");
  assert.equal(byAlias?.name, "Ada Lovelace");
  const hits = await searchEntities(db, SCOPE, ["lovelace"]);
  assert.ok(hits.length >= 1);
});

test("entity: scoped — other scope cannot see it", async () => {
  const other = await resolveEntity(db, "other-scope", "Ada Lovelace");
  assert.equal(other, null);
});

test("entity: sensitivity only escalates and search enforces its ceiling", async () => {
  const escalated = await upsertEntity(db, {
    scope_id: SCOPE,
    entity_type: "person",
    name: "Ada Lovelace",
    sensitivity: "personal",
  });
  assert.equal(escalated.sensitivity, "personal");
  const internal = await searchEntities(db, SCOPE, ["lovelace"], 8, "internal");
  assert.equal(internal.length, 0);
  assert.equal(await resolveEntity(db, SCOPE, "Ada"), null);
  const personal = await searchEntities(db, SCOPE, ["lovelace"], 8, "personal");
  assert.equal(personal.length, 1);
  assert.equal(
    (await resolveEntity(db, SCOPE, "Ada", { maxSensitivity: "personal" }))?.id,
    escalated.id,
  );

  const attemptedDowngrade = await upsertEntity(db, {
    scope_id: SCOPE,
    entity_type: "person",
    name: "Ada Lovelace",
    sensitivity: "public",
  });
  assert.equal(attemptedDowngrade.sensitivity, "personal");
});

test("entity: rejects malformed runtime attributes", async () => {
  await assert.rejects(
    upsertEntity(db, {
      scope_id: SCOPE,
      entity_type: "person",
      name: "Malformed Entity",
      attrs: [] as never,
    }),
    /attrs must be a JSON object/,
  );
});

// ---- episodes ----

test("episode: immutable + deduped by content hash", async () => {
  const e1 = await recordEpisode(db, {
    scope_id: SCOPE,
    source: "conversation",
    source_ref: "session-1",
    actor: "user",
    trust: "user_explicit",
    content: "I moved the homeserver to the basement rack.",
  });
  const e2 = await recordEpisode(db, {
    scope_id: SCOPE,
    source: "conversation",
    source_ref: "session-2",
    actor: "user",
    trust: "user_explicit",
    content: "I moved the homeserver to the basement rack.",
  });
  assert.equal(e1.id, e2.id);
});

test("episode: rejects oversized content and invalid runtime enums", async () => {
  await assert.rejects(
    recordEpisode(db, {
      scope_id: SCOPE,
      source: "conversation",
      source_ref: "oversized",
      actor: "user",
      trust: "user_explicit",
      content: "x".repeat(MAX_EPISODE_BYTES + 1),
    }),
    /exceeds/,
  );
  await assert.rejects(
    recordEpisode(db, {
      scope_id: SCOPE,
      source: "invalid" as never,
      source_ref: "bad-source",
      actor: "user",
      trust: "user_explicit",
      content: "bad source",
    }),
    /source/,
  );
});

test("episode: relevant evidence can be queried without becoming a fact", async () => {
  const rows = await queryEpisodes(db, SCOPE, { terms: ["basement", "rack"] });
  assert.ok(rows.some((row) => row.content.includes("basement rack")));
  const facts = await queryFacts(db, SCOPE, { terms: ["basement", "rack"] });
  assert.equal(facts.length, 0);
});

test("schema: every ephemeral connection receives all migrations", async () => {
  const cfg = {
    url: "mem://",
    namespace: "voidarch_test",
    database: "ephemeral_reconnect",
    repoId: "test",
    username: "",
    password: "",
    authScope: "root" as const,
  };
  const first = await connect(cfg);
  await first.close();
  const second = await connect(cfg);
  const info = await queryResult<{ tables?: Record<string, unknown> }>(second, "INFO FOR DB");
  assert.ok(info.tables?.episode);
  assert.ok(info.tables?.fact);
  await second.close();
});

// ---- facts ----

test("fact: deterministic fact lands confirmed; identical re-assert is a re-observation", async () => {
  const r1 = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "default_branch",
    object_value: "main",
    statement: "repo voidarch default branch is main",
    trust: "deterministic",
    provenance: { method: "git-ingest", actor: "test" },
  });
  assert.equal(r1.fact.status, "confirmed");
  const r2 = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "default_branch",
    object_value: "main",
    statement: "repo voidarch default branch is main",
    trust: "deterministic",
    provenance: { method: "git-ingest", actor: "test" },
  });
  assert.equal(r2.reobserved, true);
  assert.equal(r2.fact.id, r1.fact.id);
});

test("fact: deterministic-over-deterministic contradiction auto-supersedes atomically", async () => {
  const r = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "default_branch",
    object_value: "trunk",
    statement: "repo voidarch default branch is trunk",
    trust: "deterministic",
    provenance: { method: "git-ingest", actor: "test" },
  });
  assert.equal(r.fact.status, "confirmed");
  assert.equal(r.superseded.length, 1);
  // Old fact preserved with valid_to, not deleted.
  const history = await queryFacts(db, SCOPE, {
    subjectRef: "repo:voidarch",
    predicate: "default_branch",
    statuses: ["superseded"],
  });
  assert.equal(history.length, 1);
  assert.ok(history[0].valid_to);
  assert.equal(history[0].superseded_by, `fact:${r.fact.id}`);
  // Point-in-time query before supersession sees the old value.
  const asOfBefore = history[0].valid_from;
  const then = await queryFacts(db, SCOPE, {
    subjectRef: "repo:voidarch",
    predicate: "default_branch",
    statuses: ["confirmed", "superseded"],
    asOf: asOfBefore,
  });
  assert.ok(then.some((f) => f.object_value === "main"));
});

test("fact: sensitive deterministic contradiction still requires human review", async () => {
  const first = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "api_key_owner",
    object_value: "ops",
    statement: "the API key owner is ops",
    trust: "deterministic",
    provenance: { method: "tool-record", actor: "test" },
  });
  assert.equal(first.fact.status, "candidate");
  await setFactStatus(db, String(first.fact.id), "confirmed", {
    actor: "owner",
    humanApproved: true,
  });

  const replacement = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "api_key_owner",
    object_value: "platform",
    statement: "the API key owner is platform",
    trust: "deterministic",
    provenance: { method: "tool-record", actor: "test" },
  });
  assert.equal(replacement.fact.status, "proposed");
  assert.equal(replacement.superseded.length, 0);
  assert.equal(replacement.contradicted.length, 1);
});

test("fact: agent inference contradicting confirmed fact does NOT overwrite — lands proposed", async () => {
  const r = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "default_branch",
    object_value: "develop",
    statement: "repo voidarch default branch is develop",
    trust: "agent_inference",
    provenance: { method: "llm-extraction", actor: "test-agent" },
  });
  assert.equal(r.fact.status, "proposed");
  assert.equal(r.contradicted.length, 1);
  // Confirmed view still shows trunk.
  const confirmed = await queryFacts(db, SCOPE, {
    subjectRef: "repo:voidarch",
    predicate: "default_branch",
  });
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].object_value, "trunk");
  // Human confirms the proposal → old one superseded in the same transaction.
  const promoted = await setFactStatus(db, String(r.fact.id), "confirmed", {
    actor: "owner",
    humanApproved: true,
  });
  assert.equal(promoted.status, "confirmed");
  const nowConfirmed = await queryFacts(db, SCOPE, {
    subjectRef: "repo:voidarch",
    predicate: "default_branch",
  });
  assert.equal(nowConfirmed.length, 1);
  assert.equal(nowConfirmed[0].object_value, "develop");
});

test("fact: promotion without human approval is rejected for review-gated facts", async () => {
  const r = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "entity:ada",
    predicate: "prefers_editor",
    object_value: "vim",
    statement: "Ada prefers vim",
    trust: "agent_inference",
    provenance: { method: "llm-extraction", actor: "test-agent" },
  });
  await assert.rejects(
    setFactStatus(db, String(r.fact.id), "confirmed", { actor: "test-agent", humanApproved: false }),
  );
});

test("fact: delayed review supersedes the value confirmed since proposal creation", async () => {
  const first = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "release_channel",
    object_value: "stable",
    statement: "the release channel is stable",
    trust: "deterministic",
    provenance: { method: "tool-record", actor: "test" },
  });
  assert.equal(first.fact.status, "confirmed");

  const proposalA = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "release_channel",
    object_value: "candidate-a",
    statement: "the release channel is candidate A",
    trust: "agent_inference",
    provenance: { method: "agent", actor: "test" },
  });
  const proposalB = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "release_channel",
    object_value: "candidate-b",
    statement: "the release channel is candidate B",
    trust: "agent_inference",
    provenance: { method: "agent", actor: "test" },
  });
  await setFactStatus(db, String(proposalA.fact.id), "confirmed", {
    actor: "owner",
    humanApproved: true,
  });
  await setFactStatus(db, String(proposalB.fact.id), "confirmed", {
    actor: "owner",
    humanApproved: true,
  });

  const confirmed = await queryFacts(db, SCOPE, {
    subjectRef: "repo:voidarch",
    predicate: "release_channel",
  });
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].object_value, "candidate-b");
});

test("fact: sensitivity ceiling filters personal facts by default", async () => {
  await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "entity:ada",
    predicate: "lives_in",
    object_value: "London",
    statement: "Ada lives in London",
    trust: "deterministic",
    sensitivity: "personal",
    provenance: { method: "tool-record", actor: "test" },
  });
  const internalOnly = await queryFacts(db, SCOPE, { subjectRef: "entity:ada", statuses: ["confirmed", "proposed", "candidate"] });
  assert.ok(!internalOnly.some((f) => f.predicate === "lives_in"));
  const withPersonal = await queryFacts(db, SCOPE, {
    subjectRef: "entity:ada",
    statuses: ["confirmed", "proposed", "candidate"],
    maxSensitivity: "personal",
  });
  assert.ok(withPersonal.some((f) => f.predicate === "lives_in"));
});

test("fact: full-text search over statements", async () => {
  const hits = await queryFacts(db, SCOPE, {
    terms: ["branch"],
    statuses: ["confirmed", "superseded", "proposed"],
    limit: 10,
  });
  assert.ok(hits.length >= 2);
});

test("fact: runtime inputs are validated and numeric bounds are clamped", async () => {
  const clamped = await assertFact(db, {
    scope_id: SCOPE,
    subject_ref: "repo:voidarch",
    predicate: "confidence_probe",
    object_value: "bounded",
    statement: "confidence probe is bounded",
    trust: "agent_inference",
    confidence: 42,
    provenance: { method: "test", actor: "test" },
  });
  assert.equal(clamped.fact.confidence, 1);

  await assert.rejects(
    assertFact(db, {
      scope_id: SCOPE,
      subject_ref: "repo:voidarch",
      predicate: "",
      object_value: "invalid",
      statement: "invalid empty predicate",
      trust: "agent_inference",
      provenance: { method: "test", actor: "test" },
    }),
    /predicate/,
  );

  await assert.rejects(
    setFactStatus(db, String(clamped.fact.id), "not-a-status" as never, {
      actor: "test",
    }),
    /invalid fact status/,
  );

  const rows = await queryFacts(db, SCOPE, { limit: Number.POSITIVE_INFINITY });
  assert.ok(Array.isArray(rows));
});
