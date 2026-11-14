import { createHash } from "node:crypto";
import type { ReviewEntryWorkspaceInput } from "../../shared/contracts";
import { realpath } from "node:fs/promises";
import { reviewEntryInputSchema, submissionSchema, type Profile, type ReviewEntryInput, type ReviewEntryRecord, type Task } from "../../shared/contracts";
import type { QueueOperation } from "../../shared/operations";
import { command, git, queueCheckoutStatus, githubRepositoryFromRemote, SubmissionUnavailableError, validateSubmission } from "../git/index";
import { readGitCheckout } from "../git/git-identity";
import { repositoryOrigin } from "../planning/lanes";
import { now, type Store } from "../store/store";
import { validateCompletionRecipients } from "../scheduling/cohort";
import { HostFacade } from "../host/host-facade";
import type { Adapter, OriginAgent } from "../host/adapter";
import { isTransportFailure } from "../../shared/transport";
import { classifyGitCommandFailure, isForgeNetworkFailure } from "../forge/forge-health";
import { pinnedBriefDigest } from "../planning/brief";

export interface ReviewEntryInspection {
  directory:string;
  originWorkspaceId:string;
  busyReason:string;
  /** True when the busy reason is a transient admission condition (an active origin or workspace turn) that clears itself, rather than a foreign Queue ownership conflict. */
  busyTransient?:boolean;
}
export interface ReviewEntryAdapter {
  hostId:string;
  inspectReviewEntry(input:ReviewEntryInput,taskId?:string,originProof?:{origin:OriginAgent;state:import('../host/adapter').AgentObservation}):Promise<ReviewEntryInspection>;
  originAgent(id:string):Promise<OriginAgent|null>;
  reviewEntryGithubCommand?(file:string,args:string[],cwd:string):Promise<string>;
}
export interface ReviewEntryProof {
  directory:string; repository:string; branch:string; head:string; base:string; prUrl:string;
  handoffText:string; planningBase:string; originWorkspaceId:string; workspaceMode:"isolated"|"shared_canonical";
  briefDigest:string|null; briefVersion:number|null;
  /**
   * The exact source-writer activity an accepted handover was proven under, or
   * null when intake already proved the writer yielded. A non-null value means
   * this proof bounded acceptance only: nothing may execute a reviewer until a
   * fresh proof observes the same exact source without it.
   */
  pendingHandover:string|null;
  canonicalObservations?:{pr:{at:string;head:string};branch:{at:string;head:string};base:{at:string;head:string}};
}
const workspaceMode=(input:ReviewEntryInput)=>input.workspaceMode??"isolated";
export function reviewEntryInputForTask(task:Task):ReviewEntryInput{
  if(!task.reviewEntry)throw Error("Review-entry provenance is missing");
  return {
    submission:submissionSchema.strip().parse(task),workspaceId:task.reviewEntry.workspaceId,prNumber:task.reviewEntry.prNumber,
    expectedBranch:task.reviewEntry.branch,expectedHead:task.prHead??task.reviewEntry.verifiedHead,expectedBaseCommit:task.reviewEntry.verifiedBase,
    authority:task.reviewEntry.authority,authorDeclaration:task.reviewEntry.authorDeclaration,
    workspaceOwnership:task.reviewEntry.preserveWorkspace?"external":"intake",workspaceMode:task.reviewEntry.workspaceMode,
  };
}

/**
 * A forge or git read that never reached the service is an unavailable
 * observation, never a changed fact. The classification is the forge owner's
 * (`forge-health`), so a network wording fixed there is fixed here too.
 */
const remoteUnavailable=(error:unknown)=>isTransportFailure(error)||isForgeNetworkFailure(error)||classifyGitCommandFailure(error)==='network';
async function remoteCall<T>(label:string,operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch(error){if(remoteUnavailable(error))throw new SubmissionUnavailableError(`${label} unavailable: ${error instanceof Error?error.message:String(error)}`);throw error;}
}
/**
 * A typed refusal raised before any binding. Its explanation is prose and may
 * contain words such as "uncertain"; the class and its `transient` flag, not the
 * text, decide whether the operation settled as a definite failure with nothing
 * bound or as an unavailable observation whose read proved no changed fact.
 */
export class ReviewEntryRefusal extends Error {
  constructor(readonly code:"identity_mismatch"|"planning_invalid"|"ownership_conflict"|"workspace_busy"|"author_identity_unverified"|"permission_unverified"|"hook_incompatible"|"exclusive_writer_unavailable",message:string,readonly transient=false){super(message);}
}
const reject:(code:ReviewEntryRefusal["code"],message:string,transient?:boolean)=>never=(code,message,transient=false)=>{throw new ReviewEntryRefusal(code,message,transient);};
/**
 * A canonical forge field read is either a positive value or unknown. A missing,
 * blank or malformed field proves nothing about the source, receipt or author, so
 * it is an unavailable observation; a concrete different value is the only
 * positive identity statement. Never fall back to the saved receipt value.
 */
