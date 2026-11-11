import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { taskControlInputSchema, runSchema, submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { dataHome } from '../shared/data-home.mjs';
import {
  mcpBindingPathFromHostRecord, mcpBindingPathFromProcessCommand, mcpBindingPathFromProcessListing,
  pathIsUnderDataHome, reportBindingReuseDecision, runIdMismatchRefusal,
} from '../core/intake/report-binding';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';
const worker: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] };
const reviewer: Profile = { id: 'reviewer', name: 'reviewer', provider: 'test', model: 'test/reviewer', notes: '', available: true, problem: '', supportedThinking: [] };
const coord: Profile = { id: 'coord', name: 'coord', provider: 'test', model: 'test/coord', notes: '', available: true, problem: '', supportedThinking: [] };
const all = [worker, reviewer, coord];

function outsideTicket(key = 'old') {
  return join(tmpdir(), 'sealed-old-home', 'tickets', `mcp-${key}.json`);
}
function insideTicket(key = 'current') {
  return join(dataHome(), 'tickets', `mcp-${key}.json`);
}

test('pathIsUnderDataHome is a resolved-path prefix, not a move special-case', () => {
  const home = '/workspace/user/.nucleus';
  assert.equal(pathIsUnderDataHome(`${home}/tickets/mcp-run.json`, home), true);
  assert.equal(pathIsUnderDataHome(home, home), true);
  assert.equal(pathIsUnderDataHome(`${home}-backup/tickets/mcp-run.json`, home), false);
  assert.equal(pathIsUnderDataHome('/workspace/user/.paseo/northstar-queue/tickets/mcp-run.json', home), false);
  assert.equal(pathIsUnderDataHome('', home), false);
  assert.equal(pathIsUnderDataHome(home, ''), false);
});

test('reportBindingReuseDecision keeps an unknown path or home and relaunches an outside path', () => {
  const home = '/workspace/user/.nucleus';
  const cases: Array<[string, Parameters<typeof reportBindingReuseDecision>[0], 'keep' | 'fresh']> = [
    ['missing path keeps', { dataHome: home }, 'keep'],
    ['null path keeps', { bindingPath: null, dataHome: home }, 'keep'],
    ['missing home keeps', { bindingPath: outsideTicket() }, 'keep'],
    ['inside keeps', { bindingPath: `${home}/tickets/mcp-run.json`, dataHome: home }, 'keep'],
    ['outside is fresh', { bindingPath: '/old/workspace/tickets/mcp-run.json', dataHome: home }, 'fresh'],
  ];
  for (const [label, facts, expected] of cases) assert.equal(reportBindingReuseDecision(facts), expected, label);
});

test('runIdMismatchRefusal names a resend only when the ticket is under the current data home', () => {
  const inside = runIdMismatchRefusal({
    toolName: 'northstar_report', boundRunId: 'run-1', namedRunId: 'run-1-typo', kind: 'report', bindingUnderDataHome: true,
  });
  assert.equal(inside, 'This northstar_report session is bound to run run-1; the report named run run-1-typo, so nothing was reported. Resend the same report with runId run-1, or omit runId.');
  const outside = runIdMismatchRefusal({
    toolName: 'northstar_report', boundRunId: 'run-1', namedRunId: 'run-1-typo', kind: 'report', bindingUnderDataHome: false,
  });
  assert.equal(outside, 'This northstar_report session is bound to run run-1 through a ticket outside the current data home; the report named run run-1-typo, so nothing was reported. Do not resend through this callback. Nucleus will relaunch this role on a fresh thread that can report.');
  assert.equal(outside.includes('Resend'), false);
});

test('mcpBindingPathFromHostRecord reads the field, labels, or MCP argv', () => {
  const path = '/old/workspace/tickets/mcp-run.json';
  assert.equal(mcpBindingPathFromHostRecord({ mcpBindingPath: path }), path);
  assert.equal(mcpBindingPathFromHostRecord({ labels: { 'nucleus.mcpBindingPath': path } }), path);
  assert.equal(mcpBindingPathFromHostRecord({ labels: { 'northstar.mcpBindingPath': path } }), path);
  assert.equal(mcpBindingPathFromHostRecord({
    config: { mcpServers: { nucleus: { args: ['/plugin/mcp-report.mjs', path, 'report'] } } },
  }), path);
  assert.equal(mcpBindingPathFromHostRecord({ labels: { 'northstar.mcpBinding': 'run' } }), null);
});

