import { getWorkRoot } from "../core/workspaces/work-root.mjs";
import { after as restoreEnvironmentAfterTests } from "node:test";
const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
const previousWorkVolumeId = process.env.NUCLEUS_WORK_VOLUME_ID;
process.env.NUCLEUS_WORK_ROOT = "/fixture/work";
process.env.NUCLEUS_WORK_VOLUME_ID = "";
restoreEnvironmentAfterTests(() => {
  if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
  else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  if (previousWorkVolumeId === undefined) delete process.env.NUCLEUS_WORK_VOLUME_ID;
  else process.env.NUCLEUS_WORK_VOLUME_ID = previousWorkVolumeId;
});
/**
 * Order pins for the daemon split (lane `nucleus-simplify`, split map row T2).
 *
 * The coming move PRs change no behaviour, and these four conductors take their
 * meaning from the order of their steps: which `observe` handler wins when
 * several states hold at once, the steps of one `taskQuantum`, the steps of one
 * `auditPass`, and which `retryEffect` branches run before observed-idle
 * settlement. Current behaviour is the spec. A move that reorders a step fails
 * here.
 *
 * Spies replace same-name methods on the instance, the seam rule 2 of the split
 * map keeps alive through delegates.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RECLAIM_DRAIN_FREE_PAGES, Store, operationInputHash } from '../core/store/store';
import { Engine } from '../core/engine';
import { holdPatch } from '../core/merge/merge-hold';
import { runSchema, submissionSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const longAgo = new Date(Date.now() - 3_600_000).toISOString();
type Loose = any;
type Log = string[];

/** Replace `target[name]` with a recording stand-in that returns `result`. */
function spy(log: Log, target: Loose, name: string, result?: (...args: Loose[]) => unknown, label = name) {
  target[name] = (...args: Loose[]) => { log.push(label); return result?.(...args); };
}

function fixture(t: TestContext, adapter: Loose = {}) {
  const store = new Store(':memory:');
  const engine = new Engine(store, adapter as Adapter, 60_000);
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 0);
  t.after(async () => { await engine.stop(); store.close(); });
  const add = (fields: Loose = {}): Task => {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Pin', repoPath: '/fixture',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    return Object.keys(fields).length ? store.update(task.id, fields) : task;
  };
  const patchResolution = (task: Task, fields: Loose) => store.update(task.id, { resolution: { ...store.task(task.id).resolution, ...fields } });
  return { store, engine, adapter, add, patchResolution, resolution: engine.resolution as Loose, internals: engine as Loose };
}

function putRun(store: Store, taskId: string, fields: Loose = {}): Run {
  const run = runSchema.parse({ id: randomUUID(), taskId, role: 'reviewer', generation: 1, head, base, agentId: 'agent', workspaceId: 'ws',
    profile: null, profileGroup: 'group', status: 'running', createdAt: longAgo, lastObservedAt: null, active: false,
    idleSince: longAgo, completion: null, released: false, ...fields });
  store.putRun(run);
  return run;
}

// ---------------------------------------------------------------------------
// observe: which handler wins when several states hold at once
// ---------------------------------------------------------------------------

const observation = (fields: Partial<AgentObservation> = {}): AgentObservation => ({ id: 'agent', workspaceId: 'ws', status: 'idle', active: false,
  permissions: false, error: '', ...fields } as AgentObservation);
const completion = (taskId: string, runId: string) => ({ eventId: randomUUID(), taskId, runId, status: 'changes_required', summary: 'Done', headline: 'Done' });
const QUOTA = 'insufficient_quota';
const running = { status: 'running', active: true, activeTurnId: 'turn' } as Partial<AgentObservation>;
const pausedStop = { at: longAgo, operator: 'operator (board)', runId: null, agentId: 'agent', workspaceId: 'ws', role: 'reviewer' };

interface ObserveRow {
  name: string;
  /** Run fields; `completed` adds a recorded completion. */
  run?: Loose & { completed?: boolean };
  task?: Loose;
  state?: Partial<AgentObservation>;
  held?: boolean;
  paused?: boolean;
  /** Handlers that claim the run, in addition to any state the row sets. */
  claims?: { orphan?: boolean; stalled?: boolean; transient?: boolean; profileIssue?: boolean; heavy?: boolean; refused?: boolean };
  /** The stalled-stop handler throws this. */
  throws?: Error;
  pausesOnThrow?: boolean;
  calls: string[];
  outcome?: { status?: string; released?: boolean; phase?: string; event?: string; lastObserved?: boolean };
}

