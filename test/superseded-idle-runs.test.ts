import { profile as sharedProfile } from './support/fakes';
/**
 * Queue #339: release superseded idle runs on any task through the shared
 * settlement.
 *
 * One general rule, applied on finished and unfinished tasks through the
 * shared reconciler and owner-verb settlement: a stored run the canonical
 * callback binding proves superseded, freshly observed idle with its
 * owned-tool and effect safeguards passing, releases once with its history
 * kept. A current result-pending run always stays held, live and uncertain
 * states refuse with no state change, and the ordinary downstream path works
 * after settlement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { runSchema, submissionSchema, taskControlInputSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { toolTimelinePage } from './support/tool-timeline';
import type { HostProcessFact } from '../core/host/types';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);

type Role = 'worker' | 'reviewer' | 'coordinator';
const profile = (id: string, model: string, roles: Role[]) => sharedProfile(id, model);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-superseded-idle-'));
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree);
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker', ['worker']);
  const reviewer = profile('reviewer', 'test/reviewer', ['reviewer']);
  const coord = profile('coord', 'test/coord', ['coordinator']);
  const all = [worker, reviewer, coord];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : item.id === 'coord' ? 'coordinator' : 'worker'],
    weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Superseded idle', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const states = new Map<string, AgentObservation>();
  const timelineEntries: Array<{ timestamp: string; turnId?: string; item: { type: string; [key: string]: unknown } }> = [];
  let hostProcesses: HostProcessFact[] | null = [];
  const observe = (id: string, state: Partial<AgentObservation> = {}) => states.set(id, {
    id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '', ...state,
  });
  const archived: string[] = [];
  const createdRuns: Run[] = [];
  const createdRunTokens = new Map<string, string>();
  const adapter = {
    profiles: async () => all,
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('no workspaces in this fixture'); },
    findWorkspaces: async () => [],
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw new Error(`Agent ${id} missing`);
      return state;
    },
    agentTimelinePage: async () => toolTimelinePage(timelineEntries),
    hostProcessListing: async () => hostProcesses,
    archiveAgent: async () => {}, notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/7' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/7' }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {},
    verifyReview: async () => 12345, publishReview: async () => 12345,
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r); createdRunTokens.set(r.id, token);
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); createdRunTokens.set(r.id, token); },
    archiveTaskWorkspace: async (_t: Task, id: string, _dir: string, _head: string, allowed: () => boolean) => {
      if (!allowed()) return false;
      archived.push(id);
      return true;
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const taskId = submitted.id;
  const current = () => store.task(taskId);
  const events = (kind: string) => store.eventsAll(taskId).filter(event => event.kind === kind);
  const run = (overrides: Partial<Run> & { id: string }): Run => store.putRun(runSchema.parse({
    taskId, role: 'recovery', generation: current().coordinatorGeneration, head, base,
    agentId: null, workspaceId: 'ws', profile: null, status: 'running',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
    completion: null, released: false, ...overrides,
  })) as unknown as Run;
  return {
    dir, store, engine, adapter, taskId, current, events, observe, archived, createdRuns, createdRunTokens, run,
    timelineEntries, setHostProcesses: (processes: HostProcessFact[] | null) => { hostProcesses = processes; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** An unfinished reviewing task with a retained worker and one current reviewer run. */
function reviewingTask(f: ReturnType<typeof fixture>, runId: string, agentId = 'review-agent') {
  f.observe('worker-agent');
  f.store.update(f.taskId, {
    phase: 'reviewing', workspaceId: 'ws', directory: join(f.dir, 'worktree'),
    agentId: 'worker-agent', runId: 'worker-run',
    profile: { id: 'worker', name: 'worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] },
    workerModel: 'test/worker',
    prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-7', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  });
  f.run({ id: runId, role: 'reviewer', agentId, status: 'running', active: true,
    profile: { id: 'reviewer', name: 'reviewer', provider: 'test', model: 'test/reviewer', notes: '', available: true, problem: '', supportedThinking: [] } });
  f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: runId, reviewerAgentId: agentId } });
  return f.store.run(runId)!;
}

