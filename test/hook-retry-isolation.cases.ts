import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../core/store/store';
import { hookRecordSchema } from '../shared/hooks';
import { git, command } from '../core/git/index';
import { RepositoryHooks, blobDigest, discoverManifest, isolationDataDirFor, isolationRootFor, isOwnedIsolationPath, pinExecutable } from '../core/hooks/hooks';
import { submissionSchema } from '../shared/contracts';
import type { Task } from '../shared/contracts';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function makeRepo(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-retry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  return { root, repo };
}

async function commit(repo: string, message: string, files: Record<string, { content: string; mode?: number }> = {}) {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec.content);
    if (spec.mode) await chmod(full, spec.mode);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function taskFor(store: Store, repo: string, title = 'Retry task'): Task {
  return store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath: repo, planningCommit: 'a'.repeat(40), handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
}

async function storeFor(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-retrystore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { store: new Store(join(dir, 'queue.sqlite')), path: join(dir, 'queue.sqlite') };
}

/** A read-only ledger hook that records the delivered event and blocks exactly the first attempt. */
function retryScript(ledgerPath: string) {
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(event)+'\\n');
  const first=event.attempt===1;
  process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:first?'blocked':'ok',summary:first?'hold once':'retried',metadata:{},changedPaths:[],commitSubjectSuffix:null}));
});
`;
}

function readOnlyManifest() {
  return JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] }, null, 2);
}

function writeManifest(allowedPaths: string[]) {
  return JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.closeout'], mode: 'integration_write', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths, commitSubject: { prefix: 'queue: hook', maxBytes: 80 } }] }, null, 2);
}

function cancellationManifest(allowedPaths: string[]) {
  return JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.cancelled'], mode: 'integration_write', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths, commitSubject: { prefix: 'queue: cancel', maxBytes: 80 } }] }, null, 2);
}

function blockedManifest(allowedPaths: string[]) {
  return JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.blocked'], mode: 'integration_write', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths, commitSubject: { prefix: 'queue: blocked', maxBytes: 80 } }] }, null, 2);
}

function writeScript(ledgerPath: string, changedPaths: string[]) {
  return `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim();
  const origin=execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim();
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({eventId:event.eventId,attempt:event.attempt,root:event.repository.root,branch,origin,delivery:event.delivery})+'\\n');
  for(const target of ${JSON.stringify(changedPaths)}){fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify({eventId:event.eventId}));}
  process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'ledger written',metadata:{},changedPaths:${JSON.stringify([...changedPaths].sort())},commitSubjectSuffix:'ledger'}));
});
`;
}

const readJsonl = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a stale pre-publication cancellation occurrence rolls to the current integration base', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'cancel-ledger.jsonl');
  const base = await commit(repo, 'base', {
    '.paseo/queue.json': { content: cancellationManifest(['docs/cancelled.json']) },
    '.paseo/hooks/ledger': { content: writeScript(ledger, ['docs/cancelled.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo, 'Superseded task');

  const sibling = join(root, 'sibling');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  const advanced = await commit(sibling, 'advance main', { 'docs/current.json': { content: '{}' } });
  await push(sibling);

  const first = await hooks.emit('task.cancelled', task, { event: 'task.cancelled', baseCommit: base, summary: 'Superseded by replacement' });
  assert.equal(first.hold, true);
  assert.match(first.records[0].error, /Local integration base differs from origin/);
  assert.equal(first.records[0].commit, null);
  await git(repo, 'pull', '--ff-only', 'origin', 'main');

  const renewed = await hooks.emit('task.cancelled', task, { event: 'task.cancelled', baseCommit: advanced, summary: 'Superseded by replacement' });
  assert.equal(renewed.hold, false, renewed.records[0].error);
  assert.equal(renewed.records[0].state, 'published');
  assert.equal(renewed.records[0].baseCommit, advanced);
  assert.equal(renewed.records[0].occurrence, 2);
  const records = store.hookEvents(task.id);
  assert.equal(records[0].state, 'failed');
  assert.match(records[0].summary, /Superseded before publication/);
  assert.ok(store.eventsAll(task.id).some(event => event.kind === 'hook_occurrence_superseded'));
  assert.equal((await readJsonl(ledger)).length, 1);
});

test('a normal blocked lifecycle pass rolls a stale pre-publication occurrence to the current integration base', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'blocked-ledger.jsonl');
  const base = await commit(repo, 'base', {
    '.paseo/queue.json': { content: blockedManifest(['docs/blocked.json']) },
    '.paseo/hooks/ledger': { content: writeScript(ledger, ['docs/blocked.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  const inserted = taskFor(store, repo, 'Blocked task');
  const workerSummary = 'Portable contract decision required';
  let task = store.update(inserted.id, {
    phase: 'working',
    completion: { eventId: 'initial-ready', taskId: inserted.id, runId: 'worker-run', status: 'ready_for_review', summary: 'Original delivery remains accepted', prNumber: 44, head: base },
  });

  const sibling = join(root, 'sibling-blocked');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  const advanced = await commit(sibling, 'advance main', { 'docs/current.json': { content: '{}' } });
  await push(sibling);

  const first = await hooks.emit('task.blocked', task, { event: 'task.blocked', baseCommit: base, summary: workerSummary });
  assert.equal(first.hold, true);
  assert.match(first.records[0].error, /Local integration base differs from origin/);
  assert.equal(first.records[0].commit, null);
  await git(repo, 'pull', '--ff-only', 'origin', 'main');
  task = store.update(task.id, { phase: 'needs_attention', reason: 'Repository hook held the blocked transition' });

  const renewed = await hooks.emit('task.blocked', task, { event: 'task.blocked', baseCommit: advanced, summary: workerSummary });
  assert.equal(renewed.hold, false, renewed.records[0].error);
  assert.equal(renewed.records[0].state, 'published');
  assert.equal(renewed.records[0].baseCommit, advanced);
  assert.equal(renewed.records[0].occurrence, 2);
  assert.equal(renewed.records[0].eventPayload?.delivery.summary, workerSummary);
  const records = store.hookEvents(task.id);
  assert.equal(records[0].state, 'failed');
  assert.match(records[0].summary, /Superseded before publication/);
  assert.ok(store.eventsAll(task.id).some(event => event.kind === 'hook_occurrence_superseded'));
  assert.equal((await readJsonl(ledger)).length, 1);
});

test('a retry reproduces every immutable event fact and advances exactly one confirmed attempt', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: readOnlyManifest() },
    '.paseo/hooks/ledger': { content: retryScript(ledger), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  const delivery = { prUrl: 'https://example.invalid/pull/9', prNumber: 9, head: '1'.repeat(40), review: 'reviewed head', mergeCommit: '2'.repeat(40), integrationCommit: '3'.repeat(40), summary: 'first delivery' };
  const first = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head, delivery });
  assert.equal(first.hold, true, first.records[0].error);
  const blocked = first.records[0];
  assert.equal(blocked.state, 'blocked');
  const retried = await hooks.retry(task, blocked.id);
  assert.equal(retried.hold, false, retried.records[0].error);
  assert.equal(retried.records[0].state, 'result');
  const lines = await readJsonl(ledger);
  assert.equal(lines.length, 2);
  for (const key of ['eventId', 'hookId', 'event', 'occurredAt', 'repository', 'task', 'delivery']) assert.deepEqual(lines[1][key], lines[0][key], `retry changed ${key}`);
  assert.deepEqual(lines[1].delivery, delivery, 'retry dropped the original delivery object');
  assert.equal(lines[0].attempt, 1);
  assert.equal(lines[1].attempt, 2);
  const stored = store.hookEvent(blocked.id)!;
  assert.equal(stored.eventId, blocked.eventId);
  assert.equal(stored.occurrence, 1);
  assert.equal(stored.attempt, 2);
  assert.equal(stored.state, 'result');
});

async function push(repo: string) { await git(repo, 'push', 'origin', 'main'); }

test('an integration write runs in a Queue-owned isolated checkout and leaves ignored operator evidence untouched', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'write-ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(ledger, ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: '.effigy/\n' },
  });
  await mkdir(join(repo, '.effigy/reports'), { recursive: true });
  await writeFile(join(repo, '.effigy/reports/history.jsonl'), 'durable evidence\n');
  const evidenceBefore = blobDigest(await readFile(join(repo, '.effigy/reports/history.jsonl')));
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const result = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, false, result.records[0].error);
  const record = result.records[0];
  assert.equal(record.state, 'published');
  const commitSha = record.commit!;
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), commitSha);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), commitSha);
  assert.equal(blobDigest(await readFile(join(repo, '.effigy/reports/history.jsonl'))), evidenceBefore, 'ignored evidence must be byte-identical');
  const lines = await readJsonl(ledger);
  assert.equal(lines.length, 1);
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.ok(lines[0].root.startsWith(`${isolationRootFor(isolationDataDirFor(store), common)}/`), `hook ran in ${lines[0].root}`);
  assert.equal(lines[0].root.startsWith(`${common}/`), false, 'the isolated checkout is outside the repository');
  assert.notEqual(lines[0].root, repo);
  await mkdir(join(repo, 'node_modules'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'sentinel'), 'from-repo');
  await writeFile(join(repo, 'walk-sentinel.txt'), 'from-repo');
  const workspaceMarkers = ['package.json', 'pnpm-workspace.yaml', 'bun.lock', 'package-lock.json', 'yarn.lock'] as const;
  for (const name of workspaceMarkers) await writeFile(join(repo, name), 'from-repo\n');
  const repoGit = await realpath(common);
  for (let dir = dirname(lines[0].root); ; dir = dirname(dir)) {
    assert.equal(existsSync(join(dir, 'node_modules', 'sentinel')), false, dir);
    assert.equal(existsSync(join(dir, 'walk-sentinel.txt')), false, dir);
    for (const name of workspaceMarkers) assert.equal(existsSync(join(dir, name)), false, `${dir}/${name}`);
    assert.equal(existsSync(join(dir, '.git')), false, `${dir}/.git`);
    assert.notEqual(await realpath(dir).catch(() => ''), repoGit, dir);
    if (dirname(dir) === dir) break;
  }
  assert.equal(lines[0].branch, 'main', 'hook must observe the declared base branch');
  assert.equal(lines[0].origin, join(root, 'origin.git'), 'isolated repository must retain the canonical publication remote');
  assert.equal(existsSync(lines[0].root), false, 'the isolated checkout is removed after publication');
  assert.equal(record.workspace, null);
  assert.equal((await git(repo, 'worktree', 'list')).trim().split('\n').length, 1);
});

for (const scenario of ['dirty', 'moved', 'branch'] as const)
test(`an integration write refuses a ${scenario} canonical checkout before creating a worktree`, async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, `ledger-${scenario}.jsonl`);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(ledger, ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  if (scenario === 'dirty') await writeFile(join(repo, 'docs/plan.json'), 'changed');
  if (scenario === 'moved') await commit(repo, 'moved', { 'docs/plan.json': { content: '{"moved":true}' } });
  if (scenario === 'branch') await git(repo, 'checkout', '-b', 'other');
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const result = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, true, scenario);
  assert.equal(result.records[0].state, 'blocked', `${scenario}: ${result.records[0].error}`);
  assert.match(result.records[0].error, /clean synchronized base/, scenario);
  assert.equal(existsSync(ledger), false, `${scenario} must not execute the hook`);
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(existsSync(isolationRootFor(isolationDataDirFor(store), common)), false, `${scenario} must not create an isolated checkout`);
  assert.equal(existsSync(join(common, 'queue-hooks')), false, `${scenario} must not create a legacy isolated checkout`);
});

test('a collision with ignored operator content keeps the published commit and the isolated checkout for reconciliation', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'collision-ledger.jsonl');
  const manifest = JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.closeout'], mode: 'integration_write', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['.gitignore', 'docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } }] }, null, 2);
  const script = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('.gitignore','');fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'ledger written',metadata:{},changedPaths:['.gitignore','docs/ledger.json'],commitSubjectSuffix:'ledger'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: 'docs/ledger.json\n' },
  });
  await writeFile(join(repo, 'docs/ledger.json'), 'operator ignored content\n');
  const collisionBefore = blobDigest(await readFile(join(repo, 'docs/ledger.json')));
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const result = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, true);
  const record = result.records[0];
  assert.equal(record.state, 'uncertain', record.error);
  assert.match(record.error, /synchronization/i);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit, 'the remote publication stands');
  assert.equal(blobDigest(await readFile(join(repo, 'docs/ledger.json'))), collisionBefore, 'operator ignored content is untouched');
  assert.ok(record.workspace && existsSync(record.workspace.path), 'ambiguous synchronization keeps the Queue-owned checkout visible');
});

/** A collision fixture whose ignored operator evidence sits at or around the published path. */
async function collisionFixture(t: any, ignoreRule: string, evidencePath: string, publishedPath: string, allowedPaths: string[]) {
  const { root, repo } = await makeRepo(t);
  const manifest = JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.closeout'], mode: 'integration_write', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['.gitignore', ...allowedPaths], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } }] }, null, 2);
  const script = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('.gitignore','');fs.mkdirSync(path.dirname(${JSON.stringify(publishedPath)}),{recursive:true});fs.writeFileSync(${JSON.stringify(publishedPath)},JSON.stringify({eventId:event.eventId}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'ledger written',metadata:{},changedPaths:${JSON.stringify(['.gitignore', ...allowedPaths].sort())},commitSubjectSuffix:'ledger'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: ignoreRule },
  });
  await mkdir(join(repo, evidencePath, '..'), { recursive: true });
  await writeFile(join(repo, evidencePath), 'operator ignored content\n');
  const evidenceBefore = blobDigest(await readFile(join(repo, evidencePath)));
  await push(repo);
  const { store } = await storeFor(t);
  const result = await new RepositoryHooks(store).emit('task.closeout', taskFor(store, repo), { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, true, result.records[0].error);
  const record = result.records[0];
  assert.equal(record.state, 'uncertain', record.error);
  assert.match(record.error, /ignored operator content would be overwritten/);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit, 'the remote publication stands');
  assert.equal(blobDigest(await readFile(join(repo, evidencePath))), evidenceBefore, 'operator ignored content is untouched');
  assert.ok(record.workspace && existsSync(record.workspace.path), 'ambiguous synchronization keeps the Queue-owned checkout visible');
}

test('a publication below an ignored branch boundary still collides with operator evidence', async t => {
  await collisionFixture(t, 'evidence/\n', 'evidence/reports/history.jsonl', 'evidence/reports/ledger.json', ['evidence/reports/ledger.json']);
});

test('a publication above an ignored branch boundary still collides with operator evidence', async t => {
  await collisionFixture(t, '.effigy/reports/\n', '.effigy/reports/history.jsonl', '.effigy', ['.effigy']);
});

test('restart reconciliation resumes a clean creation intent and refuses a lost running checkout', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(join(root, 'restart.jsonl'), ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const base = {
    id: randomUUID(), taskId: task.id, hookId: 'ledger', event: 'task.closeout' as const, eventId: 'r'.repeat(48), occurrence: 1,
    mode: 'integration_write' as const, delivery: 'required' as const,
    manifest: { path: '.paseo/queue.json', commit: head, digest: `sha256:${sha('m')}` },
    executable: { path: '.paseo/hooks/ledger', commit: head, digest: `sha256:${sha('e')}` },
    instruction: null, baseBranch: 'main', baseCommit: head, attempt: 1,
    argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 },
    eventDigest: sha('d'), eventPayload: null, result: null, commit: null, remote: null, summary: '', error: '', reconciledAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const workspace = join(isolationRootFor(isolationDataDirFor(store), common), base.eventId);
  const intent = hookRecordSchema.parse({ ...base, state: 'workspace_intent', workspace: { path: workspace, head } });
  store.putHookEvent(intent);
  const hooks = new RepositoryHooks(store);
  const resumed = await hooks.reconcile(store.hookEvent(intent.id)!);
  assert.equal(resumed.state, 'intent');

  const running = hookRecordSchema.parse({ ...base, id: randomUUID(), eventId: 'k'.repeat(48), state: 'running', processId: 999999, workspace: { path: workspace, head } });
  store.putHookEvent(running);
  const lost = await hooks.reconcile(store.hookEvent(running.id)!);
  assert.equal(lost.state, 'uncertain');
  assert.match(lost.error, /lost the Queue-owned checkout/);
});

test('a checkout recorded under the data-home isolation root is reconciled and removed', async t => {
  const { repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(join(repo, 'legacy.jsonl'), ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const eventId = 'a'.repeat(48);
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const workspace = join(isolationRootFor(isolationDataDirFor(store), common), eventId);
  await mkdir(isolationRootFor(isolationDataDirFor(store), common), { recursive: true });
  await command('git', ['clone', '--shared', '--no-checkout', '--', repo, workspace], repo);
  await git(workspace, 'checkout', '-B', 'main', head);
  const record = hookRecordSchema.parse({
    id: randomUUID(), taskId: task.id, hookId: 'ledger', event: 'task.closeout', eventId, occurrence: 1,
    mode: 'integration_write', delivery: 'required', state: 'cleanup_intent',
    manifest: { path: '.paseo/queue.json', commit: head, digest: `sha256:${sha('m')}` },
    executable: { path: '.paseo/hooks/ledger', commit: head, digest: `sha256:${sha('e')}` },
    instruction: null, baseBranch: 'main', baseCommit: head, attempt: 1,
    argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 },
    eventDigest: sha('d'), eventPayload: null,
    workspace: { path: workspace, head }, result: { schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'ok', summary: 'ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null },
    commit: head, remote: 'refs/heads/main', summary: '', error: '', reconciledAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  store.putHookEvent(record);
  const cleaned = await new RepositoryHooks(store).reconcile(store.hookEvent(record.id)!);
  assert.equal(cleaned.state, 'published', cleaned.error);
  assert.equal(cleaned.workspace, null);
  assert.equal(existsSync(workspace), false, 'the checkout is removed by the ordinary cleanup path');
});

test('ownership and removal guards refuse paths outside the data-home isolation root', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(join(root, 'foreign.jsonl'), ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const dataDir = isolationDataDirFor(store);
  const foreign = join(root, 'foreign-checkout');
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, 'safe'), 'operator checkout');
  assert.equal(isOwnedIsolationPath(foreign, dataDir, common), false);
  assert.equal(isOwnedIsolationPath(join(isolationRootFor(dataDir, common), 'x'.repeat(48)), dataDir, common), true);
  assert.equal(isOwnedIsolationPath(join(common, 'queue-hooks', 'y'.repeat(48)), dataDir, common), false);
  const record = hookRecordSchema.parse({
    id: randomUUID(), taskId: task.id, hookId: 'ledger', event: 'task.closeout', eventId: 'f'.repeat(48), occurrence: 1,
    mode: 'integration_write', delivery: 'required', state: 'cleanup_intent',
    manifest: { path: '.paseo/queue.json', commit: head, digest: `sha256:${sha('m')}` },
    executable: { path: '.paseo/hooks/ledger', commit: head, digest: `sha256:${sha('e')}` },
    instruction: null, baseBranch: 'main', baseCommit: head, attempt: 1,
    argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 },
    eventDigest: sha('d'), eventPayload: null,
    workspace: { path: foreign, head }, result: { schema: 'paseo.queue.hook-result.v1', eventId: 'f'.repeat(48), outcome: 'ok', summary: 'ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null },
    commit: null, remote: null, summary: '', error: '', reconciledAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  store.putHookEvent(record);
  const held = await new RepositoryHooks(store).reconcile(store.hookEvent(record.id)!);
  assert.equal(held.state, 'uncertain');
  assert.match(held.error, /outside the Queue-owned isolation root/);
  assert.equal(existsSync(join(foreign, 'safe')), true, 'a foreign path is not removed');
});

test('restart reconciliation adopts a proven remote publication, synchronizes and cleans up', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'reconcile-ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(ledger, ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const published = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  assert.equal(published.records[0].state, 'published');
  const record = published.records[0];

  // Simulate a crash after the push but before canonical synchronization and cleanup.
  const { store: crashed } = await storeFor(t);
  const task2 = taskFor(crashed, repo);
  const interrupted = hookRecordSchema.parse({ ...record, id: randomUUID(), taskId: task2.id, state: 'push_intent', reconciledAt: null });
  crashed.putHookEvent(interrupted);
  const reconciled = await new RepositoryHooks(crashed).reconcile(crashed.hookEvent(interrupted.id)!);
  assert.equal(reconciled.state, 'published');
  assert.equal(reconciled.commit, record.commit);
  assert.equal(reconciled.workspace, null);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), record.commit);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit);
});

test('a concurrent advance past the published commit fast-forwards the canonical checkout to the remote tip', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: writeScript(join(root, 'concurrent.jsonl'), ['docs/ledger.json']), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const published = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  assert.equal(published.records[0].state, 'published');
  const hookCommit = published.records[0].commit!;

  // Another publisher advances main after the hook push.
  await writeFile(join(repo, 'docs/later.txt'), 'later\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'later publication');
  const later = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', 'main');
  // Canonical is left behind at the hook commit, as if the sync never ran.
  await git(repo, 'reset', '--hard', hookCommit);

  const { store: crashed } = await storeFor(t);
  const task2 = taskFor(crashed, repo);
  const interrupted = hookRecordSchema.parse({ ...published.records[0], id: randomUUID(), taskId: task2.id, state: 'push_intent', reconciledAt: null });
  crashed.putHookEvent(interrupted);
  const reconciled = await new RepositoryHooks(crashed).reconcile(crashed.hookEvent(interrupted.id)!);
  assert.equal(reconciled.state, 'published');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), later);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), later);
});

test('a blocked integration write retries from its durable delivery and publishes from the isolated checkout', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'retry-write.jsonl');
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({attempt:event.attempt,root:event.repository.root,delivery:event.delivery})+'\\n');
if(event.attempt===1){process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'delivery object does not carry a usable reviewed head',metadata:{},changedPaths:[],commitSubjectSuffix:null}));return;}
fs.writeFileSync('docs/ledger.json',JSON.stringify({head:event.delivery.head,integrationCommit:event.delivery.integrationCommit}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'published after retry',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  const delivery = { prUrl: 'https://example.invalid/pull/45', prNumber: 45, head: '6'.repeat(40), review: 'verified', mergeCommit: '4'.repeat(40), integrationCommit: head, summary: 'closeout completed' };
  const first = await hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: head, delivery });
  assert.equal(first.hold, true);
  const blocked = first.records[0];
  assert.equal(blocked.state, 'blocked');
  // Retry supplies no delivery context, exactly like the runtime control path.
  const retried = await hooks.retry(task, blocked.id);
  assert.equal(retried.hold, false, retried.records[0].error);
  const record = retried.records[0];
  assert.equal(record.state, 'published');
  const lines = await readJsonl(ledger);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1].delivery, delivery, 'the retry delivered the original non-null facts');
  assert.equal(lines[0].delivery.head, delivery.head, 'the first attempt already carried the facts');
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.ok(lines[1].root.startsWith(`${isolationRootFor(isolationDataDirFor(store), common)}/`));
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), record.commit);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit);
  assert.equal(JSON.parse(await readFile(join(repo, 'docs/ledger.json'), 'utf8')).head, delivery.head);
});

for (const retryBeforeSync of [false, true]) test(`a normal closeout pass rolls a repaired occurrence (retry before sync: ${retryBeforeSync})`, async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'rolled-closeout.jsonl');
const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({eventId:event.eventId,attempt:event.attempt,baseCommit:event.repository.baseCommit,integrationCommit:event.delivery.integrationCommit,instructionCommit:event.task.instruction&&event.task.instruction.commit})+'\\n');
if(!fs.existsSync('docs/repair.txt')){fs.mkdirSync('.effigy',{recursive:true});fs.writeFileSync('.effigy/runtime.json','ignored');process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'roadmap reference missing',metadata:{},changedPaths:[],commitSubjectSuffix:null}));return;}
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId,baseCommit:event.repository.baseCommit}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'closeout recorded after repair',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'closeout'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: '.effigy/\n' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  let task = taskFor(store, repo);
  task = store.update(task.id, {
    phase: 'closing',
    instruction: { path: 'docs/plan.json', commit: head, digest: blobDigest(Buffer.from('{}')), mediaType: 'text/markdown' },
    resolution: { ...task.resolution, mergedCommit: head, syncedCommit: head },
  });
  const delivery = { prUrl: 'https://example.invalid/pull/45', prNumber: 45, head: '6'.repeat(40), review: 'verified', mergeCommit: head, integrationCommit: head, summary: 'closeout completed' };
  const first = await hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: head, delivery });
  assert.equal(first.hold, true);
  const blocked = first.records[0];
  assert.equal(blocked.state, 'blocked');

  const repairedPlan = '---\nkind: northstar-handoff\nroadmap: docs/roadmaps/g02/092-task.md\n---\n';
  const repaired = await commit(repo, 'repair roadmap reference', {
    'docs/repair.txt': { content: 'linked\n' },
    'docs/plan.json': { content: repairedPlan },
  });
  await push(repo);
  if (retryBeforeSync) {
    const stale = await hooks.retry(task, blocked.id);
    assert.equal(stale.hold, true);
    assert.match(stale.records[0].error, /Integration HEAD moved from the event base/);
    assert.equal(stale.records[0].result?.summary, 'roadmap reference missing');
  }
  task = store.update(task.id, { resolution: { ...store.task(task.id).resolution, syncedCommit: repaired } });
  const retried = await hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: repaired, delivery: { ...delivery, integrationCommit: repaired } });
  assert.equal(retried.hold, false, retried.records[0].error);
  assert.equal(retried.records[0].state, 'published');
  assert.equal(retried.records[0].occurrence, 2);
  assert.equal(retried.records[0].attempt, 1);
  assert.equal(retried.records[0].baseCommit, repaired);
  assert.notEqual(retried.records[0].eventId, blocked.eventId);

  const records = store.hookEvents(task.id);
  assert.equal(records.length, 2);
  assert.equal(records[0].state, 'failed', 'the stale occurrence remains terminal audit evidence');
  assert.equal(records[0].occurrence, 1);
  assert.equal(records[0].result?.summary, 'roadmap reference missing');
  assert.match(records[0].summary, /Superseded before publication/);
  assert.equal(records[1].state, 'published');
  assert.equal(hooks.closeoutEmissionSettled(task.id), true, 'the latest successful occurrence settles closeout');
  const lines = await readJsonl(ledger);
  assert.deepEqual(lines.map(line => line.attempt), [1, 1]);
  assert.deepEqual(lines.map(line => line.baseCommit), [head, repaired]);
  assert.deepEqual(lines.map(line => line.instructionCommit), [head, repaired]);
  assert.equal(lines[1].integrationCommit, repaired);
  assert.equal(records[1].instruction?.digest, blobDigest(Buffer.from(repairedPlan)));
});

test('a blocked closeout rolls to a fresh occurrence when durable review evidence is restored', async t => {
  const { repo } = await makeRepo(t);
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
if(!event.delivery.review){process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'accepted review missing',metadata:{},changedPaths:[],commitSubjectSuffix:null}));return;}
fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId,review:event.delivery.review}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'closeout recorded',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'closeout'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  let task = taskFor(store, repo);
  task = store.update(task.id, {
    phase: 'closing',
    instruction: { path: 'docs/plan.json', commit: head, digest: blobDigest(Buffer.from('{}')), mediaType: 'text/markdown' },
    prUrl: 'https://example.invalid/pull/45', prHead: '6'.repeat(40),
    resolution: { ...task.resolution, mergedCommit: head, syncedCommit: head },
  });
  const first = await hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: head, delivery: { prUrl: task.prUrl, prNumber: 45, head: task.prHead, review: null, mergeCommit: head, integrationCommit: head, summary: 'closeout completed' } });
  assert.equal(first.records[0].state, 'blocked');
  task = store.update(task.id, { resolution: { ...store.task(task.id).resolution, review: { eventId: 'review', taskId: task.id, runId: 'review-run', status: 'ready_to_merge', summary: 'accepted exact-head review', head: task.prHead!, reviewCommentId: 45 } } });

  const retried = await hooks.retry(task, first.records[0].id);
  assert.equal(retried.hold, false, retried.records[0].error);
  assert.equal(retried.records[0].state, 'published');
  assert.equal(retried.records[0].occurrence, 2);
  assert.equal(retried.records[0].baseCommit, head);
  assert.equal(retried.records[0].eventPayload?.delivery.review, 'accepted exact-head review');
  const records = store.hookEvents(task.id);
  assert.equal(records[0].state, 'failed');
  assert.match(records[0].summary, /accepted-review evidence was restored/);
  assert.equal(JSON.parse(await readFile(join(repo, 'docs/ledger.json'), 'utf8')).review, 'accepted exact-head review');
});

/**
 * Build the exact pre-fix live shape: an uncertain integration write whose
 * isolated Queue-owned checkout holds one declared edit plus one ignored
 * runtime receipt, with no commit and no remote publication.
 */
async function preCommitFixture(t: any) {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'precommit-ledger.jsonl');
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.mkdirSync('.runtime',{recursive:true});fs.writeFileSync('.runtime/receipt.json',JSON.stringify({eventId:event.eventId}));
fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId,attempt:event.attempt}));
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({attempt:event.attempt,root:event.repository.root})+'\\n');
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'declared file written',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});`;
  const allowedPaths = ['docs/ledger.json'];
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(allowedPaths) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: '.runtime/\n' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  const task = taskFor(store, repo);
  const hooks = new RepositoryHooks(store);
  const discovery = (await discoverManifest(repo, head))!;
  const hook = discovery.manifest.hooks.find(candidate => candidate.id === 'ledger')!;
  const eventId = 'p'.repeat(48);
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const workspace = join(isolationRootFor(isolationDataDirFor(store), common), eventId);
  await mkdir(isolationRootFor(isolationDataDirFor(store), common), { recursive: true });
  const origin = await git(repo, 'remote', 'get-url', 'origin');
  await command('git', ['clone', '--shared', '--no-checkout', '--', repo, workspace], repo);
  await git(workspace, 'config', 'user.name', 'Queue test');
  await git(workspace, 'config', 'user.email', 'queue@example.invalid');
  await git(workspace, 'remote', 'set-url', 'origin', origin);
  await git(workspace, 'checkout', '-B', 'main', head);
  await mkdir(join(workspace, '.runtime'), { recursive: true });
  await writeFile(join(workspace, '.runtime/receipt.json'), '{"receipt":true}');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(workspace, 'docs/ledger.json'), '{"pending":true}');
  const record = hookRecordSchema.parse({
    id: randomUUID(), taskId: task.id, hookId: 'ledger', event: 'task.closeout', eventId, occurrence: 1,
    mode: 'integration_write', delivery: 'required', state: 'uncertain',
    manifest: discovery.pin,
    program: { kind: 'repository', executable: await pinExecutable(repo, head, '.paseo/hooks/ledger'), argv: [] },
    instruction: null, baseBranch: 'main', baseCommit: head, attempt: 2,
    argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths,
    commitSubject: { prefix: 'queue: hook', maxBytes: 80 },
    eventDigest: sha('event'), eventPayload: hooks.buildEvent(task, hook, eventId, 1, { event: 'task.closeout', baseCommit: head }, workspace),
    workspace: { path: workspace, head }, result: null, commit: null, remote: null,
    summary: 'ignored runtime receipt appeared beside the declared change', error: 'Ignored path changed: .runtime/receipt.json',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reconciledAt: null,
  });
  store.putHookEvent(record);
  return { root, repo, store, hooks, task, head, workspace, record, ledger, allowedPaths };
}

