import type { CheckpointIntent, Run, Task } from '../../shared/contracts';
/** Handoff-mode prompt inputs whose rendered bytes are frozen in handoff-prompts.json (Spec 020 row 6). */
const base={id:'task',runId:'initial',title:'Build',originAgentId:'origin',coordinatorAgentId:'',dependsOn:['dep'],branch:'ns-task',baseBranch:'main',repoPath:'/repo',workspaceId:'workspace',directory:'/worktree',agentId:'worker',
  handoffPath:'docs/handoffs/build.md',planningCommit:'a'.repeat(40),instruction:null,retiredWorkers:[],skipPRReview:false,prUrl:'https://github.com/example/repo/pull/7',reason:'Address review',
  resumePrNumber:null,completion:{status:'ready_for_review',prNumber:7},phase:'reviewing',originError:'',notificationAgentId:null,originWorkspaceId:null,workerModel:'model-a',profile:{model:'model-a'},reviewEntry:null,
  resolution:{review:{summary:'Fix links',reviewCommentId:1},revisionPrRepair:false,revisionResumeUnpublished:false,externalMerge:false,mergedCommit:'b'.repeat(40),revisionInstruction:{id:'scoped-1',text:'Scoped ruling',createdAt:'2026-09-13T00:00:00.000Z',runId:'run-revision'}}} as unknown as Task;
export const handoffTask=base;
export const retiredTask={...base,retiredWorkers:[{agentId:'old',runId:'r0',profile:{model:'m'},reason:'Continue tests'}],resumePrNumber:7} as unknown as Task;
export const prePrTask={...base,completion:{status:'blocked'},resumePrNumber:null,reason:'Install dependencies only'} as unknown as Task;
export const runs=(['revision','reviewer','closeout','recovery'] as const).map(role=>({id:`run-${role}`,taskId:'task',role,generation:2,head:'c'.repeat(40),base:'d'.repeat(40),agentId:null,workspaceId:'workspace',instruction:role==='revision'?'Scoped ruling':null,profile:{model:'model-b'},status:'running',createdAt:'',lastObservedAt:null,active:null,idleSince:null,completion:null,released:false}) as unknown as Run);
export const intent={ordinal:1,createdAt:'2026-09-26T00:00:00.000Z',summary:'Parser landed',head:'e'.repeat(40)} as unknown as CheckpointIntent;
