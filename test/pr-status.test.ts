import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPrStates} from '../core/forge/pr-status';
import type {Task} from '../shared/contracts';

function task(number:number,mergedCommit:string|null=null):Task {
 return {id:String(number),repoPath:'/repo',phase:'blocked',prUrl:`https://example.invalid/not-the-identity/${number}`,
  completion:{prNumber:number} as Task['completion'],resolution:{mergedCommit}} as Task;
}

test('PR display reads the recorded number and repository, including for blocked tasks',async()=>{
 const tasks=[task(1),task(2),task(3),task(5,'known-merge')];
 const calls:string[]=[];
 const states=await readPrStates(tasks,async(file,args,cwd)=>{
  assert.equal(file,'gh');assert.equal(cwd,'/repo');calls.push(args[2]);
  assert.ok(args.includes('canonical/project'));
  return JSON.stringify({state:({1:'OPEN',2:'CLOSED',3:'MERGED'} as Record<string,string>)[args[2]]});
 },async()=> 'canonical/project');
 assert.deepEqual(states,{'1':'OPEN','2':'CLOSED','3':'MERGED'});
 assert.deepEqual(calls,['1','2','3']);
});

test('PR display reports a failed task read instead of silently dropping it',async()=>{
 const failures:Error[]=[];
 const states=await readPrStates([task(4),task(6)],async(_file,args)=>{
  if(args[2]==='4')throw Error('GitHub unavailable');
  return JSON.stringify({state:'OPEN'});
 },async()=> 'canonical/project',error=>failures.push(error));
 assert.deepEqual(states,{'6':'OPEN'});
 assert.equal(failures.length,1);
 assert.match(failures[0].message,/task 4: Error: GitHub unavailable/);
});
