import type { ReviewerSetting } from '../../core/host/types';
export type { ReviewerSetting } from '../../core/host/types';
import { type Task, type Run, type Completion } from '../../shared/contracts';
import { api, repo, commandErrorText, type CheckEvidenceTransport } from './github-client';
import { taskPrNumber } from './pr-identity';
import { verifyPr, command } from '../git/index';
import { reviewMarker, reviewPublicationBody } from '../../shared/review-text';
import { type Store, digest } from '../store/store';
import { reviewPublicationKey, claimReviewPublication, type PublicationRecord } from '../review/review-publication';
import { formalReviewHttp } from './formal-review-http';
import { LoginSessionFaultError } from '../../shared/session-fault';
import { classifyGitCommandFailure, GitTransientError, classifyGitTransientFailure } from './forge-health';

type ReviewComment = {id?:unknown;issue_url?:string;user?:{login?:string};body?:unknown};
export function uniqueMarkedReviewComment(comments:ReviewComment[],issueUrl:string,login:string,marker:string) {
  const matches=comments.filter(comment=>comment.issue_url===issueUrl&&comment.user?.login===login&&
    String(comment.body).includes(marker)&&String(comment.body).split('<!-- northstar-review:').length===2&&Number.isSafeInteger(comment.id));
  // Task 704: a duplicate exact-marker comment is the real outcome of a
  // publication race. The earliest is the record; the other stays in place.
  if(!matches.length)throw Error(`Review comment reconciliation requires exactly one authenticated exact-marker match; found 0`);
  return earliestPublication(matches) as ReviewComment&{id:number};
}
/** Queue 524 (papercut 2061d84f): author evidence posted as PR issue comments.
 * The reviewer reads each body with gh; the prompt carries only a pointer plus
 * bounded metadata (comment IDs, author, timestamps, size), never large bodies. */
