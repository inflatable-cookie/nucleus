import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { git, command } from '../core/git/index';
import { RepositoryHooks, discoverManifest, parseManifestBytes, minimalHookEnvironment } from '../core/hooks/hooks';
import { submissionSchema, type Task } from '../shared/contracts';
import {
  CONTROL_SCHEMA, CONTROL_SCHEMA_V7, NEUTRAL_CONTROL_SCHEMA, NEUTRAL_CONTROL_SCHEMA_V7,
  EVENT_SCHEMA, EVENT_SCHEMA_V2, EVENT_SCHEMA_V4, NEUTRAL_EVENT_SCHEMA, NEUTRAL_EVENT_SCHEMA_V4, RESULT_SCHEMA, NEUTRAL_RESULT_SCHEMA,
  LEGACY_HOOK_MANIFEST_PATH, NEUTRAL_HOOK_MANIFEST_PATH, canonicalWireName, controlManifestSchema,
  hookWireFamilyOfManifestPath, hookWireFamilyOfSchema, wireNameFor,
} from '../shared/hooks';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

/**
 * Both wire families, end to end: the committed manifest selects the family,
 * the delivered event and the hook's answer use that family's spelling, and a
 * pending occurrence keeps the spelling it was delivered in.
 */

const LEGACY_NAMES = [
  CONTROL_SCHEMA, 'paseo.queue.control.v2', 'paseo.queue.control.v3', 'paseo.queue.control.v4', 'paseo.queue.control.v5',
  'paseo.queue.control.v6', CONTROL_SCHEMA_V7, EVENT_SCHEMA, EVENT_SCHEMA_V2, 'paseo.queue.event.v3', EVENT_SCHEMA_V4, RESULT_SCHEMA,
];

async function makeRepo(t: { after(fn: () => unknown): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-wire-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  await command('git', ['clone', join(root, 'origin.git'), join(root, 'repo')], root);
  const repo = join(root, 'repo');
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  return { root, repo };
}

async function commit(repo: string, message: string, files: Record<string, { content: string; mode?: number }>) {
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

/** A read-only pre-dispatch hook at the given executable, in one wire family's manifest. */
function manifestFor(schema: string, executable: string) {
  return JSON.stringify({
    schema,
    hooks: [{
      id: 'ledger', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required',
      executable, argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null,
    }],
  }, null, 2);
}

/**
 * A JSON-ledger hook. It records its received event schema and every Queue
 * event variable it was launched with, then answers in `resultSchema`.
 */
function ledgerScript(ledgerPath: string, resultSchema: string, outcome = 'ok') {
  return `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  const queueEnv={};
  for (const key of Object.keys(process.env)) if (/_QUEUE_EVENT_/.test(key)) queueEnv[key]=process.env[key];
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({schema:event.schema,eventId:event.eventId,queueEnv})+'\\n');
  process.stdout.write(JSON.stringify({schema:${JSON.stringify(resultSchema)},eventId:event.eventId,outcome:${JSON.stringify(outcome)},summary:'ledger',metadata:{},changedPaths:[],commitSubjectSuffix:null}));
});
`;
}

async function readLedger(path: string) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line) as { schema: string; eventId: string; queueEnv: Record<string, string> }) : [];
}

function taskFor(store: Store, repo: string): Task {
  return store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Wire task', repoPath: repo, planningCommit: 'a'.repeat(40), handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
}

async function storeFor(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-wire-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(join(dir, 'queue.sqlite'));
}

