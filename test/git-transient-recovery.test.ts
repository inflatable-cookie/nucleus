import { fakeAdapter, profile } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { GitTransientError } from "../core/forge/forge-health";
import {
  submissionSchema,
  taskControlInputSchema,
  type Completion,
  type Run,
  type Task,
} from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

/**
 * Rule 1 of the simplify lane's split map. `Resolution.adapter` is a Proxy whose
 * successful Task-bearing calls are retry witnesses; `Engine.adapter` is a
 * host-routing Proxy over the host's adapter (Queue #912) that never witnesses. A
 * line that captures its adapter, or moves to the other one, changes when a
 * Git-transient episode clears and nothing else notices. These tests notice.
 */
const head = "a".repeat(40),
  base = "b".repeat(40),
  merged = "c".repeat(40);
const prUrl = "https://github.com/example/repo/pull/1";

type Via = "engine" | "resolution";
type Episode = {
  startedAt: number;
  attempts: number;
  retryAt: number;
  detail: string;
  source?: string;
};

function fixture(seed: "queued" | "review" | "force" = "force") {
  const dir = mkdtempSync(join(tmpdir(), "git-transient-recovery-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const worker = profile("author"),
    reviewer = profile("reviewer"),
    coordinator = profile("coordinator");
  store.setMeta("paused", false);
  store.putRepository(
    { origin: null, path: "/repo" },
    "agent",
    "fixture keeps agent closeout",
  );
  store.setMeta("pool", [
    {
      profileId: worker.id,
      enabled: true,
      group: "author",
      roles: ["worker"],
      weight: 1,
      scopes: ["general"],
      capability: "medium",
      cost: "low",
    },
    {
      profileId: reviewer.id,
      enabled: true,
      group: "review",
      roles: ["reviewer"],
      weight: 1,
      scopes: ["general"],
      capability: "medium",
      cost: "medium",
    },
    {
      profileId: coordinator.id,
      enabled: true,
      group: "coordinate",
      roles: ["coordinator"],
      weight: 1,
      scopes: ["general"],
      capability: "low",
      cost: "very_low",
    },
  ]);
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Task",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  if (seed === "review")
    store.update(submitted.id, {
      phase: "awaiting_review",
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: "workspace",
      directory: "/worktree",
      agentId: "worker",
      runId: "initial",
      profile: worker,
      workerModel: worker.model,
      prHead: head,
      prUrl,
      agentActive: false,
      lastAgentStatus: "idle",
      lastObservedAt: new Date().toISOString(),
      completion: {
        taskId: submitted.id,
        runId: "initial",
        eventId: "initial-result",
        status: "ready_for_review",
        summary: "Ready",
        prNumber: 1,
      },
    });
  if (seed === "force")
    store.update(submitted.id, {
      phase: "needs_attention",
      prHead: head,
      prUrl,
      resumePrNumber: 1,
      resolution: {
        ...store.task(submitted.id).resolution,
        attention: true,
        integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      },
    });
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = "workspace") =>
    states.set(id, {
      id,
      workspaceId,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      provider: "test",
      model: "test",
    } as AgentObservation);
  idle("worker");
  idle("origin", "origin-workspace");
  const tokens = new Map<string, string>();
  let merges = 0;
  const adapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coordinator],
    validate: async () => base,
    verifyWorkspace: async (t: Task) => t.branch,
    createWorkspace: async (t: Task) => ({
      id: `ws-${t.id}`,
      directory: "/worktree",
    }),
    createAgent: async (t: Task, token: string) => {
      tokens.set(t.id, token);
      const id = `agent-${t.id}`;
      states.set(id, {
        id,
        workspaceId: t.workspaceId,
        status: "running",
        active: true,
        permissions: false,
        error: "",
      } as AgentObservation);
      return { id, workspaceId: t.workspaceId };
    },
    stopAgentTurn: async () => {},
    agentTimelinePage: async () => ({
      entries: [],
      hasOlder: false,
      hasNewer: false,
      gap: false,
      staleCursor: false,
      reset: false,
      epoch: "fixture",
      projection: "projected",
      startCursor: null,
      endCursor: null,
    }),
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw Error("Agent missing");
      return state;
    },
    verifyPr: async () => ({ head, url: prUrl }),
    verifyPrIdentity: async () => ({
      head,
      url: prUrl,
      repository: "example/repo",
      headRepository: "example/repo",
    }),
    verifyCleanQueueWorktree: async () => {},
    createRun: async (_t: Task, run: Run, token: string) => {
      tokens.set(run.id, token);
      const id = `agent-${run.id}`;
      states.set(id, {
        id,
        workspaceId: run.workspaceId,
        status: "running",
        active: true,
        permissions: false,
        error: "",
      } as AgentObservation);
      return { id, workspaceId: run.workspaceId };
    },
    sendRun: async (_t: Task, run: Run, token: string) => {
      tokens.set(run.id, token);
      states.set(run.agentId!, {
        ...states.get(run.agentId!)!,
        active: true,
        status: "running",
      });
    },
    findRunAgents: async () => [],
    verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: "" }),
    merge: async () => {
      merges++;
    },
    merged: async () => ({
      merged: merges > 0,
      commit: merged,
      head,
      base: "main",
    }),
    syncMain: async () => merged,
    verifyCloseout: async () => {},
    notify: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  // Counted beneath both adapters, so a call that bypasses them still lands here.
  const calledBelow = new Map<string, number>();
  for (const [name, method] of Object.entries(adapter))
    (adapter as unknown as Record<string, unknown>)[name] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      calledBelow.set(name, (calledBelow.get(name) ?? 0) + 1);
      return (method as (...args: unknown[]) => unknown).apply(this, args);
    };
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer, coordinator];
  const current = () => store.task(submitted.id);
  const fired: { taskId: string; source: string }[] = [];
  const wired = engine.resolution.gitTransientRecovered!;
  engine.resolution.gitTransientRecovered = (task, source) => {
    fired.push({ taskId: task.id, source });
    wired(task, source);
  };
  const episodeKey = `gitTransient:${submitted.id}`;
  return {
    store,
    engine,
    adapter,
    current,
    states,
    idle,
    tokens,
    fired,
    calledBelow,
    episodeKey,
    episode: () => store.getMeta<Episode | null>(episodeKey) ?? null,
    seedEpisode: (fields: Partial<Episode>) =>
      store.setMeta(episodeKey, {
        startedAt: Date.now(),
        attempts: 1,
        retryAt: 0,
        detail: "HTTP 503",
        ...fields,
      } satisfies Episode),
    move: (to: string, extra: Record<string, unknown> = {}) =>
      engine.performTaskControl(
        taskControlInputSchema.parse({
          taskId: submitted.id,
          version: current().version,
          action: "move",
          to,
          force: true,
          caller: "operator (board)",
          reason: "Resolved by owner",
          ...extra,
        }),
      ),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

/** Stand in for each adapter after construction. Rule 1: tests replace them, so a captured reference misses the tag. */
function tagAdapters(f: Fixture) {
  const read = new Map<string, Set<Via>>();
  const tagged = new Map<string, number>();
  const tag = (inner: object, via: Via) =>
    new Proxy(inner, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== "function" || typeof property !== "string")
          return value;
        return (...args: unknown[]) => {
          read.set(property, (read.get(property) ?? new Set<Via>()).add(via));
          tagged.set(property, (tagged.get(property) ?? 0) + 1);
          return Reflect.apply(value, target, args);
        };
      },
    });
  Object.defineProperty(f.engine, "adapter", {
    value: tag(f.engine.adapter, "engine"),
  });
  Object.defineProperty(f.engine.resolution, "adapter", {
    value: tag(f.engine.resolution.adapter, "resolution"),
  });
  return {
    census: () =>
      Object.fromEntries(
        [...read]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, vias]) => [name, [...vias].sort().join("+")]),
      ),
    /** Calls that reached the fake without passing a tag: someone holds a captured adapter. */
    untagged: () =>
      [...f.calledBelow]
        .filter(([name, count]) => (tagged.get(name) ?? 0) !== count)
        .map(
          ([name, count]) =>
            `${name}: ${count} below, ${tagged.get(name) ?? 0} tagged`,
        ),
  };
}
const firedSources = (f: Fixture) =>
  [...new Set(f.fired.map((item) => item.source))].sort();

