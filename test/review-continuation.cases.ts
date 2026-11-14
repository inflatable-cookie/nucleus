import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { Reports } from '../core/intake/report';
import { ACCEPTED_PR_RECONCILIATION_REASON, EXTERNAL_MERGE_CHECK_RECOVERED_REASON, EXTERNAL_MERGE_CHECK_REASON_PREFIX, ProvenPreSendRefusalError } from '../core/resolution';
import { incidentKey } from '../core/recovery/incident';
import { reviewAuthorizationRequired, reviewCheckpointPathFor, REVIEW_AUTHORIZATION_REQUIRED, REVIEW_BUDGET_EXHAUSTED, writeReviewCheckpoint } from '../core/review/review-continuation';
import { briefDigest } from '../core/planning/brief';
import { controlHasExternalEffect } from '../core/engine';
import { holdPatch, releasePatch, OPERATOR_HOLD_OWNER } from '../core/merge/merge-hold';
import {
  REVIEW_CONTINUATION_LIMIT, completionSchema, runSchema, submissionSchema, taskControlInputSchema, holdsOf,
  dispositionSchema, type Completion, type Profile, type Run, type Task,
} from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { PaseoAdapter } from '../service/paseo-composition';
import { incidentSchema, type Incident } from '../shared/incident';
import { assertCompleted, cleanupDiagnostic, observeOutcome, type BackgroundOutcome } from './support/background-outcome';
import { toolTimelinePage } from './support/tool-timeline';
import { whileReaderInTurn } from './support/reader-in-turn';


import {
  acceptControl, base, fixture, head, nativeReviewer, otherHead, pinReviewerRuntime, profile, reviewControl,
  setReviewerCatalogDefault,
} from './support/review-continuation-fixture';

weighted(1)('a changed native thinking level stays refused and definite through direct and owner continuation', async () => {
  for (const action of ['restart'] as const) {
    const f = fixture(); try {
      const native = nativeReviewer(f);
      native.runtimeInfo.thinkingOptionId = 'low';
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      const task = f.current(), run = f.run();
      const control = taskControlInputSchema.parse({
        action, taskId: task.id, version: task.version, caller: 'owner', role: 'reviewer', reason: 'Continue the checkpoint', instruction: 'Finish review',
      });
      const result = await acceptControl(f, control);
      assert.equal(result.state, 'failed', action);
      assert.equal(result.effect?.status, 'reconciled');
      assert.match(result.diagnostic, /refused before send.*unknown or changed/);
      assert.deepEqual(f.current(), task);
      assert.deepEqual(f.run(), run);
      assert.equal(f.reviewerDeliveries.length, 0);
    } finally { await f.close(); }
  }
});

weighted(14)('an unreported native thinking level is unknown, not changed: direct and owner continuation deliver (round 4, papercut 7d59b444)', async () => {
  for (const action of ['restart'] as const) {
    const f = fixture(); try {
      const native = nativeReviewer(f);
      delete native.runtimeInfo.thinkingOptionId;
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      const task = f.current();
      const control = taskControlInputSchema.parse({
        action, taskId: task.id, version: task.version, caller: 'owner', role: 'reviewer', reason: 'Continue the checkpoint', instruction: 'Finish review',
      });
      const result = await acceptControl(f, control);
      assert.notEqual(result.state, 'failed', `${action}: ${result.diagnostic}`);
      assert.equal(f.reviewerDeliveries.length, 1, action);
    } finally { await f.close(); }
  }
});

weighted(25)('read-only forge, observation and local gate failures are definite regardless of uncertainty words', async () => {
  for (const boundary of ['forge', 'observation', 'profile'] as const) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      if (boundary === 'forge') f.adapter.verifyPr = async () => { throw new Error('timeout: unknown forge response'); };
      if (boundary === 'observation') f.adapter.observe = async () => { throw new Error('unknown native observation after timeout'); };
      if (boundary === 'profile') f.engine.profiles = [];
      const result = await acceptControl(f, reviewControl(f));
      assert.equal(result.state, 'failed', boundary);
      assert.equal(result.effect?.status, 'reconciled');
      assert.match(result.diagnostic, /refused before send/);
      assert.equal(f.run().reviewDeliveries?.length ?? 0, 0);
      assert.equal(f.reviewerDeliveries.length, 0);
    } finally { await f.close(); }
  }
});

weighted(3)('native refresh after the awaited forge check refuses a changed thinking level without promoting configured values', async () => {
  const f = fixture(); try {
    const native = nativeReviewer(f);
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
    f.setVerifyBarrier(async () => { native.runtimeInfo.thinkingOptionId = 'low'; });
    const result = await acceptControl(f, reviewControl(f));
    assert.equal(result.state, 'failed');
    assert.equal(result.effect?.status, 'reconciled');
    assert.equal(f.run().reviewDeliveries?.[0].status, 'refused');
    assert.equal(f.reviewerDeliveries.length, 0);
  } finally { await f.close(); }
});

weighted(2)('actual native pre-send timeout is definite but native send exceptions stay uncertain even with refusal prose or class', async () => {
  for (const boundary of ['refresh', 'send', 'typed-send'] as const) {
    const f = fixture(); try {
      const native = nativeReviewer(f);
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      if (boundary === 'refresh') {
        native.refresh = async () => {
          if (f.run().reviewDeliveries?.some(item => item.status === 'reserved')) throw new Error('unknown native timeout');
          return true;
        };
      } else {
        const send = native.send;
        native.send = async (...args) => {
          await send(...args);
          if (boundary === 'typed-send') throw new ProvenPreSendRefusalError('transport timeout');
          throw new Error('timeout: no delivery was sent');
        };
      }
      const result = await acceptControl(f, reviewControl(f));
      assert.equal(result.state, boundary === 'refresh' ? 'failed' : 'needs_attention');
      assert.equal(f.run().reviewDeliveries?.[0].status, boundary === 'refresh' ? 'refused' : 'uncertain');
      assert.equal(f.reviewerDeliveries.length, boundary === 'refresh' ? 0 : 1);
      assert.equal(f.engine.operationStatus(result.id).state, result.state);
    } finally { await f.close(); }
  }
});


weighted(1)('progress saves authenticated evidence without a verdict, and only Queue\'s one reviewer continuation follows it', async () => {
  const f = fixture(); try {
    const receipt = await f.report({ covered: ['Diff', 'Brief'], remaining: ['17 originals', '10 figures'] }, 'saved-progress');
    assert.equal(receipt.checkpoint.continued, false);
    assert.equal(receipt.checkpoint.attention, REVIEW_AUTHORIZATION_REQUIRED);
    const saved = f.run().reviewCheckpoints![0];
    assert.equal(saved.head, head);
    assert.equal(f.run().reviewContinuation ?? null, null);
    assert.ok(existsSync(saved.path));
    assert.deepEqual(JSON.parse(readFileSync(saved.path, 'utf8')).checkpoint.remaining, ['17 originals', '10 figures']);
    assert.deepEqual(await f.report({ covered: ['Diff', 'Brief'], remaining: ['17 originals', '10 figures'] }, 'saved-progress'), receipt);
    await f.engine.wake(); await f.engine.wake();
    await f.engine.resolution.remindStoppedRun(f.current(), f.run());
    await f.engine.resolution.resumeTransientProviderThread(f.current(), f.run(), { id:'review-agent', workspaceId:'workspace', active:false, status:'error', permissions:false, error:'usage limit exceeded' });
    // The idle reader gets exactly one same-run continuation (Tom, 2026-10-31); nothing else is sent or created.
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId);
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'review_auto_continued').length, 1);
    assert.equal(f.continuations.length, 0);
    assert.equal(f.createdRuns.length, 0);
    assert.equal(f.run().completion, null);
    assert.equal(f.run().reviewCheckpoints?.length, 1);
    assert.equal(f.current().resolution.incident, null);
  } finally { await f.close(); }
});

weighted(5)('a review progress report is never a verdict, a pass or a merge', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] });
    await f.engine.wake();
    const task = f.current(), run = f.run();
    assert.equal(task.resolution.review, null);
    assert.deepEqual(task.resolution.reviews, []);
    assert.equal(run.completion, null);
    assert.equal(run.status, 'running');
    assert.ok(!['verifying', 'merging', 'done'].includes(task.phase));
    assert.deepEqual(f.counts(), { merges: 0, syncs: 0 });
  } finally { await f.close(); }
});

weighted(9)('checkpoint bounds do not create a coordinator or another reviewer turn', async () => {
  const f = fixture(); try {
    f.store.setMeta('reviewContinuationLimit', 2);
    await f.report({ covered:['A'], remaining:['B'] });
    await f.report({ covered:['A', 'B'], remaining:['C'] });
    const third = await f.report({ covered:['A', 'B', 'C'], remaining:['D'] });
    assert.equal(third.checkpoint.continued, false);
    await f.engine.wake();
    assert.equal(f.run().reviewCheckpoints?.length, 2);
    assert.equal(f.continuations.length, 0);
    assert.equal(f.createdRuns.length, 0);
    assert.equal(f.current().resolution.attention, false);
  } finally { await f.close(); }
});

weighted(1)('a reviewer progress report reports the exact head and rejects a mismatched one', async () => {
  const f = fixture(); try {
    await assert.rejects(
      f.engine.complete({ eventId: randomUUID(), taskId: f.submitted.id, runId: f.runId, status: 'review_in_progress', summary: 'x', head: otherHead, checkpoint: { covered: [], remaining: ['A'] } } as Completion, 'token'),
      /exact head/);
    assert.equal(f.continuations.length, 0);
  } finally { await f.close(); }
});

weighted(1)('no worker recovery follows a review in progress', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Figures'] });
    await f.engine.wake();
    assert.throws(() => f.engine.resolution.resumeWorker(f.current(), 'Return to the worker'), /reviewer continuation owns this task/);
    // A retained reviewer run already blocks the worker-return path before any mutation.
    assert.throws(() => f.engine.resolution.retry(f.current(), true, 'Return to the worker'));
    assert.equal(f.current().phase, 'reviewing');
  } finally { await f.close(); }
});

weighted(2)('restart role=reviewer is a strict durable owner control and delivers once to the same reviewer run (round 4: continue_review is retired)', async () => {
  const f = fixture(); try {
    const checkpointReceipt = await f.report({ covered: ['Harness one through line 400'], remaining: ['Harness one from line 401', 'Harness two', 'covering proofs', 'five gates'] }, 'operator-cp');
    const control = reviewControl(f);
    assert.equal(controlHasExternalEffect(control), true);
    assert.equal(taskControlInputSchema.safeParse({ ...control, action: 'hold' }).success, false);
    assert.equal(taskControlInputSchema.safeParse({ taskId: control.taskId, version: control.version, action: 'continue_review', reviewRunId: f.runId }).success, false, 'the retired action and its fields are refused');
    const credential = f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash;
    const outcome = await acceptControl(f, control);
    assert.equal(outcome.state, 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 1);
    const delivery = f.reviewerDeliveries[0];
    assert.equal(delivery.runId, f.runId);
    assert.match(delivery.messageId, /^ns-review-[a-f0-9]{64}$/);
    assert.match(delivery.text, /same reviewer run, workspace, model and exact head/);
    assert.match(delivery.text, /Harness one from line 401/);
    assert.match(delivery.text, /five gates/);
    assert.equal(f.run().completion, null);
    assert.equal(f.run().reviewDeliveries?.[0].status, 'delivered');
    assert.equal(f.current().resolution.review, null);
    assert.deepEqual(f.current().resolution.reviews, []);
    assert.equal(f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash, credential);
    const saved = f.run().reviewCheckpoints![0];
    assert.ok(existsSync(saved.path));
    assert.deepEqual(JSON.parse(readFileSync(saved.path, 'utf8')).checkpoint.remaining, ['Harness one from line 401', 'Harness two', 'covering proofs', 'five gates']);
    assert.equal(checkpointReceipt.checkpoint.continued, false);

    const final = await f.engine.complete({ eventId: 'same-run-final', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Review complete', head, reviewCommentId: 7 }, 'token');
    assert.equal(final.accepted, true);
    assert.equal(f.run().completion?.eventId, 'same-run-final');
    assert.equal(f.run().reviewCheckpoints?.length, 1);
    assert.equal(reviewAuthorizationRequired(f.current(), f.store), false);
    assert.ok(existsSync(saved.path));
    assert.equal(f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash, credential);
    assert.equal(f.run().reviewDeliveries?.[0].status, 'delivered');
  } finally { await f.close(); }
});

weighted(1)('a reviewer restart preserves the pinned effective thinking option across catalog default changes', async () => {
  const f = fixture();
  let release!: () => void;
  try {
    pinReviewerRuntime(f);
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'pinned-high-first-checkpoint');
    const first = await acceptControl(f, reviewControl(f), 'continue-pinned-high-first');
    assert.equal(first.state, 'succeeded', JSON.stringify(first));
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.run().profile?.thinkingOptionId, 'high');
    assert.equal(f.engine.profiles.find(candidate => candidate.id === 'reviewer')?.thinkingOptionId, 'medium');

    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const advance = f.engine.resolution.advance.bind(f.engine.resolution);
    f.engine.resolution.advance = async task => { enter(); await blocked; return advance(task); };
    setReviewerCatalogDefault(f, 'low');
    let reported = false;
    const reporting = f.report({ covered: ['Diff and references'], remaining: ['Proofs and citations'] }, 'pinned-high-second-checkpoint')
      .then(receipt => { reported = true; return receipt; });
    await entered;
    assert.equal(reported, false, 'fixture must wait for the checkpoint lifecycle before reading the authorization version');
    release();
    await reporting;
    const second = await acceptControl(f, reviewControl(f), 'continue-pinned-high-second');
    assert.equal(second.state, 'succeeded', JSON.stringify(second));
    assert.equal(f.reviewerDeliveries.length, 2);
    assert.deepEqual(f.reviewerDeliveries.map(delivery => delivery.runId), [f.runId, f.runId]);
    assert.notEqual(f.reviewerDeliveries[0].messageId, f.reviewerDeliveries[1].messageId);
    assert.deepEqual(f.run().reviewDeliveries?.map(delivery => [delivery.checkpointOrdinal, delivery.taskVersion, delivery.status]),
      [[1, first.expectedVersion, 'delivered'], [2, second.expectedVersion, 'delivered']]);
    assert.deepEqual(f.run().reviewCheckpoints?.map(checkpoint => [checkpoint.runId, checkpoint.head]), [[f.runId, head], [f.runId, head]]);
    assert.equal(f.run().profile?.thinkingOptionId, 'high');
    assert.equal(f.engine.profiles.find(candidate => candidate.id === 'reviewer')?.thinkingOptionId, 'low');
  } finally { release?.(); await f.close(); }
});