type PrIssueComment = { id?: unknown; user?: { login?: unknown }; created_at?: unknown; updated_at?: unknown; body?: unknown };
export const AUTHOR_COMMENT_EVIDENCE_MAX = 20;
export function formatAuthorCommentEvidence(comments: PrIssueComment[], opts: { head: string; repository: string; prNumber: number; priorCommentId?: number | null; max?: number }): string {
  const max = opts.max ?? AUTHOR_COMMENT_EVIDENCE_MAX;
  const entries = comments
    .filter((comment): comment is PrIssueComment & { id: number } => Number.isSafeInteger(comment.id))
    .filter(comment => !String(comment.body ?? '').includes('<!-- northstar-'))
    .sort((a, b) => a.id - b.id);
  if (!entries.length) return '';
  const shown = entries.slice(-max);
  const prior = opts.priorCommentId ?? null;
  const lines = shown.map(comment => {
    const login = typeof comment.user?.login === 'string' && comment.user.login ? comment.user.login : 'unknown';
    const created = typeof comment.created_at === 'string' && comment.created_at ? comment.created_at : 'unknown time';
    const updated = typeof comment.updated_at === 'string' && comment.updated_at ? comment.updated_at : null;
    const size = String(comment.body ?? '').length;
    const fresh = prior != null && comment.id > prior ? ' (new since the last review)' : '';
    return `- id ${comment.id} by @${login} at ${created}${updated && updated !== created ? ` (updated ${updated})` : ''}, ${size} chars${fresh}`;
  });
  const truncated = entries.length > shown.length ? `Showing the most recent ${shown.length} of ${entries.length} non-review comments; list the rest with gh.\n` : '';
  return `Author evidence posted as PR issue comments for the current head ${opts.head} (PR #${opts.prNumber}; read each full body yourself with \`gh api repos/${opts.repository}/issues/comments/<id>\`; this metadata is a pointer, not the evidence):\n${lines.join('\n')}\n${truncated}Treat these comments as author evidence for the current head alongside the diff and earlier findings; never report "no author evidence" without reading each one above with gh.\n`;
}
/** Live fetch for the reviewer dispatch: every non-review PR issue comment, formatted as a bounded pointer. Empty when none exist. */
export async function authorCommentEvidence(t: Task, priorCommentId?: number | null, transport: CheckEvidenceTransport = api): Promise<string> {
  const number = taskPrNumber(t);
  const name = await repo(t);
  const head = t.prHead;
  if (!head) return '';
  const pages = await transport(t, `repos/${name}/issues/${number}/comments?per_page=100`, ['--paginate', '--slurp']);
  if (!Array.isArray(pages)) throw Error('PR comment inventory is incomplete');
  return formatAuthorCommentEvidence(pages.flat(), { head, repository: name, prNumber: number, priorCommentId: priorCommentId ?? null });
}
export async function verifyReview(t: Task, run: Run, result: Completion, reviewer?: ReviewerSetting | null, runtime?: FormalReviewRuntime):Promise<number> {
  if (reviewer) return verifyFormalReview(t, run, result, reviewer, runtime);
  return verifyReviewComment(t, run, result, runtime);
}
async function verifyReviewComment(t: Task, run: Run, result: Completion, runtime?: FormalReviewRuntime):Promise<number> {
  const pr = await (runtime?.verifyPr ?? verifyPr)(t, taskPrNumber(t));
  if (pr.head !== run.head || result.head !== run.head) throw new Error('Review is stale for the current PR head');
  const name = await repo(t);
  const user = await api(t, 'user');
  const issueUrl=`https://api.github.com/repos/${name}/issues/${taskPrNumber(t)}`,marker=reviewMarker(t,run.id,run.head,result.status);
  let comment:ReviewComment;
  try { comment=await api(t, `repos/${name}/issues/comments/${result.reviewCommentId}`); }
  catch {
    // A reviewer can report a neighbouring numeric ID even though its durable
    // comment is sound. Never guess: recover only one authenticated comment on
    // this PR carrying the exact immutable task/run/head/verdict marker.
    const pages=await api(t,`repos/${name}/issues/${taskPrNumber(t)}/comments?per_page=100`,['--paginate','--slurp']);
    comment=uniqueMarkedReviewComment(pages.flat(),issueUrl,user.login,marker);
  }
  validateReviewComment(comment,issueUrl,user.login,marker);
  if(!Number.isSafeInteger(comment.id))throw Error('Review comment has no durable numeric ID');
  return comment.id as number;
}


// Accepted reports are immutable. Reconcile a reviewer-supplied marker only when
// it already proves precisely this task/run/head/verdict; never rewrite findings.
export async function publishReview(store:Store,t:Task,run:Run,status:string,text:string,allowed:()=>boolean=()=>true,reviewer?:ReviewerSetting|null,runtime?:FormalReviewRuntime):Promise<number> {
  return (await publishReviewOnce(store,t,run,status,text,allowed,reviewer,runtime)).id;
}
/**
 * Task 704: one reviewer run publishes one review, however many passes observe
 * it. Concurrent calls for the same run share one flight, so the second caller
 * observes the first caller's result instead of posting a second review, and
 * `published` tells the caller whether it performed the GitHub side effect at
 * all. A repeat that reuses a recorded publication is therefore silent.
 */