test('mcpBindingPathFromProcessCommand reads the live argv and filters by binding key', () => {
  const path = '/old/workspace/tickets/mcp-run-1.json';
  assert.equal(mcpBindingPathFromProcessCommand(`node /plugin/mcp-report.mjs ${path} report`), path);
  assert.equal(mcpBindingPathFromProcessCommand(`node /plugin/mcp-report.mjs ${path} report`, 'run-1'), path);
  assert.equal(mcpBindingPathFromProcessCommand(`node /plugin/mcp-report.mjs ${path} report`, 'other'), null);
  assert.equal(mcpBindingPathFromProcessCommand('node /plugin/mcp-report.mjs report'), null);
  assert.equal(mcpBindingPathFromProcessListing([{ command: `node /plugin/mcp-report.mjs ${path} report` }], 'run-1'), path);
});

type Observation = {
  id: string; workspaceId: string | null; status: string; active: boolean; permissions: boolean; error: string;
  provider?: string; model?: string; mcpBindingPath?: string | null; labels?: Record<string, string>;
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-report-binding-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setProfiles(all.map(({ available, problem, supportedThinking, ...p }) => p));
  store.setMeta('pool', all.map(item => ({
    profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : item.id === 'coord' ? 'coordinator' : 'worker'],
    weight: 1, scopes: ['general'],
  })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Binding relaunch', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);

  const observations = new Map<string, Observation>();
  const idle = (id: string, model?: string, workspaceId = 'workspace') =>
    observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: 'test', model });
  idle('worker-agent', worker.model);
  idle('review-agent', reviewer.model);
  const sent: Run[] = [];
  const created: Run[] = [];
  const adapter = fakeAdapter({
    catalog: async () => ({ providers: [{ key: 'test', label: 'test', available: true, problem: '', models: all.map(p => ({ id: p.model, label: p.model, aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] })) }] }),
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    createAgent: async () => { throw new Error('fixtures do not create workers'); },
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
     notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({ head: store.task(submitted.id).prHead ?? head, url: store.task(submitted.id).prUrl ?? 'https://github.com/example/repo/pull/7' }),
    verifyPrIdentity: async () => ({ head: store.task(submitted.id).prHead ?? head, url: store.task(submitted.id).prUrl ?? 'https://github.com/example/repo/pull/7' }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {}, verifyReview: async () => 12345, publishReview: async () => 12345,
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run) => { created.push(r); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run) => { sent.push(r); },
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const current = () => store.task(submitted.id);
  const events = (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind);
  return {
    dir, store, engine, adapter, taskId: submitted.id, current, events, observations, sent, created,
    bind(path: string | null | undefined, labels?: Record<string, string>) {
      const state = observations.get('worker-agent')!;
      observations.set('worker-agent', { ...state, ...(path !== undefined ? { mcpBindingPath: path } : {}), ...(labels ? { labels } : {}) });
    },
    plantBlockedWithPr() {
      store.update(submitted.id, {
        phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: join(dir, 'worktree'),
        profile: worker, workerModel: worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        completion: { taskId: submitted.id, runId: 'worker-run', eventId: 'blocked-2', status: 'blocked', summary: 'Blocked', prNumber: 7 },
      });
    },
    plantStoppedRevision() {
      store.update(submitted.id, {
        phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: join(dir, 'worktree'),
        profile: worker, workerModel: worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      });
      store.putRun(runSchema.parse({
        id: 'revision-run', taskId: submitted.id, role: 'revision', generation: 1, head, base,
        agentId: 'worker-agent', workspaceId: 'workspace', profile: worker, status: 'running',
        createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: false,
        idleSince: new Date().toISOString(), completion: null, released: false,
      }));
      store.setCredential('revision-run', 'revision-token');
      store.update(submitted.id, { resolution: { ...store.task(submitted.id).resolution, currentRunId: 'revision-run' } });
    },
    async restart() {
      return engine.performTaskControl(taskControlInputSchema.parse({
        taskId: submitted.id, version: current().version, action: 'restart', reason: 'Owner restart',
        caller: CALLER, instruction: 'Continue after the blocker',
      }));
    },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('revision dispatch relaunches a retained thread whose ticket is outside the current data home', async () => {
  const f = fixture(); try {
    f.plantBlockedWithPr();
    f.bind(outsideTicket('worker-run'));
    await f.restart();
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.ok(revision, 'the restart launched a revision');
    assert.equal(f.sent.length, 0, 'the retained thread is not reused');
    assert.equal(f.created.length, 1);
    assert.equal(revision!.agentId, `agent-${revision!.id}`);
    assert.equal(f.current().agentId, `agent-${revision!.id}`);
    assert.equal(f.current().profile?.id, 'worker', 'the same profile continues');
    assert.ok(f.events('report_binding_relaunch').some(event => /outside the current data home/.test(event.detail)));
    assert.equal(f.current().retiredWorkers.at(-1)?.reason, 'Report binding lives outside the current data home');
  } finally { await f.close(); }
});

test('revision dispatch reuses a retained thread whose ticket lives under the current data home', async () => {
  const f = fixture(); try {
    f.plantBlockedWithPr();
    f.bind(insideTicket('worker-run'));
    await f.restart();
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.ok(revision);
    assert.equal(f.created.length, 0, 'no fresh agent');
    assert.equal(f.sent.length, 1);
    assert.equal(revision!.agentId, 'worker-agent');
    assert.equal(f.current().agentId, 'worker-agent');
    assert.equal(f.events('report_binding_relaunch').length, 0);
  } finally { await f.close(); }
});

test('a missing binding path keeps the retained thread', async () => {
  const f = fixture(); try {
    f.plantBlockedWithPr();
    await f.restart();
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.ok(revision);
    assert.equal(revision!.agentId, 'worker-agent');
    assert.equal(f.sent.length, 1);
    assert.equal(f.created.length, 0);
  } finally { await f.close(); }
});

test('restart relaunches when the live MCP argv still names a ticket outside the current data home', async () => {
  const f = fixture(); try {
    f.plantBlockedWithPr();
    const path = outsideTicket('worker-run');
    f.bind(undefined, { 'northstar.mcpBinding': 'worker-run', 'nucleus.mcpBinding': 'worker-run' });
    f.adapter.hostProcessListing = async () => [{
      pid: 1, pgid: 1, uid: 1, startIdentity: '1', command: `node /plugin/mcp-report.mjs ${path} report`, cwd: null,
    }];
    await f.restart();
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.ok(revision);
    assert.equal(f.created.length, 1);
    assert.equal(revision!.agentId, `agent-${revision!.id}`);
    assert.match(f.events('report_binding_relaunch')[0]!.detail, /outside the current data home/);
  } finally { await f.close(); }
});

test('a stale-binding reminder is skipped and restart relaunches instead of looping', async () => {
  const f = fixture(); try {
    f.plantStoppedRevision();
    f.bind(outsideTicket('revision-run'));
    const run = f.store.run('revision-run')!;
    await f.engine.resolution.remindStoppedRun(f.current(), run);
    assert.equal(f.events('callback_reminder').length, 0, 'the reminder never tells the agent to retry the same callback');
    assert.equal(f.events('callback_reminder_skipped').length, 1);
    assert.match(f.events('callback_reminder_skipped')[0]!.detail, /outside the current data home/);
    assert.ok(f.events('report_binding_relaunch').some(event => event.detail.includes('revision-run') && /outside the current data home/.test(event.detail)));
    await f.restart();
    await f.engine.wake();
    const next = f.store.runs(f.taskId).findLast(item => item.role === 'revision' && item.id !== 'revision-run');
    assert.ok(next, 'restart launched a replacement revision');
    assert.equal(f.created.length, 1);
    assert.equal(next!.agentId, `agent-${next!.id}`);
    assert.notEqual(f.current().agentId, 'worker-agent');
  } finally { await f.close(); }
});
