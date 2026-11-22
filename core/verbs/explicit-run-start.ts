import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  authorModelKey,
  queueAuthorModelKey,
  taskAuthorModelKeys,
} from "../../shared/authors";
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
import {
  chooseProfile,
  isOwnerRoutedReviewer,
  reviewerIndependence,
} from "../dispatch/routing";
import { usageGateBlocked } from "../dispatch/usage-gate";
import type { Engine } from "../engine";
import { taskPrNumber } from "../forge/index";
import { git } from "../git/index";
import {
  commonDirMatchesTask,
  originsMatchForTask,
  readGitCheckout,
} from "../git/git-identity";
import type { Adapter } from "../host/adapter";
import {
  assertDetachedReviewViewIdentity,
  detachedReviewViewSource,
} from "../review/ordinary-review";
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

export type ExplicitRunStartPreflight = {
  forgeHead: string | null;
  workerTurnActive: boolean;
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
  const allowQueuedFallback = input.accept.includes("queued");

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
          const outcome = await engine.adapter.steerOrNotify!(
            target.agentId!,
            messageId,
            input.text,
            undefined,
            { allowQueuedFallback },
          );
          delivery = outcome === "queued" ? "queued" : "delivered";
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

function isIndependentReviewerProfile(
  task: Task,
  runs: Run[],
  profile: Profile,
): boolean {
  const modelKey = authorModelKey(profile.model);
  if (modelKey === "default") return false;
  const authors = taskAuthorModelKeys(
    task,
    runs.filter((run) => run.role === "revision"),
  );
  const currentQueueModel = queueAuthorModelKey(task);
  const currentAuthorModels =
    currentQueueModel === null ? authors : new Set([currentQueueModel]);
  const selectState = reviewerIndependence({
    site: "select",
    entrypoint: task.entrypoint,
    authors,
    currentAuthorModels,
  });
  if (selectState !== "independent") return false;
  const reviewerRequest = task.profileRequests?.reviewer;
  const explicitReviewer =
    reviewerRequest?.required === true ? reviewerRequest.profileId : undefined;
  const ownerRouted = Boolean(
    explicitReviewer && isOwnerRoutedReviewer(task, explicitReviewer),
  );
  return (
    reviewerIndependence({
      site: "profile",
      authors,
      currentAuthorModels,
      reviewerModel: modelKey,
      namedRequired: profile.id === explicitReviewer,
      ownerRouted,
    }) !== "collision"
  );
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
    if (
      role === "reviewer" &&
      profile &&
      !isIndependentReviewerProfile(task, runs, profile)
    ) {
      throw Error(
        `Retained reviewer profile ${profile.id} is not independent of the task author model`,
      );
    }
    return {
      profile,
      group: groupOf(profile),
      needsPolicySignoff: policySignoffFor(profile),
    };
  }

  if (role === "reviewer") {
    const selected = engine.resolution.select(task, "reviewer");
    let profile: Profile | null = selected?.profile ?? null;
    if (!profile && request?.profileId) {
      const requested =
        allProfiles.find((item) => item.id === request.profileId) ?? null;
      if (requested && isIndependentReviewerProfile(task, runs, requested)) {
        profile = requested;
      }
    }
    if (!profile) {
      throw Error("No independent reviewer profile is available for this task");
    }
    return {
      profile,
      group: selected?.entry.group ?? groupOf(profile),
      needsPolicySignoff: policySignoffFor(profile),
    };
  }

  let profile: Profile | null = null;
  if (role === "coordinator") {
    const selected = engine.resolution.select(task, "coordinator");
    if (selected) profile = selected.profile;
  }
  if (!profile && request?.profileId) {
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

/**
 * Every non-proof reviewer start requires a real, distinct, valid Git checkout
 * for the task. A missing, unbound or repo-aliasing checkout is always reported
 * as unavailable and never skipped.
 */
function assertReviewSourceAvailable(task: Task): void {
  if (task.entrypoint === "proof") return;
  if (!task.directory) {
    throw Error(
      "Reviewer checkout is unavailable (no task checkout directory is bound); restore or recreate the worktree before starting review",
    );
  }
  if (!task.branch || task.branch === task.baseBranch) {
    throw Error(
      `Reviewer source identity is incomplete: expected a task branch distinct from ${task.baseBranch}`,
    );
  }
  if (
    !existsSync(task.directory) ||
    !existsSync(join(task.directory, ".git")) ||
    !existsSync(task.repoPath)
  ) {
    throw Error(
      `Reviewer checkout is unavailable at ${task.directory}; restore or recreate the worktree before starting review`,
    );
  }
  const checkout = readGitCheckout(task.directory);
  const repo = readGitCheckout(task.repoPath);
  if (
    realpathSync(task.directory) === realpathSync(task.repoPath) ||
    checkout.toplevel !== realpathSync(task.directory)
  ) {
    throw Error(
      "Reviewer checkout is unavailable: task checkout aliases the repository root or is not a valid worktree",
    );
  }
  if (
    !commonDirMatchesTask(
      task,
      checkout.commonDir,
      repo.commonDir,
      task.directory,
    ) ||
    !originsMatchForTask(checkout.origin, repo.origin)
  ) {
    throw Error(
      `Reviewer repository identity changed: expected ${repo.commonDir} / ${repo.origin}, observed ${checkout.commonDir} / ${checkout.origin}`,
    );
  }
}

/**
 * Preflight reviewer source availability, forge-confirmed PR head and live
 * writer observation before the transaction creates a run. Never refuses on
 * control-actor recovery runs or live workers (live workers surface as the
 * `two_writers` warning). A PR whose forge head cannot be confirmed refuses
 * instead of falling through to an unconfirmed commit.
 */
export async function preflightExplicitRunStart(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "run.start" }>,
): Promise<ExplicitRunStartPreflight> {
  if (input.role !== "reviewer") {
    return { forgeHead: null, workerTurnActive: false };
  }
  assertReviewSourceAvailable(task);
  let forgeHead: string | null = null;
  let workerTurnActive = false;
  const probe = async () => {
    let prNumber: number | null = null;
    try {
      prNumber = taskPrNumber(task);
    } catch {
      const match = task.prUrl?.match(/\/pull\/(\d+)/);
      prNumber = match ? Number(match[1]) : null;
    }
    if (prNumber) {
      if (typeof engine.adapter.verifyPrIdentity === "function") {
        const pr = await engine.adapter.verifyPrIdentity(task, prNumber);
        if (!pr?.head) {
          throw Error(
            "Forge PR head is unavailable; cannot start review on an unconfirmed commit",
          );
        }
        forgeHead = pr.head;
      } else if (typeof engine.adapter.verifyPr === "function") {
        const pr = await engine.adapter.verifyPr(task, prNumber);
        if (!pr?.head) {
          throw Error(
            "Forge PR head is unavailable; cannot start review on an unconfirmed commit",
          );
        }
        forgeHead = pr.head;
      }
    }
    if (task.agentId && typeof engine.host?.observe === "function") {
      const state = await engine.host.observe(task.agentId).catch(() => null);
      if (state && (state.status === "running" || state.activeTurnId)) {
        workerTurnActive = true;
      }
    }
  };
  await (task.hostId ? engine.withHost(task.hostId, probe) : probe());
  return { forgeHead, workerTurnActive };
}

/**
 * Create a separate, run-owned detached Git worktree at `run.head` and register
 * its host workspace so the native reviewer launches in the detached view while
 * the worker's `task.directory`, `HEAD`, `refs/heads/<task.branch>` and working
 * files remain completely untouched through launch and settlement.
 */
async function prepareReviewerCheckout(
  engine: Engine,
  task: Task,
  run: Run,
): Promise<Run> {
  if (task.entrypoint === "proof" || !run.reviewCheckoutDirectory) return run;
  assertReviewSourceAvailable(task);
  let fetchError: unknown = null;
  if (task.branch) {
    try {
      await git(task.repoPath, "fetch", "origin", `refs/heads/${task.branch}`);
    } catch (error) {
      fetchError = error;
    }
  }
  try {
    await git(task.repoPath, "rev-parse", "--verify", `${run.head}^{commit}`);
  } catch (error) {
    if (fetchError) {
      throw Error(
        `Reviewer commit ${run.head} is unavailable after fetch failure: ${String(fetchError).slice(0, 300)}`,
      );
    }
    throw error;
  }
  if (existsSync(run.reviewCheckoutDirectory)) {
    throw Error(
      `Detached review view path already exists at ${run.reviewCheckoutDirectory}; refusing to overwrite it`,
    );
  }
  await git(
    task.repoPath,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    run.reviewCheckoutDirectory,
    run.head,
  );
  await detachedReviewViewSource(task, run.reviewCheckoutDirectory, run.head);
  if (typeof engine.adapter.createWorkspace === "function") {
    const viewTask: Task = {
      ...task,
      directory: run.reviewCheckoutDirectory,
      branch: `ns-review-${run.id.slice(0, 12)}`,
    };
    const workspace = await engine.adapter.createWorkspace(viewTask);
    if (
      workspace.directory &&
      realpathSync(workspace.directory) !==
        realpathSync(run.reviewCheckoutDirectory)
    ) {
      throw Error(
        `Host registered review workspace at ${workspace.directory}, expected ${run.reviewCheckoutDirectory}`,
      );
    }
    const updated: Run = { ...run, workspaceId: workspace.id };
    engine.store.putRun(updated);
    return updated;
  }
  return run;
}

export function runStartPlan(
  engine: Engine,
  task: Task,
  input: Extract<ExplicitResolution, { action: "run.start" }>,
  preflight?: ExplicitRunStartPreflight,
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
  if (
    input.role === "reviewer" &&
    agentMode === "retained" &&
    task.entrypoint !== "proof"
  ) {
    const priorDetached = runs.findLast(
      (r) =>
        r.role === "reviewer" &&
        r.agentId === retainedAgentId &&
        Boolean(r.reviewCheckoutDirectory),
    );
    if (
      !priorDetached?.reviewCheckoutDirectory ||
      !existsSync(priorDetached.reviewCheckoutDirectory)
    ) {
      throw Error(
        `Retained reviewer ${retainedAgentId} has no detached review checkout; use run.start reviewer fresh`,
      );
    }
  }

  const replacedRun = input.replacing ? store.run(input.replacing) : null;
  const replacedInitial = Boolean(
    input.replacing && !replacedRun && task.runId === input.replacing,
  );
  if (input.replacing && (replacedRun || replacedInitial)) {
    const replacedRole = replacedInitial
      ? "worker"
      : replacedRun!.role === "revision"
        ? "worker"
        : replacedRun!.role === "reviewer"
          ? "reviewer"
          : replacedRun!.role === "recovery"
            ? "coordinator"
            : replacedRun!.role;
    if (replacedRole !== input.role) {
      throw Error(
        `Run ${input.replacing} is a ${replacedRole} run and cannot be replaced by run.start ${input.role}`,
      );
    }
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

  const replacedAgentlessUncertain = Boolean(
    replacedRun
      ? !replacedRun.agentId &&
          !replacedRun.completion &&
          ["intent", "uncertain"].includes(replacedRun.status)
      : replacedInitial &&
          !task.agentId &&
          !task.completion &&
          task.agentIntent,
  );
  if (replacingPlan && !replacedAgentlessUncertain) {
    for (const warning of replacingPlan.warnings) {
      warn(warning.id, warning.text);
    }
  }

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
  const liveCheckoutWriters = runs.some(
    (r) =>
      (r.role === "revision" || r.role === "executor") &&
      !r.released &&
      (r.active !== false ||
        ["running", "intent", "uncertain"].includes(r.status)),
  );
  if (
    (input.role === "worker" || input.role === "reviewer") &&
    (liveCheckoutWriters || liveInitialWorker || preflight?.workerTurnActive)
  ) {
    warn(
      "two_writers",
      "Another worker or executor may still be live in this task's worktree.",
    );
  }
  const referencePrHead = preflight?.forgeHead ?? task.prHead ?? null;
  if (input.head && referencePrHead && input.head !== referencePrHead) {
    warn(
      "head_mismatch",
      `Requested head ${input.head.slice(0, 12)} differs from ${preflight?.forgeHead ? "forge PR head" : "recorded PR head"} ${referencePrHead.slice(0, 12)}.`,
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
      // For reviewers, the forge-confirmed PR head always governs placement,
      // delivery and intake even after head_mismatch is accepted.
      const head =
        runRole === "reviewer" && preflight?.forgeHead
          ? preflight.forgeHead
          : (input.head ?? task.prHead ?? task.planningCommit);
      const base = task.planningCommit;
      const generation =
        runRole === "recovery" ? task.coordinatorGeneration + 1 : 1;
      const temporaryDirectory = engine.adapter.runTemporaryDirectory?.(
        runId,
        task,
      );
      const reviewCheckoutDirectory =
        runRole === "reviewer" && task.entrypoint !== "proof" && task.directory
          ? join(dirname(task.directory), `.ns-review-${runId.slice(0, 12)}`)
          : undefined;

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
        ...(reviewCheckoutDirectory ? { reviewCheckoutDirectory } : {}),
        ...(temporaryDirectory ? { temporaryDirectory } : {}),
      });
      token = randomBytes(24).toString("hex");
      store.setCredential(runId, token);
      store.putRun(createdRun);

      const patch: Partial<Task> = { ...basePatch, resolution };
      // Only record a forge-confirmed PR head; never overwrite prHead with an
      // unconfirmed caller-supplied head.
      if (
        runRole === "reviewer" &&
        preflight?.forgeHead &&
        task.prHead !== preflight.forgeHead
      ) {
        patch.prHead = preflight.forgeHead;
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
      let activeRun = run;
      const sendGuard = {
        allowed: async () => {
          if (!isRunStillOwned()) return false;
          if (runRole === "reviewer" && activeRun.reviewCheckoutDirectory) {
            await detachedReviewViewSource(
              store.task(task.id),
              activeRun.reviewCheckoutDirectory,
              activeRun.head,
            );
          }
          return isRunStillOwned();
        },
        stillAllowed: () => {
          if (!isRunStillOwned()) return false;
          if (runRole === "reviewer" && activeRun.reviewCheckoutDirectory) {
            assertDetachedReviewViewIdentity(
              store.task(task.id),
              activeRun.reviewCheckoutDirectory,
              activeRun.head,
            );
          }
          return true;
        },
      };

      const deliver = async () => {
        if (runRole === "reviewer" && agentMode === "fresh") {
          activeRun = await prepareReviewerCheckout(engine, latestTask, run);
        } else if (runRole === "reviewer" && agentMode === "retained") {
          const priorForAgent = store
            .runs(task.id)
            .findLast(
              (r) =>
                r.id !== run.id &&
                r.role === "reviewer" &&
                r.agentId === run.agentId &&
                Boolean(r.reviewCheckoutDirectory),
            );
          if (
            !priorForAgent?.reviewCheckoutDirectory ||
            !existsSync(priorForAgent.reviewCheckoutDirectory)
          ) {
            throw Error(
              `Retained reviewer ${run.agentId} is not bound to an existing detached review view; use run.start reviewer fresh`,
            );
          }
          await detachedReviewViewSource(
            latestTask,
            priorForAgent.reviewCheckoutDirectory,
            run.head,
          );
          activeRun = {
            ...run,
            workspaceId: priorForAgent.workspaceId,
            reviewCheckoutDirectory: priorForAgent.reviewCheckoutDirectory,
          };
          store.putRun(activeRun);
        }
        const deliveryTask =
          runRole === "reviewer" && activeRun.reviewCheckoutDirectory
            ? { ...latestTask, directory: activeRun.reviewCheckoutDirectory }
            : latestTask;
        if (!isRunStillOwned()) {
          issues.push(
            `Run ${run.id} was already replaced or released before delivery.`,
          );
          return;
        }
        if (agentMode === "retained") {
          const sendRun = (
            engine.adapter as Adapter & {
              sendRun?: (
                t: Task,
                r: Run,
                tok: string,
                context?: unknown,
                ownerContext?: unknown,
                guard?: {
                  allowed: () => Promise<boolean>;
                  stillAllowed: () => boolean;
                },
              ) => Promise<void>;
            }
          ).sendRun;
          if (typeof sendRun !== "function") {
            throw Error(
              "Host adapter supports no authenticated retained run delivery method (sendRun)",
            );
          }
          await sendRun.call(
            engine.adapter,
            deliveryTask,
            activeRun,
            token,
            null,
            null,
            sendGuard,
          );
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
        const created = await engine.adapter.createRun(
          deliveryTask,
          activeRun,
          token,
          null,
          null,
          runRole === "reviewer" && activeRun.reviewCheckoutDirectory
            ? sendGuard
            : undefined,
        );
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
