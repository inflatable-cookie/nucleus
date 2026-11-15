/**
 * The proof rules: what a brief-named required proof means for author and
 * reviewer, which actor performs an acceptance proof, the route each awaiting
 * proof names, and where proof files live for each role. One owner, because a
 * reviewer, an author and a proof executor must read the same rule.
 */
import type { Run, Task } from '../../../shared/contracts';
import { quote } from './workspace-text';

/**
 * The one required-proof rule. The covering checks (the repository's AGENTS.md
 * Validate section) never waive a proof the brief names, so the rule sits
 * outside `operatorValidationBlock` as fixed prompt text. It is honesty
 * guidance: the retained reviewer judges proof named in prose; an owner-gated
 * proof can use `queue.mergeHold`.
 */
export const REQUIRED_PROOF_AUTHOR_NOTE = "Required proof: covering checks never waive a proof this brief names as required. If you cannot produce a named required proof, report it missing rather than claiming the work is complete.";

/**
 * Who performs an acceptance proof follows the brief, and the brief alone names
 * any separate executor. The retained reviewer judges the evidence.
 */
export const ACCEPTANCE_PROOF_ACTOR_NOTE = "Acceptance proof actor. The brief decides who performs each proof. A proof it assigns to you is yours: perform it yourself at this head. An author's check or an earlier run's record never replaces it. If you cannot perform it, report blocked with the reason, and never report ready_to_merge with a required reviewer proof skipped. A proof the brief names as a separately owner-activated run by a distinct agent is not yours to execute, and you do not re-execute it: evaluate that run's verified evidence, checking that its selector, exact head and inputs match the brief, that the owner activated it, and that its agent is not the source author. Apply that distinct-agent condition only where the brief names it. Missing, stale, inconsistent, unauthorized or wrong-agent evidence is insufficient, and the required-proof rule applies. A proof the brief assigns to neither you nor a separate executor is the author's required proof: do not perform it; judge its presence and evidence under the required-proof rule. Your personal reading and source judgment stay mandatory, and separately produced evidence is not automatic gate credit.";

/**
 * Spec 058 (task 533): every proof a reviewer names carries the route that can
 * produce it. The tag picks the route and is never approval; an untagged proof
 * gets one author round at its head before it can reach the operator (task 539).
 */
export const AWAITING_PROOF_ROUTE_RULE = "This path is for proofs of this PR's own correctness only. When source review is complete but a proof you cannot produce yourself prevents completion, report blocked with reviewResponsibility environment, sourceApproved true and awaitingProofs naming each missing proof with the route that can produce it, as {proof: \"...\", route: \"author\" | \"environment\" | \"external\"}: author for evidence the author can produce at this head (its own tests, selectors, execution evidence); environment for a check that faulted before any assertion in your own run (for example tsx IPC EADDRINUSE or a missing temp directory), which Nucleus retries once in a clean environment and then treats as external; external for native hardware, another project's consumer verification or a post-merge proof. CI checks are not proofs: never name a forge check (by name or URL, including a queued GitHub job) in awaitingProofs; the merge gate's required-check wait already covers it, so record it as a follow-up instead. Tag every proof. An untagged proof gets one author round at this head before it can reach the operator, and a proof you already named to the author at this head is external. You may include full reviewText and structured verdicts, marking missing evidence insufficient. Nucleus reads the route only to send the work to whoever can produce it: an author-tagged proof returns this task to its author for that evidence alone, an environment-tagged one gets one clean retry, and only external proofs reach the operator. No route publishes a review or grants approval, and the arriving evidence still needs your judgment on the next turn. Unfinished reading still uses review_in_progress, not this path.";

/**
 * Spec 058 (task 539): on a responsible task the brief may carry text from before
 * conversion that demands owner-activated native runs, counted diagnostics or
 * checkpoint receipts. Those are the planner's release gates, not proofs of this PR.
 */
export const RESPONSIBLE_RELEASE_GATE_RULE = "This task is responsible, and its brief may carry text from before conversion that demands owner-activated native runs, counted diagnostics or checkpoint receipts. Those describe release gates for the planner, not proofs of this PR. List them as follow-ups in your review and never name them in awaitingProofs. Name one there only when it tests this PR's own correctness and the author can run it at this head, and then tag it author. When source review passes and only release gates remain, report ready_to_merge at the exact head with the gates as follow-ups; the task's merge hold (if any) keeps it from merging until the owner releases it.";

