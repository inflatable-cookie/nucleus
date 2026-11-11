import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { git, command } from '../core/git/index';
import { controlManifestSchema, hookRecordSchema, type ControlManifest } from '../shared/hooks';
import { classifyCloseoutAuthority, isCloseoutAuthorityHook } from '../core/hooks/hooks';
import { submissionSchema, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { stepEngine } from './support/engine-step';

const worker: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const coordinator: Profile = { id: 'coordinator', name: 'Coordinator', provider: 'test', model: 'coordinator', notes: '', available: true, problem: '', supportedThinking: [] };

function hook(id: string, overrides: Record<string, unknown> = {}): ControlManifest['hooks'][number] {
  return {
    id, events: ['task.closeout'], mode: 'read_only', delivery: 'required',
    executable: `.paseo/hooks/${id}`, argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
    allowedPaths: [], commitSubject: null, ...overrides,
  } as unknown as ControlManifest['hooks'][number];
}
const authority = (id = 'ledger') => hook(id, { mode: 'integration_write', delivery: 'required', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } });
const manifestOf = (...hooks: unknown[]): ControlManifest => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks });

test('closeout authority is selected by the manifest when present; without one the project override applies and Queue is the default', () => {
  assert.equal(classifyCloseoutAuthority(null), 'queue', 'manifest absence defaults to Queue closeout (Spec 022)');
  assert.equal(classifyCloseoutAuthority(null, 'agent'), 'agent', 'the project override keeps the closeout agent without a manifest');
  assert.equal(classifyCloseoutAuthority(null, 'queue'), 'queue');
  assert.equal(classifyCloseoutAuthority(manifestOf(), 'queue'), 'agent', 'a manifest repository ignores the project override');
  assert.equal(classifyCloseoutAuthority(manifestOf()), 'agent', 'an empty manifest has no closeout binding');
  assert.equal(classifyCloseoutAuthority(manifestOf(hook('policy', { events: ['task.blocked'] }))), 'agent', 'another event never claims closeout');
  assert.equal(classifyCloseoutAuthority(manifestOf(hook('policy'))), 'agent', 'a required read-only closeout hook stays an observer');
  assert.equal(classifyCloseoutAuthority(manifestOf(hook('policy', { delivery: 'advisory' }))), 'agent', 'an advisory read-only closeout hook stays an observer');
  assert.equal(classifyCloseoutAuthority(manifestOf(hook('policy', { mode: 'integration_write', delivery: 'advisory', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } }))), 'agent', 'an advisory integration write stays an observer');
  assert.equal(classifyCloseoutAuthority(manifestOf(hook('policy', { events: ['task.blocked'], mode: 'integration_write', delivery: 'required', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } }))), 'agent', 'a write hook bound elsewhere does not own closeout');
  const write = authority();
  assert.equal(classifyCloseoutAuthority(manifestOf(write)), 'hook', 'a required integration write owns closeout');
  assert.equal(isCloseoutAuthorityHook(write), true);
  assert.equal(classifyCloseoutAuthority(manifestOf(hook('observer'), write)), 'hook', 'observers never mask the authority');
  assert.equal(classifyCloseoutAuthority(manifestOf(write, hook('observer'))), 'hook');
});

type FixtureOptions = { manifest?: unknown; withManifest?: boolean; hooks?: Record<string, { content: string; mode?: number }>; notifyOrigin?: boolean; coordinatorRecovery?: boolean; mechanicalVerification?: boolean };