const reviewerBlocked = (taskId: string, runId: string) => ({
  eventId: `verdict-${runId}`, taskId, runId, status: 'blocked' as const,
  summary: 'Reviewer finished without a verdict', head,
});

test('an idle current reader with an unaccepted report stays protected', async () => {
  const f = fixture();
  try {
    const run = reviewingTask(f, 'reader-unaccepted');
    f.observe('review-agent');
    // The verdict is recorded on the run but not yet applied: result pending.
    f.store.setCredential(run.id, 'token');
    f.store.putRun({ ...run, completion: reviewerBlocked(f.taskId, run.id) as never });
    const version = f.current().version;
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.store.run(run.id)!.released, false, 'the current result-pending reader stays held');
    assert.equal(f.events('run_released_from_observed_liveness').length, 0);
    assert.equal(f.current().version, version, 'a hold writes nothing');
  } finally { await f.close(); }
});

test('an idle current reader with an accepted report stays protected', async () => {
  const f = fixture();
  try {
    const run = reviewingTask(f, 'reader-accepted');
    f.observe('review-agent');
    const completion = reviewerBlocked(f.taskId, run.id);
    f.store.putRun({ ...run, completion: completion as never });
    // The report is accepted into the task resolution, but the run still holds its lease.
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, review: { ...completion, reviewText: 'findings' } as never } });
    const version = f.current().version;
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.store.run(run.id)!.released, false, 'the just-accepted reader stays held');
    assert.equal(f.events('run_released_from_observed_liveness').length, 0);
    assert.equal(f.current().version, version, 'a hold writes nothing');
  } finally { await f.close(); }
});

test('a stale idle superseded recovery run settles exactly once, with history kept', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    // The episode was cleared, but two recovery runs were never released.
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'stale-a', agentId: 'coord-a' });
    f.run({ id: 'stale-b', agentId: 'coord-b' });
    f.observe('coord-a');
    f.observe('coord-b');
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 2);
    for (const id of ['stale-a', 'stale-b']) {
      const settled = f.store.run(id)!;
      assert.equal(settled.released, true);
      assert.equal(settled.status, 'superseded');
      assert.equal(settled.completion, null, 'history is kept; no completion is invented');
    }
    assert.equal(f.events('run_released_from_observed_liveness').length, 2);
    assert.match(f.events('run_released_from_observed_liveness')[0]!.detail, /stale-a/);
    // Exactly once: a second pass finds nothing settleable and writes nothing.
    const version = f.current().version;
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.events('run_released_from_observed_liveness').length, 2);
    assert.equal(f.current().version, version, 'no churn once nothing settleable remains');
  } finally { await f.close(); }
});

test('a finished turn settles a running shell after its provider tree proves empty', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'stale-shell-run', agentId: 'coord-shell' });
    f.observe('coord-shell', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'shell-call', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' },
    } });
    f.setHostProcesses([
      { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'claude', cwd: null },
      { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-stale-shell-run.json', cwd: null },
    ]);
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 1);
    assert.equal(f.store.run('stale-shell-run')!.released, true);
    assert.match(f.events('owned_tool_settled')[0]!.detail, /provider pid 100/);
  } finally { await f.close(); }
});

/**
 * project-e#280's live process shape: codex app-server 100 with its Queue MCP
 * report helper 101, a persistent `node_repl` 102, that host's kernel 103 and
 * trusted worker, its code-mode host 105 and the provider server it nests 106.
 * None of those runtimes is a turn's work.
 */
