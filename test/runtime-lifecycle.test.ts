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
    engine: { refresh: async () => undefined },
    adapter: { connect: async () => undefined },
    admission: {},
    hostRegistry: {
      known: () => known,
      get: () => undefined,
      // The primary is the Paseo entry, never whichever host registered first: the
      // lifecycle's identity guard reads it (Spec 062 phase 1).
      primary: () => known[0],
    },
    plannerTickets: { ensure: async () => undefined },
    t3Host: null,
    daemonUrl: "ws://127.0.0.1:6767/ws",
    connectTimeoutMs: 10,
    paseoHostId: options.observedHost ?? "fixture-host",
    hostSession: null,
    idleShutdownLatched: false,
    connected: () => false,
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
