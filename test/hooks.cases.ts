import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, symlink, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { git, command, queueCheckoutStatus, validateSubmission } from '../core/git/index';
import {
  RepositoryHooks, blobDigest, discoverManifest, inspectChangedPaths, STDERR_EXCERPT_MAX_BYTES, HOOK_EVIDENCE_MAX_BYTES,
  parseHookResult, parseManifestBytes, parsePorcelain, pinInstruction, executeHookProgram,
  isRecoveredPreDispatchHookHold, statusEntries, ignoredPathCollides, gitRaw, snapshotGit,
  SCRATCH_INDEX_PREFIX,
  type ExecutionOutcome,
  isolationRootFor, isolationDataDirFor,
} from '../core/hooks/hooks';
import { controlManifestSchema, instructionArtifactSchema, joinCommitSubject, normalizeAllowedPath, normalizeRepoRelativePath, allowedPathSchema } from '../shared/hooks';
import { submissionSchema } from '../shared/contracts';
import type { Task } from '../shared/contracts';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import { processGroupHasStartIdentity } from '../core/machine/process-group';

async function makeRepo(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-hooks-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  await command('git', ['clone', join(root, 'origin.git'), join(root, 'repo')], root);
  const repo = join(root, 'repo');
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
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

async function push(repo: string) { await git(repo, 'push', 'origin', 'main'); }

function manifestHook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ledger', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required',
    executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
    allowedPaths: [], commitSubject: null, ...overrides,
  } as Record<string, unknown>;
}

function manifest(hooks: unknown[]) { return JSON.stringify({ schema: 'paseo.queue.control.v1', hooks }, null, 2); }

/** A repository-neutral JSON-ledger hook: it appends the received event to an absolute path. */
function ledgerScript(ledgerPath: string, options: { extra?: string; outcome?: string; summary?: string; changedPaths?: string[]; suffix?: string | null } = {}) {
  const result = `{schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:${JSON.stringify(options.outcome ?? 'ok')},summary:${JSON.stringify(options.summary ?? 'ledger')},metadata:{},changedPaths:${JSON.stringify(options.changedPaths ?? [])},commitSubjectSuffix:${JSON.stringify(options.suffix ?? null)}}`;
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({eventId:event.eventId,hookId:event.hookId,event:event.event,title:event.task.title,attempt:event.attempt,argv:process.argv.slice(2)})+'\\n');
  ${options.extra ?? ''}
  const result=${result};
  process.stdout.write(JSON.stringify(result));
});
`;
}

function taskFor(store: Store, repo: string, title = 'Ledger task'): Task {
  return store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath: repo, planningCommit: 'a'.repeat(40), handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
}

async function hooksFixture(t: any, files: Record<string, { content: string; mode?: number }> = {}) {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    'docs/plan.json': { content: JSON.stringify({ task: 'ledger' }) },
    ...files,
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  return { root, repo, head, store, hooks: new RepositoryHooks(store), task: () => taskFor(store, repo) };
}

test('the generic hook core carries no document-system vocabulary', async () => {
  const generic = [await readFile(join(process.cwd(), 'shared', 'hooks.ts'), 'utf8'), await readFile(join(process.cwd(), 'core', 'hooks', 'hooks.ts'), 'utf8')].join('\n');
  for (const forbidden of ['docs/handoffs', 'handoffPath', 'planningCommit', 'frontmatter', 'Northstar handoff file', 'g0', 'worker-pr-loop']) {
    assert.equal(generic.includes(forbidden), false, `generic hook core must not embed ${forbidden}`);
  }
  const parsed = parseManifestBytes(Buffer.from(manifest([manifestHook()])));
  assert.equal(parsed.schema, 'paseo.queue.control.v1');
});

test('a repository without a manifest keeps current behavior', async t => {
  const f = await hooksFixture(t);
  assert.equal(await discoverManifest(f.repo, f.head), null);
  const result = await f.hooks.emit('task.pre_dispatch', f.task(), { event: 'task.pre_dispatch', baseCommit: f.head });
  assert.deepEqual(result, { hold: false, attention: false, records: [] });
  assert.equal(f.store.hookEvents().length, 0);
});

test('a successful pre-dispatch retry clears only its recorded task hold', () => {
  const record = { event: 'task.pre_dispatch', state: 'result' } as any;
  const held = { phase: 'needs_attention', reason: 'Repository hook lifecycle-gate task.pre_dispatch holds this transition: repair required' } as Task;
  assert.equal(isRecoveredPreDispatchHookHold(held, { hold: false, attention: false, records: [record] }), true);
  assert.equal(isRecoveredPreDispatchHookHold({ ...held, reason: 'Coordinator needs attention' }, { hold: false, attention: false, records: [record] }), false);
  assert.equal(isRecoveredPreDispatchHookHold(held, { hold: true, attention: true, records: [record] }), false);
  assert.equal(isRecoveredPreDispatchHookHold(held, { hold: false, attention: false, records: [{ ...record, event: 'task.closeout' }] }), false);
});

test('closed manifest validation rejects duplicate keys, unknown keys and forbidden bindings', async t => {
  assert.throws(() => parseManifestBytes(Buffer.from('{"schema":"paseo.queue.control.v1","hooks":[],"hooks":[]}')), /duplicate/i);
  assert.throws(() => parseManifestBytes(Buffer.from('{"schema":"paseo.queue.control.v1","hooks":[],"extra":1}')), /Unrecognized|invalid/i);
  assert.throws(() => parseManifestBytes(Buffer.from("schema: paseo.queue.control.v1\nhooks: []\n")), /not valid JSON/);
  assert.throws(() => parseManifestBytes(Buffer.from("{'schema':'paseo.queue.control.v1','hooks':[]}")), /not valid JSON/);
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ mode: 'integration_write', allowedPaths: [], commitSubject: { prefix: 'q', maxBytes: 40 } })] }), /pre_dispatch/);
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ allowedPaths: ['src/a.ts'] })] }), /allowed paths/);
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ events: ['task.blocked'], mode: 'integration_write', allowedPaths: ['src/'], commitSubject: null })] }), /commit subject/);
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ allowedPaths: ['.git/config'] }), manifestHook({ id: 'other', events: ['task.blocked'] })] }), /Reserved/);
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ allowedPaths: ['.paseo/'] }), manifestHook({ id: 'other', events: ['task.blocked'] })] }), /Reserved/);
  assert.throws(() => controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ allowedPaths: ['.git/'] }), manifestHook({ id: 'other', events: ['task.blocked'] })] }), /Reserved/);
  assert.throws(() => parseManifestBytes(Buffer.alloc(64 * 1024 + 1, 0x20)), /64 KiB/);
});

test('manifest allowed paths accept normalized tree prefixes as frozen by spec 001', () => {
  const write = { events: ['task.blocked'], mode: 'integration_write', commitSubject: { prefix: 'queue: hook', maxBytes: 60 } };
  for (const path of ['docs/', 'docs/nested/', 'src/a.ts', 'docs/README.md']) {
    const parsed = controlManifestSchema.parse({ schema: 'paseo.queue.control.v1', hooks: [manifestHook({ ...write, allowedPaths: [path] })] });
    assert.deepEqual(parsed.hooks[0].allowedPaths, [path]);
    assert.equal(normalizeAllowedPath(path), path);
  }
  for (const path of ['/docs/', 'docs//', 'docs/./', 'docs/../', '../docs/', 'docs/..', '', '/', 'docs']) {
    assert.equal(allowedPathSchema.safeParse(path).success, path === 'docs', `unexpected acceptance for ${JSON.stringify(path)}`);
  }
  assert.throws(() => normalizeRepoRelativePath('docs/'), /empty, dot or parent/);
  assert.equal(normalizeAllowedPath('docs/'), 'docs/');
});

test('instruction identity is immutable and regular-blob only', async t => {
  const f = await hooksFixture(t);
  const bytes = await git(f.repo, 'show', `${f.head}:docs/plan.json`);
  const artifact = instructionArtifactSchema.parse({ path: 'docs/plan.json', commit: f.head, digest: `sha256:${(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')}`, mediaType: 'application/json' });
  assert.deepEqual(await pinInstruction(f.repo, artifact), artifact);
  await assert.rejects(pinInstruction(f.repo, { ...artifact, digest: `sha256:${'0'.repeat(64)}` }), /digest/);
  await assert.rejects(pinInstruction(f.repo, { ...artifact, commit: 'b'.repeat(40) }));
  const changed = await commit(f.repo, 'changed', { 'docs/plan.json': { content: '{"task":"other"}' } });
  await assert.rejects(pinInstruction(f.repo, { ...artifact, commit: changed }), /digest/);
  await assert.rejects(pinInstruction(f.repo, { ...artifact, path: 'docs' }), /regular/);
  assert.throws(() => normalizeRepoRelativePath('../escape'), /parent/);
  assert.equal(blobDigest(Buffer.from('x')), 'sha256:' + (await import('node:crypto')).createHash('sha256').update('x').digest('hex'));
});

