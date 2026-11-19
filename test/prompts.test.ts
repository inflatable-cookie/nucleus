import { buildRunContext } from '../core/dispatch/prompt-text/context-store';
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runPrompt,
  checkpointPrompt,
  operatorReviewContinuationPrompt,
  operatorValidationBlock,
  queueBuildOutputBlock,
  WORKSPACE_RULE,
  REVIEWER_NO_FINDING_FOR_UNRUN_TESTS,
  REVIEWER_READING_RULE,
  REVIEWER_REFUSED_REPORT_RULE,
  WORKER_REFUSED_REPORT_RULE,
  COORDINATOR_NO_ESCALATE_FOR_UNRUN_TESTS,
  REQUIRED_PROOF_AUTHOR_NOTE,
  REQUIRED_PROOF_REVIEWER_NOTE,
  ACCEPTANCE_PROOF_ACTOR_NOTE,
  VALIDATION_RULE_HEADING,
  VALIDATION_AUTHORITY_RULE,
} from "../core/dispatch/prompts";
import type {
  ReviewCheckpointRecord,
  ReviewDeliveryAuthorization,
  Run,
  Task,
} from "../shared/contracts";
import { workerPrompt } from "../core/dispatch/prompts";
import { briefDigest } from "../core/planning/brief";
import { laneDocumentScratchPath } from "../core/planning/brief-lane-documents";
import { parseBriefDocument } from "../core/planning/handoff";
import { handoffTask, runs, intent } from "./fixtures/handoff-prompt-cases";

const messageRuleTask = {
  id: "task",
  runId: "initial",
  title: "Build",
  originAgentId: "origin",
  coordinatorAgentId: null,
  dependsOn: [],
  branch: "ns-task",
  baseBranch: "main",
  handoffPath: "handoff.md",
  planningCommit: "a".repeat(40),
  retiredWorkers: [],
  resolution: {},
  skipPRReview: false,
} as unknown as Task;

