import { taskPrNumber } from './pr-identity';
import { type Task, operatorSourceAcceptance, qualifiedOwnerAcceptance, type Run, type RepositoryChecksPolicy, type Completion } from '../../shared/contracts';
import { withIntegrationCheckout, git, gitStatus, verifyPr, queueCheckoutStatus } from '../git/index';
import { type ReviewerSetting, type FormalReviewRuntime, verifyReview } from './reviews';
import { readyReviewAtHead } from '../recovery/task-reasons';
import { type CheckHistory, type GateEvidence, type CheckRequirementTransport, requiredCheckRequirements, branchUpdateRequired, observeCheckClassification, type CheckClassification, requiredChecks } from './checks';
import { api, repo } from './github-client';
import { requestServiceRollAfterRepositorySync } from './roll-request';

export function classifyGithubMerge(p: {mergeable: string; mergeStateStatus: string}, updateBranchRequired: boolean, options: {advisoryChecks?: boolean} = {}): {wait: string; needsRebase?: true} {
  if (p.mergeable === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY') return {wait: MERGE_CONFLICT_REASON, needsRebase: true};
  if (p.mergeable === 'UNKNOWN' || p.mergeStateStatus === 'UNKNOWN') return {wait: `GitHub merge state is ${p.mergeStateStatus}; branch rules must be satisfied`};
  if (p.mergeable !== 'MERGEABLE') return {wait: `GitHub merge state is ${p.mergeStateStatus}; branch rules must be satisfied`};
  if (p.mergeStateStatus === 'BEHIND') {
    if (updateBranchRequired) return {wait: 'Repository requires the PR head to include the current base', needsRebase: true};
    return {wait: ''};
  }
  if (p.mergeStateStatus === 'CLEAN' || p.mergeStateStatus === 'HAS_HOOKS') return {wait: ''};
  // GitHub reports UNSTABLE for a mergeable PR whose failing or pending checks are
  // not required. Under an advisory policy those checks are recorded evidence, so
  // the label must not reintroduce their block. BLOCKED keeps its meaning: missing
  // review, a required check or another branch rule still refuses the merge.
  if (p.mergeStateStatus === 'UNSTABLE' && options.advisoryChecks) return {wait: ''};
  if (p.mergeStateStatus === 'BLOCKED' && updateBranchRequired) return {wait: 'Repository requires the PR head to include the current base', needsRebase: true};
  return {wait: `GitHub merge state is ${p.mergeStateStatus}; branch rules must be satisfied`};
}
export async function integrationBaseGate(t: Pick<Task,'repoPath'|'baseBranch'|'directory'> & Partial<Pick<Task,'brief'>>,_head:string) {
  return withIntegrationCheckout(t, async (checkout, unchanged) => {
    await git(checkout, 'fetch', 'origin', t.baseBranch);
    if (await git(checkout, 'branch', '--show-current') !== t.baseBranch || await gitStatus(checkout, 'status', '--porcelain')) throw new Error('Preserving dirty or switched integration checkout');
    const base=await git(checkout,'rev-parse',`refs/remotes/origin/${t.baseBranch}`);
    if(await git(checkout,'rev-parse','HEAD')!==base)throw new Error('Local integration branch must match origin before merge');
    if(!t.directory)throw new Error('Task has no worktree');
    await unchanged();
    return {base,wait:''};
  });
}
/** The review evidence a merge requires: the accepted exact-head review, verified under its reviewer identity when the repository opted in. A qualified owner acceptance keeps the same proof burden for the authentic verdict it binds — the recorded `changes_required` review is verified at the exact head instead of being waived. An explicit operator source acceptance (2026-10-20) binds the exact current head with no review identity: nothing is verified or invented here, and GitHub's own branch rules still gate the merge. An opted-in repository cannot skip the gate for a recorded verdict: a review-backed acceptance still needs the authentic reviewed evidence verified at the forge. */
export async function requiredMergeReview(t: Task, reviewer?: ReviewerSetting | null, runtime?: FormalReviewRuntime) {
  if (t.skipPRReview && !reviewer) return;
  const r = t.resolution.review;
  // A source acceptance binds the current head with no review identity; a verdict
  // at an older head, even an approval, is history it outlived (papercut 209406f4).
  if (operatorSourceAcceptance(t) && !readyReviewAtHead(t)) return;
  if (!r || (r.status !== 'ready_to_merge' && !qualifiedOwnerAcceptance(t))) throw new Error('The recorded review does not approve merging');
  await verifyReview(t, { id: r.runId, head: t.prHead! } as Run, r, reviewer, runtime);
}
/**
 * Queue's own GitHub review-requirement gate. Under a qualified owner acceptance
 * or an explicit operator source acceptance the recorded owner disposition is
 * the approval Queue reads; GitHub's own rules (branch protection, merge state,
 * required checks) still gate through mergeable and mergeStateStatus, so a
 * protected repository still refuses.
 */
export function reviewRequirementsWait(t: Task, reviewDecision: string | null | undefined): string {
  return !qualifiedOwnerAcceptance(t) && !operatorSourceAcceptance(t)
    && (reviewDecision === 'CHANGES_REQUESTED' || reviewDecision === 'REVIEW_REQUIRED')
    ? 'GitHub review requirements are not satisfied' : '';
}
export async function mergeGate(t: Task, history?: CheckHistory, reviewer?: ReviewerSetting | null, checksPolicy: RepositoryChecksPolicy = 'all', runtime?: FormalReviewRuntime): Promise<GateEvidence> {
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try { return await work(); } finally { timings[name] = Date.now() - started; }
  };
  const verify = runtime?.verifyPr ?? verifyPr;
  const pr = await timed('pr_identity', () => verify(t, taskPrNumber(t)));
  // This attempt's PR observation also binds the review identity check.
  const reads = new Map<string, Promise<unknown>>();
  const read: CheckRequirementTransport = (task, endpoint, args = []) => {
    const key = JSON.stringify([endpoint, args]);
    if (!reads.has(key)) reads.set(key, api(task, endpoint, args));
    return reads.get(key)!;
  };
  const name = await timed('repository', () => repo(t)), [owner, repository] = name.split('/');
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefOid baseRefName isDraft state mergeable mergeStateStatus reviewDecision reviewThreads(first:100){nodes{isResolved isOutdated}pageInfo{hasNextPage}}statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{databaseId name status conclusion startedAt completedAt detailsUrl checkSuite{app{databaseId}}} ... on StatusContext{context state targetUrl}}pageInfo{hasNextPage}}}}}}`;
  const [data, , gate, requirements, updateRequired] = await Promise.all([
    timed('graphql', () => api(t, 'graphql', ['-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repository}`, '-F', `number=${taskPrNumber(t)}`])),
    timed('review_identity', () => requiredMergeReview(t, reviewer, {...runtime, verifyPr: async () => pr})),
    timed('integration_base', () => integrationBaseGate(t, pr.head)),
    checksPolicy === 'required' ? timed('check_requirements', () => requiredCheckRequirements(t, owner, repository, t.baseBranch, read)) : undefined,
    // Finish the other reads before surfacing a strict-rule refusal. In
    // particular, the integration checkout must not outlive this attempt.
    timed('branch_update_rules', () => branchUpdateRequired(t, owner, repository, t.baseBranch, read))
      .then(value => ({value}), error => ({error})),
  ]);
  if ('error' in updateRequired) throw updateRequired.error;
  if (data.errors?.length) throw new Error('GitHub merge gate query failed');
  const p = data.data?.repository?.pullRequest;
  if (!p || p.headRefOid !== pr.head || p.baseRefName !== t.baseBranch || p.isDraft || p.state !== 'OPEN') throw new Error('PR identity changed during merge verification');
  if (p.reviewThreads.pageInfo.hasNextPage || p.statusCheckRollup?.contexts.pageInfo.hasNextPage) throw new Error('Merge evidence pagination is incomplete');
  if (p.reviewThreads.nodes.some((n: {isResolved: boolean}) => !n.isResolved)) return { timings, head: pr.head, base: gate.base, wait: 'Unresolved PR review threads remain' };
  const reviewWait = reviewRequirementsWait(t, p.reviewDecision);
  if (reviewWait) return { timings, head: pr.head, base: gate.base, wait: reviewWait };
  // Requirement discovery reads the exact base branch GitHub enforces. A local
  // advisory setting never becomes an empty requirement set by default.
  const checks = await timed('check_classification', () => observeCheckClassification(t, p.statusCheckRollup?.contexts.nodes ?? [], history?.forHead?.(pr.head) ?? history, checksPolicy, requirements, owner, repository));
  if (checks.wait) return { timings, head: pr.head, base: gate.base, ...checks };
  const merge=classifyGithubMerge({mergeable:String(p.mergeable),mergeStateStatus:String(p.mergeStateStatus)},updateRequired.value,{advisoryChecks: checksPolicy === 'required' && Boolean(requirements?.known)});
  const observed = checksPolicy === 'required' ? {checksPolicy, requirements: checks.requirements, requiredEvidence: checks.requiredEvidence, advisory: checks.advisory} : {};
  if (merge.wait) return { timings, head: pr.head, base: gate.base, ...merge, ...observed };
  return { timings, head: pr.head, base: gate.base, wait: '', ...observed };
}
/** Covering evidence for a subsequent review round: the exact PR's checks and the
 * integration base it would merge into. It never asks whether a review approves
 * merging — the next reviewer has not reviewed yet — and grants no merge credit;
 * the full merge gate still runs before any merge. */