weighted(4)('a second checkpoint authorization read before lifecycle settlement refuses its stale version', async t => {
  const f = fixture();
  let release!: () => void;
  try {
    pinReviewerRuntime(f);
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'racing-first-checkpoint');
    const first = await acceptControl(f, reviewControl(f), 'racing-first-continuation');
    assert.equal(first.state, 'succeeded', JSON.stringify(first));
    await f.engine.quiesce();

    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const advance = f.engine.resolution.advance.bind(f.engine.resolution);
    f.engine.resolution.advance = async task => { enter(); await blocked; return advance(task); };
    setReviewerCatalogDefault(f, 'low');
    // The reader reports from inside its turn, so Queue does not continue it here.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    // This oracle reads before the receipt's wake settles, so it takes the raw receipt.
    await f.reportUnsettled({ covered: ['Diff and references'], remaining: ['Proofs and citations'] }, 'racing-second-checkpoint');
    await entered;
    const control = reviewControl(f);
    const before = f.current();
    const pending = acceptControl(f, control, 'racing-second-continuation');
    release();
    const second = await pending;
    const after = f.current();
    const events = f.store.events(f.submitted.id).filter(event => event.kind === 'review_checkpoint' || event.kind === 'task_waiting').reverse();
    t.diagnostic(JSON.stringify({ diagnostic: second.diagnostic, authorizedVersion: control.version, currentVersion: after.version,
      events: events.map(({ id, kind, detail }) => ({ id, kind, detail })) }));
    assert.equal(second.state, 'failed', JSON.stringify(second));
    assert.match(second.diagnostic, /Task changed; refresh before (?:continuing reviewer progress|restarting)/);
    assert.match(second.diagnostic, new RegExp(`now version ${after.version}`));
    assert.equal(second.expectedVersion, before.version);
    assert.equal(before.resolution.stop, null);
    assert.equal(after.version, before.version + 1);
    assert.equal(after.resolution.stop?.reason, 'lifecycle');
    assert.deepEqual(events.slice(-2).map(event => event.kind), ['review_checkpoint', 'task_waiting']);
    assert.match(events.at(-2)!.detail, /2\/6 racing-second-checkpoint/);
    assert.equal(JSON.parse(events.at(-1)!.detail).reason, 'lifecycle');
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.run().reviewDeliveries?.length, 1, 'stale authorization never reserves a second delivery');
    assert.equal(f.run().profile?.thinkingOptionId, 'high');
  } finally { release?.(); await f.close(); }
});

weighted(1)('duplicate and concurrent reviewer restarts deliver only one stable message', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
    const control = reviewControl(f), key = 'same-review-delivery-operation';
    const [one, two, three] = await Promise.all([acceptControl(f, control, key), acceptControl(f, control, key), acceptControl(f, control, 'different-concurrent-key')]);
    assert.equal(one.id, two.id);
    assert.equal(one.state, two.state);
    assert.ok(one.state === 'succeeded' || three.state === 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.run().reviewDeliveries?.length, 1);
  } finally { await f.close(); }
});

weighted(7)('a proven pre-send refusal preserves the checkpoint for a fresh, fully rechecked authorization', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Harness one through line 400'], remaining: ['Harness one from line 401', 'Harness two', 'covering proofs'] });
    const saved = f.run().reviewCheckpoints![0];
    const checkpointBytes = readFileSync(saved.path, 'utf8');
    const credential = f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash;
    f.setDeliveryMode('refused-before-send');

    const refused = await acceptControl(f, reviewControl(f), 'refused-review-delivery');
    assert.equal(refused.state, 'failed');
    assert.equal(f.reviewerDeliveries.length, 0, 'a pre-send refusal is not an adapter delivery');
    const refusedAuthorization = f.run().reviewDeliveries?.[0];
    assert.equal(refusedAuthorization?.status, 'refused');
    const refusalEvent = f.store.events(f.submitted.id).find(event => event.kind === 'review_delivery_refused');
    assert.match(refusalEvent?.detail ?? '', /test transport refused before messaging/);

    const fresh = reviewControl(f, {
      version: f.current().version,
      reason: 'Operator reauthorizes after the confirmed pre-send refusal',
      instruction: 'Continue the remaining listed reading and report normally',
    });
    const retried = await acceptControl(f, fresh, 'fresh-review-delivery-after-refusal');
    assert.equal(retried.state, 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.reviewerDeliveries[0].runId, f.runId);
    assert.equal(f.reviewerDeliveries[0].messageId, refusedAuthorization?.deliveryId);
    assert.equal(f.run().reviewDeliveries?.length, 1, 'the retry reuses the checkpoint-bound delivery identity');
    assert.equal(f.run().reviewDeliveries?.[0].status, 'delivered');
    assert.equal(f.run().reviewDeliveries?.[0].reason, 'Operator reauthorizes after the confirmed pre-send refusal');
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'review_delivery_refused' && /test transport refused before messaging/.test(event.detail)),
      'the first refusal remains auditable after delivery');
    assert.equal(readFileSync(saved.path, 'utf8'), checkpointBytes);
    assert.equal(f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash, credential);
  } finally { await f.close(); }
});

// Round 4: the restart derives the run, head and checkpoint, so only a stale
// version, brief or checkpoint receipt can be wrong in the request.
weighted(3)('a stale version, brief or checkpoint receipt refuses without delivery', async () => {
  const cases: Array<{ name: string; mutate?: (f: ReturnType<typeof fixture>) => void; override?: (f: ReturnType<typeof fixture>) => Partial<{ version: number }> }> = [
    { name: 'version', mutate: f => f.store.update(f.submitted.id, { reason: 'task version changed' }), override: f => ({ version: f.submitted.version }) },
    { name: 'brief', mutate: f => f.store.update(f.submitted.id, { briefVersions: [{ version: 1, digest: `sha256:${'d'.repeat(64)}`, mediaType: 'text/plain', text: 'changed brief', reason: 'test', pinnedAt: '2026-10-10T00:00:00.000Z' }] }) },
    { name: 'callback hash', mutate: f => {
      const record = f.run().reviewCheckpoints![0];
      const eventId = record.eventId;
      if (!eventId) throw new Error('current checkpoint has no authenticated event ID');
      f.store.db.prepare('UPDATE receipts SET hash=? WHERE id=?').run('0'.repeat(64), eventId);
    } },
  ];
  for (const c of cases) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      const version = f.current().version;
      c.mutate?.(f);
      const control = reviewControl(f, { ...c.override?.(f), version: c.name === 'version' ? version : f.current().version });
      const outcome = await acceptControl(f, control);
      assert.notEqual(outcome.state, 'succeeded', c.name);
      assert.equal(f.reviewerDeliveries.length, 0, c.name);
    } finally { await f.close(); }
  }
});

weighted(7)('dispatch holds defer; disposition fences, active turns, permissions, wrong workspace/model and authors refuse', async () => {
  const cases: Array<{ name: string; setup: (f: ReturnType<typeof fixture>) => void }> = [
    { name: 'dispatch', setup: f => { const task = f.current(); f.store.update(task.id, holdPatch(task, 'dispatch', OPERATOR_HOLD_OWNER, 'wait')); } },
    { name: 'disposition', setup: f => f.store.update(f.submitted.id, { disposition: dispositionSchema.parse({ kind: 'cancel', status: 'intent', requestedAt: '2026-10-10T00:00:00.000Z', requestedBy: 'operator', reason: 'stop', workDisposition: 'preserve' }) }) },
    { name: 'active', setup: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true }) },
    { name: 'permission', setup: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, permissions: true }) },
    { name: 'workspace', setup: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, workspaceId: 'different-workspace' }) },
    { name: 'model', setup: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, model: 'test/worker' }) },
    { name: 'author', setup: f => { f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'worker' } }); f.store.putRun({ ...f.run(), agentId: 'worker' }); } },
  ];
  for (const c of cases) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      c.setup(f);
      const outcome = await acceptControl(f, reviewControl(f));
      // Round 4 (Tom, 2026-10-19): a pause or dispatch hold records the verb for
      // later delivery instead of refusing it; nothing is sent meanwhile.
      if (c.name === 'dispatch') {
        assert.equal(outcome.state, 'succeeded', c.name);
        assert.ok(f.current().resolution.deferredVerb, c.name);
      } else assert.notEqual(outcome.state, 'succeeded', c.name);
      assert.equal(f.reviewerDeliveries.length, 0, c.name);
    } finally { await f.close(); }
  }
});

weighted(32)('a reviewer restart refuses observed runtime drift and invalid pinned reviewer configuration', async () => {
  const driftCases: Array<{ name: string; mutate: (f: ReturnType<typeof fixture>) => void }> = [
    { name: 'provider drift', mutate: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, provider: 'other' }) },
    { name: 'mode drift', mutate: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, modeId: 'other-mode' }) },
    { name: 'thinking drift', mutate: f => f.states.set('review-agent', { ...f.states.get('review-agent')!, thinkingOptionId: 'medium' }) },
  ];
  for (const c of driftCases) {
    const f = fixture(); try {
      pinReviewerRuntime(f);
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      c.mutate(f);
      const outcome = await acceptControl(f, reviewControl(f));
      assert.notEqual(outcome.state, 'succeeded', c.name);
      assert.equal(f.reviewerDeliveries.length, 0, c.name);
    } finally { await f.close(); }
  }

  const refusalCases: Array<{ name: string; setup: (f: ReturnType<typeof fixture>) => void }> = [
    { name: 'assigned/run thinking disagreement', setup: f => {
      const task = f.current(), assigned = task.resolution.reviewerProfile!;
      f.store.update(task.id, { resolution: { ...task.resolution, reviewerProfile: { ...assigned, thinkingOptionId: 'medium' } } });
    } },
    { name: 'unsupported pinned thinking', setup: f => {
      f.engine.profiles = f.engine.profiles.map(candidate => candidate.id === 'reviewer' ? { ...candidate, supportedThinking: ['medium'] } : candidate);
    } },
    { name: 'disabled pool profile', setup: f => f.store.setMeta('pool', f.store.pool().map(entry => entry.profileId === 'reviewer' ? { ...entry, enabled: false } : entry)) },
    { name: 'catalog profile unavailable', setup: f => {
      f.engine.profiles = f.engine.profiles.map(candidate => candidate.id === 'reviewer' ? { ...candidate, available: false, problem: 'profile unavailable' } : candidate);
    } },
    { name: 'subscription unavailable', setup: f => {
      f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('review', JSON.stringify({ group: 'review', unavailable: true, reason: 'quota', retryAt: null }));
    } },
  ];
  for (const c of refusalCases) {
    const f = fixture(); try {
      pinReviewerRuntime(f);
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      c.setup(f);
      const outcome = await acceptControl(f, reviewControl(f));
      assert.notEqual(outcome.state, 'succeeded', c.name);
      assert.equal(f.reviewerDeliveries.length, 0, c.name);
    } finally { await f.close(); }
  }
});

weighted(4)('an awaited exact-head race refuses after fences and identity/checkpoint changes; a final callback racing delivery creates no extra turn', async () => {
  for (const race of ['dispatch fence', 'head change', 'checkpoint change', 'model change', 'provider change', 'mode change', 'thinking change'] as const) {
    const f = fixture(); try {
      if (race === 'provider change' || race === 'mode change' || race === 'thinking change') pinReviewerRuntime(f);
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      f.setVerifyBarrier(async () => { enter(); await blocked; });
      const pending = acceptControl(f, reviewControl(f));
      await entered;
      if (race === 'dispatch fence') { const task = f.current(); f.store.update(task.id, holdPatch(task, 'dispatch', OPERATOR_HOLD_OWNER, 'changed during verification')); }
      if (race === 'head change') f.store.update(f.submitted.id, { prHead: otherHead });
      if (race === 'checkpoint change') {
        const run = f.run(), prior = run.reviewCheckpoints![0];
        f.store.putRun({ ...run, reviewCheckpoints: [...run.reviewCheckpoints!, { ordinal: 2, checkpoint: { covered: ['Diff'], remaining: ['new remaining'] }, head, at: new Date().toISOString(), runId: run.id, path: `${prior.path}.changed`, eventId: 'raced-checkpoint', callbackDigest: '0'.repeat(64), briefVersion: null, briefDigest: null }] });
      }
      if (race === 'model change') f.states.set('review-agent', { ...f.states.get('review-agent')!, model: 'test/worker' });
      if (race === 'provider change') f.states.set('review-agent', { ...f.states.get('review-agent')!, provider: 'other' });
      if (race === 'mode change') f.states.set('review-agent', { ...f.states.get('review-agent')!, modeId: 'other-mode' });
      if (race === 'thinking change') f.states.set('review-agent', { ...f.states.get('review-agent')!, thinkingOptionId: 'medium' });
      release();
      const result = await pending;
      assert.notEqual(result.state, 'succeeded', race);
      assert.equal(f.reviewerDeliveries.length, 0, race);
    } finally { await f.close(); }
  }
  {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      f.setVerifyBarrier(async () => { enter(); await blocked; });
      const control = acceptControl(f, reviewControl(f));
      await entered;
      const callback = f.engine.complete({ eventId: 'callback-racing-send', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Review complete', head, reviewCommentId: 8 }, 'token');
      release();
      const [operation, accepted] = await Promise.all([control, callback]);
      assert.equal(operation.state, 'succeeded');
      assert.equal(accepted.accepted, true);
      assert.equal(f.reviewerDeliveries.length, 1);
      assert.equal(f.run().completion?.eventId, 'callback-racing-send');
      assert.equal(f.run().reviewDeliveries?.[0].status, 'delivered');
    } finally { await f.close(); }
  }
});

weighted(2)('lost send response and restart reconcile only exact delivery evidence and never resend', async () => {
  for (const mode of ['lost-visible', 'lost-unknown'] as const) {
    const f = fixture(); let restarted: Engine | null = null; try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      f.setDeliveryMode(mode);
      const first = await acceptControl(f, reviewControl(f));
      assert.equal(first.state, 'needs_attention');
      assert.equal(f.reviewerDeliveries.length, 1);
      assert.equal(f.run().reviewDeliveries?.[0].status, 'uncertain');
      await f.engine.stop();
      restarted = new Engine(f.store, f.adapter, 3_600_000);
      restarted.profiles = f.engine.profiles;
      restarted.resumeOperations();
      const resumed = await acceptControl(f, reviewControl(f, { version: f.current().version }), `inspect-after-restart-${mode}`, restarted);
      if (mode === 'lost-visible') {
        assert.equal(resumed.state, 'succeeded');
        assert.equal(f.run().reviewDeliveries?.[0].status, 'delivered');
        assert.equal(f.store.operation(first.id)?.state, 'succeeded');
      } else {
        assert.equal(resumed.state, 'needs_attention');
        assert.match(f.current().reason, /uncertain/);
        assert.equal(f.run().reviewDeliveries?.[0].status, 'uncertain');
        const final = await restarted.complete({ eventId: 'callback-proves-unknown-send', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Review complete', head, reviewCommentId: 9 }, 'token');
        assert.equal(final.accepted, true);
        // A completion is the run's result, never proof of WHICH occurrence an
        // unknown send belongs to: an earlier result can land after a later send.
        // The occurrence stays unknown and keeps its own durable hold until its
        // exact timeline message or a later authenticated checkpoint settles it.
        assert.equal(f.run().reviewDeliveries?.[0].status, 'uncertain');
        assert.match(f.current().reason, /uncertain|inspect/);
        assert.equal(f.store.operation(first.id)?.state, 'needs_attention');
        assert.equal(f.store.operation(resumed.id)?.state, 'needs_attention');
      }
      assert.equal(f.reviewerDeliveries.length, 1);
    } finally { await restarted?.stop(); await f.close(); }
  }
});

weighted(4)('each later checkpoint needs its own authorization and prior coverage stays immutable', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['A'], remaining: ['B'] }, 'later-cp-1');
    const first = await acceptControl(f, reviewControl(f));
    assert.equal(first.state, 'succeeded');
    const priorPath = f.run().reviewCheckpoints![0].path;
    await f.report({ covered: ['A', 'B'], remaining: ['C'] }, 'later-cp-2');
    assert.equal(f.reviewerDeliveries.length, 1);
    const credential = f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash;
    const latest = await acceptControl(f, reviewControl(f, { version: f.current().version }));
    assert.equal(latest.state, 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 2);
    assert.notEqual(f.reviewerDeliveries[0].messageId, f.reviewerDeliveries[1].messageId);
    assert.ok(existsSync(priorPath));
    assert.deepEqual(JSON.parse(readFileSync(priorPath, 'utf8')).checkpoint, { covered: ['A'], remaining: ['B'] });
    assert.equal(f.run().reviewCheckpoints?.length, 2);
    assert.equal(f.store.db.prepare('SELECT hash FROM credentials WHERE run=?').get(f.runId)?.hash, credential);
  } finally { await f.close(); }
});

