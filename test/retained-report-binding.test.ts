import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { runAgentSpec, writeMcpBinding, writeRunTicket } from '../core/dispatch/agent-creation';
import { sendRunVia } from '../core/dispatch/run-launch/send';
import { purgeReleasedRunTicket, purgeReportingFiles } from '../core/intake/reporting-files';
import { startCallbacks } from '../service/callbacks/callback';
import { runSchema, type Run } from '../shared/contracts';
import { fakeAdapter, profile, submission } from './support/fakes';

const head = 'a'.repeat(40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-retained-report-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = store.insert(submission(), 'host', 'Synthetic brief', head);
  store.update(task.id, { phase: 'needs_attention', workspaceId: 'workspace', coordinatorAgentId: 'coordinator' });
  const state = { id: 'coordinator', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '',
    labels: { 'nucleus.mcpBinding': 'first-run' }, mcpBindingPath: join(dir, 'tickets', 'mcp-first-run.json') };
  const adapter = fakeAdapter({ helperPath: join(dir, 'worker-report.mjs'), supportsCoordinatorRecovery: true,
    observe: async () => state, profiles: async () => [] });
  const engine = new Engine(store, adapter, 0);
  const paths = { helperPath: adapter.helperPath, socketPath: join(dir, 'callback.sock') };
  const owner = { ...paths, reportingViaMcp: true, admissionLaunchEnv: {},
    scratchPlacement: () => ({ mount: dir, root: dir, create: (path: string) => mkdirSync(path), remove: () => false }) };
  function run(id: string, role: Run['role'] = 'recovery'): Run {
    return runSchema.parse({ id, taskId: task.id, role, generation: 1, head, base: head, agentId: state.id,
      workspaceId: state.workspaceId, profile: profile('coordinator'), status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: new Date(0).toISOString(), completion: null, released: false });
  }
  function activate(current: Run) {
    store.putRun(current); store.setCredential(current.id, `secret-${current.id}`);
    store.update(task.id, { resolution: { ...store.task(task.id).resolution, recoveryActive: true,
      currentRunId: current.role === 'recovery' ? null : current.id,
      recovery: current.role === 'recovery' ? { id: 'episode', key: 'synthetic', generation: 1, runId: current.id,
        agentId: state.id, status: 'running', summary: 'Synthetic recovery', idleSince: null, incidentId: null } : null } });
  }
  async function send(current: Run) {
    await sendRunVia({ ...owner, retainedAgentRef: () => ({ workspaceId: state.workspaceId, archivedAt: null,
      status: 'idle', activeTurn: null, pendingPermissions: [], runtimeInfo: null, refresh: async () => true,
      current: () => ({ labels: state.labels }), send: async () => {
        assert.equal(JSON.parse(readFileSync(state.mcpBindingPath, 'utf8')).runId, current.id, 'binding changes before delivery');
      } }), binding: (key, task, runId, token) => writeMcpBinding(paths, key, task, runId, token),
      ticket: (task, run, token) => writeRunTicket(paths, task, run, token),
      continueReviewer: async () => { throw Error('Unexpected detached review'); },
    }, store.task(task.id), current, `secret-${current.id}`);
  }
  return { dir, store, task, engine, state, paths, owner, run, activate, send,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const role of ['reviewer', 'revision', 'closeout', 'recovery', 'executor'] as const) {
  test(`released ticket cleanup preserves the stable binding rebound to a retained ${role}`, async () => {
    const f = fixture();
    try {
      const first = f.run('first-run', role);
      // Use the real launch writer and layout, including the helper's original argv path.
      const spec = runAgentSpec(() => f.owner, f.store.task(f.task.id), first, 'secret-first-run', first.profile!, undefined, null, null);
      assert.equal(spec.mcpBindingPath, f.state.mcpBindingPath);
      f.store.putRun(first); f.store.setCredential(first.id, 'secret-first-run');
      const released = { ...first, status: 'superseded' as const, released: true };
      f.store.putRun(released);
      assert.equal(existsSync(spec.mcpBindingPath!), role === 'reviewer',
        'only a reportless reviewer keeps a verdict-only ticket on release');
      const current = f.run('current-run', role); f.activate(current);
      await f.send(current);
      // A later release observation repeats cleanup for the earlier run on the same task.
      f.store.putRun(released);
      purgeReleasedRunTicket(f.dir, f.task.id, first.id);
      purgeReportingFiles(f.paths.helperPath, f.task.id, [first.id]);
      assert.equal(existsSync(join(f.dir, 'tickets', `${first.id}.json`)), false);
      assert.equal(JSON.parse(readFileSync(spec.mcpBindingPath!, 'utf8')).runId, current.id);
      assert.throws(() => f.store.authenticate(first.id, 'secret-first-run'), /Unauthorized|invalid|revoked/i);
      f.store.authenticate(current.id, 'secret-current-run');
    } finally { await f.close(); }
  });
}

test('a real retained MCP helper accepts recovery after its superseded first run is released and purged again', async () => {
  const f = fixture(), client = new Client({ name: 'synthetic-retained-thread', version: '1' });
  let stop: (() => Promise<void>) | undefined;
  try {
    const first = f.run('first-run'); f.activate(first);
    const spec = runAgentSpec(() => f.owner, f.store.task(f.task.id), first, 'secret-first-run', first.profile!, undefined, null, null);
    stop = await startCallbacks(f.paths.socketPath, f.paths.helperPath, f.engine);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../mcp-report.mjs', import.meta.url)), spec.mcpBindingPath!], stderr: 'pipe',
      env: { ...process.env, NUCLEUS_DATA_HOME: f.dir } }));
    const released = { ...first, status: 'superseded' as const, released: true };
    f.store.putRun(released);
    const current = f.run('current-run'); f.activate(current); await f.send(current);
    f.store.putRun(released);
    const response = await client.callTool({ name: 'nucleus_report', arguments: { runId: current.id,
      status: 'recovered', headline: 'Recovery observed', summary: 'Synthetic recovery is ready to continue',
      coordinatorAction: { verb: 'restart', role: 'worker', reason: 'Continue the synthetic task' } } });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.equal(f.store.run(current.id)?.completion?.status, 'recovered');
    assert.equal(f.store.run(first.id)?.completion, null);
  } finally { await client.close(); await stop?.(); await f.close(); }
});

