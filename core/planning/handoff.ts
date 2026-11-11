import {readFile,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative} from 'node:path';
import {parseDocument} from 'yaml';
import {z} from 'zod';
import {git,validateSubmission,verifyPublishedPlanning} from '../git/index';
import {instructionForCommit,assertReviewSkipSupported} from '../hooks/hooks';
import {digest} from '../store/store';
import {briefDigest} from './brief';
import {BRIEF_MAX_LENGTH,capabilityLevelSchema,laneKeyListSchema,laneKeySchema,MAX_REVIEW_VERDICTS,reviewPassGateSchema,reviewVerdictsOptInSchema,scopeSchema,submissionRecordFromLegacy,submissionSchema,taskTitleSchema,type Submission} from '../../shared/contracts';
import {stageGoalSchema,stageDefinitionInputSchema,stageSubjectSetsSchema,stageDeclarationSchema,type StageDefinition} from '../stages';
const laneSelectionSchema=z.union([laneKeySchema,laneKeyListSchema,z.null()]);
/**
 * Spec 019 revision: frontmatter `queue.lane` takes a key or a list and `queue.lanes`
 * takes a list; giving both is refused. The resolved membership travels to the
 * submission as the one `lanes` list, in the order given and without duplicates.
 */
export function submissionQueueFields(queue:{lane?:string|string[]|null;lanes?:string[];[key:string]:unknown}):Record<string,unknown>{
 const {lane,lanes,stages:_stages,subjectSets:_subjectSets,goal:_goal,reportOnly:_reportOnly,reportLane:_reportLane,...rest}=queue;
 if(lane!==undefined&&lanes!==undefined)throw Error('Provide queue.lane or queue.lanes, not both');
 const resolved=lanes??(lane===undefined||lane===null?[]:Array.isArray(lane)?lane:[lane]);
 return {...rest,lanes:resolved};
}
/** Explain the limited routing effect of task-level preferences on proof-only work. */
export function proofOnlyPreferenceWarning(submission:Pick<Submission,'proofOnly'|'preferredProfileId'|'requirePreferred'>):string|null{
 if(!submission.proofOnly||(!submission.preferredProfileId&&!submission.requirePreferred))return null;
 return 'On proof-only tasks, preferredProfileId/requirePreferred bind only the GO-gate reviewer when requiresOperatorGo is set; the executor is always selected independently.';
}
const sections=['What This Thread Was Doing','Why It Matters','Current State','Boundaries','Important Context','Suggested Next Move','Completion Protocol'];
/**
 * Brief and handoff frontmatter names the task type `scope` with an optional
 * five-level `complexity`. Documents written before the rename (Tom 2026-10-12)
 * keep their bytes and name it `capability`; the preprocess renames that key and
 * refuses a document that carries both spellings.
 */
