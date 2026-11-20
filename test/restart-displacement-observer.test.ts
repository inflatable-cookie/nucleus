/**
 * Spec 066 operation observer for historical task-control restart sends.
 *
 * A restart whose transport was lost stays uncertain after the task has moved
 * on. The observer settles that exact occurrence only on positive evidence that
 * it can neither land nor affect current custody. Later phase and missing
 * inventory alone never settle it, and a settled occurrence is never resent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  digest,
  operationIdForKey,
  operationInputHash,
} from "../core/store/store";
import {
  blockingRecoveryEffects,
  blockingTaskOperations,
  observedHostEffectEvidence,
  recoveryEffects,
} from "../core/recovery/recovery-effects";
import {
  blockedEffectAttentionReason,
  settleObservedHostEffectOperations,
} from "../core/recovery/effect-gates";
import { releaseRunFromRecordedCompletion } from "../core/recovery/fence-settlement";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { taskControlOperation } from "../core/verbs/task-control-key";
import { queueOperationSchema } from "../shared/operations";
import {
  runSchema,
  submissionSchema,
  taskControlInputSchema,
  type Completion,
  type Run,
  type Task,
} from "../shared/contracts";

const head = "a".repeat(40),
  base = "b".repeat(40),
  at = "2026-01-01T00:00:00.000Z";

function openTask(path = ":memory:") {
  const store = new Store(path);
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "restart-observer",
      title: "Interrupted restart",
      repoPath: "/fixture",
      planningCommit: base,
      handoffPath: "brief.md",
      originAgentId: "origin",
    }),
    "host",
    "brief",
    base,
  );
  return { store, task };
}

function reviewRun(
  store: Store,
  task: Task,
  overrides: Partial<Run> & { id: string },
): Run {
  store.putRun(
    runSchema.parse({
      taskId: task.id,
      role: "reviewer",
      generation: 1,
      head,
      base,
      agentId: "review-agent",
      workspaceId: "workspace",
      profile: null,
      status: "finished",
      createdAt: at,
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: true,
      ...overrides,
    }),
  );
  return store.run(overrides.id)!;
}

/** The accepted receipt the callback path writes for a completion. */
function acceptCompletion(store: Store, taskId: string, completion: Completion) {
  store.db
    .prepare(
      "INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)",
    )
    .run(
      completion.eventId,
      taskId,
      completion.runId,
      digest(JSON.stringify(completion)),
      JSON.stringify({ accepted: true, eventId: completion.eventId }),
    );
}

const reviewCompletion = (taskId: string, runId: string): Completion => ({
  eventId: `${runId}-event`,
  taskId,
  runId,
  status: "changes_required",
  summary: "Historical findings",
  head,
  reviewText: "Substantive historical findings: fix the links",
});

/**
 * One restart whose send was uncertain after transport loss, shaped as the
 * stored record: needs_attention, uncertain effect, Transport diagnostic,
 * one attempt, null result and no pre-send receipt.
 */
function interruptedRestart(
  store: Store,
  task: Task,
  options: {
    instruction?: string;
    role?: "reviewer" | "worker";
  } = {},
) {
  const accepted = new Date(Date.now() - 60_000).toISOString();
  const input = taskControlInputSchema.parse({
    taskId: task.id,
    version: store.task(task.id).version,
    action: "restart",
    role: options.role ?? "reviewer",
    caller: "owner",
    reason: "Continue",
    ...(options.instruction ? { instruction: options.instruction } : {}),
  });
  const { key, payload } = taskControlOperation(input);
  const id = operationIdForKey(key);
  store.putOperation(
    queueOperationSchema.parse({
      id,
      key,
      kind: "task_control",
      inputHash: operationInputHash(payload),
      state: "needs_attention",
      taskId: task.id,
      expectedVersion: input.version,
      createdAt: accepted,
      startedAt: accepted,
      settledAt: accepted,
      attempts: 1,
      diagnostic: "Transport",
      result: null,
      effect: {
        kind: "task_control",
        target: "restart",
        intentAt: accepted,
        status: "uncertain",
        result: null,
        resultAt: null,
      },
    }),
    payload,
  );
  return { id, expectedVersion: input.version };
}

/**
 * The target that was possibly live at the send: a finished reviewer with an
 * accepted completion, then the task advanced past it with a fresh binding.
 */
function displacedTarget(
  store: Store,
  task: Task,
  options: {
    accepted?: boolean;
    released?: boolean;
    archived?: boolean;
    laterBinding?: boolean;
  } = {},
) {
  const completion = reviewCompletion(task.id, "target-run");
  reviewRun(store, task, {
    id: "target-run",
    agentId: "target-agent",
    status: "finished",
    released: false,
    completion,
    createdAt: at,
  });
  if (options.accepted !== false) acceptCompletion(store, task.id, completion);
  store.update(task.id, { reason: "Advanced past the interrupted restart" });
  if (options.laterBinding !== false)
    reviewRun(store, task, {
      id: "replacement-run",
      agentId: "replacement-agent",
      status: "running",
      released: false,
      createdAt: new Date().toISOString(),
    });
  if (options.released !== false)
    releaseRunFromRecordedCompletion(store, task.id, store.run("target-run")!);
  if (options.archived)
    store.putThreadArchiveEffect(
      store.threadArchiveKey("target-agent", task.hostId)!,
      "target-agent",
      { status: "archived", at: new Date().toISOString() },
    );
}

const restartEvents = (store: Store, taskId: string) =>
  store
    .eventsAll(taskId)
    .filter((event) => event.kind === "operation_superseded");

const retryOffers = (store: Store, task: Task) =>
  ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id))).verbs.filter(
    (view) => view.verb === "retry_effect",
  );

