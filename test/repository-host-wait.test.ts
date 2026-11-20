import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { poolSchema } from "../shared/contracts";
import { fakeAdapter, profile, submission } from "./support/fakes";

// nucleus#1416: an explicit repository hostKind is a requirement for first worker
// dispatch. Stored tasks, stored repository settings and the real catalog shape
// (one host per kind, each with its own read catalog) run through dispatchQueued.

const PASEO = "paseo-primary";
const T3 = "t3code:env";
const REPO_T3 = { origin: null, path: "/synthetic/t3-repo" };
const REPO_PLAIN = { origin: null, path: "/synthetic/plain-repo" };
const SHA = "a".repeat(40);

function fixture(store: Store) {
  const created: string[] = [];
  const online = new Set([PASEO, T3]);
  const catalogRead = new Set([PASEO, T3]);
  const paseoWorker = profile("paseo-only");
  const t3Worker = profile("neon");
  const shared = profile("both");
  const workers = [paseoWorker, t3Worker, shared];
  store.setMeta(
    "pool",
    workers.map((p) =>
      poolSchema.parse({
        profileId: p.id,
        enabled: true,
        group: p.id,
        weight: 1,
        scopes: ["general"],
        capability: "worker",
        cost: "medium",
      }),
    ),
  );
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 12);
  // Runs after selection and before the commit: a host can drop in that window.
  const hooks = { afterSelection: () => {} };
  const adapter = (host: string) =>
    fakeAdapter({
      validate: async () => {
        hooks.afterSelection();
        return SHA;
      },
      createWorkspace: async (task) => {
        created.push(`${host}:${task.id}`);
        return { id: `ws-${task.id}`, directory: `/synthetic/${task.id}` };
      },
    });
  const paseo = adapter("paseo");
  const t3 = adapter("t3");
  const engine = new Engine(store, paseo, 0);
  engine.profiles = workers;
  engine.hostIds = () => [PASEO, T3];
  engine.resolveHostAdapter = (id) => (id === T3 ? t3 : paseo);
  engine.hostAvailable = (id) => online.has(id);
  engine.profileCatalogKnownFor = (id) => catalogRead.has(id ?? PASEO);
  // The real catalog shape: each host reports only its own profiles.
  engine.profilesFor = (id) =>
    id === T3 ? [t3Worker, shared] : [paseoWorker, shared];
  engine.launchAgent = async () => {};
  engine.enqueueTitle = () => {};
  return { engine, created, online, catalogRead, hooks };
}

function insertTask(
  store: Store,
  engine: Engine,
  repoPath: string,
  overrides: Record<string, unknown> = {},
) {
  return store.insert(
    submission({ repoPath, ...overrides }),
    repoPath === REPO_T3.path ? T3 : PASEO,
    "handoff",
    SHA,
  );
}