test('wire names resolve to one legacy generation, in either family, and unknown names belong to neither', () => {
  for (const legacy of LEGACY_NAMES) {
    const neutral = wireNameFor('neutral', legacy);
    assert.ok(neutral.startsWith('nucleus.queue.'), neutral);
    assert.equal(neutral.slice('nucleus.queue.'.length), legacy.slice('paseo.queue.'.length));
    assert.equal(wireNameFor('legacy', legacy), legacy);
    assert.equal(canonicalWireName(neutral), legacy);
    assert.equal(canonicalWireName(legacy), legacy);
    assert.equal(hookWireFamilyOfSchema(neutral), 'neutral');
    assert.equal(hookWireFamilyOfSchema(legacy), 'legacy');
  }
  assert.equal(hookWireFamilyOfSchema('paseo.queue.event.v9'), null);
  assert.equal(hookWireFamilyOfSchema('constructor'), null);
  assert.equal(canonicalWireName('constructor'), 'constructor');
  assert.throws(() => wireNameFor('neutral', NEUTRAL_EVENT_SCHEMA), /Not a repository hook wire name/);
  assert.equal(hookWireFamilyOfManifestPath(LEGACY_HOOK_MANIFEST_PATH), 'legacy');
  assert.equal(hookWireFamilyOfManifestPath(NEUTRAL_HOOK_MANIFEST_PATH), 'neutral');
  assert.equal(hookWireFamilyOfManifestPath('.nucleus/state.json'), null);
});

test('the environment carries only the family the event was delivered in', () => {
  const legacy = minimalHookEnvironment('event-1', EVENT_SCHEMA);
  assert.equal(legacy.PASEO_QUEUE_EVENT_ID, 'event-1');
  assert.equal(legacy.PASEO_QUEUE_EVENT_SCHEMA, EVENT_SCHEMA);
  assert.equal(Object.keys(legacy).some(key => key.startsWith('NUCLEUS_QUEUE_')), false);
  const neutral = minimalHookEnvironment('event-2', NEUTRAL_EVENT_SCHEMA);
  assert.equal(neutral.NUCLEUS_QUEUE_EVENT_ID, 'event-2');
  assert.equal(neutral.NUCLEUS_QUEUE_EVENT_SCHEMA, NEUTRAL_EVENT_SCHEMA);
  assert.equal(Object.keys(neutral).some(key => key.startsWith('PASEO_QUEUE_')), false);
});

test('every generation accepts its neutral spelling, and a neutral manifest is only ever its own spelling', () => {
  const parsed = controlManifestSchema.parse({ schema: NEUTRAL_CONTROL_SCHEMA_V7, closeout: 'queue', hooks: [] });
  assert.equal(canonicalWireName(parsed.schema), CONTROL_SCHEMA_V7);
  assert.throws(() => controlManifestSchema.parse({ schema: NEUTRAL_CONTROL_SCHEMA, hooks: [], validation: { argv: ['x'] } }), /validation|Unrecognized/i);
  assert.throws(() => controlManifestSchema.parse({ schema: 'nucleus.queue.control.v9', hooks: [] }));
  assert.equal(controlManifestSchema.parse({ schema: NEUTRAL_CONTROL_SCHEMA, hooks: [] }).schema, NEUTRAL_CONTROL_SCHEMA);
});

test('a neutral manifest may not declare the legacy namespace or its own, but a legacy manifest keeps every path it already held', () => {
  const write = { events: ['task.closeout'], mode: 'integration_write', delivery: 'required', executable: 'x/hook', argv: [], timeoutMs: 1000, maxOutputBytes: 65536, commitSubject: { prefix: 'queue: hook', maxBytes: 80 } };
  const manifest = (schema: string, allowedPaths: string[]) => Buffer.from(JSON.stringify({ schema, hooks: [{ id: 'writer', ...write, allowedPaths }] }));
  for (const path of ['.paseo/', '.paseo/queue.json', '.paseo/hooks/x', '.nucleus', '.nucleus/', '.nucleus/queue.json', '.nucleus/hooks/', '.nucleus/hooks/x']) {
    assert.throws(() => parseManifestBytes(manifest(NEUTRAL_CONTROL_SCHEMA, [path])), /Reserved path/, path);
  }
  assert.throws(() => parseManifestBytes(manifest(CONTROL_SCHEMA, ['.paseo/hooks/x'])), /Reserved path/);
  // Historical manifests may name `.nucleus/` paths they already held: the neutral reservation is theirs alone.
  assert.equal(parseManifestBytes(manifest(CONTROL_SCHEMA, ['.nucleus/state.json'])).hooks[0].allowedPaths[0], '.nucleus/state.json');
  assert.equal(parseManifestBytes(manifest(NEUTRAL_CONTROL_SCHEMA, ['docs/ledger.json'])).hooks[0].allowedPaths[0], 'docs/ledger.json');
});