const renameLegacyQueueScope=(queue:unknown):unknown=>{
 if(!queue||typeof queue!=='object'||Array.isArray(queue))return queue;
 return submissionRecordFromLegacy(queue,'queue frontmatter');
};
const requireProofOnlyQueue=<T extends {proofOnly?:unknown;proofExecution?:unknown;requiresOperatorGo?:unknown}>(queue:T,ctx:z.RefinementCtx)=>{
 if(queue.proofOnly&&!queue.proofExecution)ctx.addIssue({code:'custom',path:['proofExecution'],message:'queue.proofOnly requires queue.proofExecution'});
 if(queue.requiresOperatorGo&&!queue.proofOnly)ctx.addIssue({code:'custom',path:['requiresOperatorGo'],message:'queue.requiresOperatorGo is only valid with queue.proofOnly'});
};
const refuseRetiredQueueFlags=<T extends {responsible?:boolean;manualVerification?:boolean;reviewVerdicts?:unknown;reviewPassGate?:unknown}>(queue:T,ctx:z.RefinementCtx)=>{
 if(queue.responsible===false)ctx.addIssue({code:'custom',path:['responsible'],message:'responsible: false is no longer supported; every task runs the responsible lifecycle'});
 if(queue.manualVerification===true)ctx.addIssue({code:'custom',path:['manualVerification'],message:'queue.manualVerification is no longer available; every task runs the responsible lifecycle'});
 if(queue.reviewVerdicts!==undefined)ctx.addIssue({code:'custom',path:['reviewVerdicts'],message:'queue.reviewVerdicts is no longer available; state the outcome and acceptance in prose in the brief body, and use queue.mergeHold for a needed hold'});
 if(queue.reviewPassGate!==undefined)ctx.addIssue({code:'custom',path:['reviewPassGate'],message:'queue.reviewPassGate is no longer available; state the acceptance conditions in prose in the brief body, and use queue.mergeHold for a needed hold'});
};
const queueFieldsObjectSchema=z.object({profileRequests:submissionSchema.shape.profileRequests,dependsOn:submissionSchema.shape.dependsOn.optional(),lane:laneSelectionSchema.optional(),lanes:laneKeyListSchema.optional(),laneDocuments:laneKeyListSchema.optional(),scope:scopeSchema.optional(),complexity:capabilityLevelSchema.nullable().optional(),preferredProfileId:z.string().optional(),requirePreferred:z.boolean().optional(),thinkingOptionId:z.string().optional(),skipPRReview:z.boolean().optional(),siblings:z.boolean().optional(),manualVerification:z.boolean().optional(),interactive:z.boolean().optional(),responsible:z.boolean().optional(),critical:z.boolean().optional(),reportOnly:z.boolean().optional(),reportLane:laneKeySchema.optional(),mergeHold:submissionSchema.shape.mergeHold,mergeHoldReason:submissionSchema.shape.mergeHoldReason,proofExecution:submissionSchema.shape.proofExecution,proofOnly:submissionSchema.shape.proofOnly,requiresOperatorGo:submissionSchema.shape.requiresOperatorGo,notifyOriginOnCloseout:z.boolean().optional(),reviewVerdicts:reviewVerdictsOptInSchema.optional(),reviewPassGate:reviewPassGateSchema.optional(),completionNotificationAgentIds:submissionSchema.shape.completionNotificationAgentIds.optional()}).strict();
const queueFieldsSchema=z.preprocess(renameLegacyQueueScope,queueFieldsObjectSchema.superRefine((queue,ctx)=>{
 requireProofOnlyQueue(queue,ctx);
 refuseRetiredQueueFlags(queue,ctx);
}));
const briefQueueFieldsSchema=z.preprocess(renameLegacyQueueScope,queueFieldsObjectSchema.extend({stages:z.array(stageDefinitionInputSchema).min(1).optional(),subjectSets:stageSubjectSetsSchema.optional(),goal:stageGoalSchema.optional(),
// Retired with the automatic-review-loop concept (2026-10-07): parsed inertly so
// historical briefs that carry it keep loading and amending. No code reads it and
// new briefs get no behaviour from it.
reviewContinuationIds:z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_REVIEW_VERDICTS).refine(ids=>new Set(ids).size===ids.length,'Review continuation ids must be unique').optional()}).transform((queue,ctx):Omit<typeof queue,'stages'>&{stages?:StageDefinition[]}=>{
 const {stages,...rest}=queue;
 if(stages===undefined)return rest;
 const declaration=stageDeclarationSchema.safeParse({stages,subjectSets:queue.subjectSets,goal:queue.goal});
 if(!declaration.success){
  for(const issue of declaration.error.issues)ctx.addIssue({...issue});
  return z.NEVER;
 }
 return {...rest,stages:declaration.data.stages};
}).superRefine((queue,ctx)=>{
 requireProofOnlyQueue(queue,ctx);
 refuseRetiredQueueFlags(queue,ctx);
 if(queue.goal!==undefined&&queue.stages===undefined)ctx.addIssue({code:'custom',path:['goal'],message:'queue.goal requires queue.stages (Spec 043)'});
 if(queue.subjectSets!==undefined&&queue.stages===undefined)ctx.addIssue({code:'custom',path:['subjectSets'],message:'queue.subjectSets requires queue.stages (Spec 043)'});
 if(queue.reportLane!==undefined&&!queue.reportOnly)ctx.addIssue({code:'custom',path:['reportLane'],message:'queue.reportLane requires queue.reportOnly: true'});
 if(queue.reportLane!==undefined&&!((queue.lanes??(queue.lane===undefined||queue.lane===null?[]:Array.isArray(queue.lane)?queue.lane:[queue.lane])).includes(queue.reportLane)))
  ctx.addIssue({code:'custom',path:['reportLane'],message:'queue.reportLane must also be attached through queue.lane or queue.lanes'});
 if(queue.reportOnly&&queue.interactive)ctx.addIssue({code:'custom',path:['interactive'],message:'queue.reportOnly cannot be combined with queue.interactive'});
}));
const requireMergeHoldReason=<T extends {mergeHold?:boolean;mergeHoldReason?:string}>(queue:T,ctx:z.RefinementCtx)=>{
 if(queue.mergeHold===true&&!queue.mergeHoldReason)ctx.addIssue({code:'custom',path:['mergeHoldReason'],message:'queue.mergeHold: true requires queue.mergeHoldReason (Spec 040)'});
};
// Historical document format: committed handoffs carry `kind: northstar-handoff`
// and may carry `queue_dispatch: northstar-queue`, so the parser and the frozen
// submission identities (`northstar-*`) keep those names readable permanently.
const metadataSchema=z.object({
 title:taskTitleSchema,kind:z.literal('northstar-handoff'),handoff_mode:z.literal('worker-pr-loop'),worker_mode:z.literal('implementation'),dispatch_authority:z.literal('orchestrator'),status:z.literal('ready-to-launch'),
 queue_dispatch:z.enum(['nucleus','northstar-queue']),queue_approval:z.string().trim().min(1),base_required:z.literal('pushed-main'),
 queue:queueFieldsSchema.superRefine(requireMergeHoldReason).default({}),
});
/**
 * A Queue-held brief carries only what Queue acts on. The handoff-transport fields
 * (kind, modes, dispatch authority, status, base requirement) describe a committed
 * handoff and say nothing about a brief. Queue imposes no heading structure on a
 * brief either; its shape belongs to the planning skill that writes it.
 */
