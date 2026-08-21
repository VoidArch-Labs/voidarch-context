import { parseArgs, positiveIntArg, repoRootFromArgs } from '../src/cli.js';
import { withDb } from '../src/surreal.js';
import {
  queryOperationalObservations,
  queryOperationalSolutions,
  recordOperationalObservation,
  type OperationalOutcome,
} from '../src/operational.js';

const SUBCOMMANDS = new Set(['observe', 'search', 'solutions']);

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: voidarch-context operational <observe|search|solutions> [flags]');
  process.exit(2);
}

function required(value: string | undefined, flag: string): string {
  const normalized = (value ?? '').trim();
  if (!normalized || normalized === 'true') usage(`--${flag} is required`);
  return normalized;
}

function commaList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === 'true') return undefined;
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

async function main(): Promise<void> {
  const [subcommand = '', ...rest] = process.argv.slice(2);
  if (!SUBCOMMANDS.has(subcommand)) usage(`unknown operational subcommand: ${subcommand}`);
  const args = parseArgs(rest);
  const repoRoot = repoRootFromArgs(args);

  await withDb(async (db, cfg) => {
    if (subcommand === 'observe') {
      const observation = await recordOperationalObservation(db, {
        scope_id: cfg.repoId,
        problem_signature: required(args.problem, 'problem'),
        symptom: required(args.symptom, 'symptom'),
        scopes: commaList(args.scopes),
        actor: required(args.actor, 'actor'),
        workflow_id: args.workflow && args.workflow !== 'true' ? args.workflow : undefined,
        capability_id: args.capability && args.capability !== 'true' ? args.capability : undefined,
        outcome: required(args.outcome, 'outcome') as OperationalOutcome,
        evidence_refs: commaList(args.evidence),
        solution_ref: args['solution-ref'] && args['solution-ref'] !== 'true' ? args['solution-ref'] : undefined,
      });
      console.log(JSON.stringify(observation, null, 2));
      return;
    }

    const options = {
      problemSignature: args.problem && args.problem !== 'true' ? args.problem : undefined,
      activeScopes: commaList(args.scopes),
      limit: positiveIntArg(args, 'limit'),
    };
    const rows = subcommand === 'solutions'
      ? await queryOperationalSolutions(db, cfg.repoId, options)
      : await queryOperationalObservations(db, cfg.repoId, options);
    console.log(JSON.stringify(rows, null, 2));
  }, { repoRoot });
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