const observeRows: ObserveRow[] = [
  { name: 'a clean idle reviewer past grace walks every handler to the reminder',
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'retainedProfileIssue', 'heavyRunAlive', 'recoverRefusedReviewer', 'remindStoppedRun'] },
  { name: 'within grace, no reminder and no refusal read', run: { idleSince: new Date().toISOString() },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'retainedProfileIssue', 'heavyRunAlive'] },
  { name: 'a mismatched workspace beats quota and completion', run: { completed: true }, state: { workspaceId: 'other', error: QUOTA },
    calls: ['attention:Observed agent or workspace differs from the recorded run lease'], outcome: { released: false } },
  { name: 'an unknown status beats every handler', state: { status: 'mystery' as Loose, error: QUOTA },
    calls: ['attention:Run state is unknown'] },
  { name: 'an idle orphan settles before quota and the stalled stop', claims: { orphan: true, stalled: true }, state: { error: QUOTA },
    calls: ['supersedeOrphans'] },
  { name: 'a busy orphan is not an orphan yet', claims: { orphan: true }, state: running,
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'stalls.check', 'stalls.settleNotice'] },
  { name: 'pause records the observation and stops before every handler', paused: true, claims: { stalled: true, transient: true }, state: { error: QUOTA },
    calls: [], outcome: { lastObserved: true, released: false } },
  { name: 'pause with a completion releases a finished idle thread and skips resume and replace', paused: true, run: { completed: true }, claims: { stalled: true },
    calls: [], outcome: { status: 'finished', released: true } },
  { name: 'a dispatch hold with a completion releases it before every handler', held: true, run: { completed: true }, claims: { stalled: true }, state: { error: QUOTA },
    calls: [], outcome: { status: 'finished', released: true } },
  { name: 'a dispatch hold with no completion is never read', held: true, claims: { stalled: true },
    calls: [], outcome: { lastObserved: false } },
  { name: 'a stalled stop beats a transient resume and quota', claims: { stalled: true, transient: true }, state: { error: QUOTA },
    calls: ['reconcileStalledTurnStop'], outcome: { released: false } },
  { name: 'a transient resume beats quota', claims: { transient: true }, state: { error: QUOTA },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { released: false } },
  { name: 'quota on an idle reviewer replaces it ahead of its completion', run: { completed: true }, state: { error: QUOTA },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { status: 'superseded', released: true, phase: 'awaiting_review', event: 'provider_exhausted' } },
  { name: 'quota on a busy reviewer records it and skips the stall check', state: { ...running, error: QUOTA },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { status: 'running', released: false, event: 'provider_exhausted' } },
  { name: 'quota with no known group asks for a remap ahead of the busy check', run: { profileGroup: null }, state: { ...running, error: QUOTA },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'attention:Exhausted role has no known subscription profile; remap it explicitly'] },
  { name: 'quota past the replacement limit asks for attention ahead of the completion', run: { completed: true }, task: { roleReplacements: 8 }, state: { error: QUOTA },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'attention:Role replacement limit reached; operator attention required'], outcome: { released: false } },
  { name: 'quota does not touch a revision run', run: { role: 'revision', completed: true }, state: { error: QUOTA },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { status: 'finished', released: true } },
  { name: 'a busy run with a completion is checked for a stall, not finished', run: { completed: true }, state: running,
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'stalls.check', 'stalls.settleNotice'], outcome: { released: false } },
  { name: 'a busy coordinator skips the stall check', run: { role: 'closeout' }, state: running,
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'] },
  { name: 'a paused stop skips the reviewer profile check', run: { pausedStop }, claims: { profileIssue: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'waiting:paused_stop'], outcome: { released: false } },
  { name: 'an unavailable reviewer profile is replaced ahead of uncertain delivery', run: { status: 'uncertain' }, claims: { profileIssue: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'retainedProfileIssue'], outcome: { status: 'superseded', released: true, phase: 'awaiting_review', event: 'role_replacement' } },
  { name: 'a completion stops the profile check, so it finishes instead', run: { completed: true }, claims: { profileIssue: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { status: 'finished', released: true } },
  { name: 'a stale coordinator generation supersedes ahead of its completion', run: { role: 'closeout', generation: 7, completed: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { status: 'superseded', released: true } },
  { name: 'a completion beats uncertain delivery, a paused stop and a heavy run', run: { completed: true, status: 'uncertain', pausedStop }, claims: { heavy: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread'], outcome: { status: 'finished', released: true } },
  { name: 'uncertain delivery beats a paused stop and a heavy run', run: { status: 'uncertain', pausedStop }, claims: { heavy: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'attention:Prompt delivery is uncertain; inspect the retained thread before retrying'] },
  { name: 'a paused stop beats a heavy run and the reminder', run: { pausedStop }, claims: { heavy: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'waiting:paused_stop'] },
  { name: 'a heavy run extends the reminder ahead of the grace check', claims: { heavy: true, refused: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'retainedProfileIssue', 'heavyRunAlive', 'extendCallbackReminder'] },
  { name: 'a recovered refusal beats the reminder', claims: { refused: true },
    calls: ['reconcileStalledTurnStop', 'resumeTransientProviderThread', 'retainedProfileIssue', 'heavyRunAlive', 'recoverRefusedReviewer'] },
  { name: 'a disposition in progress skips the run before any read', task: { disposition: 'active' }, run: { completed: true }, claims: { stalled: true },
    calls: [], outcome: { lastObserved: false, released: false } },
  { name: 'a handler transport failure defers the task instead of raising attention', throws: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    calls: ['reconcileStalledTurnStop', 'transportDeferred'] },
  { name: 'a handler fault after a pause lands raises nothing', pausesOnThrow: true, throws: new Error('fault'),
    calls: ['reconcileStalledTurnStop'] },
  { name: 'any other handler fault raises attention', throws: new Error('fault'),
    calls: ['reconcileStalledTurnStop', 'attention:fault'] },
];

for (const row of observeRows) test(`observe: ${row.name}`, async t => {
  const f = fixture(t, { observe: async () => observation(row.state) });
  const { completed, ...runFields } = row.run ?? {};
  const { disposition, roleReplacements, ...taskFields } = row.task ?? {};
  let task = f.add({ phase: 'reviewing', prHead: head, ...taskFields });
  const run = putRun(f.store, task.id, runFields);
  if (completed) f.store.putRun({ ...run, completion: completion(task.id, run.id) } as Run);
  task = f.patchResolution(task, { currentRunId: run.id, roleReplacements: roleReplacements ?? 0 });
  if (disposition) {
    const read = f.store.task.bind(f.store);
    f.internals.store.task = (id: string) => ({ ...read(id), disposition: { status: 'running' } });
  }
  if (row.held) f.store.update(task.id, holdPatch(f.store.task(task.id), 'dispatch', 'operator', 'Wait'));
  f.store.setMeta('paused', row.paused === true);

  const log: Log = [], r = f.resolution, claims = row.claims ?? {};
  r.orphanRuns = () => claims.orphan ? [f.store.run(run.id)] : [];
  spy(log, r, 'supersedeOrphans', () => []);
  spy(log, r, 'reconcileStalledTurnStop', () => { if (row.pausesOnThrow) f.store.setMeta('paused', true); if (row.throws) throw row.throws; return claims.stalled === true; });
  spy(log, r, 'resumeTransientProviderThread', () => claims.transient === true);
  spy(log, r.stalls, 'check', () => null, 'stalls.check');
  spy(log, r.stalls, 'settleNotice', () => undefined, 'stalls.settleNotice');
  spy(log, r, 'retainedProfileIssue', () => claims.profileIssue ? 'gone' : null);
  spy(log, r, 'heavyRunAlive', () => claims.heavy === true);
  spy(log, r, 'extendCallbackReminder');
  spy(log, r, 'recoverRefusedReviewer', () => claims.refused === true);
  spy(log, r, 'remindStoppedRun');
  spy(log, r, 'transportDeferred');
  spy(log, r, 'environmentDeferred');
  r.attention = (_task: Task, reason: string) => { log.push(`attention:${reason}`); };
  r.waiting = (_task: Task, _reason: string, stop: string) => { log.push(`waiting:${stop}`); };

  await r.observe();

  assert.deepEqual(log, row.calls);
  const after = f.store.run(run.id)!, outcome = row.outcome ?? {};
  if (outcome.status !== undefined) assert.equal(after.status, outcome.status);
  if (outcome.released !== undefined) assert.equal(after.released, outcome.released);
  if (outcome.phase !== undefined) assert.equal(f.store.task(task.id).phase, outcome.phase);
  if (outcome.event !== undefined) assert.ok(f.store.eventsAll(task.id).some(event => event.kind === outcome.event), `event ${outcome.event}`);
  if (outcome.lastObserved !== undefined) assert.equal(Boolean(after.lastObservedAt), outcome.lastObserved);
});

test('observe: a run rewritten during its read is left for the next pass', async t => {
  const holder: { run?: Run } = {};
  const f = fixture(t, { observe: async () => { f.store.putRun({ ...holder.run!, temporaryDirectory: '/rewritten' }); return observation({ error: QUOTA }); } });
  const task = f.add({ phase: 'reviewing', prHead: head });
  holder.run = putRun(f.store, task.id);
  const log: Log = [];
  spy(log, f.resolution, 'reconcileStalledTurnStop', () => true);
  await f.resolution.observe();
  assert.deepEqual(log, []);
  assert.equal(f.store.run(holder.run.id)!.lastObservedAt, null);
});

test('observe: a run mid-launch is skipped by the sweep and by a callback wake', async t => {
  let reads = 0;
  const f = fixture(t, { observe: async () => { reads++; return observation(); } });
  const task = f.add({ phase: 'reviewing', prHead: head });
  const run = putRun(f.store, task.id);
  f.store.putRun({ ...run, completion: completion(task.id, run.id) } as Run);
  f.resolution.launchingRuns.add(run.id);
  await f.resolution.observe();
  await f.resolution.observe(null, task.id);
  assert.equal(reads, 0);
  f.resolution.launchingRuns.delete(run.id);
  await f.resolution.observe(null, task.id);
  assert.equal(reads, 1);
});

test('observe: pause still binds an unbound run, and a hold landing during its lookup binds nothing', async t => {
  const log: Log = [];
  const found = [{ id: 'found', workspaceId: 'ws' }];
  const f = fixture(t, { findRunAgents: async () => { log.push('findRunAgents'); return found; }, observe: async () => observation() });
  const task = f.add({ phase: 'reviewing', prHead: head });
  const run = putRun(f.store, task.id, { agentId: null, idleSince: null });
  spy(log, f.resolution, 'reconcileAbsentCreation');

  f.store.setMeta('paused', true);
  await f.resolution.observe();
  assert.deepEqual(log, ['findRunAgents'], 'pause still looks up an unbound in-flight run');
  assert.equal(f.store.run(run.id)!.agentId, 'found');

  f.store.putRun({ ...f.store.run(run.id)!, agentId: null });
  f.store.setMeta('paused', false);
  const lookup = f.adapter.findRunAgents;
  f.adapter.findRunAgents = async (value: Run) => {
    const answer = await lookup(value);
    f.store.update(task.id, holdPatch(f.store.task(task.id), 'dispatch', 'operator', 'Wait'));
    return answer;
  };
  await f.resolution.observe();
  assert.deepEqual(log, ['findRunAgents', 'findRunAgents'], 'a hold landing during the lookup binds nothing');
  assert.equal(f.store.run(run.id)!.agentId, null);
});

// ---------------------------------------------------------------------------
// taskQuantum: spy order
// ---------------------------------------------------------------------------

const QUANTUM_TAIL = ['profileCatalogKnown', 'reconcileClosedRetainedReviewer', 'settleHistoricalProofExecutions', 'settleSupersededIdleRuns', 'recovery.pass', 'archiveFinishedThreads', 'enqueueTitle'];
/** Archive returns on its pause and disposition checks before the adapter property these spies can see. */
const UNARCHIVED_TAIL = QUANTUM_TAIL.filter(step => step !== 'archiveFinishedThreads');
const QUANTUM_HEAD = ['profileCatalogKnown', 'beginValidationScanPass'];
const SETTLED = ['settleFinishedRuns', 'settleRunBuildOutputs'];
const PROBED = [...SETTLED, 'recoverExternalMerge', 'resumeClearedAttention', 'owns'];

interface QuantumOptions { owns?: boolean; externalMerge?: boolean; hold?: boolean; fail?: string; onSettled?: () => void }

/** Every step of one quantum is recorded; archive is seen through the adapter property it reads first. */
function quantumSpies(f: ReturnType<typeof fixture>, options: QuantumOptions = {}) {
  const log: Log = [], e = f.internals, r = f.resolution;
  const step = (target: Loose, name: string, result?: (...args: Loose[]) => unknown, label = name) => spy(log, target, name, (...args) => {
    if (options.fail === label) throw new Error(`${label} failed`);
    return result?.(...args);
  }, label);
  step(e, 'profileCatalogKnown', () => false);
  step(r, 'beginValidationScanPass');
  step(e, 'observeOnly');
  step(e.adapter, 'preflightWorkspaceStorage');
  step(f.store, 'reconcilePrerequisiteWait', () => 'waiting');
  step(e, 'prerequisiteWaitYieldsToLiveWork', () => false);
  step(r, 'reconcileHoldUntil', () => 'held');
  step(e, 'settleFinishedRuns', () => options.onSettled?.());
  step(e, 'settleRunBuildOutputs');
  step(r, 'recoverExternalMerge', () => options.externalMerge === true);
  step(r, 'resumeClearedAttention', () => null);
  step(r, 'owns', () => options.owns === true);
  step(r, 'advance');
  step(e.hooks, 'reconcileTask', () => ({ hold: options.hold === true, records: [] }), 'hooks.reconcileTask');
  step(e, 'note');
  step(e, 'recover');
  step(e, 'reconcile');
  step(e, 'launchAgent');
  step(e, 'launchProofOnly');
  step(e, 'noteStepFailure');
  step(r, 'recordStop', task => task);
  step(e, 'reconcileClosedRetainedReviewer');
  step(e, 'settleHistoricalProofExecutions');
  step(e, 'settleSupersededIdleRuns');
  step(r.recovery, 'pass', undefined, 'recovery.pass');
  step(r.recovery, 'route', undefined, 'recovery.route');
  step(e, 'enqueueTitle');
  Object.defineProperty(e.adapter, 'originAgent', { configurable: true, get() { log.push('archiveFinishedThreads'); return undefined; } });
  return log;
}

const quantumRows: { name: string; task: Loose; options?: QuantumOptions; paused?: boolean; stopped?: boolean; calls: string[] }[] = [
  { name: 'a working task settles, probes, then reconciles, then runs the tail',
    task: { phase: 'working', agentId: 'agent', agentActive: true },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'reconcile', ...QUANTUM_TAIL] },
  { name: 'an owned task advances and never reads hooks',
    task: { phase: 'working', agentId: 'agent', agentActive: true }, options: { owns: true },
    calls: [...QUANTUM_HEAD, ...PROBED, 'advance', ...QUANTUM_TAIL] },
  { name: 'an observed external merge ends the body before ownership',
    task: { phase: 'working', agentId: 'agent', agentActive: true }, options: { externalMerge: true },
    calls: [...QUANTUM_HEAD, ...SETTLED, 'recoverExternalMerge', ...QUANTUM_TAIL] },
  { name: 'a hook hold notes the task instead of reconciling',
    task: { phase: 'working', agentId: 'agent', agentActive: true }, options: { hold: true },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'note', ...QUANTUM_TAIL] },
  { name: 'an unbound creation recovers',
    task: { phase: 'dispatching', workspaceIntent: true },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'recover', ...QUANTUM_TAIL] },
  { name: 'a bound workspace launches',
    task: { phase: 'dispatching', workspaceIntent: true, workspaceId: 'ws' },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'launchAgent', ...QUANTUM_TAIL] },
  { name: 'pause settles in-flight work, skips archive, and still runs the tail',
    task: { phase: 'working', agentId: 'agent', agentActive: true, workspaceId: 'ws' }, paused: true,
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'reconcile', ...UNARCHIVED_TAIL] },
  { name: 'a parked prerequisite wait is the one return that skips the tail',
    task: { phase: 'queued', prerequisiteWait: { id: randomUUID(), waitsFor: [randomUUID()], reason: 'Wait', releasedAt: null } },
    calls: [...QUANTUM_HEAD, 'reconcilePrerequisiteWait', 'prerequisiteWaitYieldsToLiveWork'] },
  { name: 'a self-lifting hold is read before finished runs settle',
    task: { phase: 'working', agentId: 'agent', agentActive: true, holdUntil: { kind: 'task', taskId: randomUUID() } },
    calls: [...QUANTUM_HEAD, 'reconcileHoldUntil', ...PROBED, 'hooks.reconcileTask', 'reconcile', ...QUANTUM_TAIL] },
  { name: 'a path off the checkout volume is never preflighted, and settles as any path',
    task: { phase: 'working', agentId: 'agent', agentActive: true, directory: '/Volumes/retired-volume/pin' },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'reconcile', ...QUANTUM_TAIL] },
  { name: 'a live volume is preflighted before settlement',
    task: { phase: 'working', agentId: 'agent', agentActive: true, directory: `${getWorkRoot()}/pin` },
    calls: [...QUANTUM_HEAD, 'preflightWorkspaceStorage', ...PROBED, 'hooks.reconcileTask', 'reconcile', ...QUANTUM_TAIL] },
  { name: 'a step failure is noted and the tail still runs',
    task: { phase: 'working', agentId: 'agent', agentActive: true }, options: { fail: 'reconcile' },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'reconcile', 'noteStepFailure', ...QUANTUM_TAIL] },
  { name: 'a needs-attention task records its stop ahead of the tail',
    task: { phase: 'needs_attention', agentActive: true },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'recordStop', ...QUANTUM_TAIL] },
  { name: 'a tail failure is noted, and archive and title still run',
    task: { phase: 'working', agentId: 'agent', agentActive: true }, options: { fail: 'settleHistoricalProofExecutions' },
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'reconcile', 'profileCatalogKnown', 'reconcileClosedRetainedReviewer', 'settleHistoricalProofExecutions', 'noteStepFailure', 'archiveFinishedThreads', 'enqueueTitle'] },
  { name: 'a stopped engine skips the settling tail, and archive and title still run',
    task: { phase: 'working', agentId: 'agent', agentActive: true }, stopped: true,
    calls: [...QUANTUM_HEAD, ...PROBED, 'hooks.reconcileTask', 'reconcile', 'archiveFinishedThreads', 'enqueueTitle'] },
];

