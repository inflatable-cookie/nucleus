import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema, taskControlInputSchema } from "../shared/contracts";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  base = "b".repeat(40);
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "force-boundaries-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const initial = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Force boundary",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  let sent: string | null = null;
  const adapter = {
    verifyPr: async () => ({
      head,
      url: "https://github.com/example/repo/pull/7",
    }),
    merge: async (task: { resolution: { mergeHead: string | null } }) => {
      sent = task.resolution.mergeHead;
    },
    merged: async () => ({ merged: true, head, commit: base, base: "main" }),
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta("paused", false);
  store.update(initial.id, {
    phase: "needs_attention",
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/7",
    resumePrNumber: 7,
    resolution: { ...store.task(initial.id).resolution, attention: true },
  });
  const task = () => store.task(initial.id);
  const apply = (fields: Record<string, unknown>) =>
    engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: initial.id,
        version: task().version,
        caller: "operator (board)",
        reason: "Accept this exact head",
        ...fields,
      }),
    );
  return { store, task, apply, sent: () => sent };
}

test("forced merge records explicit source acceptance and sends the exact head", async () => {
  const f = await setup();
  try {
    const result = await f.apply({
      action: "move",
      to: "merge",
      force: true,
      qualification: "Tom accepts this exact source head",
    });
    assert.equal(f.sent(), head);
    assert.equal(result.resolution.mergeHead, head);
    assert.equal(
      result.resolution.ownerAcceptances.at(-1)?.kind,
      "operator_source",
    );
    assert.equal(result.resolution.integrationTurn, null);
  } finally {
    f.store.close();
  }
});

test("next offers force and a later owned-tool occurrence remains blocking", async () => {
  const f = await setup();
  try {
    const hold = () =>
      f.store.event(
        f.task().id,
        "owned_tool_hold",
        JSON.stringify({ runId: "run", reason: "tool still live" }),
      );
    hold();
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.task()));
    const retry = next.verbs.find(
      (verb) =>
        verb.verb === "retry_effect" && verb.args?.effect === "owned_tool.run",
    );
    assert.equal(retry?.forceArgs?.force, true);
    await f.apply({
      action: "retry_effect",
      effect: "owned_tool.run",
      force: true,
    });
    assert.equal(
      ownerPendingEffects(collectOwnerVerbFacts(f.store, f.task())).some(
        (item) => item.effect === "owned_tool.run",
      ),
      false,
    );
    hold();
    assert.equal(
      ownerPendingEffects(collectOwnerVerbFacts(f.store, f.task())).some(
        (item) => item.effect === "owned_tool.run",
      ),
      true,
    );
  } finally {
    f.store.close();
  }
});