async function authorityFixture(t: any, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-authority-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  if (options.withManifest !== false && options.manifest !== undefined) {
    await mkdir(join(repo, '.paseo'), { recursive: true });
    await writeFile(join(repo, '.paseo/queue.json'), JSON.stringify(options.manifest, null, 2));
  }
  for (const [path, spec] of Object.entries(options.hooks ?? {})) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec.content);
    if (spec.mode) await chmod(full, spec.mode);
  }
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs/plan.json'), '{}');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  await git(repo, 'push', 'origin', 'main');
  const head = await git(repo, 'rev-parse', 'HEAD');

  const dir = await mkdtemp(join(tmpdir(), 'nsq-authority-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'queue.sqlite');
  const store = new Store(dbPath);
  store.setMeta('paused', false);
  store.setMeta('lastRetentionAt', Date.now());
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Manifest-gated closeout', repoPath: repo, planningCommit: head,
    handoffPath: 'docs/plan.json', originAgentId: 'origin', notifyOriginOnCloseout: options.notifyOrigin ?? false,
  }), 'host', 'handoff', head);
  const task = store.update(submitted.id, {
    phase: 'closing', workspaceIntent: true, agentIntent: true, workspaceId: 'task-ws', directory: repo,
    agentId: 'worker', runId: 'initial', profile: worker,
    prUrl: 'https://github.com/example/repo/pull/7', prHead: '6'.repeat(40), resumePrNumber: 7,
    ...(options.notifyOrigin ? { originWorkspaceId: 'origin-workspace' } : {}),
    resolution: {
      ...submitted.resolution,
      coordinatorWorkspaceId: 'task-ws',
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      review: { eventId: 'review', taskId: submitted.id, runId: 'review-run', status: 'ready_to_merge', summary: 'independent review accepted the exact head', head: '6'.repeat(40), reviewCommentId: 7 },
      mechanicalVerification: options.mechanicalVerification ? { at: new Date().toISOString(), head: '6'.repeat(40), base: '7'.repeat(40) } : null,
      mergedCommit: head, syncedCommit: head, mergeHead: '6'.repeat(40), mergeBase: '7'.repeat(40),
    },
  });

  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'task-ws') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker'); idle('origin', 'origin-workspace');
  const tokens = new Map<string, string>(), creates: Run[] = [], notices: string[] = [];
  const adapter: Adapter & ResolutionAdapter = {
    profiles: async () => [worker, coordinator], validate: async () => head, verifyWorkspace: async () => 'main',
    createWorkspace: async () => { throw new Error('Closeout must not create workspaces'); }, findWorkspaces: async () => [],
    createAgent: async () => { throw new Error('No worker dispatch expected'); }, findAgents: async () => [],
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; }, archiveAgent: async () => {},
    verifyPr: async () => ({ head: '6'.repeat(40), url: 'https://github.com/example/repo/pull/7' }),
    createRun: async (t, r, token) => { creates.push(r); tokens.set(r.id, token); const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: r.workspaceId }; },
    sendRun: async (t, r, token) => { tokens.set(r.id, token); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }); },
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head: '6'.repeat(40), base: '7'.repeat(40), wait: '' }), merge: async () => {},
    merged: async () => ({ merged: true, commit: head, head: '6'.repeat(40), base: 'main' }), syncMain: async () => head,
    verifyCloseout: async () => undefined, notify: async id => { notices.push(id); }, supportsCoordinatorRecovery: options.coordinatorRecovery ?? false,
  };
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, coordinator];
  const current = () => store.task(task.id);
  const closeoutRun = () => store.run(current().resolution.currentRunId!)!;
  async function reportCloseout(closeoutCommit?: string) {
    const run = closeoutRun();
    idle(run.agentId!, run.workspaceId);
    engine.resolution.complete({ eventId: randomUUID(), taskId: task.id, runId: run.id, status: 'closed', summary: 'legacy closeout accepted', head: run.head, coordinatorGeneration: run.generation, ...(closeoutCommit ? { closeoutCommit } : {}) }, tokens.get(run.id)!);
    await engine.wake();
  }
  return {
    root, repo, head, dbPath, store, engine, adapter, taskId: task.id, current, closeoutRun, reportCloseout, idle, tokens, creates, notices,
    close: async () => { await engine.stop(); store.close(); },
  };
}