weighted(2)('generic instruction submission validates identity without parsing the document', async t => {
  const f = await hooksFixture(t);
  const bytes = await readFile(join(f.repo, 'docs/plan.json'));
  const instruction = instructionArtifactSchema.parse({ path: 'docs/plan.json', commit: f.head, digest: blobDigest(bytes), mediaType: 'application/json' });
  const submission = submissionSchema.parse({ submissionId: 'generic-1', title: 'Ledger', repoPath: f.repo, baseBranch: 'main', planningCommit: f.head, handoffPath: 'docs/plan.json', instruction, originAgentId: 'origin' });
  assert.deepEqual((await validateSubmission(submission)).instruction, instruction);
  await assert.rejects(validateSubmission({ ...submission, instruction: { ...instruction, digest: `sha256:${'0'.repeat(64)}` } }), /digest/);
  // A legacy submission without the artifact still resolves the same immutable identity.
  const legacy = (await validateSubmission({ ...submission, instruction: null })).instruction!;
  assert.deepEqual({ path: legacy.path, commit: legacy.commit, digest: legacy.digest }, { path: instruction.path, commit: instruction.commit, digest: instruction.digest });
});

weighted(11)('read-only hook receives the event on stdin and preserves Git state', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  const result = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(result.hold, false);
  assert.equal(result.records[0].state, 'result');
  const ledgerLines = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0].hookId, 'ledger');
  assert.equal(ledgerLines[0].event, 'task.pre_dispatch');
  assert.deepEqual(ledgerLines[0].argv, []);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

/**
 * Run `body` with TMPDIR pointed at a private directory, so the baseline's
 * scratch index is observable in isolation from every other test in flight.
 */
async function withScratchTmpdir<T>(body: (scratchRoot: string) => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  const scratchRoot = await mkdtemp(join(tmpdir(), 'nsq-scratch-probe-'));
  process.env.TMPDIR = scratchRoot;
  try { return await body(scratchRoot); }
  finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

/** Make every directory under `root` read-only, returning what to restore. */
async function lockTree(root: string): Promise<Array<[string, number]>> {
  const saved: Array<[string, number]> = [];
  const walk = async (dir: string) => {
    saved.push([dir, (await stat(dir)).mode & 0o7777]);
    for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await walk(join(dir, entry.name));
  };
  await walk(root);
  for (const [dir] of saved) await chmod(dir, 0o555);
  return saved;
}

async function restoreTree(saved: Array<[string, number]>) { for (const [dir, mode] of saved) await chmod(dir, mode); }

weighted(11)('a baseline snapshots the staged index while the shared index lock is held', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl')), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hooks = new RepositoryHooks(store);
  const unlocked = await snapshotGit(repo);
  // A held lock is what a concurrent baseline or lane integration write leaves
  // behind; the snapshot must not need it.
  const lock = join(repo, '.git', 'index.lock');
  await writeFile(lock, '');
  try {
    const held = await snapshotGit(repo);
    assert.equal(held.indexTree, unlocked.indexTree, 'a held shared index lock must not change the baseline tree');
    assert.equal(held.head, unlocked.head);
    assert.equal(held.status, unlocked.status);
    assert.equal(await readFile(lock, 'utf8'), '', 'the baseline must not disturb a foreign index lock');
    const result = await hooks.emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
    assert.equal(result.hold, false, result.records[0]?.error);
    assert.equal(result.records[0].state, 'result');
  } finally { await rm(lock, { force: true }); }
});

test('concurrent baselines against one repository all succeed and agree', async t => {
  const { repo } = await makeRepo(t);
  const head = await commit(repo, 'base', { 'docs/plan.json': { content: '{}' } });
  await push(repo);
  const lock = join(repo, '.git', 'index.lock');
  await writeFile(lock, '');
  try {
    const snapshots = await Promise.all(Array.from({ length: 5 }, () => snapshotGit(repo)));
    for (const snapshot of snapshots) {
      assert.equal(snapshot.head, head);
      assert.equal(snapshot.indexTree, snapshots[0].indexTree, 'concurrent baselines must agree on the index tree');
      assert.equal(snapshot.status, snapshots[0].status);
    }
  } finally { await rm(lock, { force: true }); }
});

test('a staged uncommitted change still changes the recorded index tree', async t => {
  const { repo } = await makeRepo(t);
  const head = await commit(repo, 'base', { 'docs/plan.json': { content: '{}' } });
  await push(repo);
  const clean = await snapshotGit(repo);
  await writeFile(join(repo, 'staged.txt'), 'staged\n');
  await git(repo, 'add', 'staged.txt');
  const staged = await snapshotGit(repo);
  assert.notEqual(staged.indexTree, clean.indexTree, 'a staged change must still move the recorded index tree');
  assert.equal(staged.head, head, 'a staged change must not move HEAD');
  assert.equal(clean.status, '');
  assert.equal(staged.status, 'A  staged.txt');
});

test('a read-only hook that stages is still refused by the baseline comparison', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl'), { extra: `fs.writeFileSync('staged.txt','x');require('child_process').execSync('git add staged.txt');` }), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hooks = new RepositoryHooks(store);
  const result = await hooks.emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(result.hold, true);
  assert.equal(result.attention, true);
  assert.equal(result.records[0].state, 'uncertain');
  assert.match(result.records[0].error ?? '', /changed HEAD, index or worktree/);
});

weighted(7)('a read-only hook that commits is still refused by the baseline comparison', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl'), { extra: `fs.writeFileSync('committed.txt','x');require('child_process').execSync('git add committed.txt && git commit -m mutation');` }), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const result = await new RepositoryHooks(store).emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(result.hold, true);
  assert.equal(result.attention, true);
  assert.equal(result.records[0].state, 'uncertain');
  assert.match(result.records[0].error ?? '', /changed HEAD, index or worktree/);
});

weighted(2)('an unavailable after-snapshot is distinct from a read-only mutation', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl')), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  let snapshots = 0;
  const hooks = new RepositoryHooks(store, { snapshot: async root => {
    if (++snapshots === 1) return snapshotGit(root);
    throw new Error('comparison unavailable');
  } });
  const result = await hooks.emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(result.hold, true);
  assert.equal(result.attention, true);
  assert.equal(result.records[0].state, 'uncertain');
  assert.match(result.records[0].error ?? '', /mutation comparison unavailable/);
  assert.doesNotMatch(result.records[0].error ?? '', /changed HEAD, index or worktree/);
});