test('a proven pre-commit uncertainty retries, replaces the disposable checkout and publishes only declared paths', async t => {
  const f = await preCommitFixture(t);
  const retried = await f.hooks.retry(f.task, f.record.id);
  assert.equal(retried.hold, false, retried.records[0].error);
  const record = retried.records[0];
  assert.equal(record.state, 'published');
  assert.equal(record.eventId, f.record.eventId, 'the same event occurrence is reused');
  assert.equal(record.occurrence, 1);
  assert.equal(record.attempt, 3);
  const changed = await git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', record.commit!);
  assert.deepEqual(changed.split('\n').filter(Boolean), ['docs/ledger.json']);
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), record.commit);
  assert.equal(await git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit);
  assert.equal(existsSync(join(f.repo, '.runtime/receipt.json')), false, 'the ignored receipt never reaches the canonical checkout');
  assert.equal(existsSync(f.workspace), false, 'the stale disposable checkout is replaced and removed');
  const recovered = f.store.events(f.task.id).filter(event => event.kind === 'hook_pre_commit_recovered');
  assert.equal(recovered.length, 1, 'pre-commit recovery is exposed in task history');
  const lines = await readJsonl(f.ledger);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].attempt, 3, 'the retry advances exactly one confirmed attempt');
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.ok(lines[0].root.startsWith(`${isolationRootFor(isolationDataDirFor(f.store), common)}/`), 'a live recorded checkout keeps its data-home path');
});

