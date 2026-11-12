/**
 * Task 405: the source-immutable author-side proof executor.
 *
 * A manual or external source author may have no supported heavy launch route.
 * The brief can therefore name ONE selector and its exact input hashes, and the
 * project owner may activate one Queue-created proof-only run on the same task.
 * The executor receives ordinary admission wiring, runs only that selector
 * against the exact published head, and records its own authenticated evidence
 * separately from the unchanged source-author declaration.
 *
 * This module owns the source-immutable proofs and the append-only record
 * helpers. The run itself is an ordinary `executor` run in the task workspace;
 * it publishes no review, spends no reviewer credit and cannot reach merge.
 */
import { git, gitRaw } from '../git/index';
import { gitHash, gitNulEach } from '../git/git-command';
import { withFetchLock } from '../git/git-fetch';
import { TERMINAL_TOOL_STATUSES, type TimelineEntry } from '../recovery/stall';
import { now, type Store } from '../store/store';
import { awaitingProofRoute, awaitingProofText, awaitingProofTexts, type AwaitingProof, type ProofExecutionRecord, type Run, type Task } from '../../shared/contracts';

/** A typed refusal with the invariant and the verb that clears it. */
export class ProofExecutionRefusal extends Error {
  constructor(readonly code:
    | 'no_brief_subject'
    | 'allowance_spent'
    | 'not_authorized'
    | 'source_unavailable'
    | 'source_moved'
    | 'source_dirty'
    | 'source_branch'
    | 'live_run'
    | 'dispatch_held'
    | 'paused'
    | 'wrong_phase'
    | 'wrong_pr',
  message: string, readonly transient = false) { super(message); }
}

export const refuseProof = (code: ProofExecutionRefusal['code'], message: string, transient = false): never => {
  throw new ProofExecutionRefusal(code, message, transient);
};

/** The ordered execution history, including attempts with unknown start. */
export const proofExecutions = (task: Pick<Task, 'proofExecutions'>): ProofExecutionRecord[] => task.proofExecutions ?? [];

/** A reservation stays spent when start evidence is absent or legacy-inferred. */
export const spentProofExecution = (task: Pick<Task, 'proofExecutions'>, _runs: Pick<Run, 'id' | 'completion'>[] = []): ProofExecutionRecord | null =>
  proofExecutions(task)[0] ?? null;

/**
 * The settled proof-only receipt that still needs a verdict. Historical
 * receipts stay here: they spend no allowance but still need judgment.
 */
export function settledProofOnlyReceipt(
  task: Pick<Task, 'entrypoint' | 'proofOnly' | 'proofOnlyResult' | 'proofExecutions'>,
): ProofExecutionRecord | null {
  if (task.entrypoint !== 'proof' || !task.proofOnly || task.proofOnlyResult) return null;
  const receipt = spentProofExecution(task);
  if (!receipt || receipt.status === 'running' || receipt.head !== task.proofOnly.commit) return null;
  return receipt;
}

/** A proof-only qualification has a settled receipt and no recorded verdict. */
export const proofOnlyReceiptAwaitingReview = (
  task: Pick<Task, 'entrypoint' | 'proofOnly' | 'proofOnlyResult' | 'proofExecutions'>,
): boolean => settledProofOnlyReceipt(task) !== null;

/**
 * Task 560: single-flight launch refusal. Executor dispatch records its run
 * intent before the adapter call, and this is the check every dispatch path
 * (and the reservation transaction) reads: a second dispatch while an
 * executor run for the task is unreleased, or while a proof execution at that
 * head is already recorded, refuses before anything is sent. The proof-only
 * dispatch path and the in-review proof path both go through it.
 */
