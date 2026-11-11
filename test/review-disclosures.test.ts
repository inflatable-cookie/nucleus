import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Resolution } from "../core/resolution";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import { submissionSchema, type Task } from "../shared/contracts";
import type { RepositoryHooks } from "../core/hooks/hooks";
import type { Adapter } from "../core/host";

const head = "a".repeat(40);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "review-disclosures-"));
  const store = new Store(join(directory, "queue.sqlite"));
  store.setMeta("paused", false);
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "disclosures",
      title: "Review disclosure",
      repoPath: "/repo",
      planningCommit: head,
      handoffPath: "h",
      critical: true,
      originAgentId: "origin",
    }),
    "host",
    "",
    head,
  );
  const task = store.update(inserted.id, {
    phase: "closing",
    prHead: head,
    resumePrNumber: 1,
    prUrl: "https://github.com/example/repo/pull/1",
    resolution: {
      ...inserted.resolution,
      mergedCommit: head,
      syncedCommit: head,
      criticalReviewFallbacks: [
        {
          at: new Date().toISOString(),
          workerProfileId: "worker",
          reviewerProfileId: "ordinary-reviewer",
          reason:
            "No available independent rated peer; ordinary reviewer selection used",
        },
      ],
      forcedChecks: [
        {
          head,
          runId: "reviewer-run",
          reason:
            "macos-check is unrelated host failure; diff cannot have caused it",
          checks: [
            {
              name: "macos-check",
              jobUrl: "https://github.com/example/repo/actions/runs/1/job/2",
            },
          ],
        },
      ],
    },
  });
  return { store, task };
}

function assertDisclosures(text: string) {
  assert.match(
    text,
    /Critical review fallback: No available independent rated peer/,
  );
  assert.match(text, /ordinary-reviewer/);
  assert.match(
    text,
    /Reviewer forced checks at a{40}: macos-check https:\/\/github.com\/example\/repo\/actions\/runs\/1\/job\/2/,
  );
  assert.match(text, /unrelated host failure/);
}

test("next exposes critical status and fallback, and closeout persists review disclosures once", () => {
  const f = fixture();
  try {
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.task));
    assert.equal(next.critical, true);
    assert.equal(
      next.criticalReviewFallbacks[0].reviewerProfileId,
      "ordinary-reviewer",
    );
    const resolution = new Resolution(
      f.store,
      {} as Adapter,
      () => [],
      () => false,
    );
    const closeout = resolution as unknown as {
      closeoutWritten: (task: Task) => void;
    };
    const done = f.store.update(f.task.id, {
      phase: "done",
      reason: "Closeout complete",
    });
    closeout.closeoutWritten(done);
    const recorded = f.store.task(f.task.id);
    assertDisclosures(recorded.reason);
    closeout.closeoutWritten(recorded);
    assert.equal(
      f.store
        .eventsAll(f.task.id)
        .filter((event) => event.kind === "review_disclosures").length,
      1,
    );
  } finally {
    f.store.close();
  }
});

test("hook-owned closeout sends fallback and forced-check evidence in both summary fields", async () => {
  const f = fixture();
  try {
    let context: { summary: string; delivery: { summary: string } } | undefined;
    const hooks = {
      heldAutomaticReplay: () => null,
      emit: async (_event: unknown, _task: unknown, input: unknown) => {
        context = input as typeof context;
        return { hold: false, records: [] };
      },
    } as unknown as RepositoryHooks;
    const resolution = new Resolution(
      f.store,
      {} as Adapter,
      () => [],
      () => false,
      0,
      hooks,
    );
    await resolution.hookCloseout(f.task);
    assert.ok(context, "closeout hook receives its summary");
    assertDisclosures(context.summary);
    assertDisclosures(context.delivery.summary);
  } finally {
    f.store.close();
  }
});
