import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../shared/contracts';
import { fixture, git } from './support/retained-external-merge-fixture';
import { ownerEffectHook } from './support/review-entry-fixture';

for (const fault of ['unknown merge','dirty','switched','aliased']) {
  test(`descendant closeout refuses ${fault} without settlement`,{timeout:90000},async()=>{
    const f=await fixture();try{
      const before=f.runtime.store.task(f.taskId), runs=f.runtime.store.runs(f.taskId);
      let extra:Record<string,unknown>={};
      if(fault==='wrong head')extra={head:'a'.repeat(40)};
      if(fault==='unauthorized')extra={caller:'stranger'};
      if(fault==='unmerged')f.respond({...f.payload,merged:false});
      if(fault==='draft')f.respond({...f.payload,draft:true});
      if(fault==='wrong repository')f.respond({...f.payload,head:{...f.payload.head,repo:{full_name:'wrong/repo'}}});
      if(fault==='wrong branch')f.respond({...f.payload,head:{...f.payload.head,ref:'other'}});
      if(fault==='wrong base')f.respond({...f.payload,base:{...f.payload.base,ref:'other'}});
      if(fault==='wrong PR')f.respond({...f.payload,number:42});
      if(fault==='unknown merge')f.respond({...f.payload,merge_commit_sha:null});
      if(fault==='dirty')writeFileSync(join(f.workspace,'work.txt'),'dirty\n');
      if(fault==='switched')git(f.workspace,'checkout','--detach');
      if(fault==='aliased')f.setAlias();
      if(fault==='active')f.setState({status:'running',active:true,permissions:false});
      if(fault==='permission')f.setState({status:'idle',active:false,permissions:true});
      if(fault==='unknown')f.setState({status:'idle'});
      if(fault==='tool')f.setTool();
      const expected:Record<string,RegExp>={
        'wrong head':/differs from the exact head accepted/,'unauthorized':/owner thread|has none/,
        'unmerged':/positively merged/,'draft':/positively merged/,'wrong repository':/identity does not match/,
        'wrong branch':/identity does not match/,'wrong base':/identity does not match/,'wrong PR':/canonical task PR/,
        'unknown merge':/identity does not match/,'dirty':/dirty or switched/,'switched':/dirty or switched/,
        'aliased':/aliased or changed/,'active':/active, permission-holding/,'permission':/active, permission-holding/,
        'unknown':/active, permission-holding/,'tool':/live or unknown tool effects/,
      };
      await assert.rejects(f.runtime.taskControl(f.control(extra)),expected[fault]);
      assert.deepEqual(f.runtime.store.task(f.taskId),before);assert.deepEqual(f.runtime.store.runs(f.taskId),runs);
      assert.equal(f.counts().mergeCalls,0);
    }finally{await f.close();}
  });
}

