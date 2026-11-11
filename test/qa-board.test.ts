import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardQaRuns, boardQaRunView, createQaStalenessResolver, QA_BOARD_PASS_FADE_MS } from "../core/qa/qa-board";
import { Store } from "../core/store/store";
import { ProjectQaRunner } from "./project-qa-runner-fixture";
import { createUiSnapshotFactsCache } from "../core/telemetry/ui-snapshot";
import { boardQaRunSchema, projectQaDismissInputSchema, projectQaRunSchema, type ProjectQaRun } from "../shared/contracts";
import { pipelineBoard } from "../shared/pipeline-board";

/**
 * Milestone QA on the board (Tom, 2026-11-01): each active run is a card. Placement follows state,
 * a pass fades after the fade window, a failure stays until a passing re-run or a dismissal, and
 * dismissal records who dismissed which run without deleting it.
 */

const base = "a".repeat(40), digest = "b".repeat(64);
const minute = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

function qaRun(overrides: Record<string, unknown> = {}): ProjectQaRun {
  return projectQaRunSchema.parse({
    id: "run-1", repository: { origin: "owner/repo", path: "/checkout" }, key: "owner/repo", state: "passed",
    baseBranch: "main", base, argv: ["effigy", "qa"], digest, selector: "qa", exitCode: 0, durationMs: 1000,
    outputTail: "ok", startedAt: at(Date.now() - 2 * minute), finishedAt: at(Date.now() - minute), pid: null,
    submittedAt: at(Date.now() - 2 * minute), capacityWait: null, capacityUnavailable: false, ...overrides,
  });
}

function step(name: string, endedAt?: string) {
  return { name, command: "effigy qa", exitCode: endedAt ? 0 : null, signal: null, timedOut: false, stdoutHead: "", stdoutTail: "",
    stderrHead: "", stderrTail: "", ...(endedAt ? { endedAt } : {}) };
}

test("a queued run is a Queued card with its position; a running run is a Working card on its open step", () => {
  const now = Date.now();
  const queued = qaRun({ id: "queued", key: "owner/queued", state: "queued", queuePosition: 2, finishedAt: null, exitCode: null, startedAt: at(now - minute) });
  const running = qaRun({ id: "running", key: "owner/running", state: "running", finishedAt: null, exitCode: null,
    steps: [step("setup", at(now - 30_000)), step("qa")] });
  const cards = boardQaRuns([queued, running], now);
  assert.deepEqual(cards.map(card => [card.id, card.state]), [["queued", "queued"], ["running", "running"]]);
  assert.equal(cards[0].queuePosition, 2);
  assert.equal(cards[1].currentStep, "qa");
  assert.equal(pipelineBoard({ projects: [], lanes: [], selection: [],  leads: [], tasks: [], qaRuns: cards }).counts.Queued, 1);
  assert.equal(pipelineBoard({ projects: [], lanes: [], selection: [],  leads: [], tasks: [], qaRuns: cards }).counts.Working, 1);
});

test("a failed run is an Attention card with its failed step, exit code and last output lines", () => {
  const now = Date.now();
  const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const failed = qaRun({ id: "failed", state: "failed", exitCode: 1, failedStep: "qa", outputTail: output, finishedAt: at(now - 20 * minute) });
  const [card] = boardQaRuns([failed], now);
  assert.equal(card.failedStep, "qa");
  assert.equal(card.exitCode, 1);
  assert.deepEqual(card.outputLines, Array.from({ length: 8 }, (_, index) => `line ${index + 5}`));
  assert.equal(pipelineBoard({ projects: [], lanes: [], selection: [],  leads: [], tasks: [], qaRuns: [card] }).counts.Attention, 1);
});

