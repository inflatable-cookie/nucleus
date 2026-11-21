import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeLifecycle,
  type RuntimeLifecycleOwner,
} from "../service/runtime-lifecycle";
import type { PrState } from "../core/forge/pr-status";

/**
 * The lifecycle's honest read facts. Blind calibration #1263 found that a failed
 * PR-state read published an empty map and that a host identity conflict was
 * inferred from `startError` text; these tests exercise the typed facts at the
 * owner's real boundary.
 */

const flush = async () => {
  for (let index = 0; index < 5; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

interface Fake {
  owner: RuntimeLifecycleOwner;
  reads: () => number;
  revisions: () => number;
  setRead(read: () => Promise<Record<string, PrState>>): void;
}

const fakeOwner = (
  options: {
    recordedHost?: string;
    observedHost?: string;
    read?: () => Promise<Record<string, PrState>>;
    /** A verified host other than the primary is online. */
    secondaryOnline?: boolean;
    /** The primary connect never answers, the shape a quit Paseo leaves. */
    primaryHangs?: boolean;
  } = {},
): Fake => {
  let read = options.read ?? (async () => ({}));
  let reads = 0;
  let revisions = 0;
  const known = options.recordedHost ? [{ id: options.recordedHost }] : [];
  const owner = {
    store: {
      prStateTasks: () => [],
      advanceRevision: () => {
        revisions++;
      },
    },
    engine: {
      refresh: async () => undefined,
      wake: async () => undefined,
      progressMark: () => 0,
      resumeOperations: () => undefined,
      resumeBulkDispositions: () => undefined,
      hooks: { disposeLegacyWarmCheckouts: async () => undefined },
    },
    adapter: {
      connect: options.primaryHangs
        ? () => new Promise<void>(() => {})
        : async () => undefined,
    },
    admission: {},
    hostRegistry: {
      known: () => known,
      get: () => undefined,
      // The primary is the Paseo entry, never whichever host registered first: the
      // lifecycle's identity guard reads it (Spec 062 phase 1).
      primary: () => known[0],
    },
    plannerTickets: { ensure: async () => undefined },
    t3Host: () => null,
    refreshT3Settings: () => undefined,
    daemonUrl: "ws://127.0.0.1:6767/ws",
    connectTimeoutMs: 10,
    paseoHostId: options.observedHost ?? "fixture-host",
    hostSession: null,
    idleShutdownLatched: false,
    connected: () => false,
    anyHostConnected: () => options.secondaryOnline === true,
    readPrStates: () => {
      reads++;
      return read();
    },
  } as unknown as RuntimeLifecycleOwner;
  return {
    owner,
    reads: () => reads,
    revisions: () => revisions,
    setRead: (next) => {
      read = next;
    },
  };
};

test("a failed PR-state read stays unknown and named, and keeps the last known map", async () => {
  const fake = fakeOwner({ read: async () => ({ "task-1": "OPEN" }) });
  const lifecycle = new RuntimeLifecycle(fake.owner);

  assert.deepEqual(
    lifecycle.prStateFacts(),
    {
      state: "unknown",
      reason: "PR states have not been read yet",
      readAt: null,
      lastKnownAt: null,
    },
    "before any read the fact is unknown, never an empty known map",
  );
  assert.deepEqual(
    lifecycle.prStateMap(),
    {},
    "the map starts empty; only the fact says it was never read",
  );

  await lifecycle.refresh();
  await flush();
  assert.equal(fake.reads(), 1);
  assert.deepEqual(lifecycle.prStateMap(), { "task-1": "OPEN" });
  const known = lifecycle.prStateFacts();
  assert.equal(known.state, "known");
  assert.equal(known.reason, null);
  assert.equal(
    fake.revisions(),
    1,
    "a changed map advances the board revision once",
  );

  fake.setRead(async () => {
    throw new Error("gh is unavailable");
  });
  await lifecycle.refresh();
  await flush();
  assert.deepEqual(
    lifecycle.prStateMap(),
    { "task-1": "OPEN" },
    "a failed read keeps the last known map instead of publishing an empty one",
  );
  assert.equal(
    fake.revisions(),
    1,
    "a failed read changes no data and advances nothing",
  );
  const unknown = lifecycle.prStateFacts();
  assert.equal(unknown.state, "unknown");
  assert.equal(
    unknown.reason,
    "gh is unavailable",
    "the unknown read names its cause",
  );
  assert.equal(
    unknown.lastKnownAt,
    known.readAt,
    "the fact says how old the kept map is",
  );
});

test("a host identity conflict is a typed fact observed by the bootstrap, not startError text", async () => {
  const fake = fakeOwner({
    recordedHost: "old-host",
    observedHost: "other-host",
  });
  const lifecycle = new RuntimeLifecycle(fake.owner);

  assert.equal(
    await lifecycle.ensureBootstrap(),
    false,
    "a refused identity never reports a completed bootstrap",
  );
  assert.match(
    lifecycle.startError,
    /Configured daemon identity changed/,
    "the display text is unchanged",
  );
  assert.equal(lifecycle.identityConflict?.kind, "identity");
  assert.equal(
    lifecycle.identityConflict?.hostId,
    "old-host",
    "the conflict names the recorded host it disagrees with",
  );
  assert.match(
    lifecycle.identityConflict?.message ?? "",
    /existing tasks belong to another host/,
  );
  assert.equal(lifecycle.bootstrapped, false);
  assert.equal(
    fake.owner.hostSession,
    null,
    "a refused identity claims no session",
  );

  assert.equal(await lifecycle.ensureBootstrap(), false);
  assert.equal(
    lifecycle.identityConflict?.hostId,
    "old-host",
    "a retry records the same typed fact",
  );
});

test("a secondary host satisfies readiness while the primary connect never answers (nucleus#1449)", async () => {
  const withSecondary = fakeOwner({
    secondaryOnline: true,
    primaryHangs: true,
  });
  const lifecycle = new RuntimeLifecycle(withSecondary.owner);
  const startedAt = Date.now();

  assert.equal(
    await lifecycle.ensureBootstrap(),
    true,
    "the online host owns readiness, so the bootstrap completes",
  );
  assert.equal(
    lifecycle.startError,
    "",
    "the primary's absence is not a start error",
  );
  assert.equal(lifecycle.bootstrapped, true);
  assert.equal(
    lifecycle.primaryFault === null,
    true,
    "the abandoned connect has not failed yet; the host shows offline meanwhile",
  );
  assert.ok(
    Date.now() - startedAt < 1_000,
    "the common recovery did not wait for the offline adapter",
  );

  // The bounded attempt settles on its own and records its cause on that host.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(
    lifecycle.primaryFault?.message ?? "",
    /Daemon connection did not settle inside 10 ms/,
  );
  assert.equal(
    lifecycle.startError,
    "",
    "the recorded host fault stays off the board",
  );
});

test("with no host online the primary's connect failure is still the runtime's start error", async () => {
  const alone = fakeOwner({ primaryHangs: true });
  const lifecycle = new RuntimeLifecycle(alone.owner);

  assert.equal(
    await lifecycle.ensureBootstrap(),
    false,
    "nothing owns readiness, so the bootstrap never completes",
  );
  assert.match(
    lifecycle.startError,
    /Daemon connection did not settle inside 10 ms/,
  );
  assert.equal(lifecycle.bootstrapped, false);
});

test("warm primary disconnect with a secondary host online runs common recovery once without waiting (nucleus#1449)", async () => {
  let primaryOnline = true;
  let refreshes = 0;
  let bulkResumes = 0;
  const opResumes: boolean[] = [];
  let wakes = 0;
  let lifecycle!: RuntimeLifecycle;
  const owner = {
    store: {
      prStateTasks: () => [],
      advanceRevision: () => undefined,
    },
    engine: {
      refresh: async () => {
        refreshes++;
      },
      wake: async () => {
        wakes++;
      },
      progressMark: () => wakes,
      resumeOperations: (reconcileInterrupted: boolean) => {
        opResumes.push(reconcileInterrupted);
      },
      resumeBulkDispositions: () => {
        bulkResumes++;
      },
      hooks: { disposeLegacyWarmCheckouts: async () => undefined },
    },
    adapter: {
      connect: () =>
        primaryOnline ? Promise.resolve() : new Promise<void>(() => {}),
    },
    admission: {},
    hostRegistry: {
      known: () => [],
      get: () => undefined,
      primary: () => undefined,
      connect: () => ({}),
      resource: (_id: string, create: () => unknown) => create(),
    },
    plannerTickets: { ensure: async () => undefined },
    t3Host: () => null,
    refreshT3Settings: () => undefined,
    daemonUrl: "ws://127.0.0.1:6767/ws",
    connectTimeoutMs: 10,
    paseoHostId: "paseo:primary",
    hostSession: null as { id: string; token: object } | null,
    idleShutdownLatched: false,
    connected: () => {
      if (!primaryOnline) {
        const hadSession = owner.hostSession !== null;
        owner.hostSession = null;
        if (hadSession) lifecycle.bootstrapped = false;
        return false;
      }
      return owner.hostSession !== null;
    },
    anyHostConnected: () => {
      owner.connected();
      return true;
    },
    readPrStates: async () => ({}),
  } as unknown as RuntimeLifecycleOwner;

  lifecycle = new RuntimeLifecycle(owner);
  assert.equal(await lifecycle.ensureBootstrap(), true);
  assert.equal(refreshes, 1);
  assert.equal(bulkResumes, 1);
  assert.deepEqual(opResumes, [true]);
  assert.equal(wakes, 1);

  // Primary disconnects while secondary stays online: common recovery and reconciliation
  // run once (reconcileInterrupted=false) without waiting for the hanging primary connect.
  primaryOnline = false;
  const startedAt = Date.now();
  assert.equal(await lifecycle.ensureBootstrap(), true);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(lifecycle.startError, "");
  assert.equal(lifecycle.bootstrapped, true);
  assert.equal(refreshes, 2);
  assert.equal(bulkResumes, 2);
  assert.deepEqual(opResumes, [true, false]);
  assert.equal(wakes, 2);

  // Subsequent ticks while primary remains offline do not repeat recovery or reconciliation.
  assert.equal(await lifecycle.ensureBootstrap(), true);
  assert.equal(refreshes, 2);
  assert.equal(bulkResumes, 2);
  assert.deepEqual(opResumes, [true, false]);
  assert.equal(wakes, 2);
});
