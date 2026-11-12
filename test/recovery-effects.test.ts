/**
 * Spec 012/016/033/039/049: the shared recovery effect-state projection.
 *
 * One read-only classification answers "does this task still owe this effect?"
 * for every control path and for the owner-facing detail projection. Settled
 * historical records are idempotency evidence; in-flight, uncertain and
 * contradictory records remain blockers with a precise identity and reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, digest, operationIdForKey, operationInputHash } from '../core/store/store';
import { classifyReviewPublication, reviewPublicationKey } from '../core/review/review-publication';
import { recoveryEffects, blockingRecoveryEffects, blockingRecoveryEffectsRefusal, isBlockingRecoveryEffect, blockingTaskOperations, observedHostEffectEvidence, reviewEffectWait } from '../core/recovery/recovery-effects';
import { verifyEnclosingOperation } from '../core/planning/enclosing-operation';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { reviewPublicationBody } from '../core/forge/index';
import { hookRecordSchema } from '../shared/hooks';
import { queueOperationSchema } from '../shared/operations';
import { submissionSchema, runSchema, noticeSchema, taskControlInputSchema, type Completion, type Run, type Task } from '../shared/contracts';

const head = 'a'.repeat(40), base = 'b'.repeat(40), at = '2026-01-01T00:00:00.000Z';

function fixture() {
  const store = new Store(':memory:');
  const task = store.insert(submissionSchema.parse({ submissionId: 'effect-task', title: 'Effects', repoPath: '/fixture', planningCommit: base, handoffPath: 'brief.md', originAgentId: 'origin' }), 'host', 'brief', base);
  return { store, task };
}

function reviewRun(store: Store, task: Task, overrides: Partial<Run> = {}): Run {
  store.putRun(runSchema.parse({
    id: 'review-run', taskId: task.id, role: 'reviewer', generation: 1, head, base,
    agentId: 'review-agent', workspaceId: 'workspace', profile: null, status: 'finished',
    createdAt: at, lastObservedAt: null, active: false, idleSince: null, completion: null, released: true,
    ...overrides,
  }));
  return store.run(overrides.id ?? 'review-run')!;
}


/** Insert an accepted receipt for a completion exactly as the callback path does. */
function accept(store: Store, taskId: string, runId: string, completion: Completion) {
  store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)')
    .run(completion.eventId, taskId, runId, digest(JSON.stringify(completion)), JSON.stringify({ accepted: true, eventId: completion.eventId }));
}

const reviewCompletion = (taskId: string, runId: string, status: 'changes_required' | 'ready_to_merge', extra: Partial<Completion> = {}): Completion => ({
  eventId: `${runId}-event`, taskId, runId, status, summary: 'Historical findings', head,
  reviewText: 'Substantive historical findings: fix the links', ...extra,
});

