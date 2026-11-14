import { fakeAdapter } from './support/fakes';
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Engine } from '../core/engine';
import { Store, digest, legacySubmissionHash } from '../core/store/store';
import { Leads } from '../core/planning/leads';
import { Papercuts } from '../core/planning/papercut-operations';
import { briefDigest } from '../core/planning/brief';
import { runPrompt } from '../core/dispatch/prompts';
import { parseNorthstarDocument } from '../core/planning/handoff';
import { submissionQueueFields } from '../core/planning/handoff';
import { holdsOf, OPERATOR_BOARD_CALLER, proofExecutionRecordSchema, QUEUE_REPOSITORY_ORIGIN, runSchema, submissionSchema, taskControlInputSchema, taskSchema, type Completion, type PoolEntry, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { Task as ParameterTask } from '../shared/contracts';
import { docsOnlyProofAutorunSkip, proofAutorunWaitingInputs, proofWaitApplies, RESPONSIBLE_QUESTION_WAIT, type ResolutionAdapter } from '../core/resolution';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { operatorQuestionFor, preserveRecordedOperatorQuestion, type OperatorQuestion } from '../core/questions/operator-question';
import { Decisions } from '../core/planning/decisions';
import { EMPTY_RUN_USAGE } from '../core/telemetry/run-usage';
import { base, fixture, head, profile, tick } from './support/responsible-lifecycle-fixture';

/**
 * Spec 058 slice 2: every task runs the responsible lifecycle. Its worker
 * owns it end to end, one retained reviewer works with it directly, mechanical
 * faults are settled by code and the third non-converging round asks the
 * operator one joint native question. The legacy marker remains readable on
 * historical task rows.
 *
 * These scenarios use the ordinary lifecycle: the real reviewer and revision
 * dispatch, the authenticated callbacks, the recorded review evidence and the
 * ordinary recovery route. Nothing releases a run by hand or approves a verdict.
 */


test('queue.responsible is absent by default and explicit false is refused', () => {
  const explicit = parseNorthstarDocument('---\ntitle: Responsible\nqueue_approval: "Approved (Tom, 2026-11-02)"\nqueue:\n  responsible: true\n---\n\nBody\n', 'brief');
  assert.equal(submissionQueueFields(explicit.queue).responsible, true);
  const ordinary = parseNorthstarDocument('---\ntitle: Ordinary\nqueue_approval: "Approved (Tom, 2026-11-02)"\n---\n\nBody\n', 'brief');
  assert.equal(submissionQueueFields(ordinary.queue).responsible, undefined);
  assert.throws(() => parseNorthstarDocument('---\ntitle: Opted out\nqueue_approval: "Approved (Tom, 2026-11-02)"\nqueue:\n  responsible: false\n---\n\nBody\n', 'brief'), /responsible: false is no longer supported/);
  assert.throws(() => parseNorthstarDocument('---\ntitle: Wrong\nqueue_approval: "Approved"\nqueue:\n  responsible: "yes"\n---\n\nBody\n', 'brief'), /responsible/);
});

test('a new task without the flag is responsible; manual verification cannot select the old lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-responsible-default-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const submit = (extra: Record<string, unknown>, manualVerification = false) => store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Default lifecycle', repoPath: join(dir, 'repo'), planningCommit: base,
      brief: { text: 'Default lifecycle brief\n' }, originAgentId: 'origin', manualVerification, ...extra,
    }), 'host', 'brief', base);
    assert.equal(submit({}).responsible, true, 'absent queue.responsible means true');
    assert.equal(submit({ responsible: true }).responsible, true);
    assert.throws(() => submit({}, true), /manualVerification/);
    assert.throws(() => submit({ responsible: true }, true), /manualVerification/,
      'explicit true plus manualVerification is still refused');
    // A replay of the same submission reconciles the same task.
    const input = submissionSchema.parse({ submissionId: randomUUID(), title: 'Replayed', repoPath: join(dir, 'repo'),
      planningCommit: base, brief: { text: 'Replayed brief\n' }, originAgentId: 'origin' });
    const first = store.insert(input, 'host', 'brief', base);
    assert.equal(first.responsible, true);
    assert.equal(store.insert(input, 'host', 'brief', base).id, first.id, 'the same submission replays to its task');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('historical task rows with responsible false still parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-responsible-legacy-row-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const created = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Historical row', repoPath: join(dir, 'repo'), planningCommit: base, brief: { text: 'Old brief\n' }, originAgentId: 'origin' }), 'host', 'brief', base);
    assert.equal(taskSchema.parse({ ...created, responsible: false }).responsible, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a replay of a pre-rollout submission without the flag still reconciles its task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-responsible-legacy-replay-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const input = submissionSchema.parse({ submissionId: randomUUID(), title: 'Pre-rollout', repoPath: join(dir, 'repo'),
      planningCommit: base, brief: { text: 'Pre-rollout brief\n' }, originAgentId: 'origin' });
    const task = store.insert(input, 'host', 'brief', base);
    // Rewrite the row the way it was stored before responsible became the
    // default: the digest with the flag omitted.
    store.db.prepare('UPDATE tasks SET input_hash=? WHERE id=?').run(legacySubmissionHash(input), task.id);
    assert.equal(store.existing(input)?.id, task.id, 'the same submission replays to its pre-rollout task');
    assert.throws(() => store.existing({ ...input, title: 'Changed' }), /different content/,
      'changed content still refuses on a pre-rollout row');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a lead promotion and a papercut promotion without the flag each create a responsible task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-responsible-promote-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const origin = 'example/promotion-default';
    const repositories = [{ origin, path: join(dir, 'repo') }];
    // Lead promotion: the brief carries no responsible flag.
    const body = '---\ntitle: Promoted lead\nqueue:\n  scope: mechanical\n---\n\nPromoted lead body.\n';
    const added = new Leads(store).add({ repositories, title: 'Promoted lead', body, lanes: [], author: 'planner' });
    const stamp = new Date().toISOString();
    store.recordLeadCheck(added.id, added.version, { ok: true, message: 'Ready', checkedAt: stamp, planningCommit: base, baseBranch: 'main' });
    store.updateLead({ ...store.lead(added.id), approval: { version: added.version, digest: briefDigest(body),
      approver: 'operator (board)', approvedAt: stamp, note: '', relayed: false, baseBranch: 'main', planningCommit: base } });
    const lead = store.lead(added.id);
    const leadSubmission = submissionSchema.parse({ submissionId: randomUUID(), title: 'Promoted lead', repoPath: repositories[0].path,
      baseBranch: 'main', planningCommit: base, brief: { text: body, mediaType: 'text/markdown' }, originAgentId: 'origin',
      leadProvenance: { version: lead.version, approval: lead.approval, earlierDigests: [] },
      planningSource: { kind: 'lead', id: lead.id } });
    const promotedLead = store.promoteSource({ kind: 'lead', id: lead.id }, origin, briefDigest(body),
      digest(JSON.stringify(lead)), leadSubmission, 'host', base, origin);
    assert.equal(store.task('id' in promotedLead ? promotedLead.id : promotedLead.taskId!).responsible, true,
      'a lead promotion without the flag is responsible');
    // Papercut promotion: the generated brief carries no responsible flag.
    const cut = new Papercuts(store).add({ repository: repositories[0],
      title: 'Promoted papercut', happened: 'The worker stalled', impact: 'Work waited', filedBy: 'operator' });
    const cutBrief = store.lead(cut.id).body;
    const cutSubmission = submissionSchema.parse({ submissionId: randomUUID(), title: cut.title, repoPath: repositories[0].path,
      baseBranch: 'main', planningCommit: base, brief: { text: cutBrief, mediaType: 'text/markdown' }, originAgentId: 'origin',
      planningSource: { kind: 'papercut', id: cut.id } });
    const promotedCut = store.promoteSource({ kind: 'papercut', id: cut.id }, origin, briefDigest(cutBrief),
      digest(JSON.stringify(store.papercut(cut.id))), cutSubmission, 'host', base, origin);
    assert.equal(store.task('id' in promotedCut ? promotedCut.id : promotedCut.taskId!).responsible, true,
      'a papercut promotion without the flag is responsible');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a responsible task asks the planner one joint question at three non-converging rounds without upgrading the author', async () => {
  const f = fixture({ responsible: true });
  try {
    await f.reviews(3);
    await f.settle(2);
    assert.equal(f.current().responsible, true);
    assert.equal(f.sends.filter(item => item.role === 'revision').length, 2, 'only the two returned revisions ran before the question');
    assert.equal(f.asks.length, 1, 'exactly one joint native question');
    const asked = f.asks[0]!;
    assert.match(asked.question, /Three review rounds have not converged/);
    // The reviewer's complete authenticated finding (reviewText), not its summary
    // and not an excerpt.
    const fullFinding = f.finding('changes_required');
    assert.ok(fullFinding.length > 1800, 'the fixture finding exceeds the old excerpt bound');
    assert.ok(asked.question.includes(fullFinding), 'the complete authenticated reviewer finding travels in the question');
    assert.doesNotMatch(asked.question, /The reviewer's authenticated findings: reviewer reported changes_required/, 'the summary does not replace the finding');
    assert.match(asked.question, /revision reported ready_for_review/, 'the worker returns are stated');
    assert.match(asked.question, new RegExp(head), 'the reviewed exact head is named');
    assert.deepEqual(asked.options, ['Continue the current approach', 'Change the approach', 'Stop and keep the work']);
    assert.equal(f.events('responsible_question').length, 1);
    assert.equal(f.current().resolution.stop?.reason, 'responsible_question');
    assert.equal(f.current().reason, RESPONSIBLE_QUESTION_WAIT);
    // Waiting is not an incident and opens no coordinator.
    await f.settle(2);
    assert.equal(f.asks.length, 1, 'the question is never resent');
    assert.equal(f.coordinatorRuns().length, 0);
    assert.equal(f.current().resolution.stop?.reason, 'responsible_question');
    // The operator answers: the next round continues in the same worker thread.
    f.answer('Continue the current approach');
    await tick();
    assert.equal(f.events('responsible_question_answered').length, 1);
    await f.settle(2);
    assert.equal(f.sends.filter(item => item.role === 'revision').length, 3, 'the answered question releases the next revision');
    assert.equal(f.asks.length, 1);
    // The worker returns and the retained reviewer approves; mechanical gates
    // verify and merge with no coordinator, no verification run and no hold.
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.run().role, 'reviewer');
    await f.report('ready_to_merge');
    await f.settle(4);
    assert.equal(f.current().resolution.mechanicalVerification !== null, true, 'mechanical verification replaced a verification coordinator');
    assert.equal(f.mergeCalls, 1);
    assert.ok(f.current().resolution.mergeIntent);
    assert.equal(f.coordinatorRuns().length, 0, 'no coordinator run anywhere in the responsible lifecycle');
    assert.equal(holdsOf(f.current()).merge, undefined, 'no default merge hold');
  } finally { await f.close(); }
});

/** A current reviewer whose agent is positively closed, with no verdict. */
async function crashedReviewer(f: ReturnType<typeof fixture>) {
  await f.reviews(1);
  await f.engine.wake(); assert.equal(f.run().role, 'revision');
  await f.report('ready_for_review');
  await f.engine.wake(); assert.equal(f.run().role, 'reviewer');
  const crashed = f.run();
  f.idle(crashed.agentId!);
  f.states.set(crashed.agentId!, { ...f.states.get(crashed.agentId!)!, status: 'closed', active: false });
  f.store.putRun({ ...f.store.run(crashed.id)!, active: false, lastObservedAt: new Date().toISOString() });
  f.engine.resolution.attention(f.current(), 'The reviewer thread stopped without a callback; inspect the thread', 'missing_callback');
  return { run: crashed, count: f.reviewerRuns().length };
}