test("worker, revision and reviewer report only on their own binding", () => {
  const task = {
    ...messageRuleTask,
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    prUrl: null,
  } as Task;
  for (const mcp of [false, true]) {
    const prompts = [
      workerPrompt(task, mcp),
      ...(["revision", "reviewer"] as const).map((role) =>
        runPrompt(
          task,
          { id: "run", role, generation: 1, head: "a".repeat(40) } as Run,
          "/helper",
          "/ticket",
          mcp,
        ),
      ),
    ];
    for (const prompt of prompts) {
      assert.match(prompt, /Report only through this run's own binding/);
      assert.match(
        prompt,
        /Never read or use another ticket file under the Nucleus data home/,
      );
      assert.match(
        prompt,
        /report blocked with the refusal through your own binding/,
      );
      assert.match(
        prompt,
        /Never try another ticket or route to bypass a refusal/,
      );
    }
  }
});

test("worker and revision prompts direct changelog changes into fragments", () => {
  assert.match(
    workerPrompt(messageRuleTask, true),
    /add a Markdown changelog fragment under changelog\.d\//,
  );
  const revisionTask = {
    ...messageRuleTask,
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    skipPRReview: false,
    prUrl: null,
  } as Task;
  const revisionRun = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
  } as Run;
  const prompt = runPrompt(
    revisionTask,
    revisionRun,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(
    prompt,
    /add a Markdown changelog fragment under changelog\.d\//,
  );
  assert.match(prompt, /Do not edit CHANGELOG\.md's \[Unreleased\] section/);
});

test("proof-only receipt reviewer prompt explains that worker preferences do not bind the executor", () => {
  const brief = `---\ntitle: Qualification\nqueue:\n  preferredProfileId: preferred-worker\n  requirePreferred: true\n  proofOnly:\n    commit: ${"a".repeat(40)}\n  proofExecution:\n    selector: effigy check\n    inputs: []\n  requiresOperatorGo: release approval\n---\n\nQualify the merged source.\n`;
  const receipt = {
    runId: "executor-run",
    agentId: "executor",
    workspaceId: "workspace",
    profile: { id: "executor-profile", model: "executor-model" },
    operationId: null,
    selector: "effigy check",
    inputs: [],
    repository: null,
    prNumber: null,
    branch: "",
    head: "a".repeat(40),
    briefVersion: 1,
    briefDigest: null,
    authorizedBy: { role: "operator", caller: null, note: null },
    activatedAt: "2026-11-08T00:00:00Z",
    settledAt: "2026-11-08T00:01:00Z",
    status: "passed",
    exitCode: 0,
    evidence: "passed",
  };
  const task = {
    id: "task",
    runId: "initial",
    title: "Qualification",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "",
    baseBranch: "main",
    handoffPath: "",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    resolution: {},
    skipPRReview: false,
    entrypoint: "proof",
    proofOnly: { commit: "a".repeat(40) },
    requiresOperatorGo: "release approval",
    proofExecutions: [receipt],
    briefVersions: [{ version: 1, text: brief }],
  } as unknown as Task;
  const prompt = runPrompt(
    task,
    {
      id: "review",
      role: "reviewer",
      generation: 1,
      head: "a".repeat(40),
    } as Run,
    "/helper",
    "/ticket",
    false,
  );
  assert.match(
    prompt,
    /preferredProfileId\/requirePreferred preferences bind worker selection/,
  );
  assert.match(
    prompt,
    /on a GO-gated proof-only task they may bind the GO-gate reviewer only/,
  );
  assert.match(
    prompt,
    /executor is selected independently of the retained reviewer's model/,
  );
  assert.match(
    prompt,
    /executor profile differing from that worker preference is never a receipt finding/,
  );
  assert.match(
    prompt,
    /Counts that require reading the live Nucleus store are planner evidence/,
  );
  assert.match(
    prompt,
    /List any requested live-store check as a planner follow-up, never as an awaiting proof/,
  );
});

// Spec 058 rollout step 3 (task 621): worker and reviewer prompts name nucleus_message in one line.
test("role prompts direct standing guidance to the bound context", () => {
  assert.match(workerPrompt(handoffTask, true), /Worker rules.*context rules/);
  assert.match(runPrompt(handoffTask, runs[1], '/helper', '/ticket', true), /Reviewer rules.*context rules/);
});

test("worker startup pins the queue-owned branch through PR reporting", () => {
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    resolution: {},
    skipPRReview: false,
  } as unknown as Task;
  const prompt = workerPrompt(task, true);
  assert.match(prompt, /immutable queue-owned branch is ns-task/);
  assert.match(prompt, /git branch --show-current/);
  assert.match(
    prompt,
    /already dispatched by Nucleus under orchestrator dispatch authority/,
  );
  assert.doesNotMatch(prompt, /direct Northstar worker fast path/);
  assert.match(prompt, /Never create, rename, or switch/);
  assert.match(prompt, /--head ns-task --base main/);
  assert.match(prompt, /ready_for_review[\s\S]*from ns-task/);
});

test("report-only worker prompt ends with a lane artifact and no PR", () => {
  const brief = `---\ntitle: Report\nqueue_approval: test\nqueue:\n  lanes: [web-health]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite a report.\n`;
  const task = {
    id: "task",
    runId: "initial",
    title: "Report",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    resolution: {},
    skipPRReview: false,
    briefVersions: [{ version: 1, text: brief }],
  } as unknown as Task;
  const prompt = workerPrompt(task, true);
  assert.match(prompt, /Allowed statuses: report_ready, blocked, error/);
  assert.match(prompt, /report_ready with artifact \{key, version, digest\}/);
  assert.match(prompt, /no code change or PR is required/);
  assert.doesNotMatch(prompt, /ready_for_review requires prNumber/);
});

test("report-only prompt honours a lead-promoted brief that has no queue_approval", () => {
  const brief = `---\ntitle: Report\nqueue:\n  complexity: low\n  lanes: [web-health]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite a report.\n`;
  assert.throws(() => parseBriefDocument(brief, "brief"), /queue_approval/);
  const task = {
    id: "task",
    runId: "initial",
    title: "Report",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    resolution: {},
    skipPRReview: false,
    briefVersions: [{ version: 1, text: brief }],
  } as unknown as Task;
  const prompt = workerPrompt(task, true);
  assert.match(prompt, /Allowed statuses: report_ready, blocked, error/);
  assert.match(prompt, /This brief opts into report-only delivery/);
  assert.doesNotMatch(prompt, /ready_for_review requires prNumber/);
  const revision = runPrompt(
    {
      ...task,
      repoPath: "/repo",
      workspaceId: "workspace",
      directory: "/worktree",
    } as Task,
    { id: "run", role: "revision", generation: 1, head: "a".repeat(40) } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(
    revision,
    /return report_ready with artifact \{key, version, digest\}/,
  );
  assert.doesNotMatch(revision, /open one PR and return ready_for_review/);
});

test("pre-PR worker resume prompt scopes fresh authority and protects consumed one-shot actions", () => {
  const task = {
    id: "task",
    title: "Capture",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: null,
    reason: "Install dependencies only; do not invoke capture",
    completion: { status: "blocked" },
  } as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
    instruction: "Install dependencies only; do not invoke capture",
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", false);
  assert.match(
    prompt,
    /Authorized action: Install dependencies only; do not invoke capture/,
  );
  assert.match(prompt, /Do not repeat a previously consumed one-shot action/);
  // A preparation-only step continues into the approved work unless told to stop, never across an operator gate (lean audit 2026-10-15).
  assert.match(
    prompt,
    /continue into the approved work afterwards unless the instruction says to stop; never cross an operator-gated step it does not authorize/,
  );
  assert.doesNotMatch(prompt, /same workspace and PR/);
});
test("recovery coordinator prompt carries durable exclusions without asking it to choose a profile", () => {
  const task = {
    id: "task",
    title: "Recover",
    phase: "needs_attention",
    reason: "Revision budget exhausted",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    branch: "ns-task",
    baseBranch: "main",
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    workerExclusions: [
      {
        agentId: "fbfa4d29",
        profileId: null,
        reason: "Three hangs; no further turns",
        createdAt: "2026-09-27T23:00:00.000Z",
      },
      {
        agentId: null,
        profileId: "profile-b",
        reason: "Planner selected another profile",
        createdAt: "2026-09-28T00:00:00.000Z",
      },
    ],
    resolution: {},
  } as unknown as Task;
  const run = {
    id: "recovery",
    role: "recovery",
    generation: 2,
    head: "a".repeat(40),
    base: "b".repeat(40),
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /agent fbfa4d29: Three hangs; no further turns/);
  assert.match(prompt, /profile profile-b: Planner selected another profile/);
  assert.match(prompt, /Nucleus will not give an excluded worker another turn/);
  assert.match(
    prompt,
    /do not choose a profile or ask the excluded worker to continue/,
  );
  assert.match(prompt, /Report exactly one coordinatorAction/);
});
test("revision prompt names the adopted replacement PR", () => {
  const task = {
    id: "task",
    title: "Repair",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    reason: "Address review",
    resumePrNumber: 188,
    completion: { status: "ready_for_review", prNumber: 187 },
    resolution: {
      revisionPrRepair: false,
      review: { summary: "Fix links", reviewCommentId: 1 },
    },
  } as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", false);
  assert.match(prompt, /prNumber 188/);
  assert.doesNotMatch(prompt, /prNumber 187/);
});
test("revision prompt uses its bound action and never leaks a live status reason", () => {
  const task = {
    id: "task",
    title: "Repair",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    reason:
      "Waiting for a project slot… Project concurrent task-slot limit reached",
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: {
      revisionPrRepair: false,
      review: { summary: "Fix the escaped route links", reviewCommentId: 1 },
    },
  } as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
    instruction: "Fix the escaped route links",
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /Current action: Fix the escaped route links/);
  assert.match(prompt, /Review findings: Fix the escaped route links/);
  assert.doesNotMatch(prompt, /Waiting for a project slot/);
  const transient = runPrompt(
    { ...task, reason: "Daemon client closed" } as Task,
    run,
    "/helper",
    "/ticket",
    true,
  );
  assert.doesNotMatch(transient, /Daemon client closed/);
});
test("merge-conflict revision prompt keeps the bound repair request beside review findings", () => {
  const task = {
    id: "task",
    title: "Repair",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    reason:
      "Waiting for a project slot… Global concurrent task-slot limit reached",
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: {
      revisionPrRepair: false,
      review: { summary: "Fix the escaped route links", reviewCommentId: 1 },
    },
  } as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
    instruction:
      "GitHub reports a merge conflict; the worker must update the PR head",
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(
    prompt,
    /Current action: GitHub reports a merge conflict; the worker must update the PR head/,
  );
  assert.match(prompt, /Review findings: Fix the escaped route links/);
  assert.doesNotMatch(prompt, /Waiting for a project slot/);
});
test("identity-confirmation continuation names the recorded PR even before a resume number is stored", () => {
  const task = {
    id: "task",
    title: "Repair",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    resumePrNumber: null,
    completion: { status: "changes_required", prNumber: 1 },
    resolution: { revisionResumeUnpublished: false },
  } as unknown as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "d".repeat(40),
    identityConfirmation: true,
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /identity-confirmation continuation only/);
  assert.match(prompt, /exact open PR #1 on the queue-owned branch/);
  assert.match(prompt, /Return ready_for_review with prNumber 1/);
  assert.doesNotMatch(prompt, /PR #null|prNumber null/);
  // The reservation consumes the task flag; only the run's bound intent renders the
  // read-only confirmation. The identical run without it keeps implementation authority.
  const implementation = runPrompt(
    { ...task, prUrl: task.prUrl, resumePrNumber: 1 } as Task,
    { ...run, identityConfirmation: undefined } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.doesNotMatch(
    implementation,
    /identity-confirmation continuation only/,
  );
  assert.match(
    implementation,
    /Resume implementation in this same workspace and PR/,
  );
});
test("scoped revision prompt keeps brief, review findings and the operator instruction as distinct sources", () => {
  const repairBrief = "Repair brief\n";
  const pinned = {
    brief: { text: repairBrief, mediaType: "text/markdown", digest: briefDigest(repairBrief) },
    briefVersions: [{ version: 1, digest: briefDigest(repairBrief), mediaType: "text/markdown", text: repairBrief, reason: "Submitted", pinnedAt: "2026-09-13T00:00:00.000Z" }],
    handoffText: repairBrief,
  };
  const task = {
    ...pinned,
    id: "task",
    title: "Repair",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    reason: "Worker action requested: Address review",
    resumePrNumber: 188,
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: {
      revisionPrRepair: false,
      review: { summary: "Fix links", reviewCommentId: 1 },
      revisionInstruction: {
        id: "scoped-1",
        text: "Apply the accepted per-unit Card 132 ruling",
        createdAt: "2026-09-13T00:00:00.000Z",
        runId: "fix",
      },
    },
  } as Task;
  const run = {
    id: "fix",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
    instruction: "Apply the accepted per-unit Card 132 ruling",
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  const handoff = prompt.indexOf("----- BEGIN QUEUE-HELD BRIEF -----");
  const findings = prompt.indexOf("Review findings:");
  const instruction = prompt.indexOf(
    "Additional operator revision instruction",
  );
  assert.ok(
    handoff >= 0 && findings > handoff && instruction > findings,
    "instruction must follow the pinned brief and public review findings",
  );
  assert.match(prompt, /scoped-1, versioned and bound to this revision run/);
  assert.match(prompt, /distinct sources/);
  assert.match(prompt, /Apply the accepted per-unit Card 132 ruling/);
  const plain = runPrompt(
    task,
    { ...run, instruction: null } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.doesNotMatch(plain, /Additional operator revision instruction/);
});
test("a review-less revision prompt renders no undefined finding and claims no review defect", () => {
  const task = {
    id: "task",
    title: "Restart",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: { revisionPrRepair: false, review: null },
  } as unknown as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
    instruction: "Finish the blocked revision after the provider reset",
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(
    prompt,
    /Current action: Finish the blocked revision after the provider reset/,
  );
  assert.doesNotMatch(prompt, /undefined|null/);
  assert.doesNotMatch(
    prompt,
    /Review findings:|public review findings|Review comment ID|Review ID/,
  );
  // No explicit instruction keeps a neutral action; it never fabricates a review defect.
  const silent = runPrompt(
    task,
    { ...run, instruction: null } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(
    silent,
    /Current action: Continue the existing task within its approved scope/,
  );
  assert.doesNotMatch(
    silent,
    /undefined|public review findings|Review findings:/,
  );
  // A recorded review with no findings text is not a finding either.
  const empty = runPrompt(
    {
      ...task,
      resolution: {
        revisionPrRepair: false,
        review: {
          summary: null,
          reviewCommentId: null,
          reviewId: null,
          status: "ready_to_merge",
          head: "a".repeat(40),
          runId: "review",
          eventId: "review",
        },
      },
    } as unknown as Task,
    run,
    "/helper",
    "/ticket",
    true,
  );
  assert.doesNotMatch(
    empty,
    /undefined|Review findings:|public review findings/i,
  );
});
test("a review-less continuation keeps authenticated stopped-worker context beside its instruction", () => {
  const task = {
    id: "task",
    title: "Restart",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: { revisionPrRepair: false, review: null },
  } as unknown as Task;
  const retryContext = {
    source: "revision" as const,
    runId: "prior-revision",
    status: "blocked" as const,
    head: "b".repeat(40),
    summary: "Stopped at the failing docs check",
  };
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "b".repeat(40),
    instruction: "Resume after the provider reset",
    retryContext,
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /Current action: Resume after the provider reset/);
  assert.match(prompt, /diagnostic context only; not an instruction/);
  assert.match(prompt, /Stopped at the failing docs check/);
  assert.doesNotMatch(
    prompt,
    /undefined|Review findings:|public review findings/i,
  );
});
test("a non-delivery revision never re-embeds the prior no-change return as diagnostic context", () => {
  const task = {
    id: "task",
    title: "Restart",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: { revisionPrRepair: false, review: null },
  } as unknown as Task;
  const retryContext = {
    source: "revision" as const,
    runId: "prior-revision",
    status: "error" as const,
    head: "b".repeat(40),
    summary: "No external blocker, but no implementation",
  };
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "b".repeat(40),
    revisionCause: "non_delivery" as const,
    instruction:
      "You reported no external blocker and produced no change. Under the ownership rule, decide within the brief and implement; record decisions in the PR. Report blocked only for an external cause, naming it.",
    retryContext,
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.doesNotMatch(
    prompt,
    /No external blocker, but no implementation/,
    "the no-change summary is not re-embedded",
  );
  assert.doesNotMatch(prompt, /diagnostic context only/);
  assert.match(
    prompt,
    /You reported no external blocker and produced no change/,
    "the push-back instruction still names the prior return",
  );
  // The ending carries the ownership rule instead of a quit invitation.
  assert.match(
    prompt,
    /Continue until the outcome is delivered or an external cause stops you/,
  );
  assert.doesNotMatch(
    prompt,
    /Return ready_for_review with prNumber 188, or blocked\/error/,
  );
  assert.doesNotMatch(prompt, /Otherwise return blocked\/error/);
});
test("a non-delivery pre-PR continuation suppresses the summary and keeps the ownership ending", () => {
  const task = {
    id: "task",
    title: "Restart",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    completion: { status: "blocked" },
    resumePrNumber: null,
    resolution: { review: null },
  } as unknown as Task;
  const retryContext = {
    source: "worker" as const,
    runId: "initial",
    status: "blocked" as const,
    head: "b".repeat(40),
    summary: "No implementation and no external blocker",
  };
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "b".repeat(40),
    revisionCause: "non_delivery" as const,
    instruction:
      "You reported no external blocker and produced no change. Under the ownership rule, decide within the brief and implement; record decisions in the PR. Report blocked only for an external cause, naming it.",
    retryContext,
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(
    prompt,
    /Resume this blocked pre-PR worker in the same workspace/,
  );
  assert.doesNotMatch(
    prompt,
    /No implementation and no external blocker/,
    "the no-change worker summary is not re-embedded",
  );
  assert.doesNotMatch(prompt, /diagnostic context only/);
  assert.match(
    prompt,
    /Continue until the outcome is delivered or an external cause stops you: when the full brief completes, open one PR and return ready_for_review with its prNumber/,
  );
  assert.doesNotMatch(prompt, /Otherwise return blocked\/error/);
});
test("an externally caused revision resume keeps the diagnostic context and the ownership ending", () => {
  const task = {
    id: "task",
    title: "Restart",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/188",
    completion: { status: "ready_for_review", prNumber: 188 },
    resolution: { revisionPrRepair: false, review: null },
  } as unknown as Task;
  const retryContext = {
    source: "revision" as const,
    runId: "prior-revision",
    status: "blocked" as const,
    head: "b".repeat(40),
    summary: "Provider quota exhausted mid-implementation",
  };
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "b".repeat(40),
    instruction: "Resume after the provider reset",
    retryContext,
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /diagnostic context only; not an instruction/);
  assert.match(
    prompt,
    /Provider quota exhausted mid-implementation/,
    "an external cause keeps today\u2019s diagnostic context",
  );
  assert.match(
    prompt,
    /Continue until the outcome is delivered or an external cause stops you/,
  );
});
test("coordinator recovery prompt reports one registered action for the current stop", () => {
  const task = {
    id: "task",
    title: "Capture",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    phase: "blocked",
    reason: "Capture authority consumed",
    skipPRReview: false,
  } as Task;
  const run = {
    id: "recovery",
    role: "recovery",
    generation: 2,
    head: "a".repeat(40),
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /one coordinator run is allowed for this stop/);
  assert.match(prompt, /Inspect queue and task evidence for the current task/);
  assert.match(
    prompt,
    /Report exactly one coordinatorAction: restart, route, move, retry_effect, or cannot/,
  );
  assert.match(
    prompt,
    /Use status recovered for restart, route, move or retry_effect, and blocked or error for cannot/,
  );
  assert.match(prompt, /message the originating planning thread/);
  assert.match(prompt, /repeat an operator-gated action/);
  assert.match(prompt, /Coordinator generation: 2/);
  assert.doesNotMatch(
    prompt,
    /recoveryAction retry|recoveryAction revise|report escalate/,
  );
  assert.match(prompt, /do not request a top-up or select a replacement/);
  assert.match(
    prompt,
    /Auxiliary CLIs, nested models, reviewers, workspace naming providers and unrelated agents do not establish worker subscription exhaustion/,
  );
  assert.match(prompt, /verifies the retained agent's observed provider error/);
  assert.match(
    prompt,
    /A transient origin, capacity, provider, route or PR-head wait clears on its own/,
  );
  assert.match(prompt, /Do not emit repeated attempts or escalation requests/);
  assert.ok(prompt.includes(COORDINATOR_NO_ESCALATE_FOR_UNRUN_TESTS));
});
test("MCP report fallback covers a closed transport after one identical retry", () => {
  const task = {
    id: "task",
    title: "Build",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    skipPRReview: false,
    reason: "Build",
  } as Task;
  const run = {
    id: "run",
    role: "revision",
    generation: 1,
    head: "a".repeat(40),
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(
    prompt,
    /If the nucleus_report tool is absent, or its transport stays closed after one identical retry \("Transport closed" or another transport error\), use this authenticated fallback/,
  );
});
test("closeout coordinator verifies the merged state and writes no files", () => {
  const task = {
    id: "task",
    title: "Card",
    repoPath: "/repo",
    baseBranch: "main",
    resolution: { mergedCommit: "a".repeat(40) },
  } as Task;
  const run = {
    id: "run",
    role: "closeout",
    generation: 1,
    head: "a".repeat(40),
  } as Run;
  const prompt = runPrompt(task, run, "/helper", "/ticket", true);
  assert.match(prompt, /Do not write, edit or commit any file/);
  assert.doesNotMatch(prompt, /docs\/logs|closeoutCommit/);
  assert.match(prompt, /Never commit, push, reset, or stash/);
  assert.doesNotMatch(
    prompt,
    /required repository edits.*do not.*make those changes/,
  );
});

// Task 993: the code gate, not the coordinator prompt, decides whether an
// external merge counts; the prompt describes the recorded basis per case
// (review 5829659690: the no-evidence routes must not claim evidence or block).
test("the external-merge closeout prompt describes the code gate and names the recorded evidence", () => {
  const task = {
    id: "task",
    title: "Card",
    repoPath: "/repo",
    baseBranch: "main",
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/9",
    resolution: {
      externalMerge: true,
      mergeHead: head,
      mergedCommit: "c".repeat(40),
      mergedWithNone: false,
      review: {
        eventId: "review-event",
        taskId: "task",
        runId: "review-run",
        status: "ready_to_merge",
        summary: "Approved",
        head,
        reviewCommentId: 1,
      },
    },
  } as Task;
  const prompt = runPrompt(
    task,
    { id: "close", role: "closeout", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(prompt, /merged outside the plugin/);
  assert.match(
    prompt,
    /recorded review evidence binds the merged head: the recorded ready_to_merge review of run review-run/,
  );
  assert.doesNotMatch(
    prompt,
    /Verify any required review and authorization evidence/,
  );
  // The primary unreviewed-then-accepted path: an ordinary operator move to=closeout
  // records the merge with no applied verdict, so the prompt names that recorded basis
  // and never claims evidence it does not have.
  const operatorAccepted = {
    ...task,
    resolution: { ...task.resolution, mergedWithNone: true, review: null },
  } as unknown as Task;
  const accepted = runPrompt(
    operatorAccepted,
    { id: "close", role: "closeout", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(accepted, /Nucleus accepted it without review evidence/);
  assert.match(
    accepted,
    /recorded as accepted without an applied verdict \(mergedWithNone\)/,
  );
  assert.match(
    accepted,
    /explicit operator acceptance of this external merge through move to=closeout/,
  );
  assert.match(
    accepted,
    /report blocked only if the task's records or the repository contradict it/,
  );
  assert.doesNotMatch(accepted, /code gate found recorded review evidence/);
  assert.doesNotMatch(
    accepted,
    /Verify any required review and authorization evidence/,
  );
  // A review-skipped submission reaches closeout without evidence legitimately too.
  const skipped = {
    ...task,
    skipPRReview: true,
    resolution: { ...task.resolution, mergedWithNone: true, review: null },
  } as unknown as Task;
  const skippedPrompt = runPrompt(
    skipped,
    { id: "close", role: "closeout", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(
    skippedPrompt,
    /the submission explicitly skipped PR review, so no review evidence binds the merged head and none is required/,
  );
  assert.doesNotMatch(
    skippedPrompt,
    /code gate found recorded review evidence/,
  );
});

const head = "a".repeat(40);

test("reviewer, worker, closeout and recovery prompts keep their existing validation authority", () => {
  const shared = {
    id: "task",
    title: "Task",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: head,
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    baseBranch: "main",
    branch: "ns-task",
    reason: "Apply review findings",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: {
      review: { summary: "Fix links", reviewCommentId: 1 },
      mergedCommit: head,
    },
  } as Task;
  const reviewer = runPrompt(
    shared,
    { id: "rev", role: "reviewer", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  const revision = runPrompt(
    shared,
    { id: "fix", role: "revision", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    false,
  );
  const closeout = runPrompt(
    shared,
    { id: "close", role: "closeout", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  const recovery = runPrompt(
    {
      ...shared,
      phase: "blocked",
      reason: "Capture authority consumed",
    } as Task,
    { id: "recovery", role: "recovery", generation: 2, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  const worker = workerPrompt(
    {
      ...shared,
      runId: "initial",
      dependsOn: [],
      coordinatorAgentId: null,
      retiredWorkers: [],
    } as unknown as Task,
    true,
  );
  // The repository validation rule sets the scope; runtime rules stay in HEAVY_VALIDATION_NOTE.
  assert.match(
    reviewer,
    /run the checks the repository validation rule requires/,
  );
  assert.match(
    revision,
    /run the checks the repository validation rule requires/,
  );
  assert.match(closeout, /Do not write, edit or commit any file/);
  assert.match(
    recovery,
    /Inspect queue and task evidence for the current task/,
  );
  for (const prompt of [reviewer, revision, closeout, recovery, worker]) {
    assert.doesNotMatch(prompt, /Do not run full QA, broad Effigy selectors/);
    assert.doesNotMatch(prompt, /worker\/reviewer validation suites/);
  }
});

test("a formal-review repository tells the reviewer not to post a verdict itself", () => {
  const shared = {
    id: "task",
    title: "Task",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: head,
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    baseBranch: "main",
    branch: "ns-task",
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { review: null },
  } as Task;
  // Even the socket fallback (no MCP) must defer publication to Queue when a
  // separate reviewer identity is configured.
  const formal = runPrompt(
    shared,
    {
      id: "rev",
      role: "reviewer",
      generation: 1,
      head,
      formalReview: true,
    } as Run,
    "/helper",
    "/ticket",
    false,
  );
  assert.match(
    formal,
    /formal GitHub review under the configured reviewer identity/,
  );
  assert.match(formal, /do not post your own PR comment or review/);
  assert.match(
    formal,
    /report ready_to_merge or changes_required with full reviewText/,
  );
  assert.doesNotMatch(formal, /Publish all required findings on the PR/);
  // The legacy comment path is unchanged without the opt-in.
  const legacy = runPrompt(
    shared,
    { id: "rev", role: "reviewer", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    false,
  );
  assert.match(legacy, /Publish all required findings on the PR/);
  for (const prompt of [
    formal,
    legacy,
    runPrompt(
      shared,
      { id: "rev", role: "reviewer", generation: 1, head } as Run,
      "/helper",
      "/ticket",
      true,
    ),
  ]) {
    assert.match(
      prompt,
      /For a ready_to_merge or changes_required verdict only:/,
    );
    assert.match(prompt, /report blocked .*reviewResponsibility environment/);
    // Spec 058 (task 533): each named proof carries the route that produces it; no route is approval.
    assert.match(prompt, /No route publishes a review or grants approval/);
    assert.match(
      prompt,
      /awaitingProofs naming each missing proof with the route that can produce it/,
    );
    // Task 1090: this path is for proofs of this PR's own correctness, not release gates.
    assert.match(
      prompt,
      /This path is for proofs of this PR's own correctness only/,
    );
    // Task 539: an untagged proof gets one author round before the operator, and every proof is tagged.
    assert.match(
      prompt,
      /Tag every proof\. An untagged proof gets one author round at this head/,
    );
  }
});

test("a responsible reviewer treats old brief release gates as the planner's, not as its proofs (task 539)", () => {
  const base = {
    id: "task",
    title: "Task",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: head,
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    baseBranch: "main",
    branch: "ns-task",
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { review: null },
  };
  const responsible = runPrompt(
    { ...base, responsible: true } as unknown as Task,
    { id: "rev", role: "reviewer", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(
    responsible,
    /owner-activated native runs, counted diagnostics or checkpoint receipts/,
  );
  assert.match(
    responsible,
    /Those describe release gates for the planner, not proofs of this PR/,
  );
  assert.match(responsible, /never name them in awaitingProofs/);
  // Task 1090: source review with only release gates remaining reports ready_to_merge; a merge hold keeps the task off the merge gate.
  assert.match(
    responsible,
    /When source review passes and only release gates remain, report ready_to_merge at the exact head with the gates as follow-ups/,
  );
  assert.match(
    responsible,
    /the task's merge hold \(if any\) keeps it from merging until the owner releases it/,
  );
});

test("revision findings name a formal review id as a review, not a comment", () => {
  const base = {
    id: "task",
    runId: "initial",
    title: "Task",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: head,
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    baseBranch: "main",
    branch: "ns-task",
    reason: "Address review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resumePrNumber: 1,
  };
  const formal = {
    ...base,
    resolution: {
      review: { status: "ready_to_merge", summary: "Fix links", reviewId: 77 },
    },
  } as unknown as Task;
  const revision = runPrompt(
    formal,
    { id: "fix", role: "revision", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(revision, /Review ID: 77/);
  assert.doesNotMatch(revision, /Review comment ID/);
  // A comment id points to the PR issue comment, never to the review endpoint.
  const comment = {
    ...base,
    resolution: {
      review: {
        status: "ready_to_merge",
        summary: "Fix links",
        reviewCommentId: 77,
      },
    },
  } as unknown as Task;
  const revisionPrompt = runPrompt(
    comment,
    { id: "fix", role: "revision", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(
    revisionPrompt,
    /PR issue comment URL: https:\/\/github\.com\/example\/repo\/pull\/1#issuecomment-77/,
  );
  assert.doesNotMatch(revisionPrompt, /pulls\/1\/reviews\/77/);
});

test("every worktree-facing prompt forbids the repository-shared git stash", () => {
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Address review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: {
      revisionPrRepair: false,
      review: { summary: "Fix", reviewCommentId: 1 },
    },
  } as unknown as Task;
  const prompts = {
    worker: workerPrompt(task, true),
    checkpoint: checkpointPrompt(task, {
      ordinal: 1,
      createdAt: "now",
      summary: "s",
      head: "a".repeat(40),
    } as any),
    ...Object.fromEntries(
      (["revision", "reviewer", "closeout", "recovery"] as const).map(
        (role) => [
          role,
          runPrompt(
            task,
            { id: "run", role, generation: 1, head: "a".repeat(40) } as Run,
            "/helper",
            "/ticket",
            false,
          ),
        ],
      ),
    ),
  };
  for (const [role, prompt] of Object.entries(prompts))
    assert.ok(
      prompt.includes(WORKSPACE_RULE),
      `${role} prompt carries the stash rule`,
    );
});

test("extended validation retains execution detail", () => {
  const text = buildRunContext(handoffTask, { id: 'r', role: 'worker', head: 'a'.repeat(40) }).validation;
  assert.match(text, /Never kill processes by pattern/); assert.match(text, /foreground/);
});

test("author and reviewer validation points to repository authority", () => {
  for (const prompt of [workerPrompt(handoffTask, true), runPrompt(handoffTask, runs[0], '/helper', '/ticket', true), runPrompt(handoffTask, runs[1], '/helper', '/ticket', true)]) assert.match(prompt, /AGENTS.md Validate section/);
});

test("worktree-facing prompts protect other worktrees and run scratch", () => {
  assert.match(WORKSPACE_RULE, /Never use git stash or remove another worktree/);
  assert.match(WORKSPACE_RULE, /Never remove the scratch root, its parent, or anything another run owns/);
});

test("run prompt names the current scratch and environment", () => {
  const run = { ...runs[1], temporaryDirectory: '/scratch/current' };
  const prompt = runPrompt(handoffTask, run, '/helper', '/ticket', true);
  assert.match(prompt, /Run scratch: \/scratch\/current/); assert.match(prompt, /TMPDIR=/);
});

test("the first BB worker sees the browser-cache capability gap", () => {
  const task = {
    id: "task",
    runId: "run",
    hostId: `bb:${"b".repeat(32)}`,
    title: "Task",
    repoPath: "/repo",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    resolution: {},
    skipPRReview: false,
  } as unknown as Task;
  assert.match(workerPrompt(task, false), /BB browser-cache capability gap/);
  assert.doesNotMatch(
    workerPrompt({ ...task, hostId: "paseo:fixture" }, false),
    /BB browser-cache capability gap/,
  );
});

test("the clean-environment retry defers to this run's temporary directory, never the launch environment", () => {
  // Queue #584: the retry renders on a new reviewer round, which can continue a retained
  // reviewer whose launch environment names the earlier run, so the block must defer to
  // this run's directory and must not say to keep the variables unchanged.
  const run = {
    id: "run",
    role: "reviewer",
    generation: 1,
    head: "a".repeat(40),
    temporaryDirectory: "/Volumes/retired-volume/scratch/effigy/q/0123456789ab",
    proofRetry: {
      forRunId: "prior",
      head: "a".repeat(40),
      proofs: [
        "effigy test unit -- test/changed.test.ts (IPC error EADDRINUSE on the socket)",
      ],
    },
  } as Run;
  const prompt = runPrompt(
    { id: "task", title: "Task", repoPath: "/repo" } as Task,
    run,
    "/helper",
    "/ticket",
  );
  assert.match(
    prompt,
    /Clean-environment retry \(this is the one allowance\)[\s\S]*mktemp -d under this run's temporary directory/,
  );
  assert.match(
    prompt,
    /TMPDIR='\/Volumes\/retired-volume\/scratch\/effigy\/q\/0123456789ab' TMP='\/Volumes\/retired-volume\/scratch\/effigy\/q\/0123456789ab' TEMP='\/Volumes\/retired-volume\/scratch\/effigy\/q\/0123456789ab'; your launch environment may still name an earlier run/,
  );
  assert.doesNotMatch(prompt, /Keep TMPDIR, TMP and TEMP unchanged/);
  assert.match(
    prompt,
    /You must not remove this run's recorded temporary root, its parent, or a root you did not create/,
  );
  assert.match(
    prompt,
    /A test, fixture or selector may remove temporary directories it created during this run inside this run's \$TMPDIR/,
  );
});

test("workspace safety and source immutability stay in prompts", () => {
  assert.match(WORKSPACE_RULE, /Tests may remove only their own fixture directories/);
  assert.match(runPrompt(handoffTask, runs[1], '/helper', '/ticket', true), /must never edit tracked files/);
});

test("validation detail remains available to the worker", () => {
  const text = buildRunContext(handoffTask, { id: 'r', role: 'worker', head: 'a'.repeat(40) }).validation;
  assert.match(text, /foreground/); assert.match(text, /Ending the turn while one runs/);
});

test("extended validation keeps the completion rule", () => {
  const text = buildRunContext(handoffTask, { id: 'r', role: 'worker', head: 'a'.repeat(40) }).validation;
  assert.match(text, /Run each covering check once/); assert.match(text, /Only a check you would add beyond the brief/);
});

test("the reviewer must perform a brief-assigned reviewer proof or report blocked, never approve without it", () => {
  // Project-D #048, 2026-10-01: the reviewer skipped its own mandated live proof as
  // "duplication" of the worker's session and still reported ready_to_merge.
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
  } as unknown as Task;
  const reviewer = runPrompt(
    task,
    { id: "run", role: "reviewer", generation: 1, head: "a".repeat(40) } as Run,
    "/helper",
    "/ticket",
    false,
  );
  assert.match(
    reviewer,
    /A proof it assigns to you[\s\S]*is yours: perform it yourself at this head/,
  );
  assert.match(
    reviewer,
    /never report ready_to_merge with a required reviewer proof skipped/,
  );
  assert.match(
    reviewer,
    /An author's check or an earlier run's record never replaces it/,
  );
});

test("acceptance proof actor: a brief-assigned separate executor proof is evaluated, not re-executed, in ordinary and fresh review", () => {
  // Project-C #155 (run 2726e20f), 2026-10-27: the reviewer was told to perform every
  // acceptance proof personally, so it blocked on a separately owner-activated proof
  // run that the brief assigned to a distinct agent. The fresh-review path said the same.
  const executed = {
    runId: "proof-run",
    agentId: "executor-agent",
    workspaceId: "workspace",
    profile: null,
    operationId: null,
    selector: "effigy test native-proof",
    inputs: [],
    repository: null,
    prNumber: 1,
    branch: "ns-task",
    head: "a".repeat(40),
    briefVersion: 1,
    briefDigest: null,
    authorizedBy: { role: "project_owner", caller: null, note: null },
    activatedAt: "2026-10-27T00:00:00.000Z",
    settledAt: "2026-10-27T00:10:00.000Z",
    status: "passed",
    exitCode: 0,
    evidence: "4 passing",
  };
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
    proofExecutions: [executed],
  } as unknown as Task;
  const ordinary = runPrompt(
    task,
    { id: "run", role: "reviewer", generation: 1, head: "a".repeat(40) } as Run,
    "/helper",
    "/ticket",
    false,
  );
  const fresh = runPrompt(
    task,
    {
      id: "run",
      role: "reviewer",
      generation: 1,
      head: "a".repeat(40),
      reviewReason: "Owner requested fresh review",
    } as Run,
    "/helper",
    "/ticket",
    false,
  );
  for (const [label, prompt] of [
    ["ordinary", ordinary],
    ["fresh", fresh],
  ] as const) {
    assert.ok(
      prompt.includes(ACCEPTANCE_PROOF_ACTOR_NOTE),
      `${label}: carries the acceptance proof actor rule`,
    );
    assert.doesNotMatch(
      prompt,
      /perform every required acceptance proof yourself/,
      `${label}: no unconditional personal proof`,
    );
    assert.doesNotMatch(
      prompt,
      /another session's proof never stands in/,
      `${label}: no blanket substitution ban`,
    );
    assert.match(
      prompt,
      /run proof-run, executor agent executor-agent/,
      `${label}: names the recorded separate executor run`,
    );
    assert.match(
      prompt,
      /grant no review credit/,
      `${label}: separate proof grants no automatic credit`,
    );
  }
  assert.match(fresh, /Operator-requested fresh review reason/);
  assert.match(
    fresh,
    /A proof assigned to a separate owner-activated executor is evaluated from its verified evidence/,
  );
  assert.match(
    fresh,
    /an earlier required proof is not replayed without current authority/,
  );
  // The rule keeps personal reading, independent judgment and exact-head evidence mandatory.
  assert.match(
    ACCEPTANCE_PROOF_ACTOR_NOTE,
    /separately owner-activated run by a distinct agent is not yours to execute/,
  );
  assert.match(ACCEPTANCE_PROOF_ACTOR_NOTE, /do not re-execute it/);
  assert.match(
    ACCEPTANCE_PROOF_ACTOR_NOTE,
    /selector, exact head and inputs match the brief/,
  );
  assert.match(
    ACCEPTANCE_PROOF_ACTOR_NOTE,
    /Missing, stale, inconsistent, unauthorized or wrong-agent evidence is insufficient/,
  );
  assert.match(
    ACCEPTANCE_PROOF_ACTOR_NOTE,
    /Your personal reading and source judgment stay mandatory/,
  );
  assert.match(ACCEPTANCE_PROOF_ACTOR_NOTE, /not automatic gate credit/);
  // A proof assigned to neither the reviewer nor a separate executor is the author's required proof.
  assert.match(
    ACCEPTANCE_PROOF_ACTOR_NOTE,
    /A proof the brief assigns to neither you nor a separate executor is the author's required proof: do not perform it/,
  );
  assert.match(
    ACCEPTANCE_PROOF_ACTOR_NOTE,
    /judge its presence and evidence under the required-proof rule/,
  );
  assert.doesNotMatch(ACCEPTANCE_PROOF_ACTOR_NOTE, /it is yours to perform/);
});

test("acceptance proof actor: an unassigned proof is the author's required proof, judged under the required-proof rule, not performed by the reviewer", () => {
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
    proofExecutions: [],
  } as unknown as Task;
  const reviewer = runPrompt(
    task,
    { id: "run", role: "reviewer", generation: 1, head: "a".repeat(40) } as Run,
    "/helper",
    "/ticket",
    false,
  );
  assert.ok(reviewer.includes(ACCEPTANCE_PROOF_ACTOR_NOTE));
  assert.doesNotMatch(reviewer, /executor agent/);
  assert.match(
    reviewer,
    /A proof the brief assigns to neither you nor a separate executor is the author's required proof: do not perform it/,
  );
  // The author-side consequence stays the existing required-proof reporting, not a reviewer run.
  assert.ok(reviewer.includes(REQUIRED_PROOF_REVIEWER_NOTE));
  assert.match(
    reviewer,
    /[Rr]eport `changes_required` with `reviewResponsibility: author`/,
  );
});

// Representative briefs through the real reviewer prompt builder. Every case pins a
// Queue-held brief whose Acceptance section assigns the proof actor, as the Project-C #155
// brief did, and renders both the ordinary and owner-requested fresh-review prompt.
// The proof records below are synthetic; nothing runs natively.
const ACTOR_HEAD = "a".repeat(40);
const actorBrief = (acceptance: string) =>
  `# 473 representative brief\n\n## Outcome\nReviewer instructions honor this brief's proof assignment.\n\n## Acceptance\n${acceptance}\n`;
const REVIEWER_PROOF_BRIEF = actorBrief(
  "The exact-head reviewer must run `effigy test unit -- test/reviewer-proof.test.ts` itself at the reviewed head. No earlier session's run stands in.",
);
const AUTHOR_PROOF_BRIEF = actorBrief(
  "The author must attach the `effigy test unit -- test/author-proof.test.ts` result at the reviewed head.",
);
const SEPARATE_PROOF_BRIEF = actorBrief(
  "The owner must activate, and a distinct agent other than the source author must run, `effigy test native-proof` at the reviewed head with pinned input originals/project-c-155.",
);
const actorTask = (briefText: string, proofExecutions: unknown[] = []) =>
  ({
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    agentId: "author-agent",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: null,
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
    briefVersions: [
      {
        version: 1,
        digest: briefDigest(briefText),
        mediaType: "text/markdown",
        text: briefText,
        reason: "Submitted",
        pinnedAt: "2026-10-27T00:00:00.000Z",
      },
    ],
    proofExecutions,
  }) as unknown as Task;
const separateProof = (over: Record<string, unknown> = {}) => ({
  runId: "proof-run",
  agentId: "executor-agent",
  workspaceId: "workspace",
  profile: null,
  operationId: null,
  selector: "effigy test native-proof",
  inputs: ["originals/project-c-155"],
  repository: null,
  prNumber: 1,
  branch: "ns-task",
  head: ACTOR_HEAD,
  briefVersion: 1,
  briefDigest: briefDigest(SEPARATE_PROOF_BRIEF),
  authorizedBy: { role: "project_owner", caller: null, note: null },
  activatedAt: "2026-10-27T00:00:00.000Z",
  settledAt: "2026-10-27T00:10:00.000Z",
  status: "passed",
  exitCode: 0,
  evidence: "4 passing",
  ...over,
});
const reviewerPrompts = (task: Task) => ({
  ordinary: runPrompt(
    task,
    { id: "run", role: "reviewer", generation: 1, head: ACTOR_HEAD } as Run,
    "/helper",
    "/ticket",
    false,
  ),
  fresh: runPrompt(
    task,
    {
      id: "run",
      role: "reviewer",
      generation: 1,
      head: ACTOR_HEAD,
      reviewReason: "Owner requested fresh review",
    } as Run,
    "/helper",
    "/ticket",
    false,
  ),
});
const carriesBrief = (prompt: string, label: string, acceptance: string) => {
  assert.match(
    prompt,
    /Nucleus-held brief: version 1, sha256:[a-f0-9]{64}/,
    `${label}: pins the brief version and digest`,
  );
  assert.match(
    prompt,
    /----- BEGIN QUEUE-HELD BRIEF -----[\s\S]*----- END QUEUE-HELD BRIEF -----/,
    `${label}: renders the Queue-held brief`,
  );
  assert.ok(
    prompt.includes(acceptance),
    `${label}: renders the brief's own proof assignment`,
  );
};

test("representative brief: a reviewer-assigned proof stays personal, with no separate record, in ordinary and fresh review", () => {
  // A brief that assigns its proof to the reviewer: no executor run exists, so the
  // reviewer performs it, and missing evidence cannot be satisfied by another session.
  for (const [label, prompt] of Object.entries(
    reviewerPrompts(actorTask(REVIEWER_PROOF_BRIEF)),
  )) {
    carriesBrief(
      prompt,
      label,
      "The exact-head reviewer must run `effigy test unit -- test/reviewer-proof.test.ts` itself at the reviewed head.",
    );
    assert.ok(
      prompt.includes(ACCEPTANCE_PROOF_ACTOR_NOTE),
      `${label}: carries the actor rule`,
    );
    assert.match(
      prompt,
      /A proof it assigns to you[\s\S]*is yours: perform it yourself at this head/,
      `${label}: personal proof obligation`,
    );
    assert.match(
      prompt,
      /An author's check or an earlier run's record never replaces it/,
      `${label}: no substitute`,
    );
    assert.match(
      prompt,
      /never report ready_to_merge with a required reviewer proof skipped/,
      `${label}: no skipped approval`,
    );
    assert.doesNotMatch(
      prompt,
      /executor agent/,
      `${label}: no separate executor evidence block`,
    );
    assert.doesNotMatch(
      prompt,
      /perform every required acceptance proof yourself/,
      `${label}: old blanket instruction removed`,
    );
    assert.doesNotMatch(
      prompt,
      /another session's proof never stands in/,
      `${label}: old substitution ban removed`,
    );
    // Personal reading and independent judgment stay mandatory on this path too.
    assert.ok(
      prompt.includes(REVIEWER_READING_RULE),
      `${label}: keeps personal reading`,
    );
    assert.match(
      prompt,
      /You are independent of that prior work/,
      `${label}: keeps independence`,
    );
    assert.match(
      prompt,
      /Inspect the diff and canonical scope/,
      `${label}: keeps own inspection`,
    );
  }
  assert.match(
    reviewerPrompts(actorTask(REVIEWER_PROOF_BRIEF)).fresh,
    /an earlier required proof is not replayed without current authority/,
  );
});

test("representative brief: an author-assigned required proof stays the author's, judged and reported, never performed by the reviewer", () => {
  for (const [label, prompt] of Object.entries(
    reviewerPrompts(actorTask(AUTHOR_PROOF_BRIEF)),
  )) {
    carriesBrief(
      prompt,
      label,
      "The author must attach the `effigy test unit -- test/author-proof.test.ts` result at the reviewed head.",
    );
    assert.match(
      prompt,
      /A proof the brief assigns to neither you nor a separate executor is the author's required proof: do not perform it/,
      `${label}: author proof not taken over`,
    );
    assert.match(
      prompt,
      /judge its presence and evidence under the required-proof rule/,
      `${label}: judged under the required-proof rule`,
    );
    assert.ok(
      prompt.includes(REQUIRED_PROOF_REVIEWER_NOTE),
      `${label}: required-proof reporting rendered`,
    );
    assert.match(
      prompt,
      /[Rr]eport `changes_required` with `reviewResponsibility: author`/,
      `${label}: existing author reporting kept`,
    );
    assert.ok(
      prompt.includes(REVIEWER_READING_RULE),
      `${label}: keeps personal reading`,
    );
    assert.match(
      prompt,
      /Your personal reading and source judgment stay mandatory/,
      `${label}: keeps own judgment`,
    );
  }
});

test("representative brief: a separate owner-activated distinct-agent proof is evaluated from its verified evidence, never re-executed", () => {
  const task = actorTask(SEPARATE_PROOF_BRIEF, [separateProof()]);
  for (const [label, prompt] of Object.entries(reviewerPrompts(task))) {
    carriesBrief(
      prompt,
      label,
      "The owner must activate, and a distinct agent other than the source author must run, `effigy test native-proof` at the reviewed head with pinned input originals/project-c-155.",
    );
    assert.match(
      prompt,
      /run proof-run, executor agent executor-agent, executor model unrecorded, status passed, selector effigy test native-proof, exact head a{40}, activated by project_owner, inputs originals\/project-c-155, exit 0; evidence: 4 passing/,
      `${label}: shows the verified record beside the brief`,
    );
    assert.match(
      prompt,
      /grant no review credit/,
      `${label}: separate proof is not gate credit`,
    );
    assert.match(
      prompt,
      /prior author agents: author-agent, executor-agent/,
      `${label}: executor stays independence evidence`,
    );
    assert.match(
      prompt,
      /A proof the brief names as a separately owner-activated run by a distinct agent is not yours to execute, and you do not re-execute it/,
      `${label}: no re-execution`,
    );
    assert.match(
      prompt,
      /evaluate that run's verified evidence/,
      `${label}: evaluates the record`,
    );
    assert.match(
      prompt,
      /that the owner activated it/,
      `${label}: owner activation checked`,
    );
    assert.match(
      prompt,
      /Your personal reading and source judgment stay mandatory/,
      `${label}: independent judgment kept`,
    );
    assert.doesNotMatch(
      prompt,
      /perform every required acceptance proof yourself|another session's proof never stands in/,
      `${label}: no conflicting path`,
    );
  }
});

test("representative brief: missing, stale, unsettled, failed, wrong-head, wrong-input or wrong-agent separate evidence stays insufficient", () => {
  const cases: [string, unknown[]][] = [
    ["missing", []],
    ["stale", [separateProof({ status: "stale" })]],
    [
      "running",
      [
        separateProof({
          status: "running",
          settledAt: null,
          exitCode: null,
          evidence: "",
        }),
      ],
    ],
    [
      "failed",
      [separateProof({ status: "failed", exitCode: 1, evidence: "1 failing" })],
    ],
    ["wrong head", [separateProof({ head: "b".repeat(40) })]],
    ["wrong input", [separateProof({ inputs: ["originals/other"] })]],
    ["wrong agent", [separateProof({ agentId: "author-agent" })]],
  ];
  const prompts = (records: unknown[]) =>
    reviewerPrompts(actorTask(SEPARATE_PROOF_BRIEF, records)).ordinary;
  for (const [name, records] of cases) {
    for (const [label, prompt] of Object.entries(
      reviewerPrompts(actorTask(SEPARATE_PROOF_BRIEF, records)),
    )) {
      carriesBrief(
        prompt,
        label,
        "The owner must activate, and a distinct agent other than the source author must run, `effigy test native-proof` at the reviewed head with pinned input originals/project-c-155.",
      );
      assert.match(
        prompt,
        /Missing, stale, inconsistent, unauthorized or wrong-agent evidence is insufficient/,
        `${name}/${label}: insufficient under the rule`,
      );
      assert.match(
        prompt,
        /the required-proof rule applies/,
        `${name}/${label}: existing reporting applies`,
      );
      // Owner-gated evidence that cannot complete the review stays the existing environment block.
      assert.match(
        prompt,
        /a proof you cannot produce yourself prevents completion, report blocked with reviewResponsibility environment/,
        `${name}/${label}: owner-gated block path kept`,
      );
    }
  }
  assert.doesNotMatch(
    prompts([]),
    /executor agent/,
    "missing: no fabricated evidence record",
  );
  assert.match(prompts([separateProof({ status: "stale" })]), /status stale/);
  assert.match(
    prompts([
      separateProof({
        status: "running",
        settledAt: null,
        exitCode: null,
        evidence: "",
      }),
    ]),
    /status running/,
  );
  assert.match(
    prompts([
      separateProof({ status: "failed", exitCode: 1, evidence: "1 failing" }),
    ]),
    /status failed/,
  );
  assert.match(
    prompts([separateProof({ head: "b".repeat(40) })]),
    /exact head b{40}/,
  );
  assert.match(
    prompts([separateProof({ head: "b".repeat(40) })]),
    /selector, exact head and inputs match the brief/,
  );
  assert.match(
    prompts([separateProof({ inputs: ["originals/other"] })]),
    /inputs originals\/other/,
  );
  assert.match(
    prompts([separateProof({ agentId: "author-agent" })]),
    /executor agent author-agent/,
  );
  assert.match(
    prompts([separateProof({ agentId: "author-agent" })]),
    /its agent is not the source author/,
  );
  assert.match(
    prompts([separateProof({ agentId: "author-agent" })]),
    /no agent listed above may certify it/,
    "wrong agent: independence still holds",
  );
});

test("representative brief: owner activation boundary, a relayed activation is named so the reviewer checks it against the brief", () => {
  // Spec 055: an owner may relay activation. The record names the activator role, and
  // the actor rule keeps the owner-activation check the brief's condition rather than
  // accepting any recorded run.
  const relay = actorTask(SEPARATE_PROOF_BRIEF, [
    separateProof({
      authorizedBy: {
        role: "authorized_relay",
        caller: "relay-agent",
        note: null,
      },
    }),
  ]);
  for (const [label, prompt] of Object.entries(reviewerPrompts(relay))) {
    carriesBrief(
      prompt,
      label,
      "The owner must activate, and a distinct agent other than the source author must run, `effigy test native-proof` at the reviewed head with pinned input originals/project-c-155.",
    );
    assert.match(
      prompt,
      /activated by authorized_relay/,
      `${label}: names the relayed activator`,
    );
    assert.match(
      prompt,
      /that the owner activated it/,
      `${label}: owner activation remains the brief's condition`,
    );
    assert.match(
      prompt,
      /unauthorized or wrong-agent evidence is insufficient/,
      `${label}: an activation outside the brief stays insufficient`,
    );
  }
});

test("the reviewer prompt states mandatory reading before any verdict, and the continuation repeats it", () => {
  // Project-A #1900, 2026-10-05: a reviewer gave a verdict before finishing the brief's
  // required reading, then supplied a stale supplement to an already closed run.
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
  } as unknown as Task;
  const run = {
    id: "run",
    role: "reviewer",
    generation: 1,
    head: "a".repeat(40),
  } as Run;
  const reviewer = runPrompt(task, run, "/helper", "/ticket", false);
  assert.ok(reviewer.includes(REVIEWER_READING_RULE));
  assert.match(
    reviewer,
    /Read every input the brief names personally before you judge it/,
  );
  assert.match(
    reviewer,
    /Never report a verdict, or pass, while any required input is unread/,
  );
  assert.match(reviewer, /a closed review run cannot be supplemented/);
  // Approval omits responsibility; unfinished coverage is the reviewer's own checkpoint, never an author defect.
  assert.match(reviewer, /A ready_to_merge report omits reviewResponsibility/);
  assert.match(
    reviewer,
    /report review_in_progress with reviewResponsibility=reviewer, a covered\/remaining\/notes checkpoint and no verdicts/,
  );
  assert.match(
    reviewer,
    /reviewResponsibility=author only for changes_required/,
  );
});

/**
 * Papercut 8647384e: a reviewer whose own report was refused for a malformed
 * `reviewedInputs` entry reported blocked, so the planner had to restart the step
 * to get the same verdict resent. The reviewer prompt (and its operator
 * continuation) now agrees with intake: correct the named field and resend; your
 * own malformed report is never a blocked outcome.
 */
test("the reviewer prompt requires correcting a refused report instead of reporting blocked", () => {
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
  } as unknown as Task;
  const run = {
    id: "run",
    role: "reviewer",
    generation: 1,
    head: "a".repeat(40),
  } as Run;
  for (const mcp of [false, true]) {
    const reviewer = runPrompt(task, run, "/helper", "/ticket", mcp);
    assert.ok(
      reviewer.includes(REVIEWER_REFUSED_REPORT_RULE),
      `mcp ${mcp}: carries the refused-report rule`,
    );
    assert.match(
      reviewer,
      /the tool result names the exact entry, field and expected shape/,
    );
    assert.match(
      reviewer,
      /Correct that field and resend the same verdict in the same turn/,
    );
    assert.match(
      reviewer,
      /Never report blocked or error because your own report was malformed/,
    );
  }
});

test("worker, reviewer and coordinator prompts name run-scratch lane document copies and unresolved citations", () => {
  const directory = "/scratch/run-a";
  const pin = {
    key: "nucleus-t3code",
    version: 2,
    digest: "sha256:" + "a".repeat(64),
    text: "Lane guidance",
  };
  const task = {
    ...messageRuleTask,
    temporaryDirectory: directory,
    laneDocumentPins: [pin],
    laneDocumentIssues: ["missing-lane"],
  } as unknown as Task;
  const path = laneDocumentScratchPath(directory, pin.key);
  const worker = workerPrompt(task, true);
  assert.ok(worker.includes(path));
  assert.match(worker, /not found in the current plan.*missing-lane/);
  assert.ok(worker.includes(WORKER_REFUSED_REPORT_RULE));
  for (const role of ["reviewer", "recovery"] as const) {
    const prompt = runPrompt(
      task,
      {
        id: "run",
        role,
        generation: 1,
        head: "a".repeat(40),
        temporaryDirectory: directory,
      } as Run,
      "/helper",
      "/ticket",
      true,
    );
    assert.ok(prompt.includes(path));
    assert.match(prompt, /missing-lane/);
  }
});

test("review formatting covers changed source only and missing selectors do not block approval", () => {
  const task = {
    id: "task",
    title: "Verify",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    branch: "ns-task",
    baseBranch: "main",
    handoffPath: "handoff.md",
    planningCommit: head,
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: {},
  } as Task;
  const reviewer = runPrompt(
    task,
    { id: "review", role: "reviewer", generation: 1, head } as Run,
    "/helper",
    "/ticket",
    true,
  );
  assert.match(reviewer, /AGENTS.md Validate section/);
  assert.match(
    reviewer,
    /for changed formatted source that has a covering Effigy format selector/,
  );
  assert.match(reviewer, /docs, JSON and Cargo.toml-only changes need none/);
  assert.match(
    reviewer,
    /missing format selector is a papercut, not a review blocker/,
  );
});

/**
 * Queue #395: a continuation may reuse the artifacts an earlier run left.
 * Run-bound cleanup is recorded only for a run that reported a result, and a
 * `complete` record names Queue's own obligation rather than what is present
 * now, so every continuation quotes the stored records before its own reuse
 * instruction. The disclosure is provenance, never deletion, absence or
 * authority to rebuild.
 */
const cleanupRecord = (overrides: Record<string, unknown>) => ({
  workspaceId: "workspace",
  directory: "/worktree",
  state: "complete",
  detail: "",
  at: "2026-10-24T00:00:00.000Z",
  ...overrides,
});
const cleanupTask = (resolution: Record<string, unknown>) =>
  ({
    id: "task",
    runId: "worker-run",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    resumePrNumber: 9,
    handoffPath: "handoff.md",
    planningCommit: "b".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/9",
    reason: "Address the review findings",
    completion: {
      eventId: "w1",
      taskId: "task",
      runId: "worker-run",
      status: "blocked",
      summary: "Blocked after a build",
      head: "a".repeat(40),
    },
    resolution: {
      revisionPrRepair: false,
      review: { summary: "Fix the route", reviewCommentId: 1 },
      ...resolution,
    },
  }) as unknown as Task;

test("revision prompts direct cleanup history to run context", () => {
  const text = runPrompt(handoffTask, runs[0], '/helper', '/ticket', true);
  assert.match(text, /context/); assert.match(text, /Resume/);
});

test("build output history preserves recorded data in context", () => {
  const ctx = buildRunContext(handoffTask, { id: 'r', role: 'revision', head: 'a'.repeat(40) });
  assert.match(ctx.history, /buildOutputCleanups/);
});

test("reviewer can read cleanup history from context", () => {
  const ctx = buildRunContext(handoffTask, { id: 'r', role: 'reviewer', head: 'a'.repeat(40) });
  assert.match(ctx.history, /buildOutputCleanups/);
});

test("the required-proof instruction is fixed prompt text, rendered outside the validation block", () => {
  // The validation block is now fixed Nucleus text (task 985): the repository's
  // AGENTS.md Validate section is the authority. The required-proof rule stays
  // outside it so the two rules cannot be edited against each other.
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
  } as unknown as Task;
  const worker = workerPrompt(task, true);
  const revision = runPrompt(
    task,
    { id: "run", role: "revision", generation: 1, head: "a".repeat(40) } as Run,
    "/helper",
    "/ticket",
    true,
  );
  const reviewer = runPrompt(
    task,
    { id: "run", role: "reviewer", generation: 1, head: "a".repeat(40) } as Run,
    "/helper",
    "/ticket",
    true,
  );
  for (const [role, prompt] of [
    ["worker", worker],
    ["revision", revision],
  ] as const) {
    assert.ok(
      prompt.includes(REQUIRED_PROOF_AUTHOR_NOTE),
      `${role} prompt keeps the author required-proof instruction`,
    );
    assert.ok(
      prompt.indexOf(REQUIRED_PROOF_AUTHOR_NOTE) >
        prompt.indexOf(VALIDATION_AUTHORITY_RULE),
      `${role} instruction sits outside the validation rule`,
    );
  }
  assert.ok(
    reviewer.includes(REQUIRED_PROOF_REVIEWER_NOTE),
    "reviewer prompt keeps the reviewer required-proof instruction",
  );
  assert.ok(
    reviewer.indexOf(REQUIRED_PROOF_REVIEWER_NOTE) >
      reviewer.indexOf(VALIDATION_AUTHORITY_RULE),
    "reviewer instruction sits outside the validation rule",
  );
  // The validation block itself never carries the instruction, so the two rules stay independent.
  const block = operatorValidationBlock();
  assert.ok(
    !block.includes(REQUIRED_PROOF_AUTHOR_NOTE) &&
      !block.includes(REQUIRED_PROOF_REVIEWER_NOTE),
  );
  assert.ok(block.includes(VALIDATION_AUTHORITY_RULE));
  // The reviewer instruction names the statuses and responsibilities the report
  // bridge already accepts; it adds no new refusal and infers nothing from prose.
  assert.match(
    REQUIRED_PROOF_REVIEWER_NOTE,
    /Report `changes_required` with `reviewResponsibility: author` when the author can still produce it/,
  );
  assert.match(
    REQUIRED_PROOF_REVIEWER_NOTE,
    /`blocked` with `reviewResponsibility: environment` when it is owner-gated or unavailable/,
  );
  assert.match(
    REQUIRED_PROOF_REVIEWER_NOTE,
    /If the repository's AGENTS\.md Validate section and the brief disagree about a missing proof, say so in the report and report blocked/,
  );
  assert.match(
    REQUIRED_PROOF_REVIEWER_NOTE,
    /required artifact named only by a run-scratch path[\s\S]*report `changes_required` with `reviewResponsibility: author`/,
  );
  assert.match(
    REQUIRED_PROOF_AUTHOR_NOTE,
    /TMPDIR is removed at release[\s\S]*through proofFiles[\s\S]*8 MiB per file; 32 MiB total[\s\S]*subset the brief allows[\s\S]*reviewResponsibility: environment/,
  );
});

test("brief-mode prompts and reviewer continuations carry the required-proof instruction", () => {
  // A brief names its proofs in prose, and the frozen brief-mode snapshot must show the
  // instruction rendered outside the policy.
  const worker = workerPrompt(handoffTask, true);
  const revision = runPrompt(
    handoffTask,
    runs.find((run) => run.role === "revision")!,
    "/helper",
    "/ticket",
    true,
  );
  const reviewer = runPrompt(
    handoffTask,
    runs.find((run) => run.role === "reviewer")!,
    "/helper",
    "/ticket",
    true,
  );
  assert.ok(worker.includes(REQUIRED_PROOF_AUTHOR_NOTE));
  assert.ok(revision.includes(REQUIRED_PROOF_AUTHOR_NOTE));
  assert.ok(reviewer.includes(REQUIRED_PROOF_REVIEWER_NOTE));
  assert.ok(
    checkpointPrompt(handoffTask, intent).includes(REQUIRED_PROOF_AUTHOR_NOTE),
    "a worker continuation keeps the instruction",
  );
  // Roles it does not address keep their exact prompts.
  for (const role of ["closeout", "recovery"] as const) {
    const prompt = runPrompt(
      handoffTask,
      runs.find((run) => run.role === role)!,
      "/helper",
      "/ticket",
      true,
    );
    assert.ok(
      !prompt.includes(REQUIRED_PROOF_AUTHOR_NOTE) &&
        !prompt.includes(REQUIRED_PROOF_REVIEWER_NOTE),
      `${role} prompt gains no validation instruction`,
    );
  }
  const run = runs.find((candidate) => candidate.role === "reviewer")!;
  const checkpoint = {
    ordinal: 1,
    checkpoint: { covered: [], remaining: ["17 originals"], notes: "" },
    head: run.head,
    at: "now",
    runId: run.id,
    path: "/queue/review-checkpoints/t/r/checkpoint-1.json",
    briefVersion: 1,
  } as unknown as ReviewCheckpointRecord;
  const authorization = {
    reason: "Continue the bounded review",
    instruction: "Finish the remaining reading and judge the head",
    briefVersion: 1,
  } as unknown as ReviewDeliveryAuthorization;
  assert.ok(
    operatorReviewContinuationPrompt(
      handoffTask,
      run,
      checkpoint,
      authorization,
    ).includes(REQUIRED_PROOF_REVIEWER_NOTE),
  );
});

test("affected-test prompts are opt-in and use the repository command", () => {
  const task = {
    id: "task",
    runId: "initial",
    title: "Build",
    originAgentId: "origin",
    coordinatorAgentId: null,
    dependsOn: [],
    branch: "ns-task",
    baseBranch: "main",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    retiredWorkers: [],
    skipPRReview: false,
    prUrl: null,
    reason: "Review",
    completion: { status: "ready_for_review", prNumber: 1 },
    resolution: { revisionPrRepair: false },
  } as unknown as Task;
  const ordinary = [
    workerPrompt(task, true),
    runPrompt(
      task,
      {
        id: "run",
        role: "revision",
        generation: 1,
        head: "a".repeat(40),
      } as Run,
      "/helper",
      "/ticket",
      true,
    ),
    runPrompt(
      task,
      {
        id: "run",
        role: "reviewer",
        generation: 1,
        head: "a".repeat(40),
      } as Run,
      "/helper",
      "/ticket",
      true,
    ),
  ];
  for (const prompt of ordinary) assert.doesNotMatch(prompt, /Affected tests:/);
  const configured = "effigy test:affected --run";
  const optedIn = [
    workerPrompt(task, true, [], null, undefined, undefined, configured),
    runPrompt(
      task,
      {
        id: "run",
        role: "revision",
        generation: 1,
        head: "a".repeat(40),
      } as Run,
      "/helper",
      "/ticket",
      true,
      null,
      null,
      configured,
    ),
    runPrompt(
      task,
      {
        id: "run",
        role: "reviewer",
        generation: 1,
        head: "a".repeat(40),
      } as Run,
      "/helper",
      "/ticket",
      true,
      null,
      null,
      configured,
    ),
  ];
  for (const prompt of optedIn)
    assert.match(prompt, /effigy test:affected --run/);
  for (const prompt of optedIn) {
    assert.match(prompt, /effigy test:baseline <file>/);
    assert.match(prompt, /queue-test-failures-<pid>-<ts>\.txt/);
    assert.match(prompt, /it was already broken/);
    assert.match(
      prompt,
      /Only failures unique to your branch block review|Only failures unique to the branch block review/,
    );
    assert.match(prompt, /list the file and failing test/);
  }
  assert.match(
    optedIn[2],
    /If that evidence is missing or names another head, run it once yourself/,
  );
  assert.match(optedIn[2], /Only failures unique to the branch block review/);
});

test("recovery coordinator prompt carries the launch snapshot and the one refresh command for the plan", () => {
  const task = {
    id: "task",
    title: "Recover",
    phase: "reviewing",
    reason: "Checkpoint 1 awaits continuation",
    originAgentId: "origin",
    repoPath: "/repo",
    workspaceId: "workspace",
    directory: "/worktree",
    handoffPath: "handoff.md",
    planningCommit: "a".repeat(40),
    branch: "ns-task",
    baseBranch: "main",
    skipPRReview: false,
    prUrl: "https://github.com/example/repo/pull/1",
    resolution: {},
  } as unknown as Task;
  const run = {
    id: "recovery",
    role: "recovery",
    generation: 2,
    head: "a".repeat(40),
  } as Run;
  const snapshot = {
    why: {
      cause: "Checkpoint 1 awaits continuation",
      target: "reviewer",
      recoveryRunId: "recovery",
    },
    phase: "reviewing",
    reason: "Checkpoint 1 awaits continuation",
    stop: {
      kind: "recovery",
      reason: "review_authorization_required",
      owner: "coordinator",
      evidence: "recovery recovery (running, generation 2)",
      detail: null,
    },
    activeRun: null,
    holds: {},
    checkpoint: {
      runId: "review-run",
      ordinal: 1,
      head: "a".repeat(40),
      covered: ["Reading the diff"],
      remaining: ["the rest"],
      notes: null,
    },
    outcome: {
      accepted: null,
      reported: null,
      impediment: null,
      impediments: [],
      reader: null,
      authorResult: null,
      decision:
        "No review verdict is recorded at the current head aaaaaaaaaaaa; the outstanding decision is an independent review of that head.",
      revision: { runs: 0, budget: 6, exhausted: false },
    },
    authorResult: null,
    verbs: [{ verb: "restart", available: true, args: { role: "reviewer" } }],
  };
  const prompt = runPrompt(
    task,
    run,
    "/helper",
    "/ticket",
    false,
    snapshot as never,
  );
  assert.match(
    prompt,
    /Nucleus context at launch: a snapshot of the task-scoped plan `next` derives/,
  );
  assert.match(prompt, /It is observation, not authority/);
  assert.match(prompt, /nucleus helper report next/);
  assert.match(prompt, /"checkpoint":\{"runId":"review-run","ordinal":1/);
  assert.match(
    prompt,
    /"verb":"restart","available":true,"args":\{"role":"reviewer"\}/,
  );
  assert.match(prompt, /Report exactly one coordinatorAction/);
  // The coordinator guidance follows the projected outcome instead of the mere
  // presence of a verdict (Queue #477 review 5675271170).
  assert.match(
    prompt,
    /An accepted review that holds the current accepted slot is the task's verdict/,
  );
  assert.match(
    prompt,
    /When the plan marks that applied verdict superseded, it is history/,
  );
  assert.match(prompt, /a deliberate fresh reader is never displaced/);
  assert.match(prompt, /authorResult\.afterApplied/);
  assert.match(
    prompt,
    /escalates to its project planner through the blocker ladder \(Spec 058\) when the author return is the outstanding decision/,
  );
  assert.match(
    prompt,
    /A live author revision is work in progress, not a request to return it again/,
  );
  // The verb prose keeps the shipped retained-reader contract (Queue #476): the
  // move preserves and continues a valid reader, and a deliberate fresh
  // replacement is the explicit restart.
  assert.match(
    prompt,
    /move to=review preserves and continues that valid reader at the exact head/,
  );
  assert.match(
    prompt,
    /A deliberate fresh replacement is restart role=reviewer fresh or route role=reviewer with now/,
  );
  // Without a snapshot the prompt says so and still names the refresh path.
  const unavailable = runPrompt(task, run, "/helper", "/ticket", false);
  assert.match(unavailable, /launch snapshot is unavailable/);
  assert.match(unavailable, /nucleus helper report next/);
  assert.doesNotMatch(unavailable, /"verbs"/);
});

test("worker rules distinguish blockers from unfinished work", () => {
  const ctx = buildRunContext(handoffTask, { id: 'r', role: 'worker', head: 'a'.repeat(40) });
  assert.match(ctx.rules, /hit a concrete impediment/);
  assert.match(ctx.rules, /Unfinished work and context pressure call for continued work or a checkpoint/);
});

test("retired verification runs cannot produce a closeout prompt", () => {
  assert.throws(
    () =>
      runPrompt(
        {} as Task,
        { role: "verification" } as Run,
        "/helper",
        "/ticket",
      ),
    /Verification coordinator runs are retired/,
  );
});