function providerRuntimeTree(runId: string): HostProcessFact[] {
  const cua = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin';
  const install = '/workspace/user/.codex/packages/standalone/releases/0.166.0/bin';
  return [
    { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: `${install}/codex app-server --enable goals`, cwd: null },
    { pid: 101, ppid: 100, pgid: 101, uid: 501, startIdentity: '101@a', command: `node /p/mcp-report.mjs /tickets/mcp-${runId}.json report`, cwd: null },
    { pid: 102, ppid: 100, pgid: 102, uid: 501, startIdentity: '102@a', command: `${cua}/node_repl`, cwd: null },
    { pid: 103, ppid: 102, pgid: 102, uid: 501, startIdentity: '103@a', command: `${cua}/node --experimental-vm-modules /w/.tmpDXkgFc/kernel.js --session-id 9066e962fb30417e9ac3099f52fbc16e --working-dir /work/task`, cwd: null },
    { pid: 104, ppid: 102, pgid: 102, uid: 501, startIdentity: '104@a', command: `${cua}/node /w/.tmpDXkgFc/trusted-worker.js /work/task`, cwd: null },
    { pid: 105, ppid: 100, pgid: 105, uid: 501, startIdentity: '105@a', command: `${install}/codex-code-mode-host`, cwd: null },
    { pid: 106, ppid: 102, pgid: 102, uid: 501, startIdentity: '106@a', command: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://', cwd: null },
  ];
}

test('a finished turn settles a running unknown tool while only the provider own tool runtimes remain', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'stale-repl-run', agentId: 'review-repl' });
    f.observe('review-repl', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'repl-call', name: 'cua_repl.js', status: 'running', detail: { type: 'unknown' },
    } });
    f.setHostProcesses(providerRuntimeTree('stale-repl-run'));
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 1);
    assert.equal(f.store.run('stale-repl-run')!.released, true);
    assert.match(f.events('owned_tool_settled')[0]!.detail, /stale non-turn-bound tool settled/);
    assert.match(f.events('owned_tool_settled')[0]!.detail, /provider pid 100/);
  } finally { await f.close(); }
});

test('a command under the provider own tool runtime still holds a finished turn', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'stale-kernel-child-run', agentId: 'review-kernel-child' });
    f.observe('review-kernel-child', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'repl-call', name: 'cua_repl.js', status: 'running', detail: { type: 'unknown' },
    } });
    f.setHostProcesses([...providerRuntimeTree('stale-kernel-child-run'),
      { pid: 107, ppid: 103, pgid: 102, uid: 501, startIdentity: '107@a', command: "bash -lc 'effigy qa'", cwd: null }]);
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.store.run('stale-kernel-child-run')!.released, false);
    assert.match(f.events('owned_tool_hold')[0]!.detail, /descendant pid 107/);
  } finally { await f.close(); }
});

test('a live turn keeps the provider own tool runtimes as descendants and an unreadable listing holds', async () => {
  // The superseded-run path refuses an active agent before it reads tools, so
  // the turn gate is exercised on the shared proof itself: an idle observation
  // settles the same tree, a live turn keeps it.
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.run({ id: 'stale-turn-run', agentId: 'review-turn' });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'repl-call', name: 'cua_repl.js', status: 'running', detail: { type: 'unknown' },
    } });
    f.setHostProcesses(providerRuntimeTree('stale-turn-run'));
    const proof = () => f.engine.resolution.ownedToolHold('review-turn', {
      requireCompleteEvidence: true, runId: 'stale-turn-run', runIds: ['stale-turn-run'], taskId: f.taskId, workspaceId: 'ws',
    });
    f.observe('review-turn', { status: 'active', active: true, activeTurnId: 'turn-2' });
    assert.match((await proof())!, /is running/, 'a live turn keeps the provider runtimes as descendants');
    f.observe('review-turn', { activeTurnId: null });
    assert.equal(await proof(), null, 'a positively finished turn settles the idle runtimes');
  } finally { await f.close(); }
});

test('fresh idle evidence settles a recorded conflicting tool hold for every bound run', async () => {
  const f = fixture();
  try {
    f.observe('owner', { activeTurnId: null });
    for (const runId of ['old-run', 'new-run'])
      f.store.event(f.taskId, 'owned_tool_hold', JSON.stringify({ runId, reason: 'conflicting identity' }));
    f.timelineEntries.push(
      { timestamp: '2026-11-05T19:50:00.000Z', item: { type: 'tool_call', callId: 'call', name: 'partial', status: 'running', detail: { type: 'shell', command: 'git' } } },
      { timestamp: '2026-11-05T19:51:00.000Z', item: { type: 'tool_call', callId: 'call', name: 'full', status: 'completed', detail: { type: 'shell', command: 'git status' } } },
    );
    const proof = () => f.engine.resolution.ownedToolHold('owner', { requireCompleteEvidence: true, taskId: f.taskId, runId: 'old-run', runIds: ['old-run', 'new-run'], workspaceId: 'ws' });
    assert.equal(await proof(), null);
    assert.deepEqual(f.events('owned_tool_settled').map(event => JSON.parse(event.detail).runId), ['old-run', 'new-run']);
    assert.equal(ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.some(view => typeof view.args?.effect === 'string' && view.args.effect.startsWith('owned_tool.')), false);
    assert.equal(await proof(), null);
    assert.equal(f.events('owned_tool_settled').length, 2);
  } finally { await f.close(); }
});