test('a real MCP report missing its binding becomes a named recovery failure instead of a null completion', async () => {
  const f = fixture(), client = new Client({ name: 'synthetic-report-failure', version: '1' });
  try {
    const current = f.run('current-run'); f.activate(current);
    writeMcpBinding(f.paths, 'first-run', f.store.task(f.task.id), current.id, 'secret-current-run');
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../mcp-report.mjs', import.meta.url)), f.state.mcpBindingPath], stderr: 'pipe',
      env: { ...process.env, NUCLEUS_DATA_HOME: f.dir } }));
    rmSync(f.state.mcpBindingPath);
    const response = await client.callTool({ name: 'nucleus_report', arguments: { runId: current.id,
      status: 'recovered', headline: 'Observed recovery', summary: 'Synthetic result' } });
    assert.equal(response.isError, true); assert.match(JSON.stringify(response), /ENOENT/);
    f.store.setMeta('paused', false);
    await f.engine.resolution.recovery.pass(f.task.id);
    const failed = f.store.run(current.id)!;
    assert.equal(failed.completion?.status, 'error');
    assert.match(failed.completion!.summary, /Report binding missing.*current-run.*ENOENT/);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'report_failed'));
    assert.equal(failed.released, true);
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'planner_escalation'), 'the existing planner ladder owns the failure');
  } finally { await client.close(); await f.close(); }
});

for (const role of ['reviewer', 'revision', 'closeout', 'executor'] as const) {
  test(`a stopped ${role} records its missing binding before release`, async () => {
    const f = fixture();
    try {
      const current = f.run('current-run', role); f.activate(current);
      f.engine.profiles = [current.profile!];
      f.store.setMeta('pool', [{ profileId: current.profile!.id, enabled: true, group: 'synthetic', roles: ['reviewer', 'worker', 'coordinator'], weight: "default", scopes: ['general'] }]);
      f.store.setMeta('paused', false);
      await f.engine.resolution.observe();
      const failed = f.store.run(current.id)!;
      assert.equal(failed.completion?.status, 'error');
      assert.match(failed.completion!.summary, /Report binding missing/);
      assert.equal(failed.released, true);
      assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'report_failed'));
    } finally { await f.close(); }
  });
}

test('the retained initial worker records a missing binding through its ordinary error handling', async () => {
  const f = fixture();
  try {
    const task = f.store.update(f.task.id, { phase: 'working', agentId: f.state.id, runId: 'worker-run',
      profile: profile('worker'), idleSince: new Date(0).toISOString() });
    f.store.setMeta('paused', false);
    await f.engine.reconcile(task);
    assert.equal(f.store.task(task.id).completion?.status, 'error');
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'report_failed'));
  } finally { await f.close(); }
});

test('missing-binding classification never reads another path or classifies a live or foreign helper', async () => {
  const { missingReportBindingCompletion } = await import('../core/intake/reporting-failure');
  const f = fixture();
  try {
    const identity = { taskId: f.task.id, runId: 'current-run' };
    assert.equal(missingReportBindingCompletion(f.paths.helperPath, identity, { ...f.state, active: true }), null);
    assert.equal(missingReportBindingCompletion(f.paths.helperPath, identity, { ...f.state, mcpBindingPath: join(f.dir, 'foreign.json') }), null);
    assert.equal(missingReportBindingCompletion(undefined, identity, f.state), null);
  } finally { await f.close(); }
});

for (const status of ['intent', 'uncertain'] as const) {
  test(`a missing binding never settles a reviewer dispatch whose status is ${status}`, async () => {
    const f = fixture();
    try {
      const current = { ...f.run('current-run', 'reviewer'), status }; f.activate(current);
      f.engine.profiles = [current.profile!];
      f.store.setMeta('pool', [{ profileId: current.profile!.id, enabled: true, group: 'synthetic', roles: ['reviewer'], weight: "default", scopes: ['general'] }]);
      f.store.setMeta('paused', false);
      await f.engine.resolution.observe();
      const held = f.store.run(current.id)!;
      assert.equal(held.completion, null);
      assert.equal(held.released, false);
      assert.equal(held.status, status);
      assert.match(f.store.task(f.task.id).reason, /Prompt delivery is uncertain/);
      assert.equal(f.store.eventsAll(f.task.id).some(event => event.kind === 'report_failed'), false);
    } finally { await f.close(); }
  });
}
