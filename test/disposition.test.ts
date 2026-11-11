import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../core/store/store';
import { controlHasExternalEffect, Engine } from '../core/engine';
import { request as httpRequest } from 'node:http';
import { fenceDisposition, listOriginRefs, parseLsRemote, postDispositionRefDiff, proveWorkspaceEmpty, requestDisposition, resumeDispositions, type DispositionDeps } from '../core/verbs/disposition';
import { settleCancelledPr, verifyCancelledWorkspacePr, ForeignRecordedPr } from '../core/forge/index';
import { isDispositionActive, reviewEntryRecordSchema, submissionSchema, taskControlInputSchema, taskNextSchema, type Run, type Task } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { PaseoAdapter, type Adapter, type AgentObservation } from '../service/paseo-composition';
import { startCallbacks } from '../service/callbacks/callback';
import { hookRecordSchema } from '../shared/hooks';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const base = 'b'.repeat(40);

function reviewEntryFor(task: Task) {
  return reviewEntryRecordSchema.parse({
    operationId: 'b'.repeat(64), prNumber: 1, repository: task.repoPath, branch: task.branch, workspaceId: task.workspaceId!,
    verifiedHead: 'a'.repeat(40), verifiedBase: 'c'.repeat(40), dispatchBase: null, planningCommit: 'c'.repeat(40),
    authority: 'Approved external PR review',
    authorDeclaration: { models: ['provider/author-model'], githubAuthor: 'author', authoringSystem: 'GitHub', attestedBy: 'operator', provenance: 'review-entry fixture' },
    checkedAt: new Date().toISOString(), preserveWorkspace: true, directory: task.directory ?? '',
    workspaceMode: 'isolated', briefDigest: null, briefVersion: null,
  });
}

test('later workspace retirement reads closed unmerged PR truth without mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-retirement-pr-'));
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    const task = store.update(dispatched(store, 'Retirement PR').id, { resumePrNumber: 12 });
    const pr = { state: 'closed', merged: false, head: { ref: task.branch, repo: { full_name: 'owner/repo' } },
      base: { ref: task.baseBranch, repo: { full_name: 'owner/repo' } } };
    const transport = async (_task: Task, endpoint: string, args: string[] = []) => {
      assert.equal(endpoint, 'repos/owner/repo/pulls/12');
      assert.deepEqual(args, [], 'observation never mutates the PR');
      return pr;
    };
    await verifyCancelledWorkspacePr(task, transport, 'owner/repo');
    pr.state = 'open';
    await assert.rejects(verifyCancelledWorkspacePr(task, transport, 'owner/repo'), /closed and unmerged/);
    pr.state = 'closed'; pr.merged = true;
    await assert.rejects(verifyCancelledWorkspacePr(task, transport, 'owner/repo'), /closed and unmerged/);
    pr.merged = false; pr.head.ref = 'another-branch';
    await assert.rejects(verifyCancelledWorkspacePr(task, transport, 'owner/repo'), /identity changed/);
    await assert.rejects(verifyCancelledWorkspacePr(task, async () => { throw Error('unknown delivery'); }, 'owner/repo'), /unknown delivery/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('a cancel whose stored completion names a foreign PR settles without touching that PR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-foreign-pr-')); const store = new Store(join(root, 'queue.sqlite'));
  try {
    // The #984 shape: a foreign task's report stored as this task's completion
    // (#992 refuses new ones; this row already exists). Its PR 867 lives on
    // another task's branch, so the close-PR step must record a definite "no PR
    // of its own to close" and the disposition continues to archive.
    const task = dispatched(store, 'Foreign stored completion');
    const withForeign = store.update(task.id, { completion: { eventId: 'foreign-report', taskId: task.id, runId: 'run-1',
      status: 'blocked', summary: 'Report stored for another task\'s PR', prNumber: 867 } });
    let mutations = 0;
    const transport = async (_t: Task, endpoint: string, args: string[] = []) => {
      if (args.length) mutations++;
      assert.match(endpoint, /pulls\/867$/);
      return { state: 'open', merged: false, head: { ref: 'ns-e01885a1-0000-0000-0000-000000000000', repo: { full_name: 'owner/repo' } },
        base: { ref: 'main', repo: { full_name: 'owner/repo' } } };
    };
    const deps = stubDeps({ settleCancelledPr: (t: Task) => settleCancelledPr(t, transport, 'owner/repo') });
    const done = await requestDisposition(store, deps, { taskId: withForeign.id, version: withForeign.version, action: 'cancel', reason: 'Superseded by the follow-up task' });
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.disposition?.status, 'complete');
    assert.equal(done.disposition?.workspaceArchived, true, 'the disposition continues past the foreign PR');
    const close = done.disposition!.effects.find(effect => effect.kind === 'close_pr')!;
    assert.match(close.result!, /does not match task branch and repository/);
    assert.match(close.result!, /no PR of its own to close/);
    assert.equal(close.uncertain, false, 'a foreign recorded PR is a definite finding, never parked attention');
    assert.equal(mutations, 0, 'the disposition never comments or closes another task\'s PR');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

function parkedCancellation(f: ReturnType<typeof fixture>, options: { settleAfter?: number } = {}) {
  const task = dispatched(f.store, 'Parked cancellation');
  f.idle(task.agentId!);
  const withPr = f.store.update(task.id, { resumePrNumber: 867 });
  let attempts = 0;
  const settleAfter = options.settleAfter ?? 2;
  const deps = stubDeps({ settleCancelledPr: async () => {
    attempts++;
    if (attempts < settleAfter) throw Error('PR outcome is uncertain: transport down');
    return 'Closed recorded PR #867 with cancellation reason; branch retained';
  } });
  return { task: withPr, deps, calls: () => attempts };
}

test('a disposition parked in needs_attention can be withdrawn', async () => {
  const f = fixture();
  try {
    const { task, deps } = parkedCancellation(f);
    const parked = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    assert.equal(parked.phase, 'needs_attention');
    assert.equal(parked.disposition?.status, 'needs_attention');
    const withdrawn = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: parked.id, version: parked.version, action: 'withdraw_cancel', reason: 'Planner reversed the cancellation',
    }));
    assert.equal(withdrawn.disposition, null, 'the parked fence withdraws like an intent-stage one');
    assert.ok(f.store.events(parked.id).some(event => event.kind === 'disposition_withdrawn'));
  } finally { await f.close(); }
});

test('a disposition parked in needs_attention re-runs its parked step and settles', async () => {
  const f = fixture();
  try {
    const { task, deps, calls } = parkedCancellation(f);
    const parked = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    assert.equal(parked.phase, 'needs_attention');
    // A second cancel of the same kind with a fresh reason re-runs the parked
    // step under the recorded fence instead of refusing as conflicting.
    const settled = await requestDisposition(f.store, deps, { taskId: parked.id, version: parked.version, action: 'cancel', reason: 'Duplicate work; re-run the parked step' });
    assert.equal(calls(), 2, 'the re-run reconciled the same recorded close_pr occurrence');
    assert.ok(f.store.events(parked.id).some(event => event.kind === 'disposition_retry_requested' && event.detail.includes('re-run requested by operator control')));
    assert.equal(settled.phase, 'cancelled');
    assert.equal(settled.disposition?.status, 'complete');
    assert.match(settled.reason, /^Cancelled: Duplicate work$/,
      'the recorded fence keeps its original reason; the fresh request only re-drives the step');
    assert.equal(settled.disposition?.workspaceArchived, true);
  } finally { await f.close(); }
});

test('a parked re-run still refuses a conflicting fence and a stale version', async () => {
  const f = fixture();
  try {
    const { task, deps } = parkedCancellation(f);
    const parked = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    await assert.rejects(requestDisposition(f.store, deps, { taskId: parked.id, version: parked.version, action: 'supersede', reason: 'Different disposition', replacementTaskId: parked.id }),
      /A conflicting disposition request cannot replace the recorded fence/);
    await assert.rejects(requestDisposition(f.store, deps, { taskId: parked.id, version: parked.version - 1, action: 'cancel', reason: 'Re-run at a stale version' }),
      /Task changed; refresh before retrying/);
    assert.equal(f.store.task(parked.id).disposition?.status, 'needs_attention', 'a refused re-run changes nothing');
  } finally { await f.close(); }
});