test('a responsible task restarts a crashed reviewer by code, once per head, without a coordinator', async () => {
  const f = fixture({ responsible: true });
  try {
    const crashed = await crashedReviewer(f);
    await f.settle(2);
    assert.equal(f.events('responsible_fault_restart').length, 1);
    assert.equal(f.coordinatorRuns().length, 0, 'the stopped reviewer was restarted by code, not a coordinator');
    assert.equal(f.reviewerRuns().length, crashed.count + 1, 'a fresh reviewer replaced the stopped one on the same task');
    assert.equal(f.current().resolution.attention, false);
    assert.equal(f.current().resolution.stop?.reason === 'responsible_question', false);
    // A repeated crash at the same head is a fault code cannot settle: one
    // retained recovery thread takes it instead of a restart loop.
    const replacement = f.reviewerRuns().at(-1)!;
    f.idle(replacement.agentId!);
    f.states.set(replacement.agentId!, { ...f.states.get(replacement.agentId!)!, status: 'closed', active: false });
    f.store.putRun({ ...f.store.run(replacement.id)!, active: false, lastObservedAt: new Date().toISOString() });
    f.engine.resolution.attention(f.current(), 'The reviewer thread stopped without a callback; inspect the thread', 'missing_callback');
    await f.settle(2);
    assert.equal(f.events('responsible_fault_restart').length, 1, 'no second mechanical restart at the same head');
    assert.equal(f.coordinatorRuns().length, 1, 'exactly one retained recovery thread');
    assert.equal(f.store.run(crashed.run.id)!.completion, null, 'a crash is never a verdict');
  } finally { await f.close(); }
});

test('an undelivered reviewer dispatch skips the reminder and takes the ordinary restart', async () => {
  const f = fixture({ responsible: true });
  try {
    await f.engine.wake(); assert.equal(f.run().role, 'reviewer');
    const stopped = f.run();
    // The pi provider's timeline carries no `ns-run-…` dispatch message id, so the
    // identity-bound refusal read can never settle (papercut fe93582a), and the
    // complete page without it proves the dispatch was never delivered. The
    // missing-callback reminder only fires on a positively delivered dispatch,
    // so the run skips it and takes the ordinary relaunch instead.
    f.idle(stopped.agentId!);
    f.store.putRun({ ...f.store.run(stopped.id)!, active: false, lastObservedAt: new Date().toISOString() });
    await f.settle(2);
    assert.equal(f.events('provider_refusal').length, 0, 'an unproven read is never a refusal');
    assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined, 'no subscription group is marked unavailable');
    const gaps = f.events('provider_refusal_unverified');
    assert.equal(gaps.length, 2, 'the read is spent once, then the ordinary path takes the run');
    assert.equal(gaps[0]!.detail, `${stopped.id}: the reviewer timeline does not contain the dispatch message ns-run-${stopped.id}`);
    assert.equal(f.events('callback_reminder').length, 0, 'no reminder without a delivered dispatch');
    assert.equal(f.events('callback_reminder_skipped').length, 1, 'the skipped reminder is recorded once');
    assert.notEqual(f.current().resolution.stop?.reason, 'provider_unavailable', 'no indefinite provider wait');
    await f.settle(6);
    assert.equal(f.events('callback_reminder').length, 0, 'the reminder never fires late either');
    assert.equal(f.events('responsible_fault_restart').length, 1, 'the existing fresh-restart rule replaces the stopped reviewer');
    assert.equal(f.reviewerRuns().length, 2);
    assert.equal(f.current().resolution.currentRunId === stopped.id, false);
    assert.equal(f.store.run(stopped.id)!.completion, null, 'a stalled read is never a verdict');
    assert.equal(f.coordinatorRuns().length, 0, 'no coordinator is spent on a refusal check that cannot settle');
  } finally { await f.close(); }
});

test('a responsible task keeps exactly one retained recovery thread for a fault code cannot settle', async () => {
  const f = fixture({ responsible: true });
  try {
    f.store.putRun(runSchema.parse({ id: 'failed-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base,
      agentId: 'worker', workspaceId: 'workspace', profile: f.author, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Worker error: the build failed', agentActive: true, lastAgentStatus: 'running',
      completion: { taskId: f.submitted.id, runId: 'failed-revision', eventId: 'worker-error', status: 'error', summary: 'The build failed', prNumber: 1 } }, 'worker_error');
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.coordinatorRuns().length, 1);
    const episode = f.coordinatorRuns()[0]!;
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.coordinatorRuns().length, 1, 'the episode is retained, not replaced');
    assert.equal(f.current().resolution.recovery?.runId, episode.id);
  } finally { await f.close(); }
});

