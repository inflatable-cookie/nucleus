import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { runPrompt } from "../core/dispatch/prompts";
import { Reports, reportSchema } from "../core/intake/report";
import { reviewPublicationBody } from "../core/review/review-body";
import { Store } from "../core/store/store";
import { completionSchema, submissionSchema } from "../shared/contracts";
import { runSchema } from "../shared/schema/runs";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import { fakeAdapter, profile } from "./support/fakes";

const base = "b".repeat(40), head = "a".repeat(40);
const prUrl = "https://github.com/example/repo/pull/1";

/** A tiny synthetic PNG: the bytes are unique, so the hash assertion is meaningful. */
function png(seed: string): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(seed)]);
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-proof-files-")));
  const worktree = join(dir, "worktree"), scratchRoot = join(dir, "scratch", "nucleus"), scratch = join(scratchRoot, "ab12cd34");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const worker = profile("worker");
  store.setMeta("pool", [{ profileId: worker.id, enabled: true, group: "author", roles: ["worker"], weight: 1, scopes: ["general"] }]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Visual proof", repoPath: worktree, planningCommit: base, handoffPath: "handoff.md",
    originAgentId: "origin", baseBranch: "main",
  }), "host", "handoff", base);
  const taskId = submitted.id, runId = "initial-run", token = "proof-files-token";
  let reportingRunId = runId;
  store.update(taskId, {
    phase: "working", planningBase: base, workspaceId: "workspace", directory: worktree, branch: submitted.branch,
    temporaryDirectory: scratch, agentId: "worker-thread", runId, profile: worker, workerModel: worker.model,
    agentActive: true, lastAgentStatus: "running", lastObservedAt: new Date().toISOString(),
  });
  store.setCredential(runId, token);
  const adapter = fakeAdapter({
    profiles: async () => [worker], validate: async () => base, verifyWorkspace: async () => submitted.branch,
    createWorkspace: async () => { throw new Error("proof-files fixture does not create workspaces"); },
    createAgent: async () => { throw new Error("proof-files fixture does not create agents"); },
    observe: async (id: string) => ({ id, workspaceId: "workspace", status: "idle", active: false, permissions: false, error: "" }),
    verifyPr: async () => ({ url: prUrl, head, repository: "example/repo", headRepository: "example/repo" }),
    verifyPrIdentity: async () => ({ url: prUrl, head, repository: "example/repo", headRepository: "example/repo" }),
    verifyCleanQueueWorktree: async () => {}, findOpenBranchPr: async () => [],
    mergeGate: async () => ({ head, base: "main", wait: "" }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: "main" }), syncMain: async () => base,
    verifyCloseout: async () => {}, notify: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker];
  // The report path the worker CLI and the MCP bridge both use: schema, then the
  // authenticated report intake.
  const reports = new Reports(engine);
  const complete = (status: string, extra: Record<string, unknown> = {}) => reports.report(reportSchema.parse({
    eventId: randomUUID(), taskId, runId: reportingRunId, status, summary: "Visual proof delivered", prNumber: 1, ...extra,
  }), token);
  // The CLI fallback posts one parsed completion straight to the callback; it has
  // no report wrapper, so an identical retry must resolve through intake alone.
  const cliReport = (eventId: string, extra: Record<string, unknown> = {}) => engine.complete(completionSchema.parse({
    eventId, taskId, runId: reportingRunId, status: "ready_for_review", summary: "Visual proof delivered", prNumber: 1, ...extra,
  }), token);
  const reportOnce = (eventId: string, extra: Record<string, unknown> = {}) => reports.report(reportSchema.parse({
    eventId, taskId, runId: reportingRunId, status: "ready_for_review", summary: "Visual proof delivered", prNumber: 1, ...extra,
  }), token);
  const startRevision = () => {
    reportingRunId = "revision-run";
    store.update(taskId, { runId: reportingRunId });
    store.setCredential(reportingRunId, token);
    store.putRun(runSchema.parse({ id: reportingRunId, taskId, role: "revision", generation: 1, head: base, base,
      agentId: "worker-thread", workspaceId: "workspace", profile: worker, status: "running", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, temporaryDirectory: scratch }));
  };
  const task = () => store.task(taskId);
  return { dir, worktree, scratch, scratchRoot, store, engine, taskId, runId, token, complete, reportOnce, cliReport, startRevision, task,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a revision starting at A records two proof files under its reported PR head B", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, "before.png"), png("before"));
    writeFileSync(join(f.worktree, "after.png"), png("after"));
    const files = [
      { label: "Before (dark theme)", path: join(f.scratch, "before.png") },
      { label: "After (dark theme)", path: join(f.worktree, "after.png") },
    ];
    f.startRevision();
    // The report schema and the report bridge accept the same two entries.
    assert.equal(completionSchema.parse({ eventId: "e", taskId: f.taskId, runId: f.runId, status: "ready_for_review", summary: "Ready", prNumber: 1, proofFiles: files }).proofFiles?.length, 2);
    assert.equal(reportSchema.parse({ eventId: "e", taskId: f.taskId, runId: f.runId, status: "ready_for_review", summary: "Ready", prNumber: 1, proofFiles: files }).proofFiles?.length, 2);

    const receipt = await f.reportOnce("proof-report-1", { head, proofFiles: files }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
    // An identical retry of the same report resolves to the first receipt and
    // records no second copy: the report's receipt is the accepted completion.
    assert.deepEqual(await f.reportOnce("proof-report-1", { proofFiles: files }), receipt);
    const recorded = f.task().proofFiles;
    assert.equal(recorded.length, 2);
    assert.deepEqual(recorded.map(record => record.head), [head, head]);
    assert.deepEqual(recorded.map(record => record.label), ["Before (dark theme)", "After (dark theme)"]);
    for (const [index, file] of files.entries()) {
      const record = recorded[index]!;
      assert.equal(record.sha256, createHash("sha256").update(readFileSync(file.path)).digest("hex"));
      assert.ok(record.path.startsWith(join(f.scratchRoot, "evidence", f.taskId, head)), "the copy lives in Nucleus's per-task, per-head evidence directory");
      assert.equal(record.path.includes("/worktree/"), false);
      assert.deepEqual(readFileSync(record.path), readFileSync(file.path), "the copied bytes are the reported bytes");
    }
    const stored = f.task().completion!;
    assert.equal(Object.hasOwn(stored, "proofFiles"), false, "the worker's local source paths never enter the stored completion");

    const reviewerRun = {
      id: "review-run", taskId: f.taskId, role: "reviewer" as const, generation: 1, head, base, agentId: "reviewer",
      workspaceId: "workspace", profile: null, createdAt: "2026-11-12T00:00:00.000Z", lastObservedAt: null, active: false,
      idleSince: null, released: false, status: "running",
    };
    const prompt = runPrompt(f.task(), reviewerRun as never, "/helper", "/ticket", true);
    for (const record of recorded) {
      assert.ok(prompt.includes(record.path), `the reviewer prompt names ${record.label}'s local copy`);
      assert.ok(prompt.includes(record.sha256), `the reviewer prompt carries ${record.label}'s hash`);
      assert.ok(prompt.includes(record.label));
    }
    assert.match(prompt, /never uploaded to the forge/);
  } finally { await f.close(); }
});