const provenString=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const provenSha=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{40}$/.test(value);
const unreadableForge:(field:string)=>never=(field)=>reject("identity_mismatch",
  `The canonical forge response did not prove the PR ${field}; the source was not read and nothing was cleared`,true);
const assertSupportedWorkspaceMode=(input:ReviewEntryInput)=>{
  if(workspaceMode(input)==="shared_canonical")
    reject("exclusive_writer_unavailable","Shared-canonical review intake is unsupported until Queue can reserve exclusive workspace writers");
};
/**
 * `merge-base --is-ancestor` answers exactly one question and its exit code is
 * the answer: 0 yes, 1 no. Anything else (a timeout, a missing object, a git that
 * cannot run) is an unreadable observation, never a negative ancestry fact, so a
 * caller that treats every failure as drift would clear credit over an outage.
 */
async function gitAncestry(cwd:string,ancestor:string,descendant:string):Promise<'ancestor'|'diverged'|'unknown'>{
  try{ await git(cwd,'merge-base','--is-ancestor',ancestor,descendant); return 'ancestor'; }
  catch(error){ return (error as {code?:unknown}).code===1?'diverged':'unknown'; }
}

/**
 * The preview's refusal for one failed stage. A typed refusal carries the code its
 * raising site decided; anything else keeps the code its stage assigned. No refusal
 * code is ever derived from the words of an explanation.
 */
const refusal=(error:unknown,stage:ReviewEntryRefusal["code"]="identity_mismatch")=>({
  code:error instanceof ReviewEntryRefusal?error.code:stage,
  explanation:error instanceof Error?error.message:String(error),
});

/** First identity conflict between a review-entry input and one task record, or null. */
function taskIdentityConflict(store:Store,task:Task,input:ReviewEntryInput):string|null{
  const runs=store.runs(task.id);
  const workspaces=[task.workspaceId,task.resolution.closeoutWorkspaceId,task.resolution.coordinatorWorkspaceId,...runs.map(run=>run.workspaceId)];
  const prNumber=task.reviewEntry?.prNumber??task.resumePrNumber??task.completion?.prNumber??null;
  if(workspaces.includes(input.workspaceId))return `Workspace already belongs to queue task ${task.id}`;
  if(task.repoPath===input.submission.repoPath&&task.reviewEntry?.workspaceMode==="shared_canonical")return `Canonical checkout is reserved by review-entry task ${task.id}`;
  if(task.repoPath===input.submission.repoPath&&task.branch===input.expectedBranch)return `Repository branch already belongs to queue task ${task.id}`;
  if(task.repoPath===input.submission.repoPath&&prNumber===input.prNumber)return `Pull request already belongs to queue task ${task.id}`;
  return null;
}

export function assertReviewEntryUnowned(store:Store,input:ReviewEntryInput,ignoreTaskId?:string){
  assertSupportedWorkspaceMode(input);
  for(const task of store.tasks()){
    if(task.id===ignoreTaskId)continue;
    const conflict=taskIdentityConflict(store,task,input);
    if(conflict)reject("ownership_conflict",conflict);
  }
}

export const reviewEntryReconciliationKey=(operationId:string)=>`reviewEntryReconciliation:${operationId}`;
/** One append-only record per explicit reconciliation: the attention state it rearmed past. */
export interface ReviewEntryReconciliation { attempt:number; attempts:number; diagnostic:string; settledAt:string|null; reconciledAt:string }
export const reviewEntryReconciliations=(store:Store,operationId:string)=>store.getMeta<ReviewEntryReconciliation[]>(reviewEntryReconciliationKey(operationId))??[];

/**
 * Complete durable absence of any binding for one review-entry operation. It reads
 * stored state across removed tasks, tombstones and every operation, never the
 * operation's diagnostic prose. Pre-binding review entry performs only reads, so
 * an absent binding is the whole effect proof.
 */
