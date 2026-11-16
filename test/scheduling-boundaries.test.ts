import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { ReviewPublicationTransientError } from '../core/forge/forge-health';
import {
  expiredCallbackReminderReason, missingCallbackStopReason, missingCallbackStopReasonFor,
} from '../core/recovery/task-reasons';
import { submissionSchema, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * nucleus#1257 boundaries for the scheduling owners this PR changed:
 *
 * - the two callback-reminder stop sentences have one owner in `task-reasons`, and
 *   its reader answers for both and for nobody else's sentence;
 * - `gitTransientPlan` alone decides the uncertain-delivery skip, so the plan's
 *   answer and the caller's store writes agree;
 * - a wake that fails while the engine runs is recorded on the task, never dropped.
 */
type Loose = Record<string, any>;
const base = 'b'.repeat(40);

function fixture(t: TestContext) {
  const store = new Store(':memory:');
  const engine = new Engine(store, {} as Adapter, 60_000);
  t.after(async () => { await engine.stop(); store.close(); });
  const add = (): Task => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Boundary',
    repoPath: '/fixture', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  return { store, engine, add };
}

test('the callback-reminder stops are one sentence pair, read for the role that recorded them', () => {
  assert.equal(missingCallbackStopReason('worker'), 'The worker thread stopped without a callback; inspect the thread');
  assert.equal(expiredCallbackReminderReason('reviewer'), 'The reviewer callback reminder expired');
  assert.equal(missingCallbackStopReasonFor(missingCallbackStopReason('worker'), 'worker'), true);
  assert.equal(missingCallbackStopReasonFor(expiredCallbackReminderReason('worker'), 'worker'), true);
  assert.equal(missingCallbackStopReasonFor(missingCallbackStopReason('worker'), 'reviewer'), false,
    'another role\'s stop is not this run\'s stop');
  assert.equal(missingCallbackStopReasonFor('The worker thread stopped and its one callback reminder expired without a result; coordinator attention required', 'worker'), false,
    'the coordinator\'s escalation sentence is a different stop');
});

test('the git-transient plan alone decides the uncertain-delivery skip, and only a publication record lifts it', async t => {
  const f = fixture(t);
  const task = f.add();
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, currentRunId: 'run-1' } });
  const publication = new ReviewPublicationTransientError(new Error('HTTP 502 from api.github.com'));
  const key = `gitTransient:${task.id}`;

  assert.equal(f.engine.deferGitTransient(task.id, publication), false,
    'an unknown review publication with no publication record to observe is never retried blindly');
  assert.equal(f.store.getMeta(key), undefined, 'the skip writes no episode');

  // The publication protocol recorded the write, so its own observation can settle
  // the uncertainty: the same failure now takes the plan's retry path.
  f.store.setMeta('reviewPublication:run-1', { head: 'a'.repeat(40) });
  assert.equal(f.engine.deferGitTransient(task.id, publication), true);
  const episode = f.store.getMeta<Loose>(key);
  assert.equal(typeof episode?.retryAt, 'number');
  assert.ok(episode!.retryAt > Date.now(), 'the retry is dated in the future');
});

test('a wake that fails with the engine running is recorded on the task', async t => {
  const f = fixture(t);
  const task = f.add();
  (f.engine as unknown as Loose).scheduleTaskQuantum = async () => { throw new Error('audit lane discarded'); };

  await f.engine.wakeTask(task.id);

  const recorded = f.store.eventsAll(task.id).filter(event => event.kind === 'wake_failed');
  assert.equal(recorded.length, 1, 'the lost wake is on the task timeline');
  assert.match(recorded[0]!.detail, /Task quantum wake failed: audit lane discarded/);
});

test('recording a failed wake never becomes the failure itself', async t => {
  const f = fixture(t);
  const task = f.add();
  (f.engine as unknown as Loose).scheduleTaskQuantum = async () => { throw new Error('audit lane discarded'); };
  // A store that is closing refuses the write; the wake is lost either way, so the
  // record cannot be allowed to surface as its own unhandled failure.
  f.store.event = (() => { throw new Error('database is not open'); }) as unknown as typeof f.store.event;

  await f.engine.wakeTask(task.id);

  assert.ok(true, 'the wake promise settled instead of rejecting through the record');
});