export function proofSingleFlightRefusal(
  task: Pick<Task, 'entrypoint' | 'proofOnly' | 'proofExecutions'>,
  runs: Pick<Run, 'id' | 'role' | 'head' | 'released' | 'status' | 'completion'>[],
  head: string,
): string | null {
  const executors = runs.filter(run => run.role === 'executor');
  const live = executors.find(run => !run.released);
  if (live) return `An author-side proof execution is already dispatched and unreleased (${live.id}); inspect it with task.detail`;
  if (task.entrypoint === 'proof' && task.proofOnly) {
    const spent = spentProofExecution(task, runs);
    const previous = executors[0] ?? null;
    if (spent || previous)
      return `This proof-only qualification already spent its one execution (${spent ? `${spent.runId}, ${spent.status}` : `${previous!.id}, ${previous!.status}`}); it is never repeated, refunded or reset. Inspect it with task.detail`;
    return null;
  }
  if (proofExecutions(task).some(proof => proof.head === head) || executors.some(run => run.head === head))
    return `An author-side proof execution was already reserved at ${head}; inspect it with task.detail`;
  return null;
}

/** A proof may be repeated only after a recorded author revision and source approval at a new exact head. */
export function proofHeadAdmission(task: Task, runs: Pick<Run, 'id' | 'role' | 'head' | 'released' | 'completion' | 'proofExecution'>[], head: string): string | null {
  if (proofExecutions(task).some(proof => proof.head === head)
    || runs.some(run => run.role === 'executor' && run.head === head))
    return `An author-side proof execution was already reserved at ${head}; inspect it with task.detail`;
  const history = proofExecutions(task).length > 0 || runs.some(run => run.role === 'executor');
  if (!history) return null;
  const review = task.resolution.review;
  const approved = (review?.sourceApproved === true || review?.status === 'ready_to_merge') && review.head === head
    && runs.some(run => run.role === 'reviewer' && run.id === review.runId && run.released
      && (run.completion?.sourceApproved === true || run.completion?.status === 'ready_to_merge')
      && run.completion.head === head);
  if (!approved) return `A new proof execution requires the retained reviewer’s authenticated source approval at ${head}`;
  const reviewerIndex = runs.findIndex(run => run.role === 'reviewer' && run.id === review.runId);
  const priorRevisions = runs.slice(0, reviewerIndex).filter(run => run.role === 'revision' && run.released
    && run.completion?.status === 'ready_for_review');
  const latestPriorRevision = priorRevisions.at(-1);
  const revised = runs.some(run => run.role === 'revision' && run.released && run.completion?.status === 'ready_for_review'
      && run.completion.head === head)
    || (latestPriorRevision !== undefined && task.prHead === head && latestPriorRevision.completion?.head == null);
  if (!revised) return `A new proof execution requires an authenticated author revision at ${head}`;
  return null;
}

/** A reserved selector is immutable; its input hashes can be re-declared only for a qualified new head. */
export function proofInputRedeclarationAllowed(task: Task, runs: Pick<Run, 'id' | 'role' | 'head' | 'released' | 'completion' | 'proofExecution'>[], head: string): boolean {
  return proofHeadAdmission(task, runs, head) === null
    && !runs.some(run => run.role === 'executor' && !run.released);
}

/** A brief's or run's proof declaration, without the bindings only a run carries. */
export interface ProofDeclaration { selector: string; inputs: string[] }

/**
 * Task 407: two declarations are the same subject only when both name the same
 * selector and the same input hashes, in order. Nothing here compares anything
 * else, and an absent declaration is never equal to a present one.
 */
export const sameProofDeclaration = (a: ProofDeclaration | null, b: ProofDeclaration | null): boolean =>
  a === null || b === null ? a === b : a.selector === b.selector && a.inputs.length === b.inputs.length
    && a.inputs.every((input, index) => input === b.inputs[index]);

/** One line for an event or a refusal: the selector and how many input hashes it pinned. */
export const proofDeclarationSummary = (declaration: ProofDeclaration | null): string => declaration
  ? `${declaration.selector}${declaration.inputs.length ? ` with ${declaration.inputs.length} input hash${declaration.inputs.length === 1 ? '' : 'es'}` : ''}`
  : 'no declaration';

/**
 * Task 407: the declaration an amendment must keep, or `null` while the one
 * allowance is unspent. A reservation is the append-only record or the executor
 * run itself: a lost creation reply records the run and no settled record, and
 * a cancelled, failed or uncertain run is just as final. `declaration` is null
 * when a reservation's bound subject cannot be read, which no amendment can
 * prove compatible with.
 */