const preCommitRefusalVariants: Record<string, (f: Awaited<ReturnType<typeof preCommitFixture>>) => Promise<void>> = {
  'moved canonical': async f => { await commit(f.repo, 'moved', { 'docs/plan.json': { content: '{"moved":true}' } }); },
  'moved remote': async f => { await commit(f.repo, 'pushed', { 'docs/plan.json': { content: '{"pushed":true}' } }); await push(f.repo); await git(f.repo, 'reset', '--hard', f.head); },
  'missing checkout': async f => { await rm(f.workspace, { recursive: true, force: true }); },
  'moved checkout': async f => { await git(f.workspace, 'add', '-A'); await git(f.workspace, 'commit', '-m', 'unrelated checkout commit'); },
  'wrong branch': async f => { await git(f.workspace, 'checkout', '-b', 'other'); },
  'unexpected path': async f => { await writeFile(join(f.workspace, 'docs/other.json'), '{}'); },
  'matching commit': async f => { await git(f.workspace, 'add', '-A'); await git(f.workspace, 'commit', '-m', 'hook attempt', '-m', `Northstar-Queue-Hook: ${f.record.eventId}\nNorthstar-Queue-Manifest: ${f.record.manifest.path}@${f.record.manifest.digest}\nNorthstar-Queue-Event: task.closeout`); },
  'commit intent': async f => { f.store.putHookEvent({ ...f.record, commit: 'a'.repeat(40) }); },
  'push intent': async f => { f.store.putHookEvent({ ...f.record, remote: 'refs/heads/main' }); },
  'stored result mismatch': async f => { f.store.putHookEvent({ ...f.record, result: { schema: 'paseo.queue.hook-result.v1' as const, eventId: f.record.eventId, outcome: 'ok' as const, summary: 'stale parsed result', metadata: {}, changedPaths: ['docs/other.json'], commitSubjectSuffix: null } }); },
};

