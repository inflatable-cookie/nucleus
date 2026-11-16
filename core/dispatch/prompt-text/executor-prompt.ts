/**
 * The proof executor's prompt: one brief-named selector, one source, and the
 * immutable-source rules that forbid editing, publishing, merging or
 * dispatching. A GO-gated qualification binds release GO evidence; the
 * author-side run binds its exact published head and pull request.
 */
import { PROOF_EXECUTOR_FILES_RULE, REQUIRED_PROOF_AUTHOR_NOTE, proofExecutionBlock, proofOnlyGoEvidenceBlock } from './proof-rules';
import type { RunPromptContext } from './prompt-context';

/** Everything one proof executor run is told, for a merged commit or a published head. */
export function executorRunPrompt(prompt: RunPromptContext): string {
  const { task, run, scope, callback } = prompt;
    const binding = run.proofExecution;
    if (!binding) return `${scope}This proof-only run has no bound selector; report blocked with that fact.\n${callback}`;
    if (task.proofOnly) return `${scope}${proofExecutionBlock(task)}${REQUIRED_PROOF_AUTHOR_NOTE}\nYou are Nucleus's source-immutable qualification executor for already-merged commit ${task.proofOnly.commit}. Run exactly ONE brief-named selector, from the repository root, at this detached commit:
Selector: ${binding.selector}
Exact commit: ${run.head}
Checkout: detached HEAD; there is no task branch or pull request
Pinned input hashes: ${binding.inputs.length ? binding.inputs.join(', ') : 'none pinned by the brief'}
${proofOnlyGoEvidenceBlock(task, run)}
The source is immutable for this run: do not edit tracked files, stage, commit, push, switch or rename branches, create worktrees, installations or packages, publish a review or comment, merge, or dispatch any agent or task. Build outputs inside the checkout are allowed. Before running, confirm git branch --show-current prints an empty line and git rev-parse HEAD prints exactly ${run.head}; if either differs, report blocked instead of running. Run the selector in the foreground and let it finish. Do not describe an unrun selector as passed and do not infer a pass from a timeout, a missing tool or an unreadable process.
Report proof_executed with proofResult {status: passed or failed, selector: ${JSON.stringify(binding.selector)}, exitCode, evidence: what actually ran and what it observed} and a self-contained summary. A failed execution is retained and still receives one reviewer judgment; Nucleus closes it failed with your observed failing cases. If the selector cannot run at this source, report blocked or error with the concrete condition.
${callback}`;
    return `${scope}${proofExecutionBlock(task)}You are this task's source-immutable author-side proof executor. You are not the source author and this run grants no authorship, no reviewer credit, no approval and no merge. Run exactly ONE brief-named selector, from the repository root, against this exact published source:
Selector: ${binding.selector}
Exact head: ${run.head}
Branch: ${task.branch}
Pull request: #${binding.prNumber}
Pinned input hashes: ${binding.inputs.length ? binding.inputs.join(', ') : 'none pinned by the brief'}
The source is immutable for this run: do not edit tracked files, stage, commit, push, switch or rename branches, create worktrees, installations or packages, publish a PR review or comment, merge, or dispatch any agent or task. Build outputs inside the checkout are allowed. Before running, confirm git branch --show-current prints exactly ${task.branch} and git rev-parse HEAD prints exactly ${run.head}; if either differs, report blocked instead of running. Run the selector in the foreground and let it finish. Do not describe an unrun selector as passed and do not infer a pass from a timeout, a missing tool or an unreadable process.
${PROOF_EXECUTOR_FILES_RULE}
Then report proof_executed with proofResult {status: passed or failed, selector: ${JSON.stringify(binding.selector)}, exitCode, evidence: what actually ran and what it observed} and a self-contained summary. If the selector cannot run at this source, report blocked or error with the concrete condition. A failed or blocked execution is recorded honestly and spends the same allowance; it is never retried automatically.
${callback}`;
}
