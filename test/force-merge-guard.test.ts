import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { holdPatch } from "../core/merge/merge-hold";
import { submissionSchema, taskControlInputSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  base = "b".repeat(40);
async function setup(mode: "head-moved" | "stop-before-send") {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-merge-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Guarded merge",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  let requests = 0,
    expected: string | null = null;
  const adapter = {
    verifyPr: async () => {
      throw Error("the retained checkout must not be read");
    },
    verifyPrIdentity: async () => ({
      head,
      url: "https://github.com/example/repo/pull/7",
      repository: "example/repo",
      headRepository: "example/repo",
    }),
    merge: async (
      value: { resolution: { mergeHead: string | null } },
      allowed: () => boolean,
    ) => {
      expected = value.resolution.mergeHead;
      if (mode === "stop-before-send") {
        const current = store.task(task.id);
        store.update(
          task.id,
          holdPatch(current, "dispatch", "operator", "Stop before send"),
        );
      }
      if (!allowed()) throw Error("Stopped before send");
      requests++;
      if (mode === "head-moved")
        throw Error("GitHub rejected the mismatched head");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta("paused", false);
  store.update(task.id, {
    phase: "needs_attention",
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/7",
    resumePrNumber: 7,
  });
  const apply = () =>
    engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: store.task(task.id).version,
        action: "move",
        to: "merge",
        force: true,
        reason: "Accept this head",
        qualification: "Tom accepts the source",
        caller: "operator (board)",
      }),
    );
  return { store, apply, requests: () => requests, expected: () => expected };
}

test("forced merge uses forge identity and sends the accepted SHA for GitHub to guard", async () => {
  const f = await setup("head-moved");
  try {
    const result = await f.apply();
    assert.equal(f.expected(), head);
    assert.equal(f.requests(), 1);
    assert.equal(result.resolution.mergeResponseOutcome, "uncertain");
    assert.equal(result.prHead, head);
  } finally {
    f.store.close();
  }
});

test("a stop or hold arriving before the send withdraws the forced request", async () => {
  const f = await setup("stop-before-send");
  try {
    const result = await f.apply();
    assert.equal(f.requests(), 0);
    assert.equal(result.resolution.mergeIntent, false);
    assert.match(result.reason, /stopped before sending/);
  } finally {
    f.store.close();
  }
});