export function assertReviewEntryAbsent(store:Store,operation:QueueOperation,input:ReviewEntryInput){
  if(operation.taskId||operation.result||operation.effect)throw Error("Review-entry operation records a task, result or effect; reconciliation needs an absent binding");
  if(store.existing(input.submission))throw Error("Submission ID already belongs to a task; reconciliation refused");
  for(const task of store.allTasks()){
    if(task.reviewEntry?.operationId===operation.id)throw Error(`Review-entry operation already bound task ${task.id}; reconciliation refused`);
    const conflict=taskIdentityConflict(store,task,input);
    if(conflict)throw Error(`${conflict}; reconciliation refused`);
  }
  for(const other of store.operationsForAbsenceProof(input.submission.submissionId)){
    if(other.id===operation.id)continue;
    if(other.submissionId===input.submission.submissionId){
      if(other.taskId||other.result?.taskId)throw Error(`Operation ${other.id} for this submission is linked to a task; reconciliation refused`);
      throw Error(`Operation ${other.id} for this submission is ${other.state}; reconciliation refused`);
    }
    // Another unfinished review entry may still bind this workspace, branch or PR; settled ones are proven by their tasks.
    if(other.kind!=="review_entry")continue;
    const parsed=reviewEntryInputSchema.safeParse((store.operationPayload(other.id) as {input?:unknown}|null)?.input);
    if(!parsed.success)throw Error(`Operation ${other.id} has an unreadable review-entry identity; reconciliation refused`);
    const sameIdentity=parsed.data.submission.repoPath===input.submission.repoPath
      &&(parsed.data.workspaceId===input.workspaceId||parsed.data.expectedBranch===input.expectedBranch||parsed.data.prNumber===input.prNumber);
    if(sameIdentity)throw Error(`Operation ${other.id} (${other.state}) holds this workspace, branch or PR; reconciliation refused`);
  }
}

/**
 * Explicit operator reconciliation of one attention-held review-entry operation.
 * It rearms the same operation (key, ID, stored payload and hash unchanged) only
 * after a complete absence proof and a fresh preview. Binding then reruns every
 * intake proof, including the origin-idle check. No approval is minted here.
 */
export async function reconcileReviewEntryOperation(store:Store,adapter:ReviewEntryAdapter,operationId:string,expectedInputHash:string):Promise<{operation:QueueOperation;reopened:boolean}>{
  const current=store.operation(operationId);
  if(!current)throw Error("Operation not found");
  if(current.kind!=="review_entry")throw Error("Only a review-entry operation is reconciled here");
  if(current.inputHash!==expectedInputHash)throw Error("Review-entry input hash does not match the stored operation; reconciliation refused");
  if(current.state==="failed")throw Error("A failed review entry reopens only by repeating its key with the same input");
  if(current.state!=="needs_attention")return {operation:current,reopened:false};
  const input=reviewEntryInputSchema.parse((store.operationPayload(operationId) as {input?:unknown}|null)?.input);
  assertReviewEntryAbsent(store,current,input);
  const preview=await previewReviewEntry(store,adapter,input);
  if(!preview.eligible)throw Error(`Review entry is not eligible for reconciliation: ${preview.refusals.map(item=>item.explanation).join("; ")}`);
  return store.transaction(()=>{
    const latest=store.operation(operationId);
    if(!latest)throw Error("Operation not found");
    if(latest.state==="failed")throw Error("A failed review entry reopens only by repeating its key with the same input");
    // A concurrent identical reconciliation already rearmed it: return the same operation.
    if(latest.state!=="needs_attention")return {operation:latest,reopened:false};
    if(latest.inputHash!==expectedInputHash)throw Error("Review-entry input hash changed during reconciliation; reload and retry");
    assertReviewEntryAbsent(store,latest,input);
    const limit=store.configuredOperationLimit(),backlog=store.operationBacklog();
    if(backlog>=limit)throw Error(`Queue operation backlog ${backlog} reached the configured bound of ${limit}; retry after the queue drains`);
    const history=reviewEntryReconciliations(store,operationId);
    store.setMeta(reviewEntryReconciliationKey(operationId),[...history,{attempt:history.length+1,attempts:latest.attempts,diagnostic:latest.diagnostic,settledAt:latest.settledAt,reconciledAt:now()}]);
    return {operation:store.putOperation({...latest,state:"pending",startedAt:null,settledAt:null,diagnostic:"",result:null,effect:null}),reopened:true};
  });
}

/**
 * One canonical pull-request response, decoded into the typed facts Queue reads.
 * A field the response did not positively establish is `unreadable` — never a
 * different value — a positively observed closed, merged or draft PR is
 * `not_open`, and a fork or alternate repository is `foreign`. Each caller maps
 * these facts to its own sentence instead of re-reading the raw fields, so the
 * two exact-head proofs cannot disagree about what the forge said.
 */
type CanonicalPullRequest =
  | {kind:"unreadable";field:string}
  | {kind:"not_open";state:"closed"|"merged"|"draft"}
  | {kind:"foreign"}
  | {kind:"read";headRef:string;baseRef:string;headSha:string;login:string|null;url:string|null};