const observeScript = (ledger?: string) => `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
${ledger ? `fs.appendFileSync(${JSON.stringify(ledger)}, event.eventId+'\\n');` : ''}
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'observed',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;

test('an authoritative hook closes out without a closeout run or workspace and notifies once', async t => {
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId,prNumber:event.delivery.prNumber,head:event.delivery.head,intCommit:event.delivery.integrationCommit,review:event.delivery.review}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'closeout published',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } }, notifyOrigin: true });
  try {
    await f.engine.wake();
    const done = f.current();
    assert.equal(done.phase, 'done', done.reason);
    assert.equal(f.creates.length, 0, 'no closeout run may be created');
    assert.equal(f.store.runs(f.taskId).length, 0, 'no closeout run may be recorded');
    const record = f.store.hookEvents(f.taskId)[0];
    assert.equal(record.state, 'published');
    assert.equal(record.occurrence, 1);
    assert.equal(record.mode, 'integration_write');
    assert.ok(record.commit, 'the hook published an integration commit');
    assert.equal(done.resolution.syncedCommit, record.commit, 'done records the published integration commit');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), record.commit);
    assert.equal(await git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit);
    const ledgerBytes = JSON.parse(await readFile(join(f.repo, 'docs/ledger.json'), 'utf8'));
    assert.equal(ledgerBytes.prNumber, 7);
    assert.equal(ledgerBytes.head, '6'.repeat(40));
    assert.equal(ledgerBytes.intCommit, f.head);
    assert.equal(ledgerBytes.review, 'independent review accepted the exact head');
    const completion = f.store.notices(f.taskId).filter(notice => notice.kind === 'completion');
    assert.equal(completion.length, 1, 'exactly one durable completion notice');
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.store.notices(f.taskId).filter(notice => notice.kind === 'completion').length, 1, 'completion notices are not duplicated');
    assert.deepEqual(f.notices, ['origin']);
    assert.equal(f.store.hookEvents(f.taskId).length, 1, 'the closeout event is never re-emitted as a new occurrence');
  } finally { await f.close(); }
});

test('an authoritative closeout hook receives accepted review evidence after mechanical verification', async t => {
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({review:event.delivery.review}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'closeout published',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;
  const f = await authorityFixture(t, {
    manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] },
    hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } },
    mechanicalVerification: true,
  });
  try {
    await f.engine.wake();
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.ok(f.current().resolution.mechanicalVerification);
    const ledger = JSON.parse(await readFile(join(f.repo, 'docs/ledger.json'), 'utf8'));
    assert.equal(ledger.review, 'independent review accepted the exact head');
  } finally { await f.close(); }
});

test('a mixed observer and authoritative manifest runs both once and only the authority publishes', async t => {
  const writer = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'published',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-authority-mixed-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observerLedger = join(root, 'observer.jsonl');
  const f = await authorityFixture(t, {
    manifest: { schema: 'paseo.queue.control.v1', hooks: [hook('observer'), authority('ledger')] },
    hooks: { '.paseo/hooks/observer': { content: observeScript(observerLedger), mode: 0o755 }, '.paseo/hooks/ledger': { content: writer, mode: 0o755 } },
  });
  try {
    await f.engine.wake();
    assert.equal(f.current().phase, 'done', f.current().reason);
    const records = f.store.hookEvents(f.taskId);
    assert.equal(records.length, 2, 'each bound hook ran once');
    assert.equal(records.find(record => record.hookId === 'observer')!.state, 'result');
    assert.equal(records.find(record => record.hookId === 'observer')!.mode, 'read_only');
    assert.equal(records.find(record => record.hookId === 'ledger')!.state, 'published');
    assert.equal((await readFile(observerLedger, 'utf8')).trim().split('\n').length, 1);
    assert.equal(f.creates.length, 0);
  } finally { await f.close(); }
});

test('a manifest without a closeout binding keeps the closeout-agent fallback regardless of overrides', async t => {
  const configs: { label: string; options: FixtureOptions }[] = [
    { label: 'no closeout hook', options: { manifest: { schema: 'paseo.queue.control.v1', hooks: [hook('other', { events: ['task.blocked'] })] } } },
    { label: 'read-only observer', options: { manifest: { schema: 'paseo.queue.control.v1', hooks: [hook('observer')] }, hooks: { '.paseo/hooks/observer': { content: observeScript(), mode: 0o755 } } } },
    { label: 'advisory write observer', options: { manifest: { schema: 'paseo.queue.control.v1', hooks: [hook('observer', { mode: 'integration_write', delivery: 'advisory', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })] }, hooks: { '.paseo/hooks/observer': { content: observeScript(), mode: 0o755 } } } },
  ];
  for (const config of configs) {
    const f = await authorityFixture(t, config.options);
    try {
      await f.engine.wake();
      assert.equal(f.closeoutRun().role, 'closeout', `${config.label}: the closeout agent is launched`);
      assert.equal(f.current().phase, 'closing');
      assert.equal(f.creates.length, 1, `${config.label}: exactly one closeout run`);
      await f.reportCloseout(f.head);
      assert.equal(f.current().phase, 'done', `${config.label}: ${f.current().reason}`);
      for (const record of f.store.hookEvents(f.taskId)) assert.ok(['result', 'published'].includes(record.state), `${config.label}: ${record.hookId} ${record.state}`);
    } finally { await f.close(); }
  }
});

test('a blocked read-only closeout observer holds the fallback and resumes its own occurrence after retry', async t => {
  const script = `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:event.attempt===1?'blocked':'ok',summary:event.attempt===1?'hold once':'observed',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [hook('observer')] }, hooks: { '.paseo/hooks/observer': { content: script, mode: 0o755 } } });
  try {
    await f.engine.wake();
    assert.equal(f.closeoutRun().role, 'closeout');
    await f.reportCloseout(f.head);
    assert.equal(f.current().phase, 'closing');
    assert.equal(f.current().resolution.attention, true);
    const record = f.store.hookEvents(f.taskId)[0];
    assert.equal(record.state, 'blocked');
    const retried = await f.engine.hooks.retry(f.current(), record.id);
    assert.equal(retried.hold, false, retried.records[0].error);
    await f.engine.wake();
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.equal(f.store.hookEvents(f.taskId).length, 1, 'the observer keeps one occurrence');
    assert.equal(f.store.hookEvents(f.taskId)[0].eventId, record.eventId);
  } finally { await f.close(); }
});

