import type { VerifiedPr } from '../../core/host/types';
export type { VerifiedPr } from '../../core/host/types';
import { type Task, type Completion } from '../../shared/contracts';
import { repo, api } from './github-client';
import { git, queueCheckoutStatus, verifyReportOnlyIdentity, githubRepositoryFromRemote, verifyResume, command } from '../git/index';



type PullRequestIdentity = {
  state?: string;
  draft?: boolean;
  html_url?: string;
  head?: {ref?:string;sha?:string;repo?:{full_name?:string|null}|null};
  base?: {ref?:string};
};
/**
 * Project-d #117 review: a PR Queue binds from a report must come from the
 * canonical repository itself, not a fork with the same branch name. Throws,
 * before anything is written, when the head repository differs, is unknown or
 * was deleted. Existing callers keep their own checks.
 */
export function assertCanonicalPrSource(pr: VerifiedPr, number: number): void {
  if (pr.repository && pr.headRepository && pr.crossRepository !== true && pr.headRepository.toLowerCase() === pr.repository.toLowerCase()) return;
  throw new Error(`PR #${number} comes from ${pr.headRepository ?? 'an unknown or deleted repository'}, not the canonical ${pr.repository ?? 'repository'}; nothing was bound`);
}
/**
 * Check the identity of an already-bound task PR. A retained worker may be
 * sent back to revise its own draft PR, but strict callers keep the ready gate.
 */
export class ForeignPrIdentity extends Error {}
export function assertPullRequestIdentity(t:Task,pr:PullRequestIdentity,options:{allowDraft?:boolean}={}){
  if(pr.head?.ref!==t.branch) throw new ForeignPrIdentity(`PR must be ${options.allowDraft?'open':'open, ready'}, and match the task branch and base`);
  if(pr.state!=='open'||(!options.allowDraft&&pr.draft)||pr.base?.ref!==t.baseBranch){
    const readiness=options.allowDraft?'open':'open, ready';
    throw Error(`PR must be ${readiness}, and match the task branch and base`);
  }
  return {url:String(pr.html_url),head:String(pr.head?.sha)};
}

export async function verifyPrIdentity(t:Task,number:number,options:{allowDraft?:boolean}={}):Promise<VerifiedPr>{
  const name=await repo(t);
  const pr=await api(t,`repos/${name}/pulls/${number}`);
  // The head repository is reported for the PR-binding sites; null when the fork was deleted.
  return {...assertPullRequestIdentity(t,pr,options),repository:name,headRepository:pr.head?.repo?.full_name??null};
}
/**
 * Centralized inspected-head proof for stopped-revision recovery (Spec 014).
 * The supplied head must equal the open ready PR head, the remote branch head
 * and the clean retained worktree HEAD at once. Any mismatch throws with the
 * observed bounded identity facts before the caller mutates durable state.
 * The lookup seam keeps the PR observation replaceable for offline
 * verification; production callers use the default GitHub PR identity check.
 */
export async function verifyInspectedRevisionHead(t:Task,number:number,expected:string,lookup:(t:Task,n:number)=>Promise<{url:string;head:string}>=verifyPrIdentity){
  if(!/^[a-f0-9]{40}$/.test(expected))throw Error('Inspected stopped-revision recovery requires the exact 40-character inspected PR head');
  const pr=await lookup(t,number);
  // The verified head must belong to the recorded task PR: a matching head on a
  // different PR identity is not proof the task's own PR is at that head.
  if(t.prUrl&&pr.url!==t.prUrl)throw Error(`Inspected PR ${pr.url} does not match the recorded task PR ${t.prUrl}`);
  if(!t.directory)throw Error('Inspected stopped-revision recovery requires the retained task worktree');
  if(await git(t.directory,'branch','--show-current')!==t.branch||t.branch===t.baseBranch)throw Error(`Inspected stopped-revision recovery requires the retained worktree on queue-owned branch ${t.branch}`);
  if(await queueCheckoutStatus(t.directory,'status','--porcelain'))throw Error('Inspected stopped-revision recovery requires a clean retained worktree; inspect it before recovering');
  const local=await git(t.directory,'rev-parse','HEAD');
  let remote='';
  try{remote=(await git(t.directory,'ls-remote','origin',`refs/heads/${t.branch}`)).split(/\s+/)[0]??'';}
  catch{throw Error(`Inspected stopped-revision recovery cannot prove the remote head of ${t.branch}; inspect it before recovering`);}
  if(!/^[a-f0-9]{40}$/.test(remote))throw Error(`Inspected stopped-revision recovery found an ambiguous remote head for ${t.branch}; inspect it before recovering`);
  if(local!==expected||remote!==expected||pr.head!==expected)
    throw Error(`Inspected PR head ${expected} does not match the observed worktree ${local}, remote ${remote} and PR ${pr.head} heads`);
}

