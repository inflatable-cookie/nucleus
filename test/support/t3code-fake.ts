import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";
import { readFileSync } from "node:fs";

type Value = Record<string, any>;
const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/t3code-contract.json", import.meta.url),
    "utf8",
  ),
) as Value;
export const STAMP = "2026-01-01T00:00:00.000Z";

/**
 * The Nightly's record shapes, captured read-only from its own wire (contract
 * `wireShapes`: keys only, values synthetic). A test may override any field it
 * needs; the transport completes every served record to this shape and checks
 * it, so the fixture is always a Nightly wire record and never an invented
 * partial one (nucleus#1188 review).
 */
const shapes = contract.wireShapes as {
  snapshotKeys: string[];
  projectionKeys: string[];
  threadKeys: string[];
  runKeys: string[];
  runtimeRequestKeys: string[];
  turnItemBaseKeys: string[];
  turnItemTypeKeys: Record<string, string[]>;
  messageKeys: string[];
  visibleTurnItemKeys: string[];
  providerThreadKeys: string[];
  pendingBackgroundTaskKeys: string[];
  subagentKeys: string[];
};
const modelSelection = {
  instanceId: "synthetic-provider",
  model: "synthetic-model",
};

/** One pending background task the nightly's provider thread reports (nightly `OrchestrationV2PendingBackgroundTask`). */
export function syntheticBackgroundTask(overrides: Value = {}): Value {
  return {
    taskId: overrides.taskId ?? "synthetic-background-task",
    kind: overrides.kind ?? "command",
    ...overrides,
  };
}

/** One provider thread record, completed to the recorded wire shape (nightly `OrchestrationV2ProviderThread`). */
export function syntheticProviderThread(overrides: Value = {}): Value {
  const { pendingBackgroundTasks: tasks, ...rest } = overrides;
  return {
    id: "synthetic-provider-thread",
    driver: "codex",
    providerInstanceId: "synthetic-provider",
    providerSessionId: "synthetic-session",
    appThreadId: null,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...rest,
    pendingBackgroundTasks: (tasks ?? []).map((task: Value) =>
      syntheticBackgroundTask(task),
    ),
  };
}

/**
 * One delegated task of a parent thread (nightly `OrchestrationV2Subagent`, recorded
 * in `wireShapes.subagentKeys`). The adapter reads `completionDelivery.state` to decide
 * whether a child's completion can still wake the parent.
 */
export function syntheticSubagent(overrides: Value = {}): Value {
  const id = overrides.id ?? "node:delegated-task:synthetic";
  return {
    id,
    threadId: "synthetic-probe",
    runId: null,
    parentNodeId: `parent-node-${id}`,
    origin: "app_owned",
    createdBy: "user",
    driver: "codex",
    providerInstanceId: "synthetic-provider",
    providerThreadId: null,
    childThreadId: `thread:delegated-task:${id}`,
    nativeTaskRef: null,
    prompt: "Synthetic task",
    title: null,
    model: "synthetic-model",
    status: "running",
    result: null,
    startedAt: STAMP,
    completedAt: null,
    updatedAt: STAMP,
    ...overrides,
    completionDelivery: overrides.completionDelivery ?? {
      state: "pending",
      observedByRunId: null,
    },
  };
}

export function syntheticThread(
  id: string,
  directory: string,
  overrides: Value = {},
): Value {
  const thread: Value = {
    id,
    projectId: "synthetic-project",
    title: "Synthetic thread",
    providerInstanceId: "synthetic-provider",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "synthetic",
    worktreePath: directory,
    linkedPullRequest: null,
    pullRequests: [],
    activeProviderThreadId: null,
    createdBy: "user",
    creationSource: "web",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: id,
    },
    forkedFrom: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    opens: [],
    titleRegeneration: null,
    ...overrides,
  };
  return thread;
}

export function syntheticRun(
  threadId: string,
  ordinal: number,
  overrides: Value = {},
): Value {
  const id = overrides.id ?? `synthetic-run-${ordinal}`;
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: "synthetic-provider",
    modelSelection,
    providerThreadId: null,
    userMessageId: `synthetic-message-${id}`,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: STAMP,
    startedAt: STAMP,
    completedAt: STAMP,
    checkpointId: null,
    contextHandoffId: null,
    workspacePreparation: null,
    ...overrides,
  };
}

export function syntheticRuntimeRequest(overrides: Value = {}): Value {
  const id = overrides.id ?? "synthetic-request";
  return {
    id,
    nodeId: `synthetic-node-${id}`,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: {
      type: "live",
      providerSessionId: "synthetic-session",
    },
    createdAt: STAMP,
    resolvedAt: null,
    ...overrides,
  };
}

export function syntheticTurnItem(
  threadId: string,
  ordinal: number,
  overrides: Value = {},
): Value {
  const id = overrides.id ?? `synthetic-item-${ordinal}`;
  const type = overrides.type ?? "assistant_message";
  const base: Value = {
    id,
    threadId,
    type,
    status: "completed",
    title: null,
    ordinal,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    startedAt: STAMP,
    completedAt: STAMP,
    updatedAt: STAMP,
  };
  const member: Record<string, Value> = {
    assistant_message: {
      messageId: `synthetic-message-${id}`,
      text: "Synthetic reply",
      streaming: false,
    },
    user_message: {
      messageId: `synthetic-message-${id}`,
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      text: "Synthetic prompt",
      attachments: [],
    },
    user_input_request: {
      requestId: `synthetic-request-${id}`,
      questions: [
        {
          id: `synthetic-question-${id}`,
          header: "Synthetic",
          question: "Synthetic question?",
          options: [
            { label: "Yes", description: "Accept the synthetic choice" },
            { label: "No", description: "Refuse it" },
          ],
        },
      ],
    },
    command_execution: {
      input: "synthetic-command",
      exitCode: 0,
      outputIndicatesFailure: false,
      outputOmitted: false,
    },
    reasoning: { text: "Synthetic reasoning", streaming: false },
    thread_created: {
      targetThreadId: "synthetic-target",
      targetRunId: null,
      targetProviderInstanceId: "synthetic-provider",
      targetModel: "synthetic-model",
    },
  };
  return { ...base, ...(member[type] ?? {}), ...overrides };
}

/**
 * Every record of a projection, completed to the recorded wire shape, plus every
 * projection collection the Nightly's wire carries (an empty array where the test
 * has no data). `visibleTurnItems` is the rendered window: by default every item
 * served is visible, and a bounded answer passes the window's own item ids so
 * only those rows appear, exactly as the nightly windows the rows and then
 * appends what it retains outside them.
 */
function wireProjection(p: Value, windowItemIds?: Set<string>): Value {
  const threadId = p.thread.id;
  const thread = syntheticThread(
    threadId,
    p.thread.worktreePath ?? "/synthetic",
    p.thread,
  );
  const runs = (p.runs ?? []).map((run: Value, index: number) =>
    syntheticRun(threadId, index + 1, run),
  );
  const runtimeRequests = (p.runtimeRequests ?? []).map(
    (request: Value, index: number) =>
      syntheticRuntimeRequest({
        id: `synthetic-request-${index + 1}`,
        ...request,
      }),
  );
  const turnItems = (p.turnItems ?? []).map((item: Value, index: number) =>
    syntheticTurnItem(threadId, index + 1, item),
  );
  const messages = (p.messages ?? []).map((message: Value, index: number) => ({
    id: `synthetic-message-${index + 1}`,
    threadId,
    runId: null,
    nodeId: null,
    createdBy: "user",
    creationSource: "web",
    role: "user",
    text: "Synthetic message",
    attachments: [],
    streaming: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...message,
  }));
  const projection = {
    ...p,
    thread,
    runs,
    runtimeRequests,
    turnItems,
    messages,
    // The wire carries the visible rows beside the items it serves; each row points at its item.
    visibleTurnItems: turnItems
      .filter((item: Value) => !windowItemIds || windowItemIds.has(item.id))
      .map((item: Value, index: number) => ({
        position: index + 1,
        sourceItemId: item.id,
        sourceThreadId: threadId,
        visibility: "local",
        item,
      })),
    // Collections the Nightly always projects, empty unless the test supplies them.
    attempts: p.attempts ?? [],
    nodes: p.nodes ?? [],
    providerSessions: p.providerSessions ?? [],
    providerThreads: (p.providerThreads ?? []).map((thread: Value) =>
      syntheticProviderThread(thread),
    ),
    subagents: (p.subagents ?? []).map((task: Value) =>
      syntheticSubagent(task),
    ),
    providerTurns: p.providerTurns ?? [],
    plans: p.plans ?? [],
    checkpointScopes: p.checkpointScopes ?? [],
    checkpoints: p.checkpoints ?? [],
    contextHandoffs: p.contextHandoffs ?? [],
    contextTransfers: p.contextTransfers ?? [],
    updatedAt: p.updatedAt ?? STAMP,
  };
  assertWireRecords(projection);
  return projection;
}

