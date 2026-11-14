import { fakeAdapter } from './support/fakes';
/**
 * Spec 035 / orchestration "Worktree validation" (task 450): one lifecycle pass
 * asks the host at most once about one task's worktree, and the recovery route
 * asks only where its decision depends on the answer.
 *
 * The live shape (Supervisor `b885f087`'s 30-second profile of #449): recovery
 * worktree validation scans were about 1.2 s of a 4.2 s busy window. A `ps -A`
 * (plus `lsof`) scan is a bounded pass cost, not a per-read one, so the stopping
 * run, its callback reminder and its recovery route read one scan per pass
 * instead of one each, and the route — whose only load-bearing use of the scan is
 * a callback reminder it is holding — makes no scan at all in any other shape.
 *
 * Every count here is the adapter's `worktreeValidation` call, which is the
 * boundary where the real `ps`/`lsof` spawn happens, so this file counts actual
 * scans rather than helper cache hits, and it reads through `validationEvidence`
 * so the number of reads is visible beside them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { VALIDATION_SCAN_PASS_MAX_MS } from "../core/resolution";
import { taskProgressDigest } from "../core/recovery/coordinator-report";
import { submissionSchema, type Profile, type Run, type Task } from "../shared/contracts";
import type { Incident } from "../shared/incident";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import type { WorktreeValidationScan } from "../core/workspaces/worktree-validation";
import { stepEngine } from "./support/engine-step";

const head = "a".repeat(40), base = "b".repeat(40);

const profile = (id: string, roles: Profile extends never ? never : Array<"worker" | "reviewer" | "coordinator">) => ({
  profile: { id, name: id, provider: "test", model: id, notes: "", available: true, problem: "", supportedThinking: ["low"] } as Profile,
  entry: { profileId: id, enabled: true, group: id, roles, weight: 1, scopes: ["general"] as const },
});

interface ScanCall { directory: string; argv: string[][] }

/** The one-shot callback reminder incident a route pass may hold on. */
function reminderIncident(): Incident {
  const at = new Date().toISOString();
  return {
    id: "incident", role: "worker", runId: "initial", fingerprint: "", attempt: 0, cause: "missing_callback",
    detail: "One bounded callback reminder issued", action: "callback_reminder", status: "reconciling",
    createdAt: at, updatedAt: at,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-validation-scan-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const worker = profile("author", ["worker", "reviewer"]);
  const coordinator = profile("coordinator", ["coordinator"]);
  store.setMeta("pool", [worker.entry, coordinator.entry]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Stopped worker", repoPath: "/repo", planningCommit: base,
    handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", base);
  const task = store.update(submitted.id, {
    phase: "needs_attention", reason: "The revision thread stopped without a callback; inspect the thread",
    workspaceIntent: true, agentIntent: true, workspaceId: "workspace", directory: "/worktree",
    agentId: "worker", runId: "initial", profile: worker.profile, workerModel: worker.profile.model,
    idleSince: new Date().toISOString(), resolution: { ...submitted.resolution, attention: true },
  });

  /** The adapter's scan: the exact boundary a real `ps`/`lsof` spawn sits behind. */
  const scans: ScanCall[] = [];
  const verdict: { current: WorktreeValidationScan } = { current: { state: "absent" } };
  const reads: { shared: number; fresh: number } = { shared: 0, fresh: 0 };
  const runs: Run[] = [];
  const notices: string[] = [];
  const agentStates = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string }>();
  const idle = (id: string) => agentStates.set(id, { id, workspaceId: "workspace", status: "idle", active: false, permissions: false, error: "" });
  idle("worker");
  idle("coordinator");
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => [worker.profile, coordinator.profile],
    validate: async () => base,
    verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error("No workspace creation in this fixture"); },
    createAgent: async () => { throw new Error("No agent creation in this fixture"); },
    observe: async id => {
      const state = agentStates.get(id);
      if (!state) throw new Error("Agent missing");
      return state as never;
    },
    verifyPr: async () => ({ head, url: "https://github.com/example/repo/pull/1" }),
    verifyPrIdentity: async () => ({ head, url: "https://github.com/example/repo/pull/1" }),
    verifyCleanQueueWorktree: async () => {},
    verifyResume: async () => {},
    createRun: async (_t, run) => {
      runs.push(run);
      return { id: `agent-${run.id}`, workspaceId: run.workspaceId };
    },
    sendRun: async () => {},
    findRunAgents: async () => [],
    supportsCoordinatorRecovery: true,
    verifyReview: async () => {},
    mergeGate: async () => ({ head, base: "main", wait: "" }),
    merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: "main" }),
    syncMain: async () => base,
    verifyCloseout: async () => {},
    notify: async (_id: string, _key: string, message: string) => { notices.push(message); },
    // The one scan this fixture counts: the resolution's own adapter observation.
    worktreeValidation: (directory: string, argv: string[][]) => {
      scans.push({ directory, argv });
      return verdict.current;
    },
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker.profile, coordinator.profile];
  // Count the reads above the cache as well as the scans beneath it, so "shared"
  // is proven by the reads and not only by the scan count.
  const resolution = engine.resolution;
  const original = resolution.validationEvidence.bind(resolution);
  resolution.validationEvidence = (t: Task, options: { fresh?: boolean } = {}) => {
    if (options.fresh === true) reads.fresh++; else reads.shared++;
    return original(t, options);
  };
  const current = () => store.task(task.id);
  const events = (kind: string) => store.eventsAll(task.id).filter(event => event.kind === kind);
  const scanCount = () => scans.length;
  const resetCounts = () => { scans.length = 0; reads.shared = 0; reads.fresh = 0; };
  return { dir, store, engine, resolution, adapter, task, current, events, scans, reads, verdict, runs, notices, scanCount, resetCounts,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** One pass of the task quantum, without the lifecycle follow-ups it schedules. */
const onePass = (f: ReturnType<typeof fixture>) => stepEngine(f.engine);

test("the shared scan is bounded by one pass and by a few seconds, never by history", () => {
  assert.ok(VALIDATION_SCAN_PASS_MAX_MS > 0 && VALIDATION_SCAN_PASS_MAX_MS <= 10_000,
    `one pass's scan may answer for seconds, not minutes (${VALIDATION_SCAN_PASS_MAX_MS} ms)`);
});

test("one pass pays one shared scan plus the route's own launch decision, not one per read", async () => {
  const f = fixture();
  try {
    await onePass(f);
    const reads = f.reads.shared + f.reads.fresh;
    assert.equal(reads, 4, `the pass reads validation four times (${f.reads.shared} shared, ${f.reads.fresh} fresh)`);
    assert.equal(f.reads.fresh, 1, "the one fresh read is the recovery route's own launch decision");
    assert.equal(f.scanCount(), 2, `two scans answer the four reads (${f.scanCount()})`);
    // Every read saw the same complete answer, and the pass recorded the hold it
    // always recorded for a stopped worker with nothing in the worktree.
    assert.equal(f.current().resolution.stop?.reason, "operator_needed");
  } finally { await f.close(); }
});

test("the parent shape scans once per read, which is the cost this removes", async () => {
  const shared = fixture(), parent = fixture();
  try {
    await onePass(shared);
    const sharedScans = shared.scanCount();
    // The parent shape in the same fixture: no reuse at all.
    parent.resolution.validationScanShareMs = 0;
    await onePass(parent);
    assert.equal(parent.scanCount(), parent.reads.shared + parent.reads.fresh,
      "with sharing disabled every read pays its own scan");
    assert.equal(parent.scanCount(), 4, "the parent's four reads are four host scans");
    assert.ok(parent.scanCount() > sharedScans,
      `sharing removes the repeated scans (${sharedScans} against ${parent.scanCount()} for the same pass)`);
  } finally { await shared.close(); await parent.close(); }
});

test("the recovery route makes no validation scan unless it is holding a callback reminder", async () => {
  const plain = fixture();
  try {
    // No reminder: the scan cannot change this route's decision, so no scan runs,
    // however many times the route is asked.
    const task = plain.current();
    for (let index = 0; index < 4; index++) await plain.resolution.recovery.route(plain.store.task(task.id));
    assert.equal(plain.scanCount(), 0, `no scan for a route that is not holding a callback reminder (${plain.scanCount()})`);
    // The parent's unconditional read, in the same fixture: one adapter scan.
    plain.resolution.validationEvidence(plain.store.task(task.id));
    assert.equal(plain.scanCount(), 1, "the parent's unconditional route read is one scan per pass");
  } finally { await plain.close(); }

  const holding = fixture();
  try {
    // A callback reminder is the one shape where absence lets a coordinator be
    // launched over live QA, so that shape asks freshly on every route pass.
    const task = holding.current();
    holding.verdict.current = { state: "alive", command: "effigy qa:changed", pid: 4242 };
    holding.store.update(task.id, { resolution: { ...task.resolution, incident: reminderIncident() } });
    assert.equal(await holding.resolution.recovery.route(holding.store.task(task.id)), null);
    assert.equal(await holding.resolution.recovery.route(holding.store.task(task.id)), null);
    assert.equal(holding.reads.fresh, 2, "each reminder-holding route pass reads freshly");
    assert.equal(holding.scanCount(), 2, "and pays its own scan each time: absence is load-bearing there");
    assert.deepEqual(holding.runs, [], "live QA holds the recovery");
  } finally { await holding.close(); }
});

test("a scan answers inside its pass only, and the next pass reads the worktree again", async t => {
  const f = fixture();
  try {
    const task = f.current();
    f.resolution.beginValidationScanPass();
    assert.deepEqual(f.resolution.validationEvidence(task), { state: "absent" });
    assert.equal(f.scanCount(), 1);
    // Work appears after the scan: the pass that already read keeps its answer
    // (that is the bound), and the pass that follows observes it.
    f.verdict.current = { state: "alive", command: "effigy qa:changed", pid: 4242 };
    assert.equal(f.resolution.validationEvidence(task).state, "absent", "the pass's own answer stands inside it");
    assert.equal(f.scanCount(), 1, "and costs no second scan");
    f.resolution.beginValidationScanPass();
    assert.equal(f.resolution.validationEvidence(task).state, "alive", "a new pass reads the worktree again");
    assert.equal(f.scanCount(), 2);
    // Alive to gone in the other direction: the next pass stops holding.
    f.verdict.current = { state: "absent" };
    f.resolution.beginValidationScanPass();
    assert.equal(f.resolution.validationEvidence(task).state, "absent");
    assert.equal(f.scanCount(), 3);
  } finally { await f.close(); }
});

test("an incomplete scan is never shared as an observation, and still holds", async t => {
  const f = fixture();
  try {
    const task = f.current();
    f.verdict.current = { state: "unverified", reason: "process listing failed" };
    f.resolution.beginValidationScanPass();
    const first = f.resolution.validationEvidence(task);
    const second = f.resolution.validationEvidence(task);
    assert.equal(first.state, "unverified");
    assert.equal(second.state, "unverified");
    assert.equal(f.scanCount(), 2, "an unverified listing is not remembered: the next read asks again");
    assert.match(second.state === "unverified" ? second.reason : "", /process listing failed/);
    // The hold it produces is unchanged, with its own visible reason and no
    // coordinator attention on QA that is simply unproven.
    assert.equal(await f.resolution.heavyRunAlive(task), true, "an unverified scan holds like a live one");
    assert.equal(f.current().resolution.stop?.reason, "validation");
  } finally { await f.close(); }
});

test("a changed checkout, selector argv or judged run is its own question", async t => {
  const f = fixture();
  try {
    const task = f.current();
    f.resolution.beginValidationScanPass();
    f.resolution.validationEvidence(task);
    assert.equal(f.scanCount(), 1);
    // Same task, same pass, a different worktree: not the same evidence.
    f.resolution.validationEvidence({ ...task, directory: "/other-worktree" });
    assert.equal(f.scanCount(), 2, "a different checkout is scanned");
    // A different effective selector argv is a different question too.
    f.store.patchRepository({ origin: null, path: "/repo" }, { qa: { argv: ["bun", "run", "qa"], timeoutMs: 60_000 } });
    f.resolution.validationEvidence(f.store.task(task.id));
    assert.equal(f.scanCount(), 3, "a changed selector argv is scanned");
    // So is the run the scan is judging.
    const judged = f.store.task(task.id);
    f.resolution.validationEvidence({ ...judged, resolution: { ...judged.resolution, currentRunId: "revision-run" } });
    assert.equal(f.scanCount(), 4, "a changed judged run is scanned");
    // And an unchanged read of any of them is still free inside the pass.
    f.resolution.validationEvidence({ ...judged, resolution: { ...judged.resolution, currentRunId: "revision-run" } });
    assert.equal(f.scanCount(), 4, "the same evidence stays one scan");
  } finally { await f.close(); }
});

test("several tasks in one pass each scan once, and the next pass is fresh for all of them", async t => {
  const f = fixture();
  try {
    const another = f.store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: "Second stopped worker", repoPath: "/repo", planningCommit: base,
      handoffPath: "handoff.md", originAgentId: "origin",
    }), "host", "handoff", base);
    const second = f.store.update(another.id, {
      phase: "needs_attention", reason: "Second stopped worker", workspaceIntent: true, agentIntent: true,
      workspaceId: "workspace-2", directory: "/worktree-2", agentId: "worker-2", runId: "initial-2",
      profile: f.current().profile, idleSince: new Date().toISOString(), resolution: { ...another.resolution, attention: true },
    });
    f.resolution.beginValidationScanPass();
    f.resolution.validationEvidence(f.current());
    f.resolution.validationEvidence(f.current());
    f.resolution.validationEvidence(second);
    f.resolution.validationEvidence(second);
    assert.equal(f.scanCount(), 2, "one scan per task worktree in the pass, not one per read");
    assert.deepEqual(f.scans.map(call => call.directory).sort(), ["/worktree", "/worktree-2"]);
    f.verdict.current = { state: "alive", command: "effigy qa:changed", pid: 7 };
    f.resolution.beginValidationScanPass();
    assert.equal(f.resolution.validationEvidence(f.current()).state, "alive");
    assert.equal(f.resolution.validationEvidence(second).state, "alive");
    assert.equal(f.scanCount(), 4, "the next pass reads both worktrees again");
  } finally { await f.close(); }
});