export async function coveringEvidence(t: Task, history?: CheckHistory, checksPolicy: RepositoryChecksPolicy = 'all'): Promise<CheckClassification & {head: string; base: string}> {
  const checks = await requiredChecks(t, history, checksPolicy);
  const gate = await integrationBaseGate(t, checks.head);
  return { ...checks, base: gate.base };
}
export async function merge(t: Task, allowed: () => boolean = () => true) {
  const name = await repo(t);
  if (!allowed()) throw new Error('Paused before merge request');
  // The server atomically rejects a PR head different from this reviewed head.
  const response = await api(t, `repos/${name}/pulls/${taskPrNumber(t)}/merge`, ['-X', 'PUT', '-f', `sha=${t.resolution.mergeHead}`, '-f', 'merge_method=merge']);
  if (!response.merged) throw new Error(response.message || 'GitHub did not confirm merge');
}
export async function merged(t: Task) {
  const p = await api(t, `repos/${await repo(t)}/pulls/${taskPrNumber(t)}`);
  if (p.merged) return { merged: true, commit: p.merge_commit_sha as string, head: String(p.head.sha), base: String(p.base.ref) };
  const commit=await exactIntendedMerge(t);
  if (commit) return { merged: true, commit, head: String(p.head.sha), base: String(p.base.ref) };
  let proof: { proven: boolean; detail: string };
  try {
    const name = await repo(t), [owner, repository] = name.split('/');
    const query = `query($owner:String!,$repo:String!,$number:Int!,$branch:String!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefName state merged mergeable mergeStateStatus autoMergeRequest{enabledAt} isInMergeQueue isMergeQueueEnabled mergeQueueEntry{id}} mergeQueue(branch:$branch){id}}}`;
    const data = await api(t, 'graphql', ['-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repo=${repository}`, '-F', `number=${taskPrNumber(t)}`, '-f', `branch=${t.baseBranch}`]);
    proof = classifyUncertainMergeProof(data.data?.repository, t.resolution.mergeHead, t.baseBranch, data.errors?.length
      ? `GraphQL returned errors: ${data.errors.map((error: { message?: string }) => error.message ?? 'unknown').join('; ')}`
      : '');
  } catch (error) {
    proof = { proven: false, detail: `GraphQL merge-queue proof is unavailable: ${String(error).slice(0, 500)}` };
  }
  return { merged: false, commit: null, head: String(p.head.sha), base: String(p.base.ref), proof };
}

/** Complete evidence needed before a guarded uncertain-merge re-issue. */
export function classifyUncertainMergeProof(repository: any, mergeHead: string | null, baseBranch: string, unavailableReason = '') {
  const pr = repository?.pullRequest;
  const queue = repository?.mergeQueue;
  const queueFieldPresent = Boolean(repository && Object.hasOwn(repository, 'mergeQueue'));
  const queueDisabled = pr?.isMergeQueueEnabled === false && pr?.isInMergeQueue === false && pr?.mergeQueueEntry === null;
  const queueConfigured = pr?.isMergeQueueEnabled === true && Boolean(queue) && pr?.isInMergeQueue === false && pr?.mergeQueueEntry === null;
  const conditions = {
    open: pr?.state === 'OPEN',
    unmerged: pr?.merged === false,
    head: typeof mergeHead === 'string' && pr?.headRefOid === mergeHead,
    base: pr?.baseRefName === baseBranch,
    autoMergeAbsent: pr?.autoMergeRequest === null,
    mergeQueueAvailable: queueFieldPresent && (queueDisabled || queueConfigured),
    mergeQueueEntryAbsent: queueDisabled || queueConfigured,
    mergeable: pr?.mergeable === 'MERGEABLE' && ['CLEAN', 'UNSTABLE'].includes(pr?.mergeStateStatus),
  };
  const proven = !unavailableReason && Object.values(conditions).every(Boolean);
  const failures = Object.entries(conditions).filter(([, value]) => !value).map(([name]) => name);
  return { proven, detail: JSON.stringify({ conditions, queueConfigured: Boolean(queue), queueEntry: pr?.mergeQueueEntry ?? null, ...(unavailableReason ? { unavailable: unavailableReason } : {}), failures }) };
}

export async function exactIntendedMerge(t: Pick<Task,'repoPath'|'baseBranch'|'resolution'>) {
  const base=t.resolution.mergeBase,head=t.resolution.mergeHead;
  if(!base||!head)return null;
  await git(t.repoPath,'fetch','origin',t.baseBranch);
  const remote=await git(t.repoPath,'rev-parse',`refs/remotes/origin/${t.baseBranch}`);
  const rows=(await git(t.repoPath,'rev-list','--first-parent','--merges','--parents',`${base}..${remote}`)).split('\n').filter(Boolean);
  const matches=rows.filter(row=>{const [,first,second,...extra]=row.split(' ');return first===base&&second===head&&!extra.length;});
  if(matches.length>1)throw Error('Multiple exact merge commits match the recorded merge intent');
  return matches[0]?.split(' ')[0]??null;
}
export async function syncMain(t: Task, allowed: () => boolean = () => true) {
  const commit = await withIntegrationCheckout(t, (checkout, unchanged) => syncIntegrationCheckout({...t, repoPath: checkout}, allowed, unchanged));
  if (await git(t.repoPath, 'branch', '--show-current') === t.baseBranch) requestServiceRollAfterRepositorySync(t.repoPath);
  return commit;
}
async function syncIntegrationCheckout(t: Task, allowed: () => boolean, unchanged: () => Promise<void>) {
  if (!t.resolution.mergedCommit) throw new Error('Merge has not been verified');
  if (await git(t.repoPath, 'branch', '--show-current') !== t.baseBranch || await gitStatus(t.repoPath, 'status', '--porcelain')) throw new Error('Preserving dirty or switched integration checkout after merge');
  await git(t.repoPath, 'fetch', 'origin', t.baseBranch);
  const remote = await git(t.repoPath, 'rev-parse', `refs/remotes/origin/${t.baseBranch}`);
  await git(t.repoPath, 'merge-base', '--is-ancestor', t.resolution.mergedCommit, remote);
  // Local main ahead of origin (a commit not yet pushed) is repository
  // contention that clears when its author pushes, not a fault: name it so the
  // contention grace applies. Only "not an ancestor" (exit 1) is that state.
  try { await git(t.repoPath, 'merge-base', '--is-ancestor', 'HEAD', remote); }
  catch (error) {
    if ((error as { code?: unknown }).code === 1)
      throw new Error(`Local integration branch differs from origin: local ${t.baseBranch} has commits that origin/${t.baseBranch} does not`);
    throw error;
  }
  if (await git(t.repoPath, 'branch', '--show-current') !== t.baseBranch || await gitStatus(t.repoPath, 'status', '--porcelain')) throw new Error('Integration checkout changed while fetching');
  await unchanged();
  if (!allowed()) throw new Error('Paused before local main update');
  await git(t.repoPath, 'merge', '--ff-only', remote);
  if (await git(t.repoPath, 'rev-parse', 'HEAD') !== remote || await gitStatus(t.repoPath, 'status', '--porcelain')) throw new Error('Integration synchronization did not leave a clean expected head');
  return remote;
}
// Closeout may publish canonical Markdown below the three docs subtrees plus the
// exact root docs front door; no other root docs path is admitted.
const canonicalCloseoutPath=(path:string)=>path==='docs/README.md'||/^docs\/(?:logs|roadmaps|handoffs)\/.+\.md$/.test(path);
export async function verifyCloseoutPublication(t:Task,result?:Completion) {
  return withIntegrationCheckout(t, (checkout) => verifyIntegrationCloseoutPublication({...t, repoPath: checkout}, result));
}
async function verifyIntegrationCloseoutPublication(t:Task,result?:Completion) {
  const baseline=t.resolution.syncedCommit;if(!baseline||!t.resolution.mergedCommit)throw Error('Closeout requires merge and sync evidence');
  const actual=await git(t.repoPath,'rev-parse','HEAD');
  if(await git(t.repoPath,'branch','--show-current')!==t.baseBranch||await gitStatus(t.repoPath,'status','--porcelain'))throw Error('Integration checkout is not clean for closeout');
  if(actual!==baseline&&!result?.closeoutCommit)throw Error('Integration head changed during closeout; report the published closeout commit or retry with refreshed evidence');
  if(result?.closeoutCommit&&result.closeoutCommit!==actual)throw Error('Published closeout commit differs from integration HEAD');
  await git(t.repoPath,'fetch','origin',t.baseBranch);
  const remote=await git(t.repoPath,'rev-parse',`refs/remotes/origin/${t.baseBranch}`);
  if(remote!==actual)throw Error('Closeout must be published and match origin before completion');
  await git(t.repoPath,'merge-base','--is-ancestor',baseline,actual);
  await git(t.repoPath,'merge-base','--is-ancestor',t.resolution.mergedCommit,actual);
  const paths=(await git(t.repoPath,'diff','--name-only','-z',baseline,actual)).split('\0').filter(Boolean);
  for(const path of paths){
    if(!canonicalCloseoutPath(path))throw Error(`Closeout publication changed a path outside canonical closeout: ${path}`);
    const file=await git(t.repoPath,'ls-tree',actual,'--',path);
    if(!file&&path===t.handoffPath&&/^docs\/handoffs\/.+\.md$/.test(path))continue;
    if(!file.startsWith('100644 blob '))throw Error(`Closeout publication must preserve regular Markdown files: ${path}`);
  }
  if(await git(t.repoPath,'rev-parse','HEAD')!==actual||await git(t.repoPath,'branch','--show-current')!==t.baseBranch||await gitStatus(t.repoPath,'status','--porcelain'))throw Error('Integration checkout changed while verifying closeout');
  return actual;
}
export async function verifyCloseout(t: Task,result?:Completion) {
  const p = await merged(t);
  if (!p.merged || p.commit !== t.resolution.mergedCommit || p.head !== t.resolution.mergeHead) throw new Error('Closeout merge evidence changed');
  return verifyCloseoutPublication(t,result);
}

/**
 * `acceptHead`: the owner's move to closeout. A planner may push on top of the
 * recorded head and merge; the merged head is then accepted only when it descends from
 * the recorded work, never when it replaces it.
 */
export async function externalMerge(t: Task, acceptHead = false, retainedSource = false) {
  const name=await repo(t);
  const p=await api(t,`repos/${name}/pulls/${taskPrNumber(t)}`);
  if(retainedSource && (p.merged!==true || p.state!=='closed' || p.draft!==false || p.number!==taskPrNumber(t) || p.html_url!==t.prUrl || !/^[a-f0-9]{40}$/.test(String(p.head?.sha??''))))
    throw new Error('External merge requires the positively merged, ready canonical task PR and exact head');
  const commit=await reportedOrExactMergeCommit(t,p);
  if(retainedSource && !commit)throw new Error('External merge identity does not match: the merge commit is unknown');
  if(!commit)return null;
  if(p.base?.repo?.full_name?.toLowerCase()!==name.toLowerCase() || p.head?.repo?.full_name?.toLowerCase()!==name.toLowerCase() || p.base.ref!==t.baseBranch || p.head.ref!==t.branch || !/^[a-f0-9]{40}$/.test(commit))throw new Error('External merge identity does not match the task repository and branches');
  if(!t.directory || await git(t.directory,'branch','--show-current')!==t.branch || await queueCheckoutStatus(t.directory,...(retainedSource?['--no-optional-locks']:[]),'status','--porcelain'))throw new Error('Preserving dirty or switched worktree after external merge');
  const head=await git(t.directory,'rev-parse','HEAD');
  if(retainedSource){
    if(head!==t.prHead)throw new Error('The retained workspace head differs from the recorded task source');
    try{await git(t.directory,'merge-base','--is-ancestor',head,p.head.sha);}catch{throw new Error('The merged head does not descend from the retained task source, or its ancestry is unreadable');}
    return {head:p.head.sha as string,commit};
  }
  if(head!==p.head.sha)throw new Error('External merge head differs from recorded task work');
  if(t.prHead && t.prHead!==head){
    if(!acceptHead)throw new Error('External merge head differs from recorded task work');
    try{await git(t.directory,'merge-base','--is-ancestor',t.prHead,head);}catch{throw new Error('The merged head does not descend from the recorded task work');}
  }
  return {head,commit};
}

export async function reportedOrExactMergeCommit(t:Pick<Task,'repoPath'|'baseBranch'|'resolution'>,p:{merged?:boolean;merge_commit_sha?:unknown}) {
  return p.merged?String(p.merge_commit_sha??''):exactIntendedMerge(t);
}

export const MERGE_CONFLICT_REASON = 'GitHub reports a merge conflict; the worker must update the PR head';
