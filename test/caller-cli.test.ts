import { test } from 'node:test';
import assert from 'node:assert/strict';
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
