import { fakeAdapter } from './support/fakes';
import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { git } from '../core/git/index';
import { RepositoryHooks, verifyReviewedHead } from '../core/hooks/hooks';
import { controlManifestSchema, hookEventSchema, hookEventV2Schema, anyHookEventSchema } from '../shared/hooks';
import { submissionSchema, REVISION_BUDGET, type Profile, type Run } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { stepEngine } from './support/engine-step';
import { configuredClone, materializeSeed } from './support/git-seed';
import { observedParticipantTimeline } from './support/tool-timeline';

const worker: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const coordinator: Profile = { id: 'coordinator', name: 'Coordinator', provider: 'test', model: 'coordinator', notes: '', available: true, problem: '', supportedThinking: [] };

const preMerge = (overrides: Record<string, unknown> = {}) => ({
  id: 'pre-merge', events: ['task.pre_merge'], target: 'reviewed_head', mode: 'read_only', delivery: 'required',
  program: { kind: 'repository', executable: '.paseo/hooks/gate', argv: [] },
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, ...overrides,
});
const v3Manifest = (hooks: unknown[]) => ({ schema: 'paseo.queue.control.v3', hooks });
const manifestText = (hooks: unknown[]) => JSON.stringify(v3Manifest(hooks), null, 2);

// A repository-neutral gate hook: it records the received v2 event beside the
// repository and answers with the requested outcome. It never edits the repo.
function gateScript(ledgerPath: string, outcome = 'ok', extra = '') {
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({schema:event.schema,eventId:event.eventId,event:event.event,target:event.repository.target,envSchema:process.env.PASEO_QUEUE_EVENT_SCHEMA,root:event.repository.root,baseBranch:event.repository.baseBranch,baseCommit:event.repository.baseCommit,head:event.delivery.head,review:event.delivery.review,prNumber:event.delivery.prNumber,mergeCommit:event.delivery.mergeCommit,integrationCommit:event.delivery.integrationCommit,instruction:event.task.instruction})+'\\n');
  ${extra}
  process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:${JSON.stringify(outcome)},summary:${JSON.stringify(`gate ${outcome}`)},metadata:{},changedPaths:[],commitSubjectSuffix:null}));
});
`;
}

async function reviewedHeadFixture(t: any, files: Record<string, { content: string; mode?: number }> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-premerge-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs/plan.json'), '{}');
  for (const [path, spec] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec.content);
    if (spec.mode) await chmod(full, spec.mode);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'reviewed head');
  await git(repo, 'push', 'origin', 'main');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const directory = join(root, 'task-worktree');
  await git(repo, 'worktree', 'add', '-b', 'ns-task', directory, head);
  await git(directory, 'push', 'origin', 'ns-task');
  const dir = await mkdtemp(join(tmpdir(), 'nsq-premerge-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  return { root, repo, head, directory, store };
}

function taskAtReviewedHead(store: Store, repo: string, directory: string, head: string) {
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Reviewed-head gate', repoPath: repo, baseBranch: 'main',
    planningCommit: head, handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', head);
  return store.update(submitted.id, {
    directory, branch: 'ns-task', workspaceId: 'task-ws', agentId: 'worker', runId: 'initial',
    prUrl: 'https://github.com/example/repo/pull/9', prHead: head, resumePrNumber: 9,
  });
}

const gateContext = (task: { prUrl?: string | null }, head: string) => ({
  event: 'task.pre_merge' as const, baseCommit: head,
  delivery: { prUrl: task.prUrl ?? null, prNumber: 9, head, review: 'independent review accepted the exact head', summary: 'independent review accepted the exact head' },
});

test('v3 adds the reviewed-head target while v1 and v2 stay frozen', () => {
  const parsed = controlManifestSchema.parse(v3Manifest([preMerge()]));
  assert.equal(parsed.schema, 'paseo.queue.control.v3');
  const normalized = parsed.hooks[0];
  assert.equal((normalized as { target?: string }).target, 'reviewed_head');

  const v1 = { schema: 'paseo.queue.control.v1', hooks: [{ id: 'legacy', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required', executable: '.paseo/hooks/legacy', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] };
  assert.deepEqual(controlManifestSchema.parse(v1), v1);
  const v2 = { schema: 'paseo.queue.control.v2', hooks: [{ id: 'legacy', events: ['task.blocked'], mode: 'read_only', delivery: 'required', program: { kind: 'repository', executable: '.paseo/hooks/legacy', argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] };
  assert.deepEqual(controlManifestSchema.parse(v2), v2);
  for (const frozen of [v1, v2]) {
    const withPreMerge = JSON.parse(JSON.stringify(frozen)) as { hooks: Record<string, unknown>[] };
    withPreMerge.hooks[0].events = ['task.pre_merge'];
    withPreMerge.hooks[0].target = 'reviewed_head';
    assert.throws(() => controlManifestSchema.parse(withPreMerge), /task\.pre_merge|Invalid|Unrecognized/i, `${frozen.schema} must not accept the new event`);
  }
});

test('task.pre_merge requires its own hook entry, read_only mode, required delivery and the reviewed head', () => {
  assert.equal(controlManifestSchema.safeParse(v3Manifest([preMerge()])).success, true);
  assert.throws(() => controlManifestSchema.parse(v3Manifest([preMerge({ target: 'integration_base' })])), /reviewed_head/);
  assert.throws(() => controlManifestSchema.parse(v3Manifest([preMerge({ events: ['task.pre_merge', 'task.closeout'] })])), /only event|reviewed_head/);
  assert.throws(() => controlManifestSchema.parse(v3Manifest([preMerge({ mode: 'integration_write', allowedPaths: ['docs/gate.json'], commitSubject: { prefix: 'queue: gate', maxBytes: 80 } })])), /read_only/);
  assert.throws(() => controlManifestSchema.parse(v3Manifest([preMerge({ delivery: 'advisory' })])), /required delivery/);
  for (const events of [['task.closeout'], ['task.pre_dispatch'], ['task.blocked']]) {
    assert.throws(() => controlManifestSchema.parse(v3Manifest([preMerge({ events, target: 'reviewed_head' })])), /reviewed head/, `reviewed_head must be limited to task.pre_merge (${events[0]})`);
  }
  const integration = { id: 'legacy', events: ['task.closeout'], target: 'integration_base', mode: 'read_only', delivery: 'required', program: { kind: 'repository', executable: '.paseo/hooks/legacy', argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null };
  assert.equal(controlManifestSchema.safeParse(v3Manifest([integration])).success, true);
  assert.throws(() => controlManifestSchema.parse(v3Manifest([{ ...integration, target: undefined }])), /target|Invalid|required/i);
});

test('the v2 event retains every v1 field, adds the target and keeps v1 byte-stable', () => {
  const v1Event = {
    schema: 'paseo.queue.event.v1', eventId: 'event-1', hookId: 'legacy', event: 'task.closeout', occurredAt: '2026-09-15T00:00:00.000Z', attempt: 1,
    repository: { root: '/repo', baseBranch: 'main', baseCommit: 'a'.repeat(40) },
    task: { id: 'task', title: 'Task', phase: 'closing', instruction: null },
    delivery: { prUrl: null, prNumber: null, head: null, review: null, mergeCommit: null, integrationCommit: null, summary: 'closeout' },
  };
  assert.deepEqual(hookEventSchema.parse(v1Event), v1Event);
  assert.equal(hookEventV2Schema.safeParse(v1Event).success, false, 'v1 stays v1');
  const v2Event = { ...v1Event, schema: 'paseo.queue.event.v2', event: 'task.pre_merge', repository: { ...v1Event.repository, target: 'reviewed_head' } };
  assert.deepEqual(hookEventV2Schema.parse(v2Event), v2Event);
  assert.deepEqual(anyHookEventSchema.parse(v2Event), v2Event, 'the compatibility union reads both generations');
});

weighted(11)('a pass runs at the retained exact reviewed head and reports one clean occurrence', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: gateScript(ledger), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const hooks = new RepositoryHooks(f.store, { run: undefined });
  const result = await hooks.emit('task.pre_merge', task, gateContext(task, f.head));
  assert.equal(result.hold, false, result.records[0]?.error);
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.state, 'result');
  assert.equal(record.occurrence, 1);
  assert.equal(record.mode, 'read_only');
  assert.equal(record.baseCommit, f.head);
  assert.equal(record.eventPayload?.schema, 'paseo.queue.event.v2');
  assert.equal((record.eventPayload as { repository: { target: string } }).repository.target, 'reviewed_head');
  assert.equal(record.eventPayload?.repository.root, f.directory, 'the gate runs in the retained task workspace');
  assert.equal(record.result?.outcome, 'ok');
  assert.equal(await git(f.directory, 'rev-parse', 'HEAD'), f.head);
  assert.equal(await git(f.directory, 'status', '--porcelain'), '');
  const lines = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'task.pre_merge');
  assert.equal(lines[0].schema, 'paseo.queue.event.v2');
  assert.equal(lines[0].target, 'reviewed_head');
  assert.equal(lines[0].envSchema, 'paseo.queue.event.v2', 'the environment advertises the emitted event generation');
  assert.equal(lines[0].root, f.directory);
  assert.equal(lines[0].baseBranch, 'main');
  assert.equal(lines[0].baseCommit, f.head);
  assert.equal(lines[0].head, f.head);
  assert.equal(lines[0].review, 'independent review accepted the exact head');
  assert.equal(lines[0].prNumber, 9);
  assert.equal(lines[0].mergeCommit, null);
  assert.equal(lines[0].integrationCommit, null);
  assert.equal(lines[0].instruction, null);
});

weighted(16)('the same reviewed head reuses its occurrence while a changed head mints a fresh one', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: gateScript(ledger), mode: 0o755 },
  });
  t.after(() => f.store.close());
  let task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const first = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
  const again = await new RepositoryHooks(f.store).emit('task.pre_merge', f.store.task(task.id), gateContext(task, f.head));
  assert.equal(again.records[0].eventId, first.records[0].eventId, 'an unchanged head reuses the settled occurrence');
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 1, 'the gate is not executed twice');

  await writeFile(join(f.directory, 'docs/gate.json'), '{"head":"next"}\n');
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'next reviewed head');
  await git(f.directory, 'push', 'origin', 'ns-task');
  const next = await git(f.directory, 'rev-parse', 'HEAD');
  task = f.store.update(task.id, { prHead: next });
  const changed = await new RepositoryHooks(f.store).emit('task.pre_merge', f.store.task(task.id), gateContext(task, next));
  assert.equal(changed.records[0].state, 'result', changed.records[0].error);
  assert.equal(changed.records[0].occurrence, 2, 'a changed head mints a fresh occurrence');
  assert.notEqual(changed.records[0].eventId, first.records[0].eventId);
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 2);
});

weighted(11)('a confirmed refusal is a parsed result, never a mutation or transport failure', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: gateScript(ledger, 'blocked'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const refusal = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
  assert.equal(refusal.hold, true);
  assert.equal(refusal.records[0].state, 'blocked');
  assert.equal(refusal.records[0].result?.outcome, 'blocked', 'a semantic refusal carries a parsed result');
  assert.equal(await git(f.directory, 'rev-parse', 'HEAD'), f.head);
  assert.equal(await git(f.directory, 'status', '--porcelain'), '');
});

weighted(49)('mutation, invalid transport and identity drift are operational holds without a parsed result', async t => {
  const cases: { label: string; script: string; expect: string }[] = [
    { label: 'mutation', script: gateScript('/dev/null', 'blocked', "fs.writeFileSync('docs/plan.json','mutated');"), expect: 'uncertain' },
    { label: 'transport', script: '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on(\'end\',()=>{process.stdout.write(\'not a result\');});\n', expect: 'blocked' },
  ];
  for (const variant of cases) {
    const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
    t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
    const f = await reviewedHeadFixture(t, {
      '.paseo/queue.json': { content: manifestText([preMerge()]) },
      '.paseo/hooks/gate': { content: variant.script, mode: 0o755 },
    });
    try {
      const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
      const result = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
      assert.equal(result.hold, true, variant.label);
      assert.equal(result.records[0].state, variant.expect, variant.label);
      assert.equal(result.records[0].result, null, `${variant.label} must never look like a policy finding`);
    } finally { f.store.close(); }
  }
});

test('verifyReviewedHead proves the queue branch, clean tree, local head and remote branch', async t => {
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: gateScript('/dev/null'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  await verifyReviewedHead(f.directory, 'ns-task', f.head);

  await git(f.directory, 'checkout', '-B', 'other');
  await assert.rejects(verifyReviewedHead(f.directory, 'ns-task', f.head), /queue-owned branch/);
  await git(f.directory, 'checkout', '-B', 'ns-task');

  await writeFile(join(f.directory, 'docs/plan.json'), '{"dirty":true}');
  await assert.rejects(verifyReviewedHead(f.directory, 'ns-task', f.head), /clean/);
  await git(f.directory, 'checkout', '--', 'docs/plan.json');

  await writeFile(join(f.directory, 'docs/ahead.json'), '{}\n');
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'remote ahead');
  await git(f.directory, 'push', 'origin', 'ns-task');
  await git(f.directory, 'reset', '--hard', f.head);
  await assert.rejects(verifyReviewedHead(f.directory, 'ns-task', f.head), /remote branch/);

  await assert.rejects(verifyReviewedHead(f.directory, 'ns-task', 'b'.repeat(40)), /local HEAD/);
});

weighted(16)('bound reviewed-head hooks keep manifest order and all must pass', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const second = preMerge({ id: 'pre-merge-b', program: { kind: 'repository', executable: '.paseo/hooks/gate-b', argv: [] } });
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge(), second]) },
    '.paseo/hooks/gate': { content: gateScript(ledger), mode: 0o755 },
    '.paseo/hooks/gate-b': { content: gateScript(ledger, 'blocked'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const result = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
  assert.equal(result.hold, true);
  assert.deepEqual(result.records.map(record => record.hookId), ['pre-merge', 'pre-merge-b'], 'manifest order is deterministic');
  assert.deepEqual(result.records.map(record => record.state), ['result', 'blocked']);
  assert.equal(result.records[0].result?.outcome, 'ok');
  assert.equal(result.records[1].result?.outcome, 'blocked');
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 2);
});

weighted(11)('a refused head never answers for the changed head that follows it', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: gateScript(ledger, 'blocked'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  let task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const first = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
  assert.equal(first.records[0].state, 'blocked');
  assert.equal(first.records[0].occurrence, 1);

  await writeFile(join(f.directory, 'docs/gate.json'), '{"head":"next"}\n');
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'revised reviewed head');
  await git(f.directory, 'push', 'origin', 'ns-task');
  const next = await git(f.directory, 'rev-parse', 'HEAD');
  task = f.store.update(task.id, { prHead: next });
  const changed = await new RepositoryHooks(f.store).emit('task.pre_merge', f.store.task(task.id), gateContext(task, next));
  assert.equal(changed.records[0].occurrence, 2, 'the changed head is gated again');
  assert.equal(changed.records[0].baseCommit, next);
  assert.notEqual(changed.records[0].eventId, first.records[0].eventId);
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 2, 'the gate executes at both heads');
});

weighted(3)('a restart reconciles the pinned occurrence instead of duplicating the gate', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: gateScript(ledger), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const hooks = new RepositoryHooks(f.store);
  await hooks.emit('task.pre_merge', task, gateContext(task, f.head));
  const settled = f.store.hookEvents(task.id)[0];
  // Simulate a crash during the same occurrence: durable running intent with no live process.
  f.store.putHookEvent({ ...settled, state: 'running', result: null, processId: null, attempt: 1 });
  const reconciled = await hooks.reconcile(f.store.hookEvent(settled.id)!);
  assert.equal(reconciled.state, 'intent', reconciled.error);
  assert.equal(reconciled.eventId, settled.eventId);
  const replayed = await new RepositoryHooks(f.store).emit('task.pre_merge', f.store.task(task.id), gateContext(task, f.head));
  assert.equal(replayed.records[0].eventId, settled.eventId, 'a restart never mints a second occurrence');
  assert.equal(replayed.records[0].state, 'result', replayed.records[0].error);
  assert.equal(f.store.hookEvents(task.id).length, 1);
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 2, 'the proven-clean occurrence is executed again');
});

test('a named tool resolves on Nucleus PATH and records its path and digest', async t => {
  const name = `nucleus-tool-${randomUUID()}`;
  const program = { kind: 'tool', name, argv: ['literal;$(ignored)'] };
  const f = await reviewedHeadFixture(t, { '.paseo/queue.json': { content: manifestText([preMerge({ program })]) } });
  t.after(() => f.store.close());
  const tool = join(f.root, name), ledger = join(f.root, 'tool-ledger');
  await writeFile(tool, gateScript(ledger), { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${f.root}:${previousPath ?? ''}`;
  try {
    const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
    const result = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
    assert.equal(result.hold, false, result.records[0]?.error);
    const pin = result.records[0].program;
    assert.equal(pin.kind, 'tool');
    if (pin.kind === 'tool') { assert.equal(pin.path, tool); assert.match(pin.digest, /^sha256:[a-f0-9]{64}$/); assert.deepEqual(pin.argv, program.argv); }
    assert.ok((await readFile(ledger, 'utf8')).length);
  } finally { process.env.PATH = previousPath; }
});