test('a responsible task routes an exhausted worker model by code, with no coordinator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-responsible-exhausted-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const first = profile('first-worker', 'test/first'), second = profile('second-worker', 'test/second');
  store.setMeta('pool', [
    { profileId: first.id, enabled: true, group: 'first', roles: ['worker'], scopes: ['general'], weight: 1 },
    { profileId: second.id, enabled: true, group: 'second', roles: ['worker'], scopes: ['general'], weight: 1 },
  ] as PoolEntry[]);
  store.setMeta('paused', false);
  const task = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Responsible exhausted worker', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin', responsible: true,
  }), 'host', 'handoff', base);
  store.update(task.id, { preferredProfileId: first.id });
  let replacements = 0;
  const adapter = fakeAdapter({
    profiles: async () => [first, second], validate: async () => base,
    createWorkspace: async (t: ParameterTask) => ({ id: `ws-${t.id}`, directory: join(dir, 'worktree') }),
       notify: async () => {},
    verifyWorkspace: async (t: ParameterTask) => t.branch, verifyResume: async () => {}, verifyCleanQueueWorktree: async () => {},
    createAgent: async (t: ParameterTask) => { replacements++; return { id: replacements === 1 ? 'author-agent' : 'replacement', workspaceId: t.workspaceId }; },
    observe: async (id: string) => ({ id, workspaceId: store.task(task.id).workspaceId!, status: 'running', active: true, permissions: false, error: '' }),
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/1', repository: 'example/repo', headRepository: 'example/repo' }),
    findOpenBranchPr: async () => [],
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [first, second];
  try {
    await engine.wake();
    const old = store.task(task.id);
    assert.equal(old.profile?.id, first.id);
    // The provider attributes quota exhaustion to the exact retained agent.
    adapter.observe = async (id: string) => ({ id, workspaceId: old.workspaceId!, status: 'error', active: false, permissions: false,
      error: id === old.agentId ? 'weekly usage limit exceeded' : '', model: id === old.agentId ? first.model : second.model });
    await engine.wake();
    const replaced = store.task(task.id);
    assert.equal(replaced.agentId, 'replacement');
    assert.equal(replaced.profile?.id, second.id);
    assert.equal(replaced.workspaceId, old.workspaceId, 'the same task workspace keeps the work');
    assert.equal(store.runs(task.id).filter(item => item.role === 'recovery').length, 0, 'code routed the exhausted model; no coordinator ran');
    assert.ok(store.events(task.id).some(event => event.kind === 'provider_exhausted' || event.kind === 'provider_unavailable' || event.kind === 'provider_exhausted'));
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Task 523: a responsible task parked on a wait only a person can clear asks
 * the operator on its own thread — one native question, so it shows in the
 * sidebar and as the task's composer pill — instead of leaving the notice to the
 * origin thread. It is the joint question's mechanism: a durable send intent,
 * at most one question per stop and head, and a lost observation is unknown and
 * never resent.
 */
async function proofWait(f: ReturnType<typeof fixture>) {
  await proofWaitReport(f);
  assert.equal(f.current().resolution.stop?.reason, 'awaiting_proof', f.current().reason);
}
/** The approval that parks on proof, without asserting where it lands: a delegate may answer it within the same pass. */
async function proofWaitReport(f: ReturnType<typeof fixture>, afterSeed?: () => void) {
  // A source-approved reviewer report proves the exact Queue-owned checkout
  // (server/ordinary-review.ts), so this scenario seeds a real one.
  seededSourceCheckout(f);
  afterSeed?.();
  await f.engine.wake();
  assert.equal(f.run().role, 'reviewer');
  // A reviewer approves the source at the exact head and names a proof that can
  // only exist after the merge it would gate (Queue #520).
  await f.report('blocked', { sourceApproved: true, awaitingProofs: [{ proof: 'post-merge-proof', route: 'external' }] });
  await f.settle(2);
}

/** A real Queue-owned checkout at the task's branch, so a source approval can prove its identity. */
function seededSourceCheckout(f: ReturnType<typeof fixture>): void {
  const task = f.store.task(f.submitted.id);
  const repo = task.repoPath, worktree = task.directory!, remote = join(f.dir, 'origin.git');
  mkdirSync(repo, { recursive: true }); mkdirSync(worktree, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  run('init', '-q', '--bare', remote);
  run('init', '-q', '-b', 'main', repo);
  run('-C', repo, 'config', 'user.email', 'fixture@example.test');
  run('-C', repo, 'config', 'user.name', 'Queue fixture');
  run('-C', repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'change.txt'), 'the reviewed change\n');
  run('-C', repo, 'add', 'change.txt');
  run('-C', repo, 'commit', '-q', '-m', 'the reviewed change');
  run('-C', repo, 'worktree', 'add', '-q', '-b', task.branch, worktree);
  const head = run('-C', worktree, 'rev-parse', 'HEAD');
  // The reviewed branch is published, so a later ordinary round can fetch it.
  run('-C', worktree, 'push', '-q', 'origin', `refs/heads/${task.branch}:refs/heads/${task.branch}`);
  f.store.update(task.id, { prHead: head }, 'fixture_source_head');
  f.setHead(head);
}

test('a responsible task waiting on proof asks the operator one native question on its own thread', async () => {
  const f = fixture({ responsible: true });
  try {
    await proofWait(f);
    assert.equal(f.asks.length, 1, 'exactly one native question');
    const asked = f.asks[0]!;
    assert.match(asked.question, /awaiting_proof/, 'the stop reason travels in the question');
    assert.match(asked.question, /post-merge-proof/, 'the named proofs travel in the question');
    assert.ok(asked.question.includes(f.current().prHead!), 'the approved exact head is named');
    assert.match(asked.question, /cannot run from Nucleus's side/, 'new proof questions name Nucleus');
    assert.match(asked.question, /will not run before a merge/, 'the body says the proofs do not run before the merge');
    assert.match(asked.question, /Merging now accepts/, 'the body names the merge-now consequence');
    assert.deepEqual(asked.options, ['Merge now without these proofs (run them after merge)', 'Return the task to the worker', 'Leave held for the planner'],
      'the concrete choices Queue can apply, not abstract ones, and the accept option says it merges now');
    assert.equal(f.events('operator_question').length, 1, 'the send intent is durable before the prompt');
    assert.equal(f.coordinatorRuns().length, 0, 'a wait opens no coordinator');
    // A repeated pass at the same stop and head asks nothing new.
    await f.settle(3);
    assert.equal(f.asks.length, 1);
    assert.equal(f.events('operator_question').length, 1);
    assert.equal(f.current().resolution.stop?.reason, 'awaiting_proof');
  } finally { await f.close(); }
});

test('the operator answer applies the merge verb and records the source acceptance', async () => {
  const f = fixture({ responsible: true });
  try {
    await proofWait(f);
    f.answer('Merge now without these proofs (run them after merge)');
    await tick();
    assert.equal(f.events('operator_question_answered').length, 1, 'the answer is recorded first');
    await f.settle(3);
    assert.equal(f.events('operator_question_refused').length, 0, f.events('operator_question_refused').map(event => event.detail).join('\n'));
    assert.equal(f.events('operator_question_applied').length, 1);
    const task = f.current();
    const acceptance = task.resolution.ownerAcceptances.at(-1)!;
    assert.equal(acceptance.kind, 'operator_source', 'the answer is the operator source acceptance');
    assert.equal(acceptance.head, task.prHead, 'the acceptance binds the exact approved head');
    assert.equal(acceptance.actor.agentId, 'worker', 'the answer is relayed by the task thread that asked');
    assert.equal(acceptance.authority.kind, 'relayed_note');
    assert.match(acceptance.authority.note ?? '', /Merge now without these proofs \(run them after merge\)/);
    assert.notEqual(task.resolution.stop?.reason, 'awaiting_proof', task.reason);
    assert.doesNotMatch(task.reason, /awaiting proof/i);
    assert.equal(task.phase, 'verifying', 'the acceptance enters ordinary verification');
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'owner_acceptance'), 'the acceptance is recorded before the phase moves');
    assert.equal(task.resolution.review?.sourceApproved, true, 'the reviewer record is untouched');
    assert.equal(f.asks.length, 1, 'an answered question is never asked again');
  } finally { await f.close(); }
});

test('a lost observation of the proof question is recorded as unknown and never resent', async () => {
  const f = fixture({ responsible: true });
  try {
    await proofWait(f);
    f.reject(Error('Native decision observation interrupted; delivery or answer may be unknown'));
    await tick();
    await f.settle(3);
    assert.equal(f.events('operator_question_unknown').length, 1);
    assert.equal(f.events('operator_question_answered').length, 0);
    assert.equal(f.events('operator_question_applied').length, 0);
    assert.equal(f.asks.length, 1, 'an unknown observation is never resent');
    assert.equal(f.current().resolution.stop?.reason, 'awaiting_proof', 'the wait itself is untouched');
  } finally { await f.close(); }
});

test('a wait code settles without asking anyone', async () => {
  const optedIn = fixture({ responsible: true });
  try {
    await optedIn.engine.wake();
    optedIn.engine.resolution.waiting(optedIn.current(), 'Waiting for a project slot', 'capacity');
    await optedIn.settle(2);
    assert.equal(optedIn.asks.length, 0, 'capacity clears by itself; it asks nobody');
    assert.equal(optedIn.events('operator_question').length, 0);
  } finally { await optedIn.close(); }

});

/** A reviewer report that approves the source and names proofs with their route. */
async function proofReport(f: ReturnType<typeof fixture>, proofs: Completion['awaitingProofs']) {
  await f.report('blocked', { sourceApproved: true, awaitingProofs: proofs });
  await f.settle(2);
}

test('an author-tagged proof returns the task to its worker and the retained reviewer judges the evidence', async () => {
  const f = fixture({ responsible: true });
  try {
    seededSourceCheckout(f);
    await f.engine.wake();
    const reviewer = f.run();
    assert.equal(reviewer.role, 'reviewer');
    const selector = 'effigy test unit -- test/changed.test.ts';
    const faulty = 'tsx --test test/changed.test.ts (IPC error EADDRINUSE on the socket)';
    await proofReport(f, [{ proof: selector, route: 'author' }, { proof: faulty, route: 'environment' }]);
    assert.equal(f.events('run_result_applied').filter(event => event.detail === reviewer.id).length, 1);
    // The worker, not the operator, gets the reviewer's proof list.
    const task = f.current();
    assert.equal(task.phase, 'changes_requested', task.reason);
    assert.equal(task.resolution.stop, null, 'an author route is work, not a wait');
    assert.equal(f.asks.length, 0, 'an author-producible proof never reaches the operator');
    const revision = f.run();
    assert.equal(revision?.role, 'revision', task.reason);
    assert.equal(revision!.head, task.prHead, 'the evidence is produced at the approved head');
    assert.ok(revision!.instruction?.includes(selector), revision!.instruction ?? undefined);
    assert.match(revision!.instruction ?? '', /author evidence/);
    assert.equal(task.resolution.review?.sourceApproved, true, 'the reviewer record is retained as evidence');
    // The author returns readiness at the same head; the retained reviewer takes
    // the evidence-only turn rather than a fresh reader of unchanged source.
    await f.report('ready_for_review');
    await f.settle(2);
    const proofTurn = f.run();
    assert.equal(proofTurn.role, 'reviewer', f.current().reason);
    assert.equal(proofTurn.proofOnly, true, 'the arriving evidence is judged at the same head');
    assert.equal(proofTurn.agentId, reviewer.agentId, 'the retained reviewer judges its own proof request');
    assert.match(proofTurn.reviewDelta ?? '', /Judge only arriving proof evidence/);
    assert.equal(proofTurn.proofRetry, undefined, 'the author route is taken before the environment retry');
    // The same reviewer re-names the check that faulted in its own run: now, and
    // not before, it gets the one clean retry, still ahead of any operator question.
    await proofReport(f, [{ proof: faulty, route: 'environment' }]);
    assert.equal(f.run().proofRetry?.proofs.join(), faulty);
    assert.equal(f.asks.length, 0);
    await f.report('ready_to_merge');
    await f.settle(2);
    assert.equal(f.current().resolution.review?.status, 'ready_to_merge', 'the retained reviewer approves after the evidence');
    assert.equal(f.asks.length, 0);
  } finally { await f.close(); }
});

test('an environment-tagged proof gets exactly one clean retry at the head, then parks as external', async () => {
  const f = fixture({ responsible: true });
  try {
    seededSourceCheckout(f);
    await f.engine.wake();
    const first = f.run();
    const failed = 'tsx --test test/changed.test.ts (IPC error EADDRINUSE on the socket)';
    await proofReport(f, [{ proof: failed, route: 'environment' }]);
    assert.equal(f.asks.length, 0, 'an environment fault retries before anything parks');
    const retry = f.run();
    assert.equal(retry.role, 'reviewer');
    assert.equal(retry.head, first.head, 'the retry runs at the same exact head');
    assert.deepEqual(retry.proofRetry?.proofs, [failed]);
    assert.equal(retry.proofRetry?.forRunId, first.id);
    assert.equal(f.current().phase, 'reviewing');
    assert.equal(f.current().resolution.proofRetry, null, 'the retry intent is spent when the turn is dispatched');
    assert.match(runPrompt(f.current(), retry, '/helper', '/ticket', true),
      /Clean-environment retry \(this is the one allowance\)[\s\S]*TMPDIR/);
    // The check faults again: the allowance is spent, so it is an external proof now.
    await proofReport(f, [{ proof: failed, route: 'environment' }]);
    assert.equal(f.store.runs(f.current().id).filter(item => item.proofRetry).length, 1, 'exactly one clean retry');
    const parked = f.current();
    assert.equal(parked.resolution.stop?.reason, 'awaiting_proof', parked.reason);
    assert.deepEqual(parked.resolution.review?.awaitingProofs, [{ proof: failed, route: 'external' }],
      'a spent environment fault parks as an external proof');
    assert.equal(f.asks.length, 1, 'the spent retry reaches the operator once');
    assert.match(f.asks[0]!.question, /EADDRINUSE/);
  } finally { await f.close(); }
});

test('the owner no-retry rule keeps the completed reviewer verdict and sends the environment fault to the planner', async () => {
  const f = fixture({ responsible: true });
  try {
    seededSourceCheckout(f);
    await f.engine.wake();
    const first = f.run();
    const failed = 'effigy test unit -- test/changed.test.ts (environment fault)';
    const current = f.current();
    f.store.update(current.id, { resolution: { ...current.resolution, noAutomaticRetry: true } }, 'test_no_retry_rule');
    await proofReport(f, [{ proof: failed, route: 'environment' }]);
    const task = f.current();
    assert.equal(task.resolution.review?.runId, first.id, 'the completed verdict remains current evidence');
    assert.equal(task.resolution.review?.sourceApproved, true);
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'reviewer').length, 1, 'no clean-environment reviewer is launched');
    assert.equal(f.events('reviewer_environment_retry').length, 0);
    assert.equal(f.events('automatic_retry_suppressed').length, 1);
    assert.match(f.events('automatic_retry_suppressed')[0]!.detail, /reviewer_environment.*environment fault/);
    assert.equal(f.events('planner_escalation').length, 1, 'the retained evidence goes to the planner ladder');
    assert.equal(f.asks.length, 0, 'the planner ladder owns this routing');
  } finally { await f.close(); }
});

test('a mixed report returns the author proofs first and only the external one asks the operator', async () => {
  const f = fixture({ responsible: true });
  try {
    seededSourceCheckout(f);
    await f.engine.wake();
    await proofReport(f, [{ proof: 'effigy test unit -- test/changed.test.ts', route: 'author' }, { proof: 'native-hardware-run', route: 'external' }]);
    assert.equal(f.current().phase, 'changes_requested', f.current().reason);
    assert.equal(f.asks.length, 0, 'the author proof is produced before the operator is asked');
    assert.match(f.run().instruction ?? '', /effigy test unit -- test\/changed\.test\.ts/);
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.run().proofOnly, true);
    // The external proof is not the worker's to produce: it parks the wait and asks the operator.
    await proofReport(f, [{ proof: 'native-hardware-run', route: 'external' }]);
    const parked = f.current();
    assert.equal(parked.resolution.stop?.reason, 'awaiting_proof', parked.reason);
    assert.deepEqual(parked.resolution.review?.awaitingProofs, [{ proof: 'native-hardware-run', route: 'external' }]);
    assert.equal(f.asks.length, 1);
    assert.match(f.asks[0]!.question, /native-hardware-run/);
  } finally { await f.close(); }
});

test('a return to the worker carries the proof list, and a worker that cannot produce them is not asked about again (Project-F #38)', async () => {
  const f = fixture({ responsible: true });
  try {
    await proofWait(f);
    assert.equal(f.asks.length, 1);
    assert.ok(f.asks[0]!.options.includes('Return the task to the worker'), f.asks[0]!.options.join(' | '));
    f.answer('Return the task to the worker');
    await tick();
    await f.settle(3);
    assert.equal(f.events('operator_question_refused').length, 0, f.events('operator_question_refused').map(event => event.detail).join('\n'));
    assert.equal(f.events('operator_question_applied').length, 1);
    // The worker's round names the proofs and asks for each one it can produce.
    const revision = f.run();
    assert.equal(revision.role, 'revision', f.current().reason);
    assert.match(revision.instruction ?? '', /post-merge-proof/, 'the worker gets the proof list, not only the answer');
    assert.match(revision.instruction ?? '', /say plainly which you can't and why/);
    // The worker finds nothing it can produce and reports blocked at once. Queue
    // re-records the wait with a new stop episode, which used to ask the same question again.
    await f.report('blocked', { summary: 'Nothing this worker can produce at this head' });
    await f.settle(3);
    assert.equal(f.current().resolution.stop?.reason, 'awaiting_proof', f.current().reason);
    assert.equal(f.asks.length, 1, 'the identical proof question is never asked again at this head');
    assert.equal(f.events('operator_question').length, 1);
  } finally { await f.close(); }
});

test('an untagged proof gets one author round at its head before it can reach the operator', async () => {
  const f = fixture({ responsible: true });
  try {
    seededSourceCheckout(f);
    await f.engine.wake();
    assert.equal(f.run().role, 'reviewer');
    const selector = 'effigy test unit -- test/changed.test.ts';
    await proofReport(f, [selector]);
    assert.equal(f.current().phase, 'changes_requested', f.current().reason);
    assert.equal(f.asks.length, 0, 'an untagged proof is the worker\'s first');
    assert.match(f.run().instruction ?? '', /effigy test unit/);
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.run().proofOnly, true);
    // Named again at the same head: the round is spent, so the proof parks as external and asks once.
    await proofReport(f, [selector]);
    const parked = f.current();
    assert.equal(parked.resolution.stop?.reason, 'awaiting_proof', parked.reason);
    assert.deepEqual(parked.resolution.review?.awaitingProofs, [{ proof: selector, route: 'external' }]);
    assert.equal(f.asks.length, 1, 'the spent round reaches the operator once');
    assert.ok(!f.asks[0]!.options.includes('Return the task to the worker'), 'the worker already had this proof at this head');
    assert.ok(f.asks[0]!.options.includes('Leave held for the planner'));
  } finally { await f.close(); }
});