test("failed QA cards show staleness only for an ancestor base, with cached Git comparisons", () => {
  const calls: string[][] = [];
  const resolver = createQaStalenessResolver({ runGit: (_repo, args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "c".repeat(40);
    if (args[0] === "merge-base" && args[2] === "d".repeat(40)) throw new Error("not an ancestor");
    if (args[0] === "rev-list") return "3";
    return "";
  }, now: () => 1_000 });
  const failed = qaRun({ state: "failed", exitCode: 1, startedAt: at(123), base: "a".repeat(40) });
  const stale = boardQaRuns([failed], Date.now(), resolver)[0];
  assert.deepEqual(stale.stale, { commitsSince: 3, runAt: at(123) });
  const callsAfterFirst = calls.length;
  assert.deepEqual(boardQaRuns([failed], Date.now(), resolver)[0].stale, stale.stale);
  assert.equal(calls.length, callsAfterFirst, "a rebuild reuses the cached branch head and comparison");

  const atHead = qaRun({ state: "failed", base: "c".repeat(40) });
  const unrelated = qaRun({ id: "unrelated", state: "timed_out", base: "d".repeat(40) });
  const passed = qaRun({ id: "passed", state: "passed", base: "a".repeat(40) });
  assert.equal(boardQaRuns([atHead, unrelated, passed], Date.now(), resolver).some(card => card.stale), false);
});

test("a passing run fades after the fade window and a failing run stays", () => {
  const now = Date.now();
  const fresh = qaRun({ id: "fresh-pass", finishedAt: at(now - minute) });
  const faded = qaRun({ id: "faded-pass", finishedAt: at(now - QA_BOARD_PASS_FADE_MS - minute) });
  const oldFail = qaRun({ id: "old-fail", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(now - 60 * minute) });
  assert.deepEqual(boardQaRuns([fresh, faded, oldFail], now).map(card => card.id), ["fresh-pass", "old-fail"]);
  assert.deepEqual(boardQaRuns([fresh], now + QA_BOARD_PASS_FADE_MS).map(card => card.id), [], "the pass leaves exactly at the window's end");
});

test("a passing re-run clears the failure it re-runs; a fresh re-run replaces the failure's card", () => {
  const now = Date.now();
  const failed = qaRun({ id: "first", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(now - 10 * minute) });
  const rerunning = qaRun({ id: "second", state: "running", finishedAt: null, exitCode: null });
  // The latest run per repository decides the card: the re-run's state replaces the failure.
  assert.deepEqual(boardQaRuns([rerunning], now).map(card => [card.id, card.state]), [["second", "running"]]);
  const passed = qaRun({ id: "second", finishedAt: at(now - minute) });
  assert.deepEqual(boardQaRuns([passed], now).map(card => [card.id, card.state]), [["second", "passed"]]);
  assert.deepEqual(boardQaRuns([failed], now).map(card => card.id), ["first"], "the failure stays until a later run replaces it");
});

test("a dismissed run leaves the board and its record keeps who dismissed it", () => {
  const now = Date.now();
  const dismissed = qaRun({ id: "dismissed", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(now - minute),
    dismissal: { at: at(now), by: "operator (board)", reason: "known flake" } });
  assert.deepEqual(boardQaRuns([dismissed], now), []);
  assert.equal(projectQaRunSchema.parse(dismissed).dismissal?.by, "operator (board)");
});

test("the card schema carries only the card fields and the dismissal input requires a reason and caller", () => {
  const card = boardQaRunView(qaRun({ state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(Date.now() - minute) }));
  assert.equal(boardQaRunSchema.safeParse(card).success, true);
  assert.equal(boardQaRunSchema.safeParse({ ...card, steps: [] }).success, false, "steps and output stay in the detail, not on the card");
  assert.equal(projectQaDismissInputSchema.safeParse({ id: "run-1", reason: "flake", caller: "operator (board)" }).success, true);
  assert.equal(projectQaDismissInputSchema.safeParse({ id: "run-1", reason: " ", caller: "operator (board)" }).success, false);
  assert.equal(projectQaDismissInputSchema.safeParse({ id: "run-1", reason: "flake" }).success, false);
});