test('conflicting running shell needs the same empty process proof', async () => {
  const f = fixture();
  try {
    f.observe('owner', { activeTurnId: null });
    for (const [timestamp, command] of [['2026-11-05T19:50:00.000Z', 'git'], ['2026-11-05T19:51:00.000Z', 'git status']])
      f.timelineEntries.push({ timestamp, item: { type: 'tool_call', callId: 'call', name: 'Bash', status: 'running', detail: { type: 'shell', command } } });
    const proof = () => f.engine.resolution.ownedToolHold('owner', { taskId: f.taskId, runId: 'shell-run', runIds: ['shell-run'], workspaceId: 'ws' });
    f.setHostProcesses([...providerRuntimeTree('shell-run'), { pid: 107, ppid: 100, pgid: 100, uid: 501, startIdentity: '107@a', command: 'bash', cwd: null }]);
    assert.match((await proof())!, /descendant pid 107/);
    f.setHostProcesses(providerRuntimeTree('shell-run'));
    assert.equal(await proof(), null);
    assert.equal(f.events('owned_tool_settled').length, 1);
  } finally { await f.close(); }
});

test('an unreadable provider process listing still holds a finished turn', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'stale-unreadable-run', agentId: 'review-unreadable' });
    f.observe('review-unreadable', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'repl-call', name: 'cua_repl.js', status: 'running', detail: { type: 'unknown' },
    } });
    f.setHostProcesses(null);
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.store.run('stale-unreadable-run')!.released, false);
    assert.match(f.events('owned_tool_hold')[0]!.detail, /process tree is unreadable/);
  } finally { await f.close(); }
});

test('a finished turn settles an edit with unknown kind or another unknown tool only after its provider tree proves empty', async () => {
  for (const [kind, name] of [['edit', 'Edit'], ['unknown', 'mystery']] as const) {
    const f = fixture();
    try {
      f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
      f.run({ id: `stale-${kind}-run`, agentId: `coord-${kind}` });
      f.observe(`coord-${kind}`, { activeTurnId: null });
      f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
        type: 'tool_call', callId: `${kind}-call`, name, status: 'running', detail: { type: 'unknown' },
      } });
      const processes: HostProcessFact[] = [
        { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'pi', cwd: null },
        { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: `node /p/mcp-report.mjs /tickets/mcp-stale-${kind}-run.json`, cwd: null },
      ];
      f.setHostProcesses(processes);
      assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 1, kind);
      assert.equal(f.store.run(`stale-${kind}-run`)!.released, true, kind);
      assert.match(f.events('owned_tool_settled')[0]!.detail, /stale non-turn-bound tool settled/);
    } finally { await f.close(); }
  }
});

test('a finished-turn unknown tool stays held while its provider has a live descendant', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'stale-unknown-run', agentId: 'coord-unknown-live' });
    f.observe('coord-unknown-live', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'unknown-call', name: 'mystery', status: 'running', detail: { type: 'unknown' },
    } });
    f.setHostProcesses([
      { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'pi', cwd: null },
      { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-stale-unknown-run.json', cwd: null },
      { pid: 102, ppid: 100, pgid: 100, uid: 501, startIdentity: '102@a', command: 'editor-helper', cwd: null },
    ]);
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.store.run('stale-unknown-run')!.released, false);
    assert.match(f.events('owned_tool_hold')[0]!.detail, /descendant pid 102/);
  } finally { await f.close(); }
});

