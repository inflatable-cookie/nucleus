import test from "node:test";
import assert from "node:assert/strict";
import { taskControlInputSchema } from "../shared/contracts";

test("force is retained for a reasoned owner move and effect settlement", () => {
  for (const control of [
    { action: "move", to: "closeout" },
    { action: "retry_effect", effect: "workspace_archive.example" },
  ]) {
    const parsed = taskControlInputSchema.parse({
      ...control,
      taskId: "task",
      version: 1,
      reason: "Owner resolved the gate",
      force: true,
    });
    assert.equal((parsed as { force?: boolean }).force, true);
  }
});

test("forced settlement names its effect and force is limited to the two owner verbs", () => {
  const base = {
    taskId: "task",
    version: 1,
    reason: "Owner resolved the gate",
    force: true,
  };
  assert.equal(
    taskControlInputSchema.safeParse({ ...base, action: "retry_effect" })
      .success,
    false,
  );
  assert.equal(
    taskControlInputSchema.safeParse({ ...base, action: "stop" }).success,
    false,
  );
  assert.equal(
    taskControlInputSchema.safeParse({
      ...base,
      action: "move",
      to: "work",
      reason: "",
    }).success,
    false,
  );
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { runSchema, submissionSchema, type Task } from "../shared/contracts";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
} from "../core/verbs/owner-verbs";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  base = "b".repeat(40);
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "force-contract-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Force",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  let calls = 0;
  const remote = { merged: true };
  const adapter = {
    merged: async () => ({
      merged: remote.merged,
      commit: remote.merged ? base : null,
      head,
      base: "main",
    }),
    verifyPr: async () => ({
      url: "https://github.com/example/repo/pull/7",
      head,
    }),
    verifyPrIdentity: async (_task: Task, number: number) => ({
      url: `https://github.com/example/repo/pull/${number}`,
      head,
      repository: "example/repo",
      headRepository: "example/repo",
    }),
    merge: async () => {
      calls++;
    },
    observe: async () => {
      calls++;
      throw Error("must not observe");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  // Exercise the authenticated durable payload exactly once under test control.
  (
    engine as unknown as { scheduleOperation(id: string): void }
  ).scheduleOperation = () => {};
  store.setMeta("paused", false);
  store.update(task.id, {
    phase: "needs_attention",
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/7",
    resumePrNumber: 7,
    resolution: {
      ...store.task(task.id).resolution,
      attention: true,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  store.setCredential("worker-run", "secret");
  store.update(task.id, {
    runId: "worker-run",
    agentId: "worker",
    completion: null,
  });
  const current = () => store.task(task.id);
  const apply = (fields: Record<string, unknown>) =>
    engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: current().version,
        caller: "operator (board)",
        reason: "Resolved by owner",
        ...fields,
      }),
    );
  return {
    store,
    engine,
    adapter,
    task: current,
    apply,
    remote,
    calls: () => calls,
  };
}

async function selfApply(
  f: Awaited<ReturnType<typeof fixture>>,
  fields: Record<string, unknown>,
  runId = "worker-run",
) {
  const input = taskControlInputSchema.parse({
    taskId: f.task().id,
    version: f.task().version,
    force: true,
    reason: "Observed idle, no tool child",
    ...fields,
  });
  const accepted = await f.engine.taskControlFromAgent(
    { taskId: f.task().id, runId, token: "secret" },
    input,
  );
  assert.ok("operation" in accepted);
  const operation = accepted.operation;
  return (
    f.engine as unknown as {
      performOperation(op: unknown, payload: unknown): Promise<unknown>;
    }
  ).performOperation(operation, f.store.operationPayload(operation.id));
}
test("authenticated worker force settles own effect and moves; typed identity and other task refuse", async () => {
  const f = await fixture();
  try {
    f.store.event(
      f.task().id,
      "owned_tool_hold",
      JSON.stringify({ runId: "tool", reason: "idle" }),
    );
    await selfApply(f, { action: "retry_effect", effect: "owned_tool.tool" });
    assert.equal(
      f.task().resolution.ownerSettlements.at(-1)?.source,
      "task_worker",
    );
    await assert.rejects(
      f.engine.taskControlFromAgent(
        { taskId: "other", runId: "worker-run", token: "secret" },
        taskControlInputSchema.parse({
          taskId: f.task().id,
          version: f.task().version,
          action: "move",
          to: "work",
          force: true,
          reason: "idle",
        }),
      ),
      /own task/,
    );
    await assert.rejects(
      f.apply({ action: "move", to: "work", force: true, caller: "worker" }),
      /authenticated/,
    );
    await selfApply(f, { action: "move", to: "work" });
    assert.equal(f.task().phase, "changes_requested");
  } finally {
    f.store.close();
  }
});
test("critical blocks authenticated worker force and planner still works", async () => {
  const f = await fixture();
  try {
    f.store.update(f.task().id, { critical: true });
    await assert.rejects(
      selfApply(f, { action: "move", to: "work" }),
      /critical/,
    );
    await f.apply({ action: "move", to: "work", force: true });
    assert.equal(f.task().phase, "changes_requested");
  } finally {
    f.store.close();
  }
});

function bindRole(
  f: Awaited<ReturnType<typeof fixture>>,
  role: "reviewer" | "recovery",
) {
  const id = `${role}-run`,
    agentId = `${role}-agent`;
  const run = runSchema.parse({
    id,
    taskId: f.task().id,
    role,
    generation: 1,
    head,
    base,
    agentId,
    workspaceId: "workspace",
    profile: null,
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.store.putRun(run);
  f.store.setCredential(id, "secret");
  f.adapter.observe = async (observed) =>
    ({
      id: observed,
      workspaceId: "workspace",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }) as never;
  f.store.update(f.task().id, {
    resolution: {
      ...f.task().resolution,
      currentRunId: id,
      ...(role === "reviewer"
        ? { reviewerAgentId: agentId }
        : {
            recovery: {
              id: "recovery",
              key: "fault",
              generation: 1,
              runId: id,
              agentId,
              status: "running",
              summary: "",
              idleSince: null,
              incidentId: null,
            },
          }),
    },
  });
  return run;
}
function appliedReview(
  f: Awaited<ReturnType<typeof fixture>>,
  runId = "verdict-run",
  agentId = "reviewer-agent",
) {
  const run = runSchema.parse({
    id: runId,
    taskId: f.task().id,
    role: "reviewer",
    generation: 1,
    head,
    base,
    agentId,
    workspaceId: "workspace",
    profile: null,
    status: "finished",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: true,
  });
  f.store.putRun(run);
  f.store.update(f.task().id, {
    resolution: {
      ...f.task().resolution,
      review: {
        taskId: f.task().id,
        runId,
        eventId: "review-event",
        status: "ready_to_merge",
        summary: "Approved",
        head,
      },
    },
  });
}
const failedJob = "https://github.com/example/repo/actions/runs/1/job/2";
function failedChecks(
  f: Awaited<ReturnType<typeof fixture>>,
  required = false,
) {
  f.remote.merged = false;
  f.adapter.mergeGate = async (_task, _history, _reviewer, policy) =>
    ({
      head,
      base,
      wait:
        policy === "required" && !required ? "" : "Failed check: macos-gateway",
      checksFailed: policy !== "required" || required,
      requirements: { known: true, required: required ? 1 : 0 },
      advisory: [
        {
          identity: "CheckRun",
          name: "macos-gateway",
          state: "COMPLETED",
          conclusion: "FAILURE",
          jobUrl: failedJob,
        },
      ],
    }) as never;
}
for (const role of ["reviewer", "recovery"] as const) {
  test(`authenticated ${role} force settles its own effect; critical refuses`, async () => {
    const f = await fixture();
    try {
      const run = bindRole(f, role);
      f.store.event(
        f.task().id,
        "owned_tool_hold",
        JSON.stringify({ runId: "tool", reason: "idle" }),
      );
      await selfApply(
        f,
        { action: "retry_effect", effect: "owned_tool.tool" },
        run.id,
      );
      assert.equal(
        f.task().resolution.ownerSettlements.at(-1)?.source,
        `task_${role}`,
      );
      f.store.update(f.task().id, { critical: true });
      await assert.rejects(
        selfApply(f, { action: "move", to: "work" }, run.id),
        /critical/,
      );
    } finally {
      f.store.close();
    }
  });
}
for (const role of ["worker", "recovery"] as const) {
  test(`${role} cannot force a merge past failed checks`, async () => {
    const f = await fixture();
    try {
      const id = role === "recovery" ? bindRole(f, role).id : "worker-run";
      appliedReview(f);
      failedChecks(f);
      await assert.rejects(
        selfApply(f, { action: "move", to: "merge" }, id),
        /cannot force merge past a failed check/,
      );
      assert.equal(f.task().resolution.mergeIntent, false);
    } finally {
      f.store.close();
    }
  });
}
test("retained reviewer fresh run may force only its own applied exact-head verdict with named nonrequired failures", async () => {
  const f = await fixture();
  try {
    const run = bindRole(f, "reviewer");
    appliedReview(f);
    failedChecks(f);
    const gate = f.adapter.mergeGate;
    f.adapter.mergeGate = async (...args) => {
      const result = await gate(...args);
      if (args[3] !== "required") {
        const {
          requirements: _requirements,
          advisory: _advisory,
          ...ordinary
        } = result;
        return ordinary;
      }
      return result;
    };
    await selfApply(
      f,
      {
        action: "move",
        to: "merge",
        reason: `macos-gateway ${failedJob}: unrelated infrastructure failure; this diff cannot have caused it`,
      },
      run.id,
    );
    assert.deepEqual(f.task().resolution.forcedChecks[0].checks, [
      { name: "macos-gateway", jobUrl: failedJob },
    ]);
  } finally {
    f.store.close();
  }
});
for (const defect of [
  "different-reviewer",
  "stale-head",
  "required-check",
  "unnamed-check",
] as const) {
  test(`reviewer force refuses ${defect}`, async () => {
    const f = await fixture();
    try {
      const run = bindRole(f, "reviewer");
      appliedReview(
        f,
        "verdict-run",
        defect === "different-reviewer" ? "other-reviewer" : run.agentId!,
      );
      failedChecks(f, defect === "required-check");
      if (defect === "stale-head")
        f.store.update(f.task().id, {
          resolution: {
            ...f.task().resolution,
            review: { ...f.task().resolution.review!, head: base },
          },
        });
      await assert.rejects(
        selfApply(
          f,
          {
            action: "move",
            to: "merge",
            reason:
              defect === "unnamed-check"
                ? "Unrelated failure"
                : `macos-gateway ${failedJob}: unrelated failure; this diff cannot have caused it`,
          },
          run.id,
        ),
        /own applied verdict|exact head|required or unknown|Name each failed check/,
      );
      assert.equal(f.task().resolution.mergeIntent, false);
    } finally {
      f.store.close();
    }
  });
}

import {
  workerPrompt,
  runPrompt,
  RESPONSIBLE_FORCE_RULE,
} from "../core/dispatch/prompts";
test("worker, reviewer and recovery prompts explain observed self-force without repeating code gates", async () => {
  const f = await fixture();
  try {
    const reviewer = bindRole(f, "reviewer"),
      recovery = bindRole(f, "recovery");
    for (const critical of [false, true]) {
      const task = { ...f.task(), critical };
      for (const prompt of [
        workerPrompt(task, true),
        runPrompt(task, reviewer, "helper", "ticket", true),
        runPrompt(task, recovery, "helper", "ticket", true),
      ]) {
        assert.ok(prompt.includes(RESPONSIBLE_FORCE_RULE));
        assert.match(prompt, /observed evidence/);
        assert.match(prompt, /bookkeeping stop/);
        assert.match(prompt, /nucleus task -/);
        assert.match(prompt, /this run's credential/);
        assert.match(prompt, /nucleus_report does not accept force/);
        assert.doesNotMatch(prompt, /critical task prohibits every task-thread force/);
        assert.doesNotMatch(prompt, /Workers and recovery cannot bypass failed checks/);
        assert.match(prompt, /job URL and why this diff cannot have caused it/);
        assert.doesNotMatch(prompt, /Critical task: no self-force/);
      }
    }
  } finally {
    f.store.close();
  }
});

test("self-force cannot erase a planner or operator hold", async () => {
  const f = await fixture();
  try {
    await f.apply({
      action: "hold",
      kind: "merge",
      reason: "Waiting for release authority",
    });
    await assert.rejects(
      selfApply(f, { action: "move", to: "work" }),
      /hold|disposition/,
    );
    assert.equal(f.task().mergeHold, true);
  } finally {
    f.store.close();
  }
});

test("callback self-force authenticates the run and refuses a foreign task", async () => {
  const f = await fixture();
  const directory = mkdtempSync(join(tmpdir(), "self-force-callback-"));
  const socketPath = join(directory, "callback.sock");
  const { startCallbacks } = await import("../service/callbacks/callback");
  const { callbackRequest } = await import("../shared/service/callback-client.mjs");
  const stop = await startCallbacks(
    socketPath,
    join(directory, "helper.mjs"),
    f.engine,
  );
  try {
    const other = f.store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Other",
        repoPath: "/other",
        planningCommit: base,
        handoffPath: "h",
        originAgentId: "origin",
      }),
      "host",
      "h",
      base,
    );
    const input = {
      taskId: other.id,
      version: other.version,
      action: "move",
      to: "work",
      force: true,
      reason: "Observed idle with no tool child",
    };
    await assert.rejects(
      callbackRequest({ socketPath, token: "secret" }, "/task-control", {
        callerTaskId: other.id,
        callerRunId: "worker-run",
        input,
      }),
      /Stale assignment/,
    );
    input.taskId = f.task().id;
    input.version = f.task().version;
    await assert.rejects(
      callbackRequest({ socketPath, token: "wrong" }, "/task-control", {
        callerTaskId: f.task().id,
        callerRunId: "worker-run",
        input,
      }),
      /Unauthorized callback/,
    );
    const receipt = await callbackRequest<{ accepted: boolean }>(
      { socketPath, token: "secret" },
      "/task-control",
      { callerTaskId: f.task().id, callerRunId: "worker-run", input },
    );
    assert.equal(receipt.accepted, true);
  } finally {
    await stop();
    f.store.close();
  }
});