function projectA1863(f: ReturnType<typeof fixture>, laterHead = head, recordedPrHead = laterHead) {
  const reviewer = f.engine.profiles.find(p => p.id === 'reviewer')!;
  f.store.putRun({ ...f.run(), released: true, status: 'superseded' });
  // Recent-relative times: the Spec 058 wall-time budget (PRs 772/784) parks a
  // month-old lifecycle behind a budget pause before the fresh reviewer can start.
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const reviewCompletion: Completion = {
    eventId: 'review-1863', taskId: f.submitted.id, runId: 'review-1863', status: 'changes_required',
    summary: 'Reading budget exhausted', head, reviewCommentId: 1,
  };
  f.store.putRun(runSchema.parse({
    id: 'review-1863', taskId: f.submitted.id, role: 'reviewer', generation: 1, head, base,
    agentId: 'reviewer-1863', workspaceId: 'workspace', profile: reviewer, status: 'finished',
    createdAt: minutesAgo(3), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: reviewCompletion,
  }));
  f.store.putRun(runSchema.parse({
    id: 'revision-1863', taskId: f.submitted.id, role: 'revision', generation: 1, head: laterHead, base,
    agentId: 'worker', workspaceId: 'workspace', profile: f.current().profile, status: 'finished',
    createdAt: minutesAgo(2), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { eventId: 'revision-1863', taskId: f.submitted.id, runId: 'revision-1863', status: 'blocked', summary: 'not an implementation defect', head: laterHead },
  }));
  f.store.putRun(runSchema.parse({
    id: 'recovery-1863', taskId: f.submitted.id, role: 'recovery', generation: 1, head: laterHead, base,
    agentId: 'coordinator-1863', workspaceId: 'workspace', profile: reviewer, status: 'finished',
    createdAt: minutesAgo(1), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { eventId: 'recovery-1863', taskId: f.submitted.id, runId: 'recovery-1863', status: 'escalate', summary: 'Need a fresh review', head: laterHead },
  }));
  f.store.update(f.submitted.id, {
    phase: 'blocked', reason: 'not an implementation defect', prHead: recordedPrHead,
    resolution: {
      ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null,
      review: reviewCompletion, recoveryActive: true, recoveryAttempts: 1,
      recovery: { id: 'rec', key: 'k', generation: 1, runId: 'recovery-1863', agentId: 'coordinator-1863', status: 'escalated', summary: 'Need a fresh review', idleSince: null, incidentId: null },
    },
  }, 'blocked');
}

/**
 * Project-A #1900: Queue's recorded `prHead` is still the accepted review head H1 while GitHub's
 * open PR head is the retained worker's later pushed head. The revision (retained worker) and a
 * coordinator recovery both report that newer head; `githubHead` is what GitHub returns.
 */
function projectA1900(f: ReturnType<typeof fixture>, revisionHead = otherHead, recoveryHead = revisionHead, githubHead = revisionHead) {
  const head=f.initialHead, base=f.initialBase;
  const reviewer = f.engine.profiles.find(p => p.id === 'reviewer')!;
  f.store.putRun({ ...f.run(), released: true, status: 'superseded' });
  // Recent-relative times: the Spec 058 wall-time budget (PRs 772/784) pauses a
  // task whose lifecycle began minutes before the medium 180-minute limit, so
  // fixed 2026-10-05 dates would park the fresh reviewer behind a budget pause.
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const reviewCompletion: Completion = {
    eventId: 'review-1900', taskId: f.submitted.id, runId: 'review-1900', status: 'changes_required',
    summary: 'Reading budget exhausted', head, reviewCommentId: 1,
  };
  f.store.putRun(runSchema.parse({
    id: 'review-1900', taskId: f.submitted.id, role: 'reviewer', generation: 1, head, base,
    agentId: 'reviewer-1900', workspaceId: 'workspace', profile: reviewer, status: 'finished',
    createdAt: minutesAgo(3), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: reviewCompletion,
  }));
  f.store.putRun(runSchema.parse({
    id: 'revision-1900', taskId: f.submitted.id, role: 'revision', generation: 1, head: revisionHead, base,
    agentId: 'worker', workspaceId: 'workspace', profile: f.current().profile, status: 'finished',
    createdAt: minutesAgo(2), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { eventId: 'revision-1900', taskId: f.submitted.id, runId: 'revision-1900', status: 'blocked', summary: 'not an implementation defect', head: revisionHead },
  }));
  f.store.putRun(runSchema.parse({
    id: 'recovery-1900', taskId: f.submitted.id, role: 'recovery', generation: 1, head: recoveryHead, base,
    agentId: 'coordinator-1900', workspaceId: 'workspace', profile: reviewer, status: 'finished',
    createdAt: minutesAgo(1), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { eventId: 'recovery-1900', taskId: f.submitted.id, runId: 'recovery-1900', status: 'escalate', summary: 'Need a fresh review', head: recoveryHead },
  }));
  f.store.update(f.submitted.id, {
    phase: 'blocked', reason: 'not an implementation defect', prHead: head,
    resolution: {
      ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null,
      review: reviewCompletion, recoveryActive: true, recoveryAttempts: 1,
      recovery: { id: 'rec-1900', key: 'k', generation: 1, runId: 'recovery-1900', agentId: 'coordinator-1900', status: 'escalated', summary: 'Need a fresh review', idleSince: null, incidentId: null },
    },
  }, 'blocked');
  f.adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/7', head: githubHead });
  f.adapter.mergeGate = async () => ({ head: githubHead, base, wait: '' });
}

weighted(7)('a parked restart from blocked delivers one reviewer instruction to the fresh reviewer', async () => {
  const f = fixture(); try {
    const reviewer = f.engine.profiles.find(p => p.id === 'reviewer')!;
    // The fixture's open reviewer run is not the fault under retry: release it first.
    f.store.putRun({ ...f.run(), released: true, status: 'superseded' });
    const blockedRun: Run = runSchema.parse({
      id: 'blocked-review-run', taskId: f.submitted.id, role: 'reviewer', generation: 1, head, base, agentId: 'blocked-reviewer', workspaceId: 'workspace',
      // Recent-relative: a month-old run reads as a spent lifecycle under the Spec 058 budget.
      profile: reviewer, status: 'finished', createdAt: new Date(Date.now() - 60_000).toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { eventId: 'blocked-review', taskId: f.submitted.id, runId: 'blocked-review-run', status: 'blocked', summary: 'Reviewer environment unavailable', head },
    });
    f.store.putRun(blockedRun);
    f.store.update(f.submitted.id, { phase: 'blocked', reason: 'Reviewer environment unavailable', resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null } }, 'blocked');
    const instruction = 'Judge the new fixture subjects against contract 044.';
    const retried = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: instruction });
    assert.equal(retried.phase, 'awaiting_review');
    assert.equal(retried.resolution.pendingReviewReason, instruction);
    await f.engine.wake();
    const dispatched = f.createdRuns.find(run => run.role === 'reviewer');
    assert.ok(dispatched, `a fresh reviewer run was created; phase=${f.current().phase}; reason=${f.current().reason}`);
    assert.equal(dispatched!.reviewReason, instruction);
    // The instruction is bound to exactly one fresh reviewer run.
    assert.equal(f.current().resolution.pendingReviewReason, null);
    const count = f.createdRuns.filter(run => run.role === 'reviewer').length;
    await f.engine.wake();
    assert.equal(f.createdRuns.filter(run => run.role === 'reviewer').length, count);
  } finally { await f.close(); }
});

weighted(3)('a parked restart with a reviewer instruction returns a blocked unchanged reviewed head to review', async () => {
  const f = fixture(); try {
    projectA1863(f);
    const instruction = 'Judge every remaining subject; the block was not an implementation defect.';
    const retried = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: instruction });
    assert.equal(retried.phase, 'awaiting_review');
    assert.equal(retried.resolution.pendingReviewReason, instruction);
    assert.equal(retried.resolution.recoveryActive, false);
    assert.equal(retried.resolution.recoveryAttempts, 0);
    assert.equal(retried.resolution.recovery, null);
    await f.engine.wake();
    const dispatched = f.createdRuns.find(run => run.role === 'reviewer');
    assert.ok(dispatched, `a fresh reviewer run was created; phase=${f.current().phase}; reason=${f.current().reason}`);
    assert.equal(dispatched!.reviewReason, instruction);
    assert.equal(f.current().resolution.pendingReviewReason, null);
  } finally { await f.close(); }
});

weighted(1)('a parked restart with a reviewer instruction returns a blocked task to fresh review at the retained worker\'s newer pushed head', async () => {
  const f = fixture({ realSource: true }); try {
    const otherHead=f.source!.pushRevision(), head=f.initialHead;
    projectA1900(f, otherHead);
    const prior=f.store.run('review-1900')!;
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(prior.completion!.eventId,f.submitted.id,prior.id,
      digest(JSON.stringify(prior.completion)),JSON.stringify({accepted:true}));

    const instruction = 'Judge every remaining subject at the current head; the block was not an implementation defect.';
    const retried = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: instruction });
    assert.equal(retried.phase, 'awaiting_review');
    assert.equal(retried.prHead, otherHead, "Queue records the retained worker's verified pushed head");
    assert.equal(retried.resolution.pendingReviewReason, instruction);
    // The accepted earlier review stays immutable and never satisfies the gate at the new head.
    assert.equal(retried.resolution.review?.head, head);
    await f.engine.wake();
    const dispatched = f.createdRuns.find(run => run.role === 'reviewer');
    assert.ok(dispatched, `a fresh reviewer run was created; phase=${f.current().phase}; reason=${f.current().reason}`);
    assert.equal(dispatched!.head, otherHead, 'the fresh reviewer judges the newer pushed head');
    assert.equal(dispatched!.reviewReason, instruction);
  } finally { await f.close(); }
});

weighted(1)('a parked restart with a reviewer instruction refuses when the retained worker\'s newer head is not GitHub\'s PR head', async () => {
  const f = fixture(); try {
    // Accepted review at H1, a retained revision claims H2, but GitHub's open PR head is still H1.
    projectA1900(f, otherHead, otherHead, head);
    await assert.rejects(
      f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: 'Review the current head' }),
      /differs from the retained worker's latest pushed head/);
    assert.equal(f.current().phase, 'blocked');
    assert.equal(f.current().prHead, head, 'a refused retry records no head reconciliation');
  } finally { await f.close(); }
});

weighted(1)('a parked restart with a reviewer instruction refuses a head changed by anything other than the retained worker', async () => {
  const f = fixture(); try {
    // The coordinator recovery reports a third head the retained worker never pushed.
    projectA1900(f, otherHead, 'd'.repeat(40), 'd'.repeat(40));
    await assert.rejects(
      f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: 'Review the current head' }),
      /A reviewer instruction requires a blocked or errored reviewer result that returns the task to review/);
    assert.equal(f.current().phase, 'blocked');
  } finally { await f.close(); }
});

weighted(1)('a parked restart with a reviewer instruction refuses when a later revision pushed a different head', async () => {
  const f = fixture(); try {
    projectA1863(f, otherHead, head);
    await assert.rejects(
      f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: 'Review the unchanged head' }),
      /differs from the retained worker's latest pushed head/);
    assert.equal(f.current().phase, 'blocked');
  } finally { await f.close(); }
});

weighted(1)('a parked restart without a reviewer instruction keeps last-run routing on a blocked revision', async () => {
  const f = fixture(); try {
    projectA1863(f);
    const retried = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', reason: 'Owner re-runs the parked step' });
    assert.equal(retried.phase, 'changes_requested');
    assert.equal(retried.resolution.pendingReviewReason, null);
  } finally { await f.close(); }
});