test('publication classification separates absent, settled, in-flight, uncertain and invalid', () => {
  const { store, task } = fixture();
  try {
    // absent: no key
    const bare = reviewRun(store, task, { id: 'bare' });
    assert.equal(classifyReviewPublication(store, task, bare).state, 'absent');
    assert.equal(recoveryEffects(store, task, { kinds: ['publication'], runId: 'bare' }).length, 0);

    // in-flight: intent with a positive ID on a run that has not finished
    const live = reviewRun(store, task, { id: 'live', status: 'running', released: false,
      completion: reviewCompletion(task.id, 'live', 'changes_required', { reviewCommentId: 11 }) });
    store.setMeta(reviewPublicationKey('live'), { hash: 'a'.repeat(64), commentId: 11 });
    assert.equal(classifyReviewPublication(store, task, live).state, 'in-flight');

    // uncertain: intent recorded, no positive ID
    const intent = reviewRun(store, task, { id: 'intent' });
    store.setMeta(reviewPublicationKey('intent'), { hash: 'b'.repeat(64) });
    assert.equal(classifyReviewPublication(store, task, intent).state, 'uncertain');

    // settled: authentic accepted report + enrichment + exact body hash
    const settled = reviewRun(store, task, { id: 'settled',
      completion: reviewCompletion(task.id, 'settled', 'changes_required', { reviewCommentId: 41 }) });
    accept(store, task.id, 'settled', reviewCompletion(task.id, 'settled', 'changes_required'));
    const body = reviewPublicationBody(task, settled, 'changes_required', 'Substantive historical findings: fix the links');
    store.setMeta(reviewPublicationKey('settled'), { hash: digest(body), commentId: 41 });
    assert.equal(classifyReviewPublication(store, task, settled).state, 'settled');

    // invalid: an ID that the accepted completion does not carry
    const mismatched = reviewRun(store, task, { id: 'mismatched',
      completion: reviewCompletion(task.id, 'mismatched', 'changes_required', { reviewCommentId: 41 }) });
    accept(store, task.id, 'mismatched', reviewCompletion(task.id, 'mismatched', 'changes_required'));
    store.setMeta(reviewPublicationKey('mismatched'), { hash: digest(body), commentId: 99 });
    assert.equal(classifyReviewPublication(store, task, mismatched).state, 'invalid');

    // invalid: a fake completion written directly onto the run with no receipt
    const fake = reviewRun(store, task, { id: 'fake',
      completion: reviewCompletion(task.id, 'fake', 'changes_required', { reviewCommentId: 7 }) });
    store.setMeta(reviewPublicationKey('fake'), { hash: digest(reviewPublicationBody(task, fake, 'changes_required', 'Substantive historical findings: fix the links')), commentId: 7 });
    assert.equal(classifyReviewPublication(store, task, fake).state, 'invalid');

    // invalid: both a formal review ID and a comment ID
    const both = reviewRun(store, task, { id: 'both',
      completion: reviewCompletion(task.id, 'both', 'ready_to_merge', { reviewId: 5 }) });
    store.setMeta(reviewPublicationKey('both'), { hash: digest(body), reviewId: 5, commentId: 5 });
    assert.equal(classifyReviewPublication(store, task, both).state, 'invalid');

    const effects = recoveryEffects(store, task, { kinds: ['publication'] });
    assert.deepEqual(effects.map(effect => effect.state).sort(), ['in-flight', 'invalid', 'invalid', 'invalid', 'settled', 'uncertain']);
    assert.ok(effects.every(effect => effect.taskId === task.id && effect.identity === effect.runId));

    // A publication key under a completion identity with no reviewer run row can
    // never settle; it stays an unbacked uncertain effect.
    store.update(task.id, { runId: 'worker-completion-run' });
    store.setMeta(reviewPublicationKey('worker-completion-run'), { hash: 'f'.repeat(64), commentId: 3 });
    const detached = recoveryEffects(store, store.task(task.id), { kinds: ['publication'], runId: 'worker-completion-run' });
    assert.equal(detached.length, 1);
    assert.equal(detached[0]!.state, 'uncertain');
    assert.equal(detached[0]!.publication, null);
  } finally { store.close(); }
});

test('publication intent at a previous head remains history after the PR advances', () => {
  const { store, task } = fixture();
  try {
    const run = reviewRun(store, task, { id: 'old' });
    store.setMeta(reviewPublicationKey(run.id), { hash: 'c'.repeat(64) });
    const current = { ...task, prHead: 'd'.repeat(40) };
    assert.equal(classifyReviewPublication(store, current, run).state, 'superseded');
    assert.deepEqual(blockingRecoveryEffects(store, current, { kinds: ['publication'] }), []);
    assert.ok(store.getMeta(reviewPublicationKey(run.id)));
    assert.equal(classifyReviewPublication(store, { ...task, prHead: head }, run).state, 'uncertain');
  } finally { store.close(); }
});

