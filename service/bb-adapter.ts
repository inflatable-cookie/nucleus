import { isHostOperationTimeout } from "../core/host/errors";
import { HostPolicies } from "../core/host/host-policies";
import type { Adapter, HostPolicyConstructor } from "../core/host";
import {
  ArchiveNotDeliveredError,
  ProvenPreSendRefusalError,
} from "../core/host";
import { taskWorkspaceTitle } from "../core/workspaces/workspace-title";
import type {
  HostAgentSpec,
  HostPermissionDecision,
  HostWorkspaceRef,
  HostWorkspaceSpec,
} from "../shared/host";
import { isOperatorOrigin, taskOwner, type Profile } from "../shared/contracts";
import { repositoryLabel } from "../shared/repository-label";
import type { Task, Run } from "../shared/contracts";
import { runTicketPath } from "../core/dispatch/agent-creation";
import { runTemporaryEnvironment } from "../core/workspaces/run-scratch";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import { parseAgentId } from "../shared/agent-identity";
import { join } from "node:path";
import {
  bbVocabulary,
  BbThreads,
  emptyBbThreadState,
  type BbThreadState,
  type BbWorkspaceRecord,
} from "../hosts/bb";
import type { Store } from "../core/store/store";
import { createStoreWorkspaceAllocationBridge } from "../core/workspaces/workspace-allocation-bridge";
import type {
  HostOperationName,
  HostOperationOutcome,
} from "../shared/host-operation";

export interface BbWorkspaces
  extends Pick<
    Adapter,
    | "createWorkspace"
    | "findWorkspaces"
    | "workspaceAvailable"
    | "workspaceIdAccepted"
    | "taskWorkspaceArchived"
  > {
  workspaceRef(id: string): HostWorkspaceRef;
  repositoryProject(
    root: string,
  ): Promise<{ projectId?: string; workspaceRoot: string }>;
}