test('leave held for the planner places a merge hold with the proof list and closes the question', async () => {
  const f = fixture({ responsible: true });
  try {
    await proofWait(f);
    f.answer('Leave held for the planner');
    await tick();
    await f.settle(3);
    assert.equal(f.events('operator_question_refused').length, 0, f.events('operator_question_refused').map(event => event.detail).join('\n'));
    assert.equal(f.events('operator_question_applied').length, 1);
    const task = f.current();
    assert.ok(task.holds?.merge, 'a merge hold is placed');
    assert.match(task.holds!.merge!.reason, /post-merge-proof/, 'the hold names the proofs it leaves for the planner');
    assert.equal(task.holds?.dispatch, undefined, 'the dispatch fence is untouched');
    assert.equal(task.resolution.review?.sourceApproved, true, 'the reviewer record is untouched');
    assert.equal(f.asks.length, 1, 'a held task asks nothing more');
  } finally { await f.close(); }
});

test('registering a live project planner re-asks a proof question parked for the planner once', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Choice: Merge now without these proofs (run them after merge)\nReason: The proofs can run after merge.' } });
  try {
    // Task 1109: with the task planner gone the question parks for the project planner.
    originGone(f);
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    await proofWait(f);
    f.answer('Leave held for the planner');
    await tick();
    await f.settle(3);
    assert.ok(f.current().holds?.merge);
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    pushMain(f);
    await f.engine.resolution.projectPlannerRegistered('app', 'planner-1');
    await f.engine.resolution.projectPlannerRegistered('app', 'planner-1');
    assert.equal(f.delegated.planner.length, 1, 'the parked question is asked only once for this planner');
    assert.equal(f.events('operator_question_reasked_answered').length, 1);
    assert.equal(f.events('operator_question_reasked_apply_failed').length, 0, 'the planner answer applies through the ordinary owner control');
  } finally { await f.close(); }
});

test('bug 25: a re-ask to a newly registered planner carries the task context', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Choice: Merge now without these proofs (run them after merge)\nReason: The proofs can run after merge.' } });
  try {
    // Task 1109: the task planner is gone, so the question waits for the project planner.
    originGone(f);
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    await proofWait(f);
    f.answer('Leave held for the planner');
    await tick();
    await f.settle(3);
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await f.engine.resolution.projectPlannerRegistered('app', 'planner-1');
    assert.match(f.delegated.planner[0]!.prompt, /Task context:\n {2}Task: Responsible lifecycle/);
    assert.match(f.delegated.planner[0]!.prompt, /^ {2}Brief: \S/m);
  } finally { await f.close(); }
});

test('bug 23: the operator settling a parked proof question beats the re-asked planner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Choice: Merge now without these proofs (run them after merge)\nReason: The proofs can run after merge.' } });
  try {
    // Task 1109: the task planner is gone, so the operator settles the parked question.
    originGone(f);
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    await proofWait(f);
    f.answer('Leave held for the planner');
    await tick();
    await f.settle(3);
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    const adapter = f.adapter as unknown as { askPlanner: (planner: string, input: unknown) => Promise<string | null> };
    const ask = adapter.askPlanner;
    adapter.askPlanner = async (planner, input) => {
      const { merge: _merge, ...holds } = f.current().holds ?? {};
      f.store.update(f.current().id, { holds, held: false, mergeHold: false });
      return ask.call(adapter, planner, input);
    };
    await f.engine.resolution.projectPlannerRegistered('app', 'planner-1');
    assert.equal(f.delegated.planner.length, 1);
    assert.equal(f.events('operator_question_reasked_answered').length, 0);
    assert.match(f.events('operator_question_stale_answered').at(-1)!.detail, /already settled/);
    assert.equal(f.current().resolution.ownerAcceptances.length, 0);
  } finally { await f.close(); }
});

for (const route of ['project', 'queue', 'operator'] as const) {
 test(`stranded stop routes to ${route} planner with choices`, async () => {
  const f = fixture({ responsible: true, delegates: { planner: route === 'operator'
    ? 'Decision: operator\nReason: Only the operator can change the delivered scope.'
    : 'Choice: route\nReason: Select another profile with the owner verb.' } });
  try {
    const stranded = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: 'Stranded responsible task', repoPath: join(f.dir, 'other-repo'), planningCommit: base,
      brief: { text: 'Stranded brief\n' }, originAgentId: 'origin', responsible: true,
    }), 'host', 'brief', base);
    f.store.update(stranded.id, { phase: 'blocked', workspaceId: 'stranded-workspace',
      directory: join(f.dir, 'stranded'), agentId: 'stranded-worker', runId: 'stranded-run', profile: f.author,
      prerequisiteWait: { id: randomUUID(), waitsFor: ['dependency'], reason: 'waiting on a retained prerequisite', releasedAt: null } } as never, 'dispatched');
    f.engine.resolution.recordStop(f.store.task(stranded.id), 'operator_needed', 'The brief names no API to keep and the worker returned the task', ['restart', 'route', 'move']);

    const origin = route === 'project' ? stranded.repoPath : QUEUE_REPOSITORY_ORIGIN;
    f.store.upsertProject({ key: 'planner-project', name: 'Planner', repositories: [{ origin, path: route === 'project' ? stranded.repoPath : join(f.dir, 'queue') }] });
    f.store.setProjectPlanner({ key: 'planner-project', agentId: 'planner-1', setBy: 'operator' });
    if (route === 'project') {
      const task = f.store.task(stranded.id);
      f.store.update(task.id, { resolution: { ...task.resolution, mergedCommit: head } });
    }
    const question = operatorQuestionFor(f.store, f.store.task(stranded.id))!;
    if (route === 'project') {
      assert.equal(question.choices[0]!.label, 'move to=closeout force');
      const control = (f.engine.resolution as any).operatorAnswerControl(f.store.task(stranded.id), question, question.choices[0], question.choices[0]!.label,
        { role: 'planner', agentId: 'planner-1', choice: question.choices[0]!.label, reason: 'The PR merged.' });
      assert.equal(control.to, 'closeout');
      assert.equal(control.force, true);
      assert.equal(control.delegated, true);
    }

    assert.equal(question.kind, 'process');
    assert.ok(question.choices.length > 0);
    assert.ok(question.choices.some(choice => choice.label.includes('force')));
    assert.match(question.question, /No verb Nucleus can run applies/);
    assert.match(question.question, /Recommended:/);
    await f.engine.resolution.raiseOperatorQuestions();
    for (let i = 0; i < 30; i++) await tick();
    assert.equal(f.delegated.planner.length, 1);
    assert.match(f.delegated.planner[0]!.prompt, /move to=.*force/);
    if (route !== 'operator') {
      assert.equal(new Decisions(f.store).list({ status: 'open' }).length, 0);
    } else {
      const decisions = new Decisions(f.store).list({ status: 'open' });
      assert.equal(decisions.length, 1);
      assert.ok(decisions[0]!.choices?.length);
      assert.ok(decisions[0]!.recommended);
    }
  } finally { await f.close(); }
 });
}

test('recorded operator questions keep only an exact legacy digest and length', () => {
  const cases = [
    ["The proofs cannot run from Nucleus's side, so they wait.", "The proofs cannot run from Queue's side, so they wait."],
    ['Nucleus starts no new run until you answer.', 'Queue starts no new run until you answer.'],
    ['No verb Nucleus can run applies to it now.', 'No verb Queue can run applies to it now.'],
  ] as const;
  for (const [current, previous] of cases) {
    const question: OperatorQuestion = { id: 'q', kind: 'process', question: current, choices: [] };
    const legacy: OperatorQuestion = { ...question, question: previous };
    const intent = `q: question ${digest(previous)} (${previous.length} chars)`;
    assert.equal(preserveRecordedOperatorQuestion(question, legacy, undefined).question, current);
    assert.equal(preserveRecordedOperatorQuestion(question, legacy, intent).question, previous);
    assert.equal(preserveRecordedOperatorQuestion(question, legacy, `q: question ${digest(previous)} (${previous.length + 1} chars)`).question, current);
    assert.equal(preserveRecordedOperatorQuestion(question, legacy, `q: question ${digest(current)} (${previous.length} chars)`).question, current);
  }
});

test('a merge hold does not suppress the budget question', async () => {
  const f = fixture({ responsible: true });
  try {
    const task = f.store.task(f.submitted.id);
    // The question answers to the measured budget (nucleus#1187): four hours of the
    // low default limit are spent, so the pause and its question are real.
    const startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    f.store.update(task.id, { held: true, mergeHold: true, holdOwner: 'operator', holdReason: 'dependent task', holdAt: new Date().toISOString(),
      complexity: 'low', budgetSince: startedAt,
      holds: { merge: { owner: 'operator', reason: 'dependent task', at: new Date().toISOString(), generation: 1, until: null } } } as never, 'merge_held');
    f.recordRunStart(startedAt);
    f.engine.resolution.recordStop(f.store.task(task.id), 'budget', 'Budget reached: 60 minutes of wall time since the responsible lifecycle began');
    const question = operatorQuestionFor(f.store, f.store.task(task.id));
    assert.ok(question);
    assert.match(question.question, /Nucleus starts no new run/);
    const legacy = question.question.replace('Nucleus starts no new run', 'Queue starts no new run');
    f.store.event(task.id, 'operator_question', `${question.id}: question ${digest(legacy)} (${legacy.length} chars)`);
    assert.equal(operatorQuestionFor(f.store, f.store.task(task.id))?.question, legacy, 'an existing budget intent retains its exact question');
    assert.deepEqual(question!.choices.map(choice => choice.label), ['Extend the budget', 'Change the approach', 'Stop and keep the work']);
  } finally { await f.close(); }
});

test('a previously recorded budget question still applies its board answer', async () => {
  const f = fixture({ responsible: true });
  try {
    const task = f.current();
    const startedAt = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    f.store.update(task.id, { budgetSince: startedAt });
    f.recordRunStart(startedAt);
    f.engine.resolution.recordStop(f.current(), 'budget', 'Budget reached: wall-time limit');
    const question = operatorQuestionFor(f.store, f.current())!;
    const legacy = question.question.replace('Nucleus starts no new run', 'Queue starts no new run');
    assert.notEqual(legacy, question.question);
    f.store.event(task.id, 'operator_question', `${question.id}: kind budget; question ${digest(legacy)} (${legacy.length} chars); options ${question.choices.map(choice => choice.label).join(' | ')}`);
    const decisions = new Decisions(f.store);
    const decision = decisions.add({ question: legacy, askedBy: task.agentId!, tasks: [task.id], options: question.choices.map(choice => choice.label) });
    f.store.event(task.id, 'operator_question_decision', `${question.id}: decision ${decision.id}; fallback`);
    assert.equal(operatorQuestionFor(f.store, f.current())?.question, legacy, 'the recorded intent still reconstructs');
    const answered = decisions.answer({ id: decision.id, version: decision.version, answer: 'Extend the budget', answeredBy: 'operator (board)', relayed: false, note: '' });
    f.engine.resolution.operatorDecisionAnswered(answered);
    for (let i = 0; i < 30 && !f.events('budget_extended').length; i++) await tick();
    assert.equal(f.events('budget_extended').length, 1, JSON.stringify(f.store.eventsAll(task.id).filter(event => event.kind.startsWith('operator_question')).map(event => [event.kind, event.detail])));
    assert.equal(f.current().resolution.budgetExtensions, 1);
  } finally { await f.close(); }
});

