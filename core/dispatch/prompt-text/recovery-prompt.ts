/**
 * The two coordinator-shaped prompts: the recovery run's single-action request
 * (including the missing-origin case) and the closeout run's bounded document
 * assignment. Recovery observes the task-scoped plan; closeout edits only the
 * recorded closeout documents on the integration checkout.
 */
import { taskOwner, type Task } from "../../../shared/contracts";
import { HOST_KIND_LABELS, hostKindOf } from "../../../shared/host-kind";
import type { RecoveryDispatchSnapshot } from "../../recovery/recovery-context";
import { COORDINATOR_NO_ESCALATE_FOR_UNRUN_TESTS } from "./review-rules";
import {
  externalMergeCloseoutBlock,
  workerExclusionBlock,
} from "./revision-text";
import type { RunPromptContext } from "./prompt-context";

/**
 * The recovery coordinator's launch prompt: the task-scoped plan snapshot, the
 * one action its report may name, and the judgment rules that keep a live
 * verdict, a superseded one and an accepted author result distinct. The
 * missing-origin case names the successor evidence it must report instead.
 */
export function recoveryRunPrompt(
  prompt: RunPromptContext,
  context: RecoveryDispatchSnapshot | null,
): string {
  const { task, helper, ticket, scope, callback, section } = prompt;
  // The task's own host names the surfaces this run inspects and attributes.
  const host = HOST_KIND_LABELS[hostKindOf(task.hostId)];
  if (task.originError)
    return `${scope}\n${section("recoverySnapshot", recoveryContextBlock(context, helper, ticket))}The task's origin thread is missing. ${task.originError}. Original submitted thread: ${task.originAgentId}. Task owner: ${taskOwner(task)}. Recorded originating workspace: ${task.originWorkspaceId ?? "unknown"}. You cannot reparent: only the operator at the board or the task's current owner changes a task's owner (Spec 040). Use ${host} to inspect the recorded workspace's threads and metadata/history for a defensible successor. Do not message any candidate or planning thread, and do not change project work, retry tasks, or create agents/workspaces. Find the actual successor; do not choose a same-named agent in another workspace. If the original workspace is unknown, explain the evidence linking a candidate workspace to the original thread and task. Report cannot (escalate) with the defensible successor's identity and that evidence, so the operator can dispose of the reassignment; if there is no defensible match, report cannot with the missing information. Either way it remains visible in the queue because the origin cannot be reached.\n${callback}`;
  return `${scope}\n${section("recoverySnapshot", recoveryContextBlock(context, helper, ticket))}You are this task's coordinator. The task quantum continues ordinary work while you run; one coordinator run is allowed for this stop. Inspect queue and task evidence for the current task, run, PR head and review, merge and workspace. Read the plan's outcome first and act on its decision. The accepted review at its exact head, any reviewer report Nucleus has not applied, and any later author result are facts. A finished or released run in the snapshot is history, not a live participant.
Report exactly one coordinatorAction: restart, route, move, retry_effect, none or cannot. Use status recovered for restart, route, move, retry_effect or none, and blocked or error for cannot. Give the action's required fields and a concise reason; for cannot, name the concrete evidence or authority missing.
A report settles as observed when the work is live or you cannot act, and neither is refused as a stale action. If a worker or reviewer is live and working (active turn, advancing activity) and the only wait is an ordinary live or project-slot wait, report recovered with coordinatorAction {verb: "none", reason: "no action: <who> is live and progressing"}. Summary: "live: <who> is working, last activity <t>". That is a settled no action: Nucleus applies nothing, opens no question and starts no further recovery for the same unchanged facts. A {verb: "cannot", reason} report settles the same way, with your reason kept visible, and opens the planner-ladder question because someone else must act.
Verbs: restart may include role, instruction and fresh. restart role=reviewer continues a reviewer that saved a checkpoint mid-review, within the checkpoint budget, and is the supported continuation while the checkpoint, exact head and reviewer identity remain valid. restart role=executor asks a live author-side proof executor whose result never arrived to resend that report on its existing run credential; it never re-runs the selector and starts no run, and a live turn refuses it. Your accepted report settles your own run and the episode it answers, so report the verb next offers. move to=review preserves and continues that valid reader at the exact head. It refuses, and names the deliberate replacement, once the checkpoint budget is spent or the agent was observed closed; a changed source head has no reader for it. A deliberate fresh replacement is restart role=reviewer fresh or route role=reviewer with now, never another verb's side effect. route requires role and profileId, may include thinkingOptionId and now, and never names a profile above the operator's usage level (at the normal level, a Heavyweight or Frontier profile the task does not start or climb on; Nucleus refuses such a route). move requires to=work, review, merge or closeout and may include instruction. retry_effect retries one recorded failed or uncertain side effect after Nucleus observes it; take the effect key from next when more than one is pending.
Judge the outcome, not the mere presence of a verdict:
- A completed blocked or error reviewer report is recorded impediment evidence, not a missing review. Its owner or environment disposition stays outstanding.
- An accepted review that holds the current accepted slot is the task's verdict; another review of that unchanged head is not an answer.
- When the plan marks that applied verdict superseded, it is history. A reader already holding the same head is the review to continue or finish, not evidence to replay, and a deliberate fresh reader is never displaced.
- When the author returned ready_for_review at the same head after the findings (authorResult.afterApplied), that result needs its independent review, not another author return.
- A live author revision is work in progress, not a request to return it again.
- An exhausted author revision allowance escalates to its project planner through the blocker ladder (Spec 058) when the author return is the outstanding decision, never to the owner. Report cannot and preserve the accepted findings and their reference for whoever decides.
An availability or environment block is not a capability failure: wait, or stay on an equivalent-cost profile. Report a missing tool or stack as cannot.
Only act within the existing task authority. Do not edit tracked files, merge, create workspaces or agents, message the originating planning thread, or repeat an operator-gated action. An accepted task result wins even if a recovery episode remains open. A transient origin, capacity, provider, route or PR-head wait clears on its own; do not turn it into a recovery action. Do not emit repeated attempts or escalation requests. ${COORDINATOR_NO_ESCALATE_FOR_UNRUN_TESTS}
Concrete provider quota, credit or balance exhaustion is recoverable only when ${host} attributes it to the retained worker's own provider and the worker has released its workspace. Auxiliary CLIs, nested models, reviewers, workspace naming providers and unrelated agents do not establish worker subscription exhaustion. Nucleus verifies the retained agent's observed provider error and handles replacement automatically; do not request a top-up or select a replacement.\n${callback}`;
}