export function proofReservation(task: Pick<Task, 'proofExecutions'>, runs: Pick<Run, 'id' | 'role' | 'status' | 'proofExecution'>[]):
  { runId: string; status: string; declaration: ProofDeclaration | null } | null {
  const spent = spentProofExecution(task);
  if (spent) return { runId: spent.runId, status: spent.status, declaration: { selector: spent.selector, inputs: spent.inputs } };
  const run = runs.find(item => item.role === 'executor');
  if (!run) return null;
  return {
    runId: run.id, status: run.status,
    declaration: run.proofExecution ? { selector: run.proofExecution.selector, inputs: run.proofExecution.inputs } : null,
  };
}

/**
 * The source the proof run must observe: the task's own checkout, clean on the
 * task branch, at the exact published head, with the remote branch at the same
 * head. Nothing here creates, checks out or resets source.
 */
export interface ProofSourceProof {
  directory: string; branch: string; head: string; tree: string; remoteHead: string;
}

async function required<T>(label: string, read: Promise<T>): Promise<T> {
  try { return await read; } catch (error) {
    throw new ProofExecutionRefusal('source_unavailable', `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function verifyProofSource(task: Task, expectedHead: string, options: { remote?: boolean } = {}): Promise<ProofSourceProof> {
  const directory = task.directory ?? refuseProof('source_unavailable', 'The proof executor needs the task checkout, and the task records no directory');
  const toplevel = await required('The task checkout', git(directory, 'rev-parse', '--show-toplevel'));
  if (toplevel !== directory) refuseProof('source_unavailable', `The task directory ${directory} is not its own Git root; no proof execution was started`);
  const branch = await required('The task branch', git(directory, 'branch', '--show-current'));
  if (task.proofOnly ? branch !== '' : branch !== task.branch)
    refuseProof('source_branch', task.proofOnly ? `The proof-only executor requires a detached checkout; the source is on ${branch || 'a detached HEAD'}`
      : `The proof executor must run on the task branch ${task.branch}; the checkout is on ${branch || 'a detached HEAD'}`);
  const head = await required('The task head', git(directory, 'rev-parse', 'HEAD'));
  if (head !== expectedHead) refuseProof('source_moved', `The proof executor must observe the exact published head ${expectedHead}; the checkout is at ${head}`);
  const tree = await required('The checked-out tree', git(directory, 'rev-parse', 'HEAD^{tree}'));
  // Build outputs are allowed; tracked source and the index must still equal the pinned tree.
  const tracked = await required('The tracked-source proof', git(directory, 'status', '--porcelain', '--untracked-files=no'));
  if (tracked) refuseProof('source_dirty', `The proof executor requires source identical to the published head; tracked changes are present: ${tracked.split('\n').slice(0, 5).join('; ')}`);
  try { await git(directory, 'diff', '--cached', '--quiet', expectedHead, '--'); }
  catch (error) {
    if ((error as { code?: unknown }).code === 1)
      refuseProof('source_dirty', 'The proof executor requires an index identical to the published head; staged changes are present');
    throw new ProofExecutionRefusal('source_unavailable', `The staged-source proof could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let remoteHead = head;
  if (options.remote !== false && task.proofOnly) {
    // Task 560: the fetch rewrites this checkout's `FETCH_HEAD`, so the read
    // and the ancestry check run in the same critical section as the fetch.
    // Two concurrent verifications otherwise interleave the write with the
    // read and one fails with a spurious source-moved refusal. The section
    // key is the checkout, not the fetch queue's common directory, so the
    // queued fetch inside never waits on this section itself.
    await withFetchLock(`proof-source:${directory}`, async () => {
      await required(`origin/${task.baseBranch}`, git(directory, 'fetch', '--no-tags', 'origin', `refs/heads/${task.baseBranch}`));
      remoteHead = await required(`origin/${task.baseBranch} head`, git(directory, 'rev-parse', 'FETCH_HEAD'));
      try { await git(directory, 'merge-base', '--is-ancestor', expectedHead, 'FETCH_HEAD'); }
      catch { refuseProof('source_moved', `The proof-only commit ${expectedHead} is no longer an ancestor of origin/${task.baseBranch}`); }
    });
  } else if (options.remote !== false) {
    remoteHead = (await required('The remote branch head', git(directory, 'ls-remote', 'origin', `refs/heads/${branch}`))).split(/\s+/)[0] ?? '';
    if (remoteHead !== expectedHead) refuseProof('source_moved', `The published branch ${branch} is at ${remoteHead || 'unknown'}, not the expected head ${expectedHead}; source drifted before the proof executor observed it`);
  }
  return { directory, branch, head, tree, remoteHead };
}

/** The queue-created executor's own run identity, distinct from every source-author record. */
export function proofExecutionRecord(run: Run, task: Task, authorizedBy: ProofExecutionRecord['authorizedBy'], operationId: string | null): ProofExecutionRecord {
  if (!run.proofExecution || !run.agentId) throw new Error('An executor run without its bound subject or agent cannot record proof execution');
  return {
    runId: run.id, agentId: run.agentId, workspaceId: run.workspaceId, profile: run.profile,
    operationId, selector: run.proofExecution.selector, inputs: run.proofExecution.inputs,
    repository: task.repository, prNumber: task.proofOnly ? null : run.proofExecution.prNumber, branch: task.branch, head: run.head,
    briefVersion: run.proofExecution.briefVersion, briefDigest: run.proofExecution.briefDigest,
    authorizedBy, activatedAt: run.createdAt, settledAt: null, status: 'running', historical: false, evidence: '',
    refusedBeforeSelector: false, selectorStart: 'unknown',
  };
}

/**
 * Task 560: the timeline evidence that one declared proof selector ran: a
 * terminal shell tool call whose command invokes the selector. Callers asking
 * only whether it started may include a running call; that never proves a result.
 * A non-shell entry is not the selector's execution, and a
 * command that does not invoke the selector proves nothing about it; callers
 * supply only histories read with positive coverage, so an unreadable or
 * partial timeline never reaches here.
 */
export function timelineSelectorEvidence(entries: TimelineEntry[], selector: string, includeRunning = false): { command: string; at: string } | null {
  for (const entry of entries) {
    const item = entry?.item;
    if (item?.type !== 'tool_call' || item.detail?.type !== 'shell') continue;
    if (!TERMINAL_TOOL_STATUSES.has(String(item.status ?? '')) && !(includeRunning && item.status === 'running')) continue;
    const command = String(item.detail.command ?? '');
    if (!shellCommandInvokesSelector(command, selector)) continue;
    const at = String(entry.timestamp ?? '');
    if (!Number.isFinite(Date.parse(at))) continue;
    return { command: command.slice(0, 300), at };
  }
  return null;
}

/** One shell word (with its quoting fact) or one connector between commands. */
type ShellItem = { kind: 'word'; text: string; quoted: boolean } | { kind: 'connector'; text: string };

/**
 * Split one shell command into words and connectors. Quotes are read as
 * literal text and stay marked quoted (a quoted selector is a mention, never
 * a command word); unquoted `#` at a word boundary comments out the rest of
 * its line; backslash escapes join the next character into the word;
 * parameter and arithmetic expansions are opaque quoted words, while a
 * command substitution opens a connector so its body parses as commands.
 */
function shellCommandItems(command: string): ShellItem[] {
  const items: ShellItem[] = [];
  let word = '', quoted = false, inWord = false;
  const flush = () => {
    if (!inWord) return;
    items.push({ kind: 'word', text: word, quoted });
    word = ''; quoted = false; inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\\') { word += command[i + 1] ?? ''; i++; inWord = true; continue; }
    if (ch === '\'') {
      const end = command.indexOf('\'', i + 1);
      word += end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      i = end === -1 ? command.length : end;
      quoted = true; inWord = true; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === '\\') { word += command[j + 1] ?? ''; j++; continue; }
        if (command[j] === '"') break;
        word += command[j];
      }
      i = j;
      quoted = true; inWord = true; continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? command.length : nl;
      continue;
    }
    if (ch === '$') {
      const next = command[i + 1];
      if (next === '{' || next === '(') {
        // Parameter `${...}` and arithmetic `$((...))` expansions execute
        // nothing: they are one opaque, quoted word (quoted words never match
        // a selector and close any launcher chain). A command substitution
        // `$(` really runs its contents, so it opens a connector instead and
        // the substitution body parses as ordinary commands.
        flush();
        if (next === '{') {
          const end = shellClosing(command, i + 1, '{', '}');
          items.push({ kind: 'word', text: command.slice(i, end + 1), quoted: true });
          i = end;
          continue;
        }
        if (command[i + 2] === '(') {
          const end = shellClosing(command, i + 1, '(', ')');
          items.push({ kind: 'word', text: command.slice(i, end + 1), quoted: true });
          i = end;
          continue;
        }
        items.push({ kind: 'connector', text: '(' });
        i++;
        continue;
      }
      word += ch; inWord = true; continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      flush();
      const two = command.slice(i, i + 2);
      const connector = two === '&&' || two === '||' || two === ';;' ? two : ch;
      items.push({ kind: 'connector', text: connector });
      i += connector.length - 1;
      continue;
    }
    if (ch === '\n' || (!inWord && (ch === '(' || ch === ')' || ch === '{' || ch === '}'))) {
      flush();
      items.push({ kind: 'connector', text: ch });
      continue;
    }
    word += ch; inWord = true;
  }
  flush();
  return items;
}