test('extend_budget uses the owner extension path and requires board, relayed or delegated authority', async () => {
  const f = fixture({ responsible: true });
  try {
    const task = f.store.task(f.submitted.id);
    const startedAt = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    f.store.update(task.id, { budgetSince: startedAt });
    f.recordRunStart(startedAt);
    const exhaustedTask = f.store.task(task.id);
    f.engine.resolution.recordStop(exhaustedTask, 'budget', 'Budget reached: 3 hours');
    const question = operatorQuestionFor(f.store, f.current())!;
    f.store.event(task.id, 'operator_question', `${question.id}: kind ${question.kind}; stop budget; head ${task.prHead}; question ${digest(question.question)} (${question.question.length} chars); options ${question.choices.map(choice => choice.label).join(' | ')}`);
    const decision = new Decisions(f.store).add({ question: question.question, askedBy: task.agentId!, tasks: [task.id], options: question.choices.map(choice => choice.label) });
    f.store.event(task.id, 'operator_question_decision', `${question.id}: decision ${decision.id}; fallback`);
    const withoutAuthority = { taskId: task.id, version: f.current().version, action: 'extend_budget' as const, reason: 'continue' };
    await assert.rejects(f.engine.performTaskControl(withoutAuthority), /operator at the board or a relayed operator authorization note/);
    await assert.rejects(f.engine.performTaskControl({ ...withoutAuthority, caller: 'planner-1', delegated: true, note: 'Planner approved one more increment' }),
      /structured delegated budget authority/);
    await assert.rejects(f.engine.performTaskControl({ ...withoutAuthority, caller: 'planner-1', delegated: true,
      note: 'approve by default, Tom 2026-11-03' }), /structured delegated budget authority/,
      'free text never grants the standing budget authority');
    assert.equal(taskControlInputSchema.safeParse({ ...withoutAuthority, budgetAuthority: 'approve_by_default' }).success, false,
      'standing budget authority must identify a delegated answer');
    assert.equal(taskControlInputSchema.safeParse({ ...withoutAuthority, caller: 'relay-agent', relayed: true }).success, false,
      'the schema still requires a note for a relayed extension');
    const available = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(view => view.verb === 'extend_budget');
    assert.equal(available?.available, true);
    await f.engine.performTaskControl({ ...withoutAuthority, version: f.current().version, caller: OPERATOR_BOARD_CALLER });
    assert.equal(f.current().resolution.budgetExtensions, 1);
    assert.equal(f.current().resolution.stop, null);
    assert.match(f.events('operator_question_superseded')[0]!.detail, new RegExp(`^${question.id}: .*budget was extended`));
    assert.equal(f.store.decision(decision.id).status, 'withdrawn', 'the linked board question closes with the budget pause');

    f.engine.resolution.recordStop(f.current(), 'budget', 'Budget reached: 6 hours');
    await f.engine.performTaskControl(taskControlInputSchema.parse({ ...withoutAuthority, version: f.current().version,
      caller: 'relay-agent', relayed: true, note: 'Operator approved one more increment' }));
    assert.equal(f.current().resolution.budgetExtensions, 2);
    assert.equal(f.current().resolution.stop, null);
    assert.equal(f.events('budget_extended').length, 2);

    // Nothing has run since the last increment, so no recorded run start spends it.
    f.clearRunStarts();
    const underBudget = f.store.update(f.current().id, { budgetSince: new Date().toISOString() });
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, underBudget)).verbs.find(view => view.verb === 'extend_budget')?.available, false);
    await assert.rejects(f.engine.performTaskControl({ taskId: underBudget.id, version: underBudget.version,
      action: 'extend_budget', reason: 'continue', caller: OPERATOR_BOARD_CALLER }), /budget is exhausted/);
  } finally { await f.close(); }
});

test('extend_budget applies to an exhausted awaiting_proof task without starting a worker turn', async () => {
  const f = fixture({ responsible: true });
  try {
    const task = f.store.task(f.submitted.id);
    const startedAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    f.store.update(task.id, { budgetSince: startedAt });
    f.recordRunStart(startedAt);
    f.engine.resolution.recordStop(f.store.task(task.id), 'awaiting_proof', 'Waiting for the declared proof');
    const beforeRuns = f.store.runs(task.id).length;
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.equal(next.verbs.find(view => view.verb === 'extend_budget')?.available, true);
    await f.engine.performTaskControl({ taskId: task.id, version: f.current().version, action: 'extend_budget',
      reason: 'continue proof', caller: OPERATOR_BOARD_CALLER });
    assert.equal(f.current().resolution.stop?.reason, 'awaiting_proof');
    assert.equal(f.current().resolution.budgetExtensions, 1);
    assert.equal(f.store.runs(task.id).length, beforeRuns);
  } finally { await f.close(); }
});

test('extend_budget accepts a planner grant past twice the budget with delegated authority', async () => {
  const f = fixture({ responsible: true });
  try {
    await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: 2 * LOW_TOKENS * 2 }));
    f.engine.resolution.recordStop(f.current(), 'budget', 'Budget reached past twice the limit');
    const before = f.current();
    const note = "Planner approved another budget increment";
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: before.id, version: before.version, action: 'extend_budget',
      reason: 'Extend the task budget', caller: 'planner-1', delegated: true, budgetAuthority: 'approve_by_default', note }));
    assert.equal(f.current().resolution.budgetExtensions, 1);
    assert.equal(f.current().resolution.stop, null);
    assert.match(f.events('budget_extended')[0]!.detail, /planner-1: Planner approved another budget increment/);
  } finally { await f.close(); }
});

test('a planner answer arriving after extend_budget is not sent to the task thread', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null } });
  f.engine.resolution.delegatedAnswerWaitMs = 1000;
  let finishPlanner!: (answer: string) => void;
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    // Task 1109: the task's planner is the thread whose answer arrives in this window.
    const startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    f.store.update(f.current().id, { budgetSince: startedAt, plannerAgentId: 'planner-1' });
    f.recordRunStart(startedAt);
    (f.adapter as Adapter & { askPlanner: (planner: string, input: { prompt: string }) => Promise<string | null> }).askPlanner = async () =>
      await new Promise<string>(resolve => { finishPlanner = resolve; });
    f.engine.resolution.recordStop(f.current(), 'budget', 'Budget reached: 3 hours');
    await f.engine.resolution.raiseOperatorQuestions();
    assert.equal(f.asks.length, 1, 'the question was raised on the task thread');
    assert.ok(f.events('operator_question').length);
    for (let pass = 0; pass < 20 && typeof finishPlanner !== 'function'; pass++) await tick();
    assert.equal(typeof finishPlanner, 'function', 'planner delegation reached its in-flight answer');
    await f.engine.performTaskControl({ taskId: f.current().id, version: f.current().version, action: 'extend_budget',
      caller: OPERATOR_BOARD_CALLER, reason: 'Continue the current approach' });
    finishPlanner('Choice: Extend the budget\nReason: The work needs one more increment.');
    await tick();
    await tick();
    assert.equal(f.delegated.answers.length, 0, 'the stale answer was not delivered to the task thread');
    assert.equal(f.events('operator_question_decided').length, 0);
    assert.equal(f.events('operator_question_superseded').length, 1);
    assert.equal(f.events('operator_question_stale_answered').length, 1,
      `the stale planner answer is recorded without effect; events: ${JSON.stringify(f.store.eventsAll(f.current().id).map(event => [event.kind, event.detail]).filter(([kind]) => String(kind).startsWith('operator_question_')))}`);
    assert.match(f.events('operator_question_stale_answered')[0]!.detail, /answered by delegated planner planner-1; no effect/);
  } finally { await f.close(); }
});

/**
 * Spec 058 budgets: a responsible task sized low whose revision is in flight. The
 * next run is the one the budget gates, so the pause is raised before it starts.
 */
async function revisionInFlight(f: ReturnType<typeof fixture>) {
  f.store.update(f.submitted.id, { complexity: 'low' }, 'budget_fixture');
  await f.reviews(1);
  await f.engine.wake(); assert.equal(f.run().role, 'revision');
  return f.reviewerRuns().length;
}
const LOW_TOKENS = 2_000_000;

test('a responsible task over its token budget starts no new run, asks one question, and an extension resumes it', async () => {
  const f = fixture({ responsible: true });
  try {
    const reviewers = await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: LOW_TOKENS }));
    // The revision returns; the next reviewer is what the budget refuses.
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.reviewerRuns().length, reviewers, 'no run starts over budget');
    assert.equal(f.current().resolution.stop?.reason, 'budget');
    assert.match(f.current().resolution.stop!.detail, /Budget reached: 2,000,000 effective tokens/);
    assert.equal(f.asks.length, 1, 'the pause raises exactly one question');
    assert.match(f.asks[0]!.question, /2,000,000 of 2,000,000 effective tokens/);
    assert.deepEqual(f.asks[0]!.options, ['Extend the budget', 'Change the approach', 'Stop and keep the work']);
    // No duplicate question while it waits, and nothing is resent.
    await f.settle(3);
    assert.equal(f.asks.length, 1);
    assert.equal(f.events('operator_question').length, 1);
    assert.equal(f.reviewerRuns().length, reviewers);
    // The operator extends: one default increment, and the next reviewer starts.
    f.answer('Extend the budget');
    await tick();
    assert.equal(f.events('budget_extended').length, 1);
    assert.equal(f.current().resolution.budgetExtensions, 1);
    assert.equal(f.current().resolution.stop, null);
    await f.settle(2);
    assert.equal(f.reviewerRuns().length, reviewers + 1, 'the extended budget lets the next run start');
    assert.equal(f.events('operator_question_applied').length, 0, 'an extension applies no owner control');
    assert.equal(f.asks.length, 1);
    assert.equal(f.coordinatorRuns().length, 0);
  } finally { await f.close(); }
});

test('a responsible task over its wall-time budget pauses on the time limit, counted from its first dispatch', async () => {
  const f = fixture({ responsible: true });
  try {
    const reviewers = await revisionInFlight(f);
    const first = f.reviewerRuns()[0]!;
    f.store.putRun({ ...f.store.run(first.id)!, createdAt: new Date(Date.now() - 61 * 60_000).toISOString() });
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.reviewerRuns().length, reviewers, 'no run starts past the time limit');
    assert.equal(f.current().resolution.stop?.reason, 'budget');
    assert.match(f.current().resolution.stop!.detail, /60 minutes of wall time since the responsible lifecycle began/);
    assert.equal(f.asks.length, 1);
    assert.match(f.asks[0]!.question, /minutes of wall time since the responsible lifecycle began/);
  } finally { await f.close(); }
});

test('change approach extends the budget and sends the operator text to the worker as its next instruction', async () => {
  const f = fixture({ responsible: true });
  try {
    await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: LOW_TOKENS }));
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.asks.length, 1);
    f.answer('Change the approach: parse the cached index instead of re-reading the change');
    await tick();
    await f.settle(2);
    assert.equal(f.events('budget_extended').length, 1, 'changing approach grants the increment the next run needs');
    assert.equal(f.events('operator_question_applied').length, 1, f.events('operator_question_refused').map(event => event.detail).join('; ') || 'not applied');
    const next = f.run();
    assert.equal(next.role, 'revision');
    assert.match(next.instruction ?? '', /parse the cached index instead of re-reading the change/);
    assert.equal(f.asks.length, 1);
  } finally { await f.close(); }
});

test('stop and keep the work parks the task under a dispatch hold and starts nothing further', async () => {
  const f = fixture({ responsible: true });
  try {
    const reviewers = await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: LOW_TOKENS }));
    await f.report('ready_for_review');
    await f.settle(2);
    f.answer('Stop and keep the work');
    await tick();
    await f.settle(2);
    assert.equal(f.events('operator_question_applied').length, 1, f.events('operator_question_refused').map(event => event.detail).join('; ') || 'not applied');
    assert.ok(holdsOf(f.current()).dispatch, 'the task is parked under an owner dispatch hold');
    assert.equal(f.events('budget_extended').length, 0, 'stopping grants no increment');
    assert.equal(f.reviewerRuns().length, reviewers, 'nothing starts after a stop');
    assert.ok(f.current().prHead, 'the branch and PR head stay on the task');
  } finally { await f.close(); }
});

test('an interrupted budget question is unknown, is never resent, and grants no increment', async () => {
  const f = fixture({ responsible: true });
  try {
    await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: LOW_TOKENS }));
    await f.report('ready_for_review');
    await f.settle(2);
    assert.equal(f.asks.length, 1);
    f.reject(Error('observation lost'));
    await tick();
    await f.settle(3);
    assert.equal(f.events('operator_question_unknown').length, 1);
    assert.equal(f.asks.length, 1, 'the unknown question is never resent');
    assert.equal(f.events('budget_extended').length, 0);
    assert.equal(f.current().resolution.stop?.reason, 'budget', 'the pause stays until the operator acts');
  } finally { await f.close(); }
});