test('a blocked authoritative hook holds visibly, never falls back, and retries the same occurrence', async t => {
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
if(event.attempt===1){process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'delivery needs a retry',metadata:{},changedPaths:[],commitSubjectSuffix:null}));return;}
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId,attempt:event.attempt}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'published after retry',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } } });
  try {
    await f.engine.wake();
    const held = f.current();
    assert.equal(held.phase, 'closing');
    assert.equal(held.resolution.attention, true);
    assert.match(held.reason, /task\.closeout/);
    assert.equal(f.creates.length, 0, 'a held authority hook never launches the fallback agent');
    assert.equal(f.store.runs(f.taskId).length, 0);
    const blocked = f.store.hookEvents(f.taskId);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].state, 'blocked');
    assert.equal(blocked[0].occurrence, 1);

    const retried = await f.engine.hooks.retry(f.current(), blocked[0].id);
    assert.equal(retried.hold, false, retried.records[0].error);
    const durable = f.store.hookEvents(f.taskId);
    assert.equal(durable.length, 1, 'retry keeps one occurrence');
    assert.equal(durable[0].eventId, blocked[0].eventId, 'retry keeps the event identity');
    assert.equal(durable[0].occurrence, 1);
    assert.equal(durable[0].attempt, 2);
    assert.equal(durable[0].state, 'published');

    await f.engine.wake();
    const done = f.current();
    assert.equal(done.phase, 'done', done.reason);
    assert.equal(done.resolution.syncedCommit, durable[0].commit);
    assert.equal(f.store.hookEvents(f.taskId).length, 1, 'a successful retry concludes without a second occurrence');
    assert.equal(f.creates.length, 0);
  } finally { await f.close(); }
});

