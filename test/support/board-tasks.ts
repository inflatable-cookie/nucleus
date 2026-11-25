import { telemetryStageForTask } from "../../shared/telemetry";
import { detail, taskDetailView, taskNextSchema, taskSchema, type TaskDetail, type TaskNext, type Task } from "../../shared/contracts";

/** Numbered board rows, in admission order within each test. */
export function boardTasks() {
  let number = 0;
  return (id: string, patch: Partial<Task>): Task => {
    const now = new Date().toISOString();
    return taskSchema.parse({
      id,
      submissionId: id,
      title: id,
      number: ++number,
      repoPath: "/app",
      planningCommit: "a".repeat(40),
      planningBase: "a".repeat(40),
      handoffPath: `${id}.md`,
      handoffText: "handoff",
      originAgentId: "0b355fd4",
      notificationAgentId: "56e9c969",
      hostId: "host",
      version: 1,
      createdAt: now,
      updatedAt: now,
      phase: "queued",
      reason: "Waiting for dispatch",
      held: false,
      branch: `task-${id}`,
      workspaceId: null,
      directory: null,
      agentId: null,
      runId: null,
      profile: null,
      workspaceIntent: false,
      agentIntent: false,
      lastAgentStatus: null,
      idleSince: null,
      completion: null,
      agentActive: null,
      lastObservedAt: null,
      prUrl: null,
      prHead: null,
      coordinatorGeneration: 1,
      resolution: { attention: false, mergedCommit: null },
      ...patch,
    });
  };
}

export function boardDetailReply(task: Task) {
  return detail.output.parse({
    task: taskDetailView(task),
    events: [],
    runs: [],
    notices: [],
    dependencies: [],
    hooks: [],
    telemetry: {
      taskId: task.id,
      generatedAt: task.updatedAt,
      evidence: "exact",
      totalElapsedMs: 0,
      waitingMs: 0,
      activeMs: 0,
      interventionMs: 0,
      currentStage: telemetryStageForTask(task),
      currentStageAgeMs: 0,
      closeoutAuthority: "pending",
      stages: [],
      interventions: {
        recoveryRuns: 0,
        recoveries: [],
        uncertainCreations: 0,
        absentCreations: 0,
        attentionNotices: 0,
        escalations: 0,
        hookHolds: 0,
        hookRetries: 0,
        revisions: 0,
        replacements: 0,
        operatorActions: [],
      },
    },
  });
}

export function boardNext(
  task: TaskDetail,
  overrides: Record<string, unknown> = {},
): TaskNext {
  return taskNextSchema.parse({
    taskId: task.id,
    title: task.title,
    phase: task.phase,
    version: task.version,
    repository: task.repository ?? "owner/app",
    number: task.number,
    reference: task.number ? `app#${task.number}` : null,
    attention: false,
    reason: task.reason,
    activeRun: null,
    prHead: task.prHead,
    prUrl: task.prUrl,
    branch: task.branch,
    stop: null,
    outcome: {
      accepted: null,
      reported: null,
      impediment: null,
      impediments: [],
      reader: null,
      authorResult: null,
      decision: "Nothing outstanding",
      revision: { runs: 0, budget: 6, exhausted: false },
    },
    holds: task.holds,
    verbs: [],
    ...overrides,
  });
}