/**
 * Spec 058 (task 540): a delegable question is answered by the project's planner, or by a decider when no
 * planner answers. The native question clears through the same answer path, and the applied verb records
 * the delegated authority. Operator-only kinds never reach an agent.
 */
async function settleUntil(f: ReturnType<typeof fixture>, done: () => boolean) {
  for (let pass = 0; pass < 20 && !done(); pass++) { await f.settle(1); await tick(); }
}
/** Task 1109: the task's own planner (the submitting thread) is observed gone, so the project rung decides. */
function originGone(f: ReturnType<typeof fixture>): void {
  const read = f.adapter.originAgent!;
  Object.assign(f.adapter, { originAgent: async (id: string) => id === 'origin' ? null : read(id) });
}
/** A registered project's prospective merge gate fetches origin main, which the seeded checkout does not publish. */
function pushMain(f: ReturnType<typeof fixture>): void {
  execFileSync('git', ['-C', join(f.dir, 'repo'), 'push', '-q', 'origin', 'main'], { encoding: 'utf8' });
}
const PLANNER_MERGE = 'Choice: Merge now without these proofs (run them after merge)\nReason: The reviewer approved the exact head; the proofs need the merged tree.';
const DECIDER_RETURN = 'Choice: Return the task to the worker\nReason: The worker can produce the named proofs at this head.';

for (const scenario of ['planner', 'no planner', 'timeout', 'operator'] as const) {
  test(`worker native question: ${scenario}`, async () => {
    const f = fixture({ responsible: true, delegates: { planner: scenario === 'operator' ? 'Decision: operator\nReason: This changes scope.' : scenario === 'planner' ? 'Answer: The retained reviewer\nReason: It is independent.' : null, decider: 'Answer: Use the focused selector\nReason: It covers the change.' } });
    const delivered: Array<{ agentId: string; requestId: string; answers: Record<string, string> }> = [];
    try {
      if (scenario !== 'no planner') {
        f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
        f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
      }
      f.adapter.pendingQuestions = async id => id === 'worker' ? [{ requestId: 'permission-1', questions: [{ header: 'Question 1', question: 'Who reviews?', options: [] }] }] : [];
      f.adapter.answerNativeQuestion = async (agentId, _workspace, requestId, answers) => { delivered.push({ agentId, requestId, answers }); };
      await f.engine.resolution.delegateNativeQuestions();
      for (let i = 0; i < 20 && !f.events(scenario === 'operator' ? 'native_question_operator' : 'native_question_answered').length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await f.engine.resolution.delegateNativeQuestions();
      if (scenario === 'operator') {
        assert.equal(delivered.length, 0);
        assert.match(f.events('native_question_operator')[0]!.detail, /changes scope/);
        assert.equal(f.delegated.deciders.length, 0);
      } else {
        assert.deepEqual(delivered, [{ agentId: 'worker', requestId: 'permission-1', answers: { 'Question 1': scenario === 'planner' ? 'The retained reviewer' : 'Use the focused selector' } }]);
        assert.match(f.events('native_question_answered')[0]!.detail, new RegExp(`Answered by ${scenario === 'planner' ? 'planner' : 'decider'}:`));
        assert.equal(f.delegated.deciders.length, scenario === 'planner' ? 0 : 1);
      }
      assert.match((f.delegated.planner[0] ?? f.delegated.deciders[0])!.prompt, /Responsible lifecycle/);
      assert.match((f.delegated.planner[0] ?? f.delegated.deciders[0])!.prompt, /nucleus question.answer/);
    } finally { await f.close(); }
  });
}

test('the retained reviewer native question is answered on the reviewer thread', async () => {
  const f = fixture({ responsible: true, delegates: { decider: 'Answer: Use the focused selector\nReason: It covers the change.' } });
  const delivered: string[] = [];
  try {
    await settleUntil(f, () => Boolean(f.current().resolution.reviewerAgentId));
    const reviewer = f.current().resolution.reviewerAgentId!;
    assert.ok(reviewer);
    f.adapter.pendingQuestions = async id => id === reviewer ? [{ requestId: 'review-question', questions: [{ header: 'Question 1', question: 'Which selector?', options: [] }] }] : [];
    f.adapter.answerNativeQuestion = async agentId => { delivered.push(agentId); };
    await f.engine.resolution.delegateNativeQuestions();
    await settleUntil(f, () => delivered.length > 0);
    assert.deepEqual(delivered, [reviewer]);
  } finally { await f.close(); }
});

test('a native binary budget approval the planner approves records approve by default and never reaches Tom', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Answer: Approve\nReason: The budget is fine.', decider: null } });
  const delivered: Array<{ agentId: string; requestId: string; answers: Record<string, string> }> = [];
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    f.adapter.pendingQuestions = async id => id === 'worker' ? [{ requestId: 'budget-approval', questions: [
      { header: 'Continue?', question: 'Should we spend past twice the budget?', options: ['Approve', 'Hold'] },
    ] }] : [];
    f.adapter.answerNativeQuestion = async (agentId, _workspace, requestId, answers) => { delivered.push({ agentId, requestId, answers }); };
    await f.engine.resolution.delegateNativeQuestions();
    await settleUntil(f, () => f.events('native_question_answered').length > 0);
    assert.deepEqual(delivered, [{ agentId: 'worker', requestId: 'budget-approval', answers: { 'Continue?': 'Approve' } }]);
    assert.match(f.events('native_question_answered')[0]!.detail, /Answered by planner: Approve — approve by default, Tom 2026-11-03/);
    assert.equal(f.events('native_question_operator').length, 0);
    assert.match(f.delegated.planner[0]!.prompt, /nucleus question.answer/);
    assert.doesNotMatch(f.delegated.planner[0]!.prompt, /approve by default, Tom 2026-11-03/, 'standing rules live in the skill');
  } finally { await f.close(); }
});

test('a project planner answers a delegable proof question, the native question clears, and the merge records delegated authority', async () => {
  const f = fixture({ responsible: true, delegates: { planner: PLANNER_MERGE, decider: null } });
  try {
    // Task 1109: the project planner is the live fallback rung for this task.
    originGone(f);
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 1, 'the planner is asked first');
    assert.equal(f.delegated.deciders.length, 0, 'a planner that answers starts no decider');
    assert.equal(f.delegated.answers.length, 1, 'the native question is answered once, through the same permission');
    assert.equal(f.delegated.answers[0]!.answer, 'Merge now without these proofs (run them after merge)');
    assert.match(f.events('operator_question_decided')[0]!.detail, /Decided by planner: Merge now without these proofs \(run them after merge\) — The reviewer approved the exact head/);
    assert.equal(f.events('operator_question_refused').length, 0, f.events('operator_question_refused').map(event => event.detail).join('\n'));
    assert.equal(f.events('operator_question_applied').length, 1);
    const acceptance = f.current().resolution.ownerAcceptances.at(-1)!;
    assert.equal(acceptance.kind, 'operator_source');
    assert.equal(acceptance.actor.role, 'delegated', 'the acceptance is recorded as delegated, never the board');
    assert.equal(acceptance.actor.agentId, 'planner-1');
    assert.equal(acceptance.authority.kind, 'delegated');
    assert.match(acceptance.reason, /^A delegated planner \(planner-1\) answered/, 'the reason names the delegate, not the operator');
    assert.match(acceptance.authority.note ?? '', /Delegated answer to Queue's question .* by planner planner-1/);
    assert.equal(f.asks.length, 1, 'a delegated answer never raises a second question');
    assert.deepEqual(f.delegated.archived, [], 'the planner thread is never archived');
  } finally { await f.close(); }
});

test('with no live planner, a decider answers the delegable question once and is archived', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: DECIDER_RETURN } });
  try {
    // Task 1109: the task planner is gone and no project planner is registered.
    originGone(f);
    await proofWaitReport(f);
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 0, 'no live planner is asked when none remains');
    assert.equal(f.delegated.deciders.length, 1, 'one decider answers');
    assert.ok(f.delegated.deciders[0]!.profile, 'the decider runs on an automatically selected profile');
    assert.equal(f.delegated.answers[0]!.answer, 'Return the task to the worker');
    assert.deepEqual(f.delegated.archived, ['decider-1'], 'the decider is archived after its one answer');
    assert.match(f.events('operator_question_decided')[0]!.detail, /Decided by decider: Return the task to the worker — The worker can produce/);
    assert.equal(f.events('operator_question_applied').length, 1);
    assert.equal(f.current().phase, 'changes_requested', 'the worker returns with the decider\'s choice');
  } finally { await f.close(); }
});

test('a planner that gives no usable answer in time falls through to a decider', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: DECIDER_RETURN } });
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'planner-1' });
    // Task 1109: the task names this planner, so the rung under test is the one asked.
    f.store.update(f.current().id, { plannerAgentId: 'planner-1' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 1, 'the planner was asked');
    assert.equal(f.events('operator_question_delegation_missed').length, 1, 'the silent planner is recorded as a miss');
    assert.equal(f.delegated.deciders.length, 1, 'then a decider answers');
    assert.match(f.events('operator_question_decided')[0]!.detail, /Decided by decider/);
  } finally { await f.close(); }
});

function seedAppAndQueuePlanners(f: ReturnType<typeof fixture>) {
  f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
  f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
  const queueKey = `repo-${digest(QUEUE_REPOSITORY_ORIGIN).slice(0, 20)}`;
  f.store.upsertProject({ key: queueKey, name: 'Queue', repositories: [{ origin: QUEUE_REPOSITORY_ORIGIN, path: join(f.dir, 'queue-repo') }] });
  f.store.setProjectPlanner({ key: queueKey, agentId: 'queue-planner', setBy: 'operator' });
}

test('a closed project planner stays registered and still receives the delegated question', async () => {
  const f = fixture({ responsible: true, delegates: { planner: PLANNER_MERGE, decider: null, plannerClosed: true } });
  try {
    seedAppAndQueuePlanners(f);
    f.store.update(f.current().id, { plannerAgentId: 'planner-1' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 1, 'the closed planner is asked once');
    assert.equal(f.delegated.planner[0]!.agentId, 'planner-1');
    assert.equal(f.delegated.deciders.length, 0, 'a closed planner that answers starts no decider');
    assert.equal(f.store.projectByKey('app')?.planner?.agentId, 'planner-1', 'a closed planner stays on the project');
    assert.equal(f.store.eventsAll('project:app').filter(event => event.kind === 'project_planner_missing_notified').length, 0);
    assert.equal(f.events('operator_question_applied').length, 1);
  } finally { await f.close(); }
});

test('a closed planner that gives no usable answer stays registered and falls through to a decider', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: DECIDER_RETURN, plannerClosed: true } });
  try {
    seedAppAndQueuePlanners(f);
    f.store.update(f.current().id, { plannerAgentId: 'planner-1' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 1, 'the closed planner is asked');
    assert.equal(f.delegated.planner[0]!.agentId, 'planner-1');
    assert.equal(f.store.projectByKey('app')?.planner?.agentId, 'planner-1', 'silence does not clear a closed planner');
    assert.equal(f.delegated.deciders.length, 1, 'then a decider answers');
    assert.match(f.events('operator_question_decided')[0]!.detail, /Decided by decider/);
  } finally { await f.close(); }
});

