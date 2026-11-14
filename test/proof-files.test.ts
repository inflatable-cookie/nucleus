import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { runPrompt, workerPrompt } from "../core/dispatch/prompts";
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

function fixture(options: { branchPrs?: { number: number; url: string; head: string }[] } = {}) {
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
  let reportingToken = token;
  let forgeHead = head;
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
    verifyPr: async () => ({ url: prUrl, head: forgeHead, repository: "example/repo", headRepository: "example/repo" }),
    verifyPrIdentity: async () => ({ url: prUrl, head: forgeHead, repository: "example/repo", headRepository: "example/repo" }),
    verifyCleanQueueWorktree: async () => {}, findOpenBranchPr: async () => options.branchPrs ?? [],
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
  }), reportingToken);
  // The CLI fallback posts one parsed completion straight to the callback; it has
  // no report wrapper, so an identical retry must resolve through intake alone.
  const cliReport = (eventId: string, extra: Record<string, unknown> = {}) => engine.complete(completionSchema.parse({
    eventId, taskId, runId: reportingRunId, status: "ready_for_review", summary: "Visual proof delivered", prNumber: 1, ...extra,
  }), reportingToken);
  const reportOnce = (eventId: string, extra: Record<string, unknown> = {}) => reports.report(reportSchema.parse({
    eventId, taskId, runId: reportingRunId, status: "ready_for_review", summary: "Visual proof delivered", prNumber: 1, ...extra,
  }), reportingToken);
  const startRevision = () => {
    reportingRunId = "revision-run";
    reportingToken = "proof-files-revision-token";
    const task = store.task(taskId);
    store.update(taskId, { runId: reportingRunId, resolution: { ...task.resolution, currentRunId: reportingRunId } });
    store.setCredential(reportingRunId, reportingToken);
    store.putRun(runSchema.parse({ id: reportingRunId, taskId, role: "revision", generation: 1, head: base, base,
      agentId: "worker-thread", workspaceId: "workspace", profile: worker, status: "running", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, temporaryDirectory: scratch }));
    assert.equal(store.task(taskId).resolution.currentRunId, reportingRunId);
    assert.equal(store.run(reportingRunId)?.released, false);
  };
  const startExecutor = (executorScratch: string, sourceHead: string, tree: string) => {
    reportingRunId = "executor-run";
    reportingToken = "proof-files-executor-token";
    forgeHead = sourceHead;
    store.setCredential(reportingRunId, reportingToken);
    store.putRun(runSchema.parse({ id: reportingRunId, taskId, role: "executor", generation: 1, head: sourceHead, base,
      agentId: "executor-thread", workspaceId: "workspace", profile: worker, status: "running", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, temporaryDirectory: executorScratch,
      proofExecution: { selector: "effigy test unit -- test/proof.test.ts", inputs: [], prNumber: 1, tree,
        operationId: "synthetic-operation", briefVersion: 1, briefDigest: null, returnPhase: "awaiting_review",
        authorizedBy: { role: "queue_dispatch", caller: null, note: null } } }));
  };
  const task = () => store.task(taskId);
  return { dir, worktree, scratch, scratchRoot, store, engine, adapter, taskId, runId, token, complete, reportOnce, cliReport, startRevision, startExecutor, task,
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
    const revisionRun = f.store.run("revision-run")!;
    const authorPrompt = runPrompt(f.task(), revisionRun, "/helper", "/ticket", true);
    assert.match(authorPrompt, /top-level head equal to the current pushed PR HEAD/);
    assert.match(authorPrompt, /report the head it now pushed, not the run's starting head/);
    assert.doesNotMatch(authorPrompt, /bridge supplies exact head/);
    // The report schema and the report bridge accept the same two entries.
    assert.equal(completionSchema.parse({ eventId: "e", taskId: f.taskId, runId: f.runId, status: "ready_for_review", summary: "Ready", prNumber: 1, proofFiles: files }).proofFiles?.length, 2);
    assert.equal(reportSchema.parse({ eventId: "e", taskId: f.taskId, runId: f.runId, status: "ready_for_review", summary: "Ready", prNumber: 1, proofFiles: files }).proofFiles?.length, 2);

    const receipt = await f.reportOnce("proof-report-1", { head, proofFiles: files }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
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
    const stored = f.store.run("revision-run")!.completion!;
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

test("an executor proof delivers retained evidence beside its run scratch for the reviewer", async () => {
  const f = fixture();
  try {
    const remote = join(f.dir, "origin.git");
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    execFileSync("git", ["-C", f.worktree, "init", "--quiet", "-b", f.task().branch]);
    execFileSync("git", ["-C", f.worktree, "config", "user.email", "proof-files@example.com"]);
    execFileSync("git", ["-C", f.worktree, "config", "user.name", "Proof Files"]);
    execFileSync("git", ["-C", f.worktree, "remote", "add", "origin", remote]);
    writeFileSync(join(f.worktree, "source.txt"), "source\n");
    execFileSync("git", ["-C", f.worktree, "add", "source.txt"]);
    execFileSync("git", ["-C", f.worktree, "commit", "--quiet", "-m", "source"]);
    execFileSync("git", ["-C", f.worktree, "-c", "protocol.file.allow=always", "push", "--quiet", "origin", f.task().branch]);
    const sourceHead = execFileSync("git", ["-C", f.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", f.worktree, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const executorScratch = join(f.scratchRoot, "ef567890");
    mkdirSync(executorScratch);
    const sourcePath = join(executorScratch, "capture.png");
    writeFileSync(sourcePath, png("executor capture"));
    f.startExecutor(executorScratch, sourceHead, tree);
    const executorPrompt = runPrompt(f.task(), f.store.run("executor-run")!, "/helper", "/ticket", true);
    assert.match(executorPrompt, /Executor evidence files for the retained reviewer/);
    assert.match(executorPrompt, /top-level head equal to the current pushed PR HEAD/);

    const receipt = await f.complete("proof_executed", {
      head: sourceHead,
      proofResult: { status: "passed", selector: "effigy test unit -- test/proof.test.ts", exitCode: 0, evidence: "Selector passed at the published source" },
      proofFiles: [{ label: "Executor capture", path: sourcePath }],
    }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
    const [record] = f.task().proofFiles;
    assert.ok(record);
    assert.equal(record.runId, "executor-run", "the copy is bound to the proof execution run");
    assert.equal(record.sourcePath, sourcePath, "the original locator is retained as provenance");
    assert.equal(record.sha256, createHash("sha256").update(png("executor capture")).digest("hex"));
    assert.equal(record.bytes, png("executor capture").byteLength);
    assert.ok(record.path.startsWith(join(f.scratchRoot, "evidence", f.taskId, sourceHead)));
    assert.equal(f.task().proofExecutions.find(execution => execution.runId === "executor-run")?.status, "passed");

    rmSync(executorScratch, { recursive: true, force: true });
    assert.equal(existsSync(sourcePath), false, "the executor scratch was removed");
    assert.deepEqual(readFileSync(record.path), png("executor capture"), "the Nucleus copy survives executor scratch removal");
    const reviewerRun = { id: "review-run", taskId: f.taskId, role: "reviewer" as const, generation: 1, head: sourceHead, base,
      agentId: "reviewer", workspaceId: "workspace", profile: null, createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: false, status: "running" };
    const prompt = runPrompt(f.task(), reviewerRun as never, "/helper", "/ticket", true);
    assert.ok(prompt.includes(record.path));
    assert.ok(prompt.includes(record.sourcePath!));
    assert.ok(prompt.includes(record.sha256));
    assert.ok(prompt.includes(`${record.bytes} bytes`));
    assert.match(prompt, /Selector passed at the published source/);
  } finally { await f.close(); }
});

test("executor proof files outside its own scratch or over a file limit are refused without copying", async () => {
  const f = fixture();
  try {
    const remote = join(f.dir, "origin.git");
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    execFileSync("git", ["-C", f.worktree, "init", "--quiet", "-b", f.task().branch]);
    execFileSync("git", ["-C", f.worktree, "config", "user.email", "proof-files@example.com"]);
    execFileSync("git", ["-C", f.worktree, "config", "user.name", "Proof Files"]);
    execFileSync("git", ["-C", f.worktree, "remote", "add", "origin", remote]);
    writeFileSync(join(f.worktree, "source.txt"), "source\n");
    execFileSync("git", ["-C", f.worktree, "add", "source.txt"]);
    execFileSync("git", ["-C", f.worktree, "commit", "--quiet", "-m", "source"]);
    execFileSync("git", ["-C", f.worktree, "-c", "protocol.file.allow=always", "push", "--quiet", "origin", f.task().branch]);
    const sourceHead = execFileSync("git", ["-C", f.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", f.worktree, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const executorScratch = join(f.scratchRoot, "ef567890");
    mkdirSync(executorScratch);
    f.startExecutor(executorScratch, sourceHead, tree);
    const wrongScratchPath = join(f.scratch, "worker-file.png");
    writeFileSync(wrongScratchPath, png("wrong run"));
    await assert.rejects(f.complete("proof_executed", {
      head: sourceHead, proofResult: { status: "passed", selector: "effigy test unit -- test/proof.test.ts", exitCode: 0, evidence: "Ran" },
      proofFiles: [{ label: "Wrong run", path: wrongScratchPath }],
    }), /outside this task's own scratch and worktree/);
    assert.equal(f.task().proofFiles.length, 0);
    assert.equal(existsSync(join(f.scratchRoot, "evidence")), false);

    const oversizedPath = join(executorScratch, "oversized.png");
    writeFileSync(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(f.complete("proof_executed", {
      head: sourceHead, proofResult: { status: "passed", selector: "effigy test unit -- test/proof.test.ts", exitCode: 0, evidence: "Ran" },
      proofFiles: [{ label: "Oversized", path: oversizedPath }],
    }), /each proof file must be at most/);
    assert.equal(f.task().proofFiles.length, 0);
    assert.equal(existsSync(join(f.scratchRoot, "evidence")), false);
  } finally { await f.close(); }
});

test("an initial worker report accepts proofFiles", async () => {
  const f = fixture();
  try {
    const sourcePath = join(f.scratch, "initial-worker.png");
    writeFileSync(sourcePath, png("worker"));
    const prompt = workerPrompt(f.task(), true);
    assert.match(prompt, /Proof files for the retained reviewer/);
    const receipt = await f.reportOnce("initial-worker-proof", {
      head, proofFiles: [{ label: "Initial worker", path: sourcePath }],
    }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
    assert.equal(f.task().proofFiles.length, 1);
    assert.equal(f.task().proofFiles[0]!.sourcePath, sourcePath);
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

test("a null recorded prHead reads the task branch PR head from the forge", async () => {
  const openHead = "c".repeat(40);
  const f = fixture({ branchPrs: [{ number: 268, url: "https://github.com/example/repo/pull/268", head: openHead }] });
  try {
    assert.equal(f.task().prHead, null, "nothing recorded the PR head yet");
    writeFileSync(join(f.scratch, "proof.png"), png("proof"));
    const files = [{ label: "Proof", path: join(f.scratch, "proof.png") }];
    f.startRevision();
    // A different head refuses first (a refusal stores nothing, so the run stays
    // reportable), naming the reported and the observed forge head.
    await assert.rejects(f.reportOnce("proof-forge-head-wrong", {
      status: "blocked", prNumber: undefined, head: base, proofFiles: files,
    }), (error: unknown) => {
      assert.match(String((error as Error).message), /reported head for proofFiles must match the pushed PR head/);
      assert.ok(String((error as Error).message).includes(base), "the refusal names the reported head");
      assert.ok(String((error as Error).message).includes(openHead), "the refusal names the observed forge head");
      return true;
    });
    assert.equal(f.task().proofFiles.length, 0, "a refused report copies nothing");
    // The oxide#309 shape: a blocked revision report carries proof files at the
    // open PR head but no PR number, while Nucleus recorded no PR head.
    const receipt = await f.reportOnce("proof-forge-head-1", {
      status: "blocked", prNumber: undefined, head: openHead, proofFiles: files,
    }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
    const recorded = f.task().proofFiles;
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.head, openHead, "the files are recorded under the forge head");
    assert.equal(f.task().prHead, null, "the check observes the forge head without relabelling the task");
  } finally { await f.close(); }
});

test("a pre-PR report keeps its proof files against the pushed branch head", async () => {
  const f = fixture();
  try {
    // No PR on the forge: findOpenBranchPr stays empty, so the check falls back
    // to the pushed branch head read with `git ls-remote` from a real origin.
    const branch = f.task().branch;
    const remote = join(f.dir, "origin.git");
    execFileSync("git", ["init", "--bare", "--quiet", remote]);
    execFileSync("git", ["-C", f.worktree, "init", "--quiet", "-b", branch]);
    execFileSync("git", ["-C", f.worktree, "config", "user.email", "proof-files@example.com"]);
    execFileSync("git", ["-C", f.worktree, "config", "user.name", "Proof Files"]);
    execFileSync("git", ["-C", f.worktree, "remote", "add", "origin", remote]);
    writeFileSync(join(f.worktree, "source.txt"), "source\n");
    execFileSync("git", ["-C", f.worktree, "add", "source.txt"]);
    execFileSync("git", ["-C", f.worktree, "commit", "--quiet", "-m", "source"]);
    execFileSync("git", ["-C", f.worktree, "-c", "protocol.file.allow=always", "push", "--quiet", "origin", branch]);
    const pushed = execFileSync("git", ["-C", f.worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.match(pushed, /^[a-f0-9]{40}$/);
    writeFileSync(join(f.scratch, "proof.png"), png("proof"));
    const files = [{ label: "Proof", path: join(f.scratch, "proof.png") }];
    // An unpushed head refuses first (a refusal stores nothing) against the
    // observed pushed branch head.
    await assert.rejects(f.complete("blocked", {
      prNumber: undefined, head: base, proofFiles: files,
    }), /reported head for proofFiles must match the pushed branch head/);
    assert.equal(f.task().proofFiles.length, 0, "a refused report copies nothing");
    const receipt = await f.complete("blocked", { prNumber: undefined, head: pushed, proofFiles: files }) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);
    const recorded = f.task().proofFiles;
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.head, pushed, "the files are recorded under the pushed branch head");
    assert.ok(recorded[0]!.path.startsWith(join(f.scratchRoot, "evidence", f.taskId, pushed)));
  } finally { await f.close(); }
});

test("a failed open-PR lookup refuses proof files instead of falling back to the branch head", async () => {
  const f = fixture();
  try {
    // Review 5891487030: an unreadable forge is unverified, never proof that no
    // PR exists, so the branch-head fallback must not run.
    f.adapter.findOpenBranchPr = async () => { throw new Error("forge unreachable"); };
    writeFileSync(join(f.scratch, "proof.png"), png("proof"));
    await assert.rejects(f.complete("blocked", {
      prNumber: undefined, head, proofFiles: [{ label: "Proof", path: join(f.scratch, "proof.png") }],
    }), /cannot verify the task branch PR head/);
    assert.equal(f.task().proofFiles.length, 0, "a refused report copies nothing");
    assert.equal(f.task().completion, null, "the refused report records no completion");
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
    assert.match(prompt, /never relabel earlier-head evidence as delivered for the current head/);
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