for (const [name, mutate] of Object.entries(preCommitRefusalVariants))
test(`pre-commit recovery refuses ${name}`, async t => {
  const f = await preCommitFixture(t);
  await mutate(f);
  await assert.rejects(f.hooks.retry(f.task, f.record.id), /Reconcile the uncertain hook outcome before retrying/, name);
  assert.equal(f.store.hookEvent(f.record.id)!.state, 'uncertain', name);
  assert.equal(existsSync(f.ledger), false, `${name} must not execute the hook`);
  const remoteBody = await git(f.repo, 'show', '-s', '--format=%B', 'refs/remotes/origin/main').catch(() => '');
  assert.equal(remoteBody.includes(`Northstar-Queue-Hook: ${f.record.eventId}`), false, `${name} must not publish a hook commit`);
});

test('the recovery and isolated-checkout code stays document-system agnostic', async () => {
  const sources = await Promise.all(['core/hooks/hooks.ts'].map(file => readFile(join(process.cwd(), file), 'utf8')));
  for (const forbidden of ['docs/handoffs', 'handoffPath', 'planningCommit', 'frontmatter', 'Northstar handoff file', 'g0', 'worker-pr-loop', 'inflatable-cookie']) {
    assert.equal(sources.join('\n').includes(forbidden), false, `generic hook core must not embed ${forbidden}`);
  }
});