test('an invalid authoritative hook result holds and cannot be cleared by a fallback agent', async t => {
  const script = `#!/usr/bin/env node
process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('not a result');});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } } });
  try {
    await f.engine.wake();
    assert.equal(f.current().phase, 'closing');
    assert.equal(f.current().resolution.attention, true);
    assert.equal(f.creates.length, 0);
    const record = f.store.hookEvents(f.taskId)[0];
    assert.equal(record.state, 'blocked');
    // A resolution retry clears attention but must re-hold on the same occurrence.
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, attention: false } }, 'test_clear');
    await f.engine.wake();
    assert.equal(f.current().resolution.attention, true);
    assert.equal(f.store.hookEvents(f.taskId)[0].eventId, record.eventId);
    assert.equal(f.creates.length, 0);
  } finally { await f.close(); }
});

test('a restart after publication concludes the same occurrence instead of re-running the hook', async t => {
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'published',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } } });
  let reopened: Store | undefined, successor: Engine | undefined;
  try {
    const published = await f.engine.hooks.emit('task.closeout', f.current(), { event: 'task.closeout', baseCommit: f.head, delivery: { prUrl: f.current().prUrl, prNumber: 7, head: f.current().prHead, review: 'verified', mergeCommit: f.head, integrationCommit: f.head, summary: 'closeout' } });
    assert.equal(published.hold, false, published.records[0].error);
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'published');
    const firstCommit = f.store.hookEvents(f.taskId)[0].commit;
    await f.engine.stop(); f.store.close();
    reopened = new Store(f.dbPath);
    successor = new Engine(reopened, f.adapter, 0);
    successor.profiles = [worker, coordinator];
    await successor.wake();
    assert.equal(reopened.task(f.taskId).phase, 'done');
    assert.equal(reopened.task(f.taskId).resolution.syncedCommit, firstCommit);
    assert.equal(reopened.hookEvents(f.taskId).length, 1, 'restart reuses the published occurrence');
  } finally { if (successor) await successor.stop(); reopened?.close(); }
});

test('a published closeout finishes even when a stale failure reason still holds attention', async t => {
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'published',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } } });
  try {
    const published = await f.engine.hooks.emit('task.closeout', f.current(), { event: 'task.closeout', baseCommit: f.head, delivery: { prUrl: f.current().prUrl, prNumber: 7, head: f.current().prHead, review: 'verified', mergeCommit: f.head, integrationCommit: f.head, summary: 'closeout' } });
    assert.equal(published.hold, false, published.records[0].error);
    // g06.392: the retry published, but the reason still named the earlier refusal.
    const current = f.current();
    f.store.update(f.taskId, { phase: 'closing', reason: 'The stale hook checkout is not clean at its recorded base; an explicit discardUnpublishedCheckout retry requires proof of unpublished hook-owned content',
      resolution: { ...current.resolution, attention: true } });
    await f.engine.wake();
    assert.equal(f.current().phase, 'done', f.current().reason);
    assert.equal(f.store.hookEvents(f.taskId).length, 1, 'the published occurrence is reused, never re-run');
  } finally { await f.close(); }
});

test('hook-owned closeout never recovers a closeout workspace when the coordinator workspace is gone', async t => {
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: observeScript(), mode: 0o755 } } });
  let recoveries = 0;
  try {
    f.adapter.workspaceAvailable = async () => false;
    (f.adapter as any).createCloseoutWorkspace = async () => { recoveries++; return { id: 'closeout', directory: '/tmp/closeout' }; };
    (f.adapter as any).findCloseoutWorkspaces = async () => [];
    (f.adapter as any).verifyCloseoutWorkspace = async () => {};
    await f.engine.wake();
    assert.equal(recoveries, 0, 'the hook route must not create a closeout workspace');
    assert.equal(f.current().phase, 'done', f.current().reason);
  } finally { await f.close(); }
});

test('a hook-held closeout routes plain attention to the origin and never spawns coordinator recovery', async t => {
  const script = `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'policy needs an operator decision',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } }, notifyOrigin: true, coordinatorRecovery: true });
  try {
    await f.engine.wake();
    assert.equal(f.current().phase, 'closing');
    assert.equal(f.current().resolution.attention, true);
    const attention = f.store.notices(f.taskId).filter(notice => notice.kind === 'attention');
    assert.equal(attention.length, 1, 'one origin attention notice');
    assert.equal(attention[0].status, 'delivered');
    assert.deepEqual(f.notices, ['origin']);
    assert.equal(f.creates.length, 0, 'no coordinator recovery run is created');
    assert.equal(f.store.runs(f.taskId).filter(run => run.role === 'recovery').length, 0);
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'blocked');
  } finally { await f.close(); }
});

