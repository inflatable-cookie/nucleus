import { fakeAdapter, createTaskAgent, observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine, PRE_DISPATCH_BASE_ADVANCE_LIMIT } from '../core/engine';
import { git, command } from '../core/git/index';
import { submissionSchema, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };

/**
 * A read-only pre-dispatch gate that, while it runs, does what a Chatterbox does on
 * main: `publish` pushes from a sibling clone and fast-forwards canonical to it,
 * `local` commits in canonical without pushing, `ok` leaves the checkout alone.
 */
function gateScript(modeFile: string, sibling: string) {
  return `#!/usr/bin/env node
const fs=require('fs'),{execFileSync}=require('child_process');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const event=JSON.parse(raw),root=event.repository.root;
const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8').trim();
const g=(cwd,...a)=>execFileSync('git',a,{cwd,stdio:'pipe'});
if(mode==='publish'){g(${JSON.stringify(sibling)},'pull','-q','--ff-only','origin','main');fs.writeFileSync(${JSON.stringify(sibling)}+'/docs/chatterbox-'+Date.now(),'x');
  g(${JSON.stringify(sibling)},'add','-A');g(${JSON.stringify(sibling)},'commit','-qm','chatterbox');g(${JSON.stringify(sibling)},'push','-q','origin','main');
  g(root,'pull','-q','--ff-only','origin','main');}
if(mode==='local'){fs.writeFileSync(root+'/docs/local-'+Date.now(),'x');g(root,'add','-A');g(root,'commit','-qm','local');}
process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:'ok',summary:'gate passed',metadata:{},changedPaths:[],commitSubjectSuffix:null}));});
`;
}

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-advance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  const repo = join(root, 'repo'), sibling = join(root, 'sibling'), modeFile = join(root, 'mode');
  await command('git', ['clone', join(root, 'origin.git'), repo], root);
  for (const dir of [repo]) { await git(dir, 'config', 'user.name', 'Queue test'); await git(dir, 'config', 'user.email', 'queue@example.invalid'); }
  await mkdir(join(repo, '.paseo/hooks'), { recursive: true }); await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, '.paseo/queue.json'), JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'gate', events: ['task.pre_dispatch'], mode: 'read_only',
    delivery: 'required', executable: '.paseo/hooks/gate', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] }));
  await writeFile(join(repo, '.paseo/hooks/gate'), gateScript(modeFile, sibling)); await chmod(join(repo, '.paseo/hooks/gate'), 0o755);
  await writeFile(join(repo, 'docs/plan.json'), '{}');
  await git(repo, 'add', '-A'); await git(repo, 'commit', '-m', 'base'); await git(repo, 'push', 'origin', 'main');
  await command('git', ['clone', join(root, 'origin.git'), sibling], root);
  await git(sibling, 'config', 'user.name', 'Chatterbox'); await git(sibling, 'config', 'user.email', 'chatterbox@example.invalid');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const store = new Store(join(root, 'queue.sqlite'));
  store.setMeta('paused', false); store.setMeta('lastRetentionAt', Date.now());
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  let workspaces = 0;
  const adapter = fakeAdapter({
    profiles: async () => [profile], validate: async () => git(repo, 'rev-parse', 'HEAD'),
    createWorkspace: async (task: any) => { workspaces++; return { id: `ws-${task.id}`, directory: repo }; },
     verifyWorkspace: async (task: any) => task.branch,
    createAgent: createTaskAgent,
    observe: observeIdle('ws'),
     verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head }),
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  t.after(async () => { await engine.stop(); store.close(); });
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Gate', repoPath: repo, planningCommit: head,
    handoffPath: 'docs/plan.json', originAgentId: 'origin' }), 'host', 'handoff', head);
  const mode = (value: 'publish' | 'local' | 'ok') => writeFile(modeFile, value);
  return { repo, head, store, engine, task, mode, workspaces: () => workspaces };
}

test('a published fast-forward during the read-only gate supersedes it and dispatch re-runs at the new base', async t => {
  const f = await fixture(t);
  await f.mode('publish');
  await f.engine.wake();
  const first = f.store.hookEvents(f.task.id)[0];
  assert.equal(first.state, 'failed', first.error);
  assert.equal(first.baseAdvance?.from, f.head);
  assert.equal(f.store.task(f.task.id).phase, 'queued', 'a superseded gate is not a finding and does not park the task');
  assert.equal(f.workspaces(), 0);
  await f.mode('ok');
  await f.engine.wake();
  const records = f.store.hookEvents(f.task.id);
  assert.equal(records.length, 2, 'a fresh occurrence answers for the new base');
  assert.equal(records[1].state, 'result');
  assert.equal(records[1].baseCommit, await git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(f.store.task(f.task.id).phase, 'working');
});

test('an unpublished local commit during the read-only gate still needs attention', async t => {
  const f = await fixture(t);
  await f.mode('local');
  await f.engine.wake();
  assert.equal(f.store.hookEvents(f.task.id)[0].state, 'uncertain');
  assert.equal(f.store.task(f.task.id).phase, 'needs_attention');
});

test('a base that keeps advancing under the gate reaches a human after the bound', async t => {
  const f = await fixture(t);
  await f.mode('publish');
  for (let i = 0; i <= PRE_DISPATCH_BASE_ADVANCE_LIMIT; i++) await f.engine.wake();
  assert.equal(f.store.hookEvents(f.task.id).length, PRE_DISPATCH_BASE_ADVANCE_LIMIT + 1);
  assert.equal(f.store.task(f.task.id).phase, 'needs_attention');
});

test('operator retry renews an uncertain gate once the base is a clean published fast-forward', async t => {
  const f = await fixture(t);
  await f.mode('local');
  await f.engine.wake();
  const held = f.store.hookEvents(f.task.id)[0];
  assert.equal(held.state, 'uncertain');
  const control = () => ({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: 'retry_effect' as const, effect: `hook.${held.eventId ?? held.id}`, reason: 'Retry the held gate' });
  await assert.rejects(f.engine.performTaskControl(control()), /Reconcile the uncertain hook outcome/, 'an unpublished head still refuses');
  // g06.350: the Chatterbox's own commit is now pushed; canonical is clean and equal to origin.
  await git(f.repo, 'push', 'origin', 'main');
  await f.mode('ok');
  const retried = await f.engine.performTaskControl(control());
  assert.equal(retried.phase, 'queued');
  const records = f.store.hookEvents(f.task.id);
  assert.equal(records[0].state, 'failed'); assert.ok(records[0].baseAdvance);
  assert.equal(records[1].state, 'result');
  assert.equal(records[1].baseCommit, await git(f.repo, 'rev-parse', 'HEAD'));
});
