import assert from "node:assert/strict";
import { test } from "node:test";
import {
  head,
  intentFixture,
  lostReply,
  restartAfterIntent,
} from "./support/intent-restart";

for (const retry of [false, true]) {
  const kind = retry ? "merge_retry_intent" : "merge_intent";
  test(`${kind} observes the exact merged head after an interrupted request`, async (t) => {
    let sends = 0;
    let observed = 0;
    const commit = "b".repeat(40);
    const f = intentFixture(
      t,
      {
        createRun: async () =>
          assert.fail("Existing merge intent needs no new run"),
        merge: async (_task, allowed) => {
          assert.ok(allowed?.());
          sends++;
          throw lostReply;
        },
        merged: async () => {
          observed++;
          return sends
            ? { merged: true, head, base: "main", commit }
            : {
                merged: false,
                head,
                base: "main",
                commit: null,
                proof: {
                  proven: true,
                  detail: "Observed open and outside merge queue",
                },
              };
        },
      },
      { phase: "merging", agentId: null, resumePrNumber: 1 },
    );
    const gate = { head, base: head, wait: "" };
    f.engine.resolution.executionLease = async () => true;
    f.engine.resolution.gateSettingsCurrent = () => true;
    f.engine.resolution.mergeGateEvidence = async () => gate;
    if (retry)
      f.engine.resolution.update(f.task(), {
        mergeIntent: true,
        mergeHead: head,
        mergeBase: head,
        mergeResponseOutcome: "uncertain",
        mergeRequestedAt: new Date(Date.now() - 1000).toISOString(),
        mergeProofSince: new Date(Date.now() - 120000).toISOString(),
      });

    await restartAfterIntent(
      f.engine,
      f.id,
      kind,
      async () => {
        if (retry) await f.engine.resolution.reconcileMergeIntent(f.task());
        else
          await assert.rejects(
            f.engine.resolution.mergeGates["requestMerge"](f.task(), gate),
            lostReply,
          );
        assert.equal(sends, 1);
      },
      (store) => {
        const restarted = f.start(store);
        restarted.resolution.executionLease = async () => true;
        // Keep the later synchronization step out of this exact-head merge test.
        restarted.resolution.advanceSyncing = async () => {};
        return restarted;
      },
      async (store, sweep) => {
        const before = observed;
        await sweep();
        assert.equal(
          store.task(f.id).resolution.mergedCommit,
          commit,
          store.task(f.id).reason,
        );
        assert.ok(observed > before);
        assert.equal(sends, 1);
        const events = store.eventsAll(f.id);
        await sweep();
        assert.deepEqual(store.eventsAll(f.id), events);
        assert.equal(sends, 1);
      },
    );
  });
}