/**
 * The closeout coordinator's assignment on the integration checkout. Nucleus
 * closeout writes no file: the outcome row is the closeout record, so this
 * assignment verifies the merged and synchronized state and reports it.
 */
export function closeoutRunPrompt(prompt: RunPromptContext): string {
  const { task, run, mcp, scope, callback } = prompt;
  const reportHead = mcp
    ? ""
    : `, head ${run.head} and coordinatorGeneration ${run.generation}`;
  return `${scope}
This is a bounded coordinator closeout request. ${task.resolution.externalMerge ? externalMergeCloseoutBlock(task) : ""} The plugin verified merge ${task.resolution.mergedCommit} and synchronized local ${task.baseBranch} at ${run.head}. Read the integration checkout at ${task.repoPath}; your worker workspace still contains the pre-merge branch. Verify the task's acceptance and record this task's merged outcome, accepted review and deferred failures in your closeout summary. Do not write, edit or commit any file: a PR's own files are ordinary source and were synchronized with the merge, and closeout publishes nothing. Do not invent new work, change policy/product direction or repair unrelated failures. Genuine missing authority, acceptance evidence or operator decisions still require blocked.
Before reporting, verify local ${task.baseBranch} is clean at ${run.head} and matches origin/${task.baseBranch}. If it moved or contains unrelated changes, stop and report blocked so the plugin can refresh the assignment. Leave the worker branch unchanged; use explicit git -C ${task.repoPath} commands. Never commit, push, reset, or stash on the integration checkout. Finish with a clean integration checkout matching the remote. Report closed with a self-contained closeout summary${reportHead}. If work outside the closeout or a new planning decision remains, report blocked with its exact scope.
${callback}`;
}

/**
 * The recovery coordinator's launch snapshot and the one command that refreshes
 * it. The snapshot is observation: the coordinator's report still derives current
 * facts, so a verb the snapshot offered is refused once the task has moved on.
 */
export function recoveryContextBlock(
  snapshot: RecoveryDispatchSnapshot | null,
  helper: string,
  ticket: string,
) {
  const refresh = `nucleus helper report next`;
  if (!snapshot)
    return `Nucleus context: the launch snapshot is unavailable. Read the current plan with \`${refresh}\` before you choose an action.\n`;
  return `Nucleus context at launch: a snapshot of the task-scoped plan \`next\` derives. It is observation, not authority, and fresh state may differ. Its \`outcome\` names the accepted review with its exact source, any reviewer report Nucleus has not applied, the live reader and the decision still outstanding. Refresh it with \`${refresh}\`, which prints the current plan; Nucleus re-derives current facts when your report arrives.\n${JSON.stringify(snapshot)}\n`;
}