/** The index of the character closing the opener at `start` (nesting counted), or the command's end when never closed. */
function shellClosing(command: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < command.length; i++) {
    if (command.startsWith(open, i)) { depth++; i += open.length - 1; }
    else if (command.startsWith(close, i)) { depth -= close.length; if (depth <= 0) return i; }
  }
  return command.length - 1;
}

/** Launchers that consume themselves and still start the next word's command. */
const SHELL_LAUNCHER_WORDS = new Set(['time', 'nohup', 'env', 'command', 'exec', 'sudo', 'nice', 'do', 'then', 'timeout', 'xargs']);
/** A leading variable assignment launches the command after it, like `env`. */
const isAssignmentWord = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

/**
 * The item indices where a command may start: at the command's beginning,
 * right after a connector, or after the transparent launcher words just
 * consumed (`timeout` also consumes its duration; `nice` its optional
 * `-n N`; `env` and bare assignments their `VAR=value` words; `xargs` its
 * immediately following option words). Quoted text is never a command word
 * and closes any launcher chain.
 */
function shellInvocationStarts(items: ShellItem[]): Set<number> {
  const starts = new Set<number>();
  let invocable = true;
  let pending: 'timeout' | 'nice-flag' | 'nice-value' | 'env' | 'xargs-options' | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'connector') { invocable = true; pending = null; continue; }
    if (item.quoted) { pending = null; invocable = false; continue; }
    if (pending === 'timeout') { pending = null; invocable = true; continue; }
    if (pending === 'nice-flag') { if (item.text === '-n') { pending = 'nice-value'; continue; } pending = null; }
    else if (pending === 'nice-value') { pending = null; invocable = true; continue; }
    else if (pending === 'env') {
      if (isAssignmentWord(item.text)) continue;
      pending = null;
    } else if (pending === 'xargs-options') {
      if (item.text.startsWith('-')) continue;
      pending = null;
    }
    if (invocable) starts.add(i);
    if (item.text === 'timeout') { pending = 'timeout'; invocable = false; }
    else if (item.text === 'nice') { pending = 'nice-flag'; invocable = false; }
    else if (item.text === 'env') { pending = 'env'; invocable = false; }
    else if (item.text === 'xargs') { pending = 'xargs-options'; invocable = false; }
    else if (!SHELL_LAUNCHER_WORDS.has(item.text) && !isAssignmentWord(item.text)) invocable = false;
  }
  return starts;
}