for (const scenario of ['unpublished', 'published', 'unreadable remote', 'foreign edits'] as const)
test(`operator disposal of a rejected closeout checkout: ${scenario}`, async t => {
  const { repo } = await makeRepo(t);
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const e=JSON.parse(raw);
const repaired=fs.existsSync('docs/repair.txt');if(repaired)fs.writeFileSync('docs/ledger.json','renewed');
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:e.eventId,outcome:repaired?'ok':'blocked',summary:'closeout',metadata:{},changedPaths:repaired?['docs/ledger.json']:[],commitSubjectSuffix:null}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: writeManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  t.after(() => store.close());
  const hooks = new RepositoryHooks(store);
  let task = taskFor(store, repo);
  task = store.update(task.id, { phase: 'closing', resolution: { ...task.resolution, mergedCommit: head, syncedCommit: head } });
  const first = (await hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: head })).records[0];
  const path = first.workspace!.path;
  const orphan = await commit(path, `hook publication\n\nNorthstar-Queue-Hook: ${first.eventId}\nNorthstar-Queue-Manifest: ${first.manifest.path}@${first.manifest.digest}`, {
    'docs/ledger.json': { content: 'pending' },
  });
  store.putHookEvent({ ...first, commit: orphan, remote: 'refs/heads/main', result: { ...first.result!, outcome: 'ok', changedPaths: ['docs/ledger.json'] } });
  if (scenario === 'published') {
    await push(path);
    await git(repo, 'fetch', 'origin', 'main');
    await git(repo, 'merge', '--ff-only', 'origin/main');
  }
  const repaired = await commit(repo, 'concurrent docs change', { 'docs/repair.txt': { content: 'ready' } });
  await push(repo);
  task = store.update(task.id, { resolution: { ...task.resolution, syncedCommit: repaired } });
  if (scenario === 'unreadable remote') await git(repo, 'remote', 'set-url', 'origin', '/no-such-queue-test-remote');
  if (scenario === 'foreign edits') await writeFile(join(path, 'unowned.txt'), 'preserve me');
  if (scenario !== 'unpublished') {
    await assert.rejects(hooks.retry(task, first.id, true));
    assert.equal(existsSync(path), true, 'failed proof preserves pending content');
    assert.equal(store.hookEvents(task.id).length, 1);
    return;
  }
  await assert.rejects(hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: repaired }), /explicit discardUnpublishedCheckout/);
  await assert.rejects(hooks.retry(task, first.id), /explicit discardUnpublishedCheckout/);
  assert.equal(existsSync(path), true);
  const held = await hooks.retry(task, first.id, true, true);
  assert.equal(held.hold, true);
  assert.equal(existsSync(path), false);
  assert.equal(store.hookEvents(task.id).length, 1);
  const result = await hooks.retry(task, first.id, true);
  assert.equal(result.hold, false, result.records[0].error);
  assert.equal(result.records[0].state, 'published');
  assert.equal(result.records[0].baseCommit, repaired);
  assert.equal(result.records[0].occurrence, 2);
  assert.equal(store.hookEvent(first.id)!.commit, orphan, 'old publication intent remains evidence');
  assert.equal(store.hookEvent(first.id)!.state, 'failed');
  assert.equal(existsSync(path), false);
});

