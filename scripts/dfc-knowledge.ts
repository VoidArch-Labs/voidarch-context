// voidarch-context knowledge — operational surface for the general context plane.
//
//   knowledge entity-upsert  --type person --name "Ada Lovelace" [--aliases Ada,Countess]
//   knowledge entity-search  --query "Ada" [--limit 8]
//   knowledge episode-add    --source conversation --source-ref session-1 --actor user
//                            --trust user_explicit --content "..."
//   knowledge episode-search [--query "..."] [--source conversation] [--trust user_explicit]
//   knowledge fact-assert    --subject entity:ada --predicate works_on --value "VoidArch"
//                            --statement "Ada works on VoidArch" --trust agent_inference
//                            --method llm-extraction --actor hermes
//   knowledge fact-list      [--status proposed,candidate] [--query "..."]
//   knowledge fact-review    --id fact:abc --status confirmed --actor owner --human-approved

import { readFileSync } from "node:fs";
import { parseArgs, positiveIntArg, repoRootFromArgs, type CliArgs } from "../src/cli.js";
import {
  assertFact,
  queryEpisodes,
  queryFacts,
  recordEpisode,
  searchEntities,
  setFactStatus,
  upsertEntity,
  type EpisodeSource,
} from "../src/general.js";
import { withDb } from "../src/surreal.js";
import type { FactStatus, Sensitivity, TrustLevel } from "../src/write-policy.js";

const SUBCOMMANDS = new Set([
  "entity-upsert",
  "entity-search",
  "episode-add",
  "episode-search",
  "fact-assert",
  "fact-list",
  "fact-review",
]);
const SOURCES = new Set<EpisodeSource>([
  "conversation", "tool", "git", "web", "email", "document", "manual",
]);
const TRUSTS = new Set<TrustLevel>([
  "deterministic", "user_explicit", "agent_inference", "external_content",
]);
const STATUSES = new Set<FactStatus>([
  "candidate", "proposed", "confirmed", "disputed", "superseded", "invalidated",
]);
const SENSITIVITIES = new Set<Sensitivity>(["public", "internal", "personal", "secret"]);
const COMMON_FLAGS = ["repo-root", "scope", "json"];
const ALLOWED_FLAGS: Record<string, Set<string>> = {
  "entity-upsert": new Set([...COMMON_FLAGS, "type", "name", "aliases", "attrs-json", "sensitivity"]),
  "entity-search": new Set([...COMMON_FLAGS, "query", "limit", "sensitivity"]),
  "episode-add": new Set([
    ...COMMON_FLAGS, "source", "source-ref", "actor", "trust", "content", "file", "occurred-at",
  ]),
  "episode-search": new Set([
    ...COMMON_FLAGS, "query", "source", "trust", "since", "until", "limit",
  ]),
  "fact-assert": new Set([
    ...COMMON_FLAGS, "subject", "predicate", "object-ref", "value", "value-json",
    "statement", "trust", "confidence", "sensitivity", "method", "actor",
    "episode-id", "observed-at", "valid-from",
  ]),
  "fact-list": new Set([
    ...COMMON_FLAGS, "subject", "predicate", "as-of", "status", "sensitivity", "query", "limit",
  ]),
  "fact-review": new Set([...COMMON_FLAGS, "id", "status", "actor", "human-approved"]),
};

function usage(message: string): never {
  console.error(message);
  console.error(
    "usage: voidarch-context knowledge <entity-upsert|entity-search|episode-add|episode-search|fact-assert|fact-list|fact-review> [flags]",
  );
  process.exit(2);
}

function showUsage(): void {
  console.log(
    "usage: voidarch-context knowledge <entity-upsert|entity-search|episode-add|episode-search|fact-assert|fact-list|fact-review> [flags]",
  );
}

function required(args: CliArgs, key: string): string {
  const value = (args[key] || "").trim();
  if (!value || value === "true") usage(`--${key} is required`);
  return value;
}

function oneOf<T extends string>(raw: string, values: Set<T>, flag: string): T {
  const value = raw.trim().toLowerCase() as T;
  if (!values.has(value)) usage(`--${flag} must be one of ${[...values].join("|")}`);
  return value;
}

