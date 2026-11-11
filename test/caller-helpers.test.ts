import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { callerCliFixture } from './support/caller-cli-fixture';

for (const source of ['run','participant','host','none']) test(`submit, reparent and subscribe resolve ${source}`,async()=>{
  const f=await callerCliFixture();
  try {
    const helpers=[
      ['nucleus-submit.mjs',['--dry-run',join(f.dir,'synthetic.md')],'originAgentId'],
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