test('the baseline leaves the shared index untouched and keeps no scratch residue', async t => {
  const { repo } = await makeRepo(t);
  await commit(repo, 'base', { 'docs/plan.json': { content: '{}' } });
  await push(repo);
  const index = join(repo, '.git', 'index');
  await withScratchTmpdir(async scratchRoot => {
    const before = await readFile(index);
    await snapshotGit(repo);
    assert.deepEqual(await readFile(index), before, 'a successful baseline must not rewrite the shared index');
    assert.deepEqual(await readdir(scratchRoot), [], 'a successful baseline must remove its scratch index');
    assert.deepEqual((await readdir(repo)).filter(entry => entry.startsWith(SCRATCH_INDEX_PREFIX)), [], 'no scratch index may sit in the checkout');
    assert.deepEqual((await readdir(join(repo, '.git'))).filter(entry => entry.startsWith(SCRATCH_INDEX_PREFIX)), [], 'no scratch index may sit beside the shared index');
    // A failure after the copy must clean up just as reliably. Staging a fresh
    // file makes `write-tree` write a new object, which the locked object
    // database refuses.
    await writeFile(join(repo, 'staged.txt'), 'staged\n');
    await git(repo, 'add', 'staged.txt');
    const staged = await readFile(index);
    const locked = await lockTree(join(repo, '.git', 'objects'));
    try { await assert.rejects(() => snapshotGit(repo), /write-tree/); }
    finally { await restoreTree(locked); }
    assert.deepEqual(await readFile(index), staged, 'a failed baseline must not rewrite the shared index');
    assert.deepEqual(await readdir(scratchRoot), [], 'a failed baseline must remove its scratch index');
    assert.equal(existsSync(join(repo, '.git', 'index.lock')), false, 'the baseline must leave no index lock behind');
  });
});

test('hostile event data never reaches executable or argv', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ argv: ['--literal', 'plain'] })]) },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\n', mode: 0o755 },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  let captured: { executable: string; argv: string[]; stdin: Buffer } | null = null;
  const hooks = new RepositoryHooks(store, { run: async request => {
    captured = { executable: request.executable, argv: request.argv, stdin: request.stdin };
    const payload = JSON.parse(request.stdin.toString('utf8'));
    return { pid: 1, code: 0, signal: null, timedOut: false, stdoutExceeded: false, stderrExceeded: false, durationMs: 1, stdout: Buffer.from(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId: payload.eventId, outcome: 'ok', summary: 'ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null })), stderr: Buffer.alloc(0) };
  } });
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: '"; rm -rf / #', repoPath: repo, planningCommit: 'a'.repeat(40), handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  const result = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head, summary: '$(touch /tmp/pwned)' });
  assert.equal(result.hold, false);
  assert.deepEqual(captured!.argv, ['--literal', 'plain']);
  assert.equal(captured!.executable, join(repo, '.paseo/hooks/ledger'));
  assert.equal(JSON.parse(captured!.stdin.toString('utf8')).task.title, '"; rm -rf / #');
});

weighted(2)('read-only hook that mutates the worktree enters attention without restoring bytes', async t => {
  const { root, repo } = await makeRepo(t);
  const marker = join(root, 'mutated-once');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl'), { extra: `if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'x');fs.writeFileSync('mutated.txt','x');}` }), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  const result = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(result.hold, true);
  assert.equal(result.attention, true);
  assert.equal(result.records[0].state, 'uncertain');
  assert.equal(await readFile(join(repo, 'mutated.txt'), 'utf8'), 'x');
  await rm(join(repo, 'mutated.txt'));
  const retried = await hooks.retry(task, result.records[0].id);
  assert.equal(retried.hold, false);
  assert.equal(retried.records[0].state, 'result');
  assert.equal(retried.records[0].attempt, 2);
  assert.ok(store.events(task.id).some(event => event.kind === 'hook_read_only_recovered'));
});

weighted(14)('required failure holds the transition; advisory failure advances on a clean repository', async t => {
  const make = async (delivery: string) => {
    const { root, repo } = await makeRepo(t);
    const head = await commit(repo, 'base', {
      '.paseo/queue.json': { content: manifest([manifestHook({ delivery })]) },
      '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl'), { outcome: 'blocked', summary: 'policy says no' }), mode: 0o755 },
      'docs/plan.json': { content: '{}' },
    });
    await push(repo);
    const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new Store(join(dir, 'queue.sqlite'));
    const hooks = new RepositoryHooks(store);
    return hooks.emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
  };
  const required = await make('required');
  assert.equal(required.hold, true);
  assert.equal(required.records[0].state, 'blocked');
  const advisory = await make('advisory');
  assert.equal(advisory.hold, false, 'an advisory failure advances when the repository is proven clean');
  assert.equal(advisory.records[0].state, 'failed');
});

test('a missing advisory tool records failure without holding', async t => {
  const name = `nucleus-missing-${randomUUID()}`;
  const hook = { id: 'tool', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'advisory', program: { kind: 'tool', name, argv: [] }, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null };
  const f = await hooksFixture(t, { '.paseo/queue.json': { content: JSON.stringify({ schema: 'paseo.queue.control.v2', hooks: [hook] }) } });
  t.after(() => f.store.close());
  const result = await f.hooks.emit('task.pre_dispatch', f.task(), { event: 'task.pre_dispatch', baseCommit: f.head });
  assert.equal(result.hold, false);
  assert.equal(result.records[0].state, 'failed');
  assert.equal(result.records[0].error, `${name} not found on Nucleus's PATH`);
});

test('a held required failure is not re-emitted until it is explicitly retried', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger, { outcome: 'blocked', summary: 'policy refused' }), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  const first = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(first.hold, true);
  const second = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(second.hold, true);
  assert.equal(second.records[0].eventId, first.records[0].eventId);
  assert.equal(store.hookEvents(task.id).length, 1);
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 1);
});

weighted(4)('timeout and output limit terminate execution and never accept partial output', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ timeoutMs: 300, maxOutputBytes: 1024 })]) },
    '.paseo/hooks/ledger': { content: `#!/usr/bin/env node\nsetInterval(()=>{},1000);\n`, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const timeout = await new RepositoryHooks(store).emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(timeout.hold, true);
  assert.match(timeout.records[0].error, /timeout/);

  const { root: root2, repo: repo2 } = await makeRepo(t);
  const head2 = await commit(repo2, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ maxOutputBytes: 1024 })]) },
    '.paseo/hooks/ledger': { content: `#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(2048));\n`, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo2);
  const dir2 = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir2, { recursive: true, force: true }));
  const store2 = new Store(join(dir2, 'queue.sqlite'));
  const breach = await new RepositoryHooks(store2).emit('task.pre_dispatch', taskFor(store2, repo2), { event: 'task.pre_dispatch', baseCommit: head2 });
  assert.equal(breach.hold, true);
  assert.match(breach.records[0].error, /output limit/);
});

test('result parsing rejects extra stdout, wrong event IDs and malformed metadata', async t => {
  const eventId = 'event-1';
  const good = Buffer.from(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'ok', summary: 'ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null }));
  assert.deepEqual(parseHookResult(good, eventId), { result: { schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'ok', summary: 'ok', metadata: {}, changedPaths: [], commitSubjectSuffix: null } });
  assert.match((parseHookResult(Buffer.concat([good, Buffer.from(' trailing')]), eventId) as { error: string }).error, /extra bytes/);
  assert.match((parseHookResult(good, 'other') as { error: string }).error, /event ID/);
  assert.match((parseHookResult(Buffer.from('not json'), eventId) as { error: string }).error, /valid JSON/);
  const unsorted = Buffer.from(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'ok', summary: 'ok', metadata: {}, changedPaths: ['b', 'a'], commitSubjectSuffix: null }));
  assert.match((parseHookResult(unsorted, eventId) as { error: string }).error, /sorted/);
});

weighted(7)('integration write publishes exactly the declared paths and verifies the remote', async t => {
  const { root, repo } = await makeRepo(t);
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',JSON.stringify({task:event.task.title,event:event.event}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'ledger updated',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'record ledger'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })]) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = taskFor(store, repo);
  const result = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, false);
  assert.equal(result.records[0].state, 'published');
  const commitSha = result.records[0].commit!;
  assert.match(commitSha, /^[a-f0-9]{40}$/);
  const subject = await git(repo, 'show', '-s', '--format=%s', commitSha);
  assert.match(subject, /^queue: hook/);
  const body = await git(repo, 'show', '-s', '--format=%B', commitSha);
  assert.match(body, /Northstar-Queue-Hook: /);
  assert.match(body, /Northstar-Queue-Manifest: \.paseo\/queue\.json@sha256:/);
  assert.equal(await git(repo, 'rev-parse', `refs/remotes/origin/main`), commitSha);
  const changed = await git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', commitSha);
  assert.deepEqual(changed.split('\n').filter(Boolean), ['docs/ledger.json']);
});