function csv(raw: string | undefined): string[] {
  return (raw || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function parseJson(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    usage(`--${flag} must be valid JSON`);
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function validateFlags(subcommand: string, args: CliArgs): void {
  const allowed = ALLOWED_FLAGS[subcommand];
  const unknown = Object.keys(args).filter((key) => !allowed?.has(key));
  if (unknown.length) usage(`unknown flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
}

async function main(): Promise<void> {
  const [sub = "", ...rest] = process.argv.slice(2);
  if (sub === "help" || sub === "--help" || sub === "-h") {
    showUsage();
    return;
  }
  if (!SUBCOMMANDS.has(sub)) usage(`unknown subcommand "${sub}"`);
  const args = parseArgs(rest);
  validateFlags(sub, args);
  const repoRoot = repoRootFromArgs(args);

  await withDb(async (db, cfg) => {
    const scope = (args.scope || cfg.repoId).trim();

    if (sub === "entity-upsert") {
      print(await upsertEntity(db, {
        scope_id: scope,
        entity_type: required(args, "type"),
        name: required(args, "name"),
        aliases: csv(args.aliases),
        attrs: args["attrs-json"]
          ? parseJson(args["attrs-json"], "attrs-json") as Record<string, unknown>
          : undefined,
        sensitivity: args.sensitivity
          ? oneOf(args.sensitivity, SENSITIVITIES, "sensitivity")
          : undefined,
      }));
      return;
    }

    if (sub === "entity-search") {
      print(await searchEntities(
        db,
        scope,
        required(args, "query").split(/\s+/).filter(Boolean),
        positiveIntArg(args, "limit") ?? 8,
        args.sensitivity
          ? oneOf(args.sensitivity, SENSITIVITIES, "sensitivity")
          : "internal",
      ));
      return;
    }

    if (sub === "episode-add") {
      if (args.file && args.content !== undefined) {
        usage("episode-add accepts exactly one of --file or --content");
      }
      const content = args.file ? readFileSync(args.file, "utf8") : required(args, "content");
      print(await recordEpisode(db, {
        scope_id: scope,
        source: oneOf(required(args, "source"), SOURCES, "source"),
        source_ref: required(args, "source-ref"),
        actor: required(args, "actor"),
        trust: oneOf(required(args, "trust"), TRUSTS, "trust"),
        content,
        occurred_at: args["occurred-at"],
      }));
      return;
    }

    if (sub === "episode-search") {
      print(await queryEpisodes(db, scope, {
        source: args.source ? oneOf(args.source, SOURCES, "source") : undefined,
        trusts: args.trust ? csv(args.trust).map((value) => oneOf(value, TRUSTS, "trust")) : undefined,
        terms: args.query?.split(/\s+/).filter(Boolean),
        since: args.since,
        until: args.until,
        limit: positiveIntArg(args, "limit"),
      }));
      return;
    }

    if (sub === "fact-assert") {
      const hasRef = Boolean(args["object-ref"]);
      const hasJson = args["value-json"] !== undefined;
      const hasValue = args.value !== undefined;
      if ([hasRef, hasJson, hasValue].filter(Boolean).length !== 1) {
        usage("fact-assert needs exactly one of --object-ref, --value, or --value-json");
      }
      print(await assertFact(db, {
        scope_id: scope,
        subject_ref: required(args, "subject"),
        predicate: required(args, "predicate"),
        ...(hasRef ? { object_ref: required(args, "object-ref") } : {}),
        ...(hasJson ? { object_value: parseJson(String(args["value-json"]), "value-json") } : {}),
        ...(hasValue ? { object_value: args.value } : {}),
        statement: required(args, "statement"),
        trust: oneOf(required(args, "trust"), TRUSTS, "trust"),
        confidence: args.confidence === undefined ? undefined : Number(args.confidence),
        sensitivity: args.sensitivity
          ? oneOf(args.sensitivity, SENSITIVITIES, "sensitivity")
          : undefined,
        provenance: {
          episode_id: args["episode-id"],
          method: required(args, "method"),
          actor: required(args, "actor"),
        },
        observed_at: args["observed-at"],
        valid_from: args["valid-from"],
      }));
      return;
    }

    if (sub === "fact-list") {
      print(await queryFacts(db, scope, {
        subjectRef: args.subject,
        predicate: args.predicate,
        asOf: args["as-of"],
        statuses: args.status
          ? csv(args.status).map((value) => oneOf(value, STATUSES, "status"))
          : undefined,
        maxSensitivity: args.sensitivity
          ? oneOf(args.sensitivity, SENSITIVITIES, "sensitivity")
          : undefined,
        terms: args.query?.split(/\s+/).filter(Boolean),
        limit: positiveIntArg(args, "limit"),
      }));
      return;
    }

    print(await setFactStatus(
      db,
      required(args, "id"),
      oneOf(required(args, "status"), STATUSES, "status"),
      {
        actor: required(args, "actor"),
        humanApproved: args["human-approved"] === "true",
      },
    ));
  }, { repoRoot });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
