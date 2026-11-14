import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { submissionSchema, type Completion, type Run, type Task } from '../shared/contracts';
import { Store } from '../core/store/store';
import { reportReadyRefusal, settleReportReady } from '../core/intake/report-ready';
import { proofResultRefusal, settleProofExecution } from '../core/intake/proof-settlement';
import { advanceOwner } from '../core/intake/result-application';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const laneDigest = 'sha256:' + 'd'.repeat(64);
const reportBrief = '---\ntitle: Report\nqueue:\n  complexity: low\n  lanes: [web-health]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite a report.\n';

function task(store: Store, changes: Partial<Task> = {}): Task {
  const created = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Proof and report', repoPath: '/repo',
    planningCommit: base, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'brief', base, undefined, undefined, 'example/repo');
  store.update(created.id, { branch: 'ns-task', lanes: ['web-health'], ...changes });
  return store.task(created.id);
}
/** The settlement facts: `update` merges resolution changes the way `Resolution.update` does. */
const factsFor = (store: Store) => ({
  store,
  update: (current: Task, changes: object, patch: Partial<Task> = {}, event?: string, detail?: string) =>
    store.update(current.id, { ...patch, resolution: { ...current.resolution, ...changes } } as Parameters<Store['update']>[1], event, detail),
}) as unknown as Parameters<typeof settleProofExecution>[0] & Parameters<typeof settleReportReady>[0];
const profile = { id: 'author', name: 'author', provider: 'test', model: 'author', notes: '', available: true, problem: '', supportedThinking: [] } as Task['profile'];

/**
 * `report_ready` is one gate read by both intake paths. The artifact must be the
 * latest exact version of a lane the task carries, under a brief that opted in.
 */
test('the report_ready gate names its own refusal and accepts one exact artifact', () => {
  const store = new Store(':memory:');
  try {
    const version = { version: 1, text: reportBrief, mediaType: 'text/markdown', reason: 'Initial brief', pinnedAt: new Date().toISOString(), digest: laneDigest };
    const artifact = { key: 'web-health', version: 1, digest: laneDigest };
    const lanes = { laneDocument: (key: string, at?: number) => (key === 'web-health' && (at === undefined ? 1 : at) === 1 ? artifact : null) } as Pick<Store, 'laneDocument'>;
    const ready = task(store, { briefVersions: [version], lanes: ['web-health'] });
    const input = (extra: Partial<Completion> = {}) => ({ eventId: 'e', taskId: ready.id, runId: 'r', status: 'report_ready', summary: 'Report written', artifact, ...extra }) as Completion;

    assert.equal(reportReadyRefusal(lanes, ready, input()), null);
    assert.match(reportReadyRefusal(lanes, { ...ready, briefVersions: [] }, input())!, /Nucleus-held brief/);
    assert.match(reportReadyRefusal(lanes, ready, input({ artifact: undefined }))!, /exact lane document artifact/);
    assert.match(reportReadyRefusal(lanes, ready, input({ artifact: { ...artifact, key: 'other-notes' } }))!, /report lane web-health/);
    assert.match(reportReadyRefusal(lanes, ready, input({ artifact: { ...artifact, version: 2 } }))!, /latest exact Nucleus lane document/);
    assert.match(reportReadyRefusal(lanes, ready, input({ artifact: { ...artifact, digest: 'd2' } }))!, /latest exact Nucleus lane document/);
    assert.match(reportReadyRefusal(lanes, { ...ready, lanes: [] }, input())!, /lane attached to this task/);
    const plainBrief = { ...version, text: reportBrief.replace('  reportOnly: true\n', '') };
    assert.match(reportReadyRefusal(lanes, { ...ready, briefVersions: [plainBrief] }, input())!, /queue.reportOnly: true/);
  } finally { store.close(); }
});

test('a report_ready turn settles once, from the current revision run only', () => {
  const store = new Store(':memory:');
  try {
    const taskRow = task(store, { phase: 'changes_requested', agentId: 'worker', workspaceId: 'workspace', profile });
    const run = { id: 'revision', taskId: taskRow.id, role: 'revision', head, agentId: 'worker', workspaceId: 'workspace',
      status: 'running', released: false, generation: 1 } as Run;
    store.putRun(run);
    store.update(taskRow.id, { resolution: { ...store.task(taskRow.id).resolution, currentRunId: run.id } });
    const facts = factsFor(store);
    const input = { eventId: 'e1', taskId: taskRow.id, runId: run.id, status: 'report_ready', summary: 'Report written',
      artifact: { key: 'web-health', version: 1, digest: laneDigest } } as Completion;
    assert.equal(settleReportReady(facts, store.task(taskRow.id), run, input), true);
    const settled = store.task(taskRow.id);
    assert.equal(settled.phase, 'report_ready');
    assert.equal(settled.completion?.eventId, 'e1');
    assert.equal(settled.resolution.currentRunId, null);
    // A second pass finds the applied-result fence and writes nothing.
    assert.equal(settleReportReady(facts, settled, run, input), false);
    assert.equal(store.eventsAll(taskRow.id).filter(event => event.kind === 'run_result_applied').length, 1);
  } finally { store.close(); }
});