weighted(27)('undeclared, staged and symlinked changes are refused with attention', async t => {
  const cases: Record<string, { setup?: string; expected: RegExp }> = {
    undeclared: { setup: "fs.writeFileSync('docs/other.json','{}');", expected: /allowed|differ/ },
    staged: { setup: "fs.writeFileSync('docs/ledger.json','{}');require('child_process').execFileSync('git',['add','docs/ledger.json']);", expected: /staged/ },
    symlink: { setup: "fs.symlinkSync('plan.json','docs/ledger.json');", expected: /regular file/ },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const { root, repo } = await makeRepo(t);
    const script = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
${spec.setup}
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'wrote',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:null}));});`;
    const head = await commit(repo, 'base', {
      '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })]) },
      '.paseo/hooks/ledger': { content: script, mode: 0o755 },
      'docs/plan.json': { content: '{}' },
      '.gitignore': { content: 'ignored.tmp\n' },
    });
    await push(repo);
    const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new Store(join(dir, 'queue.sqlite'));
    const result = await new RepositoryHooks(store).emit('task.closeout', taskFor(store, repo), { event: 'task.closeout', baseCommit: head });
    assert.equal(result.hold, true, `${name} must hold`);
    assert.equal(result.records[0].state, 'uncertain', `${name}: ${result.records[0].error}`);
    assert.match(result.records[0].error, spec.expected, name);
  }
});

weighted(5)('an integration write may publish under a declared tree prefix', async t => {
  const { root, repo } = await makeRepo(t);
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.mkdirSync('docs/nested',{recursive:true});fs.writeFileSync('docs/nested/ledger.json',JSON.stringify({event:event.event}));
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'nested ledger',metadata:{},changedPaths:['docs/nested/ledger.json'],commitSubjectSuffix:'nested'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })]) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const result = await new RepositoryHooks(store).emit('task.closeout', taskFor(store, repo), { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, false);
  assert.equal(result.records[0].state, 'published');
  const changed = await git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.records[0].commit!);
  assert.deepEqual(changed.split('\n').filter(Boolean), ['docs/nested/ledger.json']);
});

weighted(2)('an integration write publishes only the declared file and never the ignored runtime receipt', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'receipt-ledger.jsonl');
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.mkdirSync('.runtime',{recursive:true});fs.writeFileSync('.runtime/receipt.json',JSON.stringify({eventId:event.eventId}));
fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/ledger.json',JSON.stringify({eventId:event.eventId}));
fs.appendFileSync(${JSON.stringify(ledger)}, event.repository.root+'\\n');
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'declared file written',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })]) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: '.runtime/\n' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const result = await new RepositoryHooks(store).emit('task.closeout', taskFor(store, repo), { event: 'task.closeout', baseCommit: head });
  assert.equal(result.hold, false, result.records[0].error);
  const record = result.records[0];
  assert.equal(record.state, 'published');
  const changed = await git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', record.commit!);
  assert.deepEqual(changed.split('\n').filter(Boolean), ['docs/ledger.json']);
  assert.equal(await git(repo, 'rev-parse', 'refs/remotes/origin/main'), record.commit);
  assert.equal(existsSync(join(repo, '.runtime/receipt.json')), false, 'the receipt never reaches the canonical checkout');
  const published = await git(repo, 'cat-file', '-p', `${record.commit}:.runtime/receipt.json`).catch(() => null);
  assert.equal(published, null, 'the ignored receipt is absent from published history');
  const workspace = (await readFile(ledger, 'utf8')).trim();
  assert.notEqual(workspace, repo);
  assert.equal(existsSync(workspace), false, 'the disposable checkout is removed after publication');
});

weighted(2)('a read-only hook may update an ignored runtime receipt without holding the transition', async t => {
  const { root, repo } = await makeRepo(t);
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(join(root, 'ledger.jsonl'), { extra: "fs.mkdirSync('.runtime',{recursive:true});fs.writeFileSync('.runtime/receipt.json','x');" }), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
    '.gitignore': { content: '.runtime/\n' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = taskFor(store, repo);
  const result = await new RepositoryHooks(store).emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(result.hold, false);
  assert.equal(result.records[0].state, 'result');
  assert.equal(existsSync(join(repo, '.runtime/receipt.json')), true, 'Queue never cleans canonical read-only mutation');
  assert.equal(store.events(task.id).some(event => event.kind === 'hook_read_only_mutation'), false);
});

test('inspectChangedPaths reports actual paths and rejects forbidden classes', async t => {
  const { repo } = await makeRepo(t);
  const head = await commit(repo, 'base', { 'a.txt': { content: 'a' }, 'docs/base.txt': { content: 'base' }, '.gitignore': { content: '' } });
  await writeFile(join(repo, 'a.txt'), 'changed');
  await writeFile(join(repo, 'b.txt'), 'new');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs', 'new.txt'), 'new');
  const inspection = await inspectChangedPaths(repo, ['a.txt', 'b.txt', 'docs/new.txt'], ['a.txt', 'b.txt', 'docs/']);
  assert.deepEqual(inspection.paths, ['a.txt', 'b.txt', 'docs/new.txt']);
  assert.deepEqual(inspection.extra, []);
  await assert.rejects(inspectChangedPaths(repo, ['a.txt'], ['a.txt']), /not declared as allowed/);
  await writeFile(join(repo, '.gitignore'), 'ignored\n');
  await writeFile(join(repo, 'ignored'), 'ignored');
  assert.equal((await statusEntries(repo)).some(entry => entry.path === 'ignored' && entry.ignored), true);
  assert.equal((await statusEntries(repo, false)).some(entry => entry.path === 'ignored'), false, 'clean-base scans do not enumerate ignored trees');
  await assert.rejects(inspectChangedPaths(repo, ['a.txt', 'b.txt', 'docs/new.txt', '.gitignore', 'ignored'], ['a.txt', 'b.txt', 'docs/', '.gitignore', 'ignored']), /Ignored/);
  const runtime = await inspectChangedPaths(repo, ['a.txt', 'b.txt', 'docs/new.txt', '.gitignore'], ['a.txt', 'b.txt', 'docs/', '.gitignore'], { ignored: 'runtime' });
  assert.equal(runtime.paths.includes('ignored'), false, 'ignored runtime material stays outside an integration-write change set');
  await rm(join(repo, 'ignored'), { force: true });
  await git(repo, 'checkout', '--', 'a.txt', '.gitignore');
  await rm(join(repo, 'b.txt'), { force: true });
  await rm(join(repo, 'docs', 'new.txt'), { force: true });
  await rm(join(repo, 'a.txt'), { force: true });
  const deleted = await inspectChangedPaths(repo, ['a.txt'], ['a.txt']);
  assert.deepEqual(deleted.paths, ['a.txt']);
  assert.equal(head, await git(repo, 'rev-parse', 'HEAD'));
});

weighted(4)('restart reconciliation adopts one exact commit and push, and refuses ambiguity', async t => {
  const { root, repo } = await makeRepo(t);
  const script = `#!/usr/bin/env node
