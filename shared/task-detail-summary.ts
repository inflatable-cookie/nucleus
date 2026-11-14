import type { Run, Task, TaskNext, TaskNextVerb } from "./contracts";
import type { TaskBudgetView } from "./task-budget";
import { waitStateLabels, type WaitStateView } from "./wait-state";

/**
 * Task 538 (papercut 90104e7f): the task detail reads in ten seconds. The
 * summary at the top of the dialog is one derivation of the task's own recorded
 * facts — where it is, the holds on it, its progress, and the newest report's
 * headline — so the client renders prose instead of deciding meaning, and the
 * derivation is testable without a rendered surface. Observation only: nothing
 * here grants a verb, a hold release, a review or merge authority.
 */

/** The headline a reader sees: about one line on a card and in the dialog. */
export const REPORT_HEADLINE_MAX = 200;
/** The words a progressing responsible task reads with: no stop and no wait. */
export const TASK_PROGRESSING_REASON = "No stop or wait; the task is progressing.";

/** What a report may carry; longer text is clipped for display, not refused on read. */
export const REPORT_HEADLINE_STORED_MAX = 240;
/** The summary keeps the two or three verbs that fit this state, and no more. */
export const PRIMARY_ACTION_LIMIT = 3;

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The first sentence of a longer report, collapsed to one line and bounded. */
export function firstSentence(text: string | null | undefined, max = REPORT_HEADLINE_MAX): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const end = flat.search(/[.!?](?=\s|$)/);
  return clipText(end > 0 ? flat.slice(0, end + 1) : flat, max);
}

/**
 * The headline a report shows. A report written before the field existed falls
 * back to the first sentence of its summary, so old runs stay readable.
 */
export function reportHeadline(completion: { headline?: string | null; summary?: string | null } | null | undefined): string {
  const own = (completion?.headline ?? "").replace(/\s+/g, " ").trim();
  return own ? clipText(own, REPORT_HEADLINE_MAX) : firstSentence(completion?.summary);
}

/**
 * Which available verbs lead, by how directly they answer the current stop:
 * clearing a hold, then moving the work or recording a disposition, then the
 * resumptions, then the parked-task controls. Registry order breaks ties.
 */
const ACTION_RANK: Record<string, number> = {
  release: 0, keep_hold: 1, move: 2, complete: 2, proof: 3, restart: 4, route: 5, retry_effect: 6, stop: 7,
};

export type TaskActionPlan = { primary: TaskNextVerb[]; more: TaskNextVerb[] };

/**
 * The two or three verbs that fit this state, and everything else that is
 * available behind "More". A refused verb is not an action: it never leads and
 * never sits in More; its refusal stays readable in the technical reference.
 */
export function taskActionPlan(verbs: readonly TaskNextVerb[] | null | undefined, limit = PRIMARY_ACTION_LIMIT): TaskActionPlan {
  const capped = Math.max(1, limit);
  const ranked = (verbs ?? [])
    .map((verb, index) => ({ verb, index }))
    .filter(entry => entry.verb.available)
    .sort((a, b) => (ACTION_RANK[a.verb.verb] ?? 8) - (ACTION_RANK[b.verb.verb] ?? 8) || a.index - b.index)
    .map(entry => entry.verb);
  return { primary: ranked.slice(0, capped), more: ranked.slice(capped) };
}

const STOP_STATE: Record<NonNullable<TaskNext["stop"]>["kind"], string> = {
  hold: "Held", incident: "Stopped by an incident", recovery: "In coordinator recovery",
  attention: "Waiting on the operator", run: "Run stopped", wait: "Waiting",
};

/** Queue owns the waits it records; the board names that owner Nucleus. */
export const waitOwnerLabel = (owner: string) => owner === "Queue" ? "Nucleus" : owner === "Queue QA scheduler" ? "Nucleus QA scheduler" : owner;