/**
 * Whether one shell command invokes the declared selector, rather than merely
 * mentioning its text: the selector must appear as an unquoted run of whole
 * words at an invocation position (the command's start, after a connector,
 * or behind transparent launchers and assignments). `echo effigy test ...`,
 * any quoted mention, an `echo ${selector}` parameter expansion, an arithmetic
 * expansion, a comment and fragmentary matches inside larger words are not
 * invocations. A command this rule cannot read as an invocation — unknown
 * wrappers, variables holding the selector — is a miss, never a guess: a
 * missed settlement leaves the record to the report path, while a wrong one
 * would invent history.
 */
export function shellCommandInvokesSelector(command: string, selector: string): boolean {
  const selectorWords = selector.trim().split(/\s+/).filter(Boolean);
  if (!selectorWords.length) return false;
  const items = shellCommandItems(command);
  const starts = shellInvocationStarts(items);
  for (let i = 0; i < items.length; i++) {
    if (!starts.has(i)) continue;
    let cursor = i;
    const matched = selectorWords.every(expected => {
      const item = items[cursor];
      cursor++;
      return item?.kind === 'word' && !item.quoted && item.text === expected;
    });
    if (matched) return true;
  }
  return false;
}

/** Append one settled executor record to the task; the first one spends the allowance for good. */
export function recordProofExecution(store: Store, taskId: string, record: ProofExecutionRecord, eventDetail: string): ProofExecutionRecord {
  const task = store.task(taskId);
  const settled: ProofExecutionRecord = { ...record, settledAt: record.settledAt ?? now() };
  const next = task.proofExecutions.some(item => item.runId === settled.runId)
    ? task.proofExecutions.map(item => item.runId === settled.runId ? settled : item)
    : [...task.proofExecutions, settled];
  store.update(taskId, { proofExecutions: next }, 'proof_execution_recorded', eventDetail);
  return settled;
}