test('a refused owned-tool retry settles its operation without creating an uncertain-operation fence', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'refused-unknown-run', agentId: 'coord-refused' });
    f.observe('coord-refused', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'refused-call', name: 'Edit', status: 'running', detail: { type: 'unknown' },
    } });
    f.setHostProcesses([
      { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'pi', cwd: null },
      { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-refused-unknown-run.json', cwd: null },
      { pid: 102, ppid: 100, pgid: 100, uid: 501, startIdentity: '102@a', command: 'editor-helper', cwd: null },
    ]);
    f.store.event(f.taskId, 'owned_tool_hold', JSON.stringify({ runId: 'refused-unknown-run', reason: 'previous proof incomplete' }));
    const task = f.current();
    const control = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'retry_effect',
      effect: 'owned_tool.refused-unknown-run', reason: 'Recheck the finished tool' });
    const accepted = await f.engine.startOperation({ key: 'refused-owned-tool-retry', kind: 'task_control',
      payload: { type: 'task_control', control }, taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in accepted);
    const operation = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(operation.state, 'failed', 'the read-only refusal is settled');
    assert.match(operation.diagnostic, /Owned-tool hold refused-unknown-run remains/);
    assert.equal(f.store.operations({ taskId: task.id, states: ['needs_attention'] }).length, 0);
    assert.equal(f.store.run('refused-unknown-run')!.released, false, 'the live descendant still protects the run');

  } finally { await f.close(); }
});

test('a live shell descendant and an unreadable process tree keep the idle run held', async () => {
  for (const processes of [
    [
      { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'claude', cwd: null },
      { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-stale-shell-run.json', cwd: null },
      { pid: 102, ppid: 100, pgid: 100, uid: 501, startIdentity: '102@a', command: 'bash npm test', cwd: null },
    ] satisfies HostProcessFact[], null,
  ]) {
    const f = fixture();
    try {
      f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
      f.run({ id: 'stale-shell-run', agentId: 'coord-shell' });
      f.observe('coord-shell', { activeTurnId: null });
      f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
        type: 'tool_call', callId: 'shell-call', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' },
      } });
      f.setHostProcesses(processes);
      assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
      assert.equal(f.store.run('stale-shell-run')!.released, false);
      assert.equal(f.events('owned_tool_settled').length, 0);
      if (processes) assert.match(f.events('owned_tool_hold')[0]!.detail, /descendant pid 102/);
      else assert.match(f.events('owned_tool_hold')[0]!.detail, /process tree is unreadable/);
    } finally { await f.close(); }
  }
});

test('retry_effect re-proves and settles a listed stale shell hold', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'retry-shell-run', agentId: 'coord-shell' });
    f.observe('coord-shell', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
      type: 'tool_call', callId: 'shell-call', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' },
    } });
    f.setHostProcesses([
      { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'claude', cwd: null },
      { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-retry-shell-run.json', cwd: null },
    ]);
    f.store.event(f.taskId, 'owned_tool_hold', JSON.stringify({ runId: 'retry-shell-run', reason: 'prior process tree was unreadable' }));
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.ok(next.verbs.some(view => view.verb === 'retry_effect' && view.available && view.args?.effect === 'owned_tool.retry-shell-run'));
    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.current().version, effect: 'owned_tool.retry-shell-run', reason: 'Recheck shell liveness' }));
    assert.equal(f.store.run('retry-shell-run')!.released, true);
    assert.match(f.events('owned_tool_settled').at(-1)!.detail, /provider pid 100/);
  } finally { await f.close(); }
});