for (const event of ['task.blocked', 'task.cancelled'] as const)
for (const scenario of ['held', 'unreadable remote', 'executed', 'wrong branch', 'wrong directory'] as const)
test(`explicit ${event} creation-corpse reconciliation: ${scenario}`, async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'invocations');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: event === 'task.blocked' ? blockedManifest(['docs/ledger.json']) : cancellationManifest(['docs/ledger.json']) },
    '.paseo/hooks/ledger': { content: retryScript(ledger), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const { store } = await storeFor(t);
  t.after(() => store.close());
  let hooks = new RepositoryHooks(store);
  const task = store.update(taskFor(store, repo).id, { phase: 'needs_attention', reason: 'Credentials missing; do not resume' });
  const first = (await hooks.emit(event, task, { event, baseCommit: head })).records[0];
  const path = first.workspace!.path;
  await rm(join(path, '.git'), { recursive: true, force: true });
  // Model a failed clone before invocation. The fixture's first refusal only
  // provides the real immutable payload and isolated path for this occurrence.
  store.putHookEvent({ ...first, state: 'uncertain', attempt: 0, result: null, error: 'checkout creation failed' });
  if (scenario === 'unreadable remote') await git(repo, 'remote', 'set-url', 'origin', '/no-such-queue-test-remote');
  if (scenario === 'executed') store.putHookEvent({ ...store.hookEvent(first.id)!, attempt: 1 });
  if (scenario === 'wrong branch') store.putHookEvent({ ...store.hookEvent(first.id)!, baseBranch: 'other' });
  if (scenario === 'wrong directory') store.putHookEvent({ ...store.hookEvent(first.id)!, workspace: { ...first.workspace!, path: repo } });
  if (scenario !== 'held') {
    await assert.rejects(hooks.retry(task, first.id, true, true));
    assert.equal(existsSync(path), true);
    assert.equal(store.hookEvents(task.id).length, 1);
    assert.equal(store.hookEvent(first.id)!.checkoutDiscard, undefined);
    return;
  }
  const put = store.putHookEvent.bind(store);
  store.putHookEvent = record => {
    put(record);
    if (record.checkoutDiscard?.status === 'intent') throw new Error('simulated interruption after durable intent');
  };
  await assert.rejects(hooks.retry(task, first.id, true, true), /simulated interruption/);
  store.putHookEvent = put;
  assert.equal(existsSync(path), true, 'intent precedes removal');
  assert.equal((await hooks.emit(event, task, { event, baseCommit: head })).hold, true);
  const result = await hooks.retry(task, first.id, true, true);
  assert.equal(result.hold, true);
  assert.equal(result.records[0].checkoutDiscard?.status, 'held');
  assert.equal(result.records[0].state, 'blocked');
  assert.equal(existsSync(path), false);
  assert.equal(await git(repo, 'rev-parse', 'origin/main'), head);
  assert.equal(store.task(task.id).reason, 'Credentials missing; do not resume');
  assert.equal(store.hookEvents(task.id).length, 1);
  // Reconstruct the executor, reconcile, then sweep on a changed base: none
  // grants authority to invoke or publish this deliberately held occurrence.
  hooks = new RepositoryHooks(store);
  await hooks.reconcileTask(task);
  const advanced = await commit(repo, 'unrelated change', { 'docs/other': { content: 'other' } });
  await push(repo);
  assert.equal((await hooks.emit(event, task, { event, baseCommit: advanced })).hold, true);
  assert.equal((await readJsonl(ledger)).length, 1);
  assert.equal(store.hookEvents(task.id).length, 1);
  await assert.rejects(hooks.retry(task, first.id), /explicit discard retry/);
  // A later explicit execution authorization can mint the successor, retaining
  // the original occurrence and task identity. This is not used on the live lane.
  await hooks.retry(task, first.id, true);
  assert.equal(store.hookEvents(task.id).length, 2);
  assert.equal(store.hookEvent(first.id)!.state, 'failed');
  assert.equal((await readJsonl(ledger)).length, 2);
});
