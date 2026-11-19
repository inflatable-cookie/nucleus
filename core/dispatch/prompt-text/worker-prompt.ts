/**
 * The pre-PR implementation worker's prompt: the task and branch identity, the
 * brief it implements, every recorded context block, the fixed rules
 * it conducts itself by, and the report it ends with. A brief whose report-only
 * policy cannot be read says so rather than silently delivering a PR.
 */
import {
  formatTaskNumber,
  type Run,
  type Task,
} from "../../../shared/contracts";
import { interactiveSessionOpen } from "../interactive";
import {
  PROVIDER_UNAVAILABLE_RULE,
  REPORT_BINDING_RULE,
  BLOCKED_REPORT_FIELDS,
  WORKER_REFUSED_REPORT_RULE,
} from "./report-rules";
import { REQUIRED_PROOF_AUTHOR_NOTE, proofFilesNote } from "./proof-rules";
import {
  briefReportPolicy,
  interactiveWorkerBlock,
  reportPolicyNotice,
} from "./revision-text";
import {
  queueBriefBlock,
  queueBuildOutputSummary,
  queueCheckoutSiblingBlock,
  queueLaneBlock,
  queueLaneDocumentBlock,
  queueSiblingBlock,
  queueWorktreeLinkBlock,
} from "./task-blocks";
import {
  CHANGELOG_FRAGMENT_RULE,
  WORKSPACE_RULE,
  runTemporaryPromptNote,
} from "./workspace-text";
import { operatorValidationBlock } from "./validation";
import { contextPointer } from "./standing-rules";
import { bbBrowserCapabilityNotice, runCallbackCommand } from "./prompt-context";
import { unmeasuredSection, type PromptSection } from "./measure";

export function workerStartingHead(task: Task): string {
  return task.checkpoints?.records?.at(-1)?.head ?? task.completion?.head ?? (task.planningBase || task.planningCommit);
}