for (const row of quantumRows) test(`taskQuantum: ${row.name}`, async t => {
  const f = fixture(t);
  const task = f.add(row.task);
  const log = quantumSpies(f, row.options);
  if (row.paused) f.store.setMeta('paused', true);
  if (row.stopped) f.internals.stopped = true;
  await f.internals.taskQuantum(task.id);
  f.internals.stopped = false;
  assert.deepEqual(log, row.calls);
});

test('taskQuantum: a disposition that opens during settlement returns before build output and runs the tail', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'working', agentId: 'agent', agentActive: true });
  const read = f.store.task.bind(f.store);
  let opened = false;
  const log = quantumSpies(f, { onSettled: () => { opened = true; } });
  f.internals.store.task = (id: string) => opened ? { ...read(id), disposition: { status: 'running' } } : read(id);
  await f.internals.taskQuantum(task.id);
  assert.deepEqual(log, [...QUANTUM_HEAD, 'settleFinishedRuns', ...UNARCHIVED_TAIL]);
});

test('taskQuantum: a resolution stop is routed after the recovery pass', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'working', agentId: 'agent', agentActive: true });
  f.resolution.recordStop(task, 'operator_needed', 'Stop', []);
  const log = quantumSpies(f);
  await f.internals.taskQuantum(task.id);
  const tail = log.slice(log.indexOf('recovery.pass'));
  assert.deepEqual(tail, ['recovery.pass', 'recovery.route', 'archiveFinishedThreads', 'enqueueTitle']);
});