/**
 * A task parked in needs_attention with an accepted `ready_for_review` completion, no resolution
 * run and the retained worker intact: the accepted-PR reconciliation path a retry takes when the
 * accepted PR is not yet reviewed at its head. `review` seeds the accepted-review record.
 */
function acceptedPrReconciliation(f: ReturnType<typeof fixture>, review: Completion | null = null) {
  f.store.putRun({ ...f.run(), released: true, status: 'superseded' });
  f.store.update(f.submitted.id, {
    phase: 'needs_attention', reason: 'Stopped reviewer thread needs attention', prHead: head,
    resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, review, attention: true },
  }, 'needs_attention');
  Object.assign(f.adapter, {
    workspaceAvailable: async () => true, findWorkspaces: async () => [],
    recoverTaskWorkspace: async () => ({ id: 'workspace', directory: '/worktree' }),
  });
}

weighted(10)('a parked restart with a reviewer instruction carries it through accepted-PR reconciliation', async () => {
  const f = fixture(); try {
    acceptedPrReconciliation(f);
    const instruction = 'Judge every remaining subject; the block was not an implementation defect.';
    const retried = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: instruction });
    assert.equal(retried.reason, ACCEPTED_PR_RECONCILIATION_REASON);
    assert.equal(retried.resolution.pendingReviewReason, instruction);
    await f.engine.wake();
    assert.equal(f.current().phase, 'reviewing');
    const dispatched = f.createdRuns.find(run => run.role === 'reviewer');
    assert.ok(dispatched, `a fresh reviewer run was created; phase=${f.current().phase}; reason=${f.current().reason}`);
    assert.equal(dispatched!.reviewReason, instruction);
    assert.equal(f.current().resolution.pendingReviewReason, null);
  } finally { await f.close(); }
});

weighted(5)('retrying a blocked reviewer does not yield before its local transaction when no head proof is needed', async () => {
  const f = fixture();
  try {
    const completion: Completion = {
      taskId: f.submitted.id, runId: f.runId, eventId: 'review-blocked',
      status: 'blocked', summary: 'Review environment was unavailable', head,
      reviewResponsibility: 'environment',
    };
    f.store.putRun({ ...f.run(), status: 'finished', released: true, active: false, completion });
    const task = f.current();
    const blocked = f.store.update(task.id, {
      phase: 'blocked', reason: completion.summary,
      resolution: { ...task.resolution, currentRunId: null },
    });
    assert.equal(f.engine.resolution.acceptedReviewAtUnchangedHead(blocked), null);
    assert.equal(f.engine.resolution.retainedWorkerAdvancedReviewHead(blocked), null);

    // Exercise the application boundary directly: public operation admission
    // adds its own awaits before this code, which would mask the new yield.
    const engine = f.engine as unknown as {
      performTaskControlApplied(input: ReturnType<typeof taskControlInputSchema.parse>): Promise<Task>;
      wakeTask(taskId: string): Promise<void>;
      wakeRepository(repoPath: string): Promise<void>;
    };
    engine.wakeTask = async () => {};
    engine.wakeRepository = async () => {};
    const input = taskControlInputSchema.parse({
      taskId: blocked.id, version: blocked.version, action: 'restart', role: 'reviewer',
      reason: 'Owner returns the reviewed head to review', instruction: 'Recheck after environment repair',
    });
    let observationApplied = false;
    queueMicrotask(() => {
      f.store.update(blocked.id, { reason: 'Concurrent observation updated the reason' });
      observationApplied = true;
    });

    const result = await engine.performTaskControlApplied(input);
    assert.equal(observationApplied, true);
    assert.equal(result.phase, 'awaiting_review');
    assert.equal(f.current().phase, 'awaiting_review');
    assert.equal(f.current().resolution.pendingReviewReason, input.instruction);
    assert.equal(f.current().reason, 'Concurrent observation updated the reason');
  } finally { await f.close(); }
});

weighted(1)('verified retry preserves main synchronous continuation after the version recheck', async () => {
  const f = fixture();
  try {
    projectA1863(f);
    const blocked = f.current();
    assert.equal(f.engine.resolution.acceptedReviewAtUnchangedHead(blocked)?.head, head);
    const engine = f.engine as unknown as {
      performTaskControlApplied(input: ReturnType<typeof taskControlInputSchema.parse>): Promise<Task>;
      wakeTask(taskId: string): Promise<void>;
      wakeRepository(repoPath: string): Promise<void>;
    };
    engine.wakeTask = async () => {};
    engine.wakeRepository = async () => {};
    let observationApplied = false;
    f.adapter.verifyPr = async () => {
      queueMicrotask(() => queueMicrotask(() => {
        f.store.update(blocked.id, { reason: 'Concurrent observation after verification' });
        observationApplied = true;
      }));
      return { head, url: blocked.prUrl! };
    };
    const result = await engine.performTaskControlApplied(taskControlInputSchema.parse({
      taskId: blocked.id, version: blocked.version, action: 'restart', role: 'reviewer',
      reason: 'Owner returns the reviewed head to review', instruction: 'Review the unchanged head',
    }));
    assert.equal(observationApplied, true);
    assert.equal(result.phase, 'awaiting_review');
    assert.equal(f.current().phase, 'awaiting_review');
    assert.equal(f.current().reason, 'Concurrent observation after verification');
  } finally { await f.close(); }
});

weighted(1)('a parked restart with a reviewer instruction refuses an accepted reviewed head that routes to verification', async () => {
  const f = fixture(); try {
    const review: Completion = { eventId: 'accepted-review', taskId: f.submitted.id, runId: 'accepted-review', status: 'ready_to_merge', summary: 'Accepted', head };
    acceptedPrReconciliation(f, review);
    await assert.rejects(
      f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: 'Review the head again' }),
      /A reviewer instruction requires a retry that returns the task to a fresh review/);
    assert.equal(f.current().resolution.pendingReviewReason, null);
    assert.equal(f.current().phase, 'needs_attention');
  } finally { await f.close(); }
});

weighted(5)('a parked restart with a reviewer instruction refuses a needs_attention task that returns to no review', async () => {
  const f = fixture(); try {
    f.store.putRun({ ...f.run(), released: true, status: 'superseded' });
    f.store.update(f.submitted.id, {
      phase: 'needs_attention', reason: 'Revision budget exhausted',
      completion: { eventId: 'worker-blocked', taskId: f.submitted.id, runId: 'worker-run', status: 'blocked', summary: 'Blocked', prNumber: 7 },
      resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, review: null, attention: true },
    }, 'needs_attention');
    await assert.rejects(
      f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: 'Review the head again' }),
      /A reviewer instruction requires a retry that returns the task to a fresh review/);
  } finally { await f.close(); }
});

weighted(1)('a parked restart with a reviewer instruction refuses when GitHub\'s PR head moved', async () => {
  const f = fixture(); try {
    projectA1863(f);
    f.adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/7', head: otherHead });
    await assert.rejects(
      f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Owner returns the reviewed head to review', instruction: 'Review the unchanged head' }),
      /current PR head .* differs from the accepted review head/);
    assert.equal(f.current().phase, 'blocked');
  } finally { await f.close(); }
});

weighted(1)('durable parked restart serializes concurrent requests, refuses a moved head and retries after it clears', async () => {
  const f = fixture(); try {
    projectA1863(f);
    f.store.setMeta('paused', true);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let verifications = 0;
    f.adapter.verifyPr = async () => { verifications++; enter(); await gate;
      return { url: 'https://github.com/example/repo/pull/7', head: otherHead }; };
    const control = taskControlInputSchema.parse({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer',
      reason: 'Return the reviewed head to review', instruction: 'Review the unchanged head' });
    const { key, payload } = taskControlOperation(control);
    const first = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in first);
    await entered;
    const concurrent = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in concurrent);
    assert.equal(concurrent.operation.id, first.operation.id);
    assert.equal(concurrent.operation.state, 'running');
    assert.equal(verifications, 1, 'the second request is admitted while the first verification is suspended');
    release();
    const refused = await f.engine.awaitOperation(first.operation.id);
    assert.equal(refused.state, 'failed');
    assert.match(refused.diagnostic, /current PR head .* differs from the accepted review head/);
    assert.equal(refused.preSendReceipt?.attempt, 1);
    assert.equal(f.reviewerDeliveries.length, 0);
    assert.equal(f.createdRuns.length, 0);
    f.adapter.verifyPr = async () => ({ url: 'https://github.com/example/repo/pull/7', head });
    const retry = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in retry);
    const succeeded = await f.engine.awaitOperation(first.operation.id);
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.id, refused.id);
    assert.equal(succeeded.attempts, 2);
    assert.deepEqual(succeeded.preSendHistory?.[0]?.receipt, refused.preSendReceipt);
    assert.deepEqual(succeeded.preSendHistory?.[0]?.effect, refused.effect);
    assert.equal(succeeded.preSendHistory?.[0]?.diagnostic, refused.diagnostic);
    assert.equal(f.reviewerDeliveries.length, 0);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

// Project-A #2091: reading-only insufficiency must not mint an unchanged author run.
for (const bridge of [false, true]) {
  test(`reviewer-owned coverage stays on its authenticated run (bridge=${bridge})`, async () => {
    const f = fixture(); try {
      f.store.putRun({ ...f.run(), reviewResponsibilityRequired: true });
      const report: Completion = { eventId: randomUUID(), taskId: f.submitted.id, runId: f.runId,
        status: 'changes_required', head, summary: 'Required personal reading remains unfinished; no author defect',
        reviewResponsibility: 'reviewer', reviewText: 'Covered 8 conversions; 186 conversions remain unread',
        verdicts: [{ id: 'complete-reading', subject: 'complete-reading', verdict: 'insufficient', evidence: 'Unread inputs' }] };
      await assert.rejects(bridge ? new Reports(f.engine).report(report, 'token') : f.engine.complete(report, 'token'), /review_in_progress.*same run/);
      assert.equal(f.run().completion, null);
      assert.equal(f.run().released, false);
      assert.equal(f.current().phase, 'reviewing');
      assert.equal(f.current().resolution.currentRunId, f.runId);
      assert.equal(f.createdRuns.length, 0);
      assert.equal(f.current().resolution.reviews?.length ?? 0, 0);
      const progress = await f.report({ covered: ['8 conversions'], remaining: ['186 conversions'] });
      assert.equal(progress.checkpoint.continued, false);
      await f.engine.wake();
      assert.equal(f.continuations.length, 0);
      assert.equal(f.createdRuns.length, 0);
    } finally { await f.close(); }
  });
}

weighted(1)('new reviewer outcomes require explicit responsibility and permit genuine author defects', async () => {
  const f = fixture(); try {
    f.store.putRun({ ...f.run(), reviewResponsibilityRequired: true });
    const report: Completion = { eventId: randomUUID(), taskId: f.submitted.id, runId: f.runId,
      status: 'changes_required', head, summary: 'A concrete author defect', reviewText: 'The result is wrong' };
    await assert.rejects(f.engine.complete(report, 'token'), /Name reviewResponsibility/);
    assert.equal(f.run().completion, null);
    await f.engine.complete({ ...report, reviewResponsibility: 'author' }, 'token');
    assert.equal(f.run().completion?.reviewResponsibility, 'author');
  } finally { await f.close(); }
});

weighted(1)('a legacy reviewer run retains its original report contract', async () => {
  const f = fixture(); try {
    assert.equal(f.run().reviewResponsibilityRequired, undefined);
    const report: Completion = { eventId: randomUUID(), taskId: f.submitted.id, runId: f.runId,
      status: 'changes_required', head, summary: 'Legacy author finding', reviewText: 'A concrete defect' };
    const receipt = await f.engine.complete(report, 'token');
    assert.deepEqual(f.run().completion, report);
    assert.deepEqual(await f.engine.complete(report, 'token'), receipt);
    assert.deepEqual(f.run().completion, report);
  } finally { await f.close(); }
});

weighted(2)('releasing a dispatch hold never authorizes an additional reviewer turn', async () => {
  const f=fixture(); try {
    await f.engine.performTaskControl({taskId:f.submitted.id,version:f.current().version,action:'hold',kind:'dispatch',reason:'STOP'});
    await f.engine.quiesce();
    await f.report({covered:['Already read'],remaining:['Unread']});
    const history=f.run().reviewCheckpoints;
    await f.engine.performTaskControl({taskId:f.submitted.id,version:f.current().version,action:'release',kind:'dispatch'});
    await f.engine.quiesce(); await f.engine.wake();
    assert.equal(f.continuations.length,0);
    assert.equal(f.createdRuns.length,0);
    assert.deepEqual(f.run().reviewCheckpoints,history);
    assert.equal(f.run().completion,null);
  } finally {await f.close();}
});

// An operator-stopped turn must not be revived by missing-callback maintenance.

