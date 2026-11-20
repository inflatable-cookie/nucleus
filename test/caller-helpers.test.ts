import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { callerCliFixture } from './support/caller-cli-fixture';

for (const source of ['run','participant','host','none']) test(`submit, reparent and subscribe resolve ${source}`,async()=>{
  const f=await callerCliFixture();
  try {
    const helpers=[
      ['nucleus-submit.mjs',['--brief','--dry-run',join(f.dir,'synthetic-brief.md')],'originAgentId'],
      ['nucleus-reparent.mjs',['owner','--task','task','--reason','Synthetic ownership'],'caller'],
      ['nucleus-subscribe.mjs',['task','subscribe'],'agentId'],
    ] as const;
    for(const [script,args,field] of helpers){
      const result=await f.invoke(source,script,[...args]);
      if(source==='none'){assert.notEqual(result.code,0);assert.match(result.stderr,/Nucleus run or participant ticket.*host-supplied identity/);}
      else {assert.equal(result.code,1,script);assert.match(result.stderr,/Synthetic caller payload received/,script);assert.equal(f.calls.at(-1)!.input[field],f.caller(source));}
    }
    if(['run','participant'].includes(source))assert.equal(f.hostResolutions.length,0);
  } finally {await f.close();}
});


test('reparent helper parses both owner-change forms and the read-only inventory before it resolves a caller', async () => {
  const f = await callerCliFixture();
  try {
    const forms = [
      ['owner', '--task', 'task', '--reason', 'Synthetic ownership'],
      ['owner', '--project', 'project-c', '--from', 'old', '--reason', 'Planner handover'],
      ['--inventory', 'old', '--project', 'project-c'],
    ] as const;
    for (const args of forms) {
      const result = await f.invoke('none', 'nucleus-reparent.mjs', [...args]);
      assert.notEqual(result.code, 0, args.join(' '));
      assert.doesNotMatch(result.stderr, /Usage: nucleus helper reparent/, `the form parses: ${args.join(' ')}`);
      assert.match(result.stderr, /Nucleus run or participant ticket/, `the parse reaches caller resolution: ${args.join(' ')}`);
    }
    const taskForm = await f.invoke('run', 'nucleus-reparent.mjs', [...forms[0]]);
    assert.match(taskForm.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, 'queue.reparent');
    assert.equal(f.calls.at(-1)?.input.toAgentId, 'owner');
    assert.deepEqual(f.calls.at(-1)?.input.taskIds, ['task']);
    assert.equal(f.calls.at(-1)?.input.reason, 'Synthetic ownership');
    const projectForm = await f.invoke('run', 'nucleus-reparent.mjs', [...forms[1]]);
    assert.match(projectForm.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, 'queue.reparent');
    assert.equal(f.calls.at(-1)?.input.toAgentId, 'owner');
    assert.equal(f.calls.at(-1)?.input.project, 'project-c');
    assert.equal(f.calls.at(-1)?.input.fromAgentId, 'old');
    const inventory = await f.invoke('run', 'nucleus-reparent.mjs', [...forms[2]]);
    assert.match(inventory.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, 'queue.owner-inventory');
    assert.deepEqual(f.calls.at(-1)?.input, {
      agentId: 'old',
      caller: f.caller('run'),
      project: 'project-c',
    });
  } finally {
    await f.close();
  }
});

test('installed helper routes bulk disposal and subscription to their implementations', async () => {
  const f = await callerCliFixture();
  try {
    const bulk = await f.invoke('run', 'nucleus.mjs', ['helper', 'bulk-dispose', 'status', 'operation']);
    assert.match(bulk.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, 'queue.bulk-disposition-detail');
    const subscribe = await f.invoke('run', 'nucleus.mjs', ['helper', 'subscribe', 'task', 'subscribe']);
    assert.match(subscribe.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, 'queue.completion-subscription');
  } finally { await f.close(); }
});

test('checkout CLI points to installed nucleus on a service contract mismatch', async () => {
  const f = await callerCliFixture(true);
  try {
    const result = await f.invoke('none', 'queue-cli.mjs', ['snapshot']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /use the installed `nucleus` command/);
    assert.doesNotMatch(result.stderr, /incompatible with the running service/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