test('an archived project planner is cleared and delegated proof questions fall back to the Queue planner', async () => {
  const f = fixture({ responsible: true, delegates: { planner: PLANNER_MERGE, decider: null, plannerArchived: true } });
  try {
    seedAppAndQueuePlanners(f);
    f.store.update(f.current().id, { plannerAgentId: 'planner-1' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 1, 'the Queue planner receives the question once');
    assert.equal(f.delegated.planner[0]!.agentId, 'queue-planner');
    assert.equal(f.delegated.deciders.length, 0, 'an archived planner does not create a decider dead end');
    assert.equal(f.store.projectByKey('app')?.planner, null, 'the missing project planner is removed from the board state');
    assert.ok(f.store.eventsAll('project:app').some(event => event.kind === 'project_planner_missing_notified' && event.detail.startsWith('planner-1:')));
    assert.ok(f.prompts.some(item => item.agentId === 'queue-planner' && item.messageId === 'ns-project-planner-missing-app'));
    assert.equal(f.events('operator_question_applied').length, 1);
  } finally { await f.close(); }
});

test('a missing project planner is cleared and the Queue planner gets the notice and the question', async () => {
  const f = fixture({ responsible: true, delegates: { planner: PLANNER_MERGE, decider: null, plannerMissing: true } });
  try {
    seedAppAndQueuePlanners(f);
    f.store.update(f.current().id, { plannerAgentId: 'planner-1' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_applied').length > 0);
    assert.equal(f.delegated.planner.length, 1, 'the Queue planner receives the question once');
    assert.equal(f.delegated.planner[0]!.agentId, 'queue-planner');
    assert.equal(f.store.projectByKey('app')?.planner, null, 'the missing project planner is removed from the board state');
    assert.ok(f.store.eventsAll('project:app').some(event => event.kind === 'project_planner_missing_notified' && event.detail.startsWith('planner-1:')));
    assert.ok(f.prompts.some(item => item.agentId === 'queue-planner' && item.messageId === 'ns-project-planner-missing-app'));
    assert.equal(f.events('operator_question_applied').length, 1);
  } finally { await f.close(); }
});

test('a decider cannot leave a proof question held for a planner that just failed', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: 'Choice: Leave held for the planner\nReason: Needs a planner.', plannerArchived: true } });
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await proofWaitReport(f, () => pushMain(f));
    await settleUntil(f, () => f.events('operator_question_delegation_missed').length > 0);
    for (let pass = 0; pass < 20 && f.events('operator_question_decision').length === 0; pass++) await tick();
    assert.equal(f.delegated.answers.length, 0, 'the decider answer is not applied');
    assert.equal(f.events('operator_question_applied').length, 0);
    assert.ok(f.events('operator_question_delegation_missed').some(event => /decider .* could not decide because the planner just failed/.test(event.detail)));
    assert.ok(f.events('operator_question_delegation_missed').some(event => event.detail.includes('no delegated answer was produced; the question stays on its existing surface')));
    assert.equal(f.events('operator_question_answered').length, 0, 'the task question stays unanswered for the planner or board');
    assert.equal(f.asks.length, 1, 'the original task question remains available');
  } finally { await f.close(); }
});

test('a budget extension past twice the limit is delegated and records Tom’s default approval rule', async () => {
  const f = fixture({ responsible: true, delegates: { planner: 'Choice: Extend the budget\nReason: The task is close to done.', decider: 'Choice: Extend the budget\nReason: The task is close to done.' } });
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: join(f.dir, 'repo') }] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: 2 * LOW_TOKENS * 2 }));
    await f.report('ready_for_review');
    await f.settle(2);
    await settleUntil(f, () => f.events('operator_question_answered').length > 0);
    assert.ok(!f.current().resolution.stop);
    assert.match(f.events('operator_question')[0]!.detail, /kind budget/);
    assert.ok(f.delegated.planner.length >= 1, 'the planner answers a past-2x pause');
    assert.equal(f.delegated.deciders.length, 0, 'the decider is not needed after the planner answers');
    assert.ok(f.current().resolution.budgetExtensions >= 1, 'the delegated planner extension applies');
    assert.match(f.events('operator_question_decided')[0]!.detail, /Decided by planner/);
    assert.match(f.events('operator_question_decided')[0]!.detail, /approve by default, Tom 2026-11-03 — The task is close to done/);
    assert.match(f.events('budget_extended')[0]!.detail, /Delegated answer to Queue's question .*approve by default, Tom 2026-11-03/);
  } finally { await f.close(); }
});

test('a budget pause within twice the limit is delegable: a decider extends it once', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: 'Choice: Extend the budget\nReason: The task is close to done.' } });
  try {
    await revisionInFlight(f);
    f.store.updateRunUsage(f.run().id, () => ({ ...EMPTY_RUN_USAGE, turns: 1, reportedTurns: 1, inputTokens: LOW_TOKENS }));
    await f.report('ready_for_review');
    await settleUntil(f, () => f.events('operator_question_answered').length > 0);
    assert.match(f.events('operator_question')[0]!.detail, /kind budget/);
    assert.equal(f.delegated.deciders.length, 1);
    assert.equal(f.current().resolution.budgetExtensions, 1, 'the delegated extension adds one default increment');
    assert.notEqual(f.current().resolution.stop?.reason, 'budget');
  } finally { await f.close(); }
});

test('a source approval whose awaited proof is the brief\'s own runnable selector runs it through the proof route, with no question', async () => {
  const f = fixture({ responsible: true });
  try {
    const selector = 'effigy test unit -- test/runnable.test.ts';
    f.store.update(f.submitted.id, { proofExecution: { selector, inputs: [], role: 'author' } });
    seededSourceCheckout(f);
    await f.engine.wake();
    assert.equal(f.run().role, 'reviewer');
    const parkedTask = f.store.task(f.submitted.id);
    const oldHead = proofExecutionRecordSchema.parse({ runId: 'prior-head-proof', agentId: 'prior-proof-agent', workspaceId: 'workspace',
      profile: null, operationId: null, selector, inputs: [], repository: parkedTask.repository, prNumber: 41,
      branch: parkedTask.branch, head: 'f'.repeat(40), briefVersion: null, briefDigest: null,
      authorizedBy: { role: 'project_owner', caller: null, note: null }, activatedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(), status: 'passed', exitCode: 0, evidence: 'pass at an earlier head' });
    assert.equal(proofWaitApplies({ ...parkedTask, resolution: { ...parkedTask.resolution,
      review: { ...parkedTask.resolution.review!, sourceApproved: true, head: f.run().head,
        awaitingProofs: [{ proof: `Run ${selector} once at the approved head via the Queue proof route`, route: 'external' }] } }, proofExecutions: [oldHead] }), true,
    'a matching selector receipt at another head leaves the proof wait active');
    await f.report('blocked', { sourceApproved: true, awaitingProofs: [{ proof: `Run ${selector} once at the approved head via the Queue proof route`, route: 'external' }] });
    await settleUntil(f, () => f.events('runnable_proof_started').length > 0 || f.events('runnable_proof_refused').length > 0);
    assert.equal(f.events('runnable_proof_refused').length, 0, f.events('runnable_proof_refused').map(event => event.detail).join('\n'));
    assert.equal(f.events('runnable_proof_started').length, 1, 'the runnable proof starts once for this head');
    assert.equal(f.store.runs(f.submitted.id).filter(run => run.role === 'executor').length, 1, 'the proof executor is a Queue-created run');
    assert.equal(f.asks.length, 0, 'a runnable proof raises no question');
    const executor = f.run();
    assert.equal(executor.role, 'executor', 'the running turn is the proof executor');
    // The executor observes the exact head and reports its one selector passing.
    await f.report('proof_executed', { summary: `Ran ${selector} once at the approved head`,
      proofResult: { status: 'passed', selector, exitCode: 0, evidence: `${selector}: 2 passing` } });
    await f.settle(3);
    const spent = f.current().proofExecutions[0]!;
    assert.equal(spent.status, 'passed', 'the passing evidence is recorded on the one allowance');
    assert.equal(f.events('proof_review_ready').length, 1, 'the settled proof moves the task to an evidence-only review');
    assert.equal(f.current().resolution.stop?.reason, undefined, 'the awaiting-proof wait clears');
    assert.equal(f.run().role, 'reviewer', 'the retained review round dispatches a reviewer turn');
    assert.equal(f.asks.length, 0, 'no question at any point of the flow');
    assert.equal(f.events('runnable_proof_started').length, 1, 'the runnable proof starts once for this head');
    await settleUntil(f, () => false);
    assert.equal(f.events('runnable_proof_started').length, 1, 'a later pass at the same head starts nothing');
  } finally { await f.close(); }
});

test('automatic proof autorun skips docs-only heads only when the prior declaration is unchanged', async () => {
  const f = fixture({ responsible: true });
  try {
    const selector = 'effigy test unit -- test/runnable.test.ts';
    f.store.update(f.submitted.id, { proofExecution: { selector, inputs: [], role: 'author' } });
    seededSourceCheckout(f);
    const task = f.store.task(f.submitted.id);
    const oldHead = task.prHead!;
    const receipt = proofExecutionRecordSchema.parse({ runId: 'prior-doc-proof', agentId: 'proof-agent', workspaceId: 'workspace',
      profile: null, operationId: null, selector, inputs: [], repository: task.repository, prNumber: 41, branch: task.branch,
      head: oldHead, briefVersion: null, briefDigest: null, authorizedBy: { role: 'project_owner', caller: null, note: null },
      activatedAt: new Date().toISOString(), settledAt: new Date().toISOString(), status: 'failed', evidence: 'failed assertion' });
    f.store.update(task.id, { proofExecutions: [receipt] });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: task.directory!, encoding: 'utf8' }).trim();
    run('commit', '-q', '--allow-empty', '-m', 'empty change');
    const emptyHead = run('rev-parse', 'HEAD');
    assert.match((await docsOnlyProofAutorunSkip(f.store.task(task.id), emptyHead)) ?? '', /empty diff/,
      'an empty diff changes no byte a proof could read');

    writeFileSync(join(task.directory!, 'notes.md'), 'documentation only\n');
    run('add', 'notes.md'); run('commit', '-q', '-m', 'docs update');
    const docsHead = run('rev-parse', 'HEAD');
    assert.match((await docsOnlyProofAutorunSkip(f.store.task(task.id), docsHead)) ?? '', /docs-only/);

    writeFileSync(join(task.directory!, 'change.txt'), 'source changed\n');
    run('add', 'change.txt'); run('commit', '-q', '-m', 'source update');
    const sourceHead = run('rev-parse', 'HEAD');
    assert.equal(await docsOnlyProofAutorunSkip(f.store.task(task.id), sourceHead), null, 'a source path change permits a new run');

    f.store.update(task.id, { proofExecution: { selector, inputs: ['a'.repeat(64)], role: 'author' } });
    assert.equal(await docsOnlyProofAutorunSkip(f.store.task(task.id), docsHead), null, 'changed declared hashes permit a new run');
  } finally { await f.close(); }
});

test('automatic proof autorun waits for changed declared inputs to be re-declared', async () => {
  const f = fixture({ responsible: true });
  try {
    const selector = 'effigy test unit -- test/runnable.test.ts';
    seededSourceCheckout(f);
    const task = f.store.task(f.submitted.id);
    const run = (...args: string[]) => execFileSync('git', args, { cwd: task.directory!, encoding: 'utf8' }).trim();
    const oldBytes = 'input before\n';
    writeFileSync(join(task.directory!, 'proof-input.txt'), oldBytes);
    run('add', 'proof-input.txt'); run('commit', '-q', '-m', 'declare proof input');
    const priorHead = run('rev-parse', 'HEAD');
    const oldHash = createHash('sha256').update(oldBytes).digest('hex');
    const receipt = proofExecutionRecordSchema.parse({ runId: 'prior-input-proof', agentId: 'proof-agent', workspaceId: 'workspace',
      profile: null, operationId: null, selector, inputs: [oldHash], repository: task.repository, prNumber: 41,
      branch: task.branch, head: priorHead, briefVersion: null, briefDigest: null,
      authorizedBy: { role: 'project_owner', caller: null, note: null }, activatedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(), status: 'passed', exitCode: 0, evidence: 'pass' });
    f.store.update(task.id, { prHead: priorHead, proofExecution: { selector, inputs: [oldHash], role: 'author' }, proofExecutions: [receipt] });
    const newBytes = 'input after\n';
    writeFileSync(join(task.directory!, 'proof-input.txt'), newBytes);
    run('add', 'proof-input.txt'); run('commit', '-q', '-m', 'change proof input');
    const nextHead = run('rev-parse', 'HEAD');
    assert.match(await proofAutorunWaitingInputs(f.store.task(task.id), nextHead) ?? '', /declared input.*changed.*waiting for input re-declaration/);
    const newHash = createHash('sha256').update(newBytes).digest('hex');
    f.store.update(task.id, { proofExecution: { selector, inputs: [newHash], role: 'author' } });
    assert.equal(await proofAutorunWaitingInputs(f.store.task(task.id), nextHead), null,
      'a declaration updated to the new input hash permits the approved-head autorun');
  } finally { await f.close(); }
});