test('a missing named tool holds a required gate with a plain error', async t => {
  const name = `nucleus-missing-${randomUUID()}`;
  const f = await reviewedHeadFixture(t, { '.paseo/queue.json': { content: manifestText([preMerge({ program: { kind: 'tool', name, argv: [] } })]) } });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const result = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
  assert.equal(result.hold, true);
  assert.equal(result.records[0].state, 'blocked');
  assert.equal(result.records[0].error, `${name} not found on Nucleus's PATH`);
});

test('a v3 manifest without task.pre_merge leaves the repository unchanged', async t => {
  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: JSON.stringify({ schema: 'paseo.queue.control.v3', hooks: [{ id: 'legacy', events: ['task.closeout'], target: 'integration_base', mode: 'read_only', delivery: 'required', program: { kind: 'repository', executable: '.paseo/hooks/gate', argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] }, null, 2) },
    '.paseo/hooks/gate': { content: gateScript('/dev/null'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = taskAtReviewedHead(f.store, f.repo, f.directory, f.head);
  const result = await new RepositoryHooks(f.store).emit('task.pre_merge', task, gateContext(task, f.head));
  assert.deepEqual(result, { hold: false, attention: false, records: [] });
  assert.equal(f.store.hookEvents().length, 0);
});

async function resolutionFixture(t: any, script: string) {  const f = await reviewedHeadFixture(t, {
    '.paseo/queue.json': { content: manifestText([preMerge()]) },
    '.paseo/hooks/gate': { content: script, mode: 0o755 },
  });
  f.store.setMeta('paused', false);
  f.store.setMeta('lastRetentionAt', Date.now());
  f.store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = f.store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Reviewed-head gate', repoPath: f.repo, baseBranch: 'main',
    planningCommit: f.head, handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', f.head);
  const base = 'a'.repeat(40);
  f.store.update(submitted.id, {
    phase: 'verifying', workspaceIntent: true, agentIntent: true, workspaceId: 'task-ws', directory: f.directory,
    branch: 'ns-task', agentId: 'worker', runId: 'initial', profile: worker,
    prUrl: 'https://github.com/example/repo/pull/9', prHead: f.head, resumePrNumber: 9,
    resolution: {
      ...submitted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      review: { eventId: 'review', taskId: submitted.id, runId: 'review-run', status: 'ready_to_merge', summary: 'independent review accepted the exact head', head: f.head, reviewCommentId: 9 },
      mergeBase: base,
    },
  });
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'task-ws') => states.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker');
  const tokens = new Map<string, string>(), runs: Run[] = [];
  let merges = 0;
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker, coordinator], validate: async () => f.head, verifyWorkspace: async () => 'main',
    createWorkspace: async () => { throw new Error('No workspace expected'); },
    createAgent: async () => { throw new Error('No worker dispatch expected'); },
    observe: async id => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; },
    agentTimelinePage: observedParticipantTimeline(states),
    verifyPr: async () => ({ head: f.store.task(submitted.id).prHead!, url: 'https://github.com/example/repo/pull/9' }),
    createRun: async (_task, run, token) => { runs.push(run); tokens.set(run.id, token); const id = `agent-${run.id}`; states.set(id, { id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '' }); return { id, workspaceId: run.workspaceId }; },
    sendRun: async (_task, run, token) => { runs.push(run); tokens.set(run.id, token); states.set(run.agentId!, { ...states.get(run.agentId!)!, active: true, status: 'running' }); },
    findRunAgents: async () => [], verifyReview: async () => {},
    mergeGate: async () => ({ head: f.store.task(submitted.id).prHead!, base, wait: '' }),
    merge: async () => { merges += 1; },
    merged: async () => ({ merged: true, commit: f.head, head: f.head, base: 'main' }), syncMain: async () => f.head,
    verifyCloseout: async () => undefined, notify: async () => {},
  });
  const engine = new Engine(f.store, adapter, 0);
  engine.profiles = [worker, coordinator];
  return { ...f, store: f.store, engine, adapter, taskId: submitted.id, base, idle, tokens, runs, mergeCount: () => merges, current: () => f.store.task(submitted.id), close: async () => { await engine.stop(); f.store.close(); } };
}

