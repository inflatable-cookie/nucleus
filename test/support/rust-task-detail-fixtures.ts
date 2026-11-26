/** Engine-shaped Rust task detail, next view and history for the task view (Spec 071). */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const now = Date.now();
export const head = "9c41e07a2d5b8f13c6e09d4a7b2f5e8c1d3a6b90";
export const pushed = "c04d2e9f1b77a3d0e5c2a8b4f6e1d9c03a7b5e21";
export const mergeCommit = "4be2a91c07d3e5f8a1b6c9d2e4f7a0b3c5d8e1f2";
const repository = "https://github.com/example/board-fixture";
export const prUrl = `${repository}/pull/233`;

export type Json = Record<string, unknown>;
export type Step = {
  key: string;
  state: "todo" | "current" | "done";
  tone?: string;
  elapsedMs?: number | null;
  activeSinceMs?: number | null;
  visits?: Array<{ enteredAtMs: number | null; leftAtMs: number | null }>;
  note?: string | null;
};

const labels: Record<string, string> = {
  queued: "Queued", working: "Working", review: "Review", merge: "Merge", close: "Close",
};

export function steps(...defs: Step[]) {
  return defs.map((step) => {
    const visits = step.visits ?? [];
    const last = visits.at(-1);
    return {
      key: step.key,
      label: labels[step.key],
      state: step.state,
      tone: step.tone ?? (step.state === "done" ? "success" : step.state === "todo" ? "muted" : "accent"),
      note: step.note ?? null,
      roundLabel: null,
      elapsedMs: step.elapsedMs ?? null,
      activeSinceMs: step.activeSinceMs ?? null,
      enteredAtMs: last?.enteredAtMs ?? null,
      leftAtMs: last?.leftAtMs ?? null,
      visits,
    };
  });
}

export function card(role: "worker" | "reviewer", round: number, fields: Json) {
  return {
    instance: `task-fixture-run-${role}-${round}`,
    role,
    round,
    purpose: role === "worker" ? "Move lesson exports" : `Checking round ${round}`,
    threadUrl: `t3-thread://v1/${role}-thread`,
    provider: role === "worker" ? "codex" : "claude",
    providerInstance: role === "worker" ? "codex-fixture" : "claude-fixture",
    model: role === "worker" ? "fixture-worker-model" : "fixture-review-model",
    modelObserved: true,
    startedAtMs: null,
    endedAtMs: null,
    elapsedMs: null,
    ended: true,
    outcome: null,
    activity: null,
    ...fields,
  };
}

export const review = (decision: "approve" | "changes", summary: string, findings: string[] = []) => ({
  kind: "review", decision, summary, finding_titles: findings, change_url: null,
});
export const work = (revision: boolean) => ({ kind: "work", url: prUrl, summary: null, revision });

export type Fixture = {
  phase: string;
  stateLabel: string;
  attention: "finished" | "attention" | "active" | "waiting";
  wait?: string | null;
  waitDetail?: string | null;
  stateSinceMs?: number | null;
  nextCheckAt?: number | null;
  question?: Json | null;
  hold?: Json | null;
  queuePriority?: "normal" | "promoted";
  steps: ReturnType<typeof steps>;
  cards?: Json[];
  reviewRound?: number | null;
  finishedAtMs?: number | null;
  pullRequest?: Json | null;
  verdict?: Json | null;
  run?: Json | null;
  allowance?: Json;
  dependencies?: Json[];
  commands: Json[];
  history?: Json[];
};

export function engineTask(id: string, fixture: Fixture) {
  const transcript = {
    cards: fixture.cards ?? [],
    completedReviews: (fixture.cards ?? []).filter((c) => c.role === "reviewer" && c.outcome).length,
    merged: fixture.phase === "done",
    question: fixture.question ?? null,
    questionUrl: null,
    questionOwner: null,
    externalAcceptances: [],
  };
  const dependencyStatus = {
    dependencies: fixture.dependencies ?? [],
    prerequisiteWait: null,
    blocking: (fixture.dependencies ?? []).some((d) => d.status !== "satisfied"),
  };
  const current = {
    version: 7,
    phase: fixture.phase,
    queuePriority: fixture.queuePriority ?? "normal",
    stateLabel: fixture.stateLabel,
    stateSinceMs: fixture.stateSinceMs ?? null,
    wait: fixture.wait ?? null,
    waitDetail: fixture.waitDetail ?? null,
    attention: fixture.attention,
    nextCheckAt: fixture.nextCheckAt ?? null,
    question: fixture.question ?? null,
  };
  const allowance = fixture.allowance ?? { usedMs: 51 * MINUTE, limitMs: 3 * HOUR, exhausted: false };
  const detail = {
    identity: { id, reference: `board-fixture#${id.length}`, repository, base: "main", entry: "brief" },
    title: `Fixture task ${id}`,
    number: 233,
    reference: "board-fixture#233",
    latestEventAtMs: now - MINUTE,
    lifecycle: {
      steps: fixture.steps,
      admittedAtMs: now - 18 * HOUR,
      finishedAtMs: fixture.finishedAtMs ?? null,
      reviewRound: fixture.reviewRound ?? null,
      worker: { thread: "worker-thread", provider: "codex", model: "fixture-worker-model" },
      reviewer: fixture.cards?.some((c) => c.role === "reviewer")
        ? { thread: "review-thread", provider: "claude", model: "fixture-review-model" }
        : null,
      transcript,
    },
    hold: fixture.hold ?? null,
    ...current,
    dependencyStatus,
    dependencyEdits: { setDependencies: fixture.phase === "queued", setPrerequisiteWait: false },
    createdAtMs: now - 18 * HOUR,
    brief: { text: "# Fixture brief\n\nMove lesson exports.", version: 3, digest: Array(32).fill(1) },
    operatorInbox: true,
    pullRequest: fixture.pullRequest ?? null,
    verdict: fixture.verdict ?? null,
    allowance,
    run: fixture.run ?? null,
  };
  const next = { ...current, allowance, dependencyStatus, dependencyEdits: detail.dependencyEdits, commands: fixture.commands };
  return { detail, next, history: fixture.history ?? [] };
}