export const REQUIRED_PROOF_REVIEWER_NOTE = `${REQUIRED_PROOF_AUTHOR_NOTE} For a reviewer: if the author's required proof is missing at this head, do not report ready_to_merge. Report \`changes_required\` with \`reviewResponsibility: author\` when the author can still produce it, or \`blocked\` with \`reviewResponsibility: environment\` when it is owner-gated or unavailable. If the repository's AGENTS.md Validate section and the brief disagree about a missing proof, say so in the report and report blocked.`;

/**
 * nucleus#1142 (papercut 01e88ba5): visual proof has a home that is not the
 * public PR. The worker names local files in its report; Nucleus copies them
 * into its own evidence directory, hashes them, and lists them for the retained
 * reviewer. Local paths never go into a PR body or comment.
 */
export const PROOF_FILES_RULE = "Proof files for the retained reviewer. When the brief requires visual or rendered proof — screenshots, rendered images, recordings — never put the files or their local paths in the PR body, a PR comment or your report summary. Save them under this run's scratch or the task worktree, then report proofFiles: [{label: a short description, path: the file's absolute local path}] and top-level head equal to the current pushed PR HEAD. A revision may start at an earlier head, so report the head it now pushed, not the run's starting head. The report bridge does not infer this head. Nucleus checks the reported head against the pushed PR head before copying. It proves each path is a real regular file inside this task's own scratch or worktree (at most 12 files, 8 MiB each, 32 MiB total), copies it into its own per-head evidence directory and records its SHA-256; the retained reviewer's prompt lists the copies with their paths, hashes and recorded heads. A missing or mismatched head is refused before any copy. Your PR may say that evidence was delivered to the retained reviewer and give the hashes. Nucleus refuses a report naming a path outside this task's own scratch or worktree and copies nothing.";

export const PROOF_EXECUTOR_FILES_RULE = "Executor evidence files for the retained reviewer. Save capture files under this executor run's TMPDIR (or the task checkout), then include proofFiles: [{label: a short description, path: the file's absolute local path}] and top-level head equal to the current pushed PR HEAD. Nucleus verifies the reported head against the forge and checks every file is a real regular file inside this run's own scratch or the task checkout (at most 12 files, 8 MiB each, 32 MiB total). It copies the complete set into task-retained, per-head evidence storage, records each copied locator, original locator, size and SHA-256 against this proof execution run, and lists the copies for the retained reviewer. These copies survive removal of this executor's scratch. Never put files or local paths in a PR body, PR comment or report summary; a refused file list copies nothing.";

export const PROOF_FILES_REVIEWER_RULE = "Author-side proof files for this review are listed below with their Nucleus copy locators, original locators, SHA-256 hashes and recorded heads. The list includes files for the exact head under review and may include files from the latest author run recorded under an earlier head. Open the copies from this session (images can be viewed directly); they are Nucleus's own local copies and are never uploaded to the forge. Judge each file against its recorded head and the brief's required proof; never relabel earlier-head evidence as delivered for the current head, or copy a local path into a PR body or comment. A missing file or a hash that differs from the list is insufficient evidence.";

/** Proof files for the exact head plus the latest author run, preserving each recorded head. */
export function proofFilesBlock(task: Pick<Task, 'proofFiles'>, head: string): string {
  const allFiles = task.proofFiles ?? [];
  const latestAuthorRunId = allFiles.at(-1)?.runId;
  const files = allFiles.filter(file => file.head === head || file.runId === latestAuthorRunId);
  if (!files.length) return '';
  return `Proof files recorded for exact head ${head} and the latest author run (local copies under Nucleus's own scratch; never uploaded to the forge):\n${files.map(file => `- ${file.label} (recorded head ${file.head}): ${file.path}${file.sourcePath ? ` (original locator ${file.sourcePath})` : ''} (sha256 ${file.sha256}, ${file.bytes} bytes, delivered by run ${file.runId})`).join('\n')}\n`;
}

/**
 * Author-side proof executions recorded on the task, shown as evidence for the
 * reviewer. They name the executor run, agent and model beside the source author,
 * so the proxy's execution is never read as authorship or review credit.
 */