weighted(1)('dispatch hold fences stopped-run recovery and reminders while accepted results settle', async () => {
  const f = fixture(); try {
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version,
      action: 'hold', kind: 'dispatch', reason: 'Operator stops all Project-A turns' });
    await f.engine.quiesce();
    let sends = 0, observations = 0, bindings = 0;
    f.engine.resolution.adapter.notify = async () => { sends++; };
    f.adapter.observe = async () => { observations++; return { id: 'review-agent', workspaceId: 'workspace',
      status: 'idle', active: false, permissions: false, error: '' }; };
    f.engine.resolution.adapter.findRunAgents = async () => { bindings++; return []; };
    const before = f.run();
    await f.engine.resolution.observe();
    await f.engine.resolution.remindStoppedRun(f.current(), f.run());
    await f.engine.resolution.remindStoppedWorker(f.current());
    await f.engine.resolution.resumeTransientProviderThread(f.current(), f.run(), { id: 'review-agent',
      workspaceId: 'workspace', status: 'error', active: false, permissions: false, error: 'temporary provider failure' });
    assert.equal(sends, 0);
    assert.equal(observations, 0);
    assert.deepEqual(f.run(), before);
    f.store.putRun({ ...before, agentId: null });
    await f.engine.resolution.observe();
    assert.equal(bindings, 0);
    f.store.putRun({ ...before, completion: { taskId: f.submitted.id, runId: f.runId, eventId: 'accepted',
      status: 'ready_to_merge', head, summary: 'Already accepted result' } });
    await f.engine.resolution.observe();
    assert.equal(f.run().released, true);
    assert.equal(f.run().completion?.eventId, 'accepted');
    assert.equal(sends, 0);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

const externalCheckDetail = `${EXTERNAL_MERGE_CHECK_REASON_PREFIX} Command failed: gh api repos/example/repo/pulls/7\nerror connecting to api.github.com`;
/** The reviewer incident a parked external-merge check records, with its fingerprint derived as ensureIncident does. */
function externalCheckIncident(f: ReturnType<typeof fixture>, detail = externalCheckDetail, overrides: Partial<Incident> = {}) {
  const task = f.current(), run = f.run(), timestamp = new Date().toISOString();
  const key = incidentKey(task, run, detail, f.store.runs(task.id));
  return incidentSchema.parse({ id: key.id, fingerprint: key.id, role: 'reviewer', runId: run.id, attempt: 0, cause: key.cause, detail, action: '', status: 'reconciling', createdAt: timestamp, updatedAt: timestamp, ...overrides });
}
/** Legacy shape: the check incident is still reconciling while the flag and reason were already restored. */
function restoredLegacyCheck(f: ReturnType<typeof fixture>, overrides: Partial<Incident> = {}) {
  f.store.update(f.submitted.id, { reason: EXTERNAL_MERGE_CHECK_RECOVERED_REASON, resolution: { ...f.current().resolution, attention: false, incident: externalCheckIncident(f, externalCheckDetail, overrides) } });
}

weighted(1)('a fresh successful external-merge probe recovers only its matching check incident and keeps the review run', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff', 'Brief'], remaining: ['Proofs'] }, 'external-check-cp');
    const checkpoints = structuredClone(f.run().reviewCheckpoints), brief = f.current().briefVersions.at(-1);
    restoredLegacyCheck(f);
    // Before a fresh probe the existing guard refuses: the restored row still carries a reconciling incident.
    assert.notEqual((await acceptControl(f, reviewControl(f))).state, 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 0);

    Object.assign(f.adapter, { externalMerge: async () => null });
    assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()), false);
    assert.equal(f.current().resolution.incident?.status, 'resolved');
    assert.equal(f.current().resolution.attention, false);
    assert.equal(f.current().phase, 'reviewing');
    assert.equal(f.current().prHead, head);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.run().released, false);
    assert.equal(f.run().status, 'running');
    assert.deepEqual(f.run().reviewCheckpoints, checkpoints);
    assert.deepEqual(f.current().briefVersions.at(-1), brief);
    assert.equal(f.current().resolution.review, null);
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'external_merge_check_incident_resolved').length, 1);
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'incident' && event.detail.includes('"status":"resolved"')).length, 1);

    const outcome = await acceptControl(f, reviewControl(f));
    assert.equal(outcome.state, 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.reviewerDeliveries[0].runId, f.runId);
    // A second observation has nothing left to resolve and writes no second recovery.
    assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()), false);
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'external_merge_check_incident_resolved').length, 1);
  } finally { await f.close(); }
});

weighted(4)('an attention-parked check restores attention and resolves its incident only after a fresh successful probe', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
    f.store.update(f.submitted.id, { reason: externalCheckDetail, resolution: { ...f.current().resolution, attention: true, incident: externalCheckIncident(f) } });
    Object.assign(f.adapter, { externalMerge: async () => { throw new Error('gh api network error'); } });
    assert.equal(await f.engine.resolution.recoverExternalMerge(f.current()), true);
    assert.equal(f.current().resolution.attention, true);
    assert.equal(f.current().resolution.incident?.status, 'reconciling');
    assert.notEqual((await acceptControl(f, reviewControl(f))).state, 'succeeded');
    assert.equal(f.reviewerDeliveries.length, 0);

    Object.assign(f.adapter, { externalMerge: async () => null });
    await f.engine.resolution.recoverExternalMerge(f.current());
    assert.equal(f.current().resolution.attention, false);
    assert.equal(f.current().resolution.incident?.status, 'resolved');
    assert.equal(f.run().released, false);
    assert.equal((await acceptControl(f, reviewControl(f))).state, 'succeeded');
  } finally { await f.close(); }
});

weighted(1)('a fresh failed probe keeps the restored check incident blocked', async () => {
  const f = fixture(); try {
    restoredLegacyCheck(f);
    Object.assign(f.adapter, { externalMerge: async () => { throw new Error('gh api network error'); } });
    await f.engine.resolution.recoverExternalMerge(f.current());
    assert.equal(f.current().resolution.incident?.status, 'reconciling');
    assert.equal(f.current().resolution.attention, true);
    assert.notEqual((await acceptControl(f, reviewControl(f))).state, 'succeeded');
  } finally { await f.close(); }
});

weighted(9)('a successful probe leaves unrelated, forged, escalated or otherwise fenced incidents and effects unresolved', async () => {
  const scenarios: { name: string; setup: (f: ReturnType<typeof fixture>) => void }[] = [
    { name: 'unrelated worker incident', setup: f => f.store.update(f.submitted.id, { reason: 'Worker stopped without callback', resolution: { ...f.current().resolution, attention: false, incident: externalCheckIncident(f, 'Worker stopped without callback', { cause: 'missing_callback' }) } }) },
    { name: 'external-looking detail under another role', setup: f => restoredLegacyCheck(f, { role: 'coordinator' }) },
    { name: 'forged fingerprint', setup: f => restoredLegacyCheck(f, { fingerprint: 'forged' }) },
    { name: 'another run identity', setup: f => restoredLegacyCheck(f, { runId: 'other-run' }) },
    { name: 'callback reminder action', setup: f => restoredLegacyCheck(f, { action: 'callback_reminder' }) },
    { name: 'other attention', setup: f => f.store.update(f.submitted.id, { reason: 'Revision budget exhausted', resolution: { ...f.current().resolution, attention: true, incident: externalCheckIncident(f) } }) },
    { name: 'active recovery', setup: f => { restoredLegacyCheck(f); f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, recoveryActive: true } }); } },
    { name: 'uncertain merge response', setup: f => { restoredLegacyCheck(f); f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, mergeResponseOutcome: 'uncertain' } }); } },
    { name: 'publication effect', setup: f => { restoredLegacyCheck(f); f.store.setMeta(`reviewPublication:${f.runId}`, { status: 'uncertain' }); } },
  ];
  for (const scenario of scenarios) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      scenario.setup(f);
      const before = f.current().resolution.incident;
      Object.assign(f.adapter, { externalMerge: async () => null });
      await f.engine.resolution.recoverExternalMerge(f.current());
      assert.equal(f.current().resolution.incident?.status, before?.status, scenario.name);
      // The fence itself refuses, never a version race (milestone QA a43d6304: before the
      // report settled its wake, every scenario here was refused only as "Task changed").
      const outcome = await acceptControl(f, reviewControl(f));
      assert.equal(outcome.state, 'failed', scenario.name);
      assert.match(outcome.diagnostic ?? '', /Reviewer continuation refused before send: (An unresolved task incident or recovery fence|Merge, publication or validation intent) blocks reviewer continuation/, scenario.name);
      assert.equal(f.reviewerDeliveries.length, 0, scenario.name);
    } finally { await f.close(); }
  }
  // Spec 050: a checkpoint continuation is refused only while its incident reconciles.
  // The probe leaves an escalated incident escalated; the owner's restart then applies.
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
    restoredLegacyCheck(f, { status: 'escalated' });
    Object.assign(f.adapter, { externalMerge: async () => null });
    await f.engine.resolution.recoverExternalMerge(f.current());
    assert.equal(f.current().resolution.incident?.status, 'escalated', 'the probe never resolves an escalated incident');
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'external_merge_check_incident_resolved').length, 0, 'nor credits it');
    const escalated = f.current().resolution.incident!;
    const outcome = await acceptControl(f, reviewControl(f));
    assert.equal(outcome.state, 'succeeded', outcome.diagnostic);
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.reviewerDeliveries[0].runId, f.runId, 'the same reviewer run continues');
    // Ordinary settlement: the owner control supersedes the incident and keeps its history.
    const settled = f.current().resolution.incident!;
    assert.equal(settled.id, escalated.id);
    assert.equal(settled.status, 'resolved');
    assert.match(settled.detail, /^Superseded by an owner control: reviewer continuation: restart reviewer: .*; original: External merge check/);
    const kinds = f.store.events(f.submitted.id).map(event => event.kind);
    assert.ok(kinds.includes('owner_fence_settled') && kinds.includes('operator_control'), JSON.stringify(kinds.slice(0, 10)));
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'external_merge_check_incident_resolved').length, 0, 'never credited to the probe');
  } finally { await f.close(); }
});

weighted(7)('a successful probe that races a change, pause or lease across its await resolves nothing', async () => {
  const races: { name: string; during: (f: ReturnType<typeof fixture>) => void }[] = [
    { name: 'task version', during: f => f.store.update(f.submitted.id, { reason: 'Changed while probing' }) },
    { name: 'incident identity', during: f => f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, incident: externalCheckIncident(f, externalCheckDetail, { id: 'replaced' }) } }) },
    { name: 'run identity', during: f => f.store.putRun({ ...f.run(), status: 'superseded' }) },
    { name: 'pause', during: f => f.store.setMeta('paused', true) },
    { name: 'reviewer lease', during: f => { f.states.set('review-agent', { ...f.states.get('review-agent')!, active: true, status: 'running' }); } },
  ];
  for (const race of races) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
      restoredLegacyCheck(f);
      Object.assign(f.adapter, { externalMerge: async () => { race.during(f); return null; } });
      await f.engine.resolution.recoverExternalMerge(f.current());
      assert.equal(f.current().resolution.incident?.status, 'reconciling', race.name);
      assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'external_merge_check_incident_resolved').length, 0, race.name);
      const outcome = await acceptControl(f, reviewControl(f));
      // Round 4: while paused the restart is recorded for later, and refused then
      // if the incident still reconciles; nothing is sent now.
      assert.notEqual(outcome.state, 'succeeded', race.name);
      assert.equal(f.reviewerDeliveries.length, 0, race.name);
    } finally { await f.close(); }
  }
});

/**
 * A prior round: a released reviewer run at an older head with an authenticated
 * changes_required result, then an accepted revision, then the current reviewer.
 * Overrides build each contradictory or out-of-order variant.
 */
function priorRound(f: ReturnType<typeof fixture>, over: { runHead?: string; completionHead?: string; released?: boolean; status?: Completion['status'];
  sourceAt?: number; revision?: 'before' | 'after' | 'none'; completionRunId?: string; revisionCompletion?: { taskId?: string; runId?: string } } = {}) {
  const current = Date.parse(f.run().createdAt);
  const status = over.status ?? 'changes_required';
  const completion = { eventId: 'prior-review-result', taskId: f.submitted.id, runId: over.completionRunId ?? 'prior-review', status,
    summary: 'Fix the figures', head: over.completionHead ?? otherHead, reviewCommentId: 5543610983 } as Completion;
  f.store.putRun(runSchema.parse({ id: 'prior-review', taskId: f.submitted.id, role: 'reviewer', generation: 1, head: over.runHead ?? otherHead, base,
    agentId: 'prior-reviewer', workspaceId: 'workspace', profile: f.run().profile, status: 'finished', createdAt: new Date(current + (over.sourceAt ?? -3_600_000)).toISOString(),
    lastObservedAt: null, active: false, idleSince: null, released: over.released ?? true, completion }));
  const revision = over.revision ?? 'before';
  if (revision !== 'none') f.store.putRun(runSchema.parse({ id: 'prior-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head: otherHead, base,
    agentId: f.current().agentId ?? 'worker', workspaceId: 'workspace', profile: f.current().profile, status: 'finished',
    createdAt: new Date(current + (revision === 'before' ? -1_800_000 : 60_000)).toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { eventId: 'revision-ready', taskId: over.revisionCompletion?.taskId ?? f.submitted.id, runId: over.revisionCompletion?.runId ?? 'prior-revision',
      status: 'ready_for_review', summary: 'Fixed', prNumber: 7 } as Completion }));
  return { ...completion, runId: 'prior-review' } as Completion;
}

weighted(1)('an authenticated result ends a checkpoint wait despite an older continuation cause', async () => {
  for (const restored of [false, true]) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `existing-result-cp-${restored}`);
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, pendingRevisionCause: 'continuation' } });
      const completion = completionSchema.parse({ eventId: `existing-result-${restored}`, taskId: f.submitted.id, runId: f.runId,
        status: 'blocked', summary: 'No findings; the review environment is unavailable', head,
        reviewResponsibility: 'environment', reviewText: 'No author findings. The required environment is unavailable.' });
      await whileReaderInTurn(f.engine, 'review-agent', () => f.engine.complete(completion, 'token'));
      if (restored) {
        f.store.putRun({ ...f.run(), completion: null });
        f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review: completion } });
      }
      await f.engine.wake(); await f.engine.wake();
      assert.equal(f.run().released, true, `restored=${restored}`);
      assert.equal(f.run().completion?.eventId, completion.eventId);
      assert.equal(f.current().phase, 'blocked');
      assert.equal(f.current().resolution.currentRunId, null);
      assert.equal(f.current().resolution.review?.eventId, completion.eventId);
      assert.equal(f.current().resolution.pendingRevisionCause, null);
      assert.equal(f.reviewerDeliveries.length, 0, 'a result is applied, never continued');
      assert.equal(f.store.eventsAll(f.submitted.id).filter(event => event.kind === 'run_result_applied' && event.detail === f.runId).length, 1);
      assert.deepEqual(f.counts(), { merges: 0, syncs: 0 }, 'an environment block is not approval');
    } finally { await f.close(); }
  }
});

weighted(1)('a checkpoint cannot recover a task result without its authenticated callback receipt', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'unreceipted-result-cp');
    const completion: Completion = { eventId: 'unreceipted-result', taskId: f.submitted.id, runId: f.runId,
      status: 'ready_to_merge', summary: 'Unproven approval', head, reviewCommentId: 7 };
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review: completion } });
    await f.engine.resolution.advance(f.current());
    assert.equal(f.run().completion, null);
    assert.equal(f.run().released, false);
    assert.deepEqual(f.counts(), { merges: 0, syncs: 0 });
  } finally { await f.close(); }
});

weighted(3)("a prior round's result at an older head is history: the current checkpoint continues (Consumer #611)", async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'current-cp');
    const review = priorRound(f);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review } });
    const { collectOwnerVerbFacts, ownerTaskNext } = await import('../core/verbs/owner-verbs');
    const verb = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(item => item.verb === 'restart')!;
    assert.equal(verb.available, true, JSON.stringify(verb));
    const outcome = await acceptControl(f, reviewControl(f));
    assert.equal(outcome.state, 'succeeded', outcome.diagnostic);
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.reviewerDeliveries[0].runId, f.runId, 'the same current reviewer run');
    assert.equal(f.current().resolution.review?.runId, 'prior-review', 'the historical result stays on the task');
  } finally { await f.close(); }
});