test("a Task-bearing call through the Proxy fires gitTransientRecovered; the raw adapter call does not", async () => {
  const f = fixture();
  try {
    // Queue #912: Engine.adapter is a host-routing Proxy over the adapter it was given;
    // the raw-versus-witness split below still holds through that Proxy.
    assert.equal(
      f.engine.resolveHostAdapter("host"),
      f.adapter,
      "Engine.adapter routes to the adapter it was given",
    );
    assert.notEqual(
      f.engine.resolution.adapter,
      f.engine.adapter,
      "Resolution.adapter is its own Proxy",
    );
    await f.engine.adapter.verifyPr(f.current(), 1);
    assert.equal(f.fired.length, 0, "raw: no witness");
    await f.engine.resolution.adapter.verifyPr(f.current(), 1);
    assert.deepEqual(
      f.fired,
      [{ taskId: f.current().id, source: "resolution.verifyPr" }],
      "Proxy: a witness named for the method",
    );
    assert.equal(
      f.calledBelow.get("verifyPr"),
      2,
      "both calls reached the same fake",
    );
  } finally {
    await f.close();
  }
});

test("the witness needs a Task argument, in any position, and a settled success", async () => {
  const f = fixture();
  try {
    const task = f.current(),
      proxy = f.engine.resolution.adapter as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
    const raw = f.adapter as unknown as Record<string, unknown>;
    await proxy.observe("worker");
    await proxy.findRunAgents({ id: "run", taskId: task.id, role: "worker" });
    raw.partial = async () => {};
    await proxy.partial({ id: task.id, repoPath: task.repoPath });
    assert.equal(
      f.fired.length,
      0,
      "no Task, no witness; a Task shape needs id, repoPath and resolution",
    );
    await proxy.partial("first", task);
    assert.deepEqual(
      f.fired.map((item) => item.source),
      ["resolution.partial"],
      "a Task after other arguments still counts",
    );
    f.fired.length = 0;
    raw.settled = () => "value";
    assert.equal(
      proxy.settled(task),
      "value",
      "a synchronous method stays synchronous",
    );
    assert.deepEqual(
      f.fired.map((item) => item.source),
      ["resolution.settled"],
      "and witnesses before returning",
    );
    f.fired.length = 0;
    let release!: () => void;
    raw.pending = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = proxy.pending(task);
    assert.equal(f.fired.length, 0, "a started call proves nothing");
    release();
    await pending;
    assert.deepEqual(
      f.fired.map((item) => item.source),
      ["resolution.pending"],
    );
  } finally {
    await f.close();
  }
});