test("an offline repository host kind keeps an unbound task queued with a named wait, while healthy projects dispatch", async () => {
  const store = new Store(":memory:");
  const { engine, created, online } = fixture(store);
  try {
    store.putRepository(
      REPO_T3,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    store.putRepository(
      REPO_PLAIN,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      null,
    );
    online.delete(T3);
    const waiting = insertTask(store, engine, REPO_T3.path);
    const healthy = insertTask(store, engine, REPO_PLAIN.path);
    await engine.dispatchQueued();
    const held = store.task(waiting.id);
    assert.equal(held.phase, "queued");
    assert.equal(held.reason, "Waiting for repository host T3Code");
    assert.equal(held.workspaceId, null);
    assert.equal(held.profile, null);
    assert.equal(held.workspaceIntent, false);
    assert.equal(
      store
        .events(waiting.id)
        .filter((event) => event.kind === "dispatch_intent").length,
      0,
      "no dispatch intent is committed while the host is offline",
    );
    assert.ok(
      created.every((entry) => !entry.endsWith(waiting.id)),
      "no workspace is created for the waiting task",
    );
    assert.notEqual(
      store.task(healthy.id).phase,
      "queued",
      "a healthy project dispatches in the same pass",
    );
    assert.ok(created.some((entry) => entry.endsWith(healthy.id)));
  } finally {
    await engine.stop();
    store.close();
  }
});

test("the same task dispatches on its repository host through ordinary scheduling once that host recovers", async () => {
  const store = new Store(":memory:");
  const { engine, created, online } = fixture(store);
  try {
    store.putRepository(
      REPO_T3,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    online.delete(T3);
    const task = insertTask(store, engine, REPO_T3.path);
    await engine.dispatchQueued();
    assert.equal(
      store.task(task.id).reason,
      "Waiting for repository host T3Code",
    );
    online.add(T3);
    await engine.dispatchQueued();
    const dispatched = store.task(task.id);
    assert.equal(dispatched.hostId, T3);
    assert.equal(dispatched.profile?.id, "both");
    assert.equal(dispatched.hostSelection?.basis, "worker_profile");
    assert.ok(created.some((entry) => entry === `t3:${task.id}`));
  } finally {
    await engine.stop();
    store.close();
  }
});

test("an unread catalog on the repository host waits, even when another host has a profile to offer", async () => {
  const store = new Store(":memory:");
  const { engine, created, catalogRead } = fixture(store);
  try {
    store.putRepository(
      REPO_T3,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    catalogRead.delete(T3);
    const task = insertTask(store, engine, REPO_T3.path, {
      preferredProfileId: "paseo-only",
      requirePreferred: false,
    });
    await engine.dispatchQueued();
    const waiting = store.task(task.id);
    assert.equal(waiting.phase, "queued");
    assert.equal(waiting.reason, "Waiting for repository host T3Code");
    assert.equal(created.length, 0, "no fallback host creates a workspace");
  } finally {
    await engine.stop();
    store.close();
  }
});

test("a profile only launchable on T3 still routes there against a healthy Paseo repository preference", async () => {
  const store = new Store(":memory:");
  const { engine, created } = fixture(store);
  try {
    store.putRepository(
      REPO_PLAIN,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "paseo",
    );
    const task = insertTask(store, engine, REPO_PLAIN.path, {
      preferredProfileId: "neon",
      requirePreferred: true,
    });
    await engine.dispatchQueued();
    const dispatched = store.task(task.id);
    assert.equal(
      dispatched.hostId,
      T3,
      "the proven exclusive profile keeps its ruling",
    );
    assert.equal(dispatched.profile?.id, "neon");
    assert.ok(created.some((entry) => entry === `t3:${task.id}`));
  } finally {
    await engine.stop();
    store.close();
  }
});

test("a repository host dropping between selection and commit holds the dispatch before any intent", async () => {
  const store = new Store(":memory:");
  const { engine, created, online, hooks } = fixture(store);
  try {
    store.putRepository(
      REPO_T3,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    // paseo-only is launchable only on Paseo, so the chosen host is Paseo while
    // the repository's T3 host still answers at selection time.
    const task = insertTask(store, engine, REPO_T3.path, {
      preferredProfileId: "paseo-only",
      requirePreferred: true,
    });
    hooks.afterSelection = () => online.delete(T3);
    await engine.dispatchQueued();
    const held = store.task(task.id);
    assert.equal(held.phase, "queued");
    assert.equal(held.reason, "Waiting for repository host T3Code");
    assert.equal(held.profile, null);
    assert.equal(held.workspaceId, null);
    assert.equal(
      store.events(task.id).filter((event) => event.kind === "dispatch_intent")
        .length,
      0,
    );
    assert.equal(created.length, 0);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("changing the repository setting while queued releases the wait on the next pass", async () => {
  const store = new Store(":memory:");
  const { engine, online } = fixture(store);
  try {
    store.putRepository(
      REPO_T3,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    online.delete(T3);
    const task = insertTask(store, engine, REPO_T3.path);
    await engine.dispatchQueued();
    assert.equal(
      store.task(task.id).reason,
      "Waiting for repository host T3Code",
    );
    store.patchRepository(REPO_T3, { hostKind: null });
    await engine.dispatchQueued();
    const dispatched = store.task(task.id);
    assert.equal(dispatched.hostId, PASEO);
    assert.notEqual(dispatched.phase, "queued");
  } finally {
    await engine.stop();
    store.close();
  }
});

test("a repository host kind with no registered host is a visible configuration wait", async () => {
  const store = new Store(":memory:");
  const { engine, created } = fixture(store);
  try {
    store.putRepository(
      { origin: null, path: "/synthetic/bb-repo" },
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "bb",
    );
    const task = insertTask(store, engine, "/synthetic/bb-repo");
    await engine.dispatchQueued();
    const waiting = store.task(task.id);
    assert.equal(waiting.phase, "queued");
    assert.equal(
      waiting.reason,
      "Repository host BB is not registered; waiting for its configuration",
    );
    assert.equal(created.length, 0);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("the operator default host kind stays a preference and never gates dispatch", async () => {
  const store = new Store(":memory:");
  const { engine, online } = fixture(store);
  try {
    store.setMeta("operatorDefaultHostKind", "t3code");
    store.putRepository(
      REPO_PLAIN,
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      null,
    );
    online.delete(T3);
    const task = insertTask(store, engine, REPO_PLAIN.path);
    await engine.dispatchQueued();
    const dispatched = store.task(task.id);
    assert.equal(dispatched.hostId, PASEO);
    assert.notEqual(dispatched.phase, "queued");
  } finally {
    await engine.stop();
    store.close();
  }
});