weighted(3)("a result at an older head is history for every status after the author returns", async () => {
  const statuses: Completion['status'][] = ['ready_for_review', 'report_ready', 'progress_checkpoint', 'review_in_progress', 'ready_to_merge',
    'changes_required', 'verified', 'proof_executed', 'closed', 'blocked', 'error', 'recovered', 'escalate'];
  for (const status of statuses) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `old-head-${status}`);
      const result = priorRound(f, { status });
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review: result } });
      const outcome = await acceptControl(f, reviewControl(f));
      assert.equal(outcome.state, 'succeeded', `${status}: ${outcome.diagnostic}`);
      assert.equal(f.reviewerDeliveries.length, 1, status);
      assert.equal(f.reviewerDeliveries[0]!.runId, f.runId, status);
      assert.equal(f.current().resolution.review?.runId, 'prior-review', status);
    } finally { await f.close(); }
  }
});

weighted(3)('an idle checkpoint fenced by its own-head result is shown stopped and offers an applicable fresh reviewer', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'own-head-result-cp');
    const result = completionSchema.parse({ eventId: 'own-head-review-result', taskId: f.submitted.id, runId: f.runId,
      status: 'ready_to_merge', summary: 'Approved at this head', head });
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review: result } });
    await f.engine.wake();
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.equal(next.activeRun?.status, 'stopped');
    assert.match(next.stop?.detail ?? '', /reviewer result fences checkpoint/);
    const restart = next.verbs.find(verb => verb.available && verb.verb === 'restart' && verb.args?.role === 'reviewer');
    assert.ok(restart, 'next offers restart role=reviewer fresh');
    assert.equal(restart.args?.fresh, true);
    const outcome = await acceptControl(f, taskControlInputSchema.parse({ ...restart.args,
      reason: 'The result fences the saved checkpoint; start a fresh review at this head', caller: 'owner' }));
    assert.equal(outcome.state, 'succeeded', outcome.diagnostic);
    assert.equal(f.createdRuns.length, 1);
    assert.equal(f.reviewerDeliveries.length, 0, 'the fenced run receives no second turn');
  } finally { await f.close(); }
});

weighted(8)('a review result the lifecycle cannot prove is an earlier round still fences the checkpoint', async () => {
  const shapes = ['own run', 'same head', 'unknown run', 'tampered event', 'unreleased source', 'no revision between', 'revision after the current run',
    'source after the current run', 'changed review head', 'foreign review task', 'foreign completion run', 'missing head',
    'revision completion for another task', 'revision completion for another run'] as const;
  for (const shape of shapes) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `cp-${shape}`);
      let review: Completion;
      if (shape === 'own run') review = { eventId: 'own', taskId: f.submitted.id, runId: f.runId, status: 'changes_required', summary: 'x', head } as Completion;
      else if (shape === 'same head') review = priorRound(f, { runHead: head, completionHead: head });
      else if (shape === 'unknown run') review = { ...priorRound(f), runId: 'no-such-run' };
      else if (shape === 'tampered event') review = { ...priorRound(f), eventId: 'forged-event' };
      else if (shape === 'unreleased source') review = priorRound(f, { released: false });
      else if (shape === 'no revision between') review = priorRound(f, { revision: 'none' });
      else if (shape === 'revision after the current run') review = priorRound(f, { revision: 'after' });
      else if (shape === 'source after the current run') review = priorRound(f, { sourceAt: 120_000, revision: 'after' });
      else if (shape === 'changed review head') review = { ...priorRound(f), head: 'd'.repeat(40) };
      else if (shape === 'foreign review task') review = { ...priorRound(f), taskId: 'another-task' };
      else if (shape === 'foreign completion run') review = priorRound(f, { completionRunId: 'someone-else' });
      else if (shape === 'revision completion for another task') review = priorRound(f, { revisionCompletion: { taskId: 'another-task' } });
      else if (shape === 'revision completion for another run') review = priorRound(f, { revisionCompletion: { runId: 'another-run' } });
      else { const { head: _head, ...headless } = priorRound(f); review = headless as Completion; }
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review } });
      const outcome = await acceptControl(f, reviewControl(f));
      assert.notEqual(outcome.state, 'succeeded', shape);
      assert.match(outcome.diagnostic, /A reviewer result already exists/, shape);
      assert.equal(f.reviewerDeliveries.length, 0, shape);
    } finally { await f.close(); }
  }
});

/** The current worker's own initial ready_for_review on the task row, receipted, with the run's agent_intent event. */
function initialAuthorResult(f: ReturnType<typeof fixture>, over: { receipt?: 'ok' | 'none' | 'tampered'; intentAt?: number[]; runId?: string; status?: 'ready_for_review' | 'blocked'; receivedAt?: number } = {}) {
  const current = Date.parse(f.run().createdAt);
  const task = f.current();
  const workerRun = 'replacement-worker-run';
  const completion = { eventId: 'replacement-ready', taskId: task.id, runId: over.runId ?? workerRun, status: over.status ?? 'ready_for_review', summary: 'Ready at the new head', prNumber: 7 } as Completion;
  f.store.update(task.id, { runId: workerRun, completion });
  const stored = f.current().completion!;
  if ((over.receipt ?? 'ok') !== 'none') f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(stored.eventId, task.id, stored.runId,
    digest(JSON.stringify(over.receipt === 'tampered' ? { ...stored, summary: 'forged' } : stored)), JSON.stringify({ accepted: true, eventId: stored.eventId }));
  for (const offset of over.intentAt ?? [-900_000])
    f.store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)').run(task.id, new Date(current + offset).toISOString(), 'agent_intent', workerRun);
  // A task-wide completion_received event names no run; the proof must not rely on it.
  f.store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)').run(task.id, new Date(current + (over.receivedAt ?? -600_000)).toISOString(), 'completion_received', stored.summary);
}

weighted(3)("a replacement worker's receipted initial result between the rounds also proves the prior review is history (Consumer #611)", async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'initial-proof-cp');
    const review = priorRound(f, { revision: 'none' });
    initialAuthorResult(f);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review } });
    const outcome = await acceptControl(f, reviewControl(f));
    assert.equal(outcome.state, 'succeeded', outcome.diagnostic);
    assert.equal(f.reviewerDeliveries.length, 1);
  } finally { await f.close(); }
});

weighted(5)('an initial author result that is unreceipted, tampered, late, foreign or not ready still fences the checkpoint', async () => {
  for (const shape of ['no receipt', 'tampered receipt', 'worker created after the current run', 'completion for another run', 'blocked result',
    'old result with a re-emitted event', 'event for another worker'] as const) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `initial-${shape}`);
      const review = priorRound(f, { revision: 'none' });
      initialAuthorResult(f, shape === 'no receipt' ? { receipt: 'none' } : shape === 'tampered receipt' ? { receipt: 'tampered' }
        : shape === 'worker created after the current run' ? { intentAt: [60_000] } : shape === 'completion for another run' ? { runId: 'someone-else' }
        : shape === 'blocked result' ? { status: 'blocked' }
        // The worker run was created before the prior review; a later completion_received falls in the window but names no run.
        : shape === 'old result with a re-emitted event' ? { intentAt: [-7_200_000], receivedAt: -600_000 }
        // Only another worker's run was created in the window.
        : { intentAt: [] });
      if (shape === 'event for another worker') f.store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)')
        .run(f.submitted.id, new Date(Date.parse(f.run().createdAt) - 900_000).toISOString(), 'agent_intent', 'another-worker-run');
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review } });
      const outcome = await acceptControl(f, reviewControl(f));
      assert.notEqual(outcome.state, 'succeeded', shape);
      assert.match(outcome.diagnostic, /A reviewer result already exists/, shape);
      assert.equal(f.reviewerDeliveries.length, 0, shape);
    } finally { await f.close(); }
  }
});

/** A delivered turn in these scenarios keeps reading until a later callback. */
function reviewerKeepsReading(f: ReturnType<typeof fixture>) {
  const send = f.adapter.continueReviewer!;
  f.adapter.continueReviewer = async (...args) => {
    const result = await send(...args);
    if (result.sent) f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    return result;
  };
}

// Tom, 2026-10-18: a reviewer checkpoint awaiting continuation is the task coordinator's to continue.

weighted(1)('a checkpoint awaiting continuation is a lifecycle wait; once Queue delivers its continuation the reviewer is shown continuing', async () => {
  const f = fixture(); try {
    reviewerKeepsReading(f);
    // The reader checkpoints from inside its turn: Queue waits for that turn to end.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    await f.engine.wake();
    assert.equal(f.current().resolution.stop?.reason, 'lifecycle');
    assert.equal(f.current().reason, REVIEW_AUTHORIZATION_REQUIRED);
    assert.equal(f.reviewerDeliveries.length, 0, 'a reader still in its turn is not continued');
    const before = f.current().updatedAt ?? '0';
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1, 'one continuation once the turn ended');
    assert.equal(f.current().reason, 'Reviewer continuing from checkpoint 1', 'never re-recorded as awaiting');
    assert.equal(f.current().resolution.stop?.reason ?? 'lifecycle', 'lifecycle');
    assert.ok(!f.store.events(f.submitted.id).some(event => event.kind === 'task_waiting' && event.detail.includes(REVIEW_AUTHORIZATION_REQUIRED)
      && Date.parse(event.at) > Date.parse(f.store.events(f.submitted.id).find(item => item.kind === 'review_auto_continued')!.at)), 'no awaiting wait after the delivery');
    assert.ok(Date.parse(f.current().updatedAt ?? '0') >= Date.parse(before));
  } finally { await f.close(); }
});


weighted(1)('an awaiting reviewer checkpoint opens no coordinator: Queue continues it with restart role=reviewer, and coordinators stay out while it continues', async () => {
  const f = fixture(); try {
    reviewerKeepsReading(f);
    const coordinator = profile('coordinator', 'test/coordinator');
    f.store.setMeta('pool', [...f.store.pool(), { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] }]);
    f.engine.profiles = [...f.engine.profiles, coordinator];
    (f.adapter as unknown as { supportsCoordinatorRecovery: boolean }).supportsCoordinatorRecovery = true;
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    await f.engine.wake();
    const coordinatorRuns = () => f.createdRuns.filter(run => run.role === 'recovery');
    assert.equal(coordinatorRuns().length, 0, 'an awaiting checkpoint gets no coordinator');
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'review_auto_continued'), 'Queue applied the restart');
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'review_delivery_delivered'), 'the reviewer was continued');
    assert.equal(f.current().reason, 'Reviewer continuing from checkpoint 1');
    assert.equal(coordinatorRuns().length, 0, 'no coordinator while the reviewer continues');
  } finally { await f.close(); }
});

weighted(1)('a checkpoint past the budget stops the review and escalates to the owner; it never reads as continuing', async () => {
  const f = fixture(); try {
    f.store.setMeta('reviewContinuationLimit', 1);
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue the checkpointed review' } as never);
    // A coordinator is available from here on.
    const coordinator = profile('coordinator', 'test/coordinator');
    f.store.setMeta('pool', [...f.store.pool(), { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] }]);
    f.engine.profiles = [...f.engine.profiles, coordinator];
    (f.adapter as unknown as { supportsCoordinatorRecovery: boolean }).supportsCoordinatorRecovery = true;
    assert.ok(f.store.pool().some(entry => entry.profileId === coordinator.id && entry.enabled), 'a coordinator is in the pool before the over-budget checkpoint');
    assert.equal((f.adapter as unknown as { supportsCoordinatorRecovery: boolean }).supportsCoordinatorRecovery, true);
    assert.equal(f.reviewerDeliveries.length, 1, 'the first checkpoint was continued once, by the owner');
    // The continued reviewer runs out again; the second checkpoint is past the budget of one.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    await f.report({ covered: ['Diff', 'Tests'], remaining: ['Docs'] }, 'ckpt-2');
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.equal(f.run().reviewCheckpoints?.length, 1, 'the over-budget checkpoint is not saved');
    assert.ok(f.run().reviewBudgetExhaustedAt);
    assert.equal(f.current().reason, REVIEW_BUDGET_EXHAUSTED);
    assert.equal(f.current().resolution.stop?.reason, 'operator_needed');
    // Cutover 7 (PR 850): the spent budget parks on the owner stop alone — no
    // recovery episode is opened; the planner ladder owns it if it ever blocks.
    assert.equal(f.current().resolution.recovery ?? null, null, 'the owner decides without a coordinator episode');
    assert.equal(f.createdRuns.filter(run => run.role === 'recovery').length, 0, 'no coordinator can continue a spent budget');
    assert.equal(f.reviewerDeliveries.length, 1, 'and no second review delivery');
  } finally { await f.close(); }
});

// Tom, 2026-10-18: amending the brief after a reviewer checkpoint must not strand the reviewer.
const continuationBrief = (extra = '') => `---
title: Reviewer continuation
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
status: ready-to-launch
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: Operator approved this disposable brief
---
${['What This Thread Was Doing', 'Why It Matters', 'Current State', 'Boundaries', 'Important Context', 'Suggested Next Move', 'Completion Protocol'].map(section => `## ${section}\n\nBrief instructions.${extra}\n`).join('\n')}`;

weighted(1)('a brief amended after the checkpoint still lets the same reviewer continue, with the current brief and a re-pinned run', async () => {
  const f = fixture({ briefText: continuationBrief() }); try {
    await f.report({ covered: ['Diff'], remaining: ['Native proof'] }, 'ckpt-1');
    const amended = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'amend_brief',
      brief: continuationBrief(' One additional native proof is allowed.'), reason: 'Owner allows one more native proof run' } as never);
    assert.equal(amended.briefVersions.at(-1)!.version, 2);
    const continued = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue with the extra proof allowance' } as never);
    assert.equal(continued.phase, 'reviewing');
    const sent = f.reviewerDeliveries.at(-1)!;
    assert.ok(sent, 'the continuation was delivered to the same reviewer');
    assert.equal(sent.runId, f.runId);
    assert.match(sent.text, /brief changed after your checkpoint \(version 1 → 2\)/);
    assert.match(sent.text, /One additional native proof is allowed\./);
    assert.equal(f.run().briefVersion, 2, 'the reviewer run is re-pinned to the brief it was given');
  } finally { await f.close(); }
});