const fs=require('fs');let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
fs.writeFileSync('docs/ledger.json',fs.existsSync('docs/ledger.json')?'second':'first');
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'ledger',metadata:{},changedPaths:['docs/ledger.json'],commitSubjectSuffix:'ledger'}));});`;
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })]) },
    '.paseo/hooks/ledger': { content: script, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = taskFor(store, repo);
  const result = await new RepositoryHooks(store).emit('task.closeout', task, { event: 'task.closeout', baseCommit: head });
  const published = result.records[0];
  assert.equal(published.state, 'published');

  // A fresh store cannot see the first record but can adopt the pushed commit from local history.
  const dir2 = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir2, { recursive: true, force: true }));
  const store2 = new Store(join(dir2, 'queue.sqlite'));
  const task2 = taskFor(store2, repo);
  const record = { ...published, id: randomUUID(), taskId: task2.id, state: 'push_intent' as const, commit: published.commit, result: published.result };
  store2.putHookEvent(record);
  const hooks2 = new RepositoryHooks(store2);
  const reconciled = await hooks2.reconcile(store2.hookEvent(record.id)!);
  assert.equal(reconciled.state, 'published');
  assert.equal(reconciled.commit, published.commit);

  // Two matching commits are ambiguous and stay in attention.
  await writeFile(join(repo, 'docs/ledger.json'), 'duplicate');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'duplicate commit', '-m', `Northstar-Queue-Hook: ${record.eventId}\nNorthstar-Queue-Manifest: ${record.manifest.path}@${record.manifest.digest}\nNorthstar-Queue-Event: task.closeout`);
  const dir3 = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir3, { recursive: true, force: true }));
  const store3 = new Store(join(dir3, 'queue.sqlite'));
  const task3 = taskFor(store3, repo);
  const ambiguous = { ...record, id: randomUUID(), taskId: task3.id, state: 'commit_intent' as const };
  store3.putHookEvent(ambiguous);
  const reconciledAmbiguous = await new RepositoryHooks(store3).reconcile(store3.hookEvent(ambiguous.id)!);
  assert.equal(reconciledAmbiguous.state, 'uncertain');
  assert.match(reconciledAmbiguous.error, /Multiple/);
});

test('intent and dead-runner records resume only after clean-state reconciliation', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'ledger.jsonl');
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await push(repo);
  const dir = await mkdtemp(join(tmpdir(), 'nsq-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  // Capture the durable intent without executing it, then restart reconciliation.
  await (hooks as any).intent(task, controlManifestSchema.parse(JSON.parse(manifest([manifestHook()]))).hooks[0], await discoverManifest(repo, head), { event: 'task.pre_dispatch', baseCommit: head });
  assert.equal(store.hookEvents(task.id)[0].state, 'intent');
  const resumed = await hooks.reconcileTask(task);
  assert.equal(resumed.hold, false);
  assert.equal(store.hookEvents(task.id)[0].state, 'result');
  assert.equal((await readFile(ledger, 'utf8')).trim().split('\n').length, 1);

  // A running record with a dead pid and clean tree returns to intent, not a blind retry.
  const dead = { ...store.hookEvents(task.id)[0], id: randomUUID(), eventId: randomUUID().slice(0, 24), state: 'running' as const, processId: 999999, attempt: 1, occurrence: 2 };
  store.putHookEvent(dead);
  const reconciled = await hooks.reconcile(store.hookEvent(dead.id)!);
  assert.equal(reconciled.state, 'intent');
});

test('commit subject join enforces the manifest byte budget and control bytes', () => {
  assert.equal(joinCommitSubject({ prefix: 'queue: hook', maxBytes: 60 }, 'ledger'), 'queue: hook ledger');
  assert.equal(joinCommitSubject({ prefix: 'queue: hook ', maxBytes: 60 }, 'ledger'), 'queue: hook ledger');
  assert.throws(() => joinCommitSubject({ prefix: 'queue', maxBytes: 20 }, 'x'.repeat(30)), /budget/);
  assert.throws(() => joinCommitSubject({ prefix: 'queue', maxBytes: 60 }, 'bad\nline'), /control/);
});

test('porcelain parsing keeps ignored and rename path identity', () => {
  const buf = Buffer.from(' M a.txt\0?? b.txt\0!! ignored\0R  old.txt\0new.txt\0');
  const entries = parsePorcelain(buf);
  assert.deepEqual(entries.map(entry => [entry.index, entry.worktree, entry.path, entry.ignored]), [
    [' ', 'M', 'a.txt', false], ['?', '?', 'b.txt', false], ['!', '!', 'ignored', true], ['R', ' ', 'old.txt', false],
  ]);
});

test('bounded status inventory reports ignored branch boundaries beside every non-ignored untracked leaf', async t => {
  const { repo } = await makeRepo(t);
  await commit(repo, 'base', {
    '.gitignore': { content: 'evidence/\n.cache/\nreceipt.tmp\n' },
    'docs/base.txt': { content: 'base' },
  });
  await mkdir(join(repo, 'evidence/nested/deeper'), { recursive: true });
  for (let index = 0; index < 40; index++) await writeFile(join(repo, `evidence/nested/deeper/leaf-${index}.bin`), `leaf ${index}`);
  await mkdir(join(repo, '.cache/pkg'), { recursive: true });
  await writeFile(join(repo, '.cache/pkg/blob'), 'cache');
  await writeFile(join(repo, 'receipt.tmp'), 'ignored file');
  await writeFile(join(repo, 'notes.txt'), 'non-ignored untracked leaf');
  await writeFile(join(repo, '.DS_Store'), 'finder metadata');
  await writeFile(join(repo, 'docs/.localized'), 'finder metadata');
  await writeFile(join(repo, '._notes.txt'), 'appledouble metadata');
  await writeFile(join(repo, 'docs/._base.txt'), 'appledouble metadata');
  await mkdir(join(repo, 'docs/new'), { recursive: true });
  await writeFile(join(repo, 'docs/new/leaf.txt'), 'non-ignored nested untracked leaf');

  const bounded = await statusEntries(repo);
  assert.deepEqual(bounded.filter(entry => entry.ignored).map(entry => entry.path).sort(), ['.cache/', 'evidence/', 'receipt.tmp']);
  assert.deepEqual(bounded.filter(entry => !entry.ignored).map(entry => entry.path).sort(), ['docs/new/leaf.txt', 'notes.txt']);
  const checkoutStatus = await queueCheckoutStatus(repo, 'status', '--porcelain', '--untracked-files=all');
  assert.doesNotMatch(checkoutStatus, /\.DS_Store|\.localized|\._/);
  assert.equal(bounded.some(entry => entry.path.includes('leaf-')), false, 'ignored leaves are never enumerated');

  // The traditional recursive listing enumerates every ignored leaf; matching
  // mode stays bounded while non-ignored discovery stays identical.
  const traditional = parsePorcelain((await gitRaw(repo, ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'])).stdout);
  assert.equal(traditional.filter(entry => entry.ignored).length, 42);
  assert.deepEqual(traditional.filter(entry => entry.path === '.DS_Store' || entry.path.includes('.localized') || entry.path.includes('._')).map(entry => entry.path).sort(), ['.DS_Store', '._notes.txt', 'docs/._base.txt', 'docs/.localized']);
  const signature = (entries: typeof bounded) => entries.filter(entry => !entry.ignored && !['.DS_Store'].includes(entry.path)
    && !entry.path.split('/').some(part => part === '.localized' || part.startsWith('._')))
    .map(entry => `${entry.index}${entry.worktree} ${entry.path}`).sort();
  assert.deepEqual(signature(bounded), signature(traditional), 'non-metadata non-ignored discovery is unchanged');
});

test('ignored branch entries reject equal, ancestor and descendant publication collisions', async t => {
  const { repo } = await makeRepo(t);
  await commit(repo, 'base', {
    '.gitignore': { content: 'ledger.json\nevidence/\n' },
    'docs/base.txt': { content: 'base' },
  });
  await writeFile(join(repo, 'ledger.json'), 'ignored file');
  await mkdir(join(repo, 'evidence/reports'), { recursive: true });
  await writeFile(join(repo, 'evidence/reports/leaf.bin'), 'ignored leaf');

  const ignored = (await statusEntries(repo)).filter(entry => entry.ignored).map(entry => entry.path);
  assert.deepEqual(ignored.sort(), ['evidence/', 'ledger.json']);
  assert.equal(ignoredPathCollides('ledger.json', 'ledger.json'), true, 'equal ignored file');
  assert.equal(ignoredPathCollides('evidence', 'evidence/'), true, 'path above an ignored branch');
  assert.equal(ignoredPathCollides('evidence/reports/ledger.json', 'evidence/'), true, 'path below an ignored branch');
  assert.equal(ignoredPathCollides('evidence', 'evidence'), true, 'branch boundary without a trailing slash');
  assert.equal(ignoredPathCollides('other.txt', 'evidence/'), false);
  assert.equal(ignoredPathCollides('evidentiary/report', 'evidence/'), false);
});

weighted(7)('executeHookProgram runs a regular executable directly with bounded output', async t => {
  const { repo } = await makeRepo(t);
  const script = join(repo, 'hook.js');
  await writeFile(script, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,argv:process.argv.slice(2)}));\n');
  await chmod(script, 0o755);
  const outcome: ExecutionOutcome = await executeHookProgram({ root: repo, executable: script, argv: ['a b', '--flag'], stdin: Buffer.from('{}'), timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 4096, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(outcome.code, 0);
  assert.deepEqual(JSON.parse(outcome.stdout.toString('utf8')).argv, ['a b', '--flag']);
});

async function assertProcessExited(pid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} survived process-group termination`);
}