test('a legacy manifest is discovered at its committed path and keeps its legacy wire names', async t => {
  const { repo } = await makeRepo(t);
  const head = await commit(repo, 'legacy', {
    [LEGACY_HOOK_MANIFEST_PATH]: { content: manifestFor(CONTROL_SCHEMA, '.paseo/hooks/ledger') },
    '.paseo/hooks/ledger': { content: '#!/usr/bin/env node\n', mode: 0o755 },
  });
  const found = await discoverManifest(repo, head);
  assert.equal(found?.pin.path, LEGACY_HOOK_MANIFEST_PATH);
  assert.equal(found?.manifest.schema, CONTROL_SCHEMA);
});

test('a neutral manifest is discovered at its own path, and each location must declare its own family', async t => {
  const { repo } = await makeRepo(t);
  const neutral = await commit(repo, 'neutral', {
    [NEUTRAL_HOOK_MANIFEST_PATH]: { content: manifestFor(NEUTRAL_CONTROL_SCHEMA, '.nucleus/hooks/ledger') },
    '.nucleus/hooks/ledger': { content: '#!/usr/bin/env node\n', mode: 0o755 },
  });
  const found = await discoverManifest(repo, neutral);
  assert.equal(found?.pin.path, NEUTRAL_HOOK_MANIFEST_PATH);
  assert.equal(found?.manifest.schema, CONTROL_SCHEMA);
  // The neutral location with a legacy schema, and the legacy location with a neutral schema, are both refused.
  const mismatched = await commit(repo, 'mismatch', { [NEUTRAL_HOOK_MANIFEST_PATH]: { content: manifestFor(CONTROL_SCHEMA, '.nucleus/hooks/ledger') } });
  await assert.rejects(discoverManifest(repo, mismatched), /neutral manifest location and must declare neutral schema names/);
  // The legacy location with a neutral schema, in a repository that carries no neutral manifest.
  const { repo: legacyRepo } = await makeRepo(t);
  const crossed = await commit(legacyRepo, 'legacy location, neutral schema', {
    [LEGACY_HOOK_MANIFEST_PATH]: { content: manifestFor(NEUTRAL_CONTROL_SCHEMA, '.paseo/hooks/ledger') },
  });
  await assert.rejects(discoverManifest(legacyRepo, crossed), /legacy manifest location and must declare legacy schema names/);
});

test('a commit that carries both manifest locations is refused rather than resolved by precedence', async t => {
  const { repo } = await makeRepo(t);
  const both = await commit(repo, 'both', {
    [LEGACY_HOOK_MANIFEST_PATH]: { content: manifestFor(CONTROL_SCHEMA, '.paseo/hooks/ledger') },
    [NEUTRAL_HOOK_MANIFEST_PATH]: { content: manifestFor(NEUTRAL_CONTROL_SCHEMA, '.nucleus/hooks/ledger') },
  });
  await assert.rejects(discoverManifest(repo, both), /both committed.*keep exactly one hook manifest/);
});