/**
 * Task 405: a later independent reviewer must also be independent of the proxy
 * that produced the author-side evidence. These are the executor models and
 * agents recorded on the task, never the unchanged source author.
 */
export const proofExecutorModels = (task: Pick<Task, 'proofExecutions'>): string[] =>
  (task.proofExecutions ?? []).flatMap(record => record.profile?.model ? [record.profile.model] : []);

export { proofExecutorAgents } from '../dispatch/routing';

/** Awaiting-proof text can be prose; a task's one declared selector remains its proof identity. */
function declaredProofSelectors(task: Task): string[] {
  const selector = task.proofExecution?.selector.trim();
  return selector ? [selector] : [];
}
function awaitingProofMatchesSelector(awaitingProof: string | AwaitingProof, selector: string, declaredSelectors: string[]): boolean {
  const text = awaitingProofText(awaitingProof).trim();
  if (selector === text) return true;
  return selector === declaredSelectors[0] && (text.includes(selector) || declaredSelectors.length === 1);
}
/**
 * A source approval waits on its named proofs until the operator accepts that exact head: the
 * recorded acceptance stands in for the proofs (a post-merge proof cannot exist before the merge
 * it would gate; Queue #520). The reviewer's record is untouched.
 */
export function proofWaitApplies(t: Task): boolean {
  // A verified merge ends the proof wait: post-merge proofs cannot exist before
  // the merge they would gate, and closeout uses the merge commit (Queue #673).
  if (t.resolution.mergedCommit) return false;
  const review = t.resolution.review;
  if (!review?.sourceApproved || !review.awaitingProofs?.length) return false;
  // Once Queue has a terminal receipt for one of the named proofs, the old
  // awaiting-proof stop no longer describes the task. Settlement below routes
  // that receipt to its next owner (worker on failure, reviewer on pass).
  const settled = new Set((t.proofExecutions ?? [])
    .filter(proof => proof.settledAt && proof.head === review.head)
    .map(proof => proof.selector));
  if (awaitingProofTexts(review.awaitingProofs).every(selector => settled.has(selector))) return false;
  return !(t.resolution.ownerAcceptances ?? []).some(entry => entry.kind === 'operator_source' && entry.head === review.head);
}

/**
 * Spec 058 (task 539): the proof texts Queue already sent to the worker at this
 * head, one `proof_worker_requested` event each. A proof the worker had at a head
 * is not sent again at that head: a repeat is the operator's question, never
 * another worker round.
 */
export function proofWorkerRequests(store: Store, taskId: string, head: string): Set<string> {
  const prefix = `${head}: `;
  return new Set(store.eventsAll(taskId)
    .filter(event => event.kind === 'proof_worker_requested' && event.detail.startsWith(prefix))
    .map(event => event.detail.slice(prefix.length)));
}