weighted(21)('a confirmed reviewed-head refusal returns the retained worker through one semantic revision', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await resolutionFixture(t, gateScript(ledger, 'blocked'));
  try {
    await stepEngine(f.engine);
    const refused = f.current();
    assert.equal(refused.phase, 'changes_requested', refused.reason);
    assert.match(refused.reason, /Repository pre-merge refusal/);
    assert.equal(refused.resolution.attention, false);
    assert.equal(refused.resolution.mergeIntent, false);
    assert.equal(refused.resolution.pendingRevisionCause, 'pre_merge');
    assert.equal(refused.resolution.review?.status, 'ready_to_merge', 'the accepted review stays as evidence');
    assert.equal(f.mergeCount(), 0, 'a refusal never merges');
    const record = f.store.hookEvents(f.taskId)[0];
    assert.equal(record.state, 'blocked');
    assert.equal(record.result?.outcome, 'blocked');
    assert.equal(record.baseCommit, f.head, 'the refusal occurrence pins the old reviewed head');
    assert.ok(f.store.events(f.taskId).some(event => event.kind === 'pre_merge_refused'));
    assert.equal(f.store.notices(f.taskId).filter(notice => notice.kind === 'attention').length, 0, 'a semantic refusal does not notify Chatterbox');

    await f.engine.wake();
    const revision = f.runs.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the retained worker receives the refusal');
    assert.equal(revision!.revisionCause, 'pre_merge', 'the refusal returns the retained worker through one semantic revision');
    assert.equal(revision!.agentId, 'worker');
    assert.equal(f.current().resolution.revisionRuns, 0, 'a refusal continues the open round without consuming a review round');
    assert.equal(f.current().resolution.pendingRevisionCause, null);
    // Commit 3b1993c2 (2026-10-06) separated the worker action from task status: the
    // pre-merge refusal is the revision's pending instruction, copied onto the
    // immutable run and cleared from the resolution (orchestration contract).
    assert.match(revision!.instruction!, /Repository pre-merge refusal/);
    assert.equal(f.current().resolution.pendingWorkerInstruction, null);
    assert.equal(record.eventId, f.store.hookEvents(f.taskId)[0].eventId, 'the refusal occurrence stays as evidence');
  } finally { await f.close(); }
});