test("a failure never witnesses, and only the Proxy names its source", async () => {
  const f = fixture();
  try {
    const task = f.current(),
      resolution = f.engine.resolution;
    const raw = f.adapter as unknown as Record<string, unknown>,
      proxy = resolution.adapter as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
    const asyncFailure = Error("async"),
      syncFailure = Error("sync"),
      rawFailure = Error("raw");
    raw.failsAsync = async () => {
      throw asyncFailure;
    };
    raw.failsSync = () => {
      throw syncFailure;
    };
    raw.failsRaw = async () => {
      throw rawFailure;
    };
    await assert.rejects(Promise.resolve(proxy.failsAsync(task)), asyncFailure);
    assert.throws(() => proxy.failsSync(task), syncFailure);
    await assert.rejects(
      (raw.failsRaw as (t: Task) => Promise<void>)(task),
      rawFailure,
    );
    assert.equal(f.fired.length, 0);
    assert.equal(
      resolution.gitFailureSource(asyncFailure),
      "resolution.failsAsync",
    );
    assert.equal(
      resolution.gitFailureSource(syncFailure),
      "resolution.failsSync",
    );
    assert.equal(
      resolution.gitFailureSource(
        new Error("wrapped", { cause: asyncFailure }),
      ),
      "resolution.failsAsync",
      "a wrapped failure keeps its source",
    );
    assert.equal(
      resolution.gitFailureSource(rawFailure),
      undefined,
      "raw failures have no source",
    );
  } finally {
    await f.close();
  }
});

