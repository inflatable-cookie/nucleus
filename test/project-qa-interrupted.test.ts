import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import {
  ProjectQaRunner,
  QA_INTERRUPTED_PREPARATION_PREFIX,
} from "./project-qa-runner-fixture";
import {
  ProjectQaSchedules,
  qaScheduleStateKey,
} from "../core/qa/project-qa-schedule";
import { qaFenceStatus } from "../core/qa/qa-fence";
import { projectQaRequestSchema, submissionSchema } from "../shared/contracts";

/**
 * Interrupted QA request preparation (2026-10-22, the 601-606 milestone
 * blocker: request queue-reliability-post-attribution-7dab23d9-20261015 stayed
 * `preparing` from 2026-10-15). A request names the writer lease that took it;
 * the current lease holder settles a predecessor's preparation as refused,
 * because the single-writer lease proves that owner can no longer reach its
 * claim and the claim admits a request together with its run. Nothing else
 * is touched, and a settled request can never turn admitted.
 */

const head = "1".repeat(40);

async function fixture(
  t: any,
  options: {
    lease?: "held" | "other" | "none";
    ownerInstance?: string | null;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "queue-qa-interrupted-"));
  const store = new Store(join(root, "queue.sqlite"));
  const owner =
    options.ownerInstance === undefined ? randomUUID() : options.ownerInstance;
  const lease = options.lease ?? "held";
  if (lease !== "none")
    store.setMeta("processOwner", {
      pid: process.pid,
      owner: lease === "held" ? owner : randomUUID(),
    });
  const runner = new ProjectQaRunner(store, {
    dataDir: root,
    hostRunStateDir: join(root, "host"),
    ...(owner ? { ownerInstance: owner } : {}),
  });
  t.after(() => {
    runner.hostRuns.stop();
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const internal = runner as any;
  internal.resolveRepository = async () => ({
    key: "fixture",
    origin: "owner/repo",
    path: root,
    checkoutPath: root,
  });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => head;
  let submits = 0;
  internal.submitToHostScheduler = () => {
    submits++;
  };
  internal.attachQueued = () => {};
  const request = (
    id: string,
    state: "preparing" | "admitted" | "refused",
    ownerInstance: string,
    extra: Record<string, unknown> = {},
  ) =>
    store.setMeta(`projectQaRequest:${id}`, {
      id,
      input: { repository: "owner/repo", baseBranch: "main", requestId: id },
      ownerInstance,
      ownerPid: 33836,
      receivedAt: "2026-10-15T09:02:28.155Z",
      state,
      runId: null,
      diagnostic: state === "refused" ? "fetch failed" : "",
      ...extra,
    });
  const read = (id: string) =>
    store.getMeta<Record<string, unknown>>(`projectQaRequest:${id}`)!;
  return {
    root,
    store,
    runner,
    internal,
    owner,
    request,
    read,
    submits: () => submits,
  };
}

test("the lease holder settles a predecessor's preparation as refused, keeping its identity, and touches nothing else", async (t) => {
  const f = await fixture(t);
  const predecessor = "6512bff2-fd3c-46f2-811a-71ca68515d04";
  f.request("stale", "preparing", predecessor);
  f.request("done", "admitted", predecessor, { runId: "run-1" });
  f.request("failed", "refused", predecessor);
  f.request("mine", "preparing", f.owner!);
  const before = {
    done: f.read("done"),
    failed: f.read("failed"),
    mine: f.read("mine"),
  };
  assert.deepEqual(
    qaFenceStatus(f.store).inventory.map((item) => item.id),
    ["mine", "stale"],
  );
  await f.runner.list();
  const settled = projectQaRequestSchema.parse(f.read("stale"));
  assert.equal(settled.state, "refused");
  assert.equal(settled.id, "stale");
  assert.deepEqual(settled.input, {
    repository: "owner/repo",
    baseBranch: "main",
    requestId: "stale",
  });
  assert.equal(settled.ownerInstance, predecessor);
  assert.equal(settled.ownerPid, 33836);
  assert.equal(settled.receivedAt, "2026-10-15T09:02:28.155Z");
  assert.equal(settled.runId, null);
  assert.ok(settled.settledAt);
  assert.equal(
    settled.refusalCode,
    "interrupted_preparation",
    "a predecessor settlement is a typed lifecycle refusal",
  );
  assert.ok(
    settled.diagnostic.startsWith(
      `${QA_INTERRUPTED_PREPARATION_PREFIX}: its owner ${predecessor} (pid 33836) is a predecessor of the current writer lease ${f.owner}`,
    ),
  );
  assert.match(
    settled.diagnostic,
    /claimed no QA run and submitted no host run\. Retry with a new request ID$/,
  );
  assert.deepEqual(
    { done: f.read("done"), failed: f.read("failed"), mine: f.read("mine") },
    before,
    "admitted, refused and own preparations are untouched",
  );
  assert.deepEqual(
    qaFenceStatus(f.store).inventory.map((item) => item.id),
    ["mine"],
    "only the genuine in-flight preparation stays unsettled",
  );
  // The settled identity reports refused; it is never replayed under the same ID.
  await assert.rejects(
    f.runner.run({
      repository: "owner/repo",
      baseBranch: "main",
      requestId: "stale",
    }),
    /QA request stale is refused: QA request preparation was interrupted/,
  );
  assert.equal(f.submits(), 0);
  // A second sweep is a no-op.
  assert.equal(f.runner.settleInterruptedPreparations(), 0);
});

test("nothing is settled without proof: no lease, a lease held by another owner, no lease identity, or an undecodable owner binding", async (t) => {
  for (const options of [
    { lease: "none" as const },
    { lease: "other" as const },
    { ownerInstance: null },
  ]) {
    const f = await fixture(t, options);
    f.request("stale", "preparing", randomUUID());
    await f.runner.list();
    assert.equal(f.read("stale").state, "preparing", JSON.stringify(options));
  }
  const f = await fixture(t);
  f.request("bad-owner", "preparing", "not-a-uuid");
  f.store.db
    .prepare(
      "INSERT INTO meta(key, value) VALUES ('projectQaRequest:broken', '{')",
    )
    .run();
  assert.equal(f.runner.settleInterruptedPreparations(), 0);
  assert.equal(
    f.read("bad-owner").state,
    "preparing",
    "an owner binding that does not decode is not settled by inference",
  );
});

test("the request records the writer lease as its owner, and a request settled during its awaits is never admitted", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const fetched = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.internal.integrationHead = async () => {
    await fetched;
    return head;
  };
  const delivery = f.runner.run({
    repository: "owner/repo",
    requestId: "racing",
  });
  assert.equal(
    f.read("racing").ownerInstance,
    f.owner,
    "the owner is the lease identity",
  );
  assert.equal(
    f.runner.requestStatus({ requestId: "racing" }).ownerInstance,
    f.owner,
  );
  // Another writer settles it while the fetch is awaited (the CAS is the second safeguard).
  f.store.setMeta("projectQaRequest:racing", {
    ...f.read("racing"),
    state: "refused",
    diagnostic: `${QA_INTERRUPTED_PREPARATION_PREFIX}: test`,
  });
  release();
  await assert.rejects(
    delivery,
    /QA request racing was settled during admission \(refused\); no QA run was claimed/,
  );
  assert.equal(f.read("racing").state, "refused");
  assert.equal(f.store.latestQaRun("fixture"), null, "no QA run was written");
  assert.equal(f.submits(), 0);
});