const briefMetadataSchema=z.object({title:metadataSchema.shape.title,repository:z.string().optional(),queue_approval:metadataSchema.shape.queue_approval,queue:briefQueueFieldsSchema.superRefine(requireMergeHoldReason).default({})});
const draftMetadataSchema=briefMetadataSchema.omit({queue_approval:true}).extend({queue_approval:z.string().optional(),queue:briefQueueFieldsSchema.superRefine(requireMergeHoldReason).default({})});
/** Readable one-line summary of a validation failure, for an operator reading a client. */
function invalidFrontmatter(error:unknown){
  if(error&&typeof error==='object'&&Array.isArray((error as {issues?:unknown[]}).issues)){
    return (error as {issues:{path:(string|number)[];message:string}[]}).issues
      .map(issue=>`${issue.path.length?issue.path.join('.'):'frontmatter'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error?error.message:String(error);
}
export interface HandoffInput {hostId?:string;handoffPath?:string;briefPath?:string;repoPath?:string;originAgentId:string;coordinatorAgentId?:string;baseBranch:string;planningCommit?:string;dryRun:boolean;
 /** The origin identity's own source, filled by the submitting CLI from its environment. */
 originIdentity?:import('../../shared/host-kind').IdentitySource}
export type HeldBriefQueue = z.infer<typeof draftMetadataSchema>['queue'];
/**
 * Read `queue` policy from a Queue-held brief that is already admitted.
 * Lead promotion copies the lead body, which carries approval in provenance rather
 * than `queue_approval`; the draft schema already accepts that. Direct brief
 * submission still requires `queue_approval` via `parseNorthstarDocument(..., 'brief')`.
 */
export function heldBriefQueuePolicy(text:string):HeldBriefQueue{
 return parseNorthstarDocument(text,'draft').queue;
}
/** A report-only opt-in that the worker could not deliver (no attached lane, or a reportLane that will not be on the task). */
export function reportOnlyDeliveryRefusal(text:string,attachedLanes:readonly string[]):string|null{
 const policy=heldBriefQueuePolicy(text);
 if(!policy.reportOnly)return null;
 const lanes=[...new Set(attachedLanes)];
 if(policy.reportLane&&!lanes.includes(policy.reportLane))
  return `queue.reportLane ${policy.reportLane} is not attached; report_ready cannot deliver`;
 if(!lanes.length)return 'queue.reportOnly requires an attached lane so the worker can report_ready';
 return null;
}
/** Parse and validate a handoff (full historical Northstar frontmatter and seven sections) or a Queue-held brief (minimal frontmatter, any structure). */
export function parseNorthstarDocument(content:string,label:'handoff'|'brief'|'draft'):z.infer<typeof draftMetadataSchema>{
 const front=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);if(!front)throw Error(`Northstar ${label} frontmatter is required`);
 const doc=parseDocument(front[1],{uniqueKeys:true});if(doc.errors.length)throw Error(`Invalid or duplicate ${label} frontmatter`);
 let metadata:z.infer<typeof draftMetadataSchema>;
 try{metadata=(label==='draft'?draftMetadataSchema:label==='brief'?briefMetadataSchema:metadataSchema).parse(doc.toJS({maxAliasCount:0}));}
 catch(error){throw Error(`Invalid ${label} frontmatter: ${invalidFrontmatter(error)}`);}
 const body=content.slice(front[0].length);
 if(/\{\{[A-Z][A-Z0-9_]*\}\}/.test(content))throw Error(`Resolve ${label} template placeholders before submission`);
 if(label==='brief'||label==='draft'){if(!body.trim())throw Error('Brief body is empty');return metadata;}
 let fence='';const headings:string[]=[];
 for(const line of body.split(/\r?\n/)){const marker=line.match(/^\s*(`{3,}|~{3,})/);if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence='';continue;}if(!fence&&line.startsWith('## '))headings.push(line.slice(3).trim());}
 if(sections.some((section,i)=>headings[i]!==section||headings.filter(h=>h===section).length!==1))throw Error('Handoff must contain the seven Northstar sections in order');
 return metadata;
}
/** Validate draft content against the fetched pushed head without reading a loose brief file. */
export async function prepareDraftContent(input:{text:string;repoPath:string;baseBranch:string;originAgentId:string;draftId:string}) {
 if(!isAbsolute(input.repoPath))throw Error('Draft repository path must be absolute');
 const metadata=parseNorthstarDocument(input.text,'draft');
 const repoPath=await realpath(await git(input.repoPath,'rev-parse','--show-toplevel'));
 await git(repoPath,'check-ref-format','--branch',input.baseBranch);
 const checkoutBranch=await git(repoPath,'branch','--show-current');
 if(!checkoutBranch)throw Error('Brief planning requires a named integration checkout');
 if(await git(repoPath,'status','--porcelain'))throw Error('Integration checkout has uncommitted changes; brief planning must be a clean integration head');
 if(metadata.repository){
  const {repositoryOrigin}=await import('./lanes');
  const origin=await repositoryOrigin(repoPath);
  if(metadata.repository!==origin&&metadata.repository!==repoPath)throw Error('Brief repository does not match the target checkout');
 }
 let pushedHead:string;
 try{pushedHead=(await git(repoPath,'ls-remote','origin',`refs/heads/${input.baseBranch}`)).split(/\s+/)[0]??'';}
 catch(error){throw Error(`Brief planning awaits the Git remote: ${error instanceof Error?error.message:String(error)}`);}
 if(!/^[a-f0-9]{40}$/.test(pushedHead))throw Error(`Brief planning requires a pushed origin/${input.baseBranch} head`);
 try{await git(repoPath,'fetch','origin',input.baseBranch);}catch(error){throw Error(`Brief planning awaits the Git remote: ${error instanceof Error?error.message:String(error)}`);}
 const head=await git(repoPath,'rev-parse',`refs/remotes/origin/${input.baseBranch}`);
 if(head!==pushedHead)throw Error('Brief planning origin changed during check; retry');
 const pinned=briefDigest(input.text);
 const submission=submissionSchema.parse({submissionId:`northstar-draft-${input.draftId}`,title:metadata.title,repoPath,baseBranch:input.baseBranch,planningCommit:head,brief:{text:input.text,mediaType:'text/markdown',digest:pinned},originAgentId:input.originAgentId,...submissionQueueFields(metadata.queue)});
 let validationError:unknown,validationFailed=false,validatedBase:string|null=null;
 try { validatedBase=(await validateSubmission(submission)).planningBase; }
 catch(error){validationError=error;validationFailed=true;}
 if(validationFailed)throw validationError;
 if(validatedBase!==head)throw Error('Brief planning origin changed during check; retry');
 if(await git(repoPath,'branch','--show-current')!==checkoutBranch||await git(repoPath,'status','--porcelain'))
  throw Error('Integration checkout changed during brief check; retry');
 const warning=proofOnlyPreferenceWarning(submission);
 return {submission,title:metadata.title,lanes:submission.lanes,digest:pinned,planningCommit:head,...(warning?{warning}:{})};
}
/** Capture only committed local identity and operator approval; no remote calls or checkout writes. */
export async function captureHandoff(input:HandoffInput):Promise<{submission:Submission;approval:string;digest?:string;warning?:string}> {
 if(input.briefPath)return captureBrief(input);
 if(!input.handoffPath)throw Error('Supply a handoff path or a brief path');
 if(!isAbsolute(input.handoffPath))throw Error('Use an absolute handoff path');
 const path=await realpath(input.handoffPath);
 if(path!==input.handoffPath)throw Error('Handoff path must be canonical, not a symlink');
 const repoPath=await realpath(await git(dirname(path),'rev-parse','--show-toplevel'));
 const handoffPath=relative(repoPath,path);
 if(!handoffPath.startsWith('docs/handoffs/') || !handoffPath.endsWith('.md'))throw Error('Northstar dispatch requires a Markdown file under docs/handoffs');
 if(await git(repoPath,'branch','--show-current')!==input.baseBranch)throw Error('Prepare submissions from the integration checkout');
 let head=await git(repoPath,'rev-parse','HEAD');
 if(input.planningCommit && input.planningCommit!==head)throw Error('Integration HEAD changed from the requested planning commit');
 const planningCommit=await git(repoPath,'log','-1','--format=%H',head,'--',handoffPath);
 const content=await git(repoPath,'show',`${head}:${handoffPath}`);
 let clean=true;
 try{await git(repoPath,'diff','--quiet','HEAD','--',handoffPath);}catch{clean=false;}
 if(!clean)throw Error('Handoff has uncommitted edits');
 if(!/^100(644|755) blob /.test(await git(repoPath,'ls-tree',head,'--',handoffPath)))throw Error('Handoff must be a regular committed file');
 const metadata=parseNorthstarDocument(content,'handoff');
 // Pin identity to the last handoff revision, not unrelated main commits.
 // The Northstar submitter is one adapter for the generic, opaque instruction artifact.
 const instruction=await instructionForCommit(repoPath,planningCommit,handoffPath,'text/markdown');
 const submission=submissionSchema.parse({submissionId:`northstar-${digest(`${repoPath}\n${handoffPath}\n${planningCommit}`).slice(0,48)}`,title:metadata.title,repoPath,baseBranch:input.baseBranch,planningCommit,handoffPath,instruction,originAgentId:input.originAgentId,coordinatorAgentId:input.coordinatorAgentId??'',...(input.originIdentity?{originIdentity:input.originIdentity}:{}),...submissionQueueFields(metadata.queue)});
 if(await git(repoPath,'rev-parse','HEAD')!==head)throw Error('Integration HEAD changed during handoff preparation; retry');
 const warning=proofOnlyPreferenceWarning(submission);
 return {submission,approval:metadata.queue_approval!,...(warning?{warning}:{})};
}

