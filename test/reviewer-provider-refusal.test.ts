import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import type { TimelineEntry, TimelinePage } from '../core/recovery/stall';
import { detectReviewerProviderRefusal, isPromptTooLargeError, timelineDispatchState } from '../core/recovery/provider-refusal';

/**
 * Spec 016: the exact callback-free reviewer provider refusal.
 *
 * A reviewer whose provider plan/quota is exhausted answers its own dispatch
 * turn with a terminal refusal and never reports. These fixtures prove Queue
 * records that refusal from the reviewer's own identity-bound timeline, marks
 * only its subscription group unavailable, and re-routes to one eligible
 * independent reader; partial, quoted, foreign or non-terminal evidence leaves
 * the lease, credential and history untouched.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);

const dispatch = (runId: string, timestamp = '2026-10-13T08:00:00.000Z', turnId = 'turn-1'): TimelineEntry =>
  ({ timestamp, turnId, item: { type: 'user_message', text: 'Review this head', messageId: `ns-run-${runId}` } });
const message = (text: string, timestamp = '2026-10-13T08:00:01.000Z', turnId = 'turn-1'): TimelineEntry =>
  ({ timestamp, turnId, item: { type: 'assistant_message', text } });
const page = (entries: TimelineEntry[], overrides: Partial<TimelinePage> = {}): TimelinePage =>
  ({ entries, hasOlder: false, gap: false, ...overrides });

test('the size-refusal classifier proves only explicit input-too-large rejections before send', () => {
  assert.equal(isPromptTooLargeError(new Error('Input exceeds the maximum length of 1048576 characters')), true);
  assert.equal(isPromptTooLargeError(new Error("This model's maximum context length is 200000 tokens")), true);
  assert.equal(isPromptTooLargeError(new Error('Prompt is too large for the provider')), true);
  assert.equal(isPromptTooLargeError(new Error('Request context window exceeded')), true);
  assert.equal(isPromptTooLargeError('the message content exceeds the maximum input length'), true);
  // Quota, plan, rate, permission and transport failures are never size refusals.
  for (const message of [
    'API error (status 402): usage balance exhausted',
    'Upgrade your plan to continue',
    'Rate limit exceeded: too many tokens this minute',
    'Transport lost',
    'Insufficient quota for this route',
    '',
  ]) assert.equal(isPromptTooLargeError(new Error(message)), false, message || '(empty)');
});

test('the dispatch-presence check proves delivery only from the exact dispatch message on a complete page', () => {
  const runId = 'run-1';
  assert.equal(timelineDispatchState(page([dispatch(runId), message('Working')]), runId), 'delivered');
  assert.equal(timelineDispatchState(page([]), runId), 'absent');
  assert.equal(timelineDispatchState(page([message('Working')]), runId), 'absent');
  // An older page may still hold the dispatch: never absence.
  assert.equal(timelineDispatchState(page([], { hasOlder: true }), runId), 'unverified');
  assert.equal(timelineDispatchState(page([], { gap: true }), runId), 'unverified');
  assert.equal(timelineDispatchState(null, runId), 'unverified');
  // A foreign dispatch identity never proves this run's delivery.
  assert.equal(timelineDispatchState(page([dispatch('other-run')]), runId), 'absent');
});

test('the exact reviewer refusal detector proves only a terminal, attributed provider response', () => {
  const runId = 'run-1';
  const refusal = 'Upgrade your plan to continue';
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), message(refusal)]), runId) as { state: string }).state, 'refusal');
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), { timestamp: '2026-10-13T08:00:01.000Z', turnId: 'turn-1', item: { type: 'error', message: 'API error (status 402): usage balance exhausted' } }]), runId) as { state: string }).state, 'refusal');
  // Quoted text is not a provider response.
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), message(`The prompt says "${refusal}" but I approved the change`)]), runId) as { state: string }).state, 'none');
  // A non-terminal refusal followed by real work is not the terminal response.
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), message(refusal), message('Review complete', '2026-10-13T08:00:02.000Z')]), runId) as { state: string }).state, 'none');
  // A gapped page cannot prove coverage.
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), message(refusal)], { gap: true }), runId) as { state: string }).state, 'unverified');
  // A page that does not reach the run's own dispatch message is unattributed.
  assert.equal((detectReviewerProviderRefusal(page([message(refusal)], { hasOlder: true }), runId) as { state: string }).state, 'unverified');
  // Foreign dispatch identity never attributes this run's refusal.
  assert.equal((detectReviewerProviderRefusal(page([dispatch('other-run'), message(refusal)]), runId) as { state: string }).state, 'unverified');
  // A running tool means the turn is not terminal.
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), { timestamp: '2026-10-13T08:00:01.000Z', turnId: 'turn-1', item: { type: 'tool_call', status: 'running', name: 'shell' } }, message(refusal, '2026-10-13T08:00:02.000Z')]), runId) as { state: string }).state, 'unverified');
  // A later user turn (a callback reminder) ends the dispatch turn.
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), message(refusal), { timestamp: '2026-10-13T08:00:02.000Z', turnId: 'turn-2', item: { type: 'user_message', text: 'reminder', messageId: `ns-reminder-${runId}` } }]), runId) as { state: string }).state, 'none');
});

test('the detector fails closed without a shared turn identity and redacts secret-shaped diagnostics', () => {
  const runId = 'run-2';
  // An absent turn identity on either side is not an exact binding.
  assert.equal((detectReviewerProviderRefusal(page([{ ...dispatch(runId), turnId: undefined }, message('Upgrade your plan to continue')]), runId) as { state: string }).state, 'unverified');
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), { ...message('Upgrade your plan to continue'), turnId: undefined }]), runId) as { state: string }).state, 'unverified');
  // Contradictory turn identities are never a refusal either.
  assert.equal((detectReviewerProviderRefusal(page([dispatch(runId), message('Upgrade your plan to continue', '2026-10-13T08:00:01.000Z', 'turn-9')]), runId) as { state: string }).state, 'unverified');
  // A quota/balance message that carries secret-shaped text is redacted before storage.
  const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef';
  const read = detectReviewerProviderRefusal(page([dispatch(runId), { timestamp: '2026-10-13T08:00:01.000Z', turnId: 'turn-1', item: { type: 'error', message: `API error (status 402): usage balance exhausted; key=${secret}` } }]), runId);
  assert.equal(read.state, 'refusal');
  const evidence = (read as { state: 'refusal'; evidence: { kind: string; reason: string } }).evidence;
  assert.equal(evidence.kind, 'quota_balance_exhaustion');
  assert.doesNotMatch(evidence.reason, /sk-ABCDEF/);
  assert.match(evidence.reason, /\[redacted\]/);
});

test('timeline ordering requires readable distinct timestamps rather than provider page order', () => {
  const runId = 'run-order';
  const refusal = message('Upgrade your plan to continue');
  assert.equal(detectReviewerProviderRefusal(page([refusal, dispatch(runId)]), runId).state, 'refusal');
  for (const timestamp of ['', 'not-a-date']) {
    for (const entries of [
      [dispatch(runId), { ...refusal, timestamp }],
      [{ ...refusal, timestamp }, dispatch(runId)],
      [dispatch(runId), message('Working', timestamp), refusal],
    ]) {
      assert.deepEqual(detectReviewerProviderRefusal(page(entries), runId), {
        state: 'unverified', gap: 'the reviewer timeline carries no readable timestamp for a turn entry',
      });
    }
  }
  for (const entries of [
    [dispatch(runId), message('Upgrade your plan to continue', dispatch(runId).timestamp)],
    [dispatch(runId), refusal, message('Review complete', refusal.timestamp)],
  ]) {
    for (const ordered of [entries, [...entries].reverse()]) {
      assert.deepEqual(detectReviewerProviderRefusal(page(ordered), runId), {
        state: 'unverified', gap: 'the reviewer timeline carries ambiguous equal timestamps for turn entries',
      });
    }
  }
});

function fixture(withBackup = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-reviewer-refusal-')), store = new Store(join(dir, 'queue.sqlite'));
  const worker = profile('author'), reviewer = profile('reviewer'), backup = profile('backup'), coordinator = profile('coordinator');
  store.setMeta('paused', false);
  store.putRepository({ origin: null, path: '/repo' }, 'agent', 'fixture keeps agent closeout');
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    ...(withBackup ? [{ profileId: backup.id, enabled: true, group: 'review-backup', roles: ['reviewer'], weight: 1, scopes: ['general'] }] : []),
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  const task = store.update(submitted.id, {
    phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'initial', profile: worker, workerModel: worker.model,
    prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
    completion: { taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1 },
  });
  const run: Run = { id: 'review-run', taskId: submitted.id, role: 'reviewer', generation: 1, head, base, agentId: 'reviewer-agent', workspaceId: 'workspace', profile: reviewer, profileGroup: 'review', status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false };
  store.putRun(run);
  store.update(submitted.id, { resolution: { ...store.task(submitted.id).resolution, currentRunId: run.id, reviewerAgentId: 'reviewer-agent', reviewerProfile: reviewer } });
  const states = new Map<string, AgentObservation>();
  states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: 'author' });
  states.set('reviewer-agent', { id: 'reviewer-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: 'reviewer' });
  let timeline: TimelinePage | null = null;
  let currentHead = head, localHead = head, remoteHead = head;
  const tokens = new Map<string, string>(), creates: Run[] = [], notices: string[] = [];
  const adapter = fakeAdapter({
    profiles: async () => [worker, reviewer, ...(withBackup ? [backup] : []), coordinator], validate: async () => base, verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error('No workspace creation'); }, createAgent: async () => { throw new Error('No initial dispatch'); },
    observe: async (id: string) => { const state = states.get(id); if (!state) throw new Error(`Agent ${id} missing`); return state; },
    verifyPr: async () => ({ head: currentHead, url: task.prUrl! }), verifyPrIdentity: async () => ({ head: currentHead, url: task.prUrl! }),
    verifyInspectedRevisionHead: async (_t: unknown, _n: unknown, expected: string) => {
      if (localHead !== expected || remoteHead !== expected || currentHead !== expected)
        throw new Error(`Inspected PR head ${expected} does not match worktree ${localHead}, remote ${remoteHead} and PR ${currentHead}`);
    },
    verifyCleanQueueWorktree: async () => {},
    agentTimelinePage: async () => timeline,
    createRun: async (t: { id: string }, r: Run, token: string) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '', provider: r.profile?.provider ?? 'test', model: r.profile?.model ?? r.role }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async (t: { id: string }, r: Run, token: string) => { tokens.set(r.id, token); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }); },
    findRunAgents: async () => [], continueRun: async () => {}, verifyReview: async () => {}, mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {}, notify: async (_id: string, key: string) => { notices.push(key); },
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0); engine.profiles = [worker, reviewer, ...(withBackup ? [backup] : []), coordinator];
  const current = () => store.task(submitted.id);
  const currentRun = () => store.run(current().resolution.currentRunId!)!;
  return { store, engine, adapter, task, submitted, reviewerRun: run, backup, current, run: currentRun, states, creates, notices, set timeline(value: TimelinePage | null) { timeline = value; },
    setCurrentHead: (value: string) => { currentHead = value; }, setLocalHead: (value: string) => { localHead = value; }, setRemoteHead: (value: string) => { remoteHead = value; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('an exact own-timeline refusal records evidence and re-routes to one eligible independent reader', async () => {
  const f = fixture(); try {
    f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
    await f.engine.resolution.observe();
    assert.equal(f.store.run(f.reviewerRun.id)?.status, 'superseded');
    assert.equal(f.store.run(f.reviewerRun.id)?.released, true);
    assert.equal(f.store.run(f.reviewerRun.id)?.completion, null, 'no synthetic callback or verdict was created');
    const availability = JSON.parse(String(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review')!.data));
    assert.equal(availability.unavailable, true);
    assert.match(String(availability.reason), /Upgrade your plan to continue/);
    assert.equal(f.current().resolution.currentRunId, null);
    assert.equal(f.current().resolution.reviewerAgentId, null);
    assert.equal(f.notices.length, 0, 'a proven terminal refusal skips the pointless callback reminder');
    const event = f.store.events(f.task.id).find(row => row.kind === 'provider_refusal');
    assert.ok(event);
    const detail = JSON.parse(event!.detail);
    assert.equal(detail.runId, f.reviewerRun.id); assert.equal(detail.head, head); assert.equal(detail.group, 'review');
    await f.engine.wake();
    const activeRunId = f.current().resolution.currentRunId;
    assert.ok(activeRunId);
    assert.equal(f.store.run(activeRunId)?.profile?.id, 'backup');
    assert.equal(f.creates.filter(created => created.profile?.id === 'reviewer').length, 0, 'the exhausted route was never re-dispatched');
  } finally { await f.close(); }
});

test('a repeated sweep and a late callback reconcile to one supersession and one reader', async () => {
  const f = fixture(); try {
    const token = 'reviewer-token';
    f.store.setCredential(f.reviewerRun.id, token);
    f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
    await f.engine.resolution.observe();
    // A second sweep over the superseded run is idempotent.
    await f.engine.resolution.observe();
    assert.equal(f.store.run(f.reviewerRun.id)?.status, 'superseded');
    assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 1);
    await f.engine.wake();
    const reader = f.current().resolution.currentRunId;
    assert.ok(reader);
    assert.equal(f.store.runs(f.task.id).filter(run => !run.released).length, 1, 'exactly one reader owns the review');
    // Release revokes the refused run credential; its late callback records no verdict.
    assert.throws(() => f.engine.resolution.complete({ eventId: 'late-callback', taskId: f.task.id, runId: f.reviewerRun.id, status: 'ready_to_merge', summary: 'Late approval', head, reviewText: 'Late approval' }, token), /Unauthorized callback/);
    assert.equal(f.current().resolution.currentRunId, reader);
    assert.equal(f.current().resolution.review, null);
    assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 1);
  } finally { await f.close(); }
});

test('live PR, worktree or provider/model drift refuses the refusal recovery and leaves the lease', async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => f.setCurrentHead('c'.repeat(40)),
    f => f.setLocalHead('c'.repeat(40)),
    f => f.setRemoteHead('c'.repeat(40)),
    f => f.states.set('reviewer-agent', { ...f.states.get('reviewer-agent')!, provider: 'other' }),
    f => f.states.set('reviewer-agent', { ...f.states.get('reviewer-agent')!, model: 'other-model' }),
  ];
  for (const mutate of cases) {
    const f = fixture(); try {
      mutate(f);
      f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
      await f.engine.resolution.observe();
      assert.equal(f.store.run(f.reviewerRun.id)?.status, 'running');
      assert.equal(f.store.run(f.reviewerRun.id)?.released, false);
      assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
      assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 0);
    } finally { await f.close(); }
  }
});

test('a reviewer run bound to another workspace refuses recovery and keeps the lease', async () => {
  const f = fixture(); try {
    f.store.update(f.submitted.id, { workspaceId: 'other-workspace' });
    f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
    await f.engine.resolution.observe();
    assert.equal(f.store.run(f.reviewerRun.id)?.status, 'running');
    assert.equal(f.store.run(f.reviewerRun.id)?.released, false);
    assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
    assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 0);
  } finally { await f.close(); }
});

test('a route that disappears during the awaited live proofs is revalidated before superseding', async () => {
  const f = fixture(); try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verifyPrIdentity = f.adapter.verifyPrIdentity!;
    let first = true;
    f.adapter.verifyPrIdentity = async (t, n) => { const pr = await verifyPrIdentity(t, n); if (first) { first = false; await gate; } return pr; };
    f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
    const observing = f.engine.resolution.observe();
    await new Promise(resolve => setTimeout(resolve, 0));
    // While the live head proof is in flight, the only fallbacks become same-author routes
    // (Spec 053: the coordinator profile can review too).
    f.engine.profiles = [f.engine.profiles[0]!, f.engine.profiles[1]!, { ...f.engine.profiles[2]!, model: 'author' }, { ...f.engine.profiles[3]!, model: 'author' }];
    release();
    await observing;
    assert.equal(f.store.run(f.reviewerRun.id)?.status, 'running');
    assert.equal(f.store.run(f.reviewerRun.id)?.released, false);
    assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
    assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 0);
    assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal_blocked').length, 1);
  } finally { await f.close(); }
});

test('live reviewer changes during either awaited revision proof retain the lease and credential', async () => {
  for (const proof of ['pr', 'worktree'] as const) {
    for (const change of ['active', 'permission', 'provider', 'model', 'workspace'] as const) {
      const f = fixture(); try {
        const token = 'retained-reviewer-token';
        f.store.setCredential(f.reviewerRun.id, token);
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        if (proof === 'pr') {
          const original = f.adapter.verifyPrIdentity!;
          f.adapter.verifyPrIdentity = async (t, n) => { const result = await original(t, n); entered(); await gate; return result; };
        } else {
          const original = f.adapter.verifyInspectedRevisionHead!;
          f.adapter.verifyInspectedRevisionHead = async (t, n, h) => { await original(t, n, h); entered(); await gate; };
        }
        f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
        const observing = f.engine.resolution.observe();
        await started;
        const previous = f.states.get('reviewer-agent')!;
        f.states.set('reviewer-agent', { ...previous,
          ...(change === 'active' ? { active: true, status: 'running' } : {}),
          ...(change === 'permission' ? { permissions: true } : {}),
          ...(change === 'provider' ? { provider: 'other' } : {}),
          ...(change === 'model' ? { model: 'other' } : {}),
          ...(change === 'workspace' ? { workspaceId: 'other' } : {}),
        });
        release();
        await observing;
        assert.equal(f.store.run(f.reviewerRun.id)?.released, false, `${proof}: ${change}`);
        assert.equal(f.current().resolution.currentRunId, f.reviewerRun.id);
        assert.doesNotThrow(() => f.store.authenticate(f.reviewerRun.id, token));
        assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
        assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 0);
        assert.equal(f.notices.length, 0);
      } finally { await f.close(); }
    }
  }
});

test('unverified timeline coverage and ordering surface the exact gap, then hand the run to the ordinary path', async () => {
  for (const timeline of [
    page([dispatch('review-run'), message('Upgrade your plan to continue')], { gap: true }),
    page([message('Upgrade your plan to continue')], { hasOlder: true }),
    page([dispatch('review-run'), message('Upgrade your plan to continue', 'invalid')]),
    page([dispatch('review-run'), message('Upgrade your plan to continue', dispatch('review-run').timestamp)]),
    null,
  ]) {
    const f = fixture(); try {
      f.store.setCredential(f.reviewerRun.id, 'retained-token');
      f.timeline = timeline;
      await f.engine.resolution.observe();
      const read = detectReviewerProviderRefusal(timeline, f.reviewerRun.id);
      assert.equal(read.state, 'unverified');
      assert.equal(f.current().reason, `Reviewer run ${f.reviewerRun.id} provider refusal is unverified: ${read.state === 'unverified' ? read.gap : ''}`);
      assert.equal(f.store.run(f.reviewerRun.id)?.released, false);
      assert.doesNotThrow(() => f.store.authenticate(f.reviewerRun.id, 'retained-token'));
      assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
      assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 0);
      assert.equal(f.notices.length, 0);
      // Queue #535 (papercut fe93582a): the read is bounded, never an indefinite provider wait. The
      // second pass spends the last read and lets one re-report continuation go out; no third read.
      await f.engine.resolution.observe();
      assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal_unverified').length, 2);
      assert.equal(f.notices.length, 1, 'one re-report continuation of the retained reviewer');
      assert.notEqual(f.current().resolution.stop?.reason, 'provider_unavailable');
      await f.engine.resolution.observe();
      assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal_unverified').length, 2, 'no further read is spent');
      assert.equal(f.store.run(f.reviewerRun.id)?.released, false, 'the run keeps its lease on the ordinary path');
    } finally { await f.close(); }
  }
});

test('secret-shaped refusal text is redacted in every durable record', async () => {
  const f = fixture(); try {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef';
    f.timeline = page([dispatch(f.reviewerRun.id), { timestamp: '2026-10-13T08:00:01.000Z', turnId: 'turn-1', item: { type: 'error', message: `API error (status 402): usage balance exhausted key=${secret}` } }]);
    await f.engine.resolution.observe();
    assert.equal(f.store.run(f.reviewerRun.id)?.status, 'superseded');
    const reason = JSON.parse(String(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review')!.data)).reason as string;
    const event = f.store.events(f.task.id).find(row => row.kind === 'provider_refusal')!;
    assert.match(reason, /\[redacted\]/);
    for (const persisted of [reason, event.detail, String(f.store.run(f.reviewerRun.id)?.exhaustionReason ?? ''), f.current().reason])
      assert.doesNotMatch(persisted, /sk-ABCDEF/, persisted);
  } finally { await f.close(); }
});

test('quoted, gapped or non-terminal timeline evidence leaves the reviewer lease and history untouched', async () => {
  for (const entries of [
    page([dispatch('review-run'), message('The prompt quotes "Upgrade your plan to continue"; my review approved the change')]),
    page([dispatch('review-run'), message('Upgrade your plan to continue'), message('Review complete', '2026-10-13T08:00:02.000Z')]),
    page([dispatch('review-run'), message('Upgrade your plan to continue')], { gap: true }),
    page([dispatch('other-run'), message('Upgrade your plan to continue')]),
  ]) {
    const f = fixture(); try {
      f.timeline = entries;
      await f.engine.resolution.observe();
      assert.equal(f.store.run(f.reviewerRun.id)?.status, 'running');
      assert.equal(f.store.run(f.reviewerRun.id)?.released, false);
      assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
      assert.equal(f.current().resolution.currentRunId, f.reviewerRun.id);
    } finally { await f.close(); }
  }
});

test('a refusal without an eligible independent reader parks visibly and keeps the lease, credential and history', async () => {
  for (const scenario of ['none', 'same-author', 'excluded'] as const) {
    const f = fixture(scenario !== 'none'); try {
      if (scenario !== 'none') f.states.set('backup', { id: 'backup', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
      // Spec 053: the coordinator profile can review too, so it shares the author model here.
      f.engine.profiles = f.engine.profiles.map(p => p.id === 'coordinator' ? { ...p, model: 'author' } : p);
      // A same-author backup is never an eligible independent reader.
      if (scenario === 'same-author') f.engine.profiles = f.engine.profiles.map(p => p.id === 'backup' ? { ...p, model: 'author' } : p);
      // A profile excluded on this task is not an automatic fallback either.
      if (scenario === 'excluded') f.store.update(f.submitted.id, { workerExclusions: [{ agentId: null, profileId: 'backup', reason: 'operator excluded this profile on the task', createdAt: new Date().toISOString() }] });
      f.timeline = page([dispatch(f.reviewerRun.id), message('Upgrade your plan to continue')]);
      await f.engine.resolution.observe();
      assert.equal(f.store.run(f.reviewerRun.id)?.status, 'running');
      assert.equal(f.store.run(f.reviewerRun.id)?.released, false);
      assert.equal(f.store.db.prepare('SELECT data FROM availability WHERE group_id=?').get('review'), undefined);
      assert.match(f.current().reason, /no eligible independent reviewer profile/);
      assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal').length, 0);
      assert.equal(f.store.events(f.task.id).filter(row => row.kind === 'provider_refusal_blocked').length, 1);
    } finally { await f.close(); }
  }
});

test('an ordinary stopped reviewer without a refusal keeps its lease and still receives the callback reminder', async () => {
  const f = fixture(); try {
    f.timeline = page([dispatch(f.reviewerRun.id), message('Partial review notes')]);
    await f.engine.resolution.observe();
    assert.equal(f.store.run(f.reviewerRun.id)?.status, 'running');
    assert.equal(f.current().resolution.currentRunId, f.reviewerRun.id);
    assert.equal(f.notices.length, 1, 'ordinary stopped reviewers keep the bounded reminder path');
  } finally { await f.close(); }
});