test('the closeout authority decision lives in the generic hook core without document-system vocabulary', async () => {
  const source = await readFile(join(process.cwd(), 'core', 'hooks', 'hooks.ts'), 'utf8');
  for (const forbidden of ['docs/handoffs', 'handoffPath', 'planningCommit', 'frontmatter', 'Northstar handoff file', 'g0', 'worker-pr-loop', 'inflatable-cookie']) {
    assert.equal(source.includes(forbidden), false, `generic hook core must not embed ${forbidden}`);
  }
});

test('a stale integration base refreshes and retries the closeout instead of parking', async t => {
  // The live shape: main advances between the merge and the integration write, so the
  // hook refuses with the stale-base proof. An operator retry fixes that by resyncing
  // and running the same occurrence again, so Queue does it itself, and parks only
  // once the bounded refreshes are spent.
  const script = `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'Integration write requires a clean synchronized base: Error: Integration HEAD moved from the event base',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } } });
  try {
    // One sweep (#346): the follow-up would retry the refreshed closeout at once.
    await stepEngine(f.engine);
    const refreshed = f.current();
    assert.equal(refreshed.phase, 'syncing', `expected an automatic refresh, saw ${refreshed.phase}: ${refreshed.reason}`);
    assert.equal(refreshed.resolution.attention, false, 'a stale base is not an operator matter');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'closeout_hold_refresh').length, 1);
    // The refreshes are bounded: once spent, the hold parks for a human. A parked
    // closeout hold keeps its phase and raises attention, as it always has.
    let parked = refreshed;
    for (let pass = 0; pass < 8 && !parked.resolution.attention; pass++) {
      await f.engine.wake();
      parked = f.current();
    }
    assert.equal(parked.resolution.attention, true, `expected the hold to park, saw ${parked.phase}: ${parked.reason}`);
    assert.equal(parked.phase, 'closing');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'closeout_hold_refresh').length, 2, 'the refresh stays bounded at two per merge');
  } finally {
    f.store.close();
  }
});

test('a separate uncertain hook still fences a closeout base refresh', async t => {
  const script = `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'Integration write requires a clean synchronized base: moved',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
  const f = await authorityFixture(t, { manifest: { schema: 'paseo.queue.control.v1', hooks: [authority()] }, hooks: { '.paseo/hooks/ledger': { content: script, mode: 0o755 } } });
  try {
    await stepEngine(f.engine);
    assert.equal(f.current().phase,'syncing');
    const held=f.store.hookEvents(f.taskId)[0]!;
    const uncertain=hookRecordSchema.parse({...held,id:randomUUID(),eventId:randomUUID(),hookId:'other',state:'uncertain',result:null,error:'Delivery unknown',summary:'Delivery unknown'});
    f.store.putHookEvent(uncertain);
    await f.engine.wake();
    assert.equal(f.current().phase,'syncing');
    assert.deepEqual(f.store.hookEvent(uncertain.id),uncertain);
    assert.equal(f.store.hookEvents(f.taskId).length,2);
    f.store.update(f.taskId,{phase:'closing',reason:'Closeout resumed with another uncertain task effect'});
    await f.engine.wake();
    assert.equal(f.current().phase,'closing');
    assert.deepEqual(f.store.hookEvent(uncertain.id),uncertain);
  } finally { f.store.close(); }
});