test('a read-only hook answers in its family: neutral events reach neutral hooks, legacy events reach legacy hooks', async t => {
  for (const family of ['legacy', 'neutral'] as const) {
    const { repo } = await makeRepo(t);
    const store = await storeFor(t);
    const dir = family === 'neutral' ? '.nucleus' : '.paseo';
    const manifestPath = family === 'neutral' ? NEUTRAL_HOOK_MANIFEST_PATH : LEGACY_HOOK_MANIFEST_PATH;
    const ledger = join(repo, '..', `${family}-ledger.jsonl`);
    const head = await commit(repo, family, {
      [manifestPath]: { content: manifestFor(family === 'neutral' ? NEUTRAL_CONTROL_SCHEMA : CONTROL_SCHEMA, `${dir}/hooks/ledger`) },
      [`${dir}/hooks/ledger`]: { content: ledgerScript(ledger, wireNameFor(family, RESULT_SCHEMA)), mode: 0o755 },
    });
    await git(repo, 'push', 'origin', 'main');
    const hooks = new RepositoryHooks(store);
    const result = await hooks.emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
    assert.equal(result.hold, false, family);
    const [record] = result.records;
    assert.equal(record.state, 'result', family);
    assert.equal(record.manifest.path, manifestPath);
    const expectedEvent = wireNameFor(family, EVENT_SCHEMA);
    assert.equal(record.eventPayload?.schema, expectedEvent);
    const [delivered] = await readLedger(ledger);
    assert.equal(delivered.schema, expectedEvent, family);
    const prefix = family === 'neutral' ? 'NUCLEUS_QUEUE' : 'PASEO_QUEUE';
    assert.deepEqual(Object.keys(delivered.queueEnv).sort(), [`${prefix}_EVENT_ID`, `${prefix}_EVENT_SCHEMA`].sort(), family);
    assert.equal(delivered.queueEnv[`${prefix}_EVENT_SCHEMA`], expectedEvent);
    assert.equal(delivered.queueEnv[`${prefix}_EVENT_ID`], delivered.eventId);
  }
});

test('a hook that answers in the other family fails its occurrence instead of being accepted', async t => {
  const { repo } = await makeRepo(t);
  const store = await storeFor(t);
  const ledger = join(repo, '..', 'crossed-ledger.jsonl');
  // A legacy manifest whose hook returns the neutral result spelling.
  const head = await commit(repo, 'crossed', {
    [LEGACY_HOOK_MANIFEST_PATH]: { content: manifestFor(CONTROL_SCHEMA, '.paseo/hooks/ledger') },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger, NEUTRAL_RESULT_SCHEMA), mode: 0o755 },
  });
  await git(repo, 'push', 'origin', 'main');
  const result = await new RepositoryHooks(store).emit('task.pre_dispatch', taskFor(store, repo), { event: 'task.pre_dispatch', baseCommit: head });
  // A required occurrence that cannot read a usable result holds as blocked, never accepted.
  assert.equal(result.records[0].state, 'blocked');
  assert.match(result.records[0].error, /schema is unsupported/);
});

test('a pending legacy occurrence keeps its recorded spelling after the repository moves to the neutral manifest', async t => {
  const { repo } = await makeRepo(t);
  const store = await storeFor(t);
  const ledger = join(repo, '..', 'pending-ledger.jsonl');
  // The gate refuses at the legacy base, leaving a pending required occurrence.
  const legacyBase = await commit(repo, 'legacy base', {
    [LEGACY_HOOK_MANIFEST_PATH]: { content: manifestFor(CONTROL_SCHEMA, '.paseo/hooks/ledger') },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger, RESULT_SCHEMA, 'failed'), mode: 0o755 },
  });
  await git(repo, 'push', 'origin', 'main');
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);
  const first = await hooks.emit('task.pre_dispatch', task, { event: 'task.pre_dispatch', baseCommit: legacyBase });
  const pending = first.records[0];
  assert.equal(pending.state, 'blocked');
  // The repository migrates: the neutral manifest replaces the legacy one, and the legacy hook file stays
  // until its pending occurrence settles, because a read-only retry runs the program from the checkout.
  await git(repo, 'rm', '-q', LEGACY_HOOK_MANIFEST_PATH);
  await commit(repo, 'migrate', {
    [NEUTRAL_HOOK_MANIFEST_PATH]: { content: manifestFor(NEUTRAL_CONTROL_SCHEMA, '.nucleus/hooks/ledger') },
    '.nucleus/hooks/ledger': { content: ledgerScript(ledger, NEUTRAL_RESULT_SCHEMA), mode: 0o755 },
  });
  await git(repo, 'push', 'origin', 'main');
  const migrated = await discoverManifest(repo, await git(repo, 'rev-parse', 'HEAD'));
  assert.equal(migrated?.pin.path, NEUTRAL_HOOK_MANIFEST_PATH);

  // Retrying the pending occurrence re-delivers its immutable legacy payload, never the neutral spelling.
  await hooks.retry(task, pending.id);
  const [, ...delivered] = (await readLedger(ledger));
  assert.ok(delivered.length >= 1, 'the pending occurrence is retried');
  for (const entry of delivered) assert.equal(entry.schema, EVENT_SCHEMA);
  const stored = store.hookEvent(pending.id)!;
  assert.equal(stored.manifest.path, LEGACY_HOOK_MANIFEST_PATH);
  assert.equal(stored.eventPayload?.schema, EVENT_SCHEMA);
  assert.equal(stored.eventPayload?.repository.baseCommit, legacyBase);
});