/** Board wording for a linked operator wait; raw decision IDs stay in task detail. */
export function taskWaitCardLabel(waitState: WaitStateView | null | undefined, decisionTitle?: string | null): string | null {
  if (waitState?.state !== "needs_operator_input") return null;
  return `Waiting on you · ${decisionTitle?.trim() || "operator decision"}`;
}

export type VerbRefusal = { verb: string; reason: string };

/**
 * The owner verbs the current stop suggests that do not apply now, each with its
 * refusal. A suggested verb with an available form is an action, not a refusal,
 * and a verb the task never names is not listed.
 */
export function suggestedVerbRefusals(next: TaskNext | null | undefined): VerbRefusal[] {
  if (!next?.stop) return [];
  return next.stop.suggestedVerbs.flatMap(name => {
    const forms = next.verbs.filter(verb => verb.verb === name);
    if (!forms.length || forms.some(verb => verb.available)) return [];
    return [{ verb: name, reason: forms.find(verb => verb.refusal)?.refusal ?? "no reason recorded" }];
  });
}

export type OverviewWait = {
  /** What the task waits on, in one sentence. */
  state: string;
  /** Who acts on it, in the board's owner words; empty when no one is named. */
  owner: string;
  /** The next action the wait names in words; empty when the owner verbs are the next step. */
  nextAction: string;
  /** Why: the live stop's detail, else the wait's reason; empty when neither is recorded. */
  detail: string;
  /** Who is working on the task now, when a run holds it: the role and profile, read from the run. */
  actor: string;
  /** The live stop, when there is one, with its raw detail for the accessible line. */
  stop: { kind: NonNullable<TaskNext["stop"]>["kind"]; reason: string; detail: string; since: string } | null;
};

/**
 * The Overview's wait: the one current wait or stop, who owns it and what comes
 * next. A recorded wait state wins over the stop, because it is the state the
 * board card shows; the stop supplies its age and the owner verbs it suggests.
 * Read from the task's own records, so a superseded reason cannot linger. With
 * no `task.next` yet, the wait state and the caller's own reason stand in.
 */
export function taskOverviewWait(waitState: WaitStateView | null | undefined, next: TaskNext | null | undefined, fallbackReason = ""): OverviewWait {
  const stop = next?.stop ?? null;
  const actor = next?.activeRun
    ? `${next.activeRun.role === "worker" ? "Worker" : `${next.activeRun.role.charAt(0).toUpperCase()}${next.activeRun.role.slice(1)}`} ${next.activeRun.profileName ?? next.activeRun.agentId ?? "agent"} is working.`
    : "";
  const stopRow = stop ? { kind: stop.kind, reason: stop.reason, detail: stop.detail, since: stop.since } : null;
  const stopDetail = stop ? clipText((stop.detail || stop.reason).replace(/\s+/g, " ").trim(), 400) : "";
  if (waitState) return {
    state: waitStateLabels[waitState.state],
    owner: waitOwnerLabel(waitState.owner),
    nextAction: waitState.nextAction,
    detail: stopDetail || clipText((waitState.reason ?? "").replace(/\s+/g, " ").trim(), 400),
    actor,
    stop: stopRow,
  };
  if (stop) {
    const suggested: readonly string[] = stop.suggestedVerbs;
    const suggestsAction = next?.verbs.some(verb => verb.available && suggested.includes(verb.verb)) ?? false;
    return {
      state: STOP_STATE[stop.kind],
      owner: stop.owner ? waitOwnerLabel(stop.owner) : "",
      nextAction: suggestsAction ? "Choose an owner verb below." : "",
      detail: stopDetail,
      actor,
      stop: stopRow,
    };
  }
  if (next) return { state: TASK_PROGRESSING_REASON, owner: "", nextAction: "", detail: "", actor, stop: null };
  return { state: firstSentence(fallbackReason, 400) || "Reading the task's current state…", owner: "", nextAction: "", detail: "", actor, stop: null };
}

