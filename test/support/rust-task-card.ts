import type { RustTask } from "../../client/web/rust-board";

export const rustTaskCard = (
  id: string,
  phase: RustTask["phase"],
  reference: string = id,
  repository = "https://github.com/example/board-fixture",
): RustTask => ({
  identity: { id, repository, reference, base: "main" },
  lifecycle: {
    steps: [
      { key: "queued", label: "Queued", state: phase === "queued" ? "current" : "done", tone: "accent", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: null },
      { key: "working", label: "Working", state: phase === "working" ? "current" : "todo", tone: "accent", elapsedMs: phase === "working" ? 831_000 : null, activeSinceMs: null, note: null, roundLabel: null },
      { key: "review", label: "Review", state: "todo", tone: "muted", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: "Round 2" },
      { key: "merge", label: "Merge", state: "todo", tone: "muted", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: null },
      { key: "close", label: "Close", state: "todo", tone: "muted", elapsedMs: null, activeSinceMs: null, note: null, roundLabel: null },
    ],
    admittedAtMs: 1_790_000_000_000,
    finishedAtMs: null,
    reviewRound: 2,
    worker: { thread: "fixture-worker", provider: "codex", model: "fixture-worker-model" },
    reviewer: { thread: "fixture-reviewer", provider: "claude", model: "fixture-review-model" },
  },
  phase,
  version: 7,
  wait: null,
  attention: "waiting",
  nextCheckAt: null,
  question: null,
  hold: null,
  stateLabel: phase[0]!.toUpperCase() + phase.slice(1),
  stateSinceMs: null,
});
