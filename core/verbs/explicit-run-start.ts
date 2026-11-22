import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  REVISION_BUDGET,
  WORKER_REPLACEMENT_CEILING,
  runSchema,
  type Profile,
  type Run,
  type Task,
} from "../../shared/contracts";
import { climbedTier, requestedTier } from "../../shared/demand";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { groupIsUnavailable, requestReaches } from "../../shared/pool";
import type {
  ExplicitResolution,
  ResolutionWarningId,
} from "../../shared/schema/task-control";
import { taskBudget } from "../../shared/task-budget";
import { chooseProfile } from "../dispatch/routing";
import { usageGateBlocked } from "../dispatch/usage-gate";
import type { Engine } from "../engine";
import { git } from "../git/index";
import { readGitCheckout } from "../git/git-identity";
import { digest, now } from "../store/store";
import type {
  ExplicitFinishResult,
  ExplicitPlan,
  ExplicitWarning,
} from "./explicit-resolution";
import { releasePlan } from "./explicit-resolution";

export type MessageTarget = {
  agentId: string | null;
  hostId: string | null;
  active: boolean;
  hasSteer: boolean;
  hasEnqueue: boolean;
  hasNotify: boolean;
};

async function detectDeliveryCapabilities(
  engine: Engine,
  hostId: string | null,
) {
  const read = () => ({
    hasSteer: typeof engine.adapter.steerOrNotify === "function",
    hasEnqueue: typeof engine.adapter.enqueueMessage === "function",
    hasNotify: typeof engine.adapter.notify === "function",
  });
  return hostId ? engine.withHost(hostId, async () => read()) : read();
}

/** Resolve the current bound thread for `message.send`, including live responsible planner lookup. */
export async function resolveMessageTarget(
  engine: Engine,
  task: Task,
  role: Extract<ExplicitResolution, { action: "message.send" }>["role"],
): Promise<MessageTarget> {
  const runs = engine.store.runs(task.id);
  let agentId: string | null = null;
  let hostId: string | null = task.hostId;
  let active = false;
  if (role === "worker") {
    const activeRevision = runs.findLast(
      (r) => r.role === "revision" && !r.released && Boolean(r.agentId),
    );
    agentId = activeRevision?.agentId ?? task.agentId;
    hostId = activeRevision?.hostId ?? task.hostId;
    active = activeRevision
      ? activeRevision.active === true
      : task.agentActive === true;
  } else if (role === "reviewer") {
    const latest = runs.findLast(
      (r) => r.role === "reviewer" && Boolean(r.agentId),
    );
    agentId = task.resolution.reviewerAgentId ?? latest?.agentId ?? null;
    hostId = latest?.hostId ?? task.hostId;
    active = runs.some(
      (r) => r.role === "reviewer" && !r.released && r.active === true,
    );
  } else if (role === "coordinator") {
    const latest = runs.findLast(
      (r) => r.role === "recovery" && Boolean(r.agentId),
    );
    agentId =
      task.resolution.recovery?.agentId ??
      task.coordinatorAgentId ??
      latest?.agentId ??
      null;
    hostId = latest?.hostId ?? task.hostId;
    active = runs.some(
      (r) => r.role === "recovery" && !r.released && r.active === true,
    );
  } else {
    const project = engine.store.projectFor(
      task.repoPath,
      normalizeRepositoryOrigin(task.repository ?? ""),
    );
    const responsible = project
      ? await engine.resolution.responsibleThread(project).catch(() => null)
      : null;
    agentId =
      responsible?.thread?.agentId ??
      project?.planner?.agentId ??
      task.originAgentId ??
      null;
    hostId = responsible?.thread?.hostId ?? task.hostId ?? null;
  }
  const caps = await detectDeliveryCapabilities(engine, hostId);
  return { agentId, hostId, active, ...caps };
}

export function phaseSetPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "phase.set" }>,
): ExplicitPlan {
  const runs = engine.store.runs(task.id);
  const hasLiveInitial = Boolean(
    task.runId &&
      !task.completion &&
      (task.agentActive !== false || task.agentIntent),
  );
  const warnings: ExplicitWarning[] = [];
  if (runs.some((run) => !run.released) || hasLiveInitial) {
    warnings.push({
      id: "live_runs",
      text: "Unreleased runs exist on this task and may see an unexpected phase.",
    });
  }
  return {
    warnings,
    apply() {
      return {
        before: { phase: task.phase, reason: task.reason },
        patch: {
          phase: input.to,
          reason: input.reason,
          resolution: { ...task.resolution, stop: task.resolution.stop },
        },
      };
    },
  };
}