/**
 * Spec 058 (task 540): the head and selector of a parked source approval that the brief's own
 * `proofExecution` declaration names as an external proof, while the one allowance is unspent. Anything
 * else is not runnable by Queue and keeps its ordinary route.
 */
function runnableDeclaredProof(task: Task, runs: Run[]): { head: string; selector: string } | null {
  if (!task.proofExecution) return null;
  if (task.resolution.stop?.reason !== 'awaiting_proof' || !proofWaitApplies(task)) return null;
  const review = task.resolution.review;
  // Automatic execution follows only the reviewer's current source-approved proof wait.
  if (review?.status !== 'blocked' || review.sourceApproved !== true) return null;
  const head = review?.head;
  if (!head || head !== task.prHead) return null;
  if (proofHeadAdmission(task, runs, head)) return null;
  const selector = task.proofExecution.selector.trim();
  const named = (review?.awaitingProofs ?? []).some(proof => awaitingProofRoute(proof) === 'external'
    && awaitingProofMatchesSelector(proof, selector, declaredProofSelectors(task)));
  return named ? { head, selector } : null;
}

/** Preserve a prior receipt when a new approved head only edits documentation. */
export async function docsOnlyProofAutorunSkip(task: Task, head: string): Promise<string | null> {
  const prior = proofExecutions(task).at(-1);
  const declaration = task.proofExecution;
  if (!prior || !declaration || prior.head === head || prior.selector !== declaration.selector
    || prior.inputs.length !== declaration.inputs.length
    || prior.inputs.some((input, index) => input !== declaration.inputs[index]) || !task.directory) return null;
  let changedCount = 0;
  let docsOnly = true;
  try { await gitNulEach(task.directory, ['diff', '--name-only', '-z', prior.head, head, '--'], path => {
    changedCount++;
    if (!path.startsWith('docs/') && !path.endsWith('.md')) docsOnly = false;
  }); }
  catch { return null; }
  // An empty diff changes no byte a proof could read; it skips like a docs-only head.
  if (changedCount === 0) return `empty diff since proof execution at ${prior.head}; no changed path can affect the proof`;
  if (!docsOnly) return null;
  return `docs-only changes since proof execution at ${prior.head}; selector and declared input hashes are unchanged`;
}

/** A changed pinned input must be re-declared by the planner before autorun. */
export async function proofAutorunWaitingInputs(task: Task, head: string): Promise<string | null> {
  const prior = proofExecutions(task).at(-1);
  const declaration = task.proofExecution;
  if (!prior || !declaration || prior.head === head
    || prior.selector !== declaration.selector || prior.inputs.length !== declaration.inputs.length
    || prior.inputs.some((input, index) => input !== declaration.inputs[index])) return null;
  if (!task.directory) return `cannot verify declared inputs against proof execution at ${prior.head}; waiting for input re-declaration`;
  const changed: string[] = [];
  try { await gitNulEach(task.directory, ['diff', '--name-only', '-z', prior.head, head, '--'], path => { changed.push(path); }); }
  catch { return `cannot verify changed paths since proof execution at ${prior.head}; waiting for input re-declaration`; }
  const declared = new Set(declaration.inputs.map(input => input.replace(/^sha256:/, '').toLowerCase()));
  if (declared.size === 0 || changed.length === 0) return null;
  for (const path of changed) {
    // A declared hash matching either side of a changed path identifies that
    // path as a pinned input; the new declaration must follow its new bytes.
    let oldHash: string | null = null;
    let newHash: string | null = null;
    for (const revision of [prior.head, head]) {
      try {
        const hash = await gitHash(task.directory, ['show', `${revision}:${path}`]);
        if (revision === prior.head) oldHash = hash;
        else newHash = hash;
      } catch { /* added or removed path: inspect the other side */ }
    }
    if (newHash && declared.has(newHash)) continue;
    if (oldHash && declared.has(oldHash))
      return `declared input at ${path} changed since proof execution at ${prior.head}; waiting for input re-declaration`;
    if (!oldHash && !newHash)
      return `cannot read changed path ${path} since proof execution at ${prior.head}; waiting for input re-declaration`;
  }
  return null;
}

export { declaredProofSelectors, awaitingProofMatchesSelector, runnableDeclaredProof };