test('timed-out steps terminate their verified process group gracefully, then escalate when needed', async () => {
  const graceful = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)\"],{stdio:'ignore'});
process.stdout.write(String(child.pid)+'\\n');
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);`;
  // Long enough for Node to start and install its handler on a busy host: a step
  // killed during startup dies of SIGTERM whatever its program would have done.
  const timeoutMs = 3_000;
  let identityProof: Promise<boolean> | null = null;
  const spawned: Array<{ pid: number; pgid: number; identity: string }> = [];
  const clean = await executeHookProgram({ root: process.cwd(), executable: process.execPath, argv: ['-e', graceful], stdin: Buffer.alloc(0),
    timeoutMs, terminationGraceMs: 500, maxOutputBytes: 4096, env: { PATH: process.env.PATH ?? '' },
    onSpawn: (pid, pgid, identity) => {
      if (!pgid || !identity) return;
      spawned.push({ pid, pgid, identity });
      // Not visible before the leader's exec, and `ps` can time out on a busy host.
      identityProof = (async () => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 40));
          if (processGroupHasStartIdentity(pgid, identity)) return true;
        }
        return false;
      })();
    } });
  assert.equal(identityProof && await identityProof, true, 'the recorded birth identity belongs to a live process in its process group');
  assert.equal(clean.processGroupId, clean.pid);
  assert.equal(clean.processGroupEmpty, true, String(clean.terminationError));
  assert.equal(clean.terminationSignal, 'SIGTERM');
  assert.ok(spawned[0] && spawned[0].pid === clean.pid && spawned[0].pgid === clean.processGroupId && spawned[0].identity === clean.leaderStartIdentity);
  const gracefulChild = Number(clean.stdout.toString('utf8').trim());
  assert.ok(Number.isInteger(gracefulChild) && gracefulChild > 0);
  await assertProcessExited(gracefulChild);

  const stubborn = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});
process.stdout.write(String(child.pid)+'\\n');
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);`;
  const killed = await executeHookProgram({ root: process.cwd(), executable: process.execPath, argv: ['-e', stubborn], stdin: Buffer.alloc(0),
    timeoutMs, terminationGraceMs: 100, maxOutputBytes: 4096, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(killed.processGroupId, killed.pid);
  assert.equal(killed.processGroupEmpty, true, String(killed.terminationError));
  assert.equal(killed.terminationSignal, 'SIGKILL');
  assert.equal(killed.signal, 'SIGKILL');
  const stubbornChild = Number(killed.stdout.toString('utf8').trim());
  assert.ok(Number.isInteger(stubbornChild) && stubbornChild > 0);
  await assertProcessExited(stubbornChild);
});