// ---------------------------------------------------------------------------
// auditPass: order
// ---------------------------------------------------------------------------

const AUDIT_NOTICES = ['deliverNotices', 'deliverQueuedMessages', 'resumeAskQuestions', 'raiseOperatorQuestions', 'delegateNativeQuestions',
  'resumeResponsibleAnsweredQuestions', 'deliverHoldNotices', 'deliverDecisionNotices', 'deliverDrainNotices'];
const AUDIT_MAINTENANCE = ['retentionCandidates', 'purgeOldTasks', 'reclaimFreedPages', 'closeIdleLanes', 'migrateProjectOwnersToPlanners', 'evaluateLaneDrains'];
const AUDIT_OBSERVE = ['observationInventory', 'observeRetiredWorkers'];
const AUDIT_RECOVERY = ['resumePausedStops', 'recoverExhaustedWorkers', 'archiveRetiredErroredAgents'];
const AUDIT_REPLAY = ['applyDeferredOwnerVerbs', 'origins.pass'];
const AUDIT_ENQUEUE = ['continueAwaitingReviewers', 'enqueuePass', 'observe'];

function auditSpies(f: ReturnType<typeof fixture>, overrides: { observe?: (...args: Loose[]) => unknown } = {}) {
  const log: Log = [], e = f.internals, r = f.resolution, store = f.store as Loose;
  e.lastHookCleanupAt = Date.now();
  // The page-release drain (task 989) runs on every maintenance tick only above its
  // threshold; seed a prune-sized freelist so the audit order below pins its position.
  const seed = store.db.prepare("INSERT INTO verb_outcomes(taskId,at,action,outcome,source,detail) VALUES(?,?,?,?,?,?)");
  store.transaction(() => {
    for (let index = 0; index < 14_000; index++)
      seed.run('drain-seed', '2026-11-09T00:00:00.000Z', 'move', 'applied', 'owner', JSON.stringify({ index, detail: 'd'.repeat(1_500) }));
  });
  store.db.prepare('DELETE FROM verb_outcomes WHERE taskId=?').run('drain-seed');
  if ((store.storeFacts().freePages as number) <= RECLAIM_DRAIN_FREE_PAGES) throw new Error('drain seed left too few free pages');
  spy(log, store, 'retentionCandidates', () => []);
  spy(log, store, 'purgeOldTasks');
  spy(log, store, 'reclaimFreedPages');
  spy(log, store, 'closeIdleLanes');
  spy(log, e, 'migrateProjectOwnersToPlanners');
  spy(log, store, 'evaluateLaneDrains');
  r.observationTargets = () => ['agent'];
  spy(log, e, 'observeRetiredWorkers', () => ({ changed: false, observations: {} }));
  e.retiredObservationPlan = () => ({ due: [], observations: {} });
  e.adapter.observationInventory = async () => { log.push('observationInventory'); return new Map(); };
  e.adapter.originAgent = async () => null;
  e.adapter.findOpenBranchPr = async () => null;
  spy(log, e, 'dispositionDeps', () => ({}), 'resumeDispositions');
  for (const name of AUDIT_RECOVERY) spy(log, e, name);
  spy(log, e, 'applyDeferredOwnerVerbs');
  spy(log, r.origins, 'pass', undefined, 'origins.pass');
  spy(log, r.checkpoints, 'pass', undefined, 'checkpoints.pass');
  spy(log, e, 'continueAwaitingReviewers');
  spy(log, e.lifecycle, 'enqueuePass', undefined, 'enqueuePass');
  spy(log, r, 'observe', overrides.observe);
  spy(log, e, 'reconcile');
  e.scheduleTaskQuantum = async () => { log.push('taskQuantum'); };
  for (const name of AUDIT_NOTICES) spy(log, r, name);
  spy(log, e, 'dispatchQueued');
  spy(log, e, 'enqueueTitle');
  return log;
}