export function proofExecutionBlock(task: Pick<Task, 'proofExecutions'>) {
  const records = task.proofExecutions ?? [];
  if (!records.length) return '';
  return `Author-side proof executions on this task (executed by Nucleus-launched proof-only runs, not by the source author; these grant no review credit, no source authorship and no approval):\n${records.map(record => `- run ${record.runId}, executor agent ${record.agentId ?? 'unresolved'}, executor model ${record.profile ? `${record.profile.provider}/${record.profile.model}` : 'unrecorded'}, status ${record.status}, selector ${record.selector}, exact head ${record.head}, activated by ${record.authorizedBy.role}${record.inputs.length ? `, inputs ${record.inputs.join(', ')}` : ''}${record.exitCode != null ? `, exit ${record.exitCode}` : ''}${record.evidence ? `; evidence: ${record.evidence}` : ''}`).join('\n')}\n`;
}

export function proofOnlyGoEvidenceBlock(task: Pick<Task, 'requiresOperatorGo'>, run: Run): string {
  // Task 574: the release GO gate is the task's own declaration. A proof-only
  // qualification without queue.requiresOperatorGo is a synthetic qualification
  // the planner already authorized, so no GO evidence exists to bind or demand:
  // the executor runs the selector directly.
  if (!task.requiresOperatorGo) return '';
  const evidence = run.proofExecution?.goEvidence;
  if (!evidence) return 'Nucleus did not bind release GO evidence to this run. Do not run the selector; report blocked with the missing evidence.\n';
  return `Authenticated release GO evidence (literal JSON): ${JSON.stringify(evidence)}\nBefore running the selector, write that exact JSON to "$TMPDIR/queue-proof-go.json" with mode 0600 (set umask 077 before creating it, then verify the file mode). This is a receipt input; do not edit the checkout. If TMPDIR or the complete evidence is unavailable, report blocked without running the selector.\n`;
}

/** The role's Spec 054 instruction as its own rendered line, or '' for a role it does not address. */
export function requiredProofNote(role: Run['role']): string {
  if (role === 'revision') return `${REQUIRED_PROOF_AUTHOR_NOTE}\n${PROOF_FILES_RULE}\n`;
  if (role === 'reviewer') return `${REQUIRED_PROOF_REVIEWER_NOTE}\n`;
  return '';
}

/**
 * The one clean-environment retry a reviewer gets after it reported a check
 * that faulted before any assertion in its own run. Rendered only for the run
 * that was reserved to spend that retry — which can be a new round continued
 * onto a retained reviewer whose launch environment names an earlier run — so
 * it defers to this run's temporary directory, never "the already-set $TMPDIR".
 */
export function environmentProofRetryBlock(run: Pick<Run, 'proofRetry' | 'temporaryDirectory'>): string {
  const retry = run.proofRetry;
  if (!retry) return '';
  const where = run.temporaryDirectory
    ? `under this run's temporary directory: prefix those commands with TMPDIR=${quote(run.temporaryDirectory)} TMP=${quote(run.temporaryDirectory)} TEMP=${quote(run.temporaryDirectory)}; your launch environment may still name an earlier run`
    : `under this run's temporary directory ($TMPDIR as set for this run, never a root you did not create)`;
  return `Clean-environment retry (this is the one allowance). Your previous turn at ${retry.head} reported these checks faulted before any assertion, so they are not a source finding yet:\n${retry.proofs.map(proof => `- ${proof}`).join('\n')}\nRetry each of them once in a fresh fixture directory created with mktemp -d ${where}. You must not remove this run's recorded temporary root, its parent, or a root you did not create. A test, fixture or selector may remove temporary directories it created during this run inside this run's $TMPDIR. A tool that would delete outside $TMPDIR or a root it did not create is a finding to report, not a reason to skip the selector. Then judge what you observed and report the ordinary result at ${retry.head}: ready_to_merge when the source judgment and evidence hold, changes_required for a real author defect, or blocked with sourceApproved true and awaitingProofs for anything still outstanding, naming any check that faulted again as route external, because a second environment fault at this head reaches the operator instead of another retry. Never describe an unrun check as passed.\n`;
}