const decodeCanonicalPullRequest=(raw:any,repository:string):CanonicalPullRequest=>{
  if(raw.state!=="open"&&raw.state!=="closed")return {kind:"unreadable",field:"state"};
  if(raw.state==="closed")return {kind:"not_open",state:"closed"};
  // An explicit null merged_at is the only proof this PR is unmerged.
  if(raw.merged_at!==null){if(!provenString(raw.merged_at))return {kind:"unreadable",field:"merged status"};return {kind:"not_open",state:"merged"};}
  if(raw.draft!==false){if(raw.draft!==true)return {kind:"unreadable",field:"draft status"};return {kind:"not_open",state:"draft"};}
  const headRepo=raw.head&&typeof raw.head==="object"?"repo" in raw.head?raw.head.repo:undefined:undefined;
  const baseRepo=raw.base&&typeof raw.base==="object"?"repo" in raw.base?raw.base.repo:undefined:undefined;
  // An explicit null head/base repository is a positively observed deletion; an absent object is an unknown read.
  if(headRepo===null||baseRepo===null)return {kind:"foreign"};
  if(!headRepo||!baseRepo)return {kind:"unreadable",field:"head or base repository identity"};
  const headName=(headRepo as {full_name?:unknown}).full_name,baseName=(baseRepo as {full_name?:unknown}).full_name;
  if(!provenString(headName))return {kind:"unreadable",field:"head repository"};
  if(!provenString(baseName))return {kind:"unreadable",field:"base repository"};
  if(headName!==repository||baseName!==repository)return {kind:"foreign"};
  if(!provenString(raw.head?.ref))return {kind:"unreadable",field:"head branch"};
  if(!provenString(raw.base?.ref))return {kind:"unreadable",field:"base branch"};
  if(!provenSha(raw.head?.sha))return {kind:"unreadable",field:"head"};
  const login=raw.user&&typeof raw.user==="object"?raw.user.login:undefined;
  return {kind:"read",headRef:raw.head.ref,baseRef:raw.base.ref,headSha:raw.head.sha,
    login:provenString(login)?login:null,url:provenString(raw.html_url)?raw.html_url:null};
};
async function readCanonicalPullRequest(submission:ReviewEntryInput["submission"],repository:string,prNumber:number,github:(file:string,args:string[],cwd:string)=>Promise<string>):Promise<CanonicalPullRequest>{
  const raw=JSON.parse(await remoteCall("GitHub",()=>github("gh",["api",`repos/${repository}/pulls/${prNumber}`],submission.repoPath)));
  return decodeCanonicalPullRequest(raw,repository);
}
/**
 * The typed facts of an open canonical PR, or this caller's refusal. Unreadable
 * fields and foreign repositories name their own reason; the three non-open states
 * are mapped by the caller, whose sentence says what it was proving.
 */
