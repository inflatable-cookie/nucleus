import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import type { HostProcessFact, HostProcessTable } from "../core/host/types";
import { workspaceToolProcessIssue } from "../core/recovery/stall";
import { runSchema, type Task } from "../shared/contracts";
import { fakeAdapter, submission } from "./support/fakes";

const HOST = "host-1";
const HEAD = "a".repeat(40);

/** A finished worker task whose run scratch is recorded, as a participant lease reads it. */
function seedWorkerTask(store: Store, slug: string): Task {
  const inserted = store.insert(
    submission({ submissionId: `sub-${slug}`, title: `Task ${slug}` }),
    HOST,
    "handoff",
    HEAD,
  );
  const agentId = `agent-${slug}`;
  const runId = `run-${slug}`;
  const temporaryDirectory = join(tmpdir(), `synthetic-${slug}-scratch`);
  const updated = store.update(inserted.id, {
    phase: "needs_attention",
    workspaceId: `ws-${slug}`,
    directory: `/tmp/synthetic-${slug}`,
    agentId,
    runId,
    reason: "Awaiting tool proof",
  });
  const run = runSchema.parse({
    id: runId,
    taskId: updated.id,
    role: "revision",
    generation: 1,
    head: HEAD,
    base: HEAD,
    agentId,
    workspaceId: `ws-${slug}`,
    hostId: HOST,
    profile: null,
    status: "stopped",
    createdAt: new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
    active: false,
    idleSince: new Date().toISOString(),
    completion: null,
    released: false,
  });
  store.putRun({ ...run, temporaryDirectory, released: true });
  return store.update(updated.id, { temporaryDirectory });
}

function fixture(
  t: TestContext,
  overrides: { hostProcessListing: () => Promise<HostProcessTable | null> },
) {
  const store = new Store(":memory:");
  const idle = (id: string) => ({
    id,
    workspaceId: `ws-${id.replace(/^agent-/, "")}`,
    status: "idle",
    active: false,
    activeTurnId: null,
    permissions: false,
    error: "",
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    pendingBackgroundTasks: [] as string[],
  });
  const adapter = fakeAdapter({
    hostId: HOST,
    observe: async (id: string) => idle(id),
    observeParticipant: async (id: string) => idle(id),
    agentTimelinePage: async () => null,
    // A live holder in the task workspace is probed the same way the host probes it.
    noLiveWorkspaceProcesses: async (
      workspace: string,
      runIds: string[],
      _runtime: unknown,
      listing: HostProcessFact[],
    ) => workspaceToolProcessIssue(listing, join(tmpdir(), workspace), runIds),
    ...overrides,
  });
  const engine = new Engine(store, adapter as unknown as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  return { store, engine };
}

/** The reason a participant lease refuses on this task's worker, or null when it clears. */
function custodyIssue(
  f: ReturnType<typeof fixture>,
  task: Task,
): Promise<string | null> {
  return f.engine.resolution.participantLease.exactCustodyIssue(
    task,
    task.agentId!,
    task.workspaceId!,
    { directFallback: true },
  );
}

test("a live workspace holder is the refusal even when the listing is also incomplete", async (t) => {
  let listing: HostProcessTable | null = null;
  const f = fixture(t, { hostProcessListing: async () => listing });
  const seeded = seedWorkerTask(f.store, "holder-incomplete");
  // The holder's working directory is the task workspace, and another row's
  // working directory could not be read, so the listing is incomplete.
  listing = Object.assign(
    [
      {
        pid: 42,
        ppid: 1,
        pgid: 42,
        uid: 501,
        startIdentity: "synthetic-start",
        command: "synthetic-writer",
        cwd: join(tmpdir(), seeded.workspaceId!),
      },
    ],
    { cwdComplete: false },
  );
  const issue = await custodyIssue(f, seeded);
  assert.ok(issue, "a known holder refuses the lease");
  assert.match(issue, /remains in the task workspace process tree/);
  assert.doesNotMatch(
    issue,
    /truncated/,
    "a coverage gap must not mask a known holder",
  );
});

test("incomplete coverage with no known holder names the truncated listing", async (t) => {
  let listing: HostProcessTable | null = null;
  const f = fixture(t, { hostProcessListing: async () => listing });
  const seeded = seedWorkerTask(f.store, "incomplete-only");
  listing = Object.assign([], { cwdComplete: false });
  assert.equal(
    await custodyIssue(f, seeded),
    "the process listing is truncated",
  );
});

test("a timed-out listing refuses with its own named reason", async (t) => {
  const f = fixture(t, {
    hostProcessListing: async () => {
      throw new Error("the process listing timed out after 5000 ms");
    },
  });
  const seeded = seedWorkerTask(f.store, "timed-out");
  const issue = await custodyIssue(f, seeded);
  assert.ok(issue, "a timed-out listing refuses the lease");
  assert.match(issue, /the process listing timed out after 5000 ms/);
  assert.doesNotMatch(issue, /truncated/);
});