test('auditPass: maintenance, observation, recovery, replay, enqueue, quanta, notices, dispatch, titles', async t => {
  const f = fixture(t);
  f.add({ phase: 'working', agentId: 'agent', agentActive: true, workspaceId: 'ws' });
  const log = auditSpies(f);
  const pass = await f.internals.auditPass(false);
  assert.equal(pass.fault, null);
  assert.deepEqual(log, [...AUDIT_MAINTENANCE, ...AUDIT_OBSERVE, ...AUDIT_RECOVERY, ...AUDIT_REPLAY, ...AUDIT_ENQUEUE,
    'reconcile', 'taskQuantum', ...AUDIT_NOTICES, 'dispatchQueued', 'enqueueTitle']);
});

test('auditPass: a persisted checkpoint intent reconciles after replay, ahead of reviewers', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'awaiting_review' });
  f.store.update(task.id, { checkpoints: { ...task.checkpoints, intent: { id: 'intent', ordinal: 1, summary: 'Checkpoint', head, runId: 'run', eventId: 'event', status: 'pending', createdAt: longAgo } } } as Loose);
  const log = auditSpies(f);
  await f.internals.auditPass(false);
  const at = log.indexOf('checkpoints.pass');
  assert.equal(log[at - 1], 'origins.pass');
  assert.equal(log[at + 1], 'continueAwaitingReviewers');
});