test("no stale absence is used at an effect boundary: work that appeared holds the recovery", async t => {
  const f = fixture();
  try {
    const task = f.current();
    // An earlier read in this pass saw an empty worktree.
    f.resolution.beginValidationScanPass();
    assert.equal(f.resolution.validationEvidence(task).state, "absent");
    assert.equal(f.scanCount(), 1);
    // Then QA starts, and the route is holding a callback reminder: its hold is
    // decided on a fresh scan, so it sees the work and launches nothing.
    f.verdict.current = { state: "alive", command: "effigy qa:changed", pid: 4242 };
    const source = f.store.task(task.id);
    f.store.update(source.id, { resolution: { ...source.resolution, incident: reminderIncident() } });
    const outcome = await f.resolution.recovery.route(f.store.task(task.id));
    assert.equal(outcome, null, "the route holds instead of launching a coordinator over live QA");
    assert.equal(f.scanCount(), 2, "the effect boundary paid a fresh scan");
    assert.deepEqual(f.runs, [], "no coordinator run was created");
    // The owner-verb lease-release path is fresh for the same reason.
    assert.ok(f.resolution.validationAlive(f.store.task(task.id)), "a live worktree is live for the owner verb too");
    assert.equal(f.scanCount(), 3, "the owner verb's proof is its own fresh read");
  } finally { await f.close(); }
});

test("an escalated episode still returns its own summary and scans nothing", async t => {
  const f = fixture();
  try {
    const task = f.current();
    f.store.update(task.id, { resolution: { ...task.resolution, incident: null, recovery: {
      id: "episode", key: "key", generation: 1, runId: null, agentId: null, status: "escalated" as const,
      summary: "Operator action required", idleSince: null, incidentId: null, progress: taskProgressDigest(task),
    } } });
    const outcome = await f.resolution.recovery.route(f.store.task(task.id));
    assert.equal(outcome, "Operator action required");
    assert.equal(f.scanCount(), 0, "an already-escalated episode needs no worktree scan to report itself");
    assert.deepEqual(f.runs, []);
  } finally { await f.close(); }
});