test('a superseded run hold uses the same agents current helper, while a live descendant still holds', async () => {
  for (const live of [false, true]) {
    const f = fixture();
    try {
      f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
      f.run({ id: 'superseded-agent-run', agentId: 'coord-same' , released: true });
      f.run({ id: 'current-agent-run', agentId: 'coord-same' });
      f.observe('coord-same', { activeTurnId: null });
      f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'turn-1', item: {
        type: 'tool_call', callId: 'same-agent-shell', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' },
      } });
      f.store.event(f.taskId, 'owned_tool_hold', JSON.stringify({ runId: 'superseded-agent-run', reason: 'MCP report helper is missing' }));
      const processes: HostProcessFact[] = [
        { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'claude', cwd: null },
        { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-current-agent-run.json', cwd: null },
      ];
      if (live) processes.push({ pid: 102, ppid: 100, pgid: 100, uid: 501, startIdentity: '102@a', command: 'editor-helper', cwd: null });
      f.setHostProcesses(processes);

      const issue = await f.engine.resolution.ownedToolHold('coord-same', {
        runId: 'superseded-agent-run', runIds: ['current-agent-run', 'superseded-agent-run'],
        taskId: f.taskId, workspaceId: 'ws',
      });
      if (live) {
        assert.match(issue ?? '', /descendant pid 102 remains/);
        assert.equal(f.events('owned_tool_settled').length, 0);
      } else {
        assert.equal(issue, null);
        const settlement = JSON.parse(f.events('owned_tool_settled').at(-1)!.detail) as { runId: string; evidence: string };
        assert.equal(settlement.runId, 'superseded-agent-run');
        assert.match(settlement.evidence, /helper run current-agent-run proves provider pid 100/);
      }
    } finally { await f.close(); }
  }
});

test('retry_effect re-proves a stale shell hold for the task-row worker', async () => {
  const f = fixture();
  try {
    const runId = 'task-row-retry-shell';
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'),
      agentId: 'worker-agent', runId });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.observe('worker-agent', { activeTurnId: null });
    f.timelineEntries.push({ timestamp: new Date().toISOString(), turnId: 'finished-worker-turn', item: {
      type: 'tool_call', callId: 'task-row-shell-call', name: 'Bash', status: 'running', detail: { type: 'shell', command: 'npm test' },
    } });
    const checkedRunIds: string[][] = [];
    f.adapter.noLiveWorkspaceProcesses = async (_workspaceId: string, runIds: readonly string[]) => {
      checkedRunIds.push([...runIds]);
      return null;
    };
    f.store.event(f.taskId, 'owned_tool_hold', JSON.stringify({ runId, reason: 'prior process tree was unreadable' }));
    assert.equal(f.store.run(runId), null, 'the initial worker has no Run row');
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.ok(next.verbs.some(view => view.verb === 'retry_effect' && view.available && view.args?.effect === `owned_tool.${runId}`));

    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.current().version, effect: `owned_tool.${runId}`, reason: 'Recheck the task-row worker shell' }));

    assert.ok(checkedRunIds.some(ids => ids.includes(runId)), 'retry re-proves the task-row run identity');
    const settlement = JSON.parse(f.events('owned_tool_settled').at(-1)!.detail) as { runId: string; evidence: string };
    assert.equal(settlement.runId, runId);
    assert.match(settlement.evidence, /no process carried an MCP ticket/);
  } finally { await f.close(); }
});

test('live, permission-blocked and uncertain states refuse, with no state change', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    f.run({ id: 'live-run', agentId: 'coord-live' });
    f.run({ id: 'permission-run', agentId: 'coord-permission' });
    f.run({ id: 'uncertain-run', agentId: 'coord-uncertain', status: 'uncertain' });
    f.run({ id: 'agentless-run', agentId: null });
    f.run({ id: 'unknown-run', agentId: 'coord-unknown' });
    f.run({ id: 'intent-run', agentId: 'coord-intent', status: 'intent' });
    f.observe('coord-live', { status: 'running', active: true });
    f.observe('coord-permission', { permissions: true });
    f.observe('coord-uncertain');
    f.observe('coord-intent');
    // coord-unknown is never registered: the agent is unreadable.
    const version = f.current().version;
    const before = new Map(['live-run', 'permission-run', 'uncertain-run', 'agentless-run', 'unknown-run', 'intent-run']
      .map(id => [id, JSON.stringify(f.store.run(id))] as const));
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    for (const [id, snapshot] of before) {
      assert.equal(f.store.run(id)!.released, false, `${id} stays held`);
      assert.equal(JSON.stringify(f.store.run(id)), snapshot, `${id} is unchanged`);
    }
    assert.equal(f.events('run_released_from_observed_liveness').length, 0);
    assert.equal(f.current().version, version, 'refusals write nothing');
  } finally { await f.close(); }
});