test('auditPass: an incomplete disposition resumes after the observation read, ahead of worker recovery', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'working' });
  const read = f.store.maintenanceTasks.bind(f.store);
  f.internals.store.maintenanceTasks = (...args: [boolean]) => read(...args).map((item: Task) => item.id === task.id ? { ...item, disposition: { status: 'running' } } as Loose : item);
  const log = auditSpies(f);
  await f.internals.auditPass(false);
  const at = log.indexOf('resumeDispositions');
  assert.equal(log[at - 1], 'observeRetiredWorkers');
  assert.equal(log[at + 1], 'resumePausedStops');
});

test('auditPass: pause skips maintenance, recovery launches, retired-errored archive and dispatch; replay, observation, notices and titles still run', async t => {
  const f = fixture(t);
  f.add({ phase: 'working', agentId: 'agent', agentActive: true, workspaceId: 'ws' });
  f.store.setMeta('paused', true);
  const log = auditSpies(f);
  await f.internals.auditPass(false);
  assert.deepEqual(log, [...AUDIT_OBSERVE, ...AUDIT_REPLAY, ...AUDIT_ENQUEUE, 'reconcile', 'taskQuantum', ...AUDIT_NOTICES, 'enqueueTitle']);
});

test('auditPass: a task released by observe takes its follow-up, not a second quantum', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'working', workspaceId: 'ws' });
  const log = auditSpies(f, { observe: (_inventory, _completed, onReleased) => onReleased(task.id) });
  spy(log, f.internals, 'scheduleLifecycleFollowUp', () => true);
  spy(log, f.internals, 'wakeCapacityWaiter');
  await f.internals.auditPass(false);
  const at = log.indexOf('observe');
  assert.deepEqual(log.slice(at, at + 3), ['observe', 'scheduleLifecycleFollowUp', 'wakeCapacityWaiter']);
  assert.equal(log.includes('taskQuantum'), false);
});