test('next offers the parked re-run and the withdrawal, and offers neither once complete', async () => {
  const f = fixture();
  try {
    const { task, deps } = parkedCancellation(f);
    const parked = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(parked.id))));
    const withdraw = next().verbs.find(verb => verb.verb === 'withdraw_cancel');
    const reRun = next().verbs.find(verb => verb.verb === 'cancel');
    assert.equal(withdraw?.available, true);
    assert.equal(withdraw?.action, 'withdraw_cancel');
    assert.deepEqual(withdraw?.args, { action: 'withdraw_cancel', taskId: parked.id, version: parked.version });
    assert.deepEqual(withdraw?.fill, ['reason']);
    assert.equal(reRun?.available, true);
    assert.equal(reRun?.action, 'cancel');
    assert.deepEqual(reRun?.args, { action: 'cancel', taskId: parked.id, version: parked.version });
    assert.deepEqual(reRun?.fill, ['reason']);
    assert.match(reRun?.note ?? '', /Re-runs the parked cancellation step/);
    // The offered args are the applied control: `queue.task` maps the view to
    // action cancel with the filled reason, and the parked fence settles.
    const settled = await requestDisposition(f.store, deps, { taskId: parked.id, version: parked.version, action: 'cancel', reason: 'Re-run from next' });
    assert.equal(settled.phase, 'cancelled');
    assert.equal(f.store.events(parked.id).some(event => event.kind === 'disposition_retry_requested'), true);
    const settledNext = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(parked.id))));
    assert.ok(!settledNext.verbs.some(verb => verb.verb === 'withdraw_cancel' || verb.verb === 'cancel'),
      'a complete disposition offers neither exit');
  } finally { await f.close(); }
});

test('a parked supersession re-runs only under the same retained replacement, and never offers withdrawal', async () => {
  const f = fixture();
  try {
    const replacement = dispatched(f.store, 'Retained replacement');
    const task = dispatched(f.store, 'Parked supersession');
    f.idle(task.agentId!);
    let holds = true;
    const deps = stubDeps({ hooks: { emit: async () => ({ hold: holds, attention: false, records: [] as unknown[] }) } });
    const parked = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'supersede',
      reason: 'Replacement owns the work', replacementTaskId: replacement.id });
    assert.equal(parked.disposition?.status, 'needs_attention');
    const next = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(parked.id))));
    const withdraw = next.verbs.find(verb => verb.verb === 'withdraw_cancel');
    const reRun = next.verbs.find(verb => verb.verb === 'supersede');
    assert.equal(withdraw?.available, false, 'only a cancellation can be withdrawn');
    assert.match(withdraw?.refusal ?? '', /Only an active cancellation can be withdrawn/);
    assert.equal(reRun?.available, true);
    assert.deepEqual(reRun?.args, { action: 'supersede', taskId: parked.id, version: parked.version, replacementTaskId: replacement.id });
    // A different retained replacement would replace the fence, so it refuses.
    const other = dispatched(f.store, 'Other replacement');
    await assert.rejects(requestDisposition(f.store, deps, { taskId: parked.id, version: parked.version, action: 'supersede',
      reason: 'Different replacement', replacementTaskId: other.id }), /conflicting disposition request/);
    // The same replacement re-runs the parked step, which settles this time.
    holds = false;
    const settled = await requestDisposition(f.store, deps, { taskId: parked.id, version: f.store.task(parked.id).version, action: 'supersede',
      reason: 'Re-run the parked supersession', replacementTaskId: replacement.id });
    assert.equal(settled.phase, 'cancelled');
    assert.equal(settled.disposition?.status, 'complete');
  } finally { await f.close(); }
});

const submit = (title: string, repoPath = '/repo') => submissionSchema.parse({
  submissionId: randomUUID(), title, repoPath, planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
});

function stubDeps(overrides: Partial<DispositionDeps> = {}): DispositionDeps & { archived: string[]; proofs: number } {
  const deps = {
    archived: [] as string[], proofs: 0,
    hooks: { emit: async () => ({ hold: false, attention: false, records: [] as unknown[] }) },
    observeAgent: async () => ({ stopped: true }),
    archiveAgent: async () => {},
    proveWorkspaceEmpty: async () => { deps.proofs++; return { empty: true, detail: 'empty' }; },
    proveRetainedByReplacement: async () => ({ retained: true, detail: 'retained' }),
    archiveWorkspace: async (task: Task) => { deps.archived.push(task.workspaceId!); return true; },
    observeWorkspaceArchived: async () => false,
    settleCancelledPr: async () => 'PR closed',
    ...overrides,
  };
  return deps;
}