/**
 * Spec 020 brief capture. The brief is a local Markdown file with handoff frontmatter; it
 * need not be committed or under docs/handoffs. The planning commit is the pushed integration
 * head (Spec 022: fetched `origin/<base>`, not the shared checkout's HEAD), and the text
 * travels to Queue as content. Nothing is written to the repository.
 */
async function captureBrief(input:HandoffInput):Promise<{submission:Submission;approval:string;digest:string;warning?:string}> {
 const briefPath=input.briefPath!;
 if(input.handoffPath)throw Error('Supply exactly one of a handoff path or a brief path');
 if(!isAbsolute(briefPath))throw Error('Use an absolute brief path');
 if(!input.repoPath||!isAbsolute(input.repoPath))throw Error('Brief submission requires the absolute integration checkout path');
 const text=await readFile(briefPath,'utf8');
 if(!text||text.length>BRIEF_MAX_LENGTH)throw Error('Brief is empty or exceeds 128 KB');
 const metadata=parseNorthstarDocument(text,'brief');
 const repoPath=await realpath(await git(input.repoPath,'rev-parse','--show-toplevel'));
 if(await git(repoPath,'branch','--show-current')!==input.baseBranch)throw Error('Prepare submissions from the integration checkout');
 // Spec 022: planning identity is the pushed integration head, fetched fresh, not
 // whatever commit the shared checkout has checked out. Manifest eligibility is
 // then checked at this commit, so a checkout that is merely behind origin does
 // not misread the repository's lifecycle mode.
 try { await git(repoPath,'fetch','origin',input.baseBranch); }
 catch(error){ throw Error(`Brief planning awaits the Git remote: ${error instanceof Error?error.message:String(error)}`); }
 const originRef=`refs/remotes/origin/${input.baseBranch}`;
 let head:string;
 try { head=await git(repoPath,'rev-parse',originRef); }
 catch{ throw Error(`Brief planning requires a pushed origin/${input.baseBranch} head`); }
 if(input.planningCommit && input.planningCommit!==head)throw Error('Integration origin changed from the requested planning commit');
 const dirty=Boolean(await git(repoPath,'status','--porcelain','--untracked-files=no'));
 if(dirty)throw Error('Integration checkout has uncommitted changes; brief planning must be a clean integration head');
 const pinned=briefDigest(text);
 const submission=submissionSchema.parse({submissionId:`northstar-brief-${digest(`${repoPath}\n${pinned}`).slice(0,42)}`,title:metadata.title,repoPath,baseBranch:input.baseBranch,planningCommit:head,brief:{text,mediaType:'text/markdown',digest:pinned},originAgentId:input.originAgentId,coordinatorAgentId:input.coordinatorAgentId??'',...(input.originIdentity?{originIdentity:input.originIdentity}:{}),...submissionQueueFields(metadata.queue)});
 if(await git(repoPath,'rev-parse',originRef)!==head)throw Error('Integration origin changed during brief preparation; retry');
 const warning=proofOnlyPreferenceWarning(submission);
 return {submission,approval:metadata.queue_approval!,digest:pinned,...(warning?{warning}:{})};
}

/** Explicit dry-run validation. Submission executes these checks from its durable operation. */
export async function prepareHandoff(input:HandoffInput):Promise<{submission:Submission;approval:string;digest?:string;warning?:string}> {
 const prepared=await captureHandoff(input);
 await verifyPublishedPlanning(prepared.submission);
 const validated=await validateSubmission(prepared.submission);
 await assertReviewSkipSupported(prepared.submission,validated.planningBase);
 return prepared;
}
