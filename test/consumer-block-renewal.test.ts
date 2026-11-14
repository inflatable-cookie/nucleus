import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { CONSUMER_BLOCK_RENEWAL_LIMIT } from '../core/closeout/recovery';
import { git, command } from '../core/git/index';
import { RepositoryHooks } from '../core/hooks/hooks';
import { consumerBlockAdvance, isConsumerDeclaredBlock } from '../core/closeout/closeout-renewal';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

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

/** A closeout hook that refuses until the consumer commits `docs/state/ready`, and owns `docs/state/`. */
const gateScript = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw),root=event.repository.root;
const ready=fs.existsSync(path.join(root,'docs/state/ready'));
if(!ready){process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'blocked',summary:'closeout blocked: projection is not current',metadata:{},changedPaths:[],commitSubjectSuffix:null}));return;}
fs.writeFileSync(path.join(root,'docs/state/closed'),event.eventId);
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'closed',metadata:{},changedPaths:['docs/state/closed'],commitSubjectSuffix:'closed'}));});
`;

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-consumer-block-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  const repo = join(root, 'repo'), sibling = join(root, 'sibling');
  await command('git', ['clone', join(root, 'origin.git'), repo], root);
  for (const dir of [repo]) { await git(dir, 'config', 'user.name', 'Queue test'); await git(dir, 'config', 'user.email', 'queue@example.invalid'); }
  const head = await commit(repo, 'base', {
    '.paseo/queue.json': { content: JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'gate', events: ['task.closeout'], mode: 'integration_write',
      delivery: 'required', executable: '.paseo/hooks/gate', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/state/'],
      commitSubject: { prefix: 'queue: closeout', maxBytes: 80 } }] }) },
    '.paseo/hooks/gate': { content: gateScript, mode: 0o755 },
    'docs/plan.json': { content: '{}' },
  });
  await git(repo, 'push', 'origin', 'main');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Queue test'); await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  const push = async (label: string, path: string) => { const sha = await commit(sibling, label, { [path]: { content: label } }); await git(sibling, 'push', 'origin', 'main'); return sha; };
  const store = new Store(join(root, 'queue.sqlite'));
  store.setMeta('paused', false);
  const hooks = new RepositoryHooks(store);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Closeout', repoPath: repo, planningCommit: head,
    handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', head);
  let task = store.update(submitted.id, { phase: 'closing', resolution: { ...submitted.resolution, mergedCommit: head, syncedCommit: head, attention: true } });
  const emitted = await hooks.emit('task.closeout', task, { event: 'task.closeout', baseCommit: head, summary: 'closeout',
    delivery: { prUrl: null, prNumber: null, head: null, review: null, mergeCommit: head, integrationCommit: head, summary: 'closeout' } });
  task = store.task(task.id);
  const engine = new Engine(store, {} as unknown as Adapter, 0);
  const lifecycle = new Lifecycle(engine); lifecycle.consumerBlockFetchMs = 0;
  t.after(async () => { await engine.stop(); store.close(); });
  return { repo, head, store, task, blocked: emitted.records.at(-1)!, lifecycle, push };
}

test('a consumer-declared closeout block is recognised from the record, not its wording', async t => {
  const f = await fixture(t);
  assert.equal(f.blocked.state, 'blocked', f.blocked.error);
  assert.equal(f.blocked.result?.outcome, 'blocked');
  assert.equal(isConsumerDeclaredBlock(f.blocked), true);
  assert.equal(isConsumerDeclaredBlock({ ...f.blocked, result: null }), false, 'a result-free refusal is the stale-base class, not a finding');
  assert.equal(isConsumerDeclaredBlock({ ...f.blocked, commit: 'e'.repeat(40) }), false, 'a publication intent is never re-asked here');
});

test('only a fast-forward through the hook-owned paths is evidence the consumer changed its inputs', async t => {
  const f = await fixture(t);
  assert.equal(await consumerBlockAdvance(f.repo, f.blocked, true), null, 'an unchanged remote is not evidence');
  await f.push('unrelated', 'docs/other.md');
  assert.equal(await consumerBlockAdvance(f.repo, f.blocked, true), null, 'an unrelated advance is not evidence');
  const fixed = await f.push('ready', 'docs/state/ready');
  assert.equal(await consumerBlockAdvance(f.repo, f.blocked, true), fixed);
  assert.equal(await consumerBlockAdvance(f.repo, { ...f.blocked, baseCommit: 'f'.repeat(40) }, false), null, 'an unknown base proves nothing');
});

test('the pass re-asks a consumer-blocked closeout only after the consumer changed its inputs, within a budget', async t => {
  const f = await fixture(t);
  const current = () => f.store.task(f.task.id);
  await f.lifecycle.pass();
  assert.equal(current().phase, 'closing'); assert.equal(current().resolution.attention, true);
  await f.push('unrelated', 'docs/other.md');
  await f.lifecycle.pass();
  assert.equal(current().phase, 'closing', 'a moved base alone does not override the finding');
  const fixed = await f.push('ready', 'docs/state/ready');
  await f.lifecycle.pass();
  assert.equal(current().phase, 'syncing');
  assert.equal(current().resolution.attention, false);
  assert.match(current().reason, new RegExp(fixed));
  assert.ok(f.store.events(f.task.id).some(event => event.kind === 'closeout_block_renewed'));

  // Parked again at the same blocked occurrence with the budget spent: a human decides.
  f.store.update(f.task.id, { phase: 'closing', resolution: { ...current().resolution, attention: true } });
  for (let i = 1; i < CONSUMER_BLOCK_RENEWAL_LIMIT; i++) f.store.event(f.task.id, 'closeout_block_renewed', 'earlier');
  await f.lifecycle.pass();
  assert.equal(current().phase, 'closing');
  assert.equal(current().resolution.attention, true);
});