/** `runs` is the task's stored run history; the session decision must match reconcile's. */
export function workerPrompt(
  task: Task,
  mcp = false,
  runs: readonly Run[] = [],
  worktreeLinkRecordFailure: string | null = null,
  _helper?: string,
  ticket?: string,
  affectedTestsCommand?: string,
  section: PromptSection = unmeasuredSection,
) {
  const callbackCommand = runCallbackCommand(task.hostId, task.runId, ticket);
  const reportPolicy = briefReportPolicy(task);
  const reportOnly = reportPolicy.reportOnly;
  const session = interactiveSessionOpen(task, runs);
  // Queue #395: a replacement or retained-workspace continuation inherits the
  // checkout an earlier run may have left output in, so it reads the recorded
  // run-bound cleanup before the preserve/resume instruction. A first dispatch
  // continues nothing and keeps its exact prompt.
  const continuesCheckout =
    task.retiredWorkers.length > 0 || task.continuesWorkspace === true;
  const continuationCleanup = continuesCheckout
    ? queueBuildOutputSummary(
        task,
        task.retiredWorkers.at(-1)?.runId ?? task.completion?.runId ?? null,
      )
    : "";
  const report = session
    ? "Only when the operator tells you to submit, "
    : "Before ending your turn, ";
  return `${section("identity", `You are the implementation worker for a plugin-managed Nucleus task.
Task: ${task.title}
${task.number ? `Task number: ${task.reference} (${formatTaskNumber(task.number)})\n` : ""}Task ID: ${task.id}; run ID: ${task.runId}; base: ${task.baseBranch}; starting head: ${workerStartingHead(task)}${task.planningBase ? `; base commit: ${task.planningBase}` : ""}
Completed prerequisite task IDs: ${task.dependsOn.join(", ") || "none"}
Origin: the planner that submitted this task (reach it with ask or tell by role, never by thread ID); coordinator contact: ${task.coordinatorAgentId ? "the recorded coordinator (reach it with ask or tell)" : "operator via queue"}
`)}The plugin owns dispatch and lifecycle state. Do not start a coordinator, dispatch other workers, or merge.
This plugin-managed run is already dispatched by Nucleus under orchestrator dispatch authority. Do not reject or edit the Nucleus-held brief on that basis.
${section("workspace", `Workspace: ${task.directory}. Use this existing workspace; do not create another worktree.
`)}${reportPolicyNotice(reportPolicy)}Your immutable queue-owned branch is ${task.branch}. Before editing, confirm \`git branch --show-current\` prints exactly ${task.branch}; otherwise report blocked. Never create, rename, or switch to a different task branch. ${reportOnly ? "This brief is report-only: no code change or PR is required." : `Push ${task.branch} and create the PR with explicit \`--head ${task.branch} --base ${task.baseBranch}\` arguments.`}
${task.number ? `Start the PR title with the bare task number, for example \`${formatTaskNumber(task.number)}: ${task.title}\`. Do not use \`#${formatTaskNumber(task.number)}\` or \`${task.reference}\` in the PR title; GitHub autolinks #N to its own issues and PRs.\n` : ""}${section("history", continuationCleanup)}${task.retiredWorkers.length ? `You replace a stopped worker after bounded recovery. Preserve and inspect all existing files and commits; resume the brief rather than restarting it. Previous worker: ${task.retiredWorkers.at(-1)!.agentId}. Recovery instruction: ${task.retiredWorkers.at(-1)!.reason}. ${task.resumePrNumber ? `Reuse PR #${task.resumePrNumber}; do not create another PR.` : "Check for an existing PR on this branch and reuse it if present."} Current review findings: ${task.resolution.review?.summary ?? "none"}.` : ""}
${task.resolution.pendingWorkerInstruction ? `Authorized continuation action: ${task.resolution.pendingWorkerInstruction}\n` : ""}${bbBrowserCapabilityNotice(task)}${section("lane", queueLaneBlock(task))}${section("laneDocuments", queueLaneDocumentBlock(task, task.temporaryDirectory))}${queueSiblingBlock(task)}${queueCheckoutSiblingBlock(task)}${queueWorktreeLinkBlock(task, worktreeLinkRecordFailure)}${section("brief", queueBriefBlock(task))}Follow its scope and the repository's applicable instructions. Preserve unrelated files.
${interactiveWorkerBlock(task, session)}${section("workspace", `${WORKSPACE_RULE}\n${CHANGELOG_FRAGMENT_RULE}${runTemporaryPromptNote(task.temporaryDirectory)}`)}
${section("validation", operatorValidationBlock(affectedTestsCommand))}${section("namedProof", `${REQUIRED_PROOF_AUTHOR_NOTE}\n${proofFilesNote(task)}`)}${contextPointer("worker", section, callbackCommand)}

${section("report", `${REPORT_BINDING_RULE}
${BLOCKED_REPORT_FIELDS}
${WORKER_REFUSED_REPORT_RULE}
${
  mcp
    ? `${report}call the nucleus_report MCP tool with runId "${task.runId}", your status, a short headline and summary${reportOnly ? ", and artifact {key, version, digest} when reporting report_ready" : ", and prNumber when ready_for_review"}. Use structured tool arguments; the bridge supplies task identity and authentication. If the tool is absent, or its transport stays closed after one identical retry, feed taskId "${task.id}", runId "${task.runId}", the same status, headline, summary and ${reportOnly ? "artifact" : "prNumber"} JSON on stdin to ${callbackCommand} for this run only. Do not use it to bypass a rejected report. Require an accepted response before finishing.`
    : `${report}report through the packaged nucleus helper with this run's ticket. Never print the callback token.
Feed actual JSON on stdin to:
${callbackCommand} <<'NUCLEUS_RESULT'
{"taskId":"${task.id}","runId":"${task.runId}","status":"blocked","headline":"One line on what is blocking and what comes next","summary":"Explain the concrete blocker here"}
NUCLEUS_RESULT
The ticket binds this report to exactly this run; a report for any other run is refused. Do not use it to bypass a rejected report. Require an accepted response before finishing.
`
}

${
  session
    ? "Allowed statuses: ready_for_review (only when the operator says submit), blocked or error (only for your own provider's quota exhaustion during the session)."
    : `Allowed statuses: ${reportOnly ? "report_ready, blocked, error" : "ready_for_review, progress_checkpoint, blocked, error"}.
${reportOnly ? "This brief opts into report-only delivery. Write the report to the Nucleus lane document named in the brief, then report report_ready with artifact {key, version, digest}. Nucleus releases your run and waits for the planner to accept it with complete; if the planner returns it with move to=work and an instruction, continue the report. This delivery does not start review or blocker escalation. Do not create a PR." : ""}
A deliberate bounded checkpoint before any PR may report progress_checkpoint with a concise continuation summary and the exact local head, for example {"status":"progress_checkpoint","headline":"Migrations and parser landed; the API layer is next","summary":"Migrations and parser landed","head":"<40-character local HEAD>"}. Nucleus continues the same worker, workspace and branch without a coordinator and accepts at most three per task; a fourth reaches attention. A checkpoint needs a clean worktree, and any head beyond the dispatch base must already be the exact pushed queue-branch head. Use blocked or error, never a checkpoint, for dirty work, unpublished commits or an unresolved blocker. Use progress_checkpoint for a deliberate bounded handover of real committed progress, not blocked for unfinished work. When the checkpoint budget is spent, commit and continue toward the PR instead of reporting error as another checkpoint.
`
}
${PROVIDER_UNAVAILABLE_RULE}
${reportOnly ? "report_ready requires the latest exact Nucleus lane document artifact {key, version, digest}; Nucleus verifies the task opt-in and lane document before accepting it." : `ready_for_review requires prNumber for a real open non-draft GitHub PR targeting ${task.baseBranch}, from ${task.branch}, whose pushed head equals your clean worktree HEAD. Recheck the current branch before reporting. If a PR cannot be created, report blocked with the reason; do not claim readiness.`}
The bridge fills task and event identity. Retry the same JSON if delivery fails. After an accepted callback, stop editing and finish the turn; you may explain the result in your final message.
`)}`;
}