/**
 * Spec 052/058 budget on the summary only when it is spent or near a limit. The
 * figures stay in Technical; a budget far from its limit is not what the reader needs.
 */
export const BUDGET_ATTENTION_RATIO = 0.8;
export function budgetNeedsAttention(budget: TaskBudgetView | null | undefined): boolean {
  if (!budget) return false;
  return Boolean(budget.exhausted) || budgetBars(budget).some(bar => bar.ratio >= BUDGET_ATTENTION_RATIO);
}

export type HoldRow = { kind: "dispatch" | "merge"; holder: string; reason: string; since: string | null };

/** One row per hold that is in force now: holder, reason and age source. */
export function taskHoldRows(next: TaskNext | null | undefined): HoldRow[] {
  const holds = next?.holds;
  return (["dispatch", "merge"] as const).flatMap(kind => {
    const hold = holds?.[kind];
    return hold ? [{ kind, holder: hold.owner, reason: hold.reason, since: hold.since || null }] : [];
  });
}

export type TaskProgress = { round: string; verdict: string };

/** Review round against its allowance, and the latest verdict with the head it covers. */
export function taskReviewProgress(outcome: TaskNext["outcome"] | null | undefined): TaskProgress {
  if (!outcome) return { round: "", verdict: "" };
  const { runs, budget, exhausted } = outcome.revision;
  // A task that has not reached review yet shows no round: progress starts with the first review.
  const started = runs > 0 || Boolean(outcome.accepted || outcome.reported || outcome.reader || outcome.impediment || outcome.authorResult);
  const round = !started ? "" : exhausted ? `Review rounds spent (${budget} of ${budget})` : `Review round ${Math.min(runs + 1, budget)} of ${budget}`;
  const head = (value: string | null) => value ? value.slice(0, 7) : "an unknown head";
  const verdict = outcome.accepted
    ? `${outcome.accepted.status === "ready_to_merge" ? "Approved" : "Changes requested"} at ${head(outcome.accepted.head)}${outcome.accepted.currentHead ? "" : " (an older head)"}${outcome.accepted.superseded ? " · superseded" : ""}`
    : outcome.reader
      ? `Review in progress at ${head(outcome.reader.head)}`
      : outcome.impediment
        ? `Review did not finish: ${outcome.impediment.status}`
        : outcome.authorResult
          ? `Author reported ${outcome.authorResult.status.replaceAll("_", " ")}`
          : "";
  return { round, verdict };
}

export type BudgetBar = {
  key: "tokens" | "time"; label: string; used: number; limit: number;
  /** 0..1, clamped; a bar never overflows its track. */
  ratio: number; text: string;
};