function openCanonicalPullRequest(read:CanonicalPullRequest,refuse:(state:"closed"|"merged"|"draft")=>string){
  if(read.kind==="unreadable")unreadableForge(read.field);
  if(read.kind==="foreign")throw Error("Fork or alternate-repository pull requests are not supported");
  if(read.kind==="not_open")throw Error(refuse(read.state));
  return read;
}
/** Queue's write permission on the canonical repository; an unproven response is a transient refusal. */
async function assertQueueWritePermission(submission:ReviewEntryInput["submission"],repository:string,github:(file:string,args:string[],cwd:string)=>Promise<string>):Promise<void>{
  const repo=JSON.parse(await remoteCall("GitHub",()=>github("gh",["api",`repos/${repository}`],submission.repoPath)));
  // A repository response that does not positively establish write permission
  // (`permissions.push:false`, or a missing `permissions`/`permissions.push`
  // field) proves nothing about the reviewed source, receipt or author: it is an
  // unavailable observation, not a changed fact. The dated-owner canonical proof
  // then preserves the exact-head review and records the ordinary
  // external_unavailable wait instead of clearing credit, and a fresh proof that
  // positively establishes the permission lets the ordinary pass resume.
  if(!repo.permissions?.push)reject("permission_unverified","Queue permission check did not prove repository write permission",true);
}
export async function verifyReviewEntry(input:ReviewEntryInput,adapter:ReviewEntryAdapter,options:{allowBaseAdvance?:boolean;freshCanonicalRefs?:boolean;taskId?:string;
  /**
   * Intake acceptance only. An active or uncertain source writer is the
   * handover condition rather than a refusal: an external author submits the
   * finished PR during the turn that finished it, and the selected workspace may
   * be one it is writing in. The proof records that wait and returns, so the
   * handover can be accepted durably and the ordinary admission pass re-proves
   * the exact source after the writer yields. Every other caller keeps the
   * transient refusal, because execution must never start under an active
   * writer.
   */
  acceptAuthorHandover?:boolean}={}):Promise<ReviewEntryProof>{
  assertSupportedWorkspaceMode(input);
  const s=input.submission;
  const mode=workspaceMode(input);
  const observedRepository=await repositoryOrigin(s.repoPath)??s.repoPath;
  if(input.authorDeclaration.models.some(model=>!model.includes('/')||/^(unknown|default)$/i.test(model)))reject("author_identity_unverified","Author models must be concrete provider/model identities");
  const inspected=await adapter.inspectReviewEntry(input,options.taskId);
  // A foreign Queue ownership conflict is not activity and always refuses. An
  // active or uncertain writer is transient: intake may accept the handover and
  // record it as the pending wait, while every execution proof still refuses it.
  let pendingHandover:string|null=null;
  if(inspected.busyReason){
    if(inspected.busyTransient!==true)reject("workspace_busy",inspected.busyReason);
    if(!options.acceptAuthorHandover)reject("workspace_busy",inspected.busyReason,true);
    pendingHandover=inspected.busyReason.slice(0,2000);
  }
  const directory=await realpath(inspected.directory);
  if(directory!==inspected.directory||directory===s.repoPath||await git(directory,"rev-parse","--show-toplevel")!==directory)
    throw Error("Review entry requires an existing isolated workspace Git root");
  if(await git(directory,"rev-parse","--path-format=absolute","--git-common-dir")!==await git(s.repoPath,"rev-parse","--path-format=absolute","--git-common-dir"))throw Error("Workspace belongs to a different repository");
  if(await git(directory,"branch","--show-current")!==input.expectedBranch||input.expectedBranch===s.baseBranch)throw Error("Workspace branch does not match the supplied isolated branch");
  const head=await git(directory,"rev-parse","HEAD");
  if(await git(directory,"status","--porcelain"))throw Error("Review-entry workspace must be clean");
  if(head!==input.expectedHead)throw Error(`Workspace head ${head} does not match expected head ${input.expectedHead}`);
  const integrationBranch=await git(s.repoPath,"branch","--show-current");
  const integrationHead=await git(s.repoPath,"rev-parse","HEAD");
  const integrationClean=!(await git(s.repoPath,"status","--porcelain"));
  if(integrationBranch!==s.baseBranch||!integrationClean)throw Error("Integration checkout must be clean on the target branch");
  await remoteCall("Git remote",()=>git(s.repoPath,"fetch","origin",s.baseBranch,input.expectedBranch));
  const base=await git(s.repoPath,"rev-parse",`refs/heads/${s.baseBranch}`);
  const remoteBase=await git(s.repoPath,"rev-parse",`refs/remotes/origin/${s.baseBranch}`);
  if(base!==remoteBase)throw Error("Local and remote integration tips are not synchronized");
  if(base!==input.expectedBaseCommit){
    if(!options.allowBaseAdvance)throw Error("Local and remote integration tips do not match expectedBaseCommit");
    const ancestry=await gitAncestry(s.repoPath,input.expectedBaseCommit,base);
    if(ancestry==='unknown')
      reject("planning_invalid",`The integration base ancestry could not be read (expected ${input.expectedBaseCommit}, current ${base}); the source was not read and nothing was cleared`,true);
    if(ancestry==='diverged')throw Error("Current integration base is not a clean advance of expectedBaseCommit");
  }
  const remoteHead=(await remoteCall("Git remote",()=>git(directory,"ls-remote","origin",`refs/heads/${input.expectedBranch}`))).split(/\s+/)[0]??"";
  if(remoteHead&&remoteHead!==input.expectedHead)throw Error("Remote branch head does not match expectedHead");
  if(remoteHead!==input.expectedHead)throw Error("Remote branch head does not match expectedHead");
  const baseAncestry=await gitAncestry(s.repoPath,s.planningCommit,base);
  if(baseAncestry==='unknown')
    reject("planning_invalid",`The planning commit ancestry could not be read (${s.planningCommit} vs ${base}); the source was not read and nothing was cleared`,true);
  if(baseAncestry==='diverged')throw Error("The integration base does not descend from the planning commit");
  // A handoff is a committed artifact, so the reviewed head must contain its
  // planning commit. Queue-held briefs live in Queue and need no such proof;
  // requiring it would force finished external PRs to merge current main.
  if(!s.brief){
    const headAncestry=await gitAncestry(directory,s.planningCommit,remoteHead);
    if(headAncestry==='unknown')
      reject("planning_invalid",`The reviewed head ancestry could not be read (${s.planningCommit} vs ${remoteHead}); the source was not read and nothing was cleared`,true);
    if(headAncestry==='diverged')throw Error("The reviewed head does not descend from the planning commit");
  }
  const validated=await validateSubmission(s);
  if(!s.brief){
    const publishedHandoff=await git(s.repoPath,"show",`${base}:${s.handoffPath}`);
    if(publishedHandoff!==validated.handoffText)throw Error("Published handoff bytes differ from the pinned planning artifact");
  }
  const remote=await git(s.repoPath,"config","--get","remote.origin.url"),repository=githubRepositoryFromRemote(remote);
  if(!repository)throw Error("Review entry requires the canonical GitHub origin");
  const github=adapter.reviewEntryGithubCommand??command;
  // Each identity field is read once, as a typed fact: an omitted or malformed
  // field is unavailable (the merge waits, credit stays), and only a concrete
  // different value is positive drift. Nothing falls back to the saved receipt.
  const read=await readCanonicalPullRequest(s,repository,input.prNumber,github);
  const prObservedAt=now();
  const pr=openCanonicalPullRequest(read,()=>"Pull request must be open, unmerged and non-draft");
  if(pr.headRef!==input.expectedBranch||pr.baseRef!==s.baseBranch||pr.headSha!==input.expectedHead)
    throw Error("Pull request branch, base or head identity does not match the supplied proof");
  // A missing, blank or malformed login is an unavailable observation; only a
  // concrete different login is a positive author-identity statement.
  if(!pr.login)reject("author_identity_unverified",
    "The canonical forge response did not prove the pull request author; the source was not read and nothing was cleared",true);
  if(pr.login.toLowerCase()!==input.authorDeclaration.githubAuthor.toLowerCase())
    reject("author_identity_unverified","Declared GitHub author does not match the pull request author");
  if(!pr.url||!/^https?:\/\/\S+$/.test(pr.url))unreadableForge("URL");
  await assertQueueWritePermission(s,repository,github);
  let canonicalObservations:ReviewEntryProof['canonicalObservations'];
  if(options.freshCanonicalRefs){
    // One actual origin advertisement after GitHub/permission awaits. This is
    // a dated witness, not a reservation of either ref or PR metadata.
    const refs=await remoteCall('Git remote',()=>git(s.repoPath,'ls-remote','origin',`refs/heads/${input.expectedBranch}`,`refs/heads/${s.baseBranch}`));
    const refsAt=now(),tips=new Map(refs.split('\n').filter(Boolean).map(line=>{const [sha,ref]=line.split(/\s+/);return [ref,sha];}));
    const pushed=tips.get(`refs/heads/${input.expectedBranch}`),integration=tips.get(`refs/heads/${s.baseBranch}`);
    if(pushed!==input.expectedHead)throw Error('Remote branch head changed after canonical PR and permission observations');
    if(integration!==base)throw Error('Remote integration tips changed after canonical PR and permission observations');
    canonicalObservations={pr:{at:prObservedAt,head:pr.headSha},branch:{at:refsAt,head:pushed},base:{at:refsAt,head:integration}};
  }
  return {directory,repository,branch:input.expectedBranch,head,base,prUrl:pr.url,...(canonicalObservations?{canonicalObservations}:{}),handoffText:validated.handoffText,planningBase:validated.planningBase,originWorkspaceId:inspected.originWorkspaceId,workspaceMode:mode,pendingHandover,
    briefDigest:s.brief?pinnedBriefDigest(s):null,briefVersion:s.brief?(s.leadProvenance?.version??1):null};
}