/** Refuse a served record that is missing a field the Nightly's wire always carries. */
function assertWireRecords(projection: Value): void {
  const missing = (records: Value[], keys: string[], kind: string) => {
    for (const record of records)
      for (const key of keys)
        assert.ok(
          Object.hasOwn(record, key),
          `${kind} ${record.id ?? record.type} is missing the wire field ${key}`,
        );
  };
  for (const key of shapes.projectionKeys)
    assert.ok(
      Object.hasOwn(projection, key),
      `projection is missing the wire field ${key}`,
    );
  missing([projection.thread], shapes.threadKeys, "thread");
  missing(projection.runs, shapes.runKeys, "run");
  missing(
    projection.runtimeRequests,
    shapes.runtimeRequestKeys,
    "runtimeRequest",
  );
  missing(projection.messages, shapes.messageKeys, "message");
  missing(
    projection.visibleTurnItems,
    shapes.visibleTurnItemKeys,
    "visibleTurnItem",
  );
  missing(
    projection.providerThreads,
    shapes.providerThreadKeys,
    "providerThread",
  );
  for (const thread of projection.providerThreads)
    missing(
      thread.pendingBackgroundTasks ?? [],
      shapes.pendingBackgroundTaskKeys,
      "pendingBackgroundTask",
    );
  missing(projection.subagents ?? [], shapes.subagentKeys, "subagent");
  for (const item of projection.turnItems) {
    const extra = shapes.turnItemTypeKeys[item.type] ?? [];
    missing(
      [item],
      [
        ...shapes.turnItemBaseKeys,
        "type",
        ...extra.filter(
          (key: string) => !shapes.turnItemBaseKeys.includes(key),
        ),
      ],
      `turnItem ${item.type}`,
    );
  }
}

export function threadProjection(id: string, directory: string): Value {
  return {
    thread: syntheticThread(id, directory),
    runs: [],
    runtimeRequests: [],
    turnItems: [],
    messages: [],
    updatedAt: STAMP,
  };
}