test('auditPass: a stop during the last notice ends the pass before dispatch and titles', async t => {
  const f = fixture(t);
  f.add({ phase: 'working', workspaceId: 'ws' });
  const log = auditSpies(f);
  f.resolution.deliverDrainNotices = () => { log.push('deliverDrainNotices'); f.internals.stopped = true; };
  const pass = await f.internals.auditPass(false);
  f.internals.stopped = false;
  assert.equal(pass.covered, false);
  assert.equal(log.at(-1), 'deliverDrainNotices');
});

test('auditPass: a fault stops every later step and is reported as the engine error', async t => {
  const f = fixture(t);
  f.add({ phase: 'working', workspaceId: 'ws' });
  const log = auditSpies(f, { observe: () => { throw new Error('observe fault'); } });
  const pass = await f.internals.auditPass(false);
  assert.equal(pass.fault?.message, 'observe fault');
  assert.equal(log.at(-1), 'observe');
  assert.match(String(f.store.getMeta('engineError')), /observe fault/);
});

// ---------------------------------------------------------------------------
// retryEffect: which branches run before observed-idle settlement
// ---------------------------------------------------------------------------

function retrySpies(f: ReturnType<typeof fixture>) {
  const log: Log = [], e = f.internals;
  spy(log, e, 'settleObservedIdleRuns');
  e.cleanContext = () => undefined;
  return log;
}
const retry = (f: ReturnType<typeof fixture>, task: Task, effect: string | undefined, fields: Loose = {}) => f.internals.retryEffect({
  action: 'retry_effect', taskId: task.id, version: f.store.task(task.id).version, effect, caller: 'operator (board)', reason: 'Pin', ...fields });
const incident = (status: string, runId: string) => ({ id: 'incident', role: 'worker', runId, attempt: 1, cause: 'other', action: '', status, detail: 'Detail', createdAt: longAgo, updatedAt: longAgo });
const fenceSettled = (f: ReturnType<typeof fixture>, task: Task) => f.store.eventsAll(task.id).some(event => event.kind === 'owner_fence_settled');

test('retryEffect: replayed outcomes answer first, in order, ahead of the version check and settlement', async t => {
  for (const [answering, calls] of [
    ['replayedArchiveOutcome', ['replayedArchiveOutcome']],
    ['replayedCatalogArchiveOutcome', ['replayedArchiveOutcome', 'replayedCatalogArchiveOutcome']],
    ['replayedDispositionWorkspaceOutcome', ['replayedArchiveOutcome', 'replayedCatalogArchiveOutcome', 'replayedDispositionWorkspaceOutcome']],
  ] as const) {
    const f = fixture(t);
    const task = f.add({ phase: 'needs_attention' });
    const log = retrySpies(f);
    for (const name of ['replayedArchiveOutcome', 'replayedCatalogArchiveOutcome', 'replayedDispositionWorkspaceOutcome'])
      spy(log, f.internals, name, () => name === answering ? task : null);
    spy(log, f.internals, 'requireOwnerControlCurrent');
    assert.equal(await retry(f, task, 'workspace_archive.ws'), task);
    assert.deepEqual(log, calls);
  }
});

test('retryEffect: a publication reconciles before any settlement', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'needs_attention', prHead: head });
  const run = putRun(f.store, task.id, { status: 'finished', released: true });
  f.store.putRun({ ...run, completion: { ...completion(task.id, run.id), status: 'ready_to_merge' } } as Run);
  f.store.setMeta(`reviewPublication:${run.id}`, { uncertain: true });
  const log = retrySpies(f);
  spy(log, f.resolution, 'reconcileReviewPublication', () => task);
  await retry(f, task, `review_publication.${run.id}`);
  assert.deepEqual(log, ['reconcileReviewPublication']);
});

test('retryEffect: an owned-tool hold settles only after its proof clears, and a live hold settles nothing', async t => {
  for (const hold of [null, 'still running']) {
    const f = fixture(t);
    const task = f.add({ phase: 'needs_attention' });
    const run = putRun(f.store, task.id);
    f.store.event(task.id, 'owned_tool_hold', JSON.stringify({ runId: run.id, reason: 'Tool' }));
    const log = retrySpies(f);
    spy(log, f.internals, 'ownedToolHold', () => hold);
    if (hold) {
      await assert.rejects(retry(f, task, `owned_tool.${run.id}`), /remains: still running/);
      assert.deepEqual(log, ['ownedToolHold']);
    } else {
      await retry(f, task, `owned_tool.${run.id}`);
      assert.deepEqual(log, ['ownedToolHold', 'settleObservedIdleRuns']);
      assert.equal(fenceSettled(f, task), false);
    }
  }
});

test('retryEffect: a cancelled workspace retirement goes straight to its settlement', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'needs_attention', workspaceId: 'ws', directory: '/fixture/ws' });
  const read = f.store.task.bind(f.store);
  f.internals.store.task = (id: string) => ({ ...read(id), phase: 'cancelled', disposition: { status: 'complete', workspaceArchived: false } });
  const log = retrySpies(f);
  spy(log, f.internals, 'assertOwnerAuthority', () => ({ kind: 'operator', note: null }));
  spy(log, f.internals, 'settleWorkspaceRetirement', () => task);
  f.internals.store.update = (_id: string) => task;
  await retry(f, task, 'workspace_archive.ws');
  assert.deepEqual(log, ['assertOwnerAuthority', 'settleWorkspaceRetirement']);
});