/**
 * The docs-skip routing scenarios' shared front: the automatic proof runs at the
 * seeded head and fails, the failed receipt returns the task to its worker, and
 * the worker returns readiness at a new exact head whose diff is exactly the
 * given paths. The retained reviewer has not judged the new head yet.
 */
async function failedProofWithReturnAt(f: ReturnType<typeof fixture>, paths: Record<string, string>) {
  const selector = 'effigy test unit -- test/runnable.test.ts';
  const wait = [{ proof: `Run ${selector} once at the approved head via the Queue proof route`, route: 'external' as const }];
  f.store.update(f.submitted.id, { proofExecution: { selector, inputs: [], role: 'author' } });
  seededSourceCheckout(f);
  // A second reviewed commit: a subsequent review round reads its range-diff
  // against main, and an empty old range cannot range-diff.
  const task0 = f.store.task(f.submitted.id);
  const git0 = (...args: string[]) => execFileSync('git', args, { cwd: task0.directory!, encoding: 'utf8' }).trim();
  writeFileSync(join(task0.directory!, 'second.txt'), 'the second reviewed change\n');
  git0('add', 'second.txt');
  git0('commit', '-q', '-m', 'the second reviewed change');
  const seededHead = git0('rev-parse', 'HEAD');
  git0('push', '-q', 'origin', `refs/heads/${task0.branch}:refs/heads/${task0.branch}`);
  f.store.update(f.submitted.id, { prHead: seededHead }, 'fixture_source_head');
  f.setHead(seededHead);
  // Review rounds read their integration base from the merge gate; the seeded
  // checkout proves it as the real main commit, never the planning digest.
  const mainHead = execFileSync('git', ['-C', join(f.dir, 'repo'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  f.store.update(f.submitted.id, { resolution: { ...f.store.task(f.submitted.id).resolution, mergeBase: mainHead } });
  (f.adapter as Adapter & Partial<ResolutionAdapter>).mergeGate = async () => ({
    head: execFileSync('git', ['-C', f.store.task(f.submitted.id).directory!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    base: mainHead, wait: '' });
  await f.engine.wake();
  assert.equal(f.run().role, 'reviewer');
  await f.report('blocked', { sourceApproved: true, awaitingProofs: wait });
  await settleUntil(f, () => f.events('runnable_proof_started').length > 0);
  assert.equal(f.events('runnable_proof_refused').length, 0, f.events('runnable_proof_refused').map(event => event.detail).join('\n'));
  assert.equal(f.events('runnable_proof_started').length, 1, 'the automatic proof runs once at the seeded head');
  await f.report('proof_executed', { proofResult: { status: 'failed', selector, exitCode: 1, evidence: `${selector}: 1 failing` } });
  assert.equal(f.events('proof_failure_returned_to_worker').length, 1, 'the failed receipt returns the task to its worker');
  await f.settle(2);
  const failed = f.current().proofExecutions.at(-1)!;
  assert.equal(failed.status, 'failed');
  const priorHead = failed.head;
  assert.equal(f.run().role, 'revision', f.current().reason);
  const task = f.store.task(f.submitted.id);
  const run = (...args: string[]) => execFileSync('git', args, { cwd: task.directory!, encoding: 'utf8' }).trim();
  for (const [path, body] of Object.entries(paths)) writeFileSync(join(task.directory!, path), body);
  run('add', '--', ...Object.keys(paths));
  run('commit', '-q', '-m', 'the returned change');
  const nextHead = run('rev-parse', 'HEAD');
  run('push', '-q', 'origin', `refs/heads/${task.branch}:refs/heads/${task.branch}`);
  f.setHead(nextHead);
  await f.report('ready_for_review', { head: nextHead });
  await f.settle(1);
  assert.equal(f.current().prHead, nextHead, 'the returned head is the task PR head');
  return { failed, wait, priorHead, nextHead };
}

test('a docs-only head after a failed proof returns the task to its worker with the earlier failure and spends no execution', async () => {
  const f = fixture({ responsible: true });
  try {
    const { failed, priorHead, nextHead, wait } = await failedProofWithReturnAt(f, { 'notes.md': 'documentation only\n' });
    assert.notEqual(nextHead, priorHead);
    await f.settle(1);
    assert.equal(f.run().role, 'reviewer', f.current().reason);
    await f.report('blocked', { sourceApproved: true, awaitingProofs: wait });
    await settleUntil(f, () => f.events('proof_autorun_skipped').length > 0);
    assert.equal(f.asks.length, 0, 'the skip routes the task instead of asking the operator');
    assert.equal(f.events('proof_autorun_skipped').length, 1);
    assert.ok(f.events('proof_autorun_skipped')[0]!.detail.startsWith(`${nextHead}: `), f.events('proof_autorun_skipped')[0]!.detail);
    assert.match(f.events('proof_autorun_skipped')[0]!.detail, new RegExp(`docs-only changes since proof execution at ${priorHead}`));
    assert.equal(f.events('runnable_proof_started').length, 1, 'no automatic execution at the docs-only head');
    const task = f.current();
    const executors = f.store.runs(task.id).filter(run => run.role === 'executor');
    assert.equal(executors.length, 1, 'the failed run is the only execution');
    assert.equal(executors[0]!.head, priorHead);
    assert.equal(task.proofExecutions.length, 1, 'the one allowance stays spent at the earlier head');
    assert.equal(task.phase, 'changes_requested', task.reason);
    assert.match(task.reason, /Documentation-only head/);
    assert.ok(task.reason?.includes(failed.runId), task.reason);
    assert.match(task.reason ?? '', /failed and remains the evidence/);
    assert.ok(task.resolution.pendingWorkerInstruction?.includes(failed.runId), task.resolution.pendingWorkerInstruction ?? '');
    assert.match(task.resolution.pendingWorkerInstruction ?? '', /failed/);
    assert.equal(task.resolution.review?.awaitingProofs, undefined, 'the old proof wait no longer parks the task');
    await f.settle(2);
    assert.equal(f.events('proof_autorun_skipped').length, 1, 'a later pass at the same head skips nothing again');
    assert.equal(f.events('runnable_proof_started').length, 1);
    assert.equal(f.run().role, 'revision', f.current().reason);
    assert.ok(f.run().instruction?.includes(failed.runId), f.run().instruction ?? '');
    assert.match(f.run().instruction ?? '', /failed/);
  } finally { await f.close(); }
});

test('a source change since the failed proof spends one new automatic execution at the new head', async () => {
  const f = fixture({ responsible: true });
  try {
    const { wait, nextHead } = await failedProofWithReturnAt(f, { 'change.txt': 'source changed\n' });
    await f.settle(1);
    assert.equal(f.run().role, 'reviewer', f.current().reason);
    await f.report('blocked', { sourceApproved: true, awaitingProofs: wait });
    await settleUntil(f, () => f.store.runs(f.submitted.id).filter(run => run.role === 'executor').length === 2);
    assert.equal(f.events('proof_autorun_skipped').length, 0, 'a source change is never skipped');
    assert.equal(f.events('runnable_proof_started').length, 2, 'one execution per source-changed head');
    const second = f.store.runs(f.submitted.id).filter(run => run.role === 'executor').at(-1)!;
    assert.equal(second.head, nextHead, 'the new execution runs at the new exact head');
    assert.equal(f.asks.length, 0, 'the automatic route still raises no question');
  } finally { await f.close(); }
});

test('a non-sourceApproved verdict at a docs-only head neither auto-runs nor records a skip', async () => {
  const f = fixture({ responsible: true });
  try {
    await failedProofWithReturnAt(f, { 'notes.md': 'documentation only\n' });
    await f.settle(1);
    assert.equal(f.run().role, 'reviewer', f.current().reason);
    await f.report('changes_required');
    await f.settle(3);
    assert.equal(f.current().resolution.review?.status, 'changes_required');
    assert.notEqual(f.current().resolution.review?.sourceApproved, true);
    assert.equal(f.events('proof_autorun_skipped').length, 0, 'a verdict that does not approve the source never auto-runs');
    assert.equal(f.events('runnable_proof_started').length, 1, 'only the earlier head executed');
    assert.equal(f.store.runs(f.submitted.id).filter(run => run.role === 'executor').length, 1);
    assert.equal(f.asks.length, 0);
  } finally { await f.close(); }
});

test('an explicit owner proof activation still runs at a docs-only head the automatic route skipped', async () => {
  const f = fixture({ responsible: true });
  try {
    const { wait, nextHead } = await failedProofWithReturnAt(f, { 'notes.md': 'documentation only\n' });
    await f.settle(1);
    assert.equal(f.run().role, 'reviewer', f.current().reason);
    await f.report('blocked', { sourceApproved: true, awaitingProofs: wait });
    await settleUntil(f, () => f.events('proof_autorun_skipped').length > 0);
    assert.equal(f.events('runnable_proof_started').length, 1, 'the automatic route skipped the docs-only head');
    assert.equal(f.asks.length, 0, 'the skip routes the task instead of asking');
    assert.equal(f.current().phase, 'changes_requested', f.current().reason);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.submitted.id, version: f.store.task(f.submitted.id).version,
      action: 'proof', reason: 'Run the declared proof deliberately at the docs-only head', caller: OPERATOR_BOARD_CALLER }));
    const executors = f.store.runs(f.submitted.id).filter(run => run.role === 'executor');
    assert.equal(executors.length, 2, 'the explicit activation dispatches the proof executor');
    assert.equal(executors.at(-1)!.head, nextHead, 'the explicit execution runs at the exact docs-only head');
    assert.equal(f.events('proof_autorun_skipped').length, 1, 'the owner run is a choice, not an automatic one');
  } finally { await f.close(); }
});

test('a decider that fails to answer is recorded as unknown, asks nothing again, and leaves the question with the operator', async () => {
  const f = fixture({ responsible: true, delegates: { planner: null, decider: null, deciderError: 'decider could not be created' } });
  try {
    await proofWaitReport(f);
    await settleUntil(f, () => f.events('operator_question_delegation_unknown').length > 0);
    assert.equal(f.delegated.deciders.length, 1, 'one decider was started');
    assert.match(f.events('operator_question_delegation_unknown')[0]!.detail, /decider could not be created/);
    assert.equal(f.delegated.answers.length, 0, 'nothing answers the native question');
    assert.equal(f.events('operator_question_applied').length, 0);
    assert.equal(f.asks.length, 1, 'the operator still has the one native question');
    await f.settle(3);
    assert.equal(f.delegated.deciders.length, 1, 'an unknown delegation is never re-decided');
  } finally { await f.close(); }
});

test('an owner move past the joint question releases the task, and the worker gets its instruction', async () => {
  const f = fixture({ responsible: true });
  try {
    await f.reviews(3);
    await f.settle(2);
    assert.equal(f.current().resolution.stop?.reason, 'responsible_question');
    const revisions = f.sends.filter(item => item.role === 'revision').length;
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.current().id, version: f.current().version, action: 'move', to: 'work',
      instruction: 'Delete the one unsupported sentence', reason: 'The owner decided', caller: OPERATOR_BOARD_CALLER }));
    assert.equal(f.events('responsible_question_superseded').length, 1);
    await f.settle(2);
    assert.notEqual(f.current().resolution.stop?.reason, 'responsible_question', 'a superseded question holds nothing');
    assert.notEqual(f.current().reason, RESPONSIBLE_QUESTION_WAIT);
    assert.equal(f.sends.filter(item => item.role === 'revision').length, revisions + 1, 'the worker runs');
    assert.match(f.run().instruction ?? '', /Delete the one unsupported sentence/);
    assert.equal(f.asks.length, 1, 'the question is not raised again');
  } finally { await f.close(); }
});
