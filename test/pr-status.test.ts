import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPrStates} from '../core/forge/pr-status';
import type {Task} from '../shared/contracts';
test('PR display uses forge state independently of blocked tasks and isolates lookup failures',async()=>{
 const tasks=[1,2,3,4,5].map(n=>({id:String(n),repoPath:'/repo',phase:'blocked',prUrl:`https://github.com/example/repo/pull/${n}`,resolution:{mergedCommit:n===5?'known-merge':null}} as Task));
 const calls:string[]=[];
 const states=await readPrStates(tasks,async(file,args,cwd)=>{
  assert.equal(file,'gh');assert.equal(cwd,'/repo');assert.ok(args.includes('example/repo'));calls.push(args[2]);
  if(args[2]==='4')throw Error('GitHub unavailable');
  return JSON.stringify({state:({1:'OPEN',2:'CLOSED',3:'MERGED'} as Record<string,string>)[args[2]]});
 });
 assert.deepEqual(states,{'1':'OPEN','2':'CLOSED','3':'MERGED'});
 assert.equal(calls.includes('5'),false);
 assert.equal(states['4'],undefined);
});