test('a superseded uncertain publication is history once a later same-head verdict is applied', () => {
  const { store, task } = fixture();
  try {
    // The live shape (task 666, run 9981c3ef): the retained intent stayed
    // uncertain after a GitHub outage while the owner's reviewer restart
    // produced a later run that published and applied its verdict at the same
    // head. That verdict answers for the head; the earlier intent is history.
    const parked = reviewRun(store, task, { id: 'parked' });
    store.setMeta(reviewPublicationKey('parked'), { hash: 'c'.repeat(64) });
    assert.equal(classifyReviewPublication(store, task, parked).state, 'uncertain');

    // A released run that lost its accepted completion: same uncertain family.
    const lost = reviewRun(store, task, { id: 'lost', createdAt: '2026-01-01T00:30:00.000Z' });
    store.setMeta(reviewPublicationKey('lost'), { hash: 'e'.repeat(64), reviewId: 21 });
    assert.equal(classifyReviewPublication(store, task, lost).state, 'uncertain');

    const later = reviewRun(store, task, { id: 'later', createdAt: '2026-01-01T01:00:00.000Z' });
    const laterCompletion = reviewCompletion(task.id, 'later', 'ready_to_merge', { reviewId: 5767110790 });
    store.putRun({ ...store.run('later')!, completion: laterCompletion });
    accept(store, task.id, 'later', laterCompletion);
    store.setMeta(reviewPublicationKey('later'),
      { hash: digest(reviewPublicationBody(task, store.run('later')!, 'ready_to_merge', laterCompletion.reviewText!)), reviewId: 5767110790 });
    store.event(task.id, 'review_result_applied', 'later');

    const superseded = classifyReviewPublication(store, task, parked);
    assert.equal(superseded.state, 'superseded');
    assert.deepEqual(superseded.supersededBy, { runId: 'later', publicationId: 5767110790 });
    assert.match(superseded.reason, /later/);
    assert.equal(isBlockingRecoveryEffect(recoveryEffects(store, task, { kinds: ['publication'], runId: 'parked' })[0]!), false);
    assert.deepEqual(blockingRecoveryEffects(store, task, { kinds: ['publication'], runId: 'parked' }), []);
    assert.equal(classifyReviewPublication(store, task, store.run('later')!).state, 'settled', 'the later verdict stays settled credit');
    assert.ok(!blockingRecoveryEffects(store, task, { kinds: ['publication'] }).length, 'nothing blocks the ordinary merge turn');

    // The released run that lost its accepted completion is superseded the same way.
    const lostClassification = classifyReviewPublication(store, task, lost);
    assert.equal(lostClassification.state, 'superseded');
    assert.deepEqual(lostClassification.supersededBy, { runId: 'later', publicationId: 5767110790 });
  } finally { store.close(); }
});

test('an uncertain publication keeps blocking without a later applied same-head verdict', () => {
  const { store, task } = fixture();
  try {
    const parked = reviewRun(store, task, { id: 'parked' });
    store.setMeta(reviewPublicationKey('parked'), { hash: 'c'.repeat(64) });
    const body = (id: string, reviewId: number, overrides: Partial<Run> = {}, text = 'Substantive historical findings: fix the links') => {
      const run = reviewRun(store, task, { id, createdAt: '2026-01-01T01:00:00.000Z', ...overrides });
      const completion = reviewCompletion(task.id, id, 'ready_to_merge', { reviewId, ...(overrides.head ? { head: overrides.head } : {}) });
      store.putRun({ ...store.run(id)!, completion });
      accept(store, task.id, id, completion);
      store.setMeta(reviewPublicationKey(id), { hash: digest(reviewPublicationBody(task, store.run(id)!, 'ready_to_merge', completion.reviewText!)), reviewId });
      return run;
    };

    // A later run whose publication landed but whose verdict Queue never applied
    // does not answer for the head.
    body('unapplied', 7);
    // A later applied verdict from a fresh reviewer (another agent) is not the
    // same retained reviewer's answer.
    body('fresh', 9, { agentId: 'fresh-reviewer', createdAt: '2026-01-01T02:00:00.000Z' });
    store.event(task.id, 'review_result_applied', 'fresh');
    // A later applied verdict at a different head proves nothing for this head.
    body('moved', 11, { head: 'd'.repeat(40), createdAt: '2026-01-01T03:00:00.000Z' });
    store.event(task.id, 'review_result_applied', 'moved');

    assert.equal(classifyReviewPublication(store, task, parked).state, 'uncertain');
    const blocking = blockingRecoveryEffects(store, task, { kinds: ['publication'], runId: 'parked' });
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]!.state, 'uncertain');
    assert.match(blockingRecoveryEffectsRefusal(store, task, { kinds: ['publication'], runId: 'parked' })!,
      /publication parked is uncertain: retained publication intent has no positive publication ID/);
  } finally { store.close(); }
});