/** Prove published retained source contains the authenticated work it continues. */
export async function verifyContinuedProgress(t:Task, number:number, expected:string, ancestors:readonly string[],
  options:{requireClean?:boolean} = {},
  lookup:(task:Task, number:number)=>Promise<VerifiedPr> = (task, n) => verifyPrIdentity(task, n, {allowDraft:true})):Promise<void> {
  if (!t.directory || !t.workspaceId || !t.agentId || !t.prUrl) throw Error('Continued progress requires the retained author, workspace and PR');
  const provePr = async () => {
    const pr = await lookup(t, number);
    assertCanonicalPrSource(pr, number);
    if (pr.url !== t.prUrl || pr.head !== expected) throw Error('Continued progress PR identity or head changed');
  };
  const proveWorktree = async () => {
    await verifyReportOnlyIdentity(t,{allowDirty:options.requireClean === false});
    const planningOrigin = githubRepositoryFromRemote(await git(t.repoPath, 'remote', 'get-url', 'origin'));
    const worktreeOrigin = githubRepositoryFromRemote(await git(t.directory!, 'remote', 'get-url', 'origin'));
    if (!planningOrigin || !worktreeOrigin || planningOrigin.toLowerCase() !== worktreeOrigin.toLowerCase())
      throw Error('Continued progress worktree origin does not match the canonical repository');
    if (await verifyResume(t) !== expected) throw Error('Continued progress worktree head changed');
  };
  await provePr();
  await proveWorktree();
  const provePublished = async () => {
    if (options.requireClean !== false) return verifyInspectedRevisionHead(t,number,expected,lookup);
    await provePr();
    const local = await git(t.directory!, 'rev-parse', 'HEAD');
    const remote = (await git(t.directory!, 'ls-remote', 'origin', `refs/heads/${t.branch}`)).split(/\s+/)[0] ?? '';
    if (!/^[a-f0-9]{40}$/.test(remote) || local !== expected || remote !== expected)
      throw Error('Continued progress does not match the local and published branch heads');
  };
  await provePublished();
  for (const ancestor of new Set(ancestors)) {
    if (!/^[a-f0-9]{40}$/.test(ancestor)) throw Error('Continued progress has an invalid recorded ancestor');
    try { await git(t.directory, 'merge-base', '--is-ancestor', ancestor, expected); }
    catch { throw Error(`Continued progress does not contain recorded work ${ancestor}`); }
  }
  await proveWorktree();
  await provePr();
  await provePublished();
}
export async function findOpenBranchPr(t:Task){
  const name=await repo(t);
  const prs=JSON.parse(await command('gh',['pr','list','--repo',name,'--head',t.branch,'--state','open','--limit','3','--json','number,url,state,isDraft,headRefName,baseRefName,headRefOid'],t.repoPath));
  if(!Array.isArray(prs))throw Error('Open branch PR lookup returned an invalid response');
  return prs.filter(pr=>pr.state==='OPEN'&&!pr.isDraft&&pr.headRefName===t.branch&&pr.baseRefName===t.baseBranch)
    .map(pr=>({number:Number(pr.number),url:String(pr.url),head:String(pr.headRefOid)}));
}
/** Report-only owner completion refuses every open PR on the task branch, including drafts and a different base. */
export async function findAnyOpenBranchPr(t:Task){
  const name=await repo(t);
  const prs=JSON.parse(await command('gh',['pr','list','--repo',name,'--head',t.branch,'--state','open','--limit','1000','--json','number,url,state,headRefName'],t.repoPath));
  if(!Array.isArray(prs))throw Error('Open branch PR lookup returned an invalid response');
  return prs.filter(pr=>pr.state==='OPEN'&&pr.headRefName===t.branch)
    .map(pr=>({number:Number(pr.number),url:String(pr.url)}));
}
/** Whether the task records any PR evidence (a number, URL or head); `taskPrNumber` throws when it has no number. */
/** Any recorded PR evidence: a review-entry or resumed PR number, a reported number, or the PR URL or head. */
export const taskHasPr = (t: Task) => Boolean(t.reviewEntry?.prNumber || t.resumePrNumber || t.completion?.prNumber || t.prUrl || t.prHead);
export const taskPrNumber = (t: Task) => { const pr=t.reviewEntry?.prNumber ?? t.resumePrNumber ?? t.completion?.prNumber; if (!pr) throw new Error('Task has no PR'); return pr; };
/**
 * Queue #392 (Tom, 2026-10-24): the retained worker's own authenticated
 * blocked or errored report. It is the task's unresolved block — its reason,
 * its findings and the validation it never ran — so a PR found on the task's
 * branch may be recorded as identity and never as readiness: the block stands
 * until an explicit owner continuation or an applicable authenticated ready
 * result answers it. Null on a task with no such report.
 */
