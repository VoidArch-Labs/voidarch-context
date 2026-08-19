// Context compiler: general-plane channel, trust filtering (candidates excluded
// by default), token-budget enforcement, and delegation packs. mem:// SurrealDB.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Surreal } from "surrealdb";
import { connect } from "../src/surreal.js";
import { buildContextPack } from "../src/context-pack.js";
import {
  buildDelegationPack,
  formatDelegationPackText,
} from "../src/delegation.js";
import {
  assertFact,
  recordEpisode,
  upsertEntity,
} from "../src/general.js";

const REPO = "test-repo";
let db: Surreal;

before(async () => {
  db = await connect({
    url: "mem://",
    namespace: "voidarch_test",
    database: "compiler",
    repoId: REPO,
    username: "",
    password: "",
    authScope: "root",
  });
  await upsertEntity(db, {
    scope_id: REPO,
    entity_type: "person",
    name: "Ada Lovelace",
    aliases: ["Ada"],
  });
  await assertFact(db, {
    scope_id: REPO,
    subject_ref: "entity:ada",
    predicate: "works_on",
    object_ref: "repo:test-repo",
    statement: "Ada Lovelace works on the analytics engine project",
    trust: "user_explicit",
    provenance: { method: "user-statement", actor: "owner" },
  });
  await assertFact(db, {
    scope_id: REPO,
    subject_ref: "entity:ada",
    predicate: "recommends",
    object_value: "surrealdb",
    statement: "Ada Lovelace recommends the analytics engine use surrealdb",
    trust: "external_content", // candidate — must NOT surface by default
    provenance: { method: "web-scrape", actor: "crawler" },
  });
  await recordEpisode(db, {
    scope_id: REPO,
    source: "conversation",
    source_ref: "hermes:session-1",
    actor: "user",
    trust: "user_explicit",
    content: "For the analytics engine, remember that the launch review happens on Friday.",
  });
});

after(async () => {
  await db.close();
});

test("compiler: general channel surfaces confirmed facts + entities, hides candidates", async () => {
  const pack = await buildContextPack(db, REPO, "plan the analytics engine work with Ada");
  assert.ok(pack.general_context.entities.some((e) => e.name === "Ada Lovelace"));
  const statements = pack.general_context.facts.map((f) => f.statement);
  assert.ok(statements.some((s) => s.includes("works on")));
  assert.ok(!statements.some((s) => s.includes("recommends")), "candidate fact leaked");
});

test("compiler: includeCandidates surfaces them, labelled with their status", async () => {
  const pack = await buildContextPack(db, REPO, "analytics engine recommends", {
    includeCandidates: true,
  });
  const candidate = pack.general_context.facts.find((f) => f.statement.includes("recommends"));
  assert.ok(candidate);
  assert.equal(candidate.status, "candidate");
});

test("compiler: episodes are labelled evidence and never promoted into facts", async () => {
  const pack = await buildContextPack(db, REPO, "analytics engine Friday launch review");
  const episode = pack.general_context.episodes.find((e) => e.content.includes("Friday"));
  assert.ok(episode);
  assert.equal(episode.trust, "user_explicit");
  assert.ok(!pack.general_context.facts.some((f) => f.statement.includes("Friday")));
});

test("compiler: token budget drops items instead of overflowing", async () => {
  const pack = await buildContextPack(db, REPO, "analytics engine Ada", { maxTokens: 30 });
  assert.ok(pack.token_budget.estimated_tokens <= 30 + 50); // header overhead only
  assert.ok(pack.token_budget.dropped_items.length > 0);
});

test("compiler: query plan diagnostics include the general channel", async () => {
  const pack = await buildContextPack(db, REPO, "who works on analytics");
  assert.ok(pack.query_plan?.channels.some((c) => c.channel === "general"));
});

test("delegation: pack carries objective, scope, confirmed facts, entities", async () => {
  const p = await buildDelegationPack(db, REPO, {
    objective: "add temporal filters to the analytics engine",
    acceptanceCriteria: ["typecheck clean", "tests pass"],
    writeScope: ["src/analytics/**"],
    verificationCommands: ["pnpm test"],
    branch: "feat/temporal",
  });
  assert.equal(p.repo.branch, "feat/temporal");
  assert.deepEqual(p.write_scope, ["src/analytics/**"]);
  assert.ok(p.facts.some((s) => s.includes("works on")));
  assert.ok(!p.facts.some((s) => s.includes("recommends")), "unconfirmed fact in delegation pack");
  const text = formatDelegationPackText(p);
  assert.match(text, /OBJECTIVE: add temporal filters/);
  assert.match(text, /WRITE SCOPE/);
  assert.match(text, /VERIFY WITH/);
});