/** Exercises the real HTTP ticket exchange and WebSocket RPC client. */
export async function t3Fake(t: TestContext, directory: string) {
  const requests: Value[] = [];
  const commands: Value[] = [];
  /** Every thread snapshot this fake served: what the client asked for and what it got. */
  const snapshots: Value[] = [];
  /** `orchestration.subscribeThread` reads being served now, and the most at once. */
  const threadReads = { inFlight: 0, max: 0 };
  /** The rows of every shell snapshot served, so a test can prove which shape it exercised. */
  const shells: Array<{ threads: string[]; archivedThreads: string[] }> = [];
  /** Requests refused for a bearer other than this fake's own, as the server answers them. */
  const unauthorized: Array<{ path: string }> = [];
  /** Every bearer a socket ticket was fetched with, in order: which connection carried which call. */
  const bearers: string[] = [];
  const projectRowsRaw: Value[] = [
    {
      id: "synthetic-project",
      title: "Synthetic project",
      workspaceRoot: directory,
    },
  ];
  const archivedProjects = new Set<string>();
  /**
   * Every held shell subscription hears about a thread change the way the
   * nightly's live tail tells it (`thread.updated` / `thread.removed`). A test edits
   * the fixture in place, so the thread map watches its own records: any write
   * schedules one publication after the current synchronous step.
   */
  const shellPublishers = new Set<() => void>();
  const shellAcks = new Set<{ sent: number; acked: number }>();
  /**
   * The client's freshness barrier (`T3LiveShell`'s test seam): publish whatever
   * changed and wait until every chunk sent is acknowledged, so a read right after
   * a fixture edit sees it, as it would a moment later on a real host.
   */
  const shellBarrier = async () => {
    for (const publish of shellPublishers) publish();
    const deadline = Date.now() + 2_000;
    while (
      [...shellAcks].some((chunks) => chunks.acked < chunks.sent) &&
      Date.now() < deadline
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const barriers = ((globalThis as Record<string, unknown>)[
    "__t3LiveShellBarriers"
  ] ??= new Set<() => Promise<void>>()) as Set<() => Promise<void>>;
  barriers.add(shellBarrier);
  t.after(() => barriers.delete(shellBarrier));
  let publishQueued = false;
  const changed = () => {
    if (publishQueued) return;
    publishQueued = true;
    queueMicrotask(() => {
      publishQueued = false;
      for (const publish of shellPublishers) publish();
    });
  };
  const watched = new WeakMap<object, object>();
  const watch = <T,>(target: T): T => {
    if (target === null || typeof target !== "object" || Buffer.isBuffer(target))
      return target;
    const known = watched.get(target as object);
    if (known) return known as T;
    const proxy = new Proxy(target as object, {
      get(object, key, receiver) {
        return watch(Reflect.get(object, key, receiver));
      },
      set(object, key, value, receiver) {
        const done = Reflect.set(object, key, value, receiver);
        changed();
        return done;
      },
      deleteProperty(object, key) {
        const done = Reflect.deleteProperty(object, key);
        changed();
        return done;
      },
    });
    watched.set(target as object, proxy);
    return proxy as T;
  };
  class WatchedThreads extends Map<string, Value> {
    override get(key: string) {
      return watch(super.get(key));
    }
    override set(key: string, value: Value) {
      super.set(key, value);
      changed();
      return this;
    }
    override delete(key: string) {
      const done = super.delete(key);
      changed();
      return done;
    }
    override clear() {
      super.clear();
      changed();
    }
    override values(): MapIterator<Value> {
      return [...super.values()]
        .map((value) => watch(value))
        [Symbol.iterator]() as unknown as MapIterator<Value>;
    }
    override entries(): MapIterator<[string, Value]> {
      return [...super.entries()]
        .map(([key, value]) => [key, watch(value)] as [string, Value])
        [Symbol.iterator]() as unknown as MapIterator<[string, Value]>;
    }
    override [Symbol.iterator]() {
      return this.entries();
    }
    override forEach(
      callback: (value: Value, key: string, map: Map<string, Value>) => void,
      thisArg?: unknown,
    ) {
      for (const [key, value] of this.entries())
        callback.call(thisArg, value, key, this as unknown as Map<string, Value>);
    }
  }
  const projectRows: Value[] = watch(projectRowsRaw);
  const threads = new WatchedThreads([
    ["synthetic-probe", threadProjection("synthetic-probe", directory)],
  ]);
  /**
   * The nightly's bounded snapshot (recorded `subscribeThread` contract): only a
   * client that sends `acceptBoundedSnapshot` receives one. The thread record is
   * whole; runs keep the active-status set, the window's own runs and the run the
   * shell presents; runtime requests keep the pending set and the window's own
   * requests; plans and context handoffs are filtered; and only the timeline is a
   * window with `hasMoreHistory` and an opaque `historyCursor`. Items a pending
   * runtime request needs are retained outside the window, as the nightly keeps
   * them (contract `subscribeThread.projectionRetained`).
   */
  const boundedSnapshot = (raw: Value, rowLimit: number) => {
    const p = raw;
    const active = new Set([
      "queued",
      "preparing",
      "starting",
      "running",
      "waiting",
    ]);
    const pending = new Set(
      p.runtimeRequests
        .filter((request: Value) =>
          ["pending", "waiting"].includes(request.status),
        )
        .map((request: Value) => request.id),
    );
    // The nightly windows the visible rows, then appends the items it retains from
    // outside that window (a run interrupt, or a request item whose request is
    // still pending). Only the window's rows are visible rows.
    const newest = p.turnItems.slice(-rowLimit);
    const windowItemIds = new Set<string>(newest.map((item: Value) => item.id));
    const kept = new Set<string>(windowItemIds);
    for (const item of p.turnItems)
      if (
        item.type === "run_interrupt_request" ||
        (["user_input_request", "approval_request"].includes(item.type) &&
          pending.has(item.requestId))
      )
        kept.add(item.id);
    const windowItems = p.turnItems.filter((item: Value) =>
      windowItemIds.has(item.id),
    );
    const servedItems = [
      ...windowItems,
      ...p.turnItems.filter(
        (item: Value) => kept.has(item.id) && !windowItemIds.has(item.id),
      ),
    ];
    const windowRuns = new Set(
      windowItems.flatMap((item: Value) => (item.runId ? [item.runId] : [])),
    );
    const presented = [...p.runs]
      .reverse()
      .find((run: Value) => run.status !== "queued" || !run.queueHeld);
    const runs = p.runs.filter(
      (run: Value) =>
        active.has(run.status) ||
        windowRuns.has(run.id) ||
        run.id === presented?.id,
    );
    const windowNodes = new Set(
      windowItems.flatMap((item: Value) => (item.nodeId ? [item.nodeId] : [])),
    );
    const runtimeRequests = p.runtimeRequests.filter(
      (request: Value) =>
        ["pending", "waiting"].includes(request.status) ||
        windowNodes.has(request.nodeId),
    );
    const plans = (p.plans ?? []).filter(
      (plan: Value) => plan.status === "active",
    );
    const contextHandoffs = (p.contextHandoffs ?? []).filter((handoff: Value) =>
      ["pending", "ready"].includes(handoff.status),
    );
    const hasMoreHistory = windowItems.length < p.turnItems.length;
    // The nightly's `historyCursor` names the row boundary before the window; the
    // history route (`GET .../history?cursor=…`) serves the page before it.
    const windowStart = p.turnItems.findIndex((item: Value) =>
      windowItemIds.has(item.id),
    );
    // Window rows first, then the retained items: the served rows are the window
    // itself, so a timeline page built from them holds no older row.
    const providerIds = new Set(
      [...servedItems, ...runs]
        .map((item: Value) => item.providerThreadId)
        .filter(Boolean),
    );
    const nodeIds = new Set(
      servedItems.map((item: Value) => item.nodeId).filter(Boolean),
    );
    const providerThreads = (p.providerThreads ?? []).filter(
      (thread: Value) =>
        thread.status === "active" ||
        providerIds.has(thread.id) ||
        nodeIds.has(thread.ownerNodeId) ||
        thread.id === p.latestTodoList?.providerThreadId,
    );
    const windowed = {
      ...p,
      runs,
      runtimeRequests,
      plans,
      contextHandoffs,
      providerThreads,
      turnItems: servedItems,
      messages: p.messages.slice(-1),
    };
    const snapshot = {
      projection: wireProjection(windowed, windowItemIds),
      hasMoreHistory,
      historyCursor: hasMoreHistory ? `synthetic-history-${windowStart}` : null,
      latestLocalTurnOrdinal: null,
    };
    // The fixture is checked against the recorded contract on every bounded
    // answer, so a hand-made coverage field cannot enter a test unobserved.
    for (const field of contract.subscribeThread.boundedRequired)
      assert.ok(
        field === "snapshotSequence" || Object.hasOwn(snapshot, field),
        `bounded snapshot.${field}`,
      );
    // A bounded answer carries exactly the recorded key set (the `kind` tag and
    // the sequence ride its frame), so a test can never read a field the live
    // Nightly does not send. A test that deliberately serves a malformed shape
    // overrides a coverage field, and then only the required set is checked.
    if (
      !Object.keys(controls.threadCoverage).length &&
      !controls.incompleteThread
    )
      assert.deepEqual(
        Object.keys({
          kind: "snapshot",
          snapshotSequence: 1,
          ...snapshot,
        }).sort(),
        [...shapes.snapshotKeys].sort(),
        "a bounded snapshot carries exactly the recorded key set",
      );
    return snapshot;
  };
  const controls = watch({
    environmentId: "synthetic-environment",
    version: "nightly-synthetic-unseen",
    protocol: 2,
    heartbeat: true,
    synchronized: true,
    incompleteThread: false,
    enrichment: false,
    shellMissingField: "",
    snapshotSequence: 1,
    threadCoverage: {} as Record<string, unknown>,
    beforeArchiveRead: (() => {}) as () => void,
    /** The next this-many `subscribeShell` requests fail remotely: T3 cannot read its shell. */
    shellFailures: 0,
    /** Methods this fake receives and never answers, as a wedged T3 does. */
    stalledMethods: [] as string[],
    /** The next N thread reads end with an Interrupt frame instead of a snapshot (a stream cut mid-turn). */
    interruptThreadReads: 0,
    /** The next N thread projection reads fail with `OrchestrationV2GetThreadProjectionError`. */
    threadProjectionErrors: 0,
    /** Optional `cause` payload attached to injected `threadProjectionErrors`. */
    threadProjectionErrorCause: undefined as unknown,
    /**
     * The answer a projection read gives for a thread T3 does not hold. The installed
     * nightly's absent read wraps `ProjectionStoreThreadNotFoundError` inside
     * `OrchestrationV2GetThreadProjectionError` (`OrchestratorProjectionError` cause);
     * `"OrchestrationV2GetThreadProjectionError"` models a cause-less generic failure,
     * and the default keeps the #1458 `ThreadNotFoundError` tag.
     */
    absentThreadError: "ThreadNotFoundError" as
      | "ThreadNotFoundError"
      | "OrchestrationV2GetThreadProjectionError"
      | "ProjectionStoreThreadNotFoundError",
    archivedThreadNotFound: false,
    disconnectMutation: false,
    disconnectAfterEffect: false,
    /** A launch thread commits, then its reply is lost to a dropped socket. */
    disconnectAfterLaunch: false,
    /** The next delegated launch times out before T3 creates its child. */
    timeoutDelegatedLaunch: false,
    /** One-shot faults for the next `thread.unsettle` commands, in order: "drops" or "lands". */
    unsettleFaults: [] as Array<"drops" | "lands">,
    /** Thread reads that still show a settled thread after an unsettle command (a delayed apply). */
    unsettleLagReads: 0,
    refuseMutation: false,
    postEffectDefect: false,
    unsupportedProjectCreate: false,
    projectMutationFailure: false,
    projectMutationSecretFailure: false,
    projectMutationIdSecretFailure: false,
    secretDefect: false,
    secretLocationDefect: false,
    mutationObserver: (() => {}) as () => void,
    /** Rows the bounded snapshot keeps before it pages; the nightly's own limit is a policy, not a contract field. */
    boundedRowLimit: 20,
    /**
     * Millisecond delay before a whole-projection answer (a read that did not opt
     * into the bounded snapshot), modelling the measured slow full read of a very
     * long thread: the nightly sends all 1986 of a long worker's turn items in one
     * 8.1 MiB frame, and a busy service outlives the 10 s read bound doing it.
     */
    slowFullSnapshotMs: 0,
    /** Millisecond delay before any thread snapshot answer (a busy or wedged read). */
    slowSnapshotMs: 0,
    /** A nightly that ignores `acceptBoundedSnapshot` and always answers the whole projection. */
    ignoreBoundedSnapshot: false,
    /** Replaces the single synthetic provider in `server.getConfig` when set (nightly provider shapes). */
    providers: undefined as Value[] | undefined,
    /** `server.getConfig`'s `settings` block; the client's own hide switch lives here. */
    settings: {
      hideTaggedThreads: false,
      hiddenThreadTags: [] as string[],
    } as Value,
    /**
     * `settings.providerInstances`: the stored provider instances the nightly keeps
     * in its own settings (`server.updateSettings`'s mutation target). Absent when
     * no test reads or writes one, so the served block keeps its previous shape.
     */
    providerInstances: undefined as Value | undefined,
    /** Authorization headers this fake refuses, for a token-rotation case. */
    rejectBearers: [] as string[],
    /**
     * The readiness a mutation leaves behind. The installed nightly answers a
     * provider upsert with `ready` and then reports its own ACP probe's verdict
     * (`warning` when the agent refuses a test session), so an install test sets
     * these to score the probe result the operator route has to report.
     */
    upsertProviderStatus: "ready" as string,
    upsertProviderMessage: "" as string,
    /**
     * A launched or messaged thread starts a live run, the way a provider turn does.
     * The parenting tests need the parent thread to be live while a child is created
     * (nightly: `Parent run ... is not active.`).
     */
    runOnLaunch: false,
    /**
     * A thread launched on the Nucleus ACP provider starts its held turn at launch,
     * exactly as the ACP agent does. `false` is how a test says that turn never
     * starts, which is the refusal a role create names (nucleus#1305, #1366).
     */
    parentHeldTurn: true,
    /**
     * A freshly created delegated child starts a running turn, as the nightly does.
     * `false` lets a fixture decide each role's turn itself, which is what a test
     * that drives reports needs.
     */
    childRunOnCreate: true,
    /**
     * Serve a removed thread as a `deletedAt` tombstone in the shell lists instead of
     * omitting it. Both shapes exist on the wire, and a reader must treat either one as
     * the same deletion fact (nucleus#1305 review).
     */
    shellTombstones: false,
    /**
     * The shell row status a thread reports, by native thread id, when it is not the
     * run-derived one: a finished run's own app state (`completed`, `interrupted`, ...)
     * is what the nightly's shell carries after the run ends (nucleus#1381).
     */
    shellStatuses: {} as Record<string, string>,
  });
  /** Command receipts make a replayed project mutation answer with its recorded outcome. */
  const projectReceipts = new Map<
    string,
    { type: string; projectId: string }
  >();
  const previews = new Map<string, Value[]>();
  let previewSequence = 0;
  let previewRevision = 0;
  const sockets = new Set<Socket>();
  const controlFrames: Value[] = [];
  const frameBytes: number[] = [];
  const injectors: Array<(text: string) => void> = [];
  let upgrades = 0,
    closes = 0;
  const wsText = (socket: Socket, text: string) => {
    const bytes = Buffer.from(text);
    frameBytes.push(bytes.length);
    const header = Buffer.alloc(
      bytes.length < 126 ? 2 : bytes.length <= 0xffff ? 4 : 10,
    );
    header[0] = 0x81;
    if (header.length === 2) header[1] = bytes.length;
    else if (header.length === 4) {
      header[1] = 126;
      header.writeUInt16BE(bytes.length, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(bytes.length), 2);
    }
    socket.write(Buffer.concat([header, bytes]));
  };
  const server = createServer((request, response) => {
    // A stranger's request gets the nightly's own answer — 401 — instead of throwing:
    // the installed server refuses an unknown bearer, and a fixture that threw from an
    // HTTP handler could be crashed by any other client on the host, which fails the
    // whole file with an uncaught exception that is not the test's (nucleus#1305 run).
    // The environment descriptor is public on the nightly (a reachability probe
    // reads it before any bearer exists); everything else needs a session.
    const publicPath = new URL(request.url!, "http://localhost").pathname;
    if (publicPath === "/.well-known/t3/environment") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          environmentId: controls.environmentId,
          serverVersion: controls.version,
          orchestrationProtocolVersion: controls.protocol,
        }),
      );
      return;
    }
    // Every `synthetic-*` bearer is this fake's own: the operator install route
    // mints one bearer per scope split and proves which one carried which call.
    const authorization = `${request.headers.authorization ?? ""}`;
    if (
      controls.rejectBearers.includes(authorization) ||
      !/^Bearer synthetic-/.test(authorization)
    ) {
      unauthorized.push({ path: request.url ?? "" });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/api/auth/websocket-ticket/rpc") {
      bearers.push(authorization);
      response.end(
        JSON.stringify({
          ticket: "synthetic-ticket",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      );
      return;
    }
    if (url.pathname === "/.well-known/t3/environment") {
      response.end(
        JSON.stringify({
          environmentId: controls.environmentId,
          serverVersion: controls.version,
          orchestrationProtocolVersion: controls.protocol,
        }),
      );
      return;
    }
    assert.fail(`unexpected HTTP route ${url.pathname}`);
  });
  let shellSequence = 0;
  /**
   * The shell's two lists. A removed thread is normally in no list: the nightly's
   * own shell reads filter `deleted_at IS NULL`, so absence is the positive answer
   * there. A nightly that keeps the tombstone is modelled by `controls.shellTombstones`.
   */
  const shellLists = () => {
    const listed = (p: Value, archived: boolean) =>
      (archived ? Boolean(p.thread.archivedAt) : !p.thread.archivedAt) &&
      (!p.thread.deletedAt || controls.shellTombstones);
    return {
      active: [...threads.values()].filter((p) => listed(p, false)).map(shell),
      archived: [...threads.values()].filter((p) => listed(p, true)).map(shell),
    };
  };
  const shell = (raw: Value) => {
    const p = wireProjection(raw);
    const active = p.runs.find((run: Value) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(
        run.status,
      ),
    );
    const pending = p.runtimeRequests.find(
      (request: Value) => request.status === "pending",
    );
    // An app state override is a finished thread's own status: it has no live run.
    const overridden = controls.shellStatuses[p.thread.id];
    const value: Value = {
      ...p.thread,
      activeRunId: overridden === undefined ? (active?.id ?? null) : null,
      status: overridden ?? active?.status ?? "idle",
      pendingRuntimeRequest: pending
        ? {
            id: pending.id,
            kind: pending.kind,
            createdAt: STAMP,
            blocking: true,
          }
        : null,
      pendingBackgroundTasks:
        raw.pendingBackgroundTasks ??
        (active
          ? []
          : [
              ...(p.providerThreads ?? []).flatMap(
                (thread: Value) => thread.pendingBackgroundTasks ?? [],
              ),
              ...p.turnItems
                .filter(
                  (item: Value) =>
                    ["command_execution", "dynamic_tool", "subagent"].includes(
                      item.type,
                    ) &&
                    ["running", "waiting", "pending", "queued"].includes(
                      item.status,
                    ),
                )
                .map((item: Value) => ({
                  taskId: item.nativeItemRef?.nativeId || item.id,
                  kind:
                    item.type === "command_execution"
                      ? "command"
                      : item.type === "subagent"
                        ? "subagent"
                        : "background_task",
                })),
            ]),
      latestUserMessageAt: p.messages.length ? STAMP : null,
      lastError: null,
      // The nightly's shell counts the thread's items, so a new turn item moves the row.
      itemCount: p.turnItems.length,
      visibleItemCount: p.turnItems.length,
    };
    if (controls.shellMissingField) delete value[controls.shellMissingField];
    return value;
  };
  const projects = () =>
    projectRows.map((row) => ({
      ...row,
      archivedAt: archivedProjects.has(row.id) ? STAMP : null,
    }));
  /**
   * The nightly's recordSubagentFollowup outcome: a message to a finished delegated
   * child starts a new app-owned task under the dispatch's own command id
   * (`node:delegated-task:<commandId>`), and T3 leaves that task's completion wake
   * pending — the one a host must dispose itself.
   */
  const recordFollowUp = (payload: Value) => {
    const child = threads.get(payload.threadId)!;
    const parentId = child.thread.lineage?.parentThreadId;
    const parent =
      parentId === null || parentId === undefined
        ? undefined
        : threads.get(parentId);
    if (!parent) return;
    const owner =
      [...parent.runs]
        .reverse()
        .find((run: Value) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        ) ?? [...parent.runs].reverse()[0];
    if (controls.runOnLaunch)
      child.runs.push(
        syntheticRun(payload.threadId, child.runs.length + 1, {
          id: `run:${payload.commandId}`,
          status: "running",
          rootNodeId: `node:root:${payload.commandId}`,
        }),
      );
    parent.subagents = [
      ...(parent.subagents ?? []),
      syntheticSubagent({
        id: `node:delegated-task:${payload.commandId}`,
        threadId: parentId,
        runId: owner?.id ?? null,
        parentNodeId: owner?.rootNodeId ?? null,
        driver: "codex",
        providerInstanceId: child.thread.providerInstanceId,
        childThreadId: payload.threadId,
        prompt: payload.text,
        title: child.thread.title,
        model: child.thread.modelSelection?.model ?? null,
        status: "running",
      }),
    ];
  };
  server.on("upgrade", (request, rawSocket) => {
    const socket = rawSocket as Socket;
    upgrades++;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      closes++;
    });
    // A client that exits mid-frame resets the connection; that is the client's
    // own teardown and never the fake's failure.
    socket.on("error", () => {
      sockets.delete(socket);
    });
    const url = new URL(request.url!, "http://localhost");
    assert.equal(url.pathname, "/ws");
    assert.equal(url.searchParams.get("wsTicket"), "synthetic-ticket");
    const accept = createHash("sha1")
      .update(
        `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    injectors.push((text) => {
      if (sockets.has(socket)) wsText(socket, text);
    });
    const send = (value: unknown) => wsText(socket, JSON.stringify(value));
    // Held shell subscriptions on this socket, by request id: the rows each was last sent.
    const shellSubscribers = new Map<
      string,
      Map<string, { location: "active" | "archive"; key: string }>
    >();
    const projectSubscribers = new Map<string, Map<string, string>>();
    const projectKeys = () =>
      new Map<string, string>(
        projects().map((row: Value) => [row.id, JSON.stringify(row)]),
      );
    const shellKeys = (active: Value[], archived: Value[]) =>
      new Map<string, { location: "active" | "archive"; key: string }>([
        ...active.map(
          (row) =>
            [row.id, { location: "active" as const, key: JSON.stringify(row) }] as const,
        ),
        ...archived.map(
          (row) =>
            [row.id, { location: "archive" as const, key: JSON.stringify(row) }] as const,
        ),
      ]);
    /** Send each held shell subscription the rows that changed since it last heard. */
    const publishShell = () => {
      if (!shellSubscribers.size || !sockets.has(socket)) return;
      let lists: { active: Value[]; archived: Value[] };
      try {
        lists = shellLists();
      } catch {
        return; // a fixture mid-edit is read again on the next tick
      }
      const { active, archived } = lists;
      const rows = new Map<string, Value>(
        [...active, ...archived].map((row) => [row.id, row]),
      );
      const current = shellKeys(active, archived);
      const currentProjects = projectKeys();
      for (const [requestId, last] of shellSubscribers) {
        const values: Value[] = [];
        const lastProjects = projectSubscribers.get(requestId) ?? new Map();
        for (const [id, key] of currentProjects)
          if (lastProjects.get(id) !== key)
            values.push({
              kind: "project.updated",
              sequence: ++shellSequence,
              project: JSON.parse(key),
            });
        for (const id of lastProjects.keys())
          if (!currentProjects.has(id))
            values.push({
              kind: "project.removed",
              sequence: ++shellSequence,
              projectId: id,
            });
        projectSubscribers.set(requestId, currentProjects);
        for (const [id, entry] of current) {
          const prior = last.get(id);
          if (prior?.key === entry.key) continue;
          if (prior && prior.location !== entry.location)
            values.push({
              kind: "thread.removed",
              sequence: ++shellSequence,
              location: prior.location,
              threadId: id,
            });
          values.push({
            kind: "thread.updated",
            sequence: ++shellSequence,
            location: entry.location,
            thread: rows.get(id),
          });
        }
        for (const [id, prior] of last)
          if (!current.has(id))
            values.push({
              kind: "thread.removed",
              sequence: ++shellSequence,
              location: prior.location,
              threadId: id,
            });
        shellSubscribers.set(requestId, current);
        if (values.length) {
          shellChunks.sent++;
          send({ _tag: "Chunk", requestId, values });
        }
      }
    };
    // The client acknowledges every chunk after applying it, so an acknowledged
    // count equal to the sent count means the client's copy is current.
    const shellChunks = { sent: 0, acked: 0 };
    shellAcks.add(shellChunks);
    shellPublishers.add(publishShell);
    // Fixture state outside the thread map (status overrides, projects) is
    // published on a short tick as well.
    const shellTimer = setInterval(publishShell, 5);
    shellTimer.unref();
    socket.on("close", () => {
      shellPublishers.delete(publishShell);
      shellAcks.delete(shellChunks);
      clearInterval(shellTimer);
    });
    const handle = (request: Value) => {
      handleFrame(request);
      publishShell();
    };
    const handleFrame = (request: Value) => {
      // A stalled method is never answered, as a wedged T3 leaves it.
      if (request._tag === "Request" && controls.stalledMethods.includes(request.tag)) {
        requests.push(request);
        return;
      }
      if (request._tag !== "Request") {
        controlFrames.push(request);
        if (
          request._tag === "Ack" &&
          shellSubscribers.has(String(request.requestId))
        )
          shellChunks.acked++;
        if (
          request._tag === "Interrupt" &&
          shellSubscribers.delete(String(request.requestId))
        )
          // A chunk in flight to an interrupted subscription is never acknowledged.
          shellChunks.acked = shellChunks.sent;
        if (request._tag === "Ping" && controls.heartbeat)
          send({ _tag: "Pong" });
        return;
      }
      requests.push(request);
      const payload = request.payload as Value;
      const success = (value: unknown) =>
        send({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Success", value },
        });
      const failure = (reason: unknown) =>
        send({
          _tag: "Exit",
          requestId: request.id,
          exit: { _tag: "Failure", cause: [reason] },
        });
      const stream = (values: unknown[]) =>
        send({ _tag: "Chunk", requestId: request.id, values });
      const marker = () =>
        controls.synchronized ? [{ kind: "synchronized", sequence: 1 }] : [];
      switch (request.tag) {
        case "preview.open": {
          previewSequence += 1;
          previewRevision += 1;
          const tabId =
            previewSequence === 1
              ? "synthetic-preview"
              : `synthetic-preview-${previewSequence}`;
          const snapshot = {
            threadId: payload.threadId,
            tabId,
            navStatus: payload.url
              ? { _tag: "Loading", url: payload.url, title: "" }
              : { _tag: "Idle" },
            canGoBack: false,
            canGoForward: false,
            ...(payload.reveal === undefined ? {} : { reveal: payload.reveal }),
            updatedAt: STAMP,
          };
          const list = previews.get(payload.threadId) ?? [];
          list.push(snapshot);
          previews.set(payload.threadId, list);
          return success(snapshot);
        }
        case "preview.list":
          return success({
            sessions: [...(previews.get(payload.threadId) ?? [])],
            serverEpoch: "synthetic-preview-epoch",
            revision: previewRevision,
          });
        case "preview.close": {
          previewRevision += 1;
          const list = previews.get(payload.threadId) ?? [];
          if (payload.tabId) {
            previews.set(
              payload.threadId,
              list.filter((session) => session.tabId !== payload.tabId),
            );
          } else {
            previews.delete(payload.threadId);
          }
          return success(null);
        }
        case "server.getConfig": {
          const reasoning: Value = {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            currentValue: "medium",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
          };
          const serviceTier: Value = {
            id: "serviceTier",
            label: "Service Tier",
            type: "select",
            currentValue: "standard",
            options: [
              { id: "standard", label: "Standard", isDefault: true },
              { id: "priority", label: "Priority" },
            ],
          };
          const verbose: Value = {
            id: "verbose",
            label: "Verbose",
            type: "boolean",
            currentValue: true,
          };
          const settings = controls.providerInstances
            ? {
                ...controls.settings,
                providerInstances: controls.providerInstances,
              }
            : controls.settings;
          if (controls.providers)
            return success({
              environment: {
                environmentId: controls.environmentId,
                serverVersion: controls.version,
                orchestrationProtocolVersion: controls.protocol,
              },
              providers: controls.providers,
              settings,
            });
          return success({
            environment: {
              environmentId: controls.environmentId,
              serverVersion: controls.version,
              orchestrationProtocolVersion: controls.protocol,
            },
            settings,
            providers: [
              {
                instanceId: "synthetic-provider",
                displayName: "Synthetic provider",
                enabled: true,
                status: "ready",
                models: [
                  {
                    slug: "synthetic-model",
                    name: "Synthetic model",
                    aliases: ["synthetic-alias"],
                    // Nightly 0.1.10 shape: each model lists its configurable options.
                    capabilities: {
                      optionDescriptors: [reasoning, serviceTier, verbose],
                    },
                  },
                  { slug: "synthetic-model-2", name: "Synthetic model two" },
                ],
              },
            ],
            unrelatedAdditiveField: true,
          });
        }
        case "server.updateSettings": {
          // The nightly's provider-instance mutation (`create`, `upsert`, `remove`)
          // over its stored instances, with a readiness row the client then reads.
          const mutation = payload.providerInstanceMutation as
            | Value
            | undefined;
          if (!mutation) return success(controls.settings);
          const instances = { ...(controls.providerInstances ?? {}) };
          if (mutation.operation === "remove") {
            if (!Object.hasOwn(instances, mutation.instanceId))
              return failure({
                _tag: "Fail",
                error: {
                  _tag: "ServerSettingsError",
                  message: "Provider instance not found.",
                },
              });
            delete instances[mutation.instanceId];
            controls.providers = (controls.providers ?? []).filter(
              (provider) => provider.instanceId !== mutation.instanceId,
            );
          } else {
            if (
              mutation.operation === "create" &&
              Object.hasOwn(instances, mutation.instanceId)
            )
              return failure({
                _tag: "Fail",
                error: {
                  _tag: "ServerSettingsError",
                  message: "Provider instance already exists.",
                },
              });
            instances[mutation.instanceId] = mutation.instance;
            const ready = {
              instanceId: mutation.instanceId,
              displayName: mutation.instance.displayName ?? null,
              driver: mutation.instance.driver,
              enabled: mutation.instance.enabled !== false,
              status: controls.upsertProviderStatus,
              ...(controls.upsertProviderMessage
                ? { message: controls.upsertProviderMessage }
                : {}),
              models: [
                { slug: "nucleus", name: "Nucleus" },
                { slug: "nucleus-quiet", name: "Nucleus (quiet)" },
              ],
            };
            controls.providers = [
              ...(controls.providers ?? []).filter(
                (provider) => provider.instanceId !== mutation.instanceId,
              ),
              ready,
            ];
          }
          controls.providerInstances = instances;
          return success({
            ...controls.settings,
            providerInstances: instances,
          });
        }
        case "orchestration.subscribeShell": {
          if (controls.shellFailures > 0) {
            controls.shellFailures--;
            return failure({
              _tag: "Fail",
              error: {
                _tag: "OrchestrationV2GetShellSnapshotError",
                message: "Failed to prepare the application shell stream",
              },
            });
          }
          const { active, archived } = shellLists();
          // The live tail follows from these rows (nightly `subscribeShell`: one
          // snapshot, `synchronized`, then `thread.updated` / `thread.removed`).
          shellSubscribers.set(String(request.id), shellKeys(active, archived));
          projectSubscribers.set(String(request.id), projectKeys());
          // The opening chunk is acknowledged like every later one.
          shellChunks.sent++;
          shells.push({
            threads: active.map((row) => row.id),
            archivedThreads: archived.map((row) => row.id),
          });
          return stream([
            {
              kind: "snapshot",
              snapshot: {
                schemaVersion: 1,
                snapshotSequence: controls.snapshotSequence,
                projects: projects(),
                threads: active,
                archivedThreads: archived,
              },
            },
            ...(controls.enrichment
              ? [
                  {
                    kind: "snapshot",
                    resolvedRepositoryIdentityRoots: [directory],
                    snapshot: { threads: [], archivedThreads: [] },
                  },
                ]
              : []),
            ...marker(),
          ]);
        }
        case "orchestration.getArchivedShellSnapshot":
          controls.beforeArchiveRead();
          return success({
            schemaVersion: 1,
            snapshotSequence: controls.snapshotSequence,
            projects: projects(),
            threads: [...threads.values()]
              .filter(
                (p) =>
                  p.thread.archivedAt &&
                  (!p.thread.deletedAt || controls.shellTombstones),
              )
              .map(shell),
          });
        case "orchestration.subscribeThread": {
          for (const field of Object.keys(payload))
            assert.ok(
              contract.subscribeThread.input.includes(field),
              `subscribeThread.${field} is not a recorded input field`,
            );
          const p = threads.get(payload.threadId);
          // A thread T3 has not projected yet can fail its read transiently too, so
          // the injected fault applies to an absent thread as well (nucleus#1458).
          if (!p && controls.threadProjectionErrors > 0) {
            controls.threadProjectionErrors--;
            return failure({
              _tag: "Fail",
              error: {
                _tag: "OrchestrationV2GetThreadProjectionError",
                threadId: payload.threadId,
                message: `Failed to load orchestration V2 thread ${payload.threadId}`,
                ...(controls.threadProjectionErrorCause === undefined
                  ? {}
                  : { cause: controls.threadProjectionErrorCause }),
              },
            });
          }
          // The nightly refuses a removed thread's projection outright.
          if (
            !p ||
            p.thread.deletedAt !== null ||
            (controls.archivedThreadNotFound && p.thread.archivedAt)
          ) {
            if (
              !p &&
              controls.absentThreadError ===
                "ProjectionStoreThreadNotFoundError"
            )
              return failure({
                _tag: "Fail",
                error: {
                  _tag: "OrchestrationV2GetThreadProjectionError",
                  threadId: payload.threadId,
                  message: `Failed to load orchestration V2 thread ${payload.threadId}`,
                  cause: {
                    name: "OrchestratorProjectionError",
                    message: `Failed to load orchestration projection for thread ${payload.threadId}.`,
                    cause: {
                      name: "ProjectionStoreThreadNotFoundError",
                      message: `No orchestration projection exists for thread ${payload.threadId}.`,
                    },
                  },
                },
              });
            return failure({
              _tag: "Fail",
              error: {
                _tag: !p ? controls.absentThreadError : "ThreadNotFoundError",
              },
            });
          }
          // A lagging unsettle becomes visible only after this many thread reads.
          if (p.unsettleLagReads !== undefined && --p.unsettleLagReads <= 0) {
            delete p.unsettleLagReads;
            p.thread.settledOverride = "active";
            p.thread.settledAt = null;
          }
          if (controls.threadProjectionErrors > 0) {
            controls.threadProjectionErrors--;
            return failure({
              _tag: "Fail",
              error: {
                _tag: "OrchestrationV2GetThreadProjectionError",
                threadId: payload.threadId,
                message: `Failed to load orchestration V2 thread ${payload.threadId}`,
                ...(controls.threadProjectionErrorCause === undefined
                  ? {}
                  : { cause: controls.threadProjectionErrorCause }),
              },
            });
          }
          if (controls.interruptThreadReads > 0) {
            controls.interruptThreadReads--;
            return send({ _tag: "Interrupt", requestId: request.id });
          }
          // A bounded snapshot is answered only to a read that opts in, and only
          // by a nightly that understands the field (recorded server guard).
          const bounded =
            payload.acceptBoundedSnapshot === true &&
            !controls.ignoreBoundedSnapshot;
          const coverage = bounded
            ? boundedSnapshot(p, controls.boundedRowLimit)
            : { projection: wireProjection(p) };
          // A coverage claim that says more history exists without a cursor: the
          // pair the nightly never sends, which no read may use.
          const incoherent = controls.incompleteThread
            ? { hasMoreHistory: true, historyCursor: null }
            : {};
          const frame = {
            kind: "snapshot",
            snapshotSequence: controls.snapshotSequence,
            ...coverage,
            ...incoherent,
            ...controls.threadCoverage,
          } as Value;
          snapshots.push({
            threadId: payload.threadId,
            acceptBoundedSnapshot: payload.acceptBoundedSnapshot === true,
            bounded,
            hasMoreHistory: frame.hasMoreHistory === true,
            historyCursor: frame.historyCursor ?? null,
            turnItems: frame.projection?.turnItems?.length ?? 0,
            runs: frame.projection?.runs?.length ?? 0,
          });
          // Thread reads in flight on the serving side: a busy host's load.
          threadReads.inFlight++;
          threadReads.max = Math.max(threadReads.max, threadReads.inFlight);
          const answer = () => {
            threadReads.inFlight--;
            stream([frame, ...marker()]);
          };
          // A whole projection of a very long thread is the slow read; a bounded
          // window never pays that cost (contract `slowFullSnapshotMs`). A wedged
          // or busy server delays either answer (`slowSnapshotMs`).
          const delay =
            controls.slowSnapshotMs ||
            (!bounded ? controls.slowFullSnapshotMs : 0);
          if (delay > 0) {
            setTimeout(answer, delay);
            return;
          }
          return answer();
        }
        case "orchestration.launchThread": {
          for (const field of contract.launchThread.required)
            assert.ok(Object.hasOwn(payload, field), `launchThread.${field}`);
          assert.ok(
            ["existing_worktree", "root"].includes(
              payload.workspaceStrategy.type,
            ),
          );
          assert.ok(
            contract.launchThread.runtimeModes.includes(payload.runtimeMode),
          );
          assert.ok(
            contract.launchThread.interactionModes.includes(
              payload.interactionMode,
            ),
          );
          const launched = (controls.providers ?? []).find(
            (provider) =>
              provider.instanceId === payload.modelSelection.instanceId,
          );
          if (launched?.supportedRuntimeModes?.length)
            assert.ok(
              launched.supportedRuntimeModes.includes(payload.runtimeMode),
              "a provider only runs a runtime mode it reports",
            );
          for (const field of contract.launchThread.modelSelectionRequired)
            assert.ok(
              Object.hasOwn(payload.modelSelection, field),
              `modelSelection.${field}`,
            );
          if (payload.modelSelection.options !== undefined) {
            assert.ok(
              Array.isArray(payload.modelSelection.options),
              "modelSelection.options is the nightly selection array",
            );
            for (const selection of payload.modelSelection.options) {
              for (const field of contract.modelOptions.optionSelectionRequired)
                assert.ok(
                  Object.hasOwn(selection, field),
                  `modelSelection.options.${field}`,
                );
              assert.ok(
                contract.modelOptions.optionSelectionValueTypes.includes(
                  typeof selection.value,
                ),
                `modelSelection.options value type ${typeof selection.value}`,
              );
            }
          }
          commands.push({ method: request.tag, ...payload });
          controls.mutationObserver();
          if (controls.disconnectMutation) return socket.destroy();
          const root = projectRows.find(
            (project) => project.id === payload.projectId,
          )?.workspaceRoot;
          const p = threadProjection(
            payload.threadId,
            payload.workspaceStrategy.type === "root"
              ? root
              : payload.workspaceStrategy.worktreePath,
          );
          p.thread.projectId = payload.projectId;
          if (payload.workspaceStrategy.type === "root")
            p.thread.worktreePath = null;
          p.thread.pinnedAt = null;
          p.thread.title = payload.title;
          p.thread.modelSelection = payload.modelSelection;
          p.thread.providerInstanceId = payload.modelSelection.instanceId;
          p.thread.runtimeMode = payload.runtimeMode;
          p.messages.push({
            id: payload.initialMessage.messageId,
            role: "user",
            text: payload.initialMessage.text,
          });
          // A thread launched on the Nucleus ACP provider starts its held turn at
          // launch, exactly as the ACP agent does; `runOnLaunch: false` is the one
          // way a test says that turn never starts (nucleus#1305).
          if (
            controls.runOnLaunch ||
            (payload.modelSelection.instanceId === "nucleus" &&
              controls.parentHeldTurn !== false)
          )
            p.runs.push(
              syntheticRun(payload.threadId, 1, {
                id: `run:launch:${payload.threadId}`,
                status: "running",
                rootNodeId: `node:root:${payload.threadId}`,
              }),
            );
          threads.set(payload.threadId, p);
          // The launch took effect, and the reply is lost (nucleus#1458).
          if (controls.disconnectAfterLaunch) return socket.destroy();
          return success({
            threadId: payload.threadId,
            projection: wireProjection(p),
            resumed: false,
            sequence: 1,
          });
        }
        case "orchestration.dispatchCommand": {
          const definition = contract.commands[payload.type];
          // The nightly decodes the command union before any handler runs, so an
          // unknown command type is a decoder defect with no effect and no span.
          if (!definition)
            return failure({
              _tag: "Die",
              defect: contract.dispatchUnknownCommandExample,
            });
          for (const field of definition.required)
            assert.ok(
              Object.hasOwn(payload, field),
              `${payload.type}.${field}`,
            );
          if (payload.type === "message.dispatch") {
            assert.ok(
              definition.dispatchModes.includes(payload.dispatchMode.type),
            );
            if (
              definition.steerModes.includes(payload.dispatchMode.type) &&
              definition.steerRequiresTargetRunId
            )
              assert.equal(
                typeof payload.dispatchMode.targetRunId,
                "string",
                `${payload.dispatchMode.type}.targetRunId`,
              );
          }
          if (payload.type === "runtime-request.respond") {
            if (payload.decision)
              assert.ok(definition.decisions.includes(payload.decision));
            if (payload.answers)
              for (const answer of Object.values(payload.answers))
                assert.ok(
                  Array.isArray(answer) ||
                    (threads.get(payload.threadId)?.thread
                      .providerInstanceId === "nucleus" &&
                      typeof answer === "string"),
                  "question answer uses the provider's answer shape",
                );
          }
          commands.push({ method: request.tag, ...payload });
          controls.mutationObserver();
          if (controls.refuseMutation)
            return failure({
              _tag: "Die",
              defect: contract.boundaryDecodeExample,
            });
          if (controls.disconnectMutation) return socket.destroy();
          // `thread.created.record` is the one dispatch command addressed to a
          // parent thread and a target thread, and carries no single `threadId`.
          const p = (
            payload.threadId
              ? threads.get(payload.threadId)
              : threads.get(payload.targetThreadId)
          )!;
          switch (payload.type) {
            case "message.dispatch": {
              p.messages.push({
                id: payload.messageId,
                role: "user",
                text: payload.text,
              });
              // The nightly wakes a snoozed thread on an ordinary delivery
              // (dispatchMessage): `snoozedUntil` and `snoozedAt` are cleared unless
              // the dispatch is an automatic notification or a delegated completion
              // (nucleus#1445). A test that wants the wake left out sets
              // `notification` on its own dispatch.
              if (
                p.thread.snoozedUntil != null &&
                payload.notification === undefined &&
                payload.delegatedCompletion === undefined
              ) {
                p.thread.snoozedUntil = null;
                p.thread.snoozedAt = null;
              }
              // A message to a thread with no live run starts one, as a provider turn
              // does. A follow-up to a delegated child also records a new app-owned
              // task under the dispatch's own command id, exactly as the nightly's
              // recordSubagentFollowup does (node:delegated-task:<commandId>). A
              // parent thread's held turn is re-armed by its message (nucleus#1305).
              if (
                (controls.runOnLaunch ||
                  (p.thread.providerInstanceId === "nucleus" &&
                    controls.parentHeldTurn !== false)) &&
                !p.runs.some((run: Value) =>
                  ["preparing", "starting", "running", "waiting"].includes(
                    run.status,
                  ),
                )
              )
                p.runs.push(
                  syntheticRun(payload.threadId, p.runs.length + 1, {
                    id: `run:${payload.commandId}`,
                    status: "running",
                    rootNodeId: `node:root:${payload.commandId}`,
                  }),
                );
              if (
                p.thread.providerInstanceId === "nucleus" &&
                /^(Nucleus keeps this task thread open for its next role\.|nucleus-hold-the-task-thread)/.test(
                  payload.text,
                )
              ) {
                const active = p.runs.find((run: Value) =>
                  ["preparing", "starting", "running", "waiting"].includes(
                    run.status,
                  ),
                );
                if (active)
                  p.turnItems.push(
                    syntheticTurnItem(payload.threadId, p.turnItems.length, {
                      type: "user_message",
                      messageId: payload.messageId,
                      runId: active.id,
                    }),
                  );
              }
              if (
                payload.threadId.startsWith("thread:delegated-task:") &&
                payload.dispatchMode?.type !== "steer_active"
              )
                recordFollowUp(payload);
              break;
            }
            case "thread.stop":
              for (const run of p.runs) run.status = "cancelled";
              break;
            case "thread.archive":
              p.thread.archivedAt = STAMP;
              break;
            case "thread.unarchive":
              if (!p.thread.archivedAt)
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    message: "Thread is not archived.",
                  },
                });
              p.thread.archivedAt = null;
              break;
            case "thread.delete":
              // The nightly cancels active work and answers success; `onlyIfUnused`
              // is the shape that silently changes nothing, so it must not be sent.
              assert.equal(
                payload.onlyIfUnused,
                undefined,
                "thread.delete must not ask the nightly to skip a used thread",
              );
              if (p.thread.deletedAt === null) p.thread.deletedAt = STAMP;
              for (const run of p.runs)
                if (
                  [
                    "preparing",
                    "queued",
                    "starting",
                    "running",
                    "waiting",
                  ].includes(run.status)
                )
                  run.status = "cancelled";
              break;
            case "thread.settle":
              if (
                payload.expectedLatestRunId &&
                p.runs.at(-1)?.id !== payload.expectedLatestRunId
              )
                return failure({
                  _tag: "Die",
                  defect: "Latest run changed before thread settlement.",
                });
              p.thread.settledOverride = "settled";
              p.thread.settledAt = payload.settledAt ?? STAMP;
              break;
            case "thread.unsettle": {
              // One-shot faults, in command order: "drops" loses the command before T3
              // applies it; "lands" applies it and then loses the reply (unknown delivery).
              const fault = controls.unsettleFaults.shift();
              if (fault === "drops") return socket.destroy();
              if (controls.unsettleLagReads > 0)
                p.unsettleLagReads = controls.unsettleLagReads;
              else {
                p.thread.settledOverride = "active";
                p.thread.settledAt = null;
              }
              if (fault === "lands") return socket.destroy();
              break;
            }
            case "thread.snooze": {
              // The nightly's own guards (nucleus#1366): a wake time in the future,
              // no pending non-user-input approval, no queued user run, not archived.
              const until = Date.parse(payload.snoozedUntil);
              if (p.thread.archivedAt !== null)
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    message: "Thread is archived.",
                  },
                });
              if (!Number.isFinite(until) || until <= Date.now())
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    message: "snooze wake time is not in the future.",
                  },
                });
              if (
                p.runtimeRequests.some(
                  (request: Value) =>
                    request.status === "pending" &&
                    request.kind !== "user_input",
                )
              )
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    message:
                      "Thread has a pending approval and cannot be snoozed.",
                  },
                });
              if (p.runs.some((run: Value) => run.status === "queued"))
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    message: "Thread has a queued run and cannot be snoozed.",
                  },
                });
              p.thread.snoozedUntil = payload.snoozedUntil;
              p.thread.snoozedAt = STAMP;
              break;
            }
            case "thread.pin":
              p.thread.pinnedAt = STAMP;
              break;
            case "thread.unsnooze":
              p.thread.snoozedUntil = null;
              p.thread.snoozedAt = null;
              break;
            case "thread.metadata.update":
              if (payload.title !== undefined) p.thread.title = payload.title;
              break;
            case "thread.tag.set": {
              // The nightly's ThreadTag rule (recorded contract `thread.tag.set`).
              assert.equal(
                typeof payload.tag,
                "string",
                "thread.tag.set.tag is a tag string",
              );
              assert.ok(
                payload.tag.trim().length > 0 && payload.tag.length <= 64,
                "thread.tag.set.tag obeys TrimmedNonEmptyString and the 64-character cap",
              );
              assert.ok(
                !/[\u0000-\u001f\u007f]/.test(payload.tag),
                "thread.tag.set.tag is a single line of text",
              );
              assert.equal(
                typeof payload.tagged,
                "boolean",
                "thread.tag.set.tagged is the set or remove flag",
              );
              const tags: string[] = p.thread.tags ?? [];
              const next =
                payload.tagged === true
                  ? [
                      ...new Set([
                        ...tags.filter((tag) => tag !== payload.tag),
                        payload.tag,
                      ]),
                    ]
                  : tags.filter((tag) => tag !== payload.tag);
              p.thread.tags = next;
              break;
            }
            case "thread.created.record": {
              const parent = threads.get(payload.parentThreadId);
              assert.ok(
                parent,
                "thread.created.record names an existing parent thread",
              );
              const parentRun = (parent!.runs ?? []).find(
                (run: Value) => run.id === payload.parentRunId,
              );
              assert.ok(
                parentRun,
                "thread.created.record names an existing parent run",
              );
              // The dispatch handler's own guards (recorded contract `parentGuards`).
              assert.equal(
                parentRun!.rootNodeId,
                payload.parentNodeId,
                "the parent node is the root of the parent run",
              );
              assert.equal(
                parent!.thread.projectId,
                p.thread.projectId,
                "the target thread belongs to the parent project",
              );
              if (payload.targetRunId !== null)
                assert.ok(
                  (p.runs ?? []).some(
                    (run: Value) => run.id === payload.targetRunId,
                  ),
                  "the target run belongs to the target thread",
                );
              // One card per command: the receipt ledger makes a replay idempotent.
              const itemId = `synthetic-created-${payload.commandId}`;
              if (
                !(parent!.turnItems ?? []).some(
                  (item: Value) => item.id === itemId,
                )
              )
                parent!.turnItems = [
                  ...(parent!.turnItems ?? []),
                  syntheticTurnItem(payload.parentThreadId, 1, {
                    id: itemId,
                    type: "thread_created",
                    runId: payload.parentRunId,
                    nodeId: payload.parentNodeId,
                    title: p.thread.title,
                    targetThreadId: payload.targetThreadId,
                    targetRunId: payload.targetRunId,
                    targetProviderInstanceId: p.thread.providerInstanceId,
                    targetModel: p.thread.modelSelection.model,
                  }),
                ];
              break;
            }
            case "delegated_task.request": {
              if (controls.timeoutDelegatedLaunch) {
                controls.timeoutDelegatedLaunch = false;
                return;
              }
              // The nightly's own rule: a child created with a workspace strategy is
              // dispatched defer_start and never starts outside T3's MCP handler.
              assert.equal(
                payload.workspaceStrategy,
                undefined,
                "a delegated child is created without a workspace strategy",
              );
              if (payload.completionWake !== undefined)
                assert.ok(
                  contract.commands[
                    "delegated_task.request"
                  ].completionWakeValues.includes(payload.completionWake),
                );
              const parentId = payload.parentThreadId;
              const parent = threads.get(parentId);
              assert.ok(
                parent,
                "delegated_task.request names an existing parent thread",
              );
              const run = (parent!.runs ?? []).find(
                (candidate: Value) => candidate.id === payload.parentRunId,
              );
              const live = ["preparing", "starting", "running", "waiting"];
              if (!run || !live.includes(run.status))
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    commandId: payload.commandId,
                    message: `Parent run ${payload.parentRunId} is not active.`,
                  },
                });
              assert.equal(
                run.rootNodeId,
                payload.parentNodeId,
                "the parent node is the root of the held run",
              );
              const childId = `thread:delegated-task:${payload.commandId}`;
              const taskId = `node:delegated-task:${payload.commandId}`;
              const child = threadProjection(
                childId,
                parent!.thread.worktreePath,
              );
              child.thread.title = payload.title ?? "Delegated task";
              child.thread.modelSelection = payload.modelSelection;
              child.thread.providerInstanceId =
                payload.modelSelection.instanceId;
              child.thread.runtimeMode = payload.runtimeMode;
              child.thread.lineage = {
                parentThreadId: parentId,
                relationshipToParent: "subagent",
                rootThreadId: parent!.thread.lineage?.rootThreadId ?? parentId,
              };
              child.thread.forkedFrom = { type: "node", nodeId: taskId };
              child.runs =
                controls.childRunOnCreate === false
                  ? []
                  : [
                      syntheticRun(childId, 1, {
                        id: `run:${payload.commandId}`,
                        status: "running",
                        rootNodeId: `node:root:${payload.commandId}`,
                      }),
                    ];
              child.messages.push({
                id: `message:delegated-task:${payload.commandId}`,
                role: "user",
                text: payload.task,
              });
              threads.set(childId, child);
              parent!.subagents = [
                ...(parent!.subagents ?? []),
                syntheticSubagent({
                  id: taskId,
                  threadId: parentId,
                  runId: payload.parentRunId,
                  parentNodeId: payload.parentNodeId,
                  driver: "codex",
                  providerInstanceId: payload.modelSelection.instanceId,
                  childThreadId: childId,
                  prompt: payload.task,
                  title: payload.title ?? null,
                  model: payload.modelSelection.model,
                  status: "running",
                  ...(payload.completionWake === undefined
                    ? {}
                    : { completionWake: payload.completionWake }),
                }),
              ];
              break;
            }
            case "delegated_task.completion-delivery.dispose": {
              const parent = threads.get(payload.parentThreadId);
              assert.ok(parent, "a dispose names an existing parent thread");
              const task = (parent!.subagents ?? []).find(
                (candidate: Value) =>
                  candidate.id === payload.taskId &&
                  candidate.origin === "app_owned",
              );
              if (!task)
                return failure({
                  _tag: "Fail",
                  error: {
                    _tag: "OrchestrationV2DispatchCommandError",
                    commandId: payload.commandId,
                    message: `Delegated task ${payload.taskId} is not an app-owned task of thread ${payload.parentThreadId}.`,
                  },
                });
              task.completionDelivery = {
                state: "disposed",
                observedByRunId: null,
              };
              break;
            }
            case "delegated_task.wake-policy": {
              const parent = threads.get(payload.parentThreadId)!;
              const task = (parent.subagents ?? []).find(
                (candidate: Value) => candidate.id === payload.taskId,
              );
              assert.ok(task, "a wake policy names an existing delegated task");
              task!.completionWake = payload.completionWake;
              break;
            }
            case "runtime-request.respond": {
              const item = p.runtimeRequests.find(
                (r: Value) => r.id === payload.requestId,
              )!;
              item.status = "resolved";
              if (
                item.kind === "user_input" &&
                (payload.decision === "cancel" ||
                  payload.decision === "decline")
              ) {
                const card = p.turnItems.find(
                  (row: Value) => row.requestId === payload.requestId,
                );
                if (card) card.status = "cancelled";
              }
              if (payload.answers) item.answers = payload.answers;
              break;
            }
            case "thread.user-input.dismiss":
              p.runtimeRequests.find(
                (r: Value) => r.id === payload.requestId,
              )!.status = "cancelled";
              break;
          }
          if (controls.disconnectAfterEffect) return socket.destroy();
          if (controls.postEffectDefect)
            return failure({
              _tag: "Die",
              defect: contract.boundaryDecodeExample,
            });
          if (controls.secretDefect)
            return failure({
              _tag: "Die",
              defect: 'Expected synthetic-secret got value\n  at ["text"]',
            });
          if (controls.secretLocationDefect)
            return failure({
              _tag: "Die",
              defect: 'Missing key\n  at ["synthetic_secret"]',
            });
          return success({ sequence: 1 });
        }
        case "projects.mutate": {
          const mutation = contract.projectMutation;
          if (payload.type === "project.update") {
            for (const field of mutation.updateRequired)
              assert.ok(
                Object.hasOwn(payload, field),
                `projects.mutate.${field}`,
              );
            commands.push({ method: request.tag, ...payload });
            controls.mutationObserver();
            if (controls.refuseMutation)
              return failure({
                _tag: "Die",
                defect: contract.boundaryDecodeExample,
              });
            if (controls.disconnectMutation) return socket.destroy();
            const project = projectRows.find(
              (row: Value) => row.id === payload.projectId,
            );
            if (!project)
              return failure({
                _tag: "Fail",
                error: {
                  _tag: "ProjectMutationError",
                  commandId: payload.commandId,
                  message: "Failed to mutate project.",
                },
              });
            if (typeof payload.title === "string")
              project.title = payload.title;
            if (payload.archived === true)
              archivedProjects.add(payload.projectId);
            else if (payload.archived === false)
              archivedProjects.delete(payload.projectId);
            if (controls.disconnectAfterEffect) return socket.destroy();
            return success({
              ...project,
              archivedAt: payload.archived ? STAMP : null,
            });
          }
          assert.equal(
            payload.type,
            "project.create",
            "only project.create and project.update mutations are exercised",
          );
          for (const field of mutation.createRequired)
            assert.ok(
              Object.hasOwn(payload, field),
              `projects.mutate.${field}`,
            );
          commands.push({ method: request.tag, ...payload });
          controls.mutationObserver();
          if (controls.refuseMutation)
            return failure({
              _tag: "Die",
              defect: contract.boundaryDecodeExample,
            });
          if (controls.disconnectMutation) return socket.destroy();
          if (controls.unsupportedProjectCreate)
            return failure({
              _tag: "Die",
              defect: `Unknown request tag: ${mutation.method}`,
            });
          if (controls.projectMutationFailure)
            return failure({
              _tag: "Fail",
              error: {
                _tag: "ProjectMutationError",
                commandId: payload.commandId,
                message: "Failed to mutate project.",
              },
            });
          if (controls.projectMutationSecretFailure)
            return failure({
              _tag: "Fail",
              error: {
                _tag: "ProjectMutationError",
                commandId: payload.commandId,
                message: "Failed for api_key=synthetic-secret",
              },
            });
          if (controls.projectMutationIdSecretFailure)
            return failure({
              _tag: "Fail",
              error: {
                _tag: "ProjectMutationError",
                commandId: payload.commandId,
                message: "Project synthetic-secret is not empty.",
              },
            });
          const project = (
            id: string,
            title: string,
            workspaceRoot: string,
          ) => ({
            id,
            title,
            workspaceRoot,
            repositoryIdentity: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: STAMP,
            updatedAt: STAMP,
            deletedAt: null,
          });
          const receipt = projectReceipts.get(payload.commandId);
          if (receipt) {
            assert.equal(
              receipt.type,
              payload.type,
              "a command id is never reused for another mutation",
            );
            const settled = projectRows.find(
              (row: Value) => row.id === receipt.projectId,
            )!;
            return success(
              project(settled.id, settled.title, settled.workspaceRoot),
            );
          }
          const owner = projectRows.find(
            (row: Value) => row.workspaceRoot === payload.workspaceRoot,
          );
          if (owner)
            return failure({
              _tag: "Fail",
              error: {
                _tag: "ProjectMutationError",
                commandId: payload.commandId,
                message: "Failed to mutate project.",
              },
            });
          projectRows.push({
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
          });
          projectReceipts.set(payload.commandId, {
            type: payload.type,
            projectId: payload.projectId,
          });
          if (controls.disconnectAfterEffect) return socket.destroy();
          return success(
            project(payload.projectId, payload.title, payload.workspaceRoot),
          );
        }
        default:
          return failure({
            _tag: "Die",
            defect: `Unknown request tag: ${request.tag}`,
          });
      }
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127,
          offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = Boolean(buffer[1]! & 128);
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask)
          for (let i = 0; i < payload.length; i++)
            payload[i] = payload[i]! ^ mask[i % 4]!;
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode === 1) handle(JSON.parse(payload.toString()));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  /** Drops every live WebSocket, as a T3 restart or network reset does. */
  const dropSockets = () => {
    for (const socket of sockets) socket.destroy();
  };
  const inject = (value: unknown) => {
    for (const write of injectors) write(JSON.stringify(value));
  };
  const injectRaw = (text: string) => {
    for (const write of injectors) write(text);
  };
  const fullSnapshotBytes = (threadId: string) =>
    Buffer.byteLength(
      JSON.stringify({
        _tag: "Chunk",
        requestId: "synthetic-request",
        values: [
          {
            kind: "snapshot",
            snapshotSequence: controls.snapshotSequence,
            projection: wireProjection(threads.get(threadId)!),
          },
        ],
      }),
    );
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    controls,
    threads,
    previews,
    commands,
    requests,
    snapshots,
    threadReads,
    shells,
    unauthorized,
    bearers,
    controlFrames,
    frameBytes,
    fullSnapshotBytes,
    get upgrades() {
      return upgrades;
    },
    get closes() {
      return closes;
    },
    projects: projectRows,
    dropSockets,
    inject,
    injectRaw,
  };
}
