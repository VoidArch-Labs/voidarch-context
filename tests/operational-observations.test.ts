import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Surreal } from 'surrealdb';
import { connect } from '../src/surreal.js';
import { queryOperationalObservations, queryOperationalSolutions, recordOperationalObservation } from '../src/operational.js';

let db: Surreal;
const SCOPE = 'ops-test';

before(async () => {
  db = await connect({
    url: 'mem://', namespace: 'voidarch_test', database: 'operational', repoId: SCOPE,
    username: '', password: '', authScope: 'root',
  });
});
after(async () => { await db.close(); });

test('operational observations are immutable structured episode evidence', async () => {
  const first = await recordOperationalObservation(db, {
    scope_id: SCOPE,
    problem_signature: 'static-careers-empty',
    symptom: 'Static careers extraction returned zero roles.',
    scopes: ['profile:scout', 'domain:jobs'],
    actor: 'scout',
    workflow_id: 'workflow.job-discovery',
    capability_id: 'web.static-extract',
    outcome: 'failed',
    evidence_refs: ['run:r1', 'tool:t7'],
  });
  const second = await recordOperationalObservation(db, {
    scope_id: SCOPE,
    problem_signature: 'static-careers-empty',
    symptom: 'Static careers extraction returned zero roles.',
    scopes: ['profile:scout', 'domain:jobs'],
    actor: 'scout',
    workflow_id: 'workflow.job-discovery',
    capability_id: 'web.static-extract',
    outcome: 'failed',
    evidence_refs: ['run:r1', 'tool:t7'],
  });
  assert.equal(first.episode_id, second.episode_id);
  const rows = await queryOperationalObservations(db, SCOPE, { problemSignature: 'static-careers-empty' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.evidence_refs, ['run:r1', 'tool:t7']);
  assert.equal(rows[0]?.outcome, 'failed');
});

test('scope retrieval returns system observations plus fully matching scoped observations', async () => {
  await recordOperationalObservation(db, {
    scope_id: SCOPE, problem_signature: 'render-required', symptom: 'Rendered DOM is required.',
    scopes: [], actor: 'system', outcome: 'succeeded', evidence_refs: ['run:system'],
  });
  await recordOperationalObservation(db, {
    scope_id: SCOPE, problem_signature: 'render-required', symptom: 'Scout confirmed browser rendering works.',
    scopes: ['profile:scout', 'domain:jobs'], actor: 'scout', outcome: 'workaround_succeeded', evidence_refs: ['run:scout'],
  });
  const general = await queryOperationalObservations(db, SCOPE, {
    problemSignature: 'render-required', activeScopes: ['profile:implementer'],
  });
  assert.deepEqual(general.map((row) => row.actor), ['system']);
  const scout = await queryOperationalObservations(db, SCOPE, {
    problemSignature: 'render-required', activeScopes: ['profile:scout', 'domain:jobs'],
  });
  assert.deepEqual(new Set(scout.map((row) => row.actor)), new Set(['system', 'scout']));
});


test('verified workaround observations expose reusable solution references', async () => {
  await recordOperationalObservation(db, {
    scope_id: SCOPE,
    problem_signature: 'static-careers-empty',
    symptom: 'Rendered browser extraction recovered jobs and validation passed.',
    scopes: ['profile:scout', 'domain:jobs'],
    actor: 'scout',
    workflow_id: 'workflow.job-discovery',
    capability_id: 'web.render-extract',
    outcome: 'workaround_succeeded',
    evidence_refs: ['verification:v9'],
    solution_ref: 'workflow://job-discovery/rendered-careers',
  });
  const solutions = await queryOperationalSolutions(db, SCOPE, {
    problemSignature: 'static-careers-empty',
    activeScopes: ['profile:scout', 'domain:jobs'],
  });
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0]?.solution_ref, 'workflow://job-discovery/rendered-careers');
  assert.deepEqual(solutions[0]?.evidence_refs, ['verification:v9']);
});


test('exact problem lookup is not displaced by newer unrelated tool episodes', async () => {
  await recordOperationalObservation(db, {
    scope_id: SCOPE,
    problem_signature: 'old-but-useful',
    symptom: 'Known workaround remains valid.',
    scopes: [],
    actor: 'system',
    outcome: 'workaround_succeeded',
    evidence_refs: ['verification:old'],
    solution_ref: 'workflow://known-good',
  });
  const { recordEpisode } = await import('../src/general.js');
  for (let index = 0; index < 275; index += 1) {
    await recordEpisode(db, {
      scope_id: SCOPE,
      source: 'tool',
      source_ref: `unrelated:${index}`,
      actor: 'noise',
      trust: 'deterministic',
      content: `unrelated tool event ${index}`,
    });
  }
  const rows = await queryOperationalSolutions(db, SCOPE, { problemSignature: 'old-but-useful' });
  assert.equal(rows[0]?.solution_ref, 'workflow://known-good');
});