test('a neutral event carries the neutral v4 generation spelling, and its generation still resolves to v4', () => {
  assert.equal(canonicalWireName(NEUTRAL_EVENT_SCHEMA_V4), EVENT_SCHEMA_V4);
  assert.equal(canonicalWireName(NEUTRAL_EVENT_SCHEMA), EVENT_SCHEMA);
});

test('a pending legacy cancellation is never renewed in the neutral spelling when the base advances across the migration', async t => {
  const { root, repo } = await makeRepo(t);
  const ledger = join(root, 'cancel-ledger.jsonl');
  const cancellation = (schema: string, executable: string) => JSON.stringify({
    schema,
    hooks: [{
      id: 'ledger', events: ['task.cancelled'], mode: 'integration_write', delivery: 'required', executable, argv: [],
      timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/cancelled.json'],
      commitSubject: { prefix: 'queue: cancel', maxBytes: 80 },
    }],
  }, null, 2);
  const base = await commit(repo, 'base', {
    [LEGACY_HOOK_MANIFEST_PATH]: { content: cancellation(CONTROL_SCHEMA, '.paseo/hooks/ledger') },
    '.paseo/hooks/ledger': { content: ledgerScript(ledger, RESULT_SCHEMA), mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await git(repo, 'push', 'origin', 'main');
  const store = await storeFor(t);
  const hooks = new RepositoryHooks(store);
  const task = taskFor(store, repo);

  // A sibling migrates to the neutral manifest and advances main while the legacy occurrence waits.
  const sibling = join(root, 'sibling');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  await git(sibling, 'rm', '-q', LEGACY_HOOK_MANIFEST_PATH);
  const advanced = await commit(sibling, 'migrate and advance', {
    [NEUTRAL_HOOK_MANIFEST_PATH]: { content: cancellation(NEUTRAL_CONTROL_SCHEMA, '.nucleus/hooks/ledger') },
    '.nucleus/hooks/ledger': { content: ledgerScript(ledger, NEUTRAL_RESULT_SCHEMA), mode: 0o755 },
    'docs/current.json': { content: '{}' },
  });
  await git(sibling, 'push', 'origin', 'main');

  const first = await hooks.emit('task.cancelled', task, { event: 'task.cancelled', baseCommit: base, summary: 'Superseded by replacement' });
  assert.equal(first.hold, true);
  assert.match(first.records[0].error, /Local integration base differs from origin/);
  await git(repo, 'pull', '--ff-only', 'origin', 'main');

  await assert.rejects(
    hooks.emit('task.cancelled', task, { event: 'task.cancelled', baseCommit: advanced, summary: 'Superseded by replacement' }),
    /moved between wire families; the pending occurrence keeps its recorded spelling and is not replayed/,
  );
  const records = store.hookEvents(task.id);
  assert.equal(records.length, 1, 'no replacement occurrence is minted');
  assert.equal(records[0].manifest.path, LEGACY_HOOK_MANIFEST_PATH);
  assert.equal(records[0].eventPayload?.schema, EVENT_SCHEMA);
  assert.deepEqual(await readLedger(ledger), [], 'the pending occurrence is never delivered');
});
