import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Engine } from "../../core/engine";
import type { ResolutionAdapter } from "../../core/resolution";
import type { Adapter } from "../../core/host";
import { Store } from "../../core/store/store";
import { type Run, type Task, runSchema } from "../../shared/contracts";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../../core/verbs/owner-verbs";
import { fakeAdapter, observeIdle, submission, tempStore } from "./fakes";

export async function restartAfterIntent(
  engine: Engine,
  taskId: string,
  kind: string | ((store: Store) => number),
  interrupt: () => Promise<void>,
  start: (store: Store) => Engine,
  verify: (
    store: Store,
    sweep: () => Promise<void>,
    engine: Engine,
  ) => Promise<void>,
) {
  const { store } = engine;
  const count =
    typeof kind === "function"
      ? () => kind(store)
      : () =>
          store.eventsAll(taskId).filter((event) => event.kind === kind).length;
  const before = count();
  try {
    await interrupt();
    assert.ok(
      count() > before,
      `The writer did not persist ${typeof kind === "string" ? kind : "the selected hook state"}`,
    );
  } finally {
    await engine.stop();
    await engine.drainCleanup();
  }

  const reopened = new Store(store.path);
  const restarted = start(reopened);
  let completedPass = false;
  try {
    await verify(
      reopened,
      async () => {
        const notices = reopened.notices(taskId);
        await restarted.sweepOnce();
        await restarted.drainCleanup();
        await restarted.quiesce();
        assert.equal(reopened.getMeta("engineError"), "");
        if (completedPass) assert.deepEqual(reopened.notices(taskId), notices);
        completedPass = true;
      },
      restarted,
    );
  } finally {
    await restarted.stop();
    await restarted.drainCleanup();
    reopened.close();
  }
}

export const head = "a".repeat(40);
export const lostReply = new Error(
  "Fixture target changed before the reply arrived",
);

export function intentFixture(
  t: TestContext,
  ports: Partial<Adapter & ResolutionAdapter> = {},
  patch: Partial<Task> = {},
) {
  const { store, dir } = tempStore(t);
  const inserted = store.insert(
    submission({ repoPath: dir }),
    "host",
    "handoff",
    head,
  );
  store.setMeta("paused", false);
  store.setMeta("hostId", "host");
  const adapter = fakeAdapter({ observe: observeIdle("ws"), ...ports });
  const id = inserted.id;
  store.update(id, {
    phase: "working",
    agentId: "worker",
    runId: "worker-run",
    workspaceId: "ws",
    directory: dir,
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/1",
    ...patch,
  });
  const task = () => store.task(id);
  const start = (reopened: Store) => new Engine(reopened, adapter, 0);
  const engine = start(store);
  const kinds = () => store.eventsAll(id).map((event) => event.kind);
  const run = (fields: Partial<Run> = {}) => {
    const row = runSchema.parse({
      id: "run",
      taskId: id,
      role: "reviewer",
      generation: 1,
      head,
      base: head,
      agentId: "reader",
      workspaceId: "ws",
      hostId: "host",
      status: "running",
      createdAt: new Date().toISOString(),
      profile: null,
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
      ...fields,
    });
    store.putRun(row);
    store.update(id, {
      resolution: { ...task().resolution, currentRunId: row.id },
    });
    return store.run(row.id)!;
  };
  return { id, store, dir, adapter, engine, task, start, kinds, run };
}

export function assertRetry(store: Store, id: string, effect: string) {
  const next = ownerTaskNext(collectOwnerVerbFacts(store, store.task(id)));
  const retry = next.verbs.find(
    (verb) => verb.verb === "retry_effect" && verb.args?.effect === effect,
  );
  assert.equal(
    retry?.available,
    true,
    `Expected applicable retry for ${effect}`,
  );
}

/** Check writer and crash boundary even when this build lacks the restart reader. */
export async function deferredRestart(
  t: TestContext,
  f: ReturnType<typeof intentFixture>,
  kind: string,
  write: () => Promise<unknown>,
  followUp: string,
  outcome: (store: Store) => void,
) {
  await restartAfterIntent(
    f.engine,
    f.id,
    kind,
    async () => {
      await write();
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      await t.test(`${kind} restart outcome`, { skip: followUp }, async () => {
        outcome(store);
        const events = store.eventsAll(f.id);
        const notices = store.notices(f.id);
        await sweep();
        assert.deepEqual(store.eventsAll(f.id), events);
        assert.deepEqual(store.notices(f.id), notices);
      });
    },
  );
}
