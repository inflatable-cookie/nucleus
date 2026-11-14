import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { callerCliFixture } from './support/caller-cli-fixture';

const commands = [
  ['project.qa.run',{repository:'owner/repo'},'submitterAgentId'],
  ['queue.routing-grant',{action:'request',reason:'Within scope'},'caller'],
  ['task.register',{title:'Caller fixture',description:'Synthetic registration',complexity:'medium'},'caller'],
  ['task',{taskId:'task',action:'complete',reason:'Finished'},'caller'],
  ['task',{taskId:'task',action:'hold',reason:'Wait'},'agentId'],
  ['task',{taskId:'task',action:'keep_hold',reason:'Still waiting'},'agentId'],
  ['task',{taskId:'task',action:'stop',reason:'Stop'},'caller'],
  ['question.answer',{questionId:'question',answer:'Proceed',reason:'Within scope'},'caller'],
  ['task',{taskId:'task',action:'accept_receipt',relayed:true,note:'Operator authorized receipt'},'caller'],
  ['repository.rekey',{source:'owner/old',target:{origin:'owner/new'},expectedSourceRevision:null,idempotencyKey:'synthetic-rekey',reason:'Operator authorized'},'relayedBy'],
  ['lead.approve',{id:'lead',version:1,digest:'sha256:'+'a'.repeat(64),approver:'thread',note:'Operator authorized'},'approver'],
  ['decision.answer',{id:'decision',version:1,answer:'Proceed',answeredBy:'thread',note:'Operator authorized'},'answeredBy'],
  ['lead.submit',{repository:'owner/repo',title:'Synthetic brief',body:'---\ntitle: Synthetic brief\n---\n',agent:'thread',note:'Operator authorized'},'agent'],
  ['lead.promote-task',{id:'lead',note:'Operator authorized'},'agent'],
  ['papercut.promote-task',{id:'papercut',note:'Operator authorized',complexity:'medium'},'agent'],
  ['project.set-planner',{key:'project',agentId:'thread'},'setBy'],
] as const;

/**
 * Spec 050: every owner control records the calling thread, and an action that
 * has its own field keeps it too. The pre-send blocks ran in sequence, so a hold
 * carried both `agentId` and `caller`; the stamping table must not stop at the
 * first matching rule.
 */
for (const source of ['run','participant']) test(`owner controls stamp the calling thread beside their action field (${source})`,async()=>{
  const f=await callerCliFixture();
  try {
    const caller=f.caller(source);
    const cases=[
      [{taskId:'task',action:'hold',reason:'Wait'},{caller,agentId:caller}],
      [{taskId:'task',action:'keep_hold',reason:'Still waiting'},{caller,agentId:caller}],
      [{taskId:'task',action:'set_routing',critical:true,reason:'Review is critical'},{caller}],
      [{taskId:'task',action:'set_routing',scope:'general',complexity:'medium',reason:'Route it',note:'Operator authorized'},{caller,relayed:true}],
      [{taskId:'task',action:'exclude_worker',workerExclusion:{profileId:'synthetic-profile'},reason:'Excluded',note:'Operator authorized'},{caller,relayed:true}],
    ] as const;
    for(const [payload,expected] of cases){
      const result=await f.invoke(source,'queue-cli.mjs',['task','-'],payload);
      assert.equal(result.code,1,result.stderr);
      assert.match(result.stderr,/Synthetic caller payload received/);
      const input=f.calls.at(-1)!.input;
      for(const [field,value] of Object.entries(expected)) assert.equal(input[field],value,`${payload.action}: ${field}`);
      if(payload.action==='set_routing'&&'critical' in payload) assert.equal('relayed' in input,false,'a critical-only routing write is not relayed');
    }
  } finally {await f.close();}
});

