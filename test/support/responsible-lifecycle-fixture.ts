import { answerFixturePrompt } from "./delegated-reply";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Engine } from "../../core/engine";
import { Store, digest } from "../../core/store/store";
import { reviewPublicationBody } from "../../core/forge/index";
import {
  submissionSchema,
  type Completion,
  type PoolEntry,
  type Profile,
  type Run,
} from "../../shared/contracts";
import type { Adapter, AgentObservation } from "../../core/host";
import type { Task as ParameterTask } from "../../shared/contracts";
import { toolTimelinePage } from "./tool-timeline";

/**
 * The ordinary responsible-lifecycle fixture (Spec 058): a responsible task at its
 * first review, the real dispatch and callback path, and a task thread whose
 * native question is presented with a permission id and answered by the caller.
 * Shared by the lifecycle suite and the nucleus_ask suite.
 */

export const head = "a".repeat(40),
  base = "b".repeat(40);

/**
 * `provider` (Spec 058 task 550) sets every profile's provider: 'codex' is the one
 * provider with a native Paseo question surface, so the default fixtures exercise
 * the native-question path; any other provider (a pi worker) has none, and Queue
 * delivers its questions through `nucleus_ask` instead.
 */
export const profile = (
  id: string,
  model: string,
  provider = "codex",
): Profile => ({
  id,
  name: id,
  model,
  provider,
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
});

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * `delegates` (Spec 058 task 540) opts the fixture into delegated answers: the planner and the decider
 * reply with the given text (null = no usable answer), and the task thread presents its native question
 * with a permission id, so a delegate's answer resolves that question as Paseo does.
 */