test("a restart target released from its completed run and archived settles once", () => {
  const { store, task } = openTask();
  try {
    const { id } = interruptedRestart(store, task);
    displacedTarget(store, task, { archived: true });
    assert.match(
      observedHostEffectEvidence(store, store.task(task.id), store.operation(id)!) ??
        "",
      /restart role reviewer targets target-run were released/,
    );
    assert.equal(blockingTaskOperations(store, store.task(task.id)).length, 0);
    settleObservedHostEffectOperations(store, task.id);
    const settled = store.operation(id)!;
    assert.equal(settled.settlement?.kind, "superseded");
    assert.equal(settled.effect?.status, "uncertain", "history is kept");
    assert.equal(settled.result, null);
    assert.equal(restartEvents(store, task.id).length, 1);
    assert.equal(
      recoveryEffects(store, store.task(task.id), { kinds: ["operation"] })[0]
        ?.state,
      "superseded",
    );
    assert.equal(
      retryOffers(store, task).some((view) => view.available),
      false,
      "a settled restart offers no retry",
    );
    settleObservedHostEffectOperations(store, task.id);
    assert.equal(restartEvents(store, task.id).length, 1, "settles once");
  } finally {
    store.close();
  }
});

const twins: Array<[string, Parameters<typeof displacedTarget>[2]]> = [
  ["the thread is not yet archived", { archived: false }],
  ["the target completion was never accepted", { accepted: false, archived: true }],
  ["the target was never released", { released: false, archived: true }],
  ["no later binding or move advanced the task", { laterBinding: false, archived: true }],
];

for (const [name, options] of twins) {
  test(`a restart stays fenced while ${name}, with its cause visible in next`, () => {
    const { store, task } = openTask();
    try {
      const { id } = interruptedRestart(store, task);
      displacedTarget(store, task, options);
      assert.equal(
        observedHostEffectEvidence(store, store.task(task.id), store.operation(id)!),
        null,
      );
      settleObservedHostEffectOperations(store, task.id);
      assert.equal(restartEvents(store, task.id).length, 0);
      assert.equal(blockingTaskOperations(store, store.task(task.id)).length, 1);
      const offers = retryOffers(store, task);
      assert.equal(offers.some((view) => view.available), false);
      assert.ok(
        offers.some((view) => view.refusal?.includes(id)),
        "the blocker is named, not hidden",
      );
    } finally {
      store.close();
    }
  });
}

test("an independent uncertain restart keeps its own fence after the displaced one settles", () => {
  const { store, task } = openTask();
  try {
    const displaced = interruptedRestart(store, task);
    displacedTarget(store, task, { archived: true });
    const other = interruptedRestart(store, store.task(task.id), {
      role: "worker",
      instruction: "A separate worker restart with no observed target",
    });
    settleObservedHostEffectOperations(store, task.id);
    assert.equal(store.operation(displaced.id)?.settlement?.kind, "superseded");
    assert.equal(store.operation(other.id)?.settlement, undefined);
    const blocking = blockingRecoveryEffects(store, store.task(task.id), {
      kinds: ["operation"],
    });
    assert.deepEqual(
      blocking.map((effect) => effect.identity),
      [other.id],
    );
  } finally {
    store.close();
  }
});

test("replay across a restart keeps one settlement and never resends the send", () => {
  const dir = mkdtempSync(join(tmpdir(), "restart-observer-"));
  const path = join(dir, "queue.sqlite");
  try {
    const first = openTask(path);
    const { id, expectedVersion } = interruptedRestart(first.store, first.task);
    displacedTarget(first.store, first.task, { archived: true });
    settleObservedHostEffectOperations(first.store, first.task.id);
    const taskId = first.task.id;
    const payloadKey = first.store.operation(id)!.key;
    first.store.close();

    const reopened = new Store(path);
    try {
      const store = reopened;
      const task = store.task(taskId);
      const operation = store.operation(id)!;
      assert.equal(operation.settlement?.kind, "superseded");
      assert.equal(operation.expectedVersion, expectedVersion);
      assert.equal(
        observedHostEffectEvidence(store, task, operation),
        "the occurrence has a durable supersession",
        "the persisted settlement answers after restart",
      );
      settleObservedHostEffectOperations(store, taskId);
      assert.equal(restartEvents(store, taskId).length, 1, "no second settlement");
      assert.equal(blockingTaskOperations(store, task).length, 0);
      const repeated = store.acceptOperation({
        key: payloadKey,
        kind: "task_control",
        inputHash: operation.inputHash,
        taskId,
        expectedVersion,
        payload: store.operationPayload(id)!,
      });
      assert.ok("operation" in repeated);
      assert.equal(
        repeated.operation.state,
        "needs_attention",
        "the same key never reopens an uncertain send",
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the attention reason for an observation-only restart names the observer, not a retry", () => {
  const { store, task } = openTask();
  try {
    const { id } = interruptedRestart(store, task);
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    store.update(
      task.id,
      {
        resolution: {
          ...store.task(task.id).resolution,
          stop: {
            reason: "lifecycle",
            detail: `Ordinary review waits for operation ${id} is uncertain: Transport; settle it with retry_effect before continuing`,
            since,
            suggestedVerbs: [],
          },
        },
      },
      "fixture_stop",
      "fixture",
    );
    const reason = blockedEffectAttentionReason(store, store.task(task.id));
    assert.ok(reason, "a blocked wait past its bound is attention");
    assert.match(reason, /observes each restart target on the sweep/);
    assert.doesNotMatch(reason, /retry_effect re-proves/);
  } finally {
    store.close();
  }
});