test("the Engine-wired witness clears only a due episode of the same source", async () => {
  const cases: {
    name: string;
    episode: Partial<Episode>;
    call: (f: Fixture) => Promise<unknown>;
    clears: boolean;
  }[] = [
    {
      name: "Proxy, due, same source",
      episode: { source: "resolution.verifyPr" },
      call: (f) => f.engine.resolution.adapter.verifyPr(f.current(), 1),
      clears: true,
    },
    {
      name: "raw, due, same source",
      episode: { source: "resolution.verifyPr" },
      call: (f) => f.engine.adapter.verifyPr(f.current(), 1),
      clears: false,
    },
    {
      name: "Proxy, due, another source",
      episode: { source: "resolution.merged" },
      call: (f) => f.engine.resolution.adapter.verifyPr(f.current(), 1),
      clears: false,
    },
    {
      name: "Proxy, not yet due",
      episode: { source: "resolution.verifyPr", retryAt: Date.now() + 60_000 },
      call: (f) => f.engine.resolution.adapter.verifyPr(f.current(), 1),
      clears: false,
    },
    {
      name: "Proxy, due, no source",
      episode: {},
      call: (f) => f.engine.resolution.adapter.verifyPr(f.current(), 1),
      clears: false,
    },
  ];
  for (const { name, episode, call, clears } of cases) {
    const f = fixture();
    try {
      f.seedEpisode(episode);
      const before = f.episode();
      await call(f);
      if (clears) assert.equal(f.episode(), null, name);
      else assert.deepEqual(f.episode(), before, name);
    } finally {
      await f.close();
    }
  }
});

test("forceMove reads merged through the Proxy and the PR identity raw", async () => {
  const closeout = fixture();
  try {
    const tags = tagAdapters(closeout);
    closeout.seedEpisode({ source: "resolution.merged" });
    closeout.adapter.merged = async () => ({
      merged: true,
      commit: merged,
      head,
      base: "main",
    });
    await closeout.move("closeout");
    assert.equal(tags.census().merged, "resolution");
    assert.deepEqual(tags.untagged(), []);
    assert.ok(
      closeout.fired.some((item) => item.source === "resolution.merged"),
      "move closeout witnesses its merge read",
    );
    assert.equal(
      closeout.episode(),
      null,
      "and that read clears the episode it failed",
    );
  } finally {
    await closeout.close();
  }
  const review = fixture();
  try {
    const tags = tagAdapters(review);
    review.seedEpisode({ source: "resolution.verifyPrIdentity" });
    const before = review.episode();
    await review.move("review", { prNumber: 1 });
    assert.equal(tags.census().verifyPrIdentity, "engine");
    assert.deepEqual(tags.untagged(), []);
    assert.equal(
      review.fired.some(
        (item) => item.source === "resolution.verifyPrIdentity",
      ),
      false,
      "raw, so no witness",
    );
    assert.deepEqual(review.episode(), before, "and no clearing");
  } finally {
    await review.close();
  }
});

test("a raw-path failure opens an episode no witness can clear; a Proxy-path failure clears on its retry", async () => {
  const dispatch = fixture("queued");
  try {
    let calls = 0;
    const validate = dispatch.adapter.validate;
    dispatch.adapter.validate = async (task) => {
      if (++calls === 1)
        throw new GitTransientError("network", Error("HTTP 503"));
      return validate(task);
    };
    await dispatch.engine.wake();
    const opened = dispatch.episode();
    assert.ok(opened, "Engine validates through the raw adapter");
    assert.equal(opened.source, undefined, "so its episode has no source");
    await dispatch.engine.resolution.adapter.verifyPr(dispatch.current(), 1);
    assert.deepEqual(
      dispatch.episode(),
      opened,
      "and a Proxy success elsewhere proves nothing",
    );
    dispatch.store.setMeta(dispatch.episodeKey, { ...opened, retryAt: 0 });
    await dispatch.engine.wake();
    assert.equal(dispatch.current().phase, "working");
    assert.equal(
      dispatch.episode(),
      null,
      "dispatch clears its own episode on the validated retry",
    );
    assert.deepEqual(
      firedSources(dispatch),
      ["resolution.verifyPr"],
      "not through a witness",
    );
  } finally {
    await dispatch.close();
  }
  const proxied = fixture("review");
  try {
    let failing = true;
    const syncMain = proxied.adapter.syncMain!;
    proxied.adapter.syncMain = async (...args) => {
      if (failing) throw new GitTransientError("lock", Error("index.lock"));
      return syncMain(...args);
    };
    await runReviewToClosing(proxied);
    const opened = proxied.episode();
    assert.equal(
      opened?.source,
      "resolution.syncMain",
      "lifecycle syncs through the Proxy, so the episode carries its source",
    );
    failing = false;
    await proxied.engine.resolution.adapter.syncMain!(
      proxied.current(),
      () => true,
    );
    assert.deepEqual(
      proxied.episode(),
      opened,
      "a success before the retry is due clears nothing",
    );
    proxied.store.setMeta(proxied.episodeKey, { ...opened, retryAt: 0 });
    await proxied.engine.wake();
    assert.equal(
      proxied.episode(),
      null,
      "the due retry clears it without help",
    );
    assert.ok(
      proxied.fired.some((item) => item.source === "resolution.syncMain"),
    );
  } finally {
    await proxied.close();
  }
});