for (const source of ['run','participant','host','none']) test(`every caller-bearing CLI command resolves ${source}`,async () => {
  const f=await callerCliFixture();
  try {
    for (const [method,payload,field] of commands) {
      const previous=f.calls.length;
      const result=await f.invoke(source,'queue-cli.mjs',[method,'-'],payload);
      if(source==='none') {
        assert.notEqual(result.code,0,method);
        assert.match(result.stderr,/Nucleus run or participant ticket.*host-supplied identity/,method);
        assert.equal(f.calls.length,previous);
      } else {
        if(method==='question.answer'&&source==='run') {assert.equal(result.code,0,result.stderr);assert.equal(f.callbacks.at(-1)!.path,'/answer');}
        else {assert.equal(result.code,1);assert.match(result.stderr,/Synthetic caller payload received/,method);assert.equal(f.calls.at(-1)!.input[field],f.caller(source),method);}
      }
    }
    if (['run','participant'].includes(source)) assert.equal(f.hostResolutions.length,0,'ticket identity must precede host identity');
  } finally {await f.close();}
});

test('a refused participant ticket cannot fall through to host identity or send a mutation',async()=>{
  const f=await callerCliFixture();
  try {
    f.revoke();
    const result=await f.invoke('participant','queue-cli.mjs',['project.set-planner','-'],{key:'project',agentId:'thread'},{PASEO_AGENT_ID:'host-fallback-thread'});
    assert.notEqual(result.code,0);assert.match(result.stderr,/revoked or invalid/);assert.equal(f.calls.length,0);assert.equal(f.hostResolutions.length,0);
  } finally {await f.close();}
});

test('CLI helpers prefer the current continuation ticket and refuse a mismatched run', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = await callerCliFixture();
  try {
    const currentTicket = join(f.dir, 'current-run.json');
    writeFileSync(currentTicket, JSON.stringify({ socketPath: join(f.dir, 'c'), token: 'synthetic-secret', taskId: 'task', runId: 'new-run' }));
    const request = { questionId: 'question', answer: 'Continue', reason: 'Within scope' };
    const accepted = await f.invoke('run', 'queue-cli.mjs', ['question.answer', '-'], request, {
      NUCLEUS_CONTINUATION_RUN_ID: 'new-run', NUCLEUS_CONTINUATION_TICKET: currentTicket,
    });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(f.callbacks.at(-1)!.input.runId, 'new-run');
    const before = f.callbacks.length;
    const refused = await f.invoke('run', 'queue-cli.mjs', ['question.answer', '-'], request, {
      NUCLEUS_CONTINUATION_RUN_ID: 'new-run', NUCLEUS_CONTINUATION_TICKET: join(f.dir, 'run.json'),
    });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Continuation ticket is for run run, not current run new-run/);
    assert.equal(f.callbacks.length, before, 'a stale ticket is refused before any callback');
  } finally { await f.close(); }
});

test('a ticket-based control reports the active roll before caller resolution and sends nothing', async () => {
  const f = await callerCliFixture();
  try {
    writeFileSync(`${f.dir}/queue-service-roll.json`, JSON.stringify({
      status: 'replacing', fromBuild: 'old-build', toBuild: 'new-build', digest: 'd'.repeat(16),
      at: new Date().toISOString(), detail: 'Replacing the service', deferrals: [],
    }));
    const result = await f.invoke('run', 'queue-cli.mjs', ['task', '-'], {
      taskId: 'task', action: 'complete', reason: 'Synthetic completion',
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /service roll in progress \(replacing, 0s elapsed\); retry shortly/);
    assert.match(result.stderr, /requested control was not applied/);
    assert.equal(f.callbacks.length, 0, 'the stale callback socket was not contacted');
    assert.equal(f.calls.length, 0, 'no service request was sent');
    assert.equal(f.hostResolutions.length, 0, 'ticket identity did not fall through to host lookup');
  } finally { await f.close(); }
});


for (const source of ['run','participant']) test(`a ${source} ticket takes precedence over a host identity`,async()=>{
  const f=await callerCliFixture();
  try {
    const result=await f.invoke(source,'queue-cli.mjs',['project.set-planner','-'],
      {key:'project',agentId:'thread'},{PASEO_AGENT_ID:'another-host-thread'});
    assert.equal(result.code,1,result.stderr);
    assert.match(result.stderr,/Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.input.setBy,f.caller(source));
    assert.equal(f.hostResolutions.length,0);
  } finally {await f.close();}
});