weighted(11)('a reviewed-head refusal at the cap continues the open round without parking', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await resolutionFixture(t, gateScript(ledger, 'blocked'));
  try {
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET } });
    await stepEngine(f.engine);
    const refused = f.current();
    assert.equal(refused.phase, 'changes_requested', refused.reason);
    assert.equal(refused.resolution.pendingRevisionCause, 'pre_merge');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'revision_budget_exhausted').length, 0, 'a pre-merge refusal never parks at the revision cap');
    assert.equal(f.store.notices(f.taskId).filter(notice => notice.kind === 'attention').length, 0);
    await f.engine.wake();
    const revision = f.runs.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the retained worker still receives the refusal at the cap');
    assert.equal(revision!.revisionCause, 'pre_merge');
    assert.equal(revision!.agentId, 'worker');
    assert.equal(f.current().resolution.revisionRuns, REVISION_BUDGET, 'a pre-merge refusal consumes no review round');
    assert.equal(f.mergeCount(), 0);
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'blocked');
  } finally { await f.close(); }
});

weighted(2)('operational uncertainty at the reviewed head holds instead of inventing a finding', async t => {
  const f = await resolutionFixture(t, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on(\'end\',()=>{process.stdout.write(\'not a result\');});\n');
  try {
    await f.engine.wake();
    const held = f.current();
    assert.equal(held.phase, 'verifying');
    assert.equal(held.resolution.attention, true);
    assert.equal(held.resolution.pendingRevisionCause, null);
    assert.equal(f.runs.filter(run => run.role === 'revision').length, 0);
    assert.equal(f.mergeCount(), 0);
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'blocked');
    assert.equal(f.store.hookEvents(f.taskId)[0].result, null);
  } finally { await f.close(); }
});

weighted(19)('a passing reviewed-head gate proceeds to mechanical verification and one merge', async t => {
  const ledger = join(await mkdtemp(join(tmpdir(), 'nsq-premerge-ledger-')), 'gate.jsonl');
  t.after(() => rm(join(ledger, '..'), { recursive: true, force: true }));
  const f = await resolutionFixture(t, gateScript(ledger));
  try {
    // One sweep per lifecycle step (#346) so the passed gate is observed before the merge.
    await stepEngine(f.engine);
    const passed = f.current();
    assert.equal(passed.phase, 'merging', passed.reason);
    assert.ok(passed.resolution.mechanicalVerification, 'a pass continues to mechanical verification');
    assert.equal(f.store.hookEvents(f.taskId)[0].state, 'result');
    assert.equal(f.store.hookEvents(f.taskId)[0].occurrence, 1);
    await stepEngine(f.engine);
    assert.equal(f.mergeCount(), 1, 'the reviewed head merges exactly once');
    assert.equal(f.store.hookEvents(f.taskId).length, 1, 'merge does not re-run the gate');
  } finally { await f.close(); }
});