export function messageSendPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "message.send" }>,
  target: MessageTarget,
): ExplicitPlan {
  const { hasSteer, hasEnqueue, hasNotify } = target;
  const routeQueues = !hasSteer && hasEnqueue;
  const willQueue = routeQueues || (target.active && (hasSteer || hasEnqueue));

  const warnings: ExplicitWarning[] = [];
  if (!target.agentId) {
    warnings.push({
      id: "no_thread",
      text: `No bound ${input.role} thread exists on this task.`,
    });
  } else if (willQueue) {
    warnings.push({
      id: "queued",
      text: routeQueues
        ? `This host delivers messages to ${input.role} by queueing them behind the thread.`
        : `The ${input.role} thread may have an active turn; this message may queue behind it.`,
    });
  }
  return {
    warnings,
    apply() {
      return { before: { role: input.role, agentId: target.agentId } };
    },
    async finish(): Promise<ExplicitFinishResult> {
      if (!target.agentId) {
        return {
          issues: [`No bound ${input.role} thread to deliver to.`],
          delivery: "unknown",
        };
      }
      const messageId = `ns-explicit-msg-${randomUUID()}`;
      let delivery: "delivered" | "queued" | "unknown" = "unknown";
      const issues: string[] = [];
      const deliver = async () => {
        if (hasSteer) {
          await engine.adapter.steerOrNotify!(
            target.agentId!,
            messageId,
            input.text,
          );
          delivery = target.active ? "queued" : "delivered";
        } else if (hasEnqueue) {
          await engine.adapter.enqueueMessage!(
            target.agentId!,
            messageId,
            input.text,
          );
          delivery = "queued";
        } else if (hasNotify) {
          await engine.adapter.notify!(target.agentId!, messageId, input.text);
          delivery = "delivered";
        } else {
          issues.push("Host adapter supports no message delivery method.");
        }
      };
      try {
        await (target.hostId
          ? engine.withHost(target.hostId, deliver)
          : deliver());
      } catch (error) {
        delivery = "unknown";
        issues.push(
          `Message delivery outcome is unknown: ${String(error).slice(0, 500)}.`,
        );
      }
      return { issues, delivery };
    },
  };
}

function selectProfileForStart(
  engine: Engine,
  task: Task,
  role: "worker" | "reviewer" | "coordinator",
  agentMode: "retained" | "fresh",
  runs: Run[],
): {
  profile: Profile | null;
  group: string | null;
  needsPolicySignoff: boolean;
} {
  const store = engine.store;
  const pool = store.pool();
  const usage = store.usageLevel();
  const request = task.profileRequests?.[role];
  const allProfiles =
    task.hostId && engine.profilesFor(task.hostId).length
      ? engine.profilesFor(task.hostId)
      : engine.profiles;
  const unavailable = new Set(
    store
      .availability()
      .filter((row) => groupIsUnavailable(row))
      .map((row) => row.group),
  );
  const groupOf = (profile: Profile | null) =>
    profile
      ? (pool.find((entry) => entry.profileId === profile.id)?.group ?? null)
      : null;
  const policySignoffFor = (profile: Profile | null) => {
    const entry = profile
      ? pool.find((item) => item.profileId === profile.id)
      : null;
    const tierBlocked = Boolean(
      entry &&
        !requestReaches(
          entry,
          usage,
          request,
          requestedTier(task.complexity),
          climbedTier(task),
        ),
    );
    const roleSignoff =
      role !== "worker" && profile
        ? engine.resolution.signoffIssue(task, profile, role)
        : null;
    return Boolean(
      tierBlocked ||
        roleSignoff ||
        request?.signoff?.status === "pending" ||
        (role === "worker" && usageGateBlocked(task, usage)),
    );
  };

  if (agentMode === "retained") {
    const profile =
      role === "worker"
        ? task.profile
        : role === "reviewer"
          ? (task.resolution.reviewerProfile ??
            runs.findLast((r) => r.role === "reviewer" && r.profile)?.profile ??
            null)
          : (runs.findLast((r) => r.role === "recovery" && r.profile)
              ?.profile ?? null);
    return {
      profile,
      group: groupOf(profile),
      needsPolicySignoff: policySignoffFor(profile),
    };
  }

  let profile: Profile | null = null;
  if (request?.profileId) {
    profile = allProfiles.find((item) => item.id === request.profileId) ?? null;
  }
  if (!profile) {
    const chosen = chooseProfile(
      task,
      allProfiles,
      pool,
      store.counts(),
      unavailable,
      role,
      store.recentCounts(),
      usage,
      false,
    );
    if (chosen) profile = chosen.profile;
  }
  if (!profile && role !== "worker") {
    const selected = engine.resolution.select(task, role);
    if (selected) profile = selected.profile;
  }
  if (!profile) {
    const entry = pool.find(
      (item) => item.enabled && item.roles.includes(role),
    );
    profile =
      (entry
        ? allProfiles.find((item) => item.id === entry.profileId)
        : null) ??
      allProfiles[0] ??
      null;
  }
  return {
    profile,
    group: groupOf(profile),
    needsPolicySignoff: policySignoffFor(profile),
  };
}

