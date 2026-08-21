import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('operational CLI records and retrieves a scoped verified solution', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'voidarch-operational-cli-'));
  const env = {
    ...process.env,
    DFC_SURREAL_URL: `surrealkv://${join(sandbox, 'db')}`,
    DFC_SURREAL_NS: 'voidarch_test',
    DFC_SURREAL_DB: 'operational_cli',
    DFC_REPO_ID: 'ops-cli',
  };
  const tsx = resolve('node_modules/.bin/tsx');
  const script = resolve('scripts/dfc-operational.ts');
  await execFileAsync(tsx, [script, 'observe',
    '--problem', 'static-careers-empty',
    '--symptom', 'Rendered extraction recovered jobs.',
    '--scopes', 'profile:scout,domain:jobs',
    '--actor', 'scout',
    '--outcome', 'workaround_succeeded',
    '--evidence', 'verification:v9',
    '--solution-ref', 'workflow://job-discovery/rendered-careers',
  ], { env });
  const { stdout } = await execFileAsync(tsx, [script, 'solutions',
    '--problem', 'static-careers-empty',
    '--scopes', 'profile:scout,domain:jobs',
    '--json', 'true',
  ], { env });
  const rows = JSON.parse(stdout) as Array<{ solution_ref?: string; actor: string }>;
  assert.deepEqual(rows.map((row) => row.solution_ref), ['workflow://job-discovery/rendered-careers']);
  assert.equal(rows[0]?.actor, 'scout');
});