async function runReviewToClosing(f: Fixture) {
  await f.engine.wake();
  const run = f.store.run(f.current().resolution.currentRunId!)!;
  f.idle(run.agentId!, run.workspaceId);
  f.engine.resolution.complete(
    {
      eventId: randomUUID(),
      taskId: f.current().id,
      runId: run.id,
      status: "ready_to_merge",
      summary: "Accepted",
      head: run.head,
      reviewCommentId: 1,
      reviewText: "Findings",
    } as Completion,
    f.tokens.get(run.id)!,
  );
  for (let pass = 0; pass < 6; pass++) await f.engine.wake();
}

// The census pins each path's whole read. A move that switches a line's adapter
// changes `census`, and one that captures an adapter shows up in `untagged`.
test("census: dispatch reads the raw adapter and witnesses nothing", async () => {
  const f = fixture("queued");
  try {
    const tags = tagAdapters(f);
    await f.engine.wake();
    assert.equal(f.current().phase, "working");
    assert.deepEqual(tags.census(), {
      createAgent: "engine",
      createWorkspace: "engine",
      validate: "engine",
      verifyWorkspace: "engine",
    });
    assert.deepEqual(tags.untagged(), []);
    assert.deepEqual(firedSources(f), []);
  } finally {
    await f.close();
  }
});

test("census: review through merge and sync reads the Proxy, and every Task-bearing read witnesses", async () => {
  const f = fixture("review");
  try {
    const tags = tagAdapters(f);
    await runReviewToClosing(f);
    assert.equal(f.current().phase, "closing");
    assert.deepEqual(tags.census(), {
      agentTimelinePage: "resolution",
      createRun: "resolution",
      merge: "resolution",
      mergeGate: "resolution",
      merged: "resolution",
      observe: "resolution",
      syncMain: "resolution",
      verifyPr: "resolution",
      verifyReview: "resolution",
    });
    assert.deepEqual(tags.untagged(), []);
    assert.deepEqual(
      firedSources(f),
      [
        "resolution.createRun",
        "resolution.merge",
        "resolution.mergeGate",
        "resolution.merged",
        "resolution.syncMain",
        "resolution.verifyPr",
        "resolution.verifyReview",
      ],
      "observe and the timeline take no Task",
    );
  } finally {
    await f.close();
  }
});

test("census: the external merge probe reads the Proxy and witnesses", async () => {
  const f = fixture("review");
  try {
    const tags = tagAdapters(f);
    f.adapter.externalMerge = async () => null;
    f.seedEpisode({ source: "resolution.externalMerge" });
    await f.engine.resolution.recoverExternalMerge(f.current());
    assert.equal(tags.census().externalMerge, "resolution");
    assert.deepEqual(firedSources(f), ["resolution.externalMerge"]);
    assert.equal(f.episode(), null);
  } finally {
    await f.close();
  }
});

test("census: closeout workspace recovery reads raw except its sync, which witnesses", async () => {
  const f = fixture("review");
  try {
    const lifecycle = new Lifecycle(f.engine);
    const tags = tagAdapters(f);
    Object.assign(f.adapter, {
      workspaceAvailable: async (id: string) => id === "recovery",
      createCloseoutWorkspace: async () => ({
        id: "recovery",
        directory: "/recovery",
      }),
      findCloseoutWorkspaces: async () => [],
      verifyCloseoutWorkspace: async () => {},
    });
    f.store.update(f.current().id, {
      phase: "closing",
      resolution: {
        ...f.current().resolution,
        mergedCommit: merged,
        syncedCommit: merged,
      },
    });
    await lifecycle.pass();
    assert.equal(f.current().resolution.coordinatorWorkspaceId, "recovery");
    const census = tags.census();
    assert.deepEqual(
      [
        census.syncMain,
        census.createCloseoutWorkspace,
        census.verifyCloseoutWorkspace,
      ],
      ["resolution", "engine", "engine"],
    );
    assert.deepEqual(tags.untagged(), []);
    assert.deepEqual(firedSources(f), ["resolution.syncMain"]);
  } finally {
    await f.close();
  }
});