test("proof files are refused when the reported head does not match the pushed PR head", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, "proof.png"), png("proof"));
    await assert.rejects(f.reportOnce("proof-wrong-head", {
      head: base, proofFiles: [{ label: "Proof", path: join(f.scratch, "proof.png") }],
    }), /reported head for proofFiles must match the pushed PR head/);
    assert.equal(f.task().proofFiles.length, 0);
    assert.equal(existsSync(join(f.scratchRoot, "evidence")), false);
  } finally { await f.close(); }
});

test("the reviewer at B sees latest author-run proof stored under A with its recorded head", async () => {
  const f = fixture();
  try {
    const oldRecord = {
      head: base, label: "Earlier revision screenshot", name: "earlier.png", path: join(f.scratchRoot, "evidence", f.taskId, base, "earlier.png"),
      sha256: createHash("sha256").update(png("earlier")).digest("hex"), bytes: png("earlier").byteLength,
      runId: "earlier-author-run", eventId: "earlier-event", at: new Date().toISOString(),
    };
    f.store.appendProofFiles(f.taskId, [oldRecord]);
    const reviewerRun = { id: "review-run", taskId: f.taskId, role: "reviewer" as const, generation: 1, head, base,
      agentId: "reviewer", workspaceId: "workspace", profile: null, createdAt: "2026-11-12T00:00:00.000Z",
      lastObservedAt: null, active: false, idleSince: null, released: false, status: "running" };
    const prompt = runPrompt(f.task(), reviewerRun as never, "/helper", "/ticket", true);
    assert.ok(prompt.includes(oldRecord.path));
    assert.ok(prompt.includes("recorded head " + base));
    assert.ok(prompt.includes("Earlier revision screenshot"));
  } finally { await f.close(); }
});

test("a path outside the task's own scratch and worktree is refused and nothing is copied", async () => {
  const f = fixture();
  try {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ns-proof-outside-")));
    try {
      const foreign = join(outside, "session.png");
      writeFileSync(foreign, png("foreign"));
      await assert.rejects(f.complete("ready_for_review", { head, proofFiles: [{ label: "Foreign", path: foreign }] }),
        /outside this task's own scratch and worktree/);
      assert.equal(f.task().proofFiles.length, 0, "nothing is recorded on the task");
      assert.equal(existsSync(join(f.scratchRoot, "evidence")), false, "no evidence directory or file is created");
      assert.equal(f.task().completion, null, "the refused report records no completion");
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { await f.close(); }
});

test("no local proof path reaches anything published to the forge", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.scratch, "before.png"), png("before"));
    writeFileSync(join(f.scratch, "after.png"), png("after"));
    const files = [
      { label: "Before", path: join(f.scratch, "before.png") },
      { label: "After", path: join(f.scratch, "after.png") },
    ];
    const receipt = await f.cliReport("cli-proof-report-1", { head, proofFiles: files }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
    // The same CLI report retried byte-for-byte is the first receipt, not a conflict.
    assert.deepEqual(await f.cliReport("cli-proof-report-1", { head, proofFiles: files }), receipt);
    const task = f.task(), recorded = task.proofFiles;
    assert.equal(recorded.length, 2);
    const reviewerRun = { id: "review-run", taskId: f.taskId, role: "reviewer", generation: 1, head, base } as never;
    const findings = `Judge the screenshots: sha256 ${recorded.map(record => record.sha256).join(", ")}. Both match the reported hashes.`;
    const body = reviewPublicationBody(task, reviewerRun, "ready_to_merge", findings, []);
    assert.ok(body.includes(recorded[0]!.sha256) && body.includes(recorded[1]!.sha256), "the hash the PR may carry is present");
    for (const record of recorded) assert.equal(body.includes(record.path), false, `the published body never names ${record.label}'s local copy`);
    for (const file of files) assert.equal(body.includes(file.path), false, `the published body never names the worker's source path ${file.label}`);
    assert.equal(body.includes(f.scratch), false);
    assert.equal(body.includes(f.worktree), false);
  } finally { await f.close(); }
});