/** 950, 12.4k, 1.2M — a figure a reader can compare at a glance. */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const fixed = (scaled: number, digits: number) => scaled.toFixed(digits).replace(/\.0$/, "");
  if (value >= 1_000_000) return `${fixed(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${fixed(value / 1_000, value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/** 45m, 2h 14m, 1d 3h — elapsed time at a human scale. */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

/** Spec 058's budget as two bars; the figures are the ones the card already shows. */
export function budgetBars(budget: TaskBudgetView | null | undefined): BudgetBar[] {
  if (!budget) return [];
  const ratio = (used: number, limit: number) => limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const tokens = budget.effectiveTokens, wall = budget.wallMs;
  return [
    {
      key: "tokens", label: "Tokens", used: tokens.used, limit: tokens.limit, ratio: ratio(tokens.used, tokens.limit),
      text: `${formatTokenCount(tokens.used)} / ${formatTokenCount(tokens.limit)}${tokens.evidence === "none" ? " · usage not reported" : tokens.evidence === "partial" ? " · at least" : ""}`,
    },
    { key: "time", label: "Time", used: wall.used, limit: wall.limit, ratio: ratio(wall.used, wall.limit),
      // nucleus#1153: time held on a Nucleus-side cause stays off both the budget and
      // this bar, and the paused figure says why the elapsed clock and the budget differ.
      text: `${formatSpan(wall.used)} / ${formatSpan(wall.limit)}${wall.pausedMs >= 60_000 ? ` · ${formatSpan(wall.pausedMs)} held on Nucleus faults` : ""}` },
  ];
}

/** How long the task has been running: from its first dispatch, so it matches the budget clock. */
export function taskElapsed(runs: readonly Pick<Run, "createdAt">[], now = Date.now()): number | null {
  const starts = runs.map(run => Date.parse(run.createdAt)).filter(Number.isFinite);
  return starts.length ? Math.max(0, now - Math.min(...starts)) : null;
}

export type CheckTick = { label: string; state: "pass" | "fail" | "pending" | "info" };

const QA_TICK: Record<string, CheckTick["state"]> = {
  queued: "pending", running: "pending", hold: "pending", passed: "pass",
  failed: "fail", timed_out: "fail", cancelled: "info", lost: "info",
};

/**
 * The latest check results Queue already holds as short ticks: the task's
 * project validation, its repository's milestone QA run, and the last accepted
 * review verdict. Nothing here is a new check or a merge permission.
 */
export function checkTicks(input: {
  validation?: { state: string; exitCode: number | null; capacityUnavailable?: boolean; capacityWait?: unknown } | null;
  milestoneQa?: { state: string } | null;
  verdict?: "ready_to_merge" | "changes_required" | null;
}): CheckTick[] {
  const ticks: CheckTick[] = [];
  const validation = input.validation;
  if (validation) ticks.push({
    label: "Validation",
    state: validation.capacityUnavailable || validation.capacityWait ? "pending"
      : validation.state === "passed" || validation.exitCode === 0 ? "pass"
      : validation.state === "running" || validation.exitCode === null ? "pending"
      : "fail",
  });
  if (input.milestoneQa) ticks.push({ label: "Milestone QA", state: QA_TICK[input.milestoneQa.state] ?? "info" });
  if (input.verdict) ticks.push({ label: "Review", state: input.verdict === "ready_to_merge" ? "pass" : "fail" });
  return ticks;
}

export type LatestReport = {
  /** The run's role, in the reader's words: worker, revision, reviewer, closeout, recovery. */
  role: string;
  /** The agent, model and profile that wrote it, when Queue recorded them. */
  author: string;
  /** When Queue last observed the run. */
  at: string | null;
  headline: string;
  /** The full report: findings text when it has one, else the summary. */
  fullText: string;
};

/**
 * The newest worker or reviewer report on the task: the latest completed run,
 * else the task row's own worker result. Older runs carry no headline, so the
 * summary's first sentence stands in.
 */
export function latestTaskReport(task: Pick<Task, "completion" | "profile" | "agentId">, runs: readonly Run[] = []): LatestReport | null {
  // The brief names the worker's and the reviewer's reports: a revision run is the
  // author's next turn, and the coordinator roles are episode machinery, not the
  // work's own latest line.
  const completed = runs
    .filter(run => run.completion && (run.role === "revision" || run.role === "reviewer"))
    .map(run => ({ run, at: Date.parse(run.lastObservedAt ?? run.createdAt) }))
    .filter(entry => Number.isFinite(entry.at))
    .sort((a, b) => b.at - a.at);
  const newest = completed[0];
  if (newest) {
    const run = newest.run, completion = run.completion!;
    return {
      role: run.role,
      author: [run.agentId, run.profile?.model, run.profile?.name].filter(Boolean).join(" · "),
      at: run.lastObservedAt ?? run.createdAt,
      headline: reportHeadline(completion),
      fullText: completion.reviewText?.trim() || completion.summary,
    };
  }
  if (!task.completion) return null;
  return {
    role: "worker",
    author: [task.agentId, task.profile?.model, task.profile?.name].filter(Boolean).join(" · "),
    at: null,
    headline: reportHeadline(task.completion),
    fullText: task.completion.reviewText?.trim() || task.completion.summary,
  };
}