weighted(1)('the reviewer run is re-pinned only when the amended brief is proven delivered', async () => {
  for (const mode of ['refused-before-send', 'lost-unknown'] as const) {
    const f = fixture({ briefText: continuationBrief() }); try {
      await f.report({ covered: ['Diff'], remaining: ['Native proof'] }, 'ckpt-1');
      await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'amend_brief',
        brief: continuationBrief(' One additional native proof is allowed.'), reason: 'Owner allows one more native proof run' } as never);
      f.setDeliveryMode(mode);
      await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue with the extra proof allowance' } as never).catch(() => null);
      assert.equal(f.run().briefVersion, 1, `${mode}: no proof of delivery, no re-pin`);
      if (mode === 'lost-unknown') {
        // A same-run callback proves the reviewer acted, not which occurrence it
        // belongs to, so it neither settles the send nor re-pins the run: the
        // occurrence stays unknown until its exact timeline message exists.
        await f.engine.complete({ eventId: 'callback-after-unknown-send', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Review complete', head, reviewCommentId: 9 } as never, 'token');
        assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'uncertain');
        assert.equal(f.run().briefVersion, 1, 'callback evidence cannot prove receipt, so no re-pin');
      }
    } finally { await f.close(); }
  }
});

weighted(1)('a checkpoint sent after an amendment the reviewer never received carries the amended brief in the next continuation', async () => {
  const f = fixture({ briefText: continuationBrief() }); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests', 'Native proof'] }, 'ckpt-1');
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue the review' } as never);
    assert.equal(f.run().briefVersion, 1);
    // The owner amends while the reviewer works on v1; its next checkpoint must still read as v1.
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'amend_brief',
      brief: continuationBrief(' One additional native proof is allowed.'), reason: 'Owner allows one more native proof run' } as never);
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    await f.report({ covered: ['Diff', 'Tests'], remaining: ['Native proof'] }, 'ckpt-2');
    assert.equal(f.run().reviewCheckpoints!.at(-1)!.briefVersion, 1, 'stamped with the brief the reviewer holds');
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue with the extra proof allowance' } as never);
    assert.match(f.reviewerDeliveries.at(-1)!.text, /brief changed after your checkpoint \(version 1 → 2\)/);
    assert.equal(f.run().briefVersion, 2, 're-pinned once Paseo accepted the message carrying v2');
  } finally { await f.close(); }
});

weighted(1)('only the exact timeline message settles a lost-reply send, and it re-pins the run', async () => {
  const f = fixture({ briefText: continuationBrief() }); try {
    await f.report({ covered: ['Diff'], remaining: ['Native proof'] }, 'ckpt-1');
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'amend_brief',
      brief: continuationBrief(' One additional native proof is allowed.'), reason: 'Owner allows one more native proof run' } as never);
    // The v2 continuation reaches the reviewer's timeline but Paseo's response is lost.
    f.setDeliveryMode('lost-visible');
    const control = reviewControl(f);
    const first = await acceptControl(f, control);
    assert.equal(first.state, 'needs_attention');
    assert.equal(f.run().briefVersion, 1);
    // A completion is the run's result, never proof of which send produced it: it
    // neither settles the delivery nor re-pins the run. Only the exact timeline
    // message for that send is positive evidence.
    await f.engine.complete({ eventId: 'callback-first', taskId: f.submitted.id, runId: f.runId, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Fix it.' } as never, 'token');
    // Round 4: Queue reads the exact timeline message itself after the callback
    // commits and settles the send from it, upgrading the pin; nothing is resent.
    const sent = f.reviewerDeliveries.length;
    for (let tick = 0; tick < 5 && f.run().briefVersion !== 2; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reviewerDeliveries.length, sent, 'no resend');
    assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'delivered');
    assert.match(String(f.run().reviewDeliveries?.at(-1)?.evidence), /Timeline contains exact user message/);
    assert.equal(f.run().briefVersion, 2, 'the exact timeline message proves receipt of v2');
  } finally { await f.close(); }
});

// Tom, 2026-10-19 (Project-E 072): reviewers that got out of step must not block the task.
weighted(1)('a reviewer stopped at a checkpoint does not own the task for move, even with a stale active flag', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    assert.equal(f.run().active, true, 'the stored flag is stale after the checkpoint');
    const { collectOwnerVerbFacts, ownerTaskNext } = await import('../core/verbs/owner-verbs');
    const work = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'work');
    assert.ok(work?.available, 'move to=work is offered for a checkpointed reviewer');
    // The handler confirms the reviewer is idle by observation and settles it.
    const moved = await f.engine.performTaskControl({ ...work!.args, reason: 'Integration work first', instruction: 'Merge main and resolve the conflicts' } as never);
    assert.equal(moved.phase, 'changes_requested');
  } finally { await f.close(); }
});

weighted(1)('a replaced reviewer\'s late verdict is readopted before release and refused after', async () => {
  const f = fixture(); try {
    // The engine writes run credentials itself; this fixture's createRun also did.
    const tokens = new Map<string, string>();
    (f.adapter as unknown as { createRun: (t: Task, r: Run, token: string) => Promise<{ id: string; workspaceId: string }> }).createRun = async (_t, r, token) => {
      tokens.set(r.id, token); f.createdRuns.push(r); f.states.set(`agent-${r.id}`, { id: `agent-${r.id}`, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    };
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    // An older replacement path left a claim that still authenticates at this head.
    // Historical replacements from other paths can still retain a verdict claim.
    f.store.putRun({ ...f.run(), status: 'superseded', released: false, replacedAt: new Date().toISOString() });
    f.store.update(f.submitted.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution,
      currentRunId: null, reviewerAgentId: null, reviewerProfile: null } });
    await f.engine.wake();
    const replacement = f.current().resolution.currentRunId;
    assert.ok(replacement && replacement !== f.runId, 'a fresh reviewer run is current');
    assert.equal(f.store.run(f.runId)!.released, false, 'the replaced run is not released');
    // A checkpoint cannot continue a non-current run, but replaced is not
    // released: the replaced reviewer's checkpoint still applies as saved
    // progress, while the replacement owns any continuation delivery.
    const progress = await f.engine.complete({ eventId: 'old-ckpt', taskId: f.submitted.id, runId: f.runId, status: 'review_in_progress', summary: 'More reading', head, checkpoint: { covered: ['Diff'], remaining: ['Tests'] } } as never, 'token');
    assert.equal(progress.accepted, true);
    assert.equal((f.store.run(f.runId)!.reviewCheckpoints ?? []).length, 2, "the replaced reviewer's checkpoint applies");
    // An exhausted claim holder keeps its evidence on its own run; the task's
    // reason stays with the current replacement.
    const reasonBefore = f.current().reason;
    f.engine.reviewContinuationLimit = () => 2;
    const rejected = await f.engine.complete({ eventId: 'old-ckpt-2', taskId: f.submitted.id, runId: f.runId, status: 'review_in_progress', summary: 'Still more reading', head, checkpoint: { covered: ['Diff'], remaining: ['Tests'] } } as never, 'token') as { accepted: boolean; checkpoint?: { attention?: string } };
    assert.equal(rejected.accepted, true);
    assert.equal(rejected.checkpoint?.attention, 'review exceeded continuation limit');
    assert.ok(f.store.run(f.runId)!.reviewBudgetExhaustedAt, 'the exhausted claim is recorded on its run');
    assert.equal(f.current().reason, reasonBefore, 'the replaced run does not move the task reason');
    // Its verdict at the exact head lands first: it finishes the review.
    const accepted = await f.engine.complete({ eventId: 'old-verdict', taskId: f.submitted.id, runId: f.runId, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Fix the retry guard.' } as never, 'token');
    assert.equal(accepted.accepted, true);
    assert.equal(f.current().resolution.currentRunId, f.runId, 'the replaced reviewer is current again');
    assert.equal(f.store.run(replacement!)!.released, true, 'the replacement is settled');
    assert.equal(f.store.credentialRunForToken(tokens.get(replacement!)!), null, 'the settled replacement authenticates nothing');
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'replaced_reviewer_readopted'));
    for (let pass = 0; pass < 3 && f.current().phase !== 'changes_requested'; pass++) await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested', 'the verdict advanced the task');
    // After release nothing authenticates: settle the readopted run (its verdict
    // applied), and a late verdict from it — like any released run — refuses.
    f.store.putRun({ ...f.store.run(f.runId)!, released: true, status: 'finished', active: false });
    assert.throws(() => f.store.authenticate(f.runId, 'token'), /Unauthorized callback/);
    await assert.rejects(f.engine.complete({ eventId: 'verdict-after-release', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Looks good', head, reviewResponsibility: 'author', reviewText: 'Approve.' } as never, 'token'), /Unauthorized callback/,
      'readopted before release; refused after');
  } finally { await f.close(); }
});

weighted(1)('a replaced reviewer that lost the first-verdict race stays refused once that verdict is cleared', async () => {
  const f = fixture(); try {
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    const tokens = new Map<string, string>();
    (f.adapter as unknown as { createRun: (t: Task, r: Run, token: string) => Promise<{ id: string; workspaceId: string }> }).createRun = async (_t, r, token) => {
      tokens.set(r.id, token); f.createdRuns.push(r); f.states.set(`agent-${r.id}`, { id: `agent-${r.id}`, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    };
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    // Historical replacements from other paths can still retain a verdict claim.
    f.store.putRun({ ...f.run(), status: 'superseded', released: false, replacedAt: new Date().toISOString() });
    f.store.update(f.submitted.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution,
      currentRunId: null, reviewerAgentId: null, reviewerProfile: null } });
    await f.engine.wake();
    const replacement = f.current().resolution.currentRunId!;
    await f.engine.complete({ eventId: 'new-verdict', taskId: f.submitted.id, runId: replacement, status: 'changes_required', summary: 'Replacement finding', head, reviewResponsibility: 'author', reviewText: 'Fix it.' } as never, tokens.get(replacement)!);
    // The state a fresh-review move leaves at the unchanged head: the replacement's verdict is cleared and nothing is current.
    f.store.putRun({ ...f.store.run(replacement)!, released: true, status: 'finished', active: false });
    const t = f.current();
    f.store.update(t.id, { phase: 'awaiting_review', resolution: { ...t.resolution, review: null, currentRunId: null } }, 'test_fresh_review_move');
    await assert.rejects(f.engine.complete({ eventId: 'old-verdict-late', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Looks good', head, reviewResponsibility: 'author', reviewText: 'Approve.' } as never, 'token'), /Stale run/);
    assert.equal(f.run().completion, null, 'the losing verdict changed nothing');
    assert.equal(f.current().resolution.review, null, 'the fresh-review move cleared the verdict')
    assert.notEqual(f.current().resolution.currentRunId, f.runId);
  } finally { await f.close(); }
});

weighted(1)('a replaced reviewer cannot take the task back while its replacement is still being created', async () => {
  const f = fixture();
  let waking: Promise<BackgroundOutcome> | undefined, failed = false, release: () => void = () => {};
  try {
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (f.adapter as unknown as { createRun: (t: Task, r: Run) => Promise<{ id: string; workspaceId: string }> }).createRun = async (_t, r) => {
      f.createdRuns.push(r); await gate; f.states.set(`agent-${r.id}`, { id: `agent-${r.id}`, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    };
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    // Historical replacements from other paths can still retain a verdict claim.
    f.store.putRun({ ...f.run(), status: 'superseded', released: false, replacedAt: new Date().toISOString() });
    f.store.update(f.submitted.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution,
      currentRunId: null, reviewerAgentId: null, reviewerProfile: null } });
    waking = observeOutcome(f.engine.wake());
    for (let i = 0; i < 50 && !f.createdRuns.length; i++) await new Promise(resolve => setImmediate(resolve));
    const replacement = f.current().resolution.currentRunId!;
    assert.ok(replacement && replacement !== f.runId, 'the replacement is reserved');
    await assert.rejects(f.engine.complete({ eventId: 'old-verdict', taskId: f.submitted.id, runId: f.runId, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Fix it.' } as never, 'token'), /Stale run/);
    release(); await assertCompleted(waking, 'the replacement wake');
    assert.equal(f.current().resolution.currentRunId, replacement);
    assert.equal(f.current().resolution.reviewerAgentId, `agent-${replacement}`);
    assert.equal(f.store.run(replacement)!.released, false);
  } catch (error) { failed = true; throw error; } finally {
    release(); await f.close();
    const note = failed ? await cleanupDiagnostic(waking, 'the replacement wake') : null;
    if (note) process.stderr.write(`[review-continuation] secondary: ${note}\n`);
  }
});

weighted(1)('the first verdict at the head wins: a replaced reviewer arriving after the replacement verdict is refused', async () => {
  const f = fixture(); try {
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    const tokens = new Map<string, string>();
    (f.adapter as unknown as { createRun: (t: Task, r: Run, token: string) => Promise<{ id: string; workspaceId: string }> }).createRun = async (_t, r, token) => {
      tokens.set(r.id, token); f.createdRuns.push(r); f.states.set(`agent-${r.id}`, { id: `agent-${r.id}`, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    };
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    // Historical replacements from other paths can still retain a verdict claim.
    f.store.putRun({ ...f.run(), status: 'superseded', released: false, replacedAt: new Date().toISOString() });
    f.store.update(f.submitted.id, { phase: 'awaiting_review', resolution: { ...f.current().resolution,
      currentRunId: null, reviewerAgentId: null, reviewerProfile: null } });
    await f.engine.wake();
    const replacement = f.current().resolution.currentRunId!;
    await f.engine.complete({ eventId: 'new-verdict', taskId: f.submitted.id, runId: replacement, status: 'changes_required', summary: 'Replacement finding', head, reviewResponsibility: 'author', reviewText: 'Fix it.' } as never, tokens.get(replacement)!);
    await assert.rejects(f.engine.complete({ eventId: 'old-verdict-late', taskId: f.submitted.id, runId: f.runId, status: 'ready_to_merge', summary: 'Looks good', head, reviewResponsibility: 'author', reviewText: 'Approve.' } as never, 'token'), /Stale run/);
    assert.equal(f.run().completion, null, 'the late verdict changed nothing');
  } finally { await f.close(); }
});

weighted(1)('a bound reviewer continues while Queue is paused', async () => {
  const f = fixture(); try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    f.store.setMeta('paused', true);
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    const move = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(v => v.verb === 'move' && v.args?.to === 'review');
    assert.ok(move?.available);
    assert.doesNotMatch(move.note ?? '', /unpaused|unheld/);
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.current().resolution.deferredVerb, null);
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1, 'the checkpoint is delivered once');
  } finally { await f.close(); }
});

weighted(1)('a deferred verb that no longer applies after unpause is recorded as refused, not retried (round 4)', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    await f.engine.wake();
    f.store.update(f.submitted.id, holdPatch(f.current(), 'dispatch', OPERATOR_HOLD_OWNER, 'wait'));
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue the checkpointed review', caller: 'owner-thread' } as never);
    // The task moved on while paused: the checkpoint is no longer current.
    f.store.update(f.submitted.id, { phase: 'done' });
    f.store.update(f.submitted.id, releasePatch(f.current(), 'dispatch'));
    await f.engine.wake();
    assert.equal(f.current().resolution.deferredVerb, null);
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'deferred_verb_refused'));
    await f.engine.wake();
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'deferred_verb_refused').length, 1, 'refused once, never retried');
  } finally { await f.close(); }
});

// Review of PR #534 (Sol): deferred-verb regressions.
const pausedRestart = async (f: ReturnType<typeof fixture>) => {
  await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
  // The reader is still in its turn for this pass, so the paused owner verb is
  // what continues checkpoint 1, not Queue (Tom, 2026-10-31).
  await whileReaderInTurn(f.engine, 'review-agent', () => f.engine.wake());
  f.store.update(f.submitted.id, holdPatch(f.current(), 'dispatch', OPERATOR_HOLD_OWNER, 'wait'));
  return f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue the checkpointed review', caller: 'owner-thread' } as never);
};

weighted(3)('a stop issued after a deferred restart wins: the restart is dropped and nothing is delivered (review #534)', async () => {
  const f = fixture(); try {
    const recorded = await pausedRestart(f);
    assert.ok(recorded.resolution.deferredVerb);
    const delivered = f.reviewerDeliveries.length;
    (f.adapter as unknown as { stopAgentTurn: () => Promise<void> }).stopAgentTurn = async () => {};
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'stop', reason: 'Owner changed their mind', caller: 'owner-thread' } as never);
    assert.equal(f.current().resolution.deferredVerb, null, 'the stop drops the earlier recorded verb');
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, delivered, 'nothing was delivered');
    assert.ok(holdsOf(f.current()).dispatch, 'the existing dispatch hold stands');
  } finally { await f.close(); }
});