export type PublicationOutcome = { id: number; published: boolean };
const publicationFlights = new Map<string, Promise<PublicationOutcome>>();
function singleFlightPublication(runId: string, begin: () => Promise<PublicationOutcome>): Promise<PublicationOutcome> {
  const key = reviewPublicationKey(runId);
  const existing = publicationFlights.get(key);
  // A joiner performed no side effect, so it reports none: only the caller that
  // started the flight records the publication.
  if (existing) return existing.then(outcome => ({ ...outcome, published: false }));
  const flight = begin();
  publicationFlights.set(key, flight);
  const settle = () => { if (publicationFlights.get(key) === flight) publicationFlights.delete(key); };
  void flight.then(settle, settle);
  return flight;
}
/** The adapter entry point: the publication ID and whether this call posted it. */
export function publishReviewOnce(store:Store,t:Task,run:Run,status:string,text:string,allowed:()=>boolean=()=>true,reviewer?:ReviewerSetting|null,runtime?:FormalReviewRuntime):Promise<PublicationOutcome> {
  return singleFlightPublication(run.id, () => reviewer
    ? publishFormalReviewOnce(store,t,run,status,text,reviewer,allowed,runtime)
    : publishReviewCommentOnce(store,t,run,status,text,allowed));
}
/** Bounded wait for the pass that won a publication claim to record its GitHub ID. */
const PUBLICATION_SETTLE_POLLS = 6;
const PUBLICATION_SETTLE_POLL_MS = 500;
function positivePublicationId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
async function awaitRecordedPublication(store: Store, key: string): Promise<void> {
  for (let attempt = 0; attempt < PUBLICATION_SETTLE_POLLS; attempt++) {
    const record = store.getMeta<{ reviewId?: unknown; commentId?: unknown }>(key);
    if (record && typeof record === 'object' && (positivePublicationId(record.reviewId) || positivePublicationId(record.commentId))) return;
    if (attempt + 1 < PUBLICATION_SETTLE_POLLS) await new Promise(resolve => setTimeout(resolve, PUBLICATION_SETTLE_POLL_MS));
  }
}
/** The earliest publication GitHub retained: `submitted_at` when both parse, then the durable ID. */
function earliestPublication<T extends { id?: unknown; submitted_at?: unknown }>(items: T[]): T {
  return [...items].sort((left, right) => {
    const a = Date.parse(String(left.submitted_at ?? '')), b = Date.parse(String(right.submitted_at ?? ''));
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    return Number(left.id) - Number(right.id);
  })[0]!;
}
async function publishReviewCommentOnce(store:Store,t:Task,run:Run,status:string,text:string,allowed:()=>boolean=()=>true):Promise<PublicationOutcome> {
  const pr=await verifyPr(t,taskPrNumber(t));if(pr.head!==run.head)throw Error('Review is stale for the current PR head');
  const body=reviewPublicationBody(t,run,status,text,store.run(run.id)?.completion?.verdicts??[]);
  const key=reviewPublicationKey(run.id),hash=digest(body),previous=store.getMeta<{hash:string;commentId?:number}>(key);
  if(previous && previous.hash!==hash)throw Error('This run already has a different review publication');
  const name=await repo(t),user=await api(t,'user');
  const verifyComment=async(id:number):Promise<PublicationOutcome>=>{
    const comment=await api(t,`repos/${name}/issues/comments/${id}`);
    if(comment.body!==body || comment.user?.login!==user.login || comment.issue_url!==`https://api.github.com/repos/${name}/issues/${taskPrNumber(t)}`)throw Error('Published review changed; inspect it before retrying');
    return {id,published:false};
  };
  if(positivePublicationId(previous?.commentId))return verifyComment(previous.commentId);
  if(previous){
    const pages=await api(t,`repos/${name}/issues/${taskPrNumber(t)}/comments?per_page=100`,['--paginate','--slurp']);
    // Two comments carrying this publication's exact body are the race's real
    // outcome: the earliest is the record and the later one stays in place.
    const matches=pages.flat().filter((c:any)=>c.body===body&&c.user?.login===user.login);
    if(!matches.length)throw Error('Review publication is uncertain; no duplicate comment will be posted. Inspect the PR.');
    const earliest=earliestPublication(matches) as {id:number};
    store.setMeta(key,{hash,commentId:earliest.id});return {id:earliest.id,published:false};
  }
  if(!allowed())throw Error('Paused before review publication');
  const claim=claimReviewPublication(store,run.id,hash,'comment');
  if(claim.kind==='settled')return verifyComment(claim.id);
  if(claim.kind==='intent'){
    // Another pass holds the durable intent; observe its result, never repost.
    await awaitRecordedPublication(store,key);
    return publishReviewCommentOnce(store,t,run,status,text,allowed);
  }
  const comment=await api(t,`repos/${name}/issues/${taskPrNumber(t)}/comments`,['-X','POST','-f',`body=${body}`]);
  if(!Number.isSafeInteger(comment.id)||comment.body!==body||comment.user?.login!==user.login)throw Error('GitHub returned an unexpected review publication');
  store.setMeta(key,{hash,commentId:comment.id});return {id:comment.id,published:true};
}