async function prepareReviewerCheckout(
  task: Task,
  head: string,
): Promise<void> {
  if (!task.directory || task.reviewEntry || task.directory === task.repoPath)
    return;
  if (!existsSync(join(task.directory, ".git"))) return;
  if (task.branch) {
    await git(
      task.directory,
      "fetch",
      "origin",
      `refs/heads/${task.branch}`,
    ).catch(() => {});
  }
  await git(task.directory, "checkout", "--quiet", "--detach", head);
  const checkout = readGitCheckout(task.directory);
  if (checkout.head !== head) {
    throw Error(`Reviewer checkout is at ${checkout.head}, expected ${head}`);
  }
}

export function runStartPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "run.start" }>,
): ExplicitPlan {
  const store = engine.store;
  const runs = store.runs(task.id);
  const runRole: Run["role"] =
    input.role === "reviewer"
      ? "reviewer"
      : input.role === "coordinator"
        ? "recovery"
        : "revision";

  const activeRevision = runs.findLast(
    (r) => r.role === "revision" && !r.released && Boolean(r.agentId),
  );
  const retainedAgentId =
    input.role === "worker"
      ? (activeRevision?.agentId ?? task.agentId)
      : input.role === "reviewer"
        ? (task.resolution.reviewerAgentId ??
          runs.findLast((r) => r.role === "reviewer" && r.agentId)?.agentId ??
          null)
        : (task.resolution.recovery?.agentId ??
          task.coordinatorAgentId ??
          runs.findLast((r) => r.role === "recovery" && r.agentId)?.agentId ??
          null);

  const agentMode =
    input.agent ??
    (input.replacing ? "fresh" : retainedAgentId ? "retained" : "fresh");
  if (agentMode === "retained" && !retainedAgentId) {
    throw Error(`No retained ${input.role} thread is bound to this task`);
  }

  const replacingPlan = input.replacing
    ? releasePlan(engine, task, {
        action: "run.release",
        taskId: input.taskId,
        version: input.version,
        reason: input.reason,
        accept: input.accept,
        caller: input.caller,
        run: input.replacing,
      })
    : null;

  const { profile, group, needsPolicySignoff } = selectProfileForStart(
    engine,
    task,
    input.role,
    agentMode,
    runs,
  );
  if (agentMode === "fresh" && !profile) {
    throw Error(`No eligible profile is available for ${input.role}`);
  }

  const warnings: ExplicitWarning[] = [];
  const warn = (id: ResolutionWarningId, text: string) => {
    if (!warnings.some((item) => item.id === id)) warnings.push({ id, text });
  };

  const unreleasedRoleRuns = runs.filter(
    (r) => r.role === runRole && !r.released,
  );
  const liveInitialWorker = Boolean(
    task.runId &&
      !task.completion &&
      (task.agentActive !== false || task.agentIntent),
  );
  if (
    unreleasedRoleRuns.length > 0 ||
    (input.role === "worker" &&
      liveInitialWorker &&
      (agentMode === "fresh" || input.replacing === task.runId))
  ) {
    warn(
      "duplicate_thread",
      `Another unreleased or uncertain ${input.role} run exists on this task.`,
    );
  }
  if (
    input.role === "worker" &&
    (unreleasedRoleRuns.some(
      (r) =>
        r.active !== false ||
        ["running", "intent", "uncertain"].includes(r.status),
    ) ||
      liveInitialWorker)
  ) {
    warn(
      "two_writers",
      "Another worker may still be live in this task's worktree.",
    );
  }
  if (input.head && task.prHead && input.head !== task.prHead) {
    warn(
      "head_mismatch",
      `Requested head ${input.head.slice(0, 12)} differs from recorded PR head ${task.prHead.slice(0, 12)}.`,
    );
  }
  const budgetState = taskBudget(
    task,
    runs,
    Date.now(),
    store.eventsAll(task.id),
    store.canonicalRepository(task.repoPath, task.repository),
  );
  if (
    (input.role === "worker" &&
      agentMode === "fresh" &&
      task.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING) ||
    (input.role === "worker" &&
      task.resolution.revisionRuns >= REVISION_BUDGET) ||
    budgetState.exhausted
  ) {
    warn(
      "budget",
      "The task's replacement ceiling, revision cap or execution budget is reached.",
    );
  }
  if (needsPolicySignoff) {
    warn(
      "route_policy",
      `Starting ${input.role} on ${profile?.id ?? "this route"} requires Spec 052 operator sign-off.`,
    );
  }

  let createdRun: Run | null = null;
  let token = "";

  return {
    warnings,
    apply() {
      const releaseChange = replacingPlan?.apply();
      const basePatch = releaseChange?.patch ?? {};
      const resolution = { ...(basePatch.resolution ?? task.resolution) };
      const runId = randomUUID();
      const head = input.head ?? task.prHead ?? task.planningCommit;
      const base = task.planningCommit;
      const generation =
        runRole === "recovery" ? task.coordinatorGeneration + 1 : 1;
      const temporaryDirectory = engine.adapter.runTemporaryDirectory?.(
        runId,
        task,
      );

      createdRun = runSchema.parse({
        id: runId,
        taskId: task.id,
        role: runRole,
        hostId: task.hostId ?? undefined,
        workspaceId: task.workspaceId ?? "",
        agentId: agentMode === "retained" ? retainedAgentId : null,
        generation,
        head,
        base,
        instruction: input.instruction ?? null,
        profile,
        profileGroup: group,
        status: "intent",
        createdAt: now(),
        lastObservedAt: null,
        idleSince: null,
        active: null,
        completion: null,
        released: false,
        ...(temporaryDirectory ? { temporaryDirectory } : {}),
      });
      token = randomBytes(24).toString("hex");
      store.setCredential(runId, token);
      store.putRun(createdRun);

      const patch: Partial<Task> = { ...basePatch, resolution };
      if (runRole === "reviewer" && input.head) {
        patch.prHead = input.head;
      }
      if (runRole === "reviewer" || runRole === "revision") {
        resolution.currentRunId = runId;
        if (runRole === "reviewer" && agentMode === "retained") {
          resolution.reviewerAgentId = retainedAgentId;
          if (profile) resolution.reviewerProfile = profile;
        }
      } else if (runRole === "recovery") {
        patch.coordinatorGeneration = generation;
        resolution.recoveryActive = true;
        resolution.recovery = {
          id: randomUUID(),
          key: digest(`explicit:${runId}`),
          generation,
          runId,
          agentId: createdRun.agentId,
          status: "running",
          summary: (input.instruction ?? input.reason).slice(0, 1000),
          idleSince: null,
          incidentId: task.resolution.incident?.id ?? null,
        };
      }
      return {
        patch,
        before: {
          replacing: releaseChange?.before ?? null,
          currentRunId: task.resolution.currentRunId,
          reviewerAgentId: task.resolution.reviewerAgentId,
          agentId: task.agentId,
          prHead: task.prHead,
        },
      };
    },
    async finish(): Promise<ExplicitFinishResult> {
      const issues: string[] = [];
      if (replacingPlan?.finish) {
        const replaced = await replacingPlan.finish();
        issues.push(...replaced.issues);
      }
      if (!createdRun) return { issues };
      const run = createdRun;
      const isRunStillOwned = () => {
        const currentRun = store.run(run.id);
        const currentTask = store.task(task.id);
        if (
          !currentRun ||
          currentRun.released ||
          currentRun.status === "superseded"
        )
          return false;
        if (runRole === "recovery")
          return currentTask.resolution.recovery?.runId === run.id;
        return currentTask.resolution.currentRunId === run.id;
      };
      if (!isRunStillOwned()) {
        issues.push(
          `Run ${run.id} was already replaced or released before delivery.`,
        );
        return { issues, runId: run.id };
      }

      const latestTask = store.task(task.id);
      const messageId = `ns-run-${run.id}`;
      const promptText = input.instruction
        ? `${input.instruction}\n\nReason: ${input.reason}`
        : `Explicit ${input.role} run ${run.id} started for task ${task.reference ?? task.id} at head ${run.head}. Reason: ${input.reason}`;
      const deliver = async () => {
        if (runRole === "reviewer") {
          await prepareReviewerCheckout(latestTask, run.head);
        }
        if (!isRunStillOwned()) {
          issues.push(
            `Run ${run.id} was already replaced or released before delivery.`,
          );
          return;
        }
        if (agentMode === "retained") {
          const sendRun = (
            engine.adapter as {
              sendRun?: (t: Task, r: Run, tok: string) => Promise<void>;
            }
          ).sendRun;
          if (typeof sendRun === "function") {
            await sendRun.call(engine.adapter, latestTask, run, token);
          } else if (engine.adapter.continueRun) {
            await engine.adapter.continueRun(run, messageId, promptText);
          } else if (engine.adapter.steerOrNotify) {
            await engine.adapter.steerOrNotify(
              run.agentId!,
              messageId,
              promptText,
            );
          } else if (engine.adapter.notify) {
            await engine.adapter.notify(run.agentId!, messageId, promptText);
          } else {
            throw Error(
              "Host adapter supports no retained run delivery method",
            );
          }
          store.transaction(() => {
            const currentRun = store.run(run.id);
            if (
              currentRun &&
              !currentRun.released &&
              currentRun.status !== "superseded"
            ) {
              store.putRun({ ...currentRun, status: "running", active: true });
            }
          });
          return;
        }
        if (!engine.adapter.createRun) {
          throw Error("Host adapter supports no fresh run creation method");
        }
        const created = await engine.adapter.createRun(latestTask, run, token);
        store.transaction(() => {
          const currentRun = store.run(run.id) ?? run;
          const currentTask = store.task(task.id);
          const stillOwned =
            !currentRun.released &&
            currentRun.status !== "superseded" &&
            (runRole === "recovery"
              ? currentTask.resolution.recovery?.runId === run.id
              : currentTask.resolution.currentRunId === run.id);
          if (!stillOwned) {
            // Fence late launch acknowledgement: preserve the created thread on the historical run only.
            store.putRun({
              ...currentRun,
              agentId: created.id,
              workspaceId: created.workspaceId ?? currentRun.workspaceId,
            });
            issues.push(
              `Run ${run.id} was replaced before launch completed; recorded late thread ${created.id} on historical run only.`,
            );
            return;
          }
          store.putRun({
            ...currentRun,
            agentId: created.id,
            workspaceId: created.workspaceId ?? currentRun.workspaceId,
            status: "running",
            active: true,
          });
          const nextResolution = { ...currentTask.resolution };
          const taskPatch: Partial<Task> = {};
          if (runRole === "reviewer") {
            nextResolution.reviewerAgentId = created.id;
            if (profile) nextResolution.reviewerProfile = profile;
            taskPatch.resolution = nextResolution;
          } else if (
            runRole === "recovery" &&
            nextResolution.recovery?.runId === run.id
          ) {
            nextResolution.recovery = {
              ...nextResolution.recovery,
              agentId: created.id,
            };
            taskPatch.coordinatorAgentId = created.id;
            taskPatch.resolution = nextResolution;
          } else if (runRole === "revision" && !currentTask.agentId) {
            taskPatch.agentId = created.id;
            taskPatch.runId = run.id;
            taskPatch.agentActive = true;
            if (created.workspaceId && !currentTask.workspaceId) {
              taskPatch.workspaceId = created.workspaceId;
            }
          }
          if (Object.keys(taskPatch).length) {
            store.update(
              task.id,
              taskPatch,
              "explicit_run_bound",
              `${run.id}:${created.id}`,
            );
          }
        });
      };
      try {
        await (run.hostId ? engine.withHost(run.hostId, deliver) : deliver());
      } catch (error) {
        const currentRun = store.run(run.id);
        if (
          currentRun &&
          !currentRun.released &&
          currentRun.status === "intent"
        ) {
          store.putRun({ ...currentRun, status: "uncertain" });
        }
        issues.push(
          `Run ${run.id} delivery could not be confirmed: ${String(error).slice(0, 500)}.`,
        );
      }
      return { issues, runId: run.id };
    },
  };
}