weighted(3)('a deferred restart whose checkpoint is no longer the latest is refused, not delivered to the newer one (review #534)', async () => {
  const f = fixture(); try {
    await pausedRestart(f);
    const delivered = f.reviewerDeliveries.length;
    await f.report({ covered: ['Diff', 'Tests'], remaining: ['Docs'] }, 'ckpt-2');
    f.store.update(f.submitted.id, releasePatch(f.current(), 'dispatch'));
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'deferred_verb_refused' && /checkpoint 1 is no longer the latest/.test(event.detail)));
    // The stale owner authorization delivered nothing. Checkpoint 2 gets Queue's
    // own one continuation once the recorded verb is gone (Tom, 2026-10-31).
    const automatic = f.store.events(f.submitted.id).filter(event => event.kind === 'review_auto_continued');
    assert.equal(automatic.length, 1);
    assert.match(automatic[0]!.detail, /^2 run /);
    assert.equal(f.reviewerDeliveries.length, delivered + 1, 'only Queue\'s continuation of checkpoint 2 was sent');
    assert.deepEqual(f.run().reviewDeliveries?.filter(item => item.checkpointOrdinal === 2).map(item => item.reason), ['Queue continues the reviewer from checkpoint 2']);
    assert.equal(f.current().resolution.deferredVerb, null);
  } finally { await f.close(); }
});

weighted(3)('the recorded verb stays recorded while it is being applied, so a crash leaves it to replay (review #534)', async () => {
  const f = fixture(); try {
    await pausedRestart(f);
    const apply = f.engine.performTaskControl.bind(f.engine);
    let seenDuringApply: unknown = 'not called';
    f.engine.performTaskControl = (async (input: never, operationId?: string) => {
      seenDuringApply = f.current().resolution.deferredVerb;
      return apply(input, operationId);
    }) as never;
    f.store.update(f.submitted.id, releasePatch(f.current(), 'dispatch'));
    await f.engine.wake();
    assert.ok(seenDuringApply && seenDuringApply !== 'not called', 'the record is present while the handler runs');
    assert.equal(f.current().resolution.deferredVerb, null, 'and cleared once the handler returned');
  } finally { await f.close(); }
});

weighted(3)('a refused restart keeps the owner stop hold (review #534)', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    await f.engine.wake();
    (f.adapter as unknown as { stopAgentTurn: () => Promise<void> }).stopAgentTurn = async () => {};
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'stop', reason: 'Park it', caller: 'owner-thread' } as never);
    // An unreconciled recovery run with unknown delivery refuses the restart.
    f.store.putRun(runSchema.parse({ id: 'unreconciled-recovery', taskId: f.submitted.id, role: 'recovery', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: null, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false }));
    await assert.rejects(f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Resume', caller: 'owner-thread' } as never));
    assert.ok(holdsOf(f.current()).dispatch?.reason.startsWith('Owner stop:'), 'the refused restart left the stop hold in place');
  } finally { await f.close(); }
});

weighted(1)('an errored reviewer with no live turn refuses the same-run continuation with the fresh-reviewer exit', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
    // Queue #606: a dead provider session cannot receive the continuation,
    // like a closed one, so the pre-send proof refuses with the same
    // fresh-reviewer recovery and its own reason — nothing is sent.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'error', error: 'Connection error' });
    const outcome = await acceptControl(f, reviewControl(f));
    assert.notEqual(outcome.state, 'succeeded');
    assert.match(outcome.diagnostic, /observed errored/);
    assert.match(outcome.diagnostic, /restart role=reviewer fresh/);
    assert.equal(f.reviewerDeliveries.length, 0, 'nothing was sent to the dead session');
    assert.equal(f.current().resolution.currentRunId, f.runId, 'the run keeps its lease for the fresh recovery');
    assert.equal(f.run().completion, null, 'no verdict was invented');
  } finally { await f.close(); }
});

// nucleus#1100 (a consumer task): a fresh review dispatch must not wait
// on a recovery thread whose run has finished, and a busy participant a launch
// really does wait on is named, never silent.
weighted(1)('a fresh review dispatches past a finished recovery run still named as coordinator', async () => {
  const f = fixture(); try {
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    // The released superseded reader is history, and the fresh-review move
    // leaves a pending review reason with no reviewer binding.
    f.store.putRun({ ...f.run(), status: 'superseded', released: true, active: false });
    const generation = f.current().coordinatorGeneration;
    // A finished recovery run the coordinator field still names: its result is
    // recorded, its release bookkeeping pends, and the resolved episode keeps
    // naming it — the shape a consumer task stalled on.
    f.store.putRun(runSchema.parse({ id: 'recovery-run', taskId: f.submitted.id, role: 'recovery', generation, head, base,
      agentId: 'coord-agent', workspaceId: 'workspace', profile: f.run().profile, status: 'finished',
      createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: false,
      idleSince: new Date().toISOString(),
      completion: { taskId: f.submitted.id, runId: 'recovery-run', eventId: 'recovery-done', status: 'recovered', summary: 'Recovery reported no action available' },
      released: false }));
    f.store.update(f.submitted.id, { coordinatorAgentId: 'coord-agent', coordinatorGeneration: generation, phase: 'awaiting_review',
      resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, review: null, stop: null,
        pendingReviewReason: 'Fresh review after the released superseded run', attention: false, recoveryActive: false,
        recovery: { id: 'episode-1100', key: 'episode-1100', generation, runId: 'recovery-run', agentId: 'coord-agent', status: 'resolved',
          summary: 'Superseded by owner move to review', idleSince: null, incidentId: null } } });
    // The finished run's thread still shows a live turn: the gate that silently
    // held every fresh review. A recorded completion is finished work, so the
    // dispatch proceeds; the thread's remaining fences are the visible ones.
    f.states.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    await f.engine.wake();
    assert.ok(f.createdRuns.some(run => run.role === 'reviewer'), 'the fresh reviewer dispatches past the finished recovery run');
    assert.equal(f.current().phase, 'reviewing');
    assert.equal(f.current().resolution.stop, null, 'no launch fence is recorded for finished work');
  } finally { await f.close(); }
});

weighted(1)('a busy unfinished recovery run holds the dispatch with a wait naming the coordinator exits', async () => {
  const f = fixture(); try {
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    f.store.putRun({ ...f.run(), status: 'superseded', released: true, active: false });
    // An unfinished recovery run whose episode is gone but whose turn is still
    // live: the lease polls it, the dispatch declines, and the wait names the
    // verbs that actually stop that turn (review 5853580400, exit-verbs).
    const generation = f.current().coordinatorGeneration;
    f.store.putRun(runSchema.parse({ id: 'recovery-run', taskId: f.submitted.id, role: 'recovery', generation, head, base,
      agentId: 'coord-agent', workspaceId: 'workspace', profile: f.run().profile, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: true, idleSince: null,
      completion: null, released: false }));
    f.store.update(f.submitted.id, { coordinatorAgentId: 'coord-agent', coordinatorGeneration: generation, phase: 'awaiting_review',
      resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, review: null, stop: null,
        pendingReviewReason: 'Fresh review', attention: false, recoveryActive: false, recovery: null } });
    f.states.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    await f.engine.wake();
    assert.equal(f.createdRuns.length, 0, 'the live recovery turn holds the dispatch');
    assert.equal(f.current().resolution.stop?.reason, 'lifecycle');
    assert.match(f.current().resolution.stop?.detail ?? '', /recovery run recovery-run \(agent coord-agent\) still owns its turn/);
    assert.match(f.current().resolution.stop?.detail ?? '', /stop role=coordinator settles it sooner/);
    assert.match(f.current().resolution.stop?.detail ?? '', /route role=coordinator with now/);
    assert.doesNotMatch(f.current().resolution.stop?.detail ?? '', /restart role=coordinator/);
    // The turn settles; the dispatch proceeds.
    f.states.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    await f.engine.wake();
    assert.ok(f.createdRuns.some(run => run.role === 'reviewer'), 'the reviewer dispatches once the recovery turn settles');
    assert.equal(f.current().phase, 'reviewing');
  } finally { await f.close(); }
});

weighted(1)('a review dispatch a busy participant holds is named in the accepting verb reply and in next', async () => {
  const f = fixture(); try {
    (f.adapter as unknown as { publishReview: () => Promise<number> }).publishReview = async () => 101;
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    f.store.putRun({ ...f.run(), status: 'superseded', released: true, active: false });
    f.store.update(f.submitted.id, { phase: 'awaiting_review',
      resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null, reviewerProfile: null, review: null, stop: null,
        pendingReviewReason: 'Fresh review', attention: false, recoveryActive: false } });
    // The retained worker's thread is still busy: the dispatch lease declines,
    // so the restart must say so instead of reporting plain success.
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const restarted = await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version,
      action: 'restart', role: 'reviewer', fresh: true, reason: 'Fresh review', caller: 'owner-thread' } as never);
    assert.match(restarted.reason, /but the launch waits on the retained worker \(agent worker\)/);
    assert.match(restarted.reason, /restart or route with now/);
    assert.equal(f.createdRuns.length, 0, 'no reader launched past the busy thread');
    await f.engine.wake();
    assert.equal(f.createdRuns.length, 0, 'the wake does not dispatch past the busy thread either');
    assert.match(f.current().resolution.stop?.detail ?? '', /retained worker \(agent worker\) still owns its turn/);
    assert.equal(f.current().resolution.stop?.reason, 'lifecycle');
    // The thread settles; the next wake dispatches the reviewer.
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    await f.engine.wake();
    assert.ok(f.createdRuns.some(run => run.role === 'reviewer'), 'the reviewer dispatches once the thread settles');
    assert.equal(f.current().phase, 'reviewing');
  } finally { await f.close(); }
});

// nucleus#1106 shape 3: a checkpoint-continuation wait is derived from a current,
// unreleased reviewer run. The observed incident named a reviewer run that was
// already superseded and released, and the task sat in the wait for hours. A
// released named run cannot be continued, so the wait does not stand: the task
// proceeds to dispatch a reviewer, or its launch shows why not.
weighted(1)('a released named reviewer run cannot hold the checkpoint wait; the task dispatches a fresh reviewer', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'ckpt-released-1');
    assert.equal(f.current().reason, REVIEW_AUTHORIZATION_REQUIRED);
    // The incident's settlement: the named run was superseded and released with
    // no verdict, and the task's binding kept pointing at it.
    f.store.putRun({ ...f.run(), status: 'superseded', released: true, active: false });
    assert.equal(reviewAuthorizationRequired(f.current(), f.store), false, 'a released named run cannot be continued');
    await f.engine.wake();
    const fresh = f.createdRuns.filter(run => run.role === 'reviewer' && run.id !== f.runId);
    assert.ok(fresh.length > 0, 'the task dispatched a fresh reviewer instead of waiting');
    const current = f.current();
    assert.equal(current.resolution.currentRunId, fresh.at(-1)!.id);
    assert.notEqual(current.reason, REVIEW_AUTHORIZATION_REQUIRED, 'the impossible continuation is no longer the visible reason');
    assert.doesNotMatch(current.resolution.stop?.detail ?? '', new RegExp(REVIEW_AUTHORIZATION_REQUIRED.slice(0, 40)), 'no stop still names the released run continuation');
    assert.equal(f.store.eventsAll(f.submitted.id).some(event => event.kind === 'released_run_binding_cleared'), true);
  } finally { await f.close(); }
});

weighted(1)('a recorded continuation cause alone never holds the checkpoint wait', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, 'ckpt-cause-1');
    // The legacy cause with the checkpointed run still current keeps its wait.
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, pendingRevisionCause: 'continuation' } });
    assert.equal(reviewAuthorizationRequired(f.current(), f.store), true);
    // The same cause cannot hold the wait once the named run was released,
    // and a task with no current reviewer run has no continuation to wait for.
    f.store.putRun({ ...f.run(), status: 'superseded', released: true, active: false });
    assert.equal(reviewAuthorizationRequired(f.current(), f.store), false);
    assert.equal(reviewAuthorizationRequired(
      { ...f.current(), resolution: { ...f.current().resolution, currentRunId: null } }, f.store), false);
  } finally { await f.close(); }
});