export function fixture(
  options: {
    responsible?: boolean;
    provider?: string;
    hostId?: string;
    delegates?: {
      planner?: string | null;
      plannerArchived?: boolean;
      plannerClosed?: boolean;
      plannerMissing?: boolean;
      decider?: string | null;
      deciderError?: string;
    };
  } = {},
) {
  const provider = options.provider ?? "codex";
  const hostId = options.hostId ?? "host";
  const dir = mkdtempSync(join(tmpdir(), "ns-responsible-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const profiles = ["author", "higher", "reviewer", "coordinator"].map((id) =>
    profile(id, id, provider),
  );
  const [author, higher, reviewer, coordinator] = profiles;
  const pool: PoolEntry[] = [
    {
      profileId: author.id,
      enabled: true,
      group: "author",
      roles: ["worker"],
      scopes: ["general"],
      weight: 1,
      capability: "low",
    },
    {
      profileId: higher.id,
      enabled: true,
      group: "higher",
      roles: ["worker"],
      scopes: ["general"],
      weight: 1,
      capability: "medium",
    },
    {
      profileId: reviewer.id,
      enabled: true,
      group: "review",
      roles: ["reviewer"],
      scopes: ["general"],
      weight: 1,
      capability: "medium",
      cost: "low",
    },
    {
      profileId: coordinator.id,
      enabled: true,
      group: "coordinate",
      roles: ["coordinator"],
      scopes: ["general"],
      weight: 1,
      capability: "low",
      cost: "very_low",
    },
  ];
  store.setMeta("pool", pool);
  store.setMeta("demandRoleOffsets", {
    worker: -1,
    reviewer: 0,
    coordinator: -2,
  });
  store.setMeta("paused", false);
  // #912: the single registered host ingress and delegated routing select.
  store.setMeta("hostId", hostId);
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Responsible lifecycle",
      repoPath: join(dir, "repo"),
      planningCommit: base,
      brief: { text: "Responsible lifecycle brief\n" },
      originAgentId: "origin",
      ...(options.responsible === undefined
        ? {}
        : { responsible: options.responsible }),
    }),
    hostId,
    "brief",
    base,
  );
  store.update(
    submitted.id,
    {
      phase: "awaiting_review",
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: "workspace",
      directory: join(dir, "worktree"),
      agentId: "worker",
      runId: "initial",
      profile: author,
      workerModel: author.model,
      workerModels: [author.model],
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/1",
      completion: {
        taskId: submitted.id,
        runId: "initial",
        eventId: "initial",
        status: "ready_for_review",
        summary: "Ready",
        prNumber: 1,
        head,
      },
    },
    "dispatched",
  );

  const states = new Map<string, AgentObservation>(),
    tokens = new Map<string, string>();
  const archivedAgents = new Set<string>();
  let remoteHead = head;
  const creates: Run[] = [],
    sends: Run[] = [];
  const asks: { id: string; question: string; options: string[] }[] = [];
  const prompts: { agentId: string; messageId: string; text: string }[] = [];
  const delegated = {
    planner: [] as { agentId?: string; prompt: string; sourceAgentId?: string }[],
    deciders: [] as { prompt: string; profile: string }[],
    archived: [] as string[],
    answers: [] as { requestId: string; header: string; answer: string }[],
  };
  let answerAsk: ((value: string) => void) | null = null;
  let rejectAsk: ((error: Error) => void) | null = null;
  let mergeCalls = 0;
  const idle = (id: string) =>
    states.set(id, {
      id,
      workspaceId: states.get(id)?.workspaceId ?? "workspace",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      provider,
      model: states.get(id)?.model,
    });
  idle("worker");
  const adapter = {
    // #912: the single host this fixture registers; Resolution identifies origin hosts from it.
    hostId,
    profiles: async () => profiles,
    validate: async () => base,
    verifyWorkspace: async () => submitted.branch,
    createWorkspace: async () => {
      throw Error("fixtures do not create workspaces");
    },
    findWorkspaces: async () => [],
    findAgents: async () => [],
    findRunAgents: async () => [],
    createAgent: async () => {
      throw Error("fixtures do not create the initial agent");
    },
    createRun: async (_task: ParameterTask, run: Run, token: string) => {
      creates.push(run);
      tokens.set(run.id, token);
      const id = `agent-${run.id}`;
      idle(id);
      states.set(id, {
        ...states.get(id)!,
        status: "running",
        active: true,
        model: run.profile?.model,
      });
      return { id, workspaceId: run.workspaceId };
    },
    sendRun: async (_task: ParameterTask, run: Run, token: string) => {
      sends.push(run);
      tokens.set(run.id, token);
      states.set(run.agentId!, {
        ...states.get(run.agentId!)!,
        status: "running",
        active: true,
      });
    },
    observe: async (id: string) =>
      states.get(id) ?? {
        id,
        workspaceId: "workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      },
    originAgent: async (id: string) => ({
      id, workspaceId: states.get(id)?.workspaceId ?? "workspace", title: id, archived: archivedAgents.has(id),
    }),
    archiveAgent: async (id: string) => {
      archivedAgents.add(id);
      const state = states.get(id);
      if (state) states.set(id, { ...state, status: "closed", active: false });
    },
    notify: async (agentId: string, messageId: string, text: string) => {
      prompts.push({ agentId, messageId, text });
    },
    verifyPr: async () => ({
      head: remoteHead,
      url: "https://github.com/example/repo/pull/1",
      repository: "example/repo",
      headRepository: "example/repo",
    }),
    coveringEvidence: async (t: ParameterTask) => ({ head: t.prHead!, base: t.resolution.mergeBase ?? t.planningBase, wait: '' }),
    verifyPrIdentity: async () => ({
      head: remoteHead,
      url: "https://github.com/example/repo/pull/1",
      repository: "example/repo",
      headRepository: "example/repo",
    }),
    verifyResume: async () => {},
    verifyCleanQueueWorktree: async () => {},
    verifyReview: async () => {},
    verifyContinuedProgress: async (
      _task: ParameterTask,
      _number: number,
      expected: string,
    ) => {
      if (expected !== remoteHead) throw Error("progress source changed");
    },
    agentTimelinePage: async () => toolTimelinePage([]),
    publishReview: async (
      publicationStore: Store,
      task: ParameterTask,
      run: Run,
      status: string,
      text: string,
    ) => {
      const hash = digest(
        reviewPublicationBody(
          task,
          run,
          status,
          text,
          publicationStore.run(run.id)?.completion?.verdicts ?? [],
        ),
      );
      const id = creates.filter((item) => item.role === "reviewer").length;
      publicationStore.setMeta(`reviewPublication:${run.id}`, {
        hash,
        commentId: id,
      });
      return id;
    },
    mergeGate: async () => ({ head: remoteHead, base, wait: "" }),
    merged: async () => ({
      merged: false,
      commit: null,
      head: remoteHead,
      base: "main",
    }),
    merge: async () => {
      mergeCalls++;
    },
    syncMain: async () => base,
    verifyCloseout: async () => {},
    continueReviewer: async () => ({ sent: true as const }),
    raiseTaskDecision: async (
      _task: ParameterTask,
      input: {
        id: string;
        question: string;
        options: string[];
        signal: AbortSignal;
        onRequested?: (request: { requestId: string; header: string }) => void;
      },
    ) => {
      asks.push({
        id: input.id,
        question: input.question,
        options: input.options,
      });
      input.onRequested?.({
        requestId: `req-${input.id}`,
        header: "Question 1",
      });
      return await new Promise<string>((resolve, reject) => {
        answerAsk = resolve;
        rejectAsk = reject;
        input.signal.addEventListener(
          "abort",
          () => reject(Error("observation cancelled")),
          { once: true },
        );
      });
    },
  } as unknown as Adapter & { supportsCoordinatorRecovery?: boolean };
  adapter.supportsCoordinatorRecovery = true;
  if (options.delegates) {
    const delegates = options.delegates;
    Object.assign(adapter, {
      originAgent: async (id: string) => {
        if (id === 'planner-1' && delegates.plannerMissing) return null;
        return { id, workspaceId: 'workspace', title: id, archived: archivedAgents.has(id) || (id === 'planner-1' && delegates.plannerArchived === true) };
      },
      askPlanner: async (planner: string, input: { prompt: string }) => {
        if (planner === 'decider-1') { delegated.deciders.at(-1)!.prompt = input.prompt; return delegates.decider ?? null; }
        delegated.planner.push({ agentId: planner, prompt: input.prompt });
        return delegates.planner ?? null;
      },
      runDecider: async (
        _task: ParameterTask,
        input: { profile: Profile },
      ) => {
        delegated.deciders.push({
          prompt: "",
          profile: input.profile.id,
        });
        if (delegates.deciderError) throw Error(delegates.deciderError);
        return { agentId: "decider-1", text: delegates.decider ?? null };
      },
      answerTaskDecision: async (
        _task: ParameterTask,
        input: { requestId: string; header: string; answer: string },
      ) => {
        delegated.answers.push(input);
        if (answerAsk) {
          answerAsk(input.answer);
          answerAsk = null;
          rejectAsk = null;
        }
      },
    });
    const archive = adapter.archiveAgent;
    adapter.archiveAgent = async (id: string) => {
      delegated.archived.push(id);
      return archive(id);
    };
    if (delegates.plannerClosed) {
      const observe = adapter.observe;
      adapter.observe = async (id: string) => id === 'planner-1'
        ? { id, workspaceId: 'workspace', status: 'closed', active: false, permissions: false, error: '' }
        : observe(id);
    }
  }
  const boundAdapter = new Proxy(adapter, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (key === "askPlanner" || key === "askReviewer") return async (recipient: string, input: { prompt: string }) => answerFixturePrompt(engine.resolution, recipient, input.prompt, await value(recipient, input));
      if (key === "runDecider") return async (task: unknown, input: unknown) => {
        const result = await value(task, input);
        if (options.delegates?.decider) engine.resolution.delegatedAnswerWaitMs = 1000;
        return { ...result, text: null };
      };
      return value;
    },
  });
  const engine = new Engine(store, boundAdapter, 0);
  engine.profiles = profiles;
  // Positive command fixtures allow journal writes under host load; silence stays short.
  engine.resolution.delegatedAnswerWaitMs = options.delegates?.planner ? 1000 : 10;
  engine.resolution.worktreeValidationProbe = () => ({ state: "absent" });

  /** A full authenticated reviewer finding, longer than any excerpt bound. */
  const finding = (status: string) =>
    `Authenticated findings for ${status}: ` +
    "The retry path still drops the accepted head and re-reads the whole change in a second pass. ".repeat(
      40,
    ) +
    `End of authenticated findings for ${status}.`;
  const current = () => store.task(submitted.id);
  const run = () => store.run(current().resolution.currentRunId!)!;
  const events = (kind: string) =>
    store.eventsAll(submitted.id).filter((event) => event.kind === kind);
  /**
   * The recorded start of the initial worker's run (nucleus#1187). The worker run
   * lives on the task row and never as a run row, so its dispatch intent and its
   * `agent_created` event are the only durable evidence of when it began. The rows
   * are written through the store and then dated, exactly as the real launch wrote
   * them, so a budget measures from a recorded run start rather than a conversion.
   */
  function recordRunStart(at: string) {
    store.event(submitted.id, "agent_intent", current().runId ?? "initial");
    store.event(submitted.id, "agent_created", "worker");
    for (const row of store.db.prepare("SELECT id FROM events WHERE taskId=? AND kind IN ('agent_intent','agent_created') ORDER BY id DESC LIMIT 2").all(submitted.id) as { id: number }[])
      store.db.prepare("UPDATE events SET at=? WHERE id=?").run(at, row.id);
  }
  const coordinatorRuns = () =>
    store.runs(submitted.id).filter((item) => item.role === "recovery");
  const reviewerRuns = () =>
    store.runs(submitted.id).filter((item) => item.role === "reviewer");
  async function report(
    status: Completion["status"],
    extra: Partial<Completion> = {},
  ) {
    const active = run();
    idle(active.agentId!);
    const input: Completion = {
      taskId: submitted.id,
      runId: active.id,
      eventId: randomUUID(),
      status,
      summary: `${active.role} reported ${status}`,
      head: active.head,
      ...(active.role === "reviewer"
        ? {
            reviewText: finding(status),
            ...(status === "changes_required"
              ? { reviewResponsibility: "author" as const }
              : status === "blocked"
                ? { reviewResponsibility: "environment" as const }
                : {}),
          }
        : { prNumber: 1 }),
      ...extra,
    };
    assert.equal(
      engine.resolution.complete(input, tokens.get(active.id)!).accepted,
      true,
    );
    await engine.wake();
    return input;
  }
  /** Three substantive review rounds with a returned revision between each. */
  async function reviews(count: number) {
    for (let i = 0; i < count; i++) {
      await engine.wake();
      assert.equal(run().role, "reviewer");
      await report("changes_required");
      if (i < count - 1) {
        await engine.wake();
        assert.equal(run().role, "revision", current().reason);
        await report("ready_for_review");
      }
    }
  }
  const settle = async (passes = 2) => {
    for (let pass = 0; pass < passes; pass++) {
      await engine.wake();
      await engine.quiesce();
    }
  };
  return {
    dir,
    store,
    engine,
    adapter,
    submitted,
    tokens,
    profiles,
    author,
    higher,
    reviewer,
    coordinator,
    current,
    run,
    events,
    recordRunStart,
    coordinatorRuns,
    reviewerRuns,
    report,
    reviews,
    settle,
    idle,
    states,
    creates,
    sends,
    asks,
    prompts,
    finding,
    delegated,
    get mergeCalls() {
      return mergeCalls;
    },
    setHead(value: string) {
      remoteHead = value;
    },
    answer(value: string) {
      assert.ok(answerAsk, "a native question was asked");
      answerAsk!(value);
      answerAsk = null;
      rejectAsk = null;
    },
    reject(error: Error) {
      assert.ok(rejectAsk, "a native question was asked");
      rejectAsk!(error);
      answerAsk = null;
      rejectAsk = null;
    },
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