/** One owner reads the executor proof shape, so every gate refuses the same reports. */
test('the proof-result shape is read once', () => {
  const binding = { selector: 'effigy test --plan' } as NonNullable<Run['proofExecution']>;
  const input = (extra: Partial<Completion> = {}) => ({ eventId: 'e', taskId: 't', runId: 'r', status: 'proof_executed', summary: 'ran', ...extra }) as Completion;
  assert.equal(proofResultRefusal(input({ proofResult: { selector: 'effigy test --plan' } as Completion['proofResult'] }), { role: 'executor', proofExecution: binding }), null);
  assert.equal(proofResultRefusal(input(), { role: 'executor', proofExecution: binding }), 'A proof execution result must carry proofResult for its declared selector');
  assert.equal(proofResultRefusal(input({ proofResult: { selector: 'other' } as Completion['proofResult'] }), { role: 'executor', proofExecution: binding }), "Proof execution result must name the run's declared selector");
  assert.equal(proofResultRefusal(input(), { role: 'executor', proofExecution: undefined }), 'Executor run is missing its bound proof subject');
  // A blocked executor report carries its conservative evidence, proofResult or not.
  assert.equal(proofResultRefusal({ ...input({ status: 'blocked' }), proofResult: undefined }, { role: 'executor', proofExecution: binding }), null);
  assert.equal(proofResultRefusal(input({ proofResult: { selector: 'x' } as Completion['proofResult'] }), { role: 'reviewer', proofExecution: binding }), 'proofResult is only accepted on a proof execution run');
});

/**
 * Proof settlement returns the task to the phase it was activated from, records
 * the receipt once, and never credits a pass for another role.
 */
test('one proof settlement records the receipt and returns the task', () => {
  const store = new Store(':memory:');
  try {
    const taskRow = task(store, { phase: 'reviewing', agentId: 'executor', workspaceId: 'workspace', profile });
    const run = { id: 'execution', taskId: taskRow.id, role: 'executor', head, agentId: 'executor', workspaceId: 'workspace', status: 'running', released: false, generation: 1,
      createdAt: new Date().toISOString(),
      proofExecution: { selector: 'effigy test --plan', authorizedBy: { role: 'project_owner', caller: 'owner', note: null }, operationId: 'op', returnPhase: 'reviewing', tree: 't1', inputs: [], prNumber: 7, briefVersion: null, briefDigest: null } } as unknown as Run;
    store.putRun(run);
    store.update(taskRow.id, { resolution: { ...store.task(taskRow.id).resolution, currentRunId: run.id } });
    const facts = factsFor(store);
    settleProofExecution(facts, { task: taskRow, run, completion: { eventId: 'p1', taskId: taskRow.id, runId: run.id, status: 'proof_executed', summary: 'ran the plan', proofResult: { selector: 'effigy test --plan', status: 'passed', exitCode: 0 } } as Completion,
      outcome: 'passed', evidence: 'ran the plan', selectorStart: 'started', selectorStartEvidence: 'ran the plan' });
    const settled = store.task(taskRow.id);
    assert.equal(settled.proofExecutions.length, 1);
    assert.equal(settled.proofExecutions[0].status, 'passed');
    assert.equal(settled.phase, 'reviewing', 'the activation phase returns; independent review is still required');
    assert.equal(settled.resolution.currentRunId, null);
    assert.equal(store.eventsAll(taskRow.id).filter(event => event.kind === 'run_result_applied').length, 1);
    // A later pass over the same settlement writes nothing.
    settleProofExecution(facts, { task: taskRow, run, completion: { eventId: 'p2', taskId: taskRow.id, runId: run.id, status: 'proof_executed', summary: 'again' } as Completion,
      outcome: 'passed', evidence: 'again', selectorStart: 'unknown' });
    assert.equal(store.task(taskRow.id).proofExecutions.length, 1);
  } finally { store.close(); }
});

test('one completed run advances through its role owner', () => {
  for (const [role, owner] of [['reviewer', 'reviewer'], ['revision', 'revision'], ['closeout', 'closeout'], ['recovery', 'closeout'],
    ['verification', 'retired_verification']] as const)
    assert.equal(advanceOwner({ role }), owner, role);
});