test('operations, hooks, merge response, validation, delivery and notice effects classify by authentic state', () => {
  const { store, task } = fixture();
  try {
    store.putOperation(queueOperationSchema.parse({ id: 'c'.repeat(64), key: 'pending-key', kind: 'task_control', inputHash: 'a'.repeat(64), state: 'pending', taskId: task.id, expectedVersion: null, repoPath: '/fixture', submissionId: null, createdAt: at, startedAt: null, settledAt: null, attempts: 0, diagnostic: '', result: null, effect: null }));
    store.putOperation(queueOperationSchema.parse({ id: 'd'.repeat(64), key: 'attention-key', kind: 'task_control', inputHash: 'a'.repeat(64), state: 'needs_attention', taskId: task.id, expectedVersion: null, repoPath: '/fixture', submissionId: null, createdAt: at, startedAt: null, settledAt: null, attempts: 0, diagnostic: '', result: null, effect: null }));
    const hook = hookRecordSchema.parse({ id: 'hook', taskId: task.id, hookId: 'generic', event: 'task.pre_dispatch', eventId: 'e'.repeat(48), occurrence: 1, mode: 'read_only', delivery: 'required', state: 'running',
      manifest: { path: '.paseo/queue.json', commit: base, digest: `sha256:${'a'.repeat(64)}` }, program: { kind: 'repository', executable: { path: '.paseo/hooks/policy', commit: base, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
      instruction: null, baseBranch: 'main', baseCommit: base, attempt: 1, timeoutMs: 30000, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, eventDigest: 'b'.repeat(64), eventPayload: null, workspace: null, processId: null, result: null, commit: null, remote: null, summary: '', error: '', createdAt: at, updatedAt: at, reconciledAt: null });
    store.putHookEvent(hook);
    store.putNotice(noticeSchema.parse({ id: 'intent-notice', taskId: task.id, agentId: 'origin', kind: 'attention', status: 'intent', error: '', text: 'attention' }));

    const kinds = recoveryEffects(store, task, { kinds: ['operation', 'hook', 'attention-notice'] });
    assert.deepEqual(kinds.map(effect => [effect.kind, effect.state]).sort(), [['attention-notice', 'in-flight'], ['hook', 'in-flight'], ['operation', 'in-flight'], ['operation', 'uncertain']]);

    // A settled publication on a released run is not blocking.
    const settled = reviewRun(store, task, { id: 'settled', completion: reviewCompletion(task.id, 'settled', 'changes_required', { reviewCommentId: 3 }) });
    accept(store, task.id, 'settled', reviewCompletion(task.id, 'settled', 'changes_required'));
    store.setMeta(reviewPublicationKey('settled'), { hash: digest(reviewPublicationBody(task, settled, 'changes_required', 'Substantive historical findings: fix the links')), commentId: 3 });
    assert.ok(!blockingRecoveryEffects(store, task, { kinds: ['publication'], runId: 'settled' }).length);
    assert.equal(isBlockingRecoveryEffect(recoveryEffects(store, task, { kinds: ['publication'], runId: 'settled' })[0]!), false);
  } finally { store.close(); }
});

test('a historical fence refusal row owes nothing; a real uncertain task control still blocks', () => {
  const { store, task } = fixture();
  try {
    const row = (char: string, diagnostic: string, extra: object = {}) => store.putOperation(queueOperationSchema.parse({ id: char.repeat(64), key: `key-${char}`, kind: 'task_control', inputHash: 'a'.repeat(64), state: 'needs_attention', taskId: task.id, expectedVersion: null, repoPath: '/fixture', submissionId: null, createdAt: at, startedAt: at, settledAt: at, attempts: 1, diagnostic, result: null, effect: null, ...extra }));
    row('1', 'Task execution participants or effects are not settled: publication p is uncertain: retained publication intent has no positive publication ID');
    row('2', 'Task execution participants or effects changed during external merge proof: operation o is uncertain');
    row('3', 'operation o remains uncertain: task operation o is needs_attention; no effect-specific observer can yet settle it');
    assert.deepEqual(blockingRecoveryEffects(store, task, { kinds: ['operation'] }), []);
    // A real unknown outcome, or a row whose send boundary started, still blocks.
    row('4', 'Unknown delivery: the connection closed');
    row('5', 'Task execution participants or effects are not settled: operation o', { preSendBoundaryStartedAt: at });
    assert.deepEqual(blockingRecoveryEffects(store, task, { kinds: ['operation'] }).map(effect => effect.identity).sort(), ['4'.repeat(64), '5'.repeat(64)]);
  } finally { store.close(); }
});

test('a base-advance-superseded hook occurrence is history only once its renewal lands', () => {
  const { store, task } = fixture();
  try {
    // One gate, two occurrences. The renewal (task 620) settles the old record
    // as `failed` with a baseAdvance mark precisely so the fresh emission
    // answers for the moved base; the projection must skip that old record
    // only when the newer occurrence exists, and compare occurrences by their
    // durable record id — hookEvents re-parses on every call, so object
    // identity never matches (review 5754555082).
    const hookRecord = (overrides: Record<string, unknown>) => hookRecordSchema.parse({
      id: 'hook-record', taskId: task.id, hookId: 'policy', event: 'task.pre_dispatch', eventId: 'e'.repeat(48), occurrence: 1,
      mode: 'read_only', delivery: 'required', state: 'failed',
      manifest: { path: '.paseo/queue.json', commit: base, digest: `sha256:${'a'.repeat(64)}` },
      program: { kind: 'repository', executable: { path: '.paseo/hooks/policy', commit: base, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
      instruction: null, baseBranch: 'main', baseCommit: base, attempt: 1, timeoutMs: 30000, maxOutputBytes: 65536,
      allowedPaths: [], commitSubject: null, eventDigest: 'b'.repeat(64), eventPayload: null, workspace: null, processId: null,
      result: null, commit: null, remote: null, summary: '', error: '', createdAt: at, updatedAt: at, reconciledAt: null, ...overrides });

    // A lone superseded occurrence with no renewal still holds: nothing yet
    // answers for the moved base, so the fence stays.
    store.putHookEvent(hookRecord({ id: 'lone', eventId: 'd'.repeat(48), baseAdvance: { from: base, to: head, at } }));
    const lone = recoveryEffects(store, task, { kinds: ['hook'] });
    assert.deepEqual(lone.map(effect => [effect.kind, effect.state]), [['hook', 'uncertain']]);
    assert.equal(lone[0]!.identity, 'lone');

    // The renewal lands: the newer occurrence of the same gate answers with a
    // settled result, so neither occurrence lists as a blocking effect.
    store.putHookEvent(hookRecord({ id: 'renewed', eventId: 'f'.repeat(48), occurrence: 2, state: 'result',
      baseAdvance: { from: base, to: head, at },
      result: { schema: 'paseo.queue.hook-result.v1', eventId: 'f'.repeat(48), outcome: 'ok', summary: 'clean at the new base', metadata: {}, changedPaths: [], commitSubjectSuffix: null } }));
    assert.deepEqual(recoveryEffects(store, task, { kinds: ['hook'] }), []);
  } finally { store.close(); }
});

test('the shared enclosing-operation verifier excludes only the exact running control', () => {
  const { store, task } = fixture();
  try {
    const input = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'cancel', reason: 'Fixture cancellation reason' });
    const { key, payload } = taskControlOperation(input);
    const id = operationIdForKey(key);
    const put = (state: 'pending' | 'running' | 'succeeded' | 'needs_attention', overrides: Record<string, unknown> = {}) => store.putOperation(queueOperationSchema.parse({
      id, key, kind: 'task_control', inputHash: operationInputHash(payload), state, taskId: task.id, expectedVersion: input.version,
      repoPath: null, submissionId: null, createdAt: at, startedAt: state === 'pending' ? null : at,
      settledAt: state === 'succeeded' ? at : null, attempts: 0, diagnostic: '', result: null, effect: null, ...overrides,
    }), payload);

    put('running');
    const verified = verifyEnclosingOperation(store, input, id);
    assert.equal(verified?.operationId, id, 'the exact running control is excluded');
    assert.equal(blockingRecoveryEffects(store, task, { enclosing: verified, kinds: ['operation'] }).length, 0,
      'the projection excludes only the verified enclosing operation');
    put('pending');
    assert.equal(verifyEnclosingOperation(store, input, id), undefined, 'a pending operation is not executing');
    put('succeeded');
    assert.equal(verifyEnclosingOperation(store, input, id), undefined, 'a settled operation is history');
    put('needs_attention', { diagnostic: 'Workspace creation is uncertain; host listing could not prove completion' });
    assert.equal(verifyEnclosingOperation(store, input, id), undefined, 'an uncertain operation is not executing');
    const uncertain = recoveryEffects(store, task, { kinds: ['operation'] })[0]!;
    assert.equal(uncertain.identity, id);
    assert.match(uncertain.reason, /Workspace creation is uncertain/);
    store.putNotice(noticeSchema.parse({id:'attention-1',taskId:task.id,agentId:'origin',recipientAgentId:'origin',workspaceId:null,
      sources:[],originEntry:true,kind:'attention',status:'uncertain',error:'delivery unknown',text:'Queue needs attention'}));
    const refusal=blockingRecoveryEffectsRefusal(store,store.task(task.id),{noticeKinds:'all'});
    assert.match(refusal??'',new RegExp(`operation ${id} is uncertain: .*Workspace creation is uncertain`));
    assert.match(refusal??'',/attention-notice attention-1 is uncertain: attention notice attention-1 delivery is uncertain/);
    put('running', { expectedVersion: task.version + 1 });
    assert.equal(verifyEnclosingOperation(store, input, id), undefined, 'a stale version excludes nothing');
    put('running', { taskId: 'other-task' });
    assert.equal(verifyEnclosingOperation(store, input, id), undefined, 'a foreign task excludes nothing');
    put('running');
    const other = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'cancel', reason: 'A different cancellation reason' });
    assert.equal(verifyEnclosingOperation(store, other, id), undefined, 'a mismatched payload excludes nothing');
    assert.equal(verifyEnclosingOperation(store, input, undefined), undefined, 'no internal context excludes nothing');
    assert.equal(verifyEnclosingOperation(store, input, 'f'.repeat(64)), undefined, 'an unknown id excludes nothing');
  } finally { store.close(); }
});