/**
 * One fresh observation that the external source writer yielded, for a caller
 * about to execute something in the preserved source workspace. The task's own
 * lease observes Queue runs and task agents; it can never see the origin author
 * or another thread in that workspace, so every execution boundary must ask
 * here. A transient condition keeps the typed transient refusal admission
 * waits on; anything the adapter did not positively classify as transient is a
 * foreign conflict and refuses.
 */
export async function assertReviewEntryWriterYielded(input:ReviewEntryInput,adapter:ReviewEntryAdapter,taskId?:string):Promise<void>{
  const inspected=await adapter.inspectReviewEntry(input,taskId);
  if(!inspected.busyReason)return;
  if(inspected.busyTransient!==true)reject("workspace_busy",inspected.busyReason);
  reject("workspace_busy",inspected.busyReason,true);
}

/**
 * The canonical pin a plain-handover pinned view needs beside its pinned content.
 * Report acceptance and mechanical verification re-prove the exact published
 * PR/branch/base, the declared GitHub author and Queue's write permission. They
 * deliberately read no source worktree: the reviewed content is the view, so an
 * author who resumed work in their own checkout has not changed it. A transient
 * observation refuses the credit and waits rather than reading as drift.
 */
export async function verifyReviewEntryCanonicalAuthor(input:ReviewEntryInput,adapter:ReviewEntryAdapter):Promise<{repository:string;prUrl:string}>{
  const s=input.submission;
  const remote=await git(s.repoPath,'config','--get','remote.origin.url'),repository=githubRepositoryFromRemote(remote);
  if(!repository)throw Error('Review entry requires the canonical GitHub origin');
  const github=adapter.reviewEntryGithubCommand??command;
  // The pinned view's own sentence for each typed non-open state; the field and
  // fork refusals are the shared decode's, so both proofs read one forge fact.
  const pr=openCanonicalPullRequest(await readCanonicalPullRequest(s,repository,input.prNumber,github),state=>
    state==='closed'?'The pull request this review accepted is closed; the pinned review is not current'
    :state==='merged'?'The pull request this review accepted is merged; the pinned review is not current'
    :'The pull request this review accepted is draft again; the pinned review is not current');
  if(pr.headSha!==input.expectedHead||pr.headRef!==input.expectedBranch||pr.baseRef!==s.baseBranch)
    throw Error('The pull request branch, base or head no longer matches the accepted intake');
  if(!pr.login)reject('author_identity_unverified','The canonical forge response did not prove the pull request author',true);
  if(pr.login.toLowerCase()!==input.authorDeclaration.githubAuthor.toLowerCase())
    reject('author_identity_unverified','The declared GitHub author is no longer the pull request author; the pinned review is not current');
  if(!pr.url)unreadableForge('URL');
  await assertQueueWritePermission(s,repository,github);
  return {repository,prUrl:pr.url};
}

