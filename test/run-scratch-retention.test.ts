import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, qualifiedThreadArchiveEffectKey } from "../core/store/store";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import { checkoutRunScratchPlacement, removeRecordedRunScratchDirectory, runTemporaryEnvironment } from "../core/workspaces/run-scratch";
import type { Adapter } from "../core/host";
import { submissionSchema, type Profile, type Run, type Task } from "../shared/contracts";

/**
 * Task 681 (project-e#280): a thread Queue retains across runs never loses the temp
 * directory its long-lived tool processes started with. Queue deletes a released
 * run's leaf only once no later turn can reuse the thread; the kept leaf is
 * removed when the thread is archived or the task is terminal, and a released
 * run of a thread that is already archived removes its own leaf at release.
 */

const base = "b".repeat(40), head = "a".repeat(40);
const reviewer: Profile = { id: "reviewer", name: "Reviewer", provider: "test", model: "review", notes: "", available: true, problem: "", supportedThinking: [] };

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nsq-run-scratch-retention-")));
  const mount = join(dir, "Stash");
  mkdirSync(mount);
  const volume = { MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true };
  const observe = () => volume;
  // The launch placement and the release remover prove the same fixture mount in
  // production's shape: a real directory under `<mount>/scratch/<namespace>/`.
  const scratch = checkoutRunScratchPlacement({ mount, uuid: "fixture", observe });
  const store = new Store(join(dir, "queue.sqlite"));
  (store as unknown as { runScratchRemover: (directory: string) => boolean }).runScratchRemover = directory => removeRecordedRunScratchDirectory(directory, { mount, uuid: "fixture", observe });
  store.setMeta("paused", false);
  const task = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Retained thread scratch", repoPath: join(dir, "repo"),
    planningCommit: base, handoffPath: "docs/handoff.md", originAgentId: "origin",
  }), "host", "handoff", base);
  /** One accepted launch of the task's retained thread: its own leaf, recorded before the prompt. */
  const launch = (runId: string, agentId = "retained-thread"): { run: Run; directory: string } => {
    const directory = runTemporaryEnvironment(runId, scratch).TMPDIR;
    const run: Run = { id: runId, taskId: task.id, role: "recovery", generation: 1, head, base, agentId, workspaceId: "workspace",
      profile: reviewer, status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: true,
      idleSince: null, completion: null, released: false, temporaryDirectory: directory };
    store.putRun(run);
    return { run, directory };
  };
  /** The turn ends: the run releases and stops owning the thread. */
  const release = (run: Run) => store.transaction(() => store.putRun({ ...run, released: true, status: "finished", active: false }));
  const archived = new Set<string>();
  const adapter = {
    originAgent: async (agentId: string) => ({ id: agentId, archived: archived.has(agentId) }),
    archiveAgent: async (agentId: string) => { archived.add(agentId); },
  } as unknown as Adapter;
  return { dir, store, task: task as Task, launch, release, adapter, archived,
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a retained thread keeps its launch temp directory across its runs and loses it when archived", async () => {
  const f = fixture();
  try {
    // The thread's first run starts with its leaf and releases. Deleting the leaf
    // here is the live fault: the thread's MCP children keep this launch
    // environment, and the next run's tool call wrote kernel assets into a
    // directory Queue had already removed.
    const first = f.launch("recovery-1");
    assert.equal(existsSync(first.directory), true, "the first run's launch leaf exists before release");
    f.release(first.run);
    assert.equal(existsSync(first.directory), true, "a released run keeps the leaf its thread launched with");

    // The thread's next run is a new run identity with its own leaf. Both leaves
    // are live for one thread, so a shell command prefix and a tool process'
    // launch environment cannot disagree about what survives the run.
    const second = f.launch("recovery-2");
    assert.notEqual(second.directory, first.directory);
    assert.equal(existsSync(second.directory), true);
    f.release(second.run);
    assert.equal(existsSync(first.directory), true, "the thread's earlier leaf is still there for its tools");
    assert.equal(existsSync(second.directory), true, "the thread's latest leaf survives its own release");

    // The thread retires. Queue's existing archive path records the archive and
    // then removes every recorded leaf that thread started with.
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.equal(f.store.threadArchiveEffect("retained-thread", "host")?.status, "archived");
    assert.equal(existsSync(first.directory), false, "retiring the thread removes the leaf its first run launched with");
    assert.equal(existsSync(second.directory), false, "retiring the thread removes every later leaf too");
  } finally { f.close(); }
});

test("a released run of a thread that is already archived removes its leaf at release", async () => {
  const f = fixture();
  try {
    const run = f.launch("recovery-3");
    // The thread was archived before this run released (a superseded tail or a
    // recovered disposition): no later turn can use the leaf, so retention does
    // not apply to it.
    f.store.setMeta(qualifiedThreadArchiveEffectKey("host", "retained-thread"), { status: "archived", at: new Date().toISOString() });
    assert.equal(existsSync(run.directory), true);
    f.release(run.run);
    assert.equal(existsSync(run.directory), false, "an already-retired thread's released run removes its leaf");
  } finally { f.close(); }
});

test("terminal cleanup takes every leaf the task's threads recorded, on the proved volume", () => {
  const f = fixture();
  try {
    const first = f.launch("recovery-4"), second = f.launch("recovery-5");
    f.release(first.run); f.release(second.run);
    assert.equal(existsSync(first.directory), true);
    assert.equal(existsSync(second.directory), true);
    // Nothing leaks past a terminal task: the transition removes every recorded
    // leaf, whether or not each thread's archive was observed first.
    f.store.update(f.task.id, { phase: "done", resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: "c".repeat(40) } }, "merged");
    assert.equal(existsSync(first.directory), false);
    assert.equal(existsSync(second.directory), false);
  } finally { f.close(); }
});