test("the retired schedule mints no identity, and a predecessor's suspended preparation is still settled", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qa-interrupted-schedule-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const key = "owner/repo",
    owner = randomUUID(),
    predecessor = randomUUID();
  store.setMeta("processOwner", { pid: process.pid, owner });
  const runner = new ProjectQaRunner(store, {
    dataDir: dir,
    hostRunStateDir: join(dir, "hosts"),
    ownerInstance: owner,
  });
  t.after(async () => {
    runner.hostRuns.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  let launched = 0;
  store.patchRepository(
    { origin: key, path: dir },
    {
      qa: {
        argv: ["effigy", "qa"],
        timeoutMs: 1000,
        schedule: { afterMerges: 1, maxIntervalHours: 24 },
      },
    },
  );
  store.setProjectPlanner({
    key: store.projectFor(dir, key)!.key,
    agentId: "planner",
    setBy: "test",
  });
  const internal = runner as any;
  internal.resolveRepository = async () => ({
    key,
    origin: key,
    path: dir,
    checkoutPath: dir,
  });
  internal.reconcile = async () => {};
  internal.integrationHead = async () => head;
  internal.submitToHostScheduler = () => {
    launched++;
  };
  internal.attachQueued = () => {};
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "merge-1",
      title: "merge 1",
      repoPath: dir,
      planningCommit: head,
      handoffPath: "h.md",
      originAgentId: "author",
    }),
    "host",
    "brief",
    head,
    {},
    undefined,
    key,
  );
  store.update(
    task.id,
    {
      phase: "done",
      resolution: { ...task.resolution, mergedCommit: "9".repeat(40) },
    },
    "fixture",
  );
  // A predecessor left this batch's request preparing and died; nothing may resume it.
  store.setMeta("projectQaRequest:stale-preparation", {
    id: "stale-preparation",
    input: { repository: key, baseBranch: "main" },
    ownerInstance: predecessor,
    ownerPid: 33836,
    receivedAt: new Date().toISOString(),
    state: "preparing",
    runId: null,
    diagnostic: "",
  });
  const schedules = new ProjectQaSchedules(store, runner, {
    includes: async () => true,
  });
  await schedules.tick();
  assert.equal(launched, 0, "the retired schedule never admits a run");
  assert.equal(
    store.getMeta<any>(qaScheduleStateKey(key))?.pending ?? null,
    null,
    "and mints no request identity of its own",
  );
  assert.equal(
    store.getMeta<any>("projectQaRequest:stale-preparation").state,
    "preparing",
    "the suspended obligation is untouched by the schedule",
  );
  assert.equal(
    store.notices(`qa:${key}`).length,
    1,
    "the repository hears the migration once",
  );
  // The recovery owner still settles a predecessor's preparation, so no stale request is left unknown.
  runner.settleInterruptedPreparations();
  assert.ok(
    store
      .getMeta<any>("projectQaRequest:stale-preparation")
      .diagnostic.startsWith(QA_INTERRUPTED_PREPARATION_PREFIX),
  );
  assert.equal(
    store.getMeta<any>("projectQaRequest:stale-preparation").state,
    "refused",
  );
  await schedules.tick();
  assert.equal(launched, 0, "no hot loop");
});