/**
 * The bounded LOCAL source custody proof for starting the first external
 * reviewer: the bound workspace is still on the recorded exact head with nothing
 * uncommitted, so the reviewer reads the approved source and never a later or
 * uncommitted one. Status is async so it delays this task, not the executor;
 * HEAD is then re-read from the filesystem with nothing awaited after it. It
 * asserts local facts only; remote freshness stays with the separately dated
 * forge proof.
 */
export async function assertReviewEntryExecutionSource(task:Task):Promise<void>{
  const recorded=task.reviewEntry;
  if(!recorded)throw Error('Review-entry provenance is missing; no reviewer was created');
  if(!task.directory||task.directory!==recorded.directory)throw Error('The bound external review workspace directory changed; no reviewer was created');
  if(await queueCheckoutStatus(task.directory,'status','--porcelain'))throw Error('The external review workspace has tracked or untracked changes; the exact approved head cannot be reviewed and no reviewer was created');
  let head:string;
  try { head=readGitCheckout(task.directory).head; }
  catch { throw Error('The external review workspace has tracked or untracked changes; the exact approved head cannot be reviewed and no reviewer was created'); }
  if(!task.prHead||head!==task.prHead)throw Error(`The external review workspace head ${head} is not the recorded review head ${task.prHead??'none'}; no reviewer was created`);
}

/**
 * The code one preview stage answers with when a failure it did not type itself
 * reaches it. A stage knows what it was proving, so this is a typed fact about the
 * failure's place in the proof, never a classification of its words.
 */
type PreviewStage=Extract<ReviewEntryRefusal["code"],"identity_mismatch"|"planning_invalid">;
const stageRefusal=async<T>(stage:PreviewStage,work:()=>Promise<T>|T):Promise<T>=>{
  try{return await work();}
  catch(error){
    if(error instanceof SubmissionUnavailableError||isTransportFailure(error)||error instanceof ReviewEntryRefusal)throw error;
    throw new ReviewEntryRefusal(stage,error instanceof Error?error.message:String(error));
  }
};
export async function previewReviewEntry(store:Store,adapter:ReviewEntryAdapter,input:ReviewEntryInput){
  let stage:PreviewStage="identity_mismatch";
  try{
    assertSupportedWorkspaceMode(input);
    assertReviewEntryUnowned(store,input);
    // Preview reads only. It accepts the same handover intake would, and reports
    // the wait it observed, so eligibility to accept is never confused with
    // readiness to execute a reviewer.
    const proof=await stageRefusal(stage,()=>verifyReviewEntry(input,adapter,{acceptAuthorHandover:true}));
    stage="planning_invalid";
    await stageRefusal(stage,()=>store.validateReviewEntryBrief(input.submission,proof.repository));
    return {eligible:true,refusals:[],pendingHandover:proof.pendingHandover,resolved:{workspaceId:input.workspaceId,directory:proof.directory,repository:proof.repository,branch:proof.branch,head:proof.head,base:proof.base,prNumber:input.prNumber,prUrl:proof.prUrl,workspaceMode:proof.workspaceMode,planningCommit:input.submission.planningCommit,briefDigest:proof.briefDigest,briefVersion:proof.briefVersion}};
  }catch(error){if(error instanceof SubmissionUnavailableError||isTransportFailure(error))throw error;return {eligible:false,refusals:[refusal(error,stage)],pendingHandover:null,resolved:null};}
}