export function validateReviewComment(comment:{issue_url?:string;user?:{login?:string};body?:unknown},issueUrl:string,login:string,marker:string) {
  if (comment.issue_url !== issueUrl) throw new Error('Review comment belongs to a different PR');
  if (comment.user?.login !== login) throw new Error('Review comment author differs from the authenticated GitHub account');
  if (!String(comment.body).includes(marker)) throw new Error(/^@\//.test(String(comment.body).trim()) ? 'Review comment contains a literal file path instead of review text; use gh api -F body=@FILE, not -f' : 'Review comment is missing the marker for this run, head and verdict');
}

/**
 * Spec 033: formal PR reviews under a separate reviewer identity.
 *
 * A repository opts in through `repository.set` with `reviewer: {login}`. Queue
 * then publishes each accepted independent verdict as a formal GitHub review
 * from that login, pinned to the reviewed head, and requires that login's
 * APPROVED review at the current head before merge. The token is read from the
 * macOS login keychain at call time and passed only to these HTTPS calls;
 * it is never stored, logged, put in an agent environment or named in an error.
 */
export const REVIEWER_TOKEN_SERVICE = 'paseo-queue.github-reviewer';
export type FormalReviewRuntime = {
  readToken?: (org: string) => Promise<string>;
  runGh?: (task: Task, endpoint: string, args: string[], token: string) => Promise<unknown>;
  verifyPr?: (task: Task, number: number) => Promise<{ url: string; head: string }>;
};
type FormalReview = { id?: unknown; user?: { login?: string }; body?: unknown; commit_id?: unknown; state?: unknown; submitted_at?: unknown };

/** The keychain token for one org, or a loud refusal naming the org and what is missing. */
export async function readReviewerToken(org: string): Promise<string> {
  let token = '';
  try { token = (await command('security', ['find-generic-password', '-s', REVIEWER_TOKEN_SERVICE, '-a', org, '-w'], process.cwd())).trim(); }
  catch { token = ''; }
  if (!token) throw new Error(`No GitHub reviewer token for org ${org}: add the token to the login keychain with service ${REVIEWER_TOKEN_SERVICE} and account ${org}`);
  return token;
}
/** `ready_to_merge` approves, `changes_required` requests changes, anything else comments. */
export function reviewEventForStatus(status: string) { return status === 'ready_to_merge' ? 'APPROVE' : status === 'changes_required' ? 'REQUEST_CHANGES' : 'COMMENT'; }
export function reviewStateForStatus(status: string) { return status === 'ready_to_merge' ? 'APPROVED' : status === 'changes_required' ? 'CHANGES_REQUESTED' : 'COMMENTED'; }
async function formalGh(_task: Task, endpoint: string, args: string[], token: string): Promise<unknown> {
  return formalReviewHttp(endpoint, args, token);
}
const AUTHORITY_REFUSAL = /HTTP 40[13]|Bad credentials|Resource not accessible|write access|Must have write/i;
/**
 * Pick GitHub's own refusal line. The process output is read before the argv
 * echo, so a review body containing the word "error" can never hide the real
 * permission refusal behind the `Command failed: gh api ... -f body=...` line.
 */
function refusalReason(error: unknown, token: string): string {
  const redact = (value: string) => value.split(token).join('[redacted]');
  const extra = error && typeof error === 'object' ? error as { stderr?: unknown; stdout?: unknown } : {};
  const output = redact(`${String(extra.stderr ?? '')}\n${String(extra.stdout ?? '')}`).split('\n').map(line => line.trim()).filter(Boolean);
  const message = redact(error instanceof Error ? error.message : String(error)).split('\n').map(line => line.trim()).filter(Boolean);
  const actionable = [...output, ...message].find(line => AUTHORITY_REFUSAL.test(line));
  return (actionable ?? output[0] ?? message[0] ?? 'unknown refusal').slice(0, 300);
}
/** Never let a keychain token ride out in an error; name the org and the actionable GitHub refusal. */
async function formalCall<T>(org: string, token: string, operation: () => Promise<T>, deliveryUnknown = false): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const text = commandErrorText(error).split(token).join('[redacted]');
    if (error instanceof LoginSessionFaultError) throw new LoginSessionFaultError(new Error(text.trim()));
    if (AUTHORITY_REFUSAL.test(text))
      throw new Error(`GitHub reviewer identity for org ${org} cannot publish or verify formal reviews: ${refusalReason(error, token)}`);
    const reason = new Error(refusalReason(error, token));
    const kind = classifyGitCommandFailure(error);
    if (kind === 'network') throw new GitTransientError(kind, reason, deliveryUnknown);
    throw reason;
  }
}
/** Recover one authenticated review carrying the exact immutable task/run/head/verdict marker. */
export function uniqueMarkedReview(reviews: FormalReview[], login: string, marker: string) {
  const matches = reviews.filter(review => review.user?.login === login && String(review.body).includes(marker) &&
    String(review.body).split('<!-- northstar-review:').length === 2 && Number.isSafeInteger(review.id));
  // Task 704: two exact-marker reviews at this head are the real outcome of a
  // publication race, not an ambiguity to stop on. The earliest is the record
  // and the later one is left in place on GitHub.
  if (!matches.length) throw new Error(`Formal review reconciliation requires exactly one authenticated exact-marker match; found 0`);
  return earliestPublication(matches) as FormalReview & { id: number };
}
export function validateFormalReview(review: FormalReview, login: string, marker: string, head: string, status: string) {
  if (review.user?.login !== login) throw new Error('Formal review author differs from the configured reviewer login');
  if (review.commit_id !== head) throw new Error('Formal review is not pinned to the reviewed head');
  if (review.state !== reviewStateForStatus(status)) throw new Error('Formal review state does not match the recorded verdict');
  if (!String(review.body).includes(marker)) throw new Error('Formal review is missing the marker for this run, head and verdict');
}
async function listFormalReviews(task: Task, name: string, token: string, gh: NonNullable<FormalReviewRuntime['runGh']>): Promise<FormalReview[]> {
  const pages = await gh(task, `repos/${name}/pulls/${taskPrNumber(task)}/reviews?per_page=100`, ['--paginate', '--slurp'], token);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page) || page.some(review => !review || typeof review !== 'object' || !Number.isSafeInteger(review.id) || typeof review.body !== 'string' || typeof review.user?.login !== 'string' || typeof review.commit_id !== 'string' || typeof review.state !== 'string'))) throw new Error('Formal review inventory is incomplete');
  return pages.flat() as FormalReview[];
}
async function formalIdentity(task: Task, reviewer: ReviewerSetting, runtime: FormalReviewRuntime) {
  const name = await repo(task), org = name.split('/')[0];
  const token = await (runtime.readToken ?? readReviewerToken)(org);
  const gh = runtime.runGh ?? formalGh;
  return { name, org, token, gh };
}
export async function publishFormalReview(store: Store, t: Task, run: Run, status: string, text: string, reviewer: ReviewerSetting, allowed: () => boolean = () => true, runtime: FormalReviewRuntime = {}, recoveryReason?: string): Promise<number> {
  return (await singleFlightPublication(run.id, () => publishFormalReviewOnce(store, t, run, status, text, reviewer, allowed, runtime, recoveryReason))).id;
}
async function publishFormalReviewOnce(store: Store, t: Task, run: Run, status: string, text: string, reviewer: ReviewerSetting, allowed: () => boolean = () => true, runtime: FormalReviewRuntime = {}, recoveryReason?: string): Promise<PublicationOutcome> {
  const verify = runtime.verifyPr ?? verifyPr;
  const pr = await verify(t, taskPrNumber(t));
  if (pr.head !== run.head) throw new Error('Review is stale for the current PR head');
  const body = reviewPublicationBody(t, run, status, text, store.run(run.id)?.completion?.verdicts ?? []);
  const key = reviewPublicationKey(run.id), hash = digest(body);
  const previous = store.getMeta<PublicationRecord>(key);
  if (previous && previous.hash !== hash) throw new Error('This run already has a different review publication');
  const { name, org, token, gh } = await formalIdentity(t, reviewer, runtime);
  const marker = reviewMarker(t, run.id, run.head, status);
  const verifyRecorded = async (id: number): Promise<PublicationOutcome> => {
    const review = await formalCall(org, token, () => gh(t, `repos/${name}/pulls/${taskPrNumber(t)}/reviews/${id}`, [], token)) as FormalReview;
    if (String(review.body) !== body || review.user?.login !== reviewer.login || review.commit_id !== run.head || review.state !== reviewStateForStatus(status))
      throw new Error('Published formal review changed; inspect it before retrying');
    return { id, published: false };
  };
  if (positivePublicationId(previous?.reviewId)) return verifyRecorded(previous.reviewId);
  if (previous) {
    const inventory = await formalCall(org, token, () => listFormalReviews(t, name, token, gh));
    // A marker under any login is evidence of an existing side effect.
    const marked = inventory.filter(review => String(review.body).includes(marker));
    if (marked.length || (!recoveryReason && !previous.transientFailure)) {
      // Two exact-marker reviews are the real outcome of a publication race:
      // the earliest is the record and the later one stays on GitHub.
      const review = uniqueMarkedReview(inventory, reviewer.login, marker);
      if (String(review.body) !== body) throw new Error('Review publication is uncertain; the marked review does not match the persisted findings body hash. Inspect the PR.');
      validateFormalReview(review, reviewer.login, marker, run.head, status);
      if (!allowed()) throw new Error('Task changed before review publication reconciliation');
      store.setMeta(key, { hash, reviewId: review.id });
      return { id: review.id, published: false };
    }
    // Observe before every resend. A transient POST failure uses the existing
    // bounded lifecycle backoff; an owner retry also proves absence again.
    const attemptKey = `reviewPublicationRecovery:${run.id}`;
    const currentPr = await verify(t, taskPrNumber(t));
    if (currentPr.head !== run.head) throw new Error('Review is stale for the current PR head');
    const second = await formalCall(org, token, () => listFormalReviews(t, name, token, gh));
    if (second.some(review => String(review.body).includes(marker))) {
      const review = uniqueMarkedReview(second, reviewer.login, marker);
      if (String(review.body) !== body) throw new Error('Review publication body changed during reconciliation');
      validateFormalReview(review, reviewer.login, marker, run.head, status);
      if (!allowed()) throw new Error('Task changed before review publication reconciliation');
      store.setMeta(key, { hash, reviewId: review.id });
      return { id: review.id, published: false };
    }
    if (!allowed()) throw new Error('Task changed before review publication recovery');
    store.setMeta(attemptKey, { hash, head: run.head, login: reviewer.login, reason: recoveryReason, attemptedAt: new Date().toISOString() });
  }
  if (!allowed()) throw new Error('Paused before review publication');
  if (!previous) {
    // Task 704: the durable single-flight claim. Only the pass that writes the
    // intent in this transaction may post; every other pass observes instead.
    const claim = claimReviewPublication(store, run.id, hash, 'review');
    if (claim.kind === 'settled') return verifyRecorded(claim.id);
    if (claim.kind === 'intent') {
      await awaitRecordedPublication(store, key);
      return publishFormalReviewOnce(store, t, run, status, text, reviewer, allowed, runtime, recoveryReason);
    }
  } else store.setMeta(key, { hash, ...(previous.transientFailure ? { transientFailure: true } : {}) });
  let review: FormalReview;
  try { review = await formalCall(org, token, () => gh(t, `repos/${name}/pulls/${taskPrNumber(t)}/reviews`,
    ['-X', 'POST', '-f', `body=${body}`, '-f', `commit_id=${run.head}`, '-f', `event=${reviewEventForStatus(status)}`], token), true) as FormalReview;
  } catch (error) {
    if (classifyGitTransientFailure(error) === 'network')
      store.setMeta(key, { hash, transientFailure: true });
    throw error;
  }
  if (!Number.isSafeInteger(review.id) || review.user?.login !== reviewer.login || review.commit_id !== run.head || review.state !== reviewStateForStatus(status))
    throw new Error('GitHub returned an unexpected formal review');
  if (String(review.body) !== body) throw new Error('GitHub returned a different formal review body');
  if (!allowed()) throw new Error('Task changed after formal review publication; reconcile the persisted remote result');
  store.setMeta(key, { hash, reviewId: review.id });
  return { id: review.id as number, published: true };
}
export async function reconcileFormalReviewPublication(store: Store, t: Task, run: Run, reviewer: ReviewerSetting, reason: string, allowed: () => boolean, runtime: FormalReviewRuntime = {}): Promise<number> {
  const result = run.completion;
  if (!reason.trim() || run.role !== 'reviewer' || !run.released || run.status !== 'finished' || !result?.reviewText || !['ready_to_merge', 'changes_required'].includes(result.status) || result.runId !== run.id || result.taskId !== t.id || result.head !== run.head)
    throw new Error('Publication recovery requires the original released accepted reviewer verdict');
  const receipt = store.db.prepare('SELECT hash,response FROM receipts WHERE id=? AND task=? AND run=?')
    .get(result.eventId, t.id, run.id) as { hash: string; response: string } | undefined;
  if (!receipt || receipt.hash !== digest(JSON.stringify(result)) || JSON.parse(receipt.response).accepted !== true)
    throw new Error('Publication recovery requires the authenticated original reviewer receipt');
  if (!store.getMeta(reviewPublicationKey(run.id))) throw new Error('No original publication intent exists for this run');
  return publishFormalReview(store, t, run, result.status, result.reviewText, reviewer, allowed, runtime, reason);
}
export async function verifyFormalReview(t: Task, run: Run, result: Completion, reviewer: ReviewerSetting, runtime: FormalReviewRuntime = {}): Promise<number> {
  const verify = runtime.verifyPr ?? verifyPr;
  const pr = await verify(t, taskPrNumber(t));
  if (pr.head !== run.head || result.head !== run.head) throw new Error('Review is stale for the current PR head');
  const { name, org, token, gh } = await formalIdentity(t, reviewer, runtime);
  const marker = reviewMarker(t, run.id, run.head, result.status);
  let review: FormalReview;
  try { review = await formalCall(org, token, () => gh(t, `repos/${name}/pulls/${taskPrNumber(t)}/reviews/${result.reviewId}`, [], token)) as FormalReview; }
  catch (error) {
    // A neighbouring or absent numeric id is never guessed: recover only the one authenticated exact-marker review.
    if (error instanceof Error && /cannot publish or verify formal reviews/.test(error.message)) throw error;
    review = uniqueMarkedReview(await formalCall(org, token, () => listFormalReviews(t, name, token, gh)), reviewer.login, marker);
  }
  validateFormalReview(review, reviewer.login, marker, run.head, result.status);
  if (!Number.isSafeInteger(review.id)) throw new Error('Formal review has no durable numeric ID');
  return review.id as number;
}
