import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { submissionSchema } from "../shared/contracts";

const head = "a".repeat(40),
  base = "b".repeat(40);
test("next offers forced merge in an ordinary awaiting-review state with no blocking effects", () => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-next-")), "queue.sqlite"),
  );
  try {
    const inserted = store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Ordinary review",
        repoPath: "/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      base,
    );
    const task = store.update(inserted.id, {
      phase: "awaiting_review",
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/7",
      resumePrNumber: 7,
    });
    const facts = collectOwnerVerbFacts(store, task);
    assert.equal(ownerPendingEffects(facts).length, 0);
    const merge = ownerTaskNext(facts).verbs.find(
      (view) => view.verb === "move" && view.forceArgs?.to === "merge",
    );
    assert.equal(merge?.forceArgs?.force, true);
    assert.ok(merge?.forceFill?.includes("qualification"));
  } finally {
    store.close();
  }
});