test('output overflow uses the same verified process-group termination path', async () => {
  const noisy = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)\"],{stdio:'ignore'});
process.stdout.write(String(child.pid)+'\\n');
setTimeout(()=>process.stdout.write('x'.repeat(4096)),100);
setInterval(()=>{},1000);`;
  const outcome = await executeHookProgram({ root: process.cwd(), executable: process.execPath, argv: ['-e', noisy], stdin: Buffer.alloc(0),
    timeoutMs: 5000, terminationGraceMs: 300, maxOutputBytes: 64, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(outcome.stdoutExceeded, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.processGroupId, outcome.pid);
  assert.equal(outcome.terminationSignal, 'SIGTERM');
  assert.equal(outcome.processGroupEmpty, true);
  const childPid = Number(outcome.stdout.toString('utf8').split('\n', 1)[0]);
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  await assertProcessExited(childPid);
});

weighted(5)('non-zero hook diagnostics carry a bounded stderr excerpt without changing timeout or output limits', async t => {
  const failing = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\nprocess.stderr.write("boom: detail\\n");process.exit(3);\n', mode: 0o755 },
  });
  const failed = await failing.hooks.emit('task.pre_dispatch', failing.task(), { event: 'task.pre_dispatch', baseCommit: failing.head });
  assert.equal(failed.records[0].state, 'blocked');
  assert.match(failed.records[0].error, /exited with code 3/);
  assert.match(failed.records[0].error, /boom: detail/);

  const long = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ maxOutputBytes: 262144 })]) },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\nprocess.stderr.write("e".repeat(40000));process.exit(1);\n', mode: 0o755 },
  });
  const truncated = await long.hooks.emit('task.pre_dispatch', long.task(), { event: 'task.pre_dispatch', baseCommit: long.head });
  assert.match(truncated.records[0].error, /\[truncated\]/);
  assert.ok(Buffer.byteLength(truncated.records[0].error, 'utf8') <= STDERR_EXCERPT_MAX_BYTES + 256, 'stored error must stay bounded');

  const slow = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ timeoutMs: 100 })]) },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\nprocess.stderr.write("hang detail");setInterval(()=>{},1000);\n', mode: 0o755 },
  });
  const timedOut = await slow.hooks.emit('task.pre_dispatch', slow.task(), { event: 'task.pre_dispatch', baseCommit: slow.head });
  assert.match(timedOut.records[0].error, /exceeded its 100ms timeout/);
  assert.doesNotMatch(timedOut.records[0].error, /hang detail/);

  const noisy = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ maxOutputBytes: 1024 })]) },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\nprocess.stderr.write("y".repeat(5000));process.exit(1);\n', mode: 0o755 },
  });
  const overflow = await noisy.hooks.emit('task.pre_dispatch', noisy.task(), { event: 'task.pre_dispatch', baseCommit: noisy.head });
  assert.match(overflow.records[0].error, /exceeded its 1024-byte output limit/);
  assert.doesNotMatch(overflow.records[0].error, /stderr:/);
});

weighted(5)('a zero wrapper exit keeps bounded stderr evidence for a failed, unusable or refused result', async t => {
  const structured = (outcome: string, summary: string, stderr: string) => `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stderr.write(${JSON.stringify(stderr)});
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:${JSON.stringify(outcome)},summary:${JSON.stringify(summary)},metadata:{},changedPaths:[],commitSubjectSuffix:null}));});`;
  const failure = (stderr: string) => `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(stderr)});`;

  // Exit 0 with a structured failure: the hook's own summary survives as the
  // summary, and stderr travels beside the wrapper exit that produced it.
  const failed = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: structured('failed', 'policy refused', 'boom: detail\n'), mode: 0o755 },
  });
  const refused = (await failed.hooks.emit('task.pre_dispatch', failed.task(), { event: 'task.pre_dispatch', baseCommit: failed.head })).records[0];
  assert.equal(refused.state, 'blocked');
  assert.equal(refused.summary, 'policy refused', 'the structured summary is preserved');
  assert.equal(refused.result?.outcome, 'failed');
  assert.match(refused.error, /^Hook exited with code 0 but reported outcome failed: policy refused; stderr: boom: detail$/);

  // A structured failure with no stderr makes no claim about stderr at all.
  const quiet = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: structured('blocked', 'waiting on an external contract', ''), mode: 0o755 },
  });
  const quietFailure = (await quiet.hooks.emit('task.pre_dispatch', quiet.task(), { event: 'task.pre_dispatch', baseCommit: quiet.head })).records[0];
  assert.equal(quietFailure.state, 'blocked');
  assert.equal(quietFailure.error, 'Hook exited with code 0 but reported outcome blocked: waiting on an external contract');
  assert.doesNotMatch(quietFailure.error, /stderr:/);

  // A zero-exit success is unchanged: stderr is not retained as failure evidence.
  const succeeding = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: structured('ok', 'policy passed', 'chatty but harmless\n'), mode: 0o755 },
  });
  const passed = (await succeeding.hooks.emit('task.pre_dispatch', succeeding.task(), { event: 'task.pre_dispatch', baseCommit: succeeding.head })).records[0];
  assert.equal(passed.state, 'result');
  assert.equal(passed.error, '');
  assert.equal(passed.summary, 'policy passed');

  // Empty and malformed results keep whatever the program wrote to stderr.
  const empty = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: failure('TypeError: cannot read properties of undefined\n'), mode: 0o755 },
  });
  const noResult = (await empty.hooks.emit('task.pre_dispatch', empty.task(), { event: 'task.pre_dispatch', baseCommit: empty.head })).records[0];
  assert.equal(noResult.state, 'blocked');
  assert.match(noResult.error, /^Hook exited with code 0 but produced no usable result: Hook produced no result on stdout; stderr: TypeError: cannot read/);

  const malformed = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\nprocess.stderr.write("crashed while writing the result");process.stdout.write("not json");\n', mode: 0o755 },
  });
  const badResult = (await malformed.hooks.emit('task.pre_dispatch', malformed.task(), { event: 'task.pre_dispatch', baseCommit: malformed.head })).records[0];
  assert.match(badResult.error, /produced no usable result: Hook result is not valid JSON/);
  assert.match(badResult.error, /stderr: crashed while writing the result$/);

  // Oversized multibyte stderr stays inside the existing excerpt and stored
  // error bounds and never leaves half a character behind.
  const long = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ maxOutputBytes: 262144 })]) },
    '.paseo/hooks/ledger': { content: structured('failed', 'refused', '𝄞é'.repeat(20000)), mode: 0o755 },
  });
  const truncated = (await long.hooks.emit('task.pre_dispatch', long.task(), { event: 'task.pre_dispatch', baseCommit: long.head })).records[0];
  assert.match(truncated.error, /reported outcome failed: refused; stderr: .*\[truncated\]$/);
  assert.ok(Buffer.byteLength(truncated.error, 'utf8') <= HOOK_EVIDENCE_MAX_BYTES + 256, 'stored evidence must stay bounded');
  assert.equal(truncated.error.includes('\ufffd'), false, 'the excerpt never splits a multibyte character');

  // The evidence is redacted by construction: a hook never receives Queue's own
  // credentials, so its stderr cannot carry them into the retained excerpt.
  const secret = 'sk-live-queue-operator-credential';
  const previous = process.env.QUEUE_TEST_HOOK_SECRET;
  process.env.QUEUE_TEST_HOOK_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.QUEUE_TEST_HOOK_SECRET; else process.env.QUEUE_TEST_HOOK_SECRET = previous; });
  const scrub = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: `#!/usr/bin/env node
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw);
process.stderr.write(process.env.QUEUE_TEST_HOOK_SECRET ? 'leaked ambient credential '+process.env.QUEUE_TEST_HOOK_SECRET : 'no ambient credential');
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'failed',summary:'refused',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});`, mode: 0o755 },
  });
  const scrubbed = (await scrub.hooks.emit('task.pre_dispatch', scrub.task(), { event: 'task.pre_dispatch', baseCommit: scrub.head })).records[0];
  assert.match(scrubbed.error, /stderr: no ambient credential$/);
  assert.equal(scrubbed.error.includes(secret), false);

  // An advisory failure still advances with the same evidence and no hold.
  const advisory = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ delivery: 'advisory' })]) },
    '.paseo/hooks/ledger': { content: structured('failed', 'advisory refusal', 'advisory detail'), mode: 0o755 },
  });
  const advisoryOutcome = await advisory.hooks.emit('task.pre_dispatch', advisory.task(), { event: 'task.pre_dispatch', baseCommit: advisory.head });
  assert.equal(advisoryOutcome.hold, false);
  assert.equal(advisoryOutcome.records[0].state, 'failed');
  assert.match(advisoryOutcome.records[0].error, /reported outcome failed: advisory refusal; stderr: advisory detail$/);

  // An integration write that exits zero with a refused result keeps the same
  // evidence, publishes nothing and stores the structured result.
  const write = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.closeout'], mode: 'integration_write', allowedPaths: ['docs/ledger.json'], commitSubject: { prefix: 'queue: hook', maxBytes: 80 } })]) },
    '.paseo/hooks/ledger': { content: structured('failed', 'ledger refused to publish', 'ledger: the projection is not durable'), mode: 0o755 },
    'docs/ledger.json': { content: '{}' },
  });
  const writeOutcome = await write.hooks.emit('task.closeout', write.task(), { event: 'task.closeout', baseCommit: write.head });
  assert.equal(writeOutcome.hold, true);
  assert.equal(writeOutcome.records[0].state, 'blocked');
  assert.equal(writeOutcome.records[0].result?.summary, 'ledger refused to publish');
  assert.match(writeOutcome.records[0].error, /^Hook exited with code 0 but reported outcome failed: ledger refused to publish; stderr: ledger: the projection is not durable$/);
  assert.equal(await git(write.repo, 'rev-parse', 'HEAD'), write.head, 'a refused integration write publishes nothing');
  assert.equal(await git(write.repo, 'rev-parse', 'refs/remotes/origin/main'), write.head);
});

weighted(9)('cancellation settlement uses the latest occurrence of every hook', async (t) => {
  const f = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook({ events: ['task.cancelled'] })]) },
    '.paseo/hooks/ledger': { content: ledgerScript('/dev/null'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = f.task();
  assert.equal(f.hooks.cancellationEmissionSettled(task.id), false);
  const result = await f.hooks.emit('task.cancelled', task, { event: 'task.cancelled', baseCommit: f.head });
  const first = result.records[0];
  f.store.putHookEvent({ ...first, state: 'failed' });
  assert.equal(f.hooks.cancellationEmissionSettled(task.id), false);
  f.store.putHookEvent({ ...first, id: randomUUID(), occurrence: 2, eventId: 'b'.repeat(48), state: 'published' });
  assert.equal(f.hooks.cancellationEmissionSettled(task.id), true);
  f.store.putHookEvent({ ...first, id: randomUUID(), hookId: 'other', eventId: 'c'.repeat(48), state: 'uncertain' });
  assert.equal(f.hooks.cancellationEmissionSettled(task.id), false, 'one settled hook cannot hide another uncertain publication');
});

weighted(7)('hook checkout reaper removes terminal leftovers and corpses, retaining warm and unresolved evidence', async (t) => {
  const { reapHookCheckouts } = await import('../core/hooks/hook-cleanup');
  const f = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript('/dev/null'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = f.task();
  const result = await f.hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: f.head });
  const seed = result.records[0];
  const root = isolationRootFor(isolationDataDirFor(f.store), await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  await mkdir(root, { recursive: true });
  const put = async (digit: string, state: typeof seed.state, owner = task, clone = false) => {
    const eventId = digit.repeat(48), path = join(root, eventId);
    if (clone) await command('git', ['clone', f.repo, path], f.root);
    else { await mkdir(path, { recursive: true }); await writeFile(join(path, 'evidence'), 'retained evidence'); }
    f.store.putHookEvent({ ...seed, id: randomUUID(), eventId, taskId: owner.id, mode: 'integration_write', target: 'integration_base', state, workspace: { path, head: f.head } });
    return path;
  };
  const corpse = await put('1', 'blocked');
  const clone = await put('2', 'blocked', task, true);
  const uncertain = await put('3', 'uncertain');
  const active = taskFor(f.store, f.repo, 'Active hook');
  const activeBlocked = await put('4', 'blocked', active);
  const warm = join(root, 'prospective-merge-warm');
  await mkdir(warm); await writeFile(join(warm, 'live'), 'warm candidate');
  const unknown = join(root, '5'.repeat(48)); await mkdir(unknown);
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'safe'), 'safe');
  const linked = join(root, '6'.repeat(48)); await symlink(outside, linked);
  f.store.putHookEvent({ ...seed, id: randomUUID(), eventId: '6'.repeat(48), mode: 'integration_write', target: 'integration_base', state: 'published', workspace: { path: linked, head: f.head } });
  const missing = taskFor(f.store, join(f.root, 'deleted-repo'));
  f.store.update(missing.id, { phase: 'done' });
  for (const digit of ['7', '8']) f.store.putHookEvent({ ...seed, id: randomUUID(), taskId: missing.id, eventId: digit.repeat(48), mode: 'integration_write', target: 'integration_base', state: 'published' });
  f.store.update(task.id, { phase: 'done' });
  const health = await reapHookCheckouts(f.store);
  assert.equal(health.unavailableRepositoryCount, 1);
  assert.equal(health.reapedCount, 2); assert.ok(health.reapedBytes > 0);
  assert.equal(existsSync(corpse), false); assert.equal(existsSync(clone), false);
  for (const path of [uncertain, activeBlocked, warm, unknown, linked, join(outside, 'safe')]) assert.equal(existsSync(path), true, path);
  assert.equal(health.errors.length, 1, 'symlink is refused');
  assert.equal((await reapHookCheckouts(f.store)).reapedCount, 0, 'cleanup is restart-idempotent');
});

test('hook checkout reaper keeps an isolation directory while its host run is unsettled', async t => {
  const { reapHookCheckouts } = await import('../core/hooks/hook-cleanup');
  const { isolationPathFor } = await import('../core/hooks/hooks');
  const { hostRunRecordSchema } = await import('../shared/contracts');
  const f = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript('/dev/null'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = f.task();
  const emitted = await f.hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: f.head });
  const seed = emitted.records[0];
  const eventId = 'a'.repeat(48);
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const dataDir = dirname(f.store.path);
  const checkout = isolationPathFor(dataDir, common, eventId);
  await mkdir(checkout, { recursive: true });
  const staleUnknown = isolationPathFor(dataDir, common, 'b'.repeat(48));
  const activeUnknown = isolationPathFor(dataDir, common, 'c'.repeat(48));
  const recentUnknown = isolationPathFor(dataDir, common, 'd'.repeat(48));
  for (const path of [staleUnknown, activeUnknown, recentUnknown]) await mkdir(path, { recursive: true });
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  await utimes(staleUnknown, old, old);
  f.store.update(task.id, { phase: 'done' });
  f.store.putHookEvent({ ...seed, id: randomUUID(), eventId, mode: 'integration_write', target: 'integration_base',
    state: 'published', workspace: { path: checkout, head: f.head } });
  const at = new Date().toISOString();
  const makeRun = (id: string, path: string) => hostRunRecordSchema.parse({
    id, epoch: 1, caller: 'interactive:test', repository: { origin: null, path },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'interactive', state: 'running',
    submittedAt: at, capacityDeadlineAt: at, runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 100_000_000 }, budget: { cpu: 1, memoryBytes: 100_000_000, wallMs: 60_000, source: 'fallback' },
    position: null, admittedAt: at, launchedAt: at, settledAt: null, capacitySample: null,
    pid: null, processGroupId: null, startIdentity: null, settlement: null, wallMs: null, cpuMs: null, containers: [],
    capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
  });
  const liveRun = f.store.putHostRun(makeRun('isolation-owner', checkout));
  const liveUnknownRun = f.store.putHostRun(makeRun('unowned-isolation-owner', activeUnknown));

  assert.equal((await reapHookCheckouts(f.store)).reapedCount, 1, 'an old ownerless checkout ages out');
  assert.equal(existsSync(checkout), true);
  assert.equal(existsSync(staleUnknown), false);
  assert.equal(existsSync(activeUnknown), true, 'an unsettled host run protects an otherwise unowned directory');
  assert.equal(existsSync(recentUnknown), true, 'an unowned directory younger than the bound stays');
  f.store.putHostRun({ ...liveRun, state: 'settled', settledAt: at, capacityReleasedAt: at,
    capacityReleaseReason: 'settled', capacityReleaseKind: 'automatic' });
  f.store.putHostRun({ ...liveUnknownRun, state: 'settled', settledAt: at, capacityReleasedAt: at,
    capacityReleaseReason: 'settled', capacityReleaseKind: 'automatic' });
  assert.equal((await reapHookCheckouts(f.store)).reapedCount, 2, 'settling releases the recorded and unowned checkouts');
  assert.equal(existsSync(checkout), false);
  assert.equal(existsSync(activeUnknown), false);
});

test('hook checkout reaper retains a candidate for an unrecorded project-validation result', async t => {
  const { reapHookCheckouts } = await import('../core/hooks/hook-cleanup');
  const f = await hooksFixture(t, {
    '.paseo/queue.json': { content: manifest([manifestHook()]) },
    '.paseo/hooks/ledger': { content: ledgerScript('/dev/null'), mode: 0o755 },
  });
  t.after(() => f.store.close());
  const task = f.task();
  const common = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const candidate = { integrationBase: f.head, reviewedHead: f.head, commit: f.head, tree: await git(f.repo, 'rev-parse', 'HEAD^{tree}') };
  const candidateId = digest(`prospective-merge\n${task.id}\n${candidate.integrationBase}\n${candidate.reviewedHead}`).slice(0, 48);
  const path = join(isolationRootFor(isolationDataDirFor(f.store), common), candidateId);
  await mkdir(join(path, '.git', 'logs'), { recursive: true });
  await writeFile(join(path, 'src.partial'), 'surviving candidate bytes');
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  await utimes(path, old, old);
  f.store.update(task.id, { resolution: { ...task.resolution, projectValidation: {
    argv: ['node', 'check'], digest: 'validation', exitCode: null, durationMs: 0, outputTail: '',
    base: f.head, head: f.head, candidate, state: 'running', queueBuild: '', settingsRevision: 0,
    pid: null, capacityWait: null, capacityUnavailable: false,
  } } });

  const health = await reapHookCheckouts(f.store);
  assert.equal(health.reapedCount, 0);
  assert.equal(existsSync(path), true, 'cleanup leaves the active validation candidate for result reconciliation');
});

test('a timed-out step whose leader is still running is signalled even when ps cannot prove identity', { timeout: 15_000 }, async t => {
  // Under load `ps` can time out, and before exec it cannot show the step's
  // environment. While the leader is Queue's own unreaped child its process
  // group id cannot be reused, so termination must not depend on that proof.
  const empty = await mkdtemp(join(tmpdir(), 'nsq-nops-'));
  const savedPath = process.env.PATH;
  process.env.PATH = empty;
  t.after(() => { process.env.PATH = savedPath; });
  const outcome = await executeHookProgram({ root: process.cwd(), executable: process.execPath, argv: ['-e', 'setInterval(()=>{},1000)'],
    stdin: Buffer.alloc(0), timeoutMs: 100, terminationGraceMs: 200, maxOutputBytes: 4096, env: {} });
  process.env.PATH = savedPath;
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.terminationSignal, 'SIGTERM');
  assert.equal(outcome.processGroupEmpty, true);
  assert.equal(outcome.terminationError, null);
});
