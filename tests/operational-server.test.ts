import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function waitForServer(base: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Context server exited with ${child.exitCode}`);
    try { if ((await fetch(`${base}/api/status`)).ok) return; } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Context server did not become healthy');
}
test('standalone Context server owns operational observation HTTP routes', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'voidarch-context-server-'));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(resolve('node_modules/.bin/tsx'), [
    'scripts/dfc-nox.ts', '--port', String(port), '--repo-root', process.cwd(),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: sandbox,
      DFC_SURREAL_URL: `surrealkv://${join(sandbox, 'db')}`,
      DFC_SURREAL_NS: 'voidarch_test',
      DFC_SURREAL_DB: 'operational_server',
      DFC_REPO_ID: 'server-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(base, child);
    const observed = await fetch(`${base}/api/operational/observe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        problem_signature: 'static-careers-empty', symptom: 'Rendered fallback recovered jobs.',
        scopes: ['profile:scout', 'domain:jobs'], actor: 'scout',
        outcome: 'workaround_succeeded', evidence_refs: ['verification:v9'],
        solution_ref: 'workflow://jobs/rendered', workflow_id: 'workflow.jobs-rendered',
      }),
    });
    assert.equal(observed.status, 200, await observed.text());
    const visible = await fetch(`${base}/api/operational/solutions?problem=static-careers-empty&scopes=profile%3Ascout%2Cdomain%3Ajobs`);
    assert.equal(visible.status, 200);
    const visibleRows = await visible.json() as { solutions: Array<{ solution_ref?: string }> };
    assert.deepEqual(visibleRows.solutions.map((row) => row.solution_ref), ['workflow://jobs/rendered']);

    const hidden = await fetch(`${base}/api/operational/solutions?problem=static-careers-empty&scopes=profile%3Aimplementer`);
    assert.equal(hidden.status, 200);
    const hiddenRows = await hidden.json() as { solutions: unknown[] };
    assert.deepEqual(hiddenRows.solutions, []);

    const observations = await fetch(`${base}/api/operational/observations?problem=static-careers-empty&scopes=profile%3Ascout%2Cdomain%3Ajobs`);
    assert.equal(observations.status, 200);
    const observationRows = await observations.json() as { observations: Array<{ problem_signature: string }> };
    assert.equal(observationRows.observations[0]?.problem_signature, 'static-careers-empty');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(sandbox, { recursive: true, force: true });
  }
});