export const authenticatedWorkerBlock = (t: Task): Completion | null =>
  t.completion && (t.completion.status === 'blocked' || t.completion.status === 'error') ? t.completion : null;
/**
 * Project-d #117 (Tom, 2026-10-23): a PR the task knows only from a reported
 * completion, with no bound `prUrl`, `resumePrNumber` or review-entry number
 * (an identity repair excepted). It is an identity candidate only: a
 * continuation on it binds it through the existing verification or refuses,
 * and it grants no review, validation or author credit.
 */
export const evidenceOnlyPr = (t: Task): number | null =>
  !t.prUrl && !t.resumePrNumber && !t.reviewEntry?.prNumber && !t.resolution.revisionPrRepair && t.completion?.prNumber ? t.completion.prNumber : null;
/** Read-only terminal cleanup proof. Never closes a reopened PR or accepts a merge. */
export async function verifyCancelledWorkspacePr(t: Task, transport: typeof api = api, repository?: string): Promise<void> {
  const number = t.completion?.prNumber ?? t.resumePrNumber;
  if (!number) {
    if (t.prUrl) throw Error('Recorded PR identity is incomplete; workspace preserved');
    return;
  }
  const name = repository ?? await repo(t);
  const pr = await transport(t, `repos/${name}/pulls/${number}`);
  if (pr.head?.ref !== t.branch || pr.head?.repo?.full_name !== name || pr.base?.repo?.full_name !== name || pr.base?.ref !== t.baseBranch)
    throw Error('Recorded PR identity changed; workspace preserved');
  if (pr.state !== 'closed' || pr.merged !== false) throw Error('Workspace retirement requires the recorded PR to be closed and unmerged');
}
/**
 * The recorded PR is provably not this task's own: it was observed, and its
 * head branch or repository does not match the task. A definite identity
 * finding, never an uncertain outcome (nucleus#1000) — a disposition's PR
 * steps act only on the PR whose branch and repository match the task.
 */
export class ForeignRecordedPr extends Error {}
/** Cancel only the PR recorded by this task. The task marker reconciles a lost comment response. */
export async function settleCancelledPr(t: Task, transport: typeof api = api, repository?: string): Promise<string> {
  const number=t.completion?.prNumber??t.resumePrNumber;
  if(!number)return 'No task-owned PR was recorded';
  const name=repository??await repo(t), endpoint=`repos/${name}/pulls/${number}`;
  const observe=async()=>transport(t,endpoint);
  let pr=await observe();
  if(pr.head?.ref!==t.branch||pr.head?.repo?.full_name!==name||pr.base?.repo?.full_name!==name)
    throw new ForeignRecordedPr(`Recorded PR #${number} does not match task branch and repository`);
  if(pr.state==='closed')return pr.merged?'Recorded PR already merged; untouched':'Recorded PR already closed; untouched';
  if(pr.state!=='open')throw Error(`Recorded PR #${number} has unknown state`);
  const marker=`<!-- northstar-cancel:${t.id}:${number} -->`;
  const actor=String((await transport(t,'user')).login);
  const comments=async()=>{
    const pages=await transport(t,`repos/${name}/issues/${number}/comments?per_page=100`,['--paginate','--slurp']);
    if(!Array.isArray(pages))throw Error('PR comment inventory is incomplete');
    return pages.flat().filter((comment:{body?:string;user?:{login?:string}})=>comment.user?.login===actor&&String(comment.body??'').includes(marker));
  };
  if(!(await comments()).length){
    try{await transport(t,`repos/${name}/issues/${number}/comments`,['-X','POST','-f',`body=Cancelled: ${t.disposition!.reason}\n\n${marker}`]);}
    catch(error){if(!(await comments()).length)throw error;}
  }
  try{await transport(t,endpoint,['-X','PATCH','-f','state=closed']);}
  catch(error){pr=await observe();if(pr.state!=='closed')throw error;}
  pr=await observe();
  if(pr.state!=='closed')throw Error(`Recorded PR #${number} close was not observed`);
  return `Closed recorded PR #${number} with cancellation reason; branch retained`;
}