test('retryEffect: a terminal archive joins the cleanup lane without settlement', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'done', workspaceId: 'ws', directory: '/fixture/ws', prHead: head });
  f.patchResolution(task, { mergedCommit: head, syncedCommit: head, archivedWorkspaceIds: [],
    workspaceArchiveRetries: [{ workspaceId: 'ws', attempts: 1, error: 'Held', nextAttemptAt: longAgo }] });
  const log = retrySpies(f);
  spy(log, f.internals, 'enqueueCleanup');
  f.internals.awaitProjectionOccurrence = async () => {
    log.push('awaitProjectionOccurrence');
    f.patchResolution(task, { archivedWorkspaceIds: ['ws'] });
  };
  await retry(f, task, 'workspace_archive.ws');
  assert.deepEqual(log, ['enqueueCleanup', 'awaitProjectionOccurrence']);
});

test('retryEffect: a superseded review view joins the cleanup lane without settlement', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'awaiting_review' });
  f.patchResolution(task, { archiveIntentWorkspaceId: 'view' });
  const log = retrySpies(f);
  spy(log, f.internals, 'enqueueCleanup');
  f.internals.awaitProjectionOccurrence = async () => {
    log.push('awaitProjectionOccurrence');
    f.patchResolution(task, { archivedWorkspaceIds: ['view'] });
  };
  await retry(f, task, 'workspace_archive.view');
  assert.deepEqual(log, ['enqueueCleanup', 'awaitProjectionOccurrence']);
});

test('retryEffect: a recovery effect settles idle runs first and supersedes no fence', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'needs_attention', agentId: 'agent', workspaceId: 'ws', runId: 'worker-run', prHead: head });
  f.patchResolution(task, { incident: incident('reconciling', 'worker-run') });
  const log = retrySpies(f);
  const settle = f.internals.settleObservedIdleRuns;
  f.internals.settleObservedIdleRuns = (...args: Loose[]) => { assert.equal(f.store.task(task.id).resolution.incident?.status, 'reconciling'); return settle(...args); };
  const settled = await retry(f, task, 'incident.incident');
  assert.deepEqual(log, ['settleObservedIdleRuns']);
  assert.equal(settled.resolution.incident?.status, 'resolved');
  assert.equal(fenceSettled(f, task), false);
  assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'incident_reproved_settled'));
});

test('retryEffect: an uncertain retry operation settles idle runs first and supersedes no fence', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'needs_attention' });
  const control = { action: 'retry_effect', taskId: task.id, version: task.version, effect: 'workspace_archive.gone', caller: 'operator (board)', reason: 'Earlier' };
  const payload = { type: 'task_control', control } as Loose;
  const accepted = f.store.acceptOperation({ key: 'pin', kind: 'task_control', inputHash: operationInputHash(payload), taskId: task.id, expectedVersion: task.version, payload }) as Loose;
  f.store.putOperation({ ...accepted.operation, state: 'needs_attention', diagnostic: 'Unknown' });
  const log = retrySpies(f);
  await retry(f, task, `task_control_operation.${accepted.operation.id}`);
  assert.deepEqual(log, ['settleObservedIdleRuns']);
  assert.equal(fenceSettled(f, task), false);
  assert.equal(f.store.operation(accepted.operation.id)?.state, 'succeeded');
});

test('retryEffect: an ordinary effect settles idle runs, then supersedes fences, then runs at the version that produced', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'needs_attention', workspaceIntent: true, workspaceId: 'ws', directory: '/fixture/ws' });
  f.patchResolution(task, { incident: incident('escalated', 'gone') });
  const log = retrySpies(f);
  const settle = f.internals.settleObservedIdleRuns;
  f.internals.settleObservedIdleRuns = (...args: Loose[]) => { assert.equal(fenceSettled(f, task), false, 'fences settle after idle runs'); return settle(...args); };
  f.internals.rerecordPlanningBase = (input: { version: number }) => {
    log.push('rerecordPlanningBase');
    assert.equal(fenceSettled(f, task), true, 'the handler runs after fence settlement');
    assert.equal(input.version, f.store.task(task.id).version, 'the handler expects the version settlement produced');
    return f.store.task(task.id);
  };
  await retry(f, task, 'planning_base');
  assert.deepEqual(log, ['settleObservedIdleRuns', 'rerecordPlanningBase']);
});

test('retryEffect: a work disposition on another effect refuses after idle settlement, before fences', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'needs_attention', workspaceIntent: true, workspaceId: 'ws', directory: '/fixture/ws' });
  f.patchResolution(task, { incident: incident('escalated', 'gone') });
  const log = retrySpies(f);
  await assert.rejects(retry(f, task, 'planning_base', { workDisposition: 'archive_if_empty' }), /only valid for a disposition workspace retry/);
  assert.deepEqual(log, ['settleObservedIdleRuns']);
  assert.equal(fenceSettled(f, task), false);
});

test('retryEffect: an effect that is not pending refuses after idle settlement and before fences', async t => {
  const f = fixture(t);
  const task = f.add({ phase: 'working' });
  const log = retrySpies(f);
  await assert.rejects(retry(f, task, 'planning_base'), /No recorded side effect planning_base is pending/);
  assert.deepEqual(log, ['settleObservedIdleRuns']);
  assert.equal(fenceSettled(f, task), false);
});