test("the store's board read keeps the latest run per repository, minus dismissed runs and faded passes", async t => {
  const dir = await mkdtemp(join(tmpdir(), "qa-board-store-"));
  const store = new Store(join(dir, "queue.sqlite"));
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });
  const now = Date.now();
  store.putQaRun(qaRun({ id: "old-pass", key: "owner/a", finishedAt: at(now - 60 * minute) }));
  store.putQaRun(qaRun({ id: "failed", key: "owner/b", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(now - 90 * minute) }));
  store.putQaRun(qaRun({ id: "dismissed", key: "owner/c", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(now - minute),
    dismissal: { at: at(now), by: "operator (board)", reason: "flake" } }));
  store.putQaRun(qaRun({ id: "fresh-pass", key: "owner/d", finishedAt: at(now - minute) }));
  const ids = store.qaBoardRuns(at(now - QA_BOARD_PASS_FADE_MS)).map(run => run.id).sort();
  assert.deepEqual(ids, ["failed", "fresh-pass"]);
  assert.deepEqual(boardQaRuns(store.qaBoardRuns(at(now - QA_BOARD_PASS_FADE_MS)), now).map(card => card.id).sort(), ["failed", "fresh-pass"]);
});

test("a board operator dismisses a finished failure once, recorded; a live or passing run is refused", async t => {
  const root = await mkdtemp(join(tmpdir(), "qa-board-dismiss-"));
  const store = new Store(join(root, "queue.sqlite"));
  const runner = new ProjectQaRunner(store, { dataDir: root, hostRunStateDir: join(root, "host") });
  t.after(() => { runner.hostRuns.stop(); store.close(); return rm(root, { recursive: true, force: true }); });
  store.putQaRun(qaRun({ id: "failed", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(Date.now() - minute) }));
  store.putQaRun(qaRun({ id: "running", key: "owner/live", state: "running", finishedAt: null, exitCode: null }));
  store.putQaRun(qaRun({ id: "passed", key: "owner/pass" }));
  const dismissed = runner.dismiss({ id: "failed", reason: "known flake", caller: "operator (board)" });
  assert.deepEqual(dismissed.dismissal && { by: dismissed.dismissal.by, reason: dismissed.dismissal.reason }, { by: "operator (board)", reason: "known flake" });
  assert.equal(store.qaRun("failed")?.state, "failed", "the record is never deleted");
  assert.equal(runner.dismiss({ id: "failed", reason: "again", caller: "someone else" }).dismissal?.by, "operator (board)", "a second dismissal keeps the first");
  assert.throws(() => runner.dismiss({ id: "running", reason: "no", caller: "operator (board)" }), /cancelled, not dismissed/);
  assert.throws(() => runner.dismiss({ id: "passed", reason: "no", caller: "operator (board)" }), /leaves the board on its own/);
  assert.throws(() => runner.dismiss({ id: "missing", reason: "no", caller: "operator (board)" }), /not found/);
});

test("the UI snapshot projects QA cards and no longer carries a heavy-work strip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-board-snapshot-"));
  const store = new Store(join(dir, "queue.sqlite"));
  try {
    const now = Date.now();
    store.putQaRun(qaRun({ id: "failed", state: "failed", exitCode: 1, failedStep: "qa", finishedAt: at(now - minute) }));
    // A passing run finishes just inside the window; the read after the window closes must drop it without any write.
    store.putQaRun(qaRun({ id: "pass", key: "owner/pass", finishedAt: at(now - QA_BOARD_PASS_FADE_MS + 200) }));
    const read = createUiSnapshotFactsCache(store, undefined, () => [], nowMs => store.qaBoardRuns(at(nowMs - QA_BOARD_PASS_FADE_MS)));
    const first = read();
    assert.deepEqual(first.qaRuns.map(card => card.id).sort(), ["failed", "pass"]);
    assert.equal("heavyRuns" in first, false);
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = read();
    assert.deepEqual(second.qaRuns.map(card => card.id), ["failed"]);
    assert.ok(second.revision > first.revision, "the fade advances the board revision with no durable write");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