function dispatched(store: Store, title: string, repoPath = '/repo') {
  const inserted = store.insert(submit(title, repoPath), 'host', 'handoff', base);
  return store.update(inserted.id, {
    phase: 'working', workspaceIntent: true, agentIntent: true,
    workspaceId: `ws-${inserted.id}`, directory: `/missing-${inserted.id}`, agentId: `worker-${inserted.id}`,
    runId: 'run-1', reason: 'Worker running',
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const states = new Map<string, AgentObservation>();
  const idle = (id: string) => states.set(id, { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' });
  const running = (id: string) => states.set(id, { id, workspaceId: null, status: 'running', active: true, permissions: false, error: '' });
  const archived: string[] = [];
  const interrupts: { agentId: string; messageId: string; text: string }[] = [];
  const adapter = {
    observe: async (id: string) => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; },
    archiveAgent: async (id: string) => { archived.push(id); states.delete(id); },
    interruptAndContinue: async (agentId: string, messageId: string, text: string) => { interrupts.push({ agentId, messageId, text }); },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  return { dir, store, engine, states, idle, running, archived, interrupts, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('cancel fences before stopping, drains the idle worker and archives the proved-empty workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = dispatched(store, 'Duplicate');
    const deps = stubDeps();
    const version = task.version;
    const result = await requestDisposition(store, deps, { taskId: task.id, version, action: 'cancel', reason: 'Zero-work duplicate' });
    assert.equal(result.phase, 'cancelled');
    assert.equal(result.disposition?.kind, 'cancel');
    assert.equal(result.disposition?.status, 'complete');
    assert.equal(result.reason, 'Cancelled: Zero-work duplicate');
    assert.deepEqual(deps.archived, [task.workspaceId]);
    // The fence version bump plus drain effects advanced the version exactly once per effect batch.
    assert.ok(result.version > version);
    assert.ok(store.events(task.id).some((event) => event.kind === 'disposition_requested'));
    assert.ok(store.events(task.id).some((event) => event.kind === 'disposition_complete'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('published PR work is archivable; dirty, unpushed and missing work are preserved with evidence', async () => {
  const root=mkdtempSync(join(tmpdir(),'ns-published-'));
  const repo=join(root,'repo'), remote=join(root,'origin.git'), workspace=join(root,'worktree');
  const run=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  const store=new Store(join(root,'queue.sqlite'));
  try {
    run(root,'init','--bare',remote);run(root,'init',repo);
    run(repo,'config','user.email','test@example.com');run(repo,'config','user.name','Test');
    writeFileSync(join(repo,'base.txt'),'base');run(repo,'add','.');run(repo,'commit','-m','base');
    const planningBase=run(repo,'rev-parse','HEAD');
    run(repo,'remote','add','origin',remote);
    const task=dispatched(store,'Published work',repo);
    run(repo,'worktree','add','-b',task.branch,workspace);
    writeFileSync(join(workspace,'change.txt'),'published');run(workspace,'add','.');run(workspace,'commit','-m','change');
    run(workspace,'push','-u','origin',task.branch);
    const assigned=store.update(task.id,{directory:workspace,planningBase,prUrl:'https://github.com/example/repo/pull/12'});
    const published=await proveWorkspaceEmpty(store,assigned);
    assert.equal(published.empty,true);assert.match(published.detail,/origin queue branch/);
    // The queue branch proves publication only on the recorded canonical origin (review #538).
    const foreign=await proveWorkspaceEmpty(store,{...assigned,repository:'canonical/repo'});
    assert.equal(foreign.empty,false);assert.match(foreign.uncertain??'',/does not match the recorded task identity/);
    writeFileSync(join(workspace,'dirty.txt'),'dirty');
    assert.match((await proveWorkspaceEmpty(store,assigned)).detail,/dirty/);
    run(workspace,'add','.');run(workspace,'commit','-m','unpushed');
    assert.match((await proveWorkspaceEmpty(store,assigned)).detail,/not on origin/);
    run(workspace,'checkout','--detach');
    assert.match((await proveWorkspaceEmpty(store,assigned)).detail,/not the queue branch/);
    run(workspace,'checkout',task.branch);
    run(workspace,'push','origin','--delete',task.branch);
    assert.match((await proveWorkspaceEmpty(store,assigned)).detail,/Remote queue branch is missing and no origin ref contains HEAD/);
    // A stale tracking ref proves nothing: origin fetches only main, and a deleted
    // donor branch's local ref still contains HEAD (review #536).
    run(repo,'push','origin',`${planningBase}:refs/heads/main`);
    run(repo,'config','remote.origin.fetch','+refs/heads/main:refs/remotes/origin/main');
    run(workspace,'push','origin',`HEAD:refs/heads/donor`);run(workspace,'fetch','origin','+refs/heads/donor:refs/remotes/origin/donor');
    run(workspace,'push','origin','--delete','donor');
    assert.equal(run(workspace,'rev-parse','refs/remotes/origin/donor'),run(workspace,'rev-parse','HEAD'),'the stale donor ref survives the configured prune');
    const stale=await proveWorkspaceEmpty(store,assigned);
    assert.equal(stale.empty,false,JSON.stringify(stale));assert.match(stale.detail,/no origin ref contains HEAD/,JSON.stringify(stale));
    // Round 4 (papercut 7d59b444): the queue branch is gone, but another live origin
    // branch (here the merged base) contains every local commit, so the work is published.
    run(workspace,'push','origin',`HEAD:refs/heads/main`);
    const merged=await proveWorkspaceEmpty(store,assigned);
    assert.equal(merged.empty,true);assert.match(merged.detail,/origin\/main contains every local commit/);
    // A queue branch behind HEAD does not make published work unpublished, and
    // unrelated origin branches or another remote never mint publication.
    run(workspace,'push','origin',`${planningBase}:refs/heads/${task.branch}`);
    const behind=await proveWorkspaceEmpty(store,assigned);
    assert.equal(behind.empty,true,JSON.stringify(behind));assert.match(behind.detail,/queue branch behind HEAD on origin, but origin\/main contains/);
    run(workspace,'push','--force','origin',`${planningBase}:refs/heads/main`);
    run(workspace,'push','origin',`${planningBase}:refs/heads/unrelated`);
    const mirror=join(root,'mirror.git');run(root,'init','--bare',mirror);run(repo,'remote','add','mirror',mirror);run(workspace,'push','mirror','HEAD:refs/heads/main');
    const unrelated=await proveWorkspaceEmpty(store,assigned);
    assert.equal(unrelated.empty,false);assert.match(unrelated.detail,/is not on origin queue branch .* or any other origin branch/);
    run(workspace,'push','origin',`HEAD:refs/heads/main`);
    assert.match((await proveWorkspaceEmpty(store,store.update(task.id,{directory:join(root,'missing')}))).detail,/missing/);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('cancelled-task archive refuses an idle unrelated thread', async () => {
  const root=mkdtempSync(join(tmpdir(),'ns-cancel-foreign-'));
  const repo=join(root,'repo'), remote=join(root,'origin.git'), workspace=join(root,'worktree');
  const run=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  const store=new Store(join(root,'queue.sqlite'));
  store.setMeta('paused',false);
  const flags:unknown[]=[];
  const archived={n:0};
  let engine:Engine|undefined;
  try {
    run(root,'init','--bare',remote);run(root,'init',repo);
    run(repo,'config','user.email','test@example.com');run(repo,'config','user.name','Test');
    writeFileSync(join(repo,'base.txt'),'base');run(repo,'add','.');run(repo,'commit','-m','base');
    const planningBase=run(repo,'rev-parse','HEAD');
    run(repo,'remote','add','origin',remote);
    const task=dispatched(store,'Idle extra thread',repo);
    run(repo,'worktree','add','-b',task.branch,workspace);
    run(workspace,'push','-u','origin',task.branch);
    const assigned=store.update(task.id,{directory:workspace,planningBase});
    const foreign={id:'foreign-calibrator',workspaceId:assigned.workspaceId,labels:{'nucleus.task':'other'},status:'idle'};
    const archiver=Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
    Object.defineProperty(archiver,'api',{value:{
      workspaces:{ref:()=>({directory:workspace,refresh:async()=>{},current:()=>({projectRootPath:repo,worktreeSlug:assigned.branch}),archive:async()=>{archived.n++;return{archivedAt:new Date().toISOString()};}})},
      agents:{list:async()=>({entries:[{agent:foreign}],pageInfo:{hasMore:false}})},
    }});
    const adapter={
      observe:async(id:string)=>({id,workspaceId:assigned.workspaceId,status:'idle',active:false,permissions:false,error:''}),
      archiveAgent:async()=>{},
      archiveTaskWorkspace:async(...args:Parameters<NonNullable<Adapter['archiveTaskWorkspace']>>)=>{
        flags.push(args[9]);
        return archiver.archiveTaskWorkspace(...args);
      },
      taskWorkspaceArchived:async()=>false,
    } as unknown as Adapter;
    engine=new Engine(store,adapter,0);
    const result=await engine.disposeTask({taskId:assigned.id,version:assigned.version,action:'cancel',reason:'Withdraw'});
    assert.ok(flags.length>=1);
    assert.ok(flags.every(flag=>flag!==true),'cancelled archive must not opt into idle foreign threads');
    assert.equal(archived.n,0);
    assert.equal(result.disposition?.workspaceArchived,false);
  } finally {
    await engine?.stop();
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('backpressured archive observes success or retries once; unknown observation holds attention', async () => {
  for(const outcome of ['done','retry','remains','unknown'] as const){
    const root=mkdtempSync(join(tmpdir(),'ns-archive-'));
    const store=new Store(join(root,'queue.sqlite'));
    try {
      const task=dispatched(store,outcome);
      let calls=0,observations=0;
      const deps=stubDeps({
        archiveWorkspace: async()=>{calls++;if(outcome==='retry'&&calls===2)return true;throw Error('admission timeout');},
        observeWorkspaceArchived: async()=>{observations++;if(outcome==='unknown')throw Error('observation timeout');return outcome==='done';},
      });
      const result=await requestDisposition(store,deps,{taskId:task.id,version:task.version,action:'cancel',reason:'Withdraw'});
      assert.equal(result.phase,outcome==='unknown'?'needs_attention':'cancelled');
      assert.equal(calls,outcome==='done'||outcome==='unknown'?1:2);
      if(outcome==='remains')assert.match(result.disposition!.workspaceEvidence,/remains present after one proven archive retry/);
      assert.ok(observations>=1);
    } finally {store.close();rmSync(root,{recursive:true,force:true});}
  }
});

test('a delayed archive is reconciled after restart before missing-directory proof',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ns-delayed-'));const store=new Store(join(root,'queue.sqlite'));
  try {
    const task=dispatched(store,'Delayed archive');let observed=0,archives=0;
    const deps=stubDeps({archiveWorkspace:async()=>{archives++;throw Error('timeout');},observeWorkspaceArchived:async()=>{observed++;if(observed===1)throw Error('timeout');return true;}});
    const held=await requestDisposition(store,deps,{taskId:task.id,version:task.version,action:'cancel',reason:'Withdraw'});
    assert.equal(held.phase,'needs_attention');
    const settled=await requestDisposition(store,deps,{taskId:task.id,version:held.version,action:'cancel',reason:'Withdraw'});
    assert.equal(settled.phase,'cancelled');assert.equal(settled.disposition?.workspaceArchived,true);
    assert.equal(archives,1);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('cancellation closes its recorded PR once and supersession leaves replacement PR rules alone',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ns-pr-close-'));const store=new Store(join(root,'queue.sqlite'));
  try {
    const task=dispatched(store,'PR task');
    const withPr=store.update(task.id,{resumePrNumber:12});
    let calls=0;
    const deps=stubDeps({settleCancelledPr:async()=>{calls++;return 'Closed recorded PR #12 with cancellation reason';}});
    const done=await requestDisposition(store,deps,{taskId:withPr.id,version:withPr.version,action:'cancel',reason:'Duplicate work',workDisposition:'preserve'});
    assert.equal(calls,1);assert.match(done.disposition!.effects.find(e=>e.kind==='close_pr')!.result!,/Closed recorded PR/);
    assert.equal(done.disposition!.workspaceArchived,false);
    assert.match(done.disposition!.workspaceEvidence,/Operator requested preserve/);
    await requestDisposition(store,deps,{taskId:done.id,version:done.version,action:'cancel',reason:'Duplicate work',workDisposition:'preserve'});
    assert.equal(calls,1);
    const replacement=dispatched(store,'Replacement');
    const superseded=store.update(dispatched(store,'Superseded PR').id,{resumePrNumber:13});
    const result=await requestDisposition(store,deps,{taskId:superseded.id,version:superseded.version,action:'supersede',reason:'Replacement owns work',replacementTaskId:replacement.id,workDisposition:'preserve'});
    assert.equal(result.phase,'cancelled');assert.equal(calls,1);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('PR close reconciles lost comment and close responses by recorded number and head branch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ns-pr-transport-'));const store=new Store(join(root,'queue.sqlite'));
  try {
    const task=dispatched(store,'PR close');const withPr=store.update(task.id,{resumePrNumber:12});
    const fenced=fenceDisposition(store,{taskId:withPr.id,version:withPr.version,action:'cancel',reason:'Duplicate implementation'});
    let state='open',comments:{body:string;user:{login:string}}[]=[],posts=0,patches=0;
    const transport=async(_task:Task,endpoint:string,args:string[]=[])=>{
      if(endpoint==='user')return {login:'queue-bot'};
      if(endpoint.endsWith('/pulls/12')){
        if(args[0]==='-X'){patches++;state='closed';throw Error('lost close response');}
        return {state,merged:false,head:{ref:task.branch,repo:{full_name:'owner/repo'}},base:{repo:{full_name:'owner/repo'}}};
      }
      if(endpoint.includes('/comments?'))return [comments];
      if(endpoint.endsWith('/comments')){posts++;comments.push({body:args[3].slice(5),user:{login:'queue-bot'}});throw Error('lost comment response');}
      throw Error(`unexpected endpoint ${endpoint}`);
    };
    assert.match(await settleCancelledPr(fenced,transport,'owner/repo'),/Closed recorded PR/);
    assert.equal(posts,1);assert.equal(patches,1);assert.match(comments[0].body,/Duplicate implementation/);
    assert.match(await settleCancelledPr(fenced,transport,'owner/repo'),/already closed/);
    assert.equal(posts,1);assert.equal(patches,1);
    // A recorded PR the forge proves foreign is a definite identity finding
    // (nucleus#1000), raised before any comment or close is ever attempted.
    let foreign: unknown;
    try { await settleCancelledPr({...fenced,branch:'wrong'},transport,'owner/repo'); }
    catch (error) { foreign = error; }
    assert.ok(foreign instanceof ForeignRecordedPr);
    assert.match((foreign as Error).message,/does not match/);
    assert.equal(posts,1);assert.equal(patches,1,'a foreign recorded PR is never commented or closed');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('completed disposition clears attention and stays terminal without erasing escalated evidence', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Disposed after escalation');
    f.idle(task.agentId!);
    const timestamp = new Date().toISOString();
    const incident = {
      id: 'incident', fingerprint: 'incident', role: 'closeout' as const, runId: null, attempt: 1,
      cause: 'missing_callback', detail: 'Closeout could not complete', action: '' as const, status: 'escalated' as const,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const recovery = {
      id: 'recovery', key: 'recovery', generation: task.coordinatorGeneration, runId: null, agentId: 'coordinator',
      status: 'escalated' as const, summary: 'Operator disposition required', idleSince: null, incidentId: incident.id,
    };
    f.store.update(task.id, {
      phase: 'needs_attention', reason: 'Closeout could not complete',
      resolution: { ...task.resolution, attention: true, incident, recovery, recoveryActive: false, mergedCommit: 'c'.repeat(40) },
    });
    f.store.putNotice({
      id: 'attention-notice', taskId: task.id, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null,
      sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Needs attention',
    });
    f.store.putNotice({
      id: 'attention-notice-intent', taskId: task.id, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null,
      sources: [], originEntry: true, kind: 'attention', status: 'intent', error: '', text: 'Delivery outcome unknown',
    });
    let notifications = 0;
    Object.assign(f.engine.resolution.adapter, {
      supportsCoordinatorRecovery: true,
      notify: async () => { notifications++; },
    });

    const disposed = await requestDisposition(f.store, stubDeps(), {
      taskId: task.id, version: f.store.task(task.id).version, action: 'cancel', reason: 'Operator disposed answered escalation', workDisposition: 'preserve',
    });

    assert.equal(disposed.phase, 'cancelled');
    assert.equal(disposed.disposition?.status, 'complete');
    assert.equal(disposed.resolution.attention, false);
    assert.deepEqual(disposed.resolution.incident, incident, 'incident remains durable evidence');
    assert.deepEqual(disposed.resolution.recovery, recovery, 'escalated recovery remains durable evidence');
    assert.ok(f.store.notices(task.id).every(notice => notice.status === 'superseded'));
    assert.ok(f.store.events(task.id).some(event => event.kind === 'attention_episode_resolved'));

    assert.equal(await f.engine.resolution.recovery.route(disposed), null);
    await f.engine.resolution.recovery.pass();
    f.store.putNotice({
      id: 'late-attention-notice', taskId: task.id, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null,
      sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Late attention',
    });
    await f.engine.resolution.deliverNotices();
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'recovery').length, 0);
    assert.equal(f.store.notices(task.id).length, 3, 'no later pass derives another notice');
    assert.ok(f.store.notices(task.id).every(notice => notice.status === 'superseded'));
    assert.equal(notifications, 0);
  } finally { await f.close(); }
});

test('completed disposition keeps an agentless uncertain resolution run as evidence without replacing it', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Disposed during uncertain reviewer creation');
    f.idle(task.agentId!);
    const run: Run = {
      id: 'uncertain-reviewer', taskId: task.id, role: 'reviewer', generation: task.coordinatorGeneration,
      head: 'a'.repeat(40), base, agentId: null, workspaceId: task.workspaceId!, profile: null,
      status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null,
      idleSince: null, completion: null, released: false,
    };
    f.store.putRun(run);
    f.store.update(task.id, {
      phase: 'reviewing', reason: 'Reviewer creation outcome is uncertain',
      resolution: { ...task.resolution, currentRunId: run.id, attention: true },
    });
    let lookups = 0, creations = 0;
    Object.assign(f.engine.resolution.adapter, {
      findRunAgents: async () => { lookups++; return []; },
      createRun: async () => { creations++; return { id: 'replacement-reviewer', workspaceId: task.workspaceId }; },
      verifyPr: async () => ({ head: run.head, url: 'https://github.com/example/repo/pull/1' }),
      workspaceAvailable: async () => true,
    });

    const disposed = await requestDisposition(f.store, stubDeps(), {
      taskId: task.id, version: f.store.task(task.id).version, action: 'cancel',
      reason: 'Operator disposed uncertain reviewer creation', workDisposition: 'preserve',
    });
    assert.equal(disposed.phase, 'cancelled');
    assert.equal(disposed.disposition?.status, 'complete');
    assert.equal(disposed.resolution.currentRunId, run.id, 'uncertain run identity remains durable evidence');
    assert.equal(f.store.run(run.id)?.released, false, 'unknown creation is not falsely released');

    await f.engine.resolution.observe();
    await f.engine.resolution.observe();

    assert.equal(f.store.task(task.id).phase, 'cancelled');
    assert.equal(f.store.task(task.id).resolution.currentRunId, run.id);
    assert.equal(f.store.run(run.id)?.status, 'uncertain');
    assert.equal(lookups, 0, 'terminal projection does not reconcile an uncertain creation');
    assert.equal(creations, 0, 'terminal projection does not derive a replacement run');
  } finally { await f.close(); }
});

test('bulk disposition fences every target first, then drains effects serially with durable progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  let activeArchives = 0, maxArchives = 0;
  const adapter = {
    observe: observeIdle(null),
    archiveAgent: async () => {
      activeArchives++; maxArchives = Math.max(maxArchives, activeArchives);
      await new Promise(resolve => setTimeout(resolve, 10)); activeArchives--;
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  try {
    const replacement = store.insert(submit('Replacement'), 'host', 'handoff', base);
    const first = dispatched(store, 'First duplicate');
    const second = dispatched(store, 'Second duplicate');
    const input = {
      operationId: 'incident-wave', tasks: [{ taskId: first.id, version: first.version }, { taskId: second.id, version: second.version }],
      action: 'supersede' as const, reason: 'Replaced by staged pilot', replacementTaskId: replacement.id, workDisposition: 'preserve' as const,
    };
    const started = await engine.startBulkDisposition(input);
    assert.equal(started.status, 'pending');
    assert.ok(isDispositionActive(store.task(first.id)));
    assert.ok(isDispositionActive(store.task(second.id)), 'all targets are fenced before the first remote effect completes');
    for (let i = 0; i < 100 && engine.bulkDispositionDetail(input.operationId).status !== 'complete'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const complete = engine.bulkDispositionDetail(input.operationId);
    assert.equal(complete.status, 'complete');
    assert.deepEqual(complete.items.map(item => item.status), ['complete', 'complete']);
    assert.equal(store.task(first.id).phase, 'cancelled');
    assert.equal(store.task(second.id).phase, 'cancelled');
    assert.equal(maxArchives, 1, 'bulk remote effects must remain single-flight');
    assert.equal((await engine.startBulkDisposition(input)).operationId, input.operationId, 'stable operation IDs are idempotent');
    await assert.rejects(engine.startBulkDisposition({ ...input, reason: 'different' }), /different input/);
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished bulk disposition resumes from durable progress after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const adapter = {
    observe: observeIdle(null),
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const stopped = new Engine(store, adapter, 0);
  stopped.stopped = true;
  try {
    const replacement = store.insert(submit('Replacement'), 'host', 'handoff', base);
    const target = dispatched(store, 'Restarted duplicate');
    const input = {
      operationId: 'restart-wave', tasks: [{ taskId: target.id, version: target.version }], action: 'supersede' as const,
      reason: 'Replaced by staged pilot', replacementTaskId: replacement.id, workDisposition: 'preserve' as const,
    };
    const pending = await stopped.startBulkDisposition(input);
    assert.equal(pending.status, 'pending');
    assert.ok(isDispositionActive(store.task(target.id)), 'durable fence exists before restart');

    const resumed = new Engine(store, adapter, 0);
    resumed.resumeBulkDispositions();
    for (let i = 0; i < 100 && resumed.bulkDispositionDetail(input.operationId).status !== 'complete'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resumed.bulkDispositionDetail(input.operationId).status, 'complete');
    assert.equal(store.task(target.id).phase, 'cancelled');
    await resumed.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an active worker holds draining without relaunch; resume completes after it stops', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Duplicate');
    f.running(task.agentId!);
    const deps = stubDeps({
      observeAgent: async (id: string) => {
        const state = f.states.get(id);
        if (!state) return { stopped: true };
        return { stopped: !state.active && ['idle', 'error', 'closed'].includes(state.status) };
      },
      archiveAgent: async (id: string) => { f.archived.push(id); f.states.delete(id); },
    });
    const draining = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
    assert.equal(draining.phase, 'working');
    assert.ok(isDispositionActive(draining));
    assert.equal(draining.disposition?.status, 'draining');
    // Ordinary controls honor the fence: resolution retry paths reject fenced tasks.
    await assert.rejects(f.engine.performTaskControl({ taskId: task.id, version: draining.version, action: 'restart', role: 'worker', reason: 'Resume the retained worker', instruction: 'retry' }), /A cancel or supersede disposition owns this task/);
    await f.engine.wake();
    assert.equal(f.store.runs(task.id).length, 0);
    assert.equal(f.store.task(task.id).phase, 'working');
    // The worker stops; resume reconciles the same persisted effects.
    f.idle(task.agentId!);
    const done = await resumeDispositions(f.store, deps).then(() => f.store.task(task.id));
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.disposition?.status, 'complete');
    assert.ok(f.archived.includes(task.agentId!));
  } finally { await f.close(); }
});

test('an errored worker with no live turn drains and archives without waiting on the dead session', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Errored duplicate');
    // Queue #606: the provider wave left the worker errored with no active
    // turn and no pending permission. It cannot write, so the archive must
    // not wait on it — the drain completes and the thread is archived.
    f.states.set(task.agentId!, { id: task.agentId!, workspaceId: null, status: 'error', error: 'Connection error', active: false, permissions: false });
    const deps = stubDeps({
      observeAgent: async (id: string) => {
        const state = f.states.get(id);
        if (!state) return { stopped: true };
        return { stopped: !state.active && ['idle', 'error', 'closed'].includes(state.status) };
      },
      archiveAgent: async (id: string) => { f.archived.push(id); f.states.delete(id); },
    });
    const done = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.disposition?.status, 'complete');
    assert.ok(f.archived.includes(task.agentId!), 'the errored thread is archived');
    assert.deepEqual(deps.archived, [task.workspaceId], 'the proved-empty workspace is archived');
  } finally { await f.close(); }
});

test('an errored worker holding a permission still holds draining until it is resolved', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Errored duplicate awaiting permission');
    f.states.set(task.agentId!, { id: task.agentId!, workspaceId: null, status: 'error', error: 'Connection error', active: false, permissions: true });
    const deps = stubDeps({
      observeAgent: async (id: string) => {
        const state = f.states.get(id);
        if (!state) return { stopped: true };
        return { stopped: !state.active && !state.permissions && ['idle', 'error', 'closed'].includes(state.status) };
      },
      archiveAgent: async (id: string) => { f.archived.push(id); f.states.delete(id); },
    });
    const draining = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
    assert.equal(draining.disposition?.status, 'draining');
    await resumeDispositions(f.store, deps);
    assert.equal(f.store.task(task.id).disposition?.status, 'draining', 'a permission-pending error still owns its thread');
    assert.deepEqual(f.archived, [], 'nothing is archived while the permission is pending');
  } finally { await f.close(); }
});

test('drain reuses its pending stop intent and an operator can withdraw the cancel', async () => {
  const f = fixture();
  try {
    assert.equal(controlHasExternalEffect({ action: 'withdraw_cancel' }), true, 'withdrawal is durably serialized with task lifecycle work');
    const task = dispatched(f.store, 'Reversible cancellation');
    f.running(task.agentId!);
    const deps = stubDeps({
      observeAgent: async (id: string) => {
        const state = f.states.get(id);
        if (!state) return { stopped: true };
        return { stopped: !state.active && ['idle', 'error', 'closed'].includes(state.status) };
      },
    });
    const draining = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    assert.equal(draining.disposition?.status, 'draining');
    assert.equal(draining.disposition?.effects.filter(effect => effect.kind === 'stop_thread' && effect.result === null).length, 1);

    await resumeDispositions(f.store, deps);
    await resumeDispositions(f.store, deps);
    const stillDraining = f.store.task(task.id);
    assert.equal(stillDraining.disposition?.effects.filter(effect => effect.kind === 'stop_thread').length, 1);

    f.store.setMeta('paused', true);
    const withdrawn = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: stillDraining.version, action: 'withdraw_cancel', reason: 'Planner reversed the cancellation',
    }));
    assert.equal(withdrawn.disposition, null);
    assert.equal(withdrawn.phase, 'working', 'withdrawal clears only the fence so the worker can continue');
    assert.ok(withdrawn.version > stillDraining.version);
    const event = f.store.events(task.id).find(item => item.kind === 'disposition_withdrawn');
    assert.match(event?.detail ?? '', /Planner reversed the cancellation/);
    assert.ok(f.store.events(task.id).some(item => item.kind === 'operator_control' && item.detail === 'withdraw_cancel'));
  } finally { await f.close(); }
});

test('ls-remote parse skips peeled tags; post-disposition diff watches only the queue branch and tags', () => {
  const sha = 'a'.repeat(40);
  const moved = 'b'.repeat(40);
  const parsed = parseLsRemote([
    `${sha}\trefs/heads/ns-task`,
    `${sha}\trefs/heads/main`,
    `${sha}\trefs/tags/v0.11.0`,
    `${sha}\trefs/tags/v0.11.0^{}`,
    'not-a-ref',
  ].join('\n'));
  assert.deepEqual(parsed, [
    { sha, ref: 'refs/heads/ns-task' },
    { sha, ref: 'refs/heads/main' },
    { sha, ref: 'refs/tags/v0.11.0' },
  ]);
  const found = postDispositionRefDiff(
    [{ sha, ref: 'refs/heads/ns-task' }],
    [{ sha: moved, ref: 'refs/heads/ns-task' }, { sha: moved, ref: 'refs/heads/main' }, { sha: moved, ref: 'refs/tags/v0.11.0' }],
    'ns-task', [], '2026-09-27T17:36:00.000Z',
  );
  assert.deepEqual(found.map(item => item.ref).sort(), ['refs/heads/ns-task', 'refs/tags/v0.11.0']);
});

test('drain interrupts the active turn once and withdraw continues that worker', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Live worker');
    f.running(task.agentId!);
    const draining = await f.engine.disposeTask({ taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    assert.equal(draining.disposition?.status, 'draining');
    assert.equal(f.interrupts.length, 1);
    assert.equal(f.interrupts[0]!.agentId, task.agentId);
    assert.equal(f.interrupts[0]!.messageId, `ns-stop-${task.id}-${task.agentId}`);
    assert.match(f.interrupts[0]!.text, /this task has been cancelled/);
    assert.match(f.interrupts[0]!.text, /Do not commit, push, tag, or create a release/);
    assert.ok(f.store.events(task.id).some(item => item.kind === 'disposition_turn_interrupted' && item.detail === task.agentId));
    assert.equal(draining.disposition?.effects.filter(effect => effect.kind === 'stop_thread' && effect.result === null).length, 1);
    assert.match(f.store.events(task.id).find(item => item.kind === 'disposition_draining')?.detail ?? '', /Interrupted owned turns/);

    await resumeDispositions(f.store, {
      ...stubDeps({
        observeAgent: async (id: string) => {
          const state = f.states.get(id);
          if (!state) return { stopped: true };
          return { stopped: !state.active && ['idle', 'error', 'closed'].includes(state.status) };
        },
      }),
      interruptTurn: (agentId, messageId, text) => f.engine.adapter.interruptAndContinue!(agentId, messageId, text),
    });
    assert.equal(f.interrupts.length, 1, 'a pending stop is not interrupted again');

    f.store.setMeta('paused', true);
    const withdrawn = await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: f.store.task(task.id).version, action: 'withdraw_cancel', reason: 'Planner reversed the cancellation',
    }));
    assert.equal(withdrawn.disposition, null);
    assert.equal(withdrawn.phase, 'working');
    assert.equal(f.interrupts.length, 2);
    assert.equal(f.interrupts[1]!.agentId, task.agentId);
    assert.equal(f.interrupts[1]!.messageId, `ns-withdraw-${task.id}-${withdrawn.version}`);
    assert.match(f.interrupts[1]!.text, /cancellation was withdrawn/);
    assert.ok(f.store.events(task.id).some(item => item.kind === 'disposition_withdraw_continued' && item.detail === task.agentId));
  } finally { await f.close(); }
});

test('an uncertain interrupt holds attention on the pending stop_thread', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Uncertain interrupt');
    f.running(task.agentId!);
    const deps = stubDeps({
      observeAgent: async () => ({ stopped: false }),
      interruptTurn: async () => { throw new Error('Paseo interrupt failed'); },
    });
    const held = await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate work' });
    assert.equal(held.disposition?.status, 'needs_attention');
    assert.match(held.disposition?.attention ?? '', /Turn interrupt is uncertain: Paseo interrupt failed/);
    const stop = held.disposition?.effects.find(effect => effect.kind === 'stop_thread' && effect.target === task.agentId);
    assert.equal(stop?.uncertain, true);
    assert.ok(!f.store.events(task.id).some(item => item.kind === 'disposition_turn_interrupted'));
  } finally { await f.close(); }
});

test('drain records a tag pushed after the origin snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-disposition-refs-'));
  const repo = join(root, 'repo'), remote = join(root, 'origin.git');
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    run(root, 'init', '--bare', remote); run(root, 'init', repo);
    run(repo, 'config', 'user.email', 'test@example.com'); run(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'base.txt'), 'base'); run(repo, 'add', '.'); run(repo, 'commit', '-m', 'base');
    run(repo, 'remote', 'add', 'origin', remote);
    const task = dispatched(store, 'Release tag after cancel', repo);
    run(repo, 'checkout', '-b', task.branch);
    run(repo, 'push', '-u', 'origin', task.branch);
    const assigned = store.update(task.id, { directory: repo, phase: 'working' });
    const interrupts: string[] = [];
    const deps = stubDeps({
      observeAgent: async () => ({ stopped: false }),
      interruptTurn: async (agentId) => { interrupts.push(agentId); },
      listRemoteRefs: (item) => listOriginRefs(item),
    });
    const draining = await requestDisposition(store, deps, { taskId: assigned.id, version: assigned.version, action: 'cancel', reason: 'Superseded' });
    assert.equal(draining.disposition?.status, 'draining');
    assert.equal(interrupts.length, 1);
    assert.ok(draining.disposition?.refSnapshot?.some(item => item.ref === `refs/heads/${task.branch}`));
    assert.equal(draining.disposition?.postDispositionRefs.length, 0);

    writeFileSync(join(repo, 'release.txt'), 'v0.11.0'); run(repo, 'add', '.'); run(repo, 'commit', '-m', 'release: v0.11.0');
    run(repo, 'tag', 'v0.11.0');
    run(repo, 'push', 'origin', task.branch);
    run(repo, 'push', 'origin', 'v0.11.0');
    const tagSha = run(repo, 'rev-parse', 'refs/tags/v0.11.0');

    await resumeDispositions(store, deps);
    const observed = store.task(task.id);
    assert.equal(observed.disposition?.status, 'draining');
    assert.equal(interrupts.length, 1, 'interrupt is not repeated while the stop is pending');
    const refs = observed.disposition?.postDispositionRefs ?? [];
    assert.ok(refs.some(item => item.ref === 'refs/tags/v0.11.0' && item.sha === tagSha));
    assert.ok(refs.some(item => item.ref === `refs/heads/${task.branch}`));
    assert.ok(!refs.some(item => item.ref === 'refs/heads/main' || item.ref.endsWith('/HEAD')));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cancellation withdrawal is refused after a thread archive has landed', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Irreversible cancellation');
    const idleCoordinator = 'stopped-coordinator';
    const withCoordinator = f.store.update(task.id, { coordinatorAgentId: idleCoordinator });
    f.running(task.agentId!);
    f.idle(idleCoordinator);
    const deps = stubDeps({
      observeAgent: async (id: string) => {
        const state = f.states.get(id);
        if (!state) return { stopped: true };
        return { stopped: !state.active && ['idle', 'error', 'closed'].includes(state.status) };
      },
    });
    const draining = await requestDisposition(f.store, deps, { taskId: withCoordinator.id, version: withCoordinator.version, action: 'cancel', reason: 'Duplicate work' });
    assert.equal(draining.disposition?.status, 'draining');
    assert.ok(draining.disposition?.effects.some(effect => effect.kind === 'archive_thread' && effect.target === idleCoordinator && effect.result));

    f.store.setMeta('paused', true);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: draining.version, action: 'withdraw_cancel', reason: 'Planner reversed the cancellation',
    })), /after a disposition effect has landed/);
    assert.equal(f.store.task(task.id).disposition?.status, 'draining');
  } finally { await f.close(); }
});