/** Compose core's worktree, launch/ticket and forge policies with BB's native operations. */
export function composeBbAdapter(input: {
  hostId: string;
  connected(): boolean;
  dataDir: string;
  store: Store;
  workspaces: BbWorkspaces;
  operation(
    op: HostOperationName,
    value: unknown,
  ): Promise<HostOperationOutcome>;
  notSent(error: unknown): boolean;
  records(): Record<string, BbWorkspaceRecord>;
  put(record: BbWorkspaceRecord): void;
}): Adapter {
  const { workspaces, store, hostId } = input;
  async function nativeWorkspaceThreads() {
    const rows = await threads.inventoryRows();
    const handles = Object.values(input.records());
    return rows.map((row) => {
      const workspace = handles.find(
        (w) =>
          w.environmentId === row.environmentId &&
          w.directory === row.environmentPath,
      );
      return {
        id: row.threadId,
        workspaceId: workspace?.id ?? null,
        labels: threads.agents().find((a) => a.id === row.threadId)?.labels,
        archived: row.archivedAt !== null,
        status: row.archivedAt !== null ? "closed" : row.status,
        activeTurn:
          ["pending", "active", "starting", "stopping"].includes(row.status) ||
          ["provisioning", "waiting-for-host"].includes(row.displayStatus) ||
          row.queuedWork === "waiting"
            ? {}
            : null,
        pendingPermissionKinds: row.interactions
          .filter((i) => ["pending", "resolving"].includes(i.status))
          .map((i) => i.kind),
      };
    });
  }
  const helperPath = join(input.dataDir, "worker-report.mjs");
  const threads = new BbThreads({
    hostId,
    operation: input.operation,
    helperPath,
    ticketPath: (id) => runTicketPath({ helperPath }, id),
    state: () =>
      store.getMeta<BbThreadState>("bbThreads") ?? emptyBbThreadState(),
    save: (state) => store.setMeta("bbThreads", state),
    workspace: (id) => input.records()[id],
    putWorkspace: input.put,
    notSent: input.notSent,
    // One task reference for every BB title (nucleus#1313, Tom 2026-11-17): the
    // repository the task works on plus its unpadded number, `poodle-lab#29`. A
    // task's planner may live in another project and one Nucleus project spans
    // repositories, so a bare number says nothing about what the threads work on.
    reference(taskId) {
      const task = store.task(taskId);
      const name = repositoryLabel(task);
      return task.number === null ? name : `${name}#${task.number}`;
    },
    parent(taskId) {
      // nucleus#1313 (Tom, 2026-11-17): nesting is conditional on the planner
      // living on *this* BB host. A detached task, a planner on another host (T3,
      // Paseo) or a task with no planner at all dispatches as a standalone
      // top-level group; questions still route to the task's real planner ladder,
      // never to a BB thread just because the task runs here.
      const task = store.task(taskId);
      if (task.presentationParent)
        return task.presentationParent.parentThreadId;
      if (task.presentationDetached) return null;
      // The first rung the task's questions climb (`plannerRungsFor`): the planner
      // the brief named, else its owner — the thread that submitted or promoted it —
      // else the project's planner. Presentation follows that one thread and no
      // other, so it never names a BB planner the ladder would not ask first.
      const own =
        task.plannerAgentId ||
        (isOperatorOrigin(taskOwner(task)) ? null : taskOwner(task));
      const planner =
        own ||
        store.projectPlannerRecipient(
          store.projectFor(task.repoPath, task.repository),
        );
      const identity = planner && parseAgentId(planner);
      return identity && identity.hostId === hostId
        ? identity.nativeAgentId
        : null;
    },
  });
  class BbAdapter extends (HostPolicies as unknown as HostPolicyConstructor) {
    readonly hostId = hostId;
    readonly vocabulary = bbVocabulary;
    readonly helperPath = helperPath;
    readonly socketPath = join(input.dataDir, "callback.sock");
    readonly reportingViaMcp = false;
    readonly supportsCoordinatorRecovery = true;
    readonly admissionLaunchEnv = {};
    readonly testPlacement = undefined;
    /** Repository scratch namespaces, so a BB run's leaf follows the repository's setting. */
    scratchNamespaceFor = (task: Task) => store.scratchNamespaceFor(task);
    workspaceAllocationBridge = createStoreWorkspaceAllocationBridge(store);
    isConnected() {
      return input.connected();
    }
    capabilities() {
      return {
        reportingViaMcp: false,
        supportsCoordinatorRecovery: true,
        nativeDecisions: false,
        lifecycleDispatch: true,
        perThreadEnvironment: false,
        repositorySharedWorkspaces: false,
      };
    }
    creationOwner() {
      return {
        ...super.creationOwner(),
        perThreadEnvironment: false as const,
        prepareRunScratch: true,
      };
    }
    nativeAgentCreate(spec: HostAgentSpec, mcp: boolean) {
      if (!input.dataDir || mcp)
        throw new ProvenPreSendRefusalError(
          "BB dispatch requires helper reporting",
        );
      // BB cannot hand a provider a per-thread environment, so the service creates
      // the run's recorded scratch leaf before the thread exists (nucleus#1315,
      // beside #1314's launch-path creation): it is owner-only, follows the
      // repository's namespace, and proves its volume before it exists. A run
      // whose scratch cannot be proved is refused before anything is spawned.
      const labels = spec.attempt(false, false).labels;
      const taskId = labels[WIRE_LABEL_KEYS.task],
        runId = labels[WIRE_LABEL_KEYS.run];
      const task = taskId ? store.task(taskId) : null;
      if (task && runId) {
        try {
          runTemporaryEnvironment(
            runId,
            this.scratchPlacement(task),
            store.run(runId)?.temporaryDirectory,
          );
        } catch (error) {
          throw new ProvenPreSendRefusalError(
            `BB run scratch is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return threads.createAgent(spec);
    }
    unsupportedMcp() {
      return false;
    }
    get workspaceHost() {
      return {
        workspaceInventory: async () =>
          Object.values(input.records())
            .filter((w) => !w.archivedAt)
            .map((w) => ({
              id: w.id,
              projectRootPath: w.directory,
              workspaceDirectory: w.directory,
              placement: {
                kind: "external",
                provenance: "bb",
              },
            })),
        repositoryProject: (root: string) => workspaces.repositoryProject(root),
        createWorkspace: (spec: HostWorkspaceSpec) =>
          workspaces.createWorkspace({
            directory: spec.directory,
            repoPath: spec.project?.workspaceRoot ?? spec.directory,
            title: spec.title,
          } as Task),
        workspaceRef: (id: string) => workspaces.workspaceRef(id),
        workspaceIdAccepted: workspaces.workspaceIdAccepted,
        createCloseoutWorkspace: async () => {
          throw new ProvenPreSendRefusalError(
            "BB closeout workspace registration is unavailable",
          );
        },
        archiveThreadPage: async (options: {
          filter: { includeArchived: boolean };
        }) => {
          const rows = await nativeWorkspaceThreads();
          return {
            entries: rows
              .filter((r) => options.filter.includeArchived || !r.archived)
              .map((r) => ({
                agent: {
                  ...r,
                  archivedAt: r.archived ? true : null,
                  pendingPermissions: r.pendingPermissionKinds,
                },
              })),
            pageInfo: { hasMore: false, nextCursor: null },
          };
        },
        workspaceThreads: async (ids: readonly string[]) => ({
          ok: true as const,
          threads: (await nativeWorkspaceThreads()).filter(
            (r) => r.workspaceId && ids.includes(r.workspaceId),
          ),
        }),
        workspaceTerminals: async () => ({
          ok: false as const,
          reason: "BB terminal inventory is not a lifecycle fact",
        }),
        activeThreads: async () =>
          (await nativeWorkspaceThreads()).filter((r) => r.activeTurn),
      };
    }
    get messageHost() {
      return {
        retainedAgentRef: (id: string) => {
          let observed: Awaited<ReturnType<BbThreads["observe"]>> | null = null;
          return {
            get workspaceId() {
              return observed?.workspaceId ?? null;
            },
            get archivedAt() {
              return observed?.status === "closed" ? true : null;
            },
            get status() {
              return observed?.status ?? null;
            },
            get activeTurn() {
              return observed?.active ? {} : null;
            },
            get pendingPermissions() {
              return observed?.pendingPermissionKinds ?? null;
            },
            get runtimeInfo() {
              return observed
                ? {
                    provider: observed.provider,
                    model: observed.model,
                    modeId: observed.modeId,
                    thinkingOptionId: observed.thinkingOptionId,
                  }
                : null;
            },
            refresh: async () => {
              observed = await threads.observe(id);
              return observed;
            },
            current: () => observed,
            send: async (text: string, options: { messageId: string }) =>
              threads.send(id, text, options.messageId),
          };
        },
      };
    }
    notify(id: string, messageId: string, text: string) {
      return threads.deliver(id, text, messageId);
    }
    /** A participant message steers a live turn; a proven not-sent steer falls back to one queued send. */
    steerOrNotify(id: string, messageId: string, text: string) {
      return threads.steerOrNotify(id, text, messageId);
    }
    pendingQuestions(id: string) {
      return threads.pendingQuestions(id);
    }
    async answerNativeQuestion(
      agent: string,
      workspace: string,
      requestId: string,
      answers: Record<string, string>,
    ) {
      this.requireQuestionThread(agent, workspace);
      await threads.answerQuestion(agent, requestId, answers);
    }
    async answerNativePermission(
      agent: string,
      workspace: string,
      requestId: string,
      decision: HostPermissionDecision,
      intentId: string,
    ) {
      this.requireQuestionThread(agent, workspace);
      await threads.answerPermission(agent, requestId, decision, intentId);
    }
    async dismissNativeQuestion(
      agent: string,
      workspace: string,
      requestId: string,
    ) {
      this.requireQuestionThread(agent, workspace);
      await threads.dismissQuestion(agent, requestId);
    }
    /** The thread and its workspace are proven before anything is written. */
    private requireQuestionThread(agent: string, workspace: string) {
      const recorded = threads.recordedAgent(agent);
      if (!recorded || recorded.workspaceId !== workspace)
        throw new ProvenPreSendRefusalError(
          "Question thread identity or workspace changed",
        );
    }
    /** The planner ask is one queued send; its answer arrives through the relayed reply, not chat output. */
    async askPlanner(
      planner: string,
      ask: {
        prompt: string;
        signal: AbortSignal;
        timeoutMs: number;
        messageId: string;
        sourceAgentId?: string;
      },
    ) {
      if (ask.signal.aborted)
        throw new ProvenPreSendRefusalError(
          "The ask was abandoned before delivery",
        );
      await threads.deliver(planner, ask.prompt, ask.messageId);
      return null;
    }
    async askReviewer(
      reviewer: string,
      ask: {
        prompt: string;
        signal: AbortSignal;
        timeoutMs: number;
        messageId: string;
        sourceAgentId?: string;
      },
    ) {
      if (ask.signal.aborted)
        throw new ProvenPreSendRefusalError(
          "The ask was abandoned before delivery",
        );
      await threads.deliver(reviewer, ask.prompt, ask.messageId);
      return null;
    }
    /** A short-lived decider thread in the task worktree; core delivers the question and archives it. */
    async runDecider(
      task: Task,
      ask: {
        profile: Profile;
        signal: AbortSignal;
        timeoutMs: number;
        decisionId: string;
      },
    ) {
      if (ask.signal.aborted)
        throw new ProvenPreSendRefusalError(
          "The decider was abandoned before creation",
        );
      if (!task.workspaceId)
        throw new ProvenPreSendRefusalError(
          "BB decider needs the task workspace",
        );
      const created = await threads.createSupportThread({
        task: task.id,
        workspaceId: task.workspaceId,
        role: "decider",
        key: `decider-${ask.decisionId}`,
        title: `${this.taskReference(task)} decider: ${task.title}`,
        profile: ask.profile,
      });
      return { agentId: created.id, text: null };
    }
    /** A consult reviewer keeps BB's one-worktree-per-task shape and is archived at closeout. */
    async createConsultReviewer(
      task: Task,
      consult: { profile: Profile; id: string },
    ) {
      if (!task.workspaceId)
        throw new ProvenPreSendRefusalError(
          "BB consult reviewer needs the task workspace",
        );
      const created = await threads.createSupportThread({
        task: task.id,
        workspaceId: task.workspaceId,
        role: "reviewer",
        key: `consult-${consult.id}`,
        title: `${this.taskReference(task)} reviewer: ${task.title}`,
        profile: consult.profile,
      });
      return { id: created.id, workspaceId: created.workspaceId };
    }
    findWorkspaces = (task: Task) => workspaces.findWorkspaces(task);
    workspaceAvailable(id: string) {
      return workspaces.workspaceAvailable!(id);
    }
    workspaceIdAccepted(id: unknown) {
      return workspaces.workspaceIdAccepted!(id);
    }
    taskWorkspaceArchived(id: string) {
      return workspaces.taskWorkspaceArchived!(id);
    }
    findAgents(task: Task) {
      return task.runId
        ? threads.findAgents(task.id, task.runId)
        : Promise.resolve([]);
    }
    findRunAgents(run: Run) {
      return threads.findAgents(run.taskId, run.id);
    }
    /** Listing only: BB has no thread removal yet, so the retention pass counts these and prunes none. */
    archivedThreads() {
      return threads.archivedThreads();
    }
    async listLiveAgents() {
      const rows = await threads.inventoryRows();
      const known = threads.agents();
      const workspaces = Object.values(input.records());
      return rows
        .filter((row) => row.archivedAt === null && row.status !== "closed")
        .map((row) => {
          const workspace = workspaces.find(
            (w) =>
              w.environmentId === row.environmentId &&
              w.directory === row.environmentPath,
          );
          return {
            id: row.threadId,
            title: row.title ?? "",
            workspaceId: workspace?.id ?? null,
            directory: row.environmentPath,
            repositoryRoot: workspace?.repositoryRoot ?? null,
            updatedAt: Number.isFinite(row.updatedAt)
              ? new Date(row.updatedAt).toISOString()
              : null,
            labels: known.find((agent) => agent.id === row.threadId)?.labels,
          };
        });
    }
    observe(id: string) {
      return threads.observe(id);
    }
    observationInventory(ids: readonly string[]) {
      return threads.observationInventory(ids);
    }
    async originAgent(id: string) {
      const { observation, environmentId } = await threads.origin(id);
      // A planner thread Nucleus did not create has no recorded workspace handle,
      // but it does run in a BB environment, and naming it as a task's new owner
      // needs a workspace on the owner record (T3 answers its project scope the
      // same way). Task threads keep their recorded handle.
      const workspaceId =
        observation.workspaceId ??
        (environmentId ? `bb-environment:${environmentId}` : null);
      return {
        id,
        workspaceId,
        title: "",
        archived: observation.status === "closed",
        labels: observation.labels,
      };
    }
    stopAgentTurn(id: string, expectedTurnId?: string) {
      return expectedTurnId !== undefined
        ? threads.stopAgentTurn(id, expectedTurnId)
        : threads.stopAgentTurn(id);
    }
    archiveAgent(id: string) {
      // A refusal the adapter or the plugin proves before its write is a not-delivered
      // archive, so the durable effect stays ready instead of reading as uncertain.
      return threads.archiveAgent(id).catch((error) => {
        if (input.notSent(error) || error instanceof ProvenPreSendRefusalError)
          throw new ArchiveNotDeliveredError(error);
        throw error;
      });
    }
    catalog() {
      return threads.catalog();
    }
    async profiles() {
      return [];
    }
    agentTimelinePage(id: string) {
      return threads.timeline(id);
    }
    async agentTimeline(id: string) {
      try {
        return (await threads.timeline(id)).entries;
      } catch {
        return null;
      }
    }
    /**
     * nucleus#1313 (Tom, 2026-11-17, live trial): while the worker is the task's only
     * thread it keeps the phase-prefixed title; once the task's container holds a
     * second participant it is named by role like the reviewer (`#29 worker: <title>`)
     * and the phase lives on the container's state line alone. Thread titles and the
     * container row share one number style, `#29`, never the padded `029`.
     */
    async setTaskWorkspaceTitle(
      task: Task,
      _title: string,
      requestId: string,
      _uncertain: boolean,
    ) {
      if (!task.agentId) return;
      const step = await this.step(task);
      const reference = this.taskReference(task);
      // The container is the threads sharing this environment, so an archived
      // participant no longer counts (item 12): a lone live worker goes back to its
      // phase-prefixed title once its reviewer is archived.
      const grouped = (await this.liveParticipants(task)) > 1;
      const roleNamed =
        grouped && task.number !== null
          ? `${reference} worker: ${task.title}`
          : null;
      const text =
        `${roleNamed ?? taskWorkspaceTitle(task, undefined, reference)}${step ? ` · ${step}` : ""}`.slice(
          0,
          200,
        );
      await threads.title(task.agentId, text, requestId);
    }
    /** This task's recorded threads that are still visible: an archived one is no participant. */
    private async liveParticipants(task: Task): Promise<number> {
      let live = 0;
      for (const agent of threads
        .agents()
        .filter((agent) => agent.task === task.id)) {
        try {
          if ((await threads.observe(agent.id)).status !== "closed") live += 1;
        } catch (error) {
          if (isHostOperationTimeout(error)) throw error;
          live += 1; /* an unreadable thread is still recorded; never flip the title on a failed read */
        }
      }
      return live;
    }
    /**
     * The task's recorded participant threads whose run settled and which no current
     * binding names any more (nucleus#1313, item 12). Superseded, not merely idle: a
     * role whose run is still unreleased, or whose identity the task still binds, is
     * current and stays.
     */
    private supersededParticipants(task: Task): string[] {
      const runs = new Map(store.runs(task.id).map((run) => [run.id, run]));
      const bindings = new Set<string | null>([
        task.agentId,
        task.runId,
        task.coordinatorAgentId,
        task.resolution.reviewerAgentId,
        task.resolution.currentRunId,
        task.resolution.recovery?.agentId ?? null,
        task.resolution.recovery?.runId ?? null,
      ]);
      const expired: string[] = [];
      for (const agent of threads
        .agents()
        .filter((agent) => agent.task === task.id)) {
        const run = runs.get(agent.run);
        // Only a settled run is superseded; support threads keep their own closeout.
        if (!run?.released || !run.agentId) continue;
        if (bindings.has(agent.id) || bindings.has(agent.run)) continue;
        expired.push(agent.id);
      }
      return expired;
    }
    /** The one reference every BB title and support thread names. */
    private taskReference(task: Task) {
      const name = repositoryLabel(task);
      return task.number === null ? name : `${name}#${task.number}`;
    }
    private async step(task: Task) {
      const participants = store
        .runs(task.id)
        .filter((r) => !r.released && r.agentId && r.role !== "revision");
      for (const run of participants) {
        const observation = await threads.observe(run.agentId!);
        if (observation.permissions) return `${run.role} needs input`;
        if (observation.error) return `blocked: ${run.role}`;
        if (observation.active)
          return run.role === "reviewer" ? "reviewing" : run.role;
      }
      if (task.agentId) {
        const worker = await threads.observe(task.agentId);
        if (worker.permissions) return "worker needs input";
        if (worker.error) return "blocked: worker";
      }
      return "";
    }
    async reconcileThreadTitles(tasks: readonly Task[]) {
      for (const task of tasks) {
        // BB's parent link is presentation: a reparented task moves each of its own
        // threads under the new planner, observation first and once per parent.
        if (task.agentId) {
          try {
            await threads.reparentTaskThreads(task.id, threads.parent(task.id));
          } catch (error) {
            if (isHostOperationTimeout(error)) throw error;
            /* an unreadable or unknown write is retried only by observation on the next sweep */
          }
        }
        // BB keeps released support roles visible, but a replaced worker is owed
        // archive as soon as its run and native turn have both ended.
        for (const retired of task.retiredWorkers) {
          if (store.unreleasedRunsForAgent(retired.agentId, hostId).length)
            continue;
          try {
            await threads.archiveAgent(retired.agentId);
          } catch (error) {
            if (isHostOperationTimeout(error)) throw error;
            /* The durable intent and fresh turn/cascade reads govern the next sweep. */
          }
        }
        // nucleus#1313 (Tom, 2026-11-17, live trial): a superseded participant leaves
        // the container. Replacing a reviewer, recovery or coordinator run otherwise
        // left every earlier thread drawn as though it were current; each is archived
        // once its own run is settled, it is bound by nothing, and its turn is proved
        // idle. A live or pending-interaction thread is never archived, and the
        // archive's own cascade proof still refuses anything this task does not own.
        for (const superseded of this.supersededParticipants(task)) {
          try {
            // Never archive a thread that is still working or waiting on the operator.
            const observed = await threads.observe(superseded);
            if (observed.active || observed.permissions) continue;
            await threads.archiveAgent(superseded);
          } catch (error) {
            if (isHostOperationTimeout(error)) throw error;
            /* A live turn or unknown delivery is observed again on the next sweep. */
          }
        }
        if (!task.agentId || task.phase === "done") continue;
        try {
          const title = taskWorkspaceTitle(
            task,
            undefined,
            this.taskReference(task),
          );
          await this.setTaskWorkspaceTitle(
            task,
            title,
            `${task.id}:${task.version}`,
            false,
          );
        } catch (error) {
          if (isHostOperationTimeout(error)) throw error;
          /* An unreadable row or unknown write is observation-only on the next sweep. */
        }
      }
    }
  }
  return new BbAdapter() as unknown as Adapter;
}