test('a run with a pending authenticated delivery stays held', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, { phase: 'working', workspaceId: 'ws', directory: join(f.dir, 'worktree'), agentId: 'worker-agent', runId: 'worker-run' });
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, recoveryActive: false, recovery: null } });
    const run = reviewingTask(f, 'delivery-run');
    // The run is superseded by binding (not current), but its review delivery is still reserved.
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: null } });
    f.store.putRun({ ...run, reviewDeliveries: [{ deliveryId: `ns-review-${'c'.repeat(64)}`, authorizationId: 'auth-1', operationId: 'op-1', taskId: f.taskId, runId: run.id, head, checkpointOrdinal: 1, taskVersion: 1, briefVersion: null, briefDigest: null, reason: 'continue', instruction: 'go', createdAt: new Date().toISOString(), status: 'reserved', evidence: '', observedAt: null }] });
    f.observe('review-agent');
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 0);
    assert.equal(f.store.run(run.id)!.released, false, 'a pending authenticated delivery stays held');
  } finally { await f.close(); }
});

test('after settlement the reader report applies and the revision launches', async () => {
  const f = fixture();
  try {
    const reader = reviewingTask(f, 'reader-downstream');
    f.store.update(f.taskId, {
      coordinatorAgentId: 'coord-stale',
      resolution: { ...f.current().resolution, recoveryActive: false, recovery: null },
    });
    f.run({ id: 'stale-recovery', agentId: 'coord-stale' });
    f.observe('coord-stale');
    f.observe('review-agent');
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 1);
    assert.equal(f.store.run('stale-recovery')!.status, 'superseded');
    // The ordinary downstream path works: the reader's report is applied ...
    f.store.setCredential(reader.id, 'token');
    const receipt = await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: reader.id,
      status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' }, 'token');
    assert.equal(receipt.accepted, true);
    await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested');
    // ... and the revision launches on the retained worker.
    const task = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.taskId, version: f.current().version, action: 'restart',
      reason: 'Continue the revision', caller: 'owner-thread', instruction: 'Address the finding and continue',
    }));
    assert.equal(task.phase, 'changes_requested');
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.ok(revision && !revision.released, 'the revision launched');
  } finally { await f.close(); }
});

test('after settlement cleanup archives the workspace', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: 'done', workspaceId: 'ws', directory: join(f.dir, 'worktree'),
      prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
      resolution: { ...f.store.task(f.taskId).resolution, mergedCommit: head, syncedCommit: head, recoveryActive: false, recovery: null },
    });
    f.run({ id: 'stale-done', agentId: 'coord-done' });
    f.observe('coord-done');
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 1);
    f.engine.enqueueCleanup(f.taskId);
    await f.engine.drainCleanup();
    assert.deepEqual(f.archived, ['ws'], 'cleanup archives the workspace after settlement');
  } finally { await f.close(); }
});

test('the recovery busy wait stops toggling once nothing settleable remains', async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', reason: 'Worker blocked: needs a ruling',
      workspaceId: 'ws', directory: join(f.dir, 'worktree'),
      agentId: 'worker-agent', runId: 'worker-run', coordinatorAgentId: 'coord-busy',
      resolution: { ...f.current().resolution, attention: true, recoveryActive: false, recovery: null },
    });
    f.run({ id: 'busy-a', agentId: 'coord-busy' });
    f.run({ id: 'busy-b', agentId: 'coord-busy' });
    f.observe('coord-busy');
    assert.equal(await f.engine.settleSupersededIdleRuns(f.taskId, 'test settlement'), 2);
    await f.engine.resolution.recovery.route(f.current());
    const version = f.current().version;
    const reason = f.current().reason;
    await f.engine.resolution.recovery.route(f.store.task(f.taskId));
    assert.equal(f.current().version, version, 'the busy wait no longer bumps the version');
    assert.equal(f.current().reason, reason, 'the busy wait no longer toggles');
    assert.ok(!f.current().reason.includes('unreleased run'), 'no stale run still owns the wait');
  } finally { await f.close(); }
});
