import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReplacementSource } from '../core/git/index';
import type { Task } from '../shared/contracts';

test('replacement source proves its own repository, clean branch, planning ancestry and exact advertised head', async () => {
 const root=mkdtempSync(join(tmpdir(),'ns-replacement-source-'));
 const remote=join(root,'remote.git'), repo=join(root,'repo'), work=join(root,'work');
 const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git(root,'init','--bare',remote);git(root,'clone',remote,repo);
  git(repo,'config','user.email','fixture@example.test');git(repo,'config','user.name','Fixture');
  git(repo,'checkout','-b','main');writeFileSync(join(repo,'brief.md'),'approved\n');git(repo,'add','brief.md');git(repo,'commit','-m','base');
  const base=git(repo,'rev-parse','HEAD');git(repo,'push','origin','main');
  git(repo,'worktree','add','-b','task',work,'main');writeFileSync(join(work,'change.txt'),'work\n');git(work,'add','change.txt');git(work,'commit','-m','work');git(work,'push','origin','task');
  const head=git(work,'rev-parse','HEAD');
  const task={directory:work,repoPath:repo,branch:'task',baseBranch:'main',planningBase:base,planningCommit:base,handoffPath:'brief.md',handoffText:'approved',brief:null,repository:''} as Task;
  await verifyReplacementSource(task,head);
  writeFileSync(join(work,'change.txt'),'dirty\n');await assert.rejects(verifyReplacementSource(task,head),/dirty|clean/i);
  git(work,'checkout','--','change.txt');
  await assert.rejects(verifyReplacementSource(task,'f'.repeat(40)),/does not descend/i);
  git(work,'commit','--allow-empty','-m','unpublished');await assert.rejects(verifyReplacementSource(task,git(work,'rev-parse','HEAD')),/published|pushed/i);
  const foreign=join(root,'foreign');git(root,'init',foreign);
  await assert.rejects(verifyReplacementSource({...task,repoPath:foreign},git(work,'rev-parse','HEAD')),/another repository/);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