/**
 * Nucleus#1159: an uncertain host-effect control the task has since answered is
 * not a blocker. Later evidence (a binding after the control was accepted, then
 * a run used in that workspace) answers it; nothing else does.
 */
test('a host-effect operation answered by later evidence stops blocking, and nothing else does', () => {
  const { store, task: inserted } = fixture();
  try {
    const accepted = new Date(Date.now() - 60_000).toISOString();
    const task = store.update(inserted.id, { workspaceIntent: true, workspaceId: 'workspace', directory: '/worktree' });
    const input = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'restart', reason: 'Recover the worker' });
    const { key, payload } = taskControlOperation(input), id = operationIdForKey(key);
    store.putOperation(queueOperationSchema.parse({ id, key, kind: 'task_control', inputHash: operationInputHash(payload),
      state: 'needs_attention', taskId: task.id, expectedVersion: input.version, repoPath: null, submissionId: null,
      createdAt: accepted, startedAt: accepted, settledAt: accepted, attempts: 1,
      diagnostic: 'Host delivery is unknown; command was not resent; command project.create', result: null,
      effect: { kind: 'task_control', target: 'restart', intentAt: accepted, status: 'uncertain', result: null, resultAt: null } }), payload);
    // Unknown delivery with no later evidence is a blocker, and a gate reads it.
    assert.equal(observedHostEffectEvidence(store, store.task(task.id), store.operation(id)!), null);
    assert.deepEqual(blockingRecoveryEffects(store, store.task(task.id), { kinds: ['operation'] }).map(effect => effect.identity), [id]);
    assert.deepEqual(blockingTaskOperations(store, store.task(task.id)).map(operation => operation.id), [id],
      'a phase gate refuses on it');
    // A binding alone is not proof the thread in it was created.
    store.event(task.id, 'workspace_created', 'workspace');
    assert.equal(observedHostEffectEvidence(store, store.task(task.id), store.operation(id)!), null);
    assert.equal(blockingTaskOperations(store, store.task(task.id)).length, 1);
    // A run created in that workspace afterwards is.
    store.putRun(runSchema.parse({ id: 'revision-used', taskId: task.id, role: 'revision', generation: 1, head, base,
      agentId: 'revision-agent', workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    const evidence = observedHostEffectEvidence(store, store.task(task.id), store.operation(id)!)!;
    assert.match(evidence, /workspace workspace was bound at \/worktree after this control was accepted/);
    assert.match(evidence, /revision run revision-used started there/);
    const projected = recoveryEffects(store, store.task(task.id), { kinds: ['operation'] })[0]!;
    assert.equal(projected.state, 'superseded', 'the projection is history, not a fence');
    assert.match(projected.reason, /answered by later evidence/);
    assert.deepEqual(blockingRecoveryEffects(store, store.task(task.id), { kinds: ['operation'] }), []);
    assert.deepEqual(blockingTaskOperations(store, store.task(task.id)), []);
    // The projection is a read: the operation row keeps its own recorded state.
    assert.equal(store.operation(id)?.state, 'needs_attention');
  } finally { store.close(); }
});

/** The blocked-review wait is Queue's own sentence on both sides, so the reader tracks it. */
test('the blocked-review wait is read from the stop Queue itself records', () => {
  const { store, task } = fixture();
  try {
    const refusal = 'operation a is uncertain: task operation a (task_control) is needs_attention: Host delivery is unknown';
    const stopFor = (detail: string, reason: 'lifecycle' | 'operator_needed' = 'lifecycle') => store.update(task.id,
      { resolution: { ...store.task(task.id).resolution, stop: { reason, detail, since: at, suggestedVerbs: [] } } }, 'fixture_stop', detail);
    assert.deepEqual(reviewEffectWait(stopFor(`Ordinary review waits for ${refusal}; settle it with retry_effect before continuing`)),
      { since: at, detail: `Ordinary review waits for ${refusal}; settle it with retry_effect before continuing` });
    assert.ok(reviewEffectWait(stopFor(`Review-entry waits for ${refusal}; settle it with retry_effect before continuing`)));
    assert.equal(reviewEffectWait(stopFor(`Ordinary review waits for ${refusal}; settle it with retry_effect before continuing`, 'operator_needed')), null,
      'the attention record is not the wait it replaced');
    assert.equal(reviewEffectWait(stopFor('Another unresolved task operation fences reviewer continuation')), null);
  } finally { store.close(); }
});
