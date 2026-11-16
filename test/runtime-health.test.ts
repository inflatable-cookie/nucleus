import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectHostStates,
  retentionFailureEvidence,
  type HostStateFacts,
} from "../service/runtime-health";
import type { HostRunOutputFailureSummary } from "../core/host-runs/host-run-output-failures";

/**
 * The health projection's typed facts. Blind calibration #1263 found a failed
 * retention summary published as null (read as "clear") and a host conflict
 * inferred from `startError` text; these exercise both at the projection's own
 * boundary.
 */

const summary = (
  overrides: Partial<HostRunOutputFailureSummary> = {},
): HostRunOutputFailureSummary => ({
  count: 0,
  firstSeen: null,
  lastSeen: null,
  examples: [],
  examplesOmitted: 0,
  ...overrides,
});

test("a retained-output set this process cannot read stays unknown and named, never clear", () => {
  assert.equal(
    retentionFailureEvidence(null),
    null,
    "no endpoint to read is absent, not clear",
  );

  assert.deepEqual(
    retentionFailureEvidence({ retentionFailureSummary: () => summary() }),
    { state: "clear", summary: null, reason: null },
    "a positively read empty set is clear",
  );

  const unresolved = retentionFailureEvidence({
    retentionFailureSummary: () => summary({ count: 2 }),
  });
  assert.equal(unresolved?.state, "unresolved");
  assert.equal(
    unresolved?.summary?.count,
    2,
    "the exact durable total is kept",
  );

  const unreadable = retentionFailureEvidence({
    retentionFailureSummary: () =>
      summary({
        unreadable:
          "the retained-output failure records could not be read (store gone)",
      }),
  });
  assert.equal(
    unreadable?.state,
    "unresolved",
    "an unreadable set is evidence, not an all-clear",
  );
  assert.match(unreadable?.summary?.unreadable ?? "", /store gone/);

  assert.deepEqual(
    retentionFailureEvidence({
      retentionFailureSummary: () => {
        throw new Error("endpoint gone");
      },
    }),
    { state: "unknown", summary: null, reason: "endpoint gone" },
    "a read that throws is unknown with its cause, never null",
  );
});

test("a host conflict comes from the typed fact, never from startError text", () => {
  const facts = (overrides: Partial<HostStateFacts> = {}): HostStateFacts => ({
    known: [{ id: "host-a" }],
    online: () => false,
    primaryId: "host-a",
    t3: undefined,
    identityConflict: null,
    startError: "",
    ...overrides,
  });

  assert.deepEqual(
    projectHostStates(facts()),
    [{ id: "host-a", state: "offline", reason: "Host is offline" }],
    "an offline host is offline",
  );

  assert.deepEqual(
    projectHostStates(
      facts({
        startError:
          "Configured daemon identity changed; existing tasks belong to another host",
      }),
    ),
    [
      {
        id: "host-a",
        state: "offline",
        reason:
          "Configured daemon identity changed; existing tasks belong to another host",
      },
    ],
    "error text alone never makes a conflict",
  );

  assert.deepEqual(
    projectHostStates(
      facts({
        identityConflict: {
          kind: "identity",
          hostId: "host-a",
          message:
            "Configured daemon identity changed; existing tasks belong to another host",
          at: "2026-11-16T00:00:00.000Z",
        },
      }),
    ),
    [
      {
        id: "host-a",
        state: "conflict",
        reason: "Host is offline",
      },
    ],
    "the typed fact names the conflicting host",
  );

  assert.deepEqual(
    projectHostStates(
      facts({
        identityConflict: {
          kind: "admission",
          hostId: "another-host",
          message:
            "Host admission identity conflicts with the selected adapter",
          at: "2026-11-16T00:00:00.000Z",
        },
      }),
    ),
    [{ id: "host-a", state: "offline", reason: "Host is offline" }],
    "a conflict naming another host is not guessed onto this one",
  );

  assert.deepEqual(
    projectHostStates({
      known: [],
      online: () => false,
      primaryId: null,
      t3: undefined,
      identityConflict: null,
      startError: "",
    }),
    [{ id: "unknown", state: "unknown", reason: "Host identity is unknown" }],
    "no known host is unknown, not offline",
  );
});

test("an online host reports its own reason and a pending secondary thread shape", () => {
  assert.deepEqual(
    projectHostStates({
      known: [{ id: "host-a" }, { id: "t3-host" }],
      online: (id) => id === "host-a",
      primaryId: "host-a",
      t3: { id: "t3-host", error: "", threadShapePending: false },
      identityConflict: null,
      startError: "",
    }),
    [
      { id: "host-a", state: "online", reason: "" },
      { id: "t3-host", state: "offline", reason: "T3Code is offline" },
    ],
  );
  assert.deepEqual(
    projectHostStates({
      known: [{ id: "t3-host" }],
      online: () => true,
      // No Paseo entry is recorded, so nothing is primary in this projection.
      primaryId: null,
      t3: { id: "t3-host", error: "", threadShapePending: true },
      identityConflict: null,
      startError: "",
    }),
    [
      {
        id: "t3-host",
        state: "online",
        reason: "thread shape pending first thread",
      },
    ],
  );
});