test('incident fixture: one supersede drains the empty duplicate and preserves the original byte for byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const original = dispatched(store, 'Scoped PR revision');
    const before = JSON.stringify(store.task(original.id));
    const duplicate = dispatched(store, 'Scoped PR revision');
    const dependant = store.insert(submit('Follow-up'), 'host', 'handoff', base);
    store.updateDependencies(store.task(dependant.id), [duplicate.id]);
    const deps = stubDeps({
      proveWorkspaceEmpty: async (task: Task) => task.id === duplicate.id
        ? { empty: true, detail: 'clean queue-owned workspace at planning base, no PR' }
        : { empty: false, detail: 'Workspace holds dirty implementation; preserved without archive' },
    });
    const superseded = await requestDisposition(store, deps, {
      taskId: duplicate.id, version: duplicate.version, action: 'supersede',
      reason: 'Timed-out submit duplicated the scoped revision', replacementTaskId: original.id,
    });
    assert.equal(superseded.phase, 'cancelled');
    assert.equal(superseded.disposition?.kind, 'supersede');
    assert.equal(superseded.disposition?.replacementTaskId, original.id);
    assert.equal(superseded.disposition?.replacementBranch, store.task(original.id).branch);
    assert.match(superseded.reason, new RegExp(`Superseded by ${original.id}`));
    assert.deepEqual(deps.archived, [duplicate.workspaceId]);
    assert.equal(JSON.stringify(store.task(original.id)), before);
    // Only done satisfies dependants; the cancelled duplicate keeps them waiting.
    assert.match(store.dependencyWait(store.task(dependant.id)), /waiting/i);
    assert.notEqual(store.dependencyWait(store.task(dependant.id)), '');
    // An identical retry at the returned version reports the stored disposition.
    const retry = await requestDisposition(store, deps, {
      taskId: duplicate.id, version: superseded.version, action: 'supersede',
      reason: 'Timed-out submit duplicated the scoped revision', replacementTaskId: original.id,
    });
    assert.equal(retry.version, superseded.version);
    // A conflicting request fails without changing state.
    await assert.rejects(requestDisposition(store, deps, {
      taskId: duplicate.id, version: retry.version, action: 'cancel', reason: 'Different reason',
    }), /already complete/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart resumes an incomplete disposition from its recorded step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const task = dispatched(store, 'Duplicate');
  // Persist the fence, then stop before the drain makes progress.
  const deps = stubDeps({ observeAgent: async () => ({ stopped: false }) });
  const fenced = await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
  assert.ok(isDispositionActive(fenced));
  store.close();
  // A fresh process reopens the same database: schema and fence survive.
  const reopened = new Store(join(dir, 'queue.sqlite'));
  try {
    assert.ok(isDispositionActive(reopened.task(task.id)));
    const idle = stubDeps();
    await resumeDispositions(reopened, idle);
    const done = reopened.task(task.id);
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.disposition?.status, 'complete');
    assert.deepEqual(idle.archived, [task.workspaceId]);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart leaves an attention disposition quiet until an explicit retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = dispatched(store, 'Held cancellation');
    let attempts = 0;
    let hold = true;
    const deps = stubDeps({
      hooks: { emit: async () => { attempts++; return { hold, attention: false, records: [] as unknown[] }; } },
    });
    const held = await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
    assert.equal(held.disposition?.status, 'needs_attention');
    assert.equal(attempts, 1);

    await resumeDispositions(store, deps);
    await resumeDispositions(store, deps);
    assert.equal(attempts, 1);
    assert.equal(store.task(task.id).disposition?.status, 'needs_attention');

    hold = false;
    const done = await requestDisposition(store, deps, { taskId: task.id, version: held.version, action: 'cancel', reason: 'Duplicate' });
    assert.equal(attempts, 2);
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.disposition?.status, 'complete');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('refusals fail before intent: stale versions, conflicts, invalid replacements, done tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = dispatched(store, 'Work');
    const other = dispatched(store, 'Other', '/elsewhere');
    const deps = stubDeps();
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version + 1, action: 'cancel', reason: 'Nope' }), /Task changed/);
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: '' }), /requires an operator reason/);
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'supersede', reason: 'x' }), /requires the retained replacement/);
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'supersede', reason: 'x', replacementTaskId: task.id }), /cannot supersede itself/);
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'supersede', reason: 'x', replacementTaskId: 'missing' }), /does not exist/);
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'supersede', reason: 'x', replacementTaskId: other.id }), /same repository/);
    await assert.rejects(requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'x', workDisposition: 'retained_by_replacement' }), /only valid for supersession/);
    const done = store.update(task.id, { phase: 'done' });
    await assert.rejects(requestDisposition(store, deps, { taskId: done.id, version: done.version, action: 'cancel', reason: 'x' }), /already done/);
    assert.equal(store.events(task.id).filter((event) => event.kind === 'disposition_requested').length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('dirty, review-entry, shared and uncertain workspaces are preserved, never archived', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    for (const [name, proof] of [
      ['dirty', { empty: false, detail: 'Workspace worktree is dirty; preserved without archive' }],
      ['uncertain-then-preserved', { empty: false, detail: '', uncertain: 'Work evidence is uncertain: lookup timed out' }],
    ] as const) {
      const task = dispatched(store, name);
      const deps = stubDeps({ proveWorkspaceEmpty: async () => ({ ...proof }) });
      const result = await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Withdraw' });
      if (name.startsWith('uncertain')) {
        assert.ok(isDispositionActive(result));
        assert.equal(result.disposition?.status, 'needs_attention');
        assert.equal(result.phase, 'needs_attention');
      } else {
        assert.equal(result.phase, 'cancelled');
        assert.equal(result.disposition?.workspaceArchived, false);
        assert.match(result.disposition?.workspaceEvidence ?? '', /dirty/);
      }
      assert.deepEqual(deps.archived, []);
    }
    const external = dispatched(store, 'review-entry');
    const reviewed = store.update(external.id, { reviewEntry: reviewEntryFor(external) });
    const externalResult = await requestDisposition(store, stubDeps(), { taskId: reviewed.id, version: reviewed.version, action: 'cancel', reason: 'Withdraw' });
    assert.equal(externalResult.phase, 'cancelled');
    assert.match(externalResult.disposition?.workspaceEvidence ?? '', /Review-entry workspace preserved/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a late callback is evidence without authority and never advances the fenced task', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, 'Duplicate');
    f.running(task.agentId!);
    f.store.setCredential('run-1', 'secret');
    const deps = stubDeps({
      observeAgent: async () => ({ stopped: false }),
    });
    await requestDisposition(f.store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
    const input = { eventId: randomUUID(), taskId: task.id, runId: 'run-1', status: 'blocked' as const, summary: 'Late report' };
    const receipt = await f.engine.complete(input, 'secret');
    assert.deepEqual(receipt, { accepted: true, eventId: input.eventId });
    assert.equal(f.store.task(task.id).completion, null);
    assert.ok(isDispositionActive(f.store.task(task.id)));
    assert.ok(f.store.events(task.id).some((event) => event.kind === 'late_callback_evidence'));
    const duplicate = await f.engine.complete(input, 'secret');
    assert.deepEqual(duplicate, receipt);
    assert.equal(f.store.events(task.id).filter((event) => event.kind === 'late_callback_evidence').length, 1);
  } finally { await f.close(); }
});

test('a required cancellation hook holds the fence; retry settles and completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = dispatched(store, 'Duplicate');
    let hold = true;
    const deps = stubDeps({ hooks: { emit: async () => ({ hold, attention: hold, records: [] as unknown[] }) } });
    const held = await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Duplicate' });
    assert.ok(isDispositionActive(held));
    assert.equal(held.disposition?.status, 'needs_attention');
    assert.equal(held.disposition?.hookEmitted, false);
    hold = false;
    const done = await requestDisposition(store, deps, { taskId: held.id, version: held.version, action: 'cancel', reason: 'Duplicate' });
    assert.equal(done.phase, 'cancelled');
    assert.equal(done.disposition?.hookEmitted, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a refused pre-workspace task can be superseded when its cancellation hook never passed integration preflight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const malformed = store.insert(submit('Malformed'), 'host', 'handoff', base);
    const replacement = store.insert(submit('Replacement'), 'host', 'handoff', base);
    const record = (event: 'task.pre_dispatch' | 'task.cancelled', mode: 'read_only' | 'integration_write', error: string) => {
      const eventId = randomUUID();
      const refusal = 'handoff does not reference a roadmap task';
      return hookRecordSchema.parse({
      id: randomUUID(), taskId: malformed.id, hookId: event === 'task.pre_dispatch' ? 'admission' : 'closeout', event,
      eventId, occurrence: 1, mode, delivery: 'required', state: 'blocked',
      manifest: { path: '.paseo/queue.json', commit: base, digest: `sha256:${'a'.repeat(64)}` },
      program: { kind: 'repository', executable: { path: '.paseo/hooks/policy', commit: base, digest: `sha256:${'c'.repeat(64)}` }, argv: [] }, instruction: null,
      baseBranch: 'main', baseCommit: base, attempt: event === 'task.cancelled' ? 16 : 1,
      timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: mode === 'integration_write' ? ['docs/'] : [],
      commitSubject: mode === 'integration_write' ? { prefix: 'queue: cancel', maxBytes: 80 } : null,
      eventDigest: 'b'.repeat(64), eventPayload: null,
      workspace: event === 'task.cancelled' ? { path: '/repo/.git/queue-hooks/cancelled', head: base } : null, processId: null,
      result: { schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'blocked', summary: refusal, metadata: {}, changedPaths: [], commitSubjectSuffix: null },
      commit: null, remote: null,
      summary: error, error, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reconciledAt: null,
    });
    };
    store.putHookEvent(record('task.pre_dispatch', 'read_only', 'handoff does not reference a roadmap task'));
    const cancellation = record('task.cancelled', 'integration_write', 'Integration write requires a clean synchronized base: Error: Integration checkout has tracked or untracked changes');
    const deps = stubDeps({ hooks: { emit: async () => ({ hold: true, attention: true, records: [cancellation] }) } });

    const result = await requestDisposition(store, deps, {
      taskId: malformed.id, version: malformed.version, action: 'supersede', reason: 'Corrected immutable submission', replacementTaskId: replacement.id,
    });

    assert.equal(result.phase, 'cancelled');
    assert.equal(result.disposition?.status, 'complete');
    assert.equal(result.disposition?.replacementTaskId, replacement.id);
    assert.equal(result.disposition?.workspaceEvidence, 'No task workspace was created');
    assert.ok(store.events(result.id).some(event => event.kind === 'disposition_hook_refusal_reconciled'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an instructionless review-entry task can preserve work when cancellation repeats its required blocked-hook refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const inserted = dispatched(store, 'Review-entry task');
    const task = store.update(inserted.id, {
      reviewEntry: reviewEntryFor(inserted),
      completion: { eventId: 'worker-blocked', taskId: inserted.id, runId: 'run-1', status: 'blocked', summary: 'Legacy blocker' },
    });
    const refusal = 'event carries no committed instruction artifact';
    const record = (event: 'task.blocked' | 'task.cancelled') => {
      const eventId = randomUUID();
      return hookRecordSchema.parse({
        id: randomUUID(), taskId: task.id, hookId: 'lifecycle-state', event,
        eventId, occurrence: 1, mode: 'integration_write', delivery: 'required', state: 'blocked',
        manifest: { path: '.paseo/queue.json', commit: base, digest: `sha256:${'a'.repeat(64)}` },
        program: { kind: 'repository', executable: { path: '.paseo/hooks/policy', commit: base, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
        instruction: null, baseBranch: 'main', baseCommit: base, attempt: 1,
        timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: ['docs/'],
        commitSubject: { prefix: 'queue: lifecycle', maxBytes: 80 }, eventDigest: 'b'.repeat(64), eventPayload: null,
        workspace: { path: `/repo/.git/queue-hooks/${eventId}`, head: base }, processId: null,
        result: { schema: 'paseo.queue.hook-result.v1', eventId, outcome: 'blocked', summary: refusal, metadata: {}, changedPaths: [], commitSubjectSuffix: null },
        commit: null, remote: null, summary: refusal, error: refusal,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reconciledAt: null,
      });
    };
    store.putHookEvent(record('task.blocked'));
    const cancellation = record('task.cancelled');
    const deps = stubDeps({ hooks: { emit: async () => ({ hold: true, attention: true, records: [cancellation] }) } });

    const result = await requestDisposition(store, deps, {
      taskId: task.id, version: task.version, action: 'cancel', reason: 'Cross-repository replacement complete', workDisposition: 'preserve',
    });

    assert.equal(result.phase, 'cancelled');
    assert.equal(result.disposition?.status, 'complete');
    assert.match(result.disposition?.workspaceEvidence ?? '', /Review-entry workspace preserved/);
    assert.ok(store.events(result.id).some(event => event.kind === 'disposition_hook_refusal_reconciled'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('MCP dispose tools share the service contract and reject self-disposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const states = new Map<string, AgentObservation>();
  const worker = dispatched(store, 'Target');
  states.set(worker.agentId!, { id: worker.agentId!, workspaceId: worker.workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  const withdrawable = dispatched(store, 'Withdrawable target');
  states.set(withdrawable.agentId!, { id: withdrawable.agentId!, workspaceId: withdrawable.workspaceId, status: 'running', active: true, permissions: false, error: '' });
  const caller = dispatched(store, 'Caller');
  states.set(caller.agentId!, { id: caller.agentId!, workspaceId: caller.workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  const engine = new Engine(store, {
    observe: async (id: string) => { const state = states.get(id); if (!state) throw new Error('Agent was not found'); return state; },
    archiveAgent: async (id: string) => { states.delete(id); },
  } as unknown as Adapter, 0);
  const socket = join(dir, 'callback.sock');
  const binding = join(dir, 'binding.json');
  store.setCredential('run-caller', 'caller-secret');
  // Point the caller binding at the caller's legacy worker run.
  store.update(caller.id, { runId: 'run-caller' });
  writeFileSync(binding, JSON.stringify({ socketPath: socket, taskId: caller.id, runId: 'run-caller', token: 'caller-secret' }), { mode: 0o600 });
  const stop = await startCallbacks(socket, join(dir, 'helper.mjs'), engine);
  try {
    const call = (path: string, payload: unknown, token = 'caller-secret') => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify(payload);
      const pending = httpRequest({ socketPath: socket, path, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      pending.on('error', reject);
      pending.end(body);
    });
    const inspected = await call('/task-disposition', { callerTaskId: caller.id, callerRunId: 'run-caller', taskId: worker.id });
    assert.equal(inspected.status, 200);
    assert.equal(JSON.parse(inspected.body).version, store.task(worker.id).version);
    // A worker cannot dispose its own task.
    const selfish = await call('/dispose-task', { callerTaskId: caller.id, callerRunId: 'run-caller', taskId: caller.id, version: store.task(caller.id).version, action: 'cancel', reason: 'Self' });
    assert.equal(selfish.status, 409);
    const selfishWithdrawal = await call('/dispose-task', { callerTaskId: caller.id, callerRunId: 'run-caller', taskId: caller.id, version: store.task(caller.id).version, action: 'withdraw_cancel', reason: 'Self' });
    assert.equal(selfishWithdrawal.status, 409);
    const disposed = await call('/dispose-task', { callerTaskId: caller.id, callerRunId: 'run-caller', taskId: worker.id, version: store.task(worker.id).version, action: 'cancel', reason: 'Operator withdrew the duplicate' });
    assert.equal(disposed.status, 200);
    assert.equal(store.task(worker.id).phase, 'cancelled');
    assert.equal(store.task(caller.id).phase, 'working');
    const pending = await call('/dispose-task', { callerTaskId: caller.id, callerRunId: 'run-caller', taskId: withdrawable.id, version: store.task(withdrawable.id).version, action: 'cancel', reason: 'Planner cancelled duplicate' });
    assert.equal(pending.status, 200);
    assert.equal(store.task(withdrawable.id).disposition?.status, 'draining');
    const withdrawn = await call('/dispose-task', { callerTaskId: caller.id, callerRunId: 'run-caller', taskId: withdrawable.id, version: store.task(withdrawable.id).version, action: 'withdraw_cancel', reason: 'Planner reversed the cancellation' });
    assert.equal(withdrawn.status, 200);
    assert.equal(store.task(withdrawable.id).phase, 'working');
    assert.equal(store.task(withdrawable.id).disposition, null);
    assert.match(store.events(withdrawable.id).find(event => event.kind === 'disposition_withdrawn')?.detail ?? '', /Queue run run-caller: Planner reversed the cancellation/);
  } finally { await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a cancellation published after an attention hold completes without re-emitting it', async () => {
  const store = new Store(':memory:');
  try {
    const task = store.insert(submit('Superseded pilot'), 'host', 'handoff', base);
    let settled = false, emissions = 0;
    const deps = stubDeps({ hooks: {
      emit: async () => { emissions++; return { hold: true, attention: true, records: [] }; },
      cancellationEmissionSettled: () => settled,
    } });
    await requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Superseded before dispatch' });
    await resumeDispositions(store, deps);
    assert.equal(store.task(task.id).disposition?.status, 'needs_attention');
    settled = true;
    await resumeDispositions(store, deps);
    assert.equal(store.task(task.id).phase, 'cancelled');
    assert.equal(store.task(task.id).disposition?.status, 'complete');
    assert.equal(store.task(task.id).disposition?.hookEmitted, true);
    await resumeDispositions(store, deps);
    assert.equal(emissions, 1, 'published hook must not be emitted against a new base');
  } finally { store.close(); }
});

test('a pass never runs a second cancellation hook while the operator step is still emitting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-disposition-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = store.insert(submit('Cancelled before dispatch'), 'host', 'handoff', base);
    let emissions = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deps = stubDeps({ hooks: { emit: async () => { emissions++; await gate; return { hold: false, attention: false, records: [] as unknown[] }; } } });
    const operator = requestDisposition(store, deps, { taskId: task.id, version: task.version, action: 'cancel', reason: 'Superseded before dispatch' });
    while (emissions === 0) await new Promise(resolve => setImmediate(resolve));
    // The live incident: the engine pass reached the same disposition mid-emission.
    const pass = resumeDispositions(store, deps);
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(emissions, 1, 'the pass skips a disposition whose step is in flight');
    release();
    const [done] = await Promise.all([operator, pass]);
    assert.equal(done.phase, 'cancelled');
    assert.equal(emissions, 1, 'the occurrence ran exactly once');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