export async function bindReviewEntry(store:Store,adapter:ReviewEntryAdapter,operation:QueueOperation,input:ReviewEntryInput,originHostId?:string,lookupOrigin?:(id:string)=>ReturnType<HostFacade['originAgent']>):Promise<Task>{
  assertSupportedWorkspaceMode(input);
  const existing=store.existing(input.submission);
  if(existing){
    if(existing.reviewEntry?.operationId!==operation.id)throw Error("Submission ID already belongs to another task");
    return existing;
  }
  assertReviewEntryUnowned(store,input);
  store.validateDependencies(input.submission);
  // The review-entry adapter is the Paseo adapter in production; its origin read goes through Host over it.
  const host=new HostFacade({adapter:adapter as Adapter&ReviewEntryAdapter});
  const {recipients:creatorCompletionRecipients}=await validateCompletionRecipients(input.submission,lookupOrigin ?? (id=>host.originAgent(id)));
  // Acceptance, not execution: an active source writer is recorded as the
  // pending handover this task waits on, and admission re-proves the source.
  const proof=await verifyReviewEntry(input,adapter,{acceptAuthorHandover:true});
  return store.transaction(()=>{
    const currentOperation=store.operation(operation.id);
    if(currentOperation&&(currentOperation.kind!=="review_entry"||currentOperation.inputHash!==operation.inputHash||currentOperation.key!==operation.key||currentOperation.state!=="running"))
      throw Error("Review-entry operation changed during external proof");
    const raced=store.existing(input.submission);
    if(raced){
      if(raced.reviewEntry?.operationId!==operation.id)throw Error("Submission ID already belongs to another task");
      return raced;
    }
    assertReviewEntryUnowned(store,input);
    const record:ReviewEntryRecord={operationId:operation.id,prNumber:input.prNumber,repository:proof.repository,branch:proof.branch,workspaceId:input.workspaceId,
      verifiedHead:proof.head,verifiedBase:proof.base,dispatchBase:null,planningCommit:input.submission.planningCommit,authority:input.authority,
      authorDeclaration:input.authorDeclaration,checkedAt:now(),preserveWorkspace:input.workspaceOwnership!=="intake",directory:proof.directory,workspaceMode:proof.workspaceMode,
      briefDigest:proof.briefDigest,briefVersion:proof.briefVersion};
    let task=store.insert(input.submission,adapter.hostId,proof.handoffText,proof.planningBase,{
      entrypoint:"review",reviewEntry:record,phase:"queued",hostSelection:operation.hostSelection,originHostId:originHostId ?? (lookupOrigin ? undefined : adapter.hostId),
      reason:proof.pendingHandover
        ? `External PR #${input.prNumber} handover accepted at ${proof.head}; independent review waits for the source writer to yield: ${proof.pendingHandover}`
        : "Review entry verified; waiting for review admission",
      workspaceId:input.workspaceId,directory:proof.directory,branch:proof.branch,workspaceIntent:true,agentIntent:false,
      prUrl:proof.prUrl,prHead:proof.head,resumePrNumber:input.prNumber,originWorkspaceId:proof.originWorkspaceId,creatorCompletionRecipients,
    },undefined,proof.repository);
    store.claimReviewEntryBrief(input.submission,proof.repository,task.id);
    task=store.task(task.id);
    store.putOperation({...operation,taskId:task.id,result:{taskId:task.id,taskVersion:task.version,phase:task.phase,number:task.number,reference:task.reference}});
    store.event(task.id,"review_entry_bound",`External PR #${input.prNumber} at ${proof.head}; declared authors ${input.authorDeclaration.models.join(", ")}; workspace ${record.preserveWorkspace?"preserved":"owned for post-closeout archive"}${proof.pendingHandover?`; handover accepted during source-writer activity, review execution deferred until a fresh proof observes it yielded: ${proof.pendingHandover}`:""}`.slice(0,4000));
    return task;
  });
}

/** Core owns review-intake workspace identity; the selected host only creates it. */
export function prepareReviewEntryWorkspace(adapter:Adapter,input:ReviewEntryWorkspaceInput){
  if(!adapter.createReviewEntryWorkspace)throw Error('Review entry is unavailable on this adapter');
  const requestId=`nucleus-review-entry-${createHash('sha256').update(`${input.leadId}\n${input.prNumber}\n${input.leadVersion}`).digest('hex').slice(0,32)}`;
  return adapter.createReviewEntryWorkspace({requestId,title:`Review PR #${input.prNumber}: ${input.title}`,repoPath:input.repoPath,prNumber:input.prNumber});
}
