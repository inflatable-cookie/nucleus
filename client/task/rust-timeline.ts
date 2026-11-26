/**
 * The task timeline (Spec 071, "Timeline bar"), derived from the engine's lifecycle:
 * equal steps, one segment per round on Working and Review, durations as values and
 * clock times only in tooltips. Times the engine did not record stay unknown.
 */
import { formatSpan } from "../../shared/task-detail-summary";
import type {
  RustLifecycle,
  RustTranscriptCard,
  RustTranscriptOutcome,
} from "../web/rust-board";

export type TimelineTone = "accent" | "danger" | "warning" | "success" | "muted";
/** `lit` is a step that is not current but has finished rounds (Review after changes). */
export type TimelineState = "todo" | "current" | "done" | "lit";

export type TimelineSegment = {
  /** `track` is a step not started; `wait` drifts while the current step waits. */
  fill: "track" | "solid" | "wait";
  tone: TimelineTone;
  label: string;
  hint: string;
};

export type TimelineStep = {
  key: RustLifecycle["steps"][number]["key"];
  label: string;
  state: TimelineState;
  tone: TimelineTone;
  segments: TimelineSegment[];
  /** Null when the step has not started or its time was not recorded. */
  value: string | null;
  /** The part of the value that ticks, coloured as the wait. */
  waiting: string | null;
  hint: string;
  live: boolean;
};

export type TimelineContext = {
  attention: "finished" | "attention" | "active" | "waiting";
  stateSinceMs: number | null;
  now: number;
};

type Round = {
  round: number;
  cards: RustTranscriptCard[];
  elapsedMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  ended: boolean;
  outcome: RustTranscriptOutcome | null;
  model: string | null;
  provider: string | null;
};

/** Seconds while under an hour, so a live value visibly ticks. */
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return formatSpan(ms);
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** A clock time today, or the date and time on another day. */
export function clockTime(atMs: number, now = Date.now()): string {
  const at = new Date(atMs);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay(at, new Date(now))) return time;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

export function roundsFor(
  cards: readonly RustTranscriptCard[],
  role: "worker" | "reviewer",
): Round[] {
  const rounds: Round[] = [];
  for (const card of cards) {
    if (card.role !== role) continue;
    const number = card.round ?? rounds.length + 1;
    let round = rounds.find((candidate) => candidate.round === number);
    if (!round) {
      round = {
        round: number,
        cards: [],
        elapsedMs: null,
        startedAtMs: null,
        endedAtMs: null,
        ended: true,
        outcome: null,
        model: null,
        provider: null,
      };
      rounds.push(round);
    }
    round.cards.push(card);
    if (card.elapsedMs !== null)
      round.elapsedMs = (round.elapsedMs ?? 0) + card.elapsedMs;
    if (card.startedAtMs !== null && round.startedAtMs === null)
      round.startedAtMs = card.startedAtMs;
    round.endedAtMs = card.endedAtMs ?? round.endedAtMs;
    round.ended = card.ended;
    round.outcome = card.outcome ?? round.outcome;
    round.model = card.model ?? round.model;
    round.provider = card.provider ?? round.provider;
  }
  return rounds.sort((a, b) => a.round - b.round);
}

function outcomeWords(outcome: RustTranscriptOutcome | null): string | null {
  switch (outcome?.kind) {
    case "review":
      return outcome.decision === "approve" ? "approved" : "changes requested";
    case "work":
      return outcome.revision ? "revision pushed" : "work submitted";
    case "question":
      return "asked a question";
    case "provider_limit":
      return "provider limit";
    case "blocked":
      return "could not finish";
    case "report":
      return "report delivered";
    default:
      return null;
  }
}

/** A round that stopped for someone else (a question, a limit, a failure) resumes in place. */
const paused = (outcome: RustTranscriptOutcome | null) =>
  outcome?.kind === "question" ||
  outcome?.kind === "provider_limit" ||
  outcome?.kind === "blocked";

function span(start: number | null, end: number | null, now: number): string | null {
  if (start === null) return end === null ? null : `Until ${clockTime(end, now)}`;
  return end === null
    ? `Since ${clockTime(start, now)}`
    : `${clockTime(start, now)} → ${clockTime(end, now)}`;
}

/** Known time across a step's visits; null when any finished visit was not recorded. */
function visitTime(
  step: RustLifecycle["steps"][number],
  now: number,
): { ms: number | null; live: boolean } {
  const visits = step.visits ?? [];
  if (visits.length === 0) return { ms: null, live: false };
  let total = 0;
  let live = false;
  for (const visit of visits) {
    if (visit.enteredAtMs === null) return { ms: null, live: false };
    if (visit.leftAtMs !== null) total += Math.max(0, visit.leftAtMs - visit.enteredAtMs);
    else if (step.state === "current") {
      total += Math.max(0, now - visit.enteredAtMs);
      live = true;
    } else return { ms: null, live: false };
  }
  return { ms: total, live };
}

export function rustTimeline(
  lifecycle: RustLifecycle,
  context: TimelineContext,
): TimelineStep[] {
  const { now } = context;
  const cards = lifecycle.transcript?.cards ?? [];
  return lifecycle.steps.map((step) => {
    const role =
      step.key === "working" ? "worker" : step.key === "review" ? "reviewer" : null;
    const rounds = role ? roundsFor(cards, role) : [];
    const current = step.state === "current";
    const blocked = current && step.tone === "danger";
    const waiting =
      current &&
      !blocked &&
      (context.attention === "waiting" || context.attention === "attention");
    const state: TimelineState =
      step.state === "todo" && rounds.length > 0 ? "lit" : step.state;
    const tone: TimelineTone = current
      ? step.tone
      : state === "lit"
        ? rounds.some((round) => round.outcome?.kind === "review" && round.outcome.decision === "changes")
          ? "warning"
          : "success"
        : step.state === "done"
          ? "success"
          : "muted";
    const currentFill = waiting ? "wait" : "solid";
    const roundTone = (round: Round): TimelineTone =>
      round.outcome?.kind === "review" && round.outcome.decision === "changes"
        ? "warning"
        : "success";

    const segments: TimelineSegment[] = [];
    let liveRound: { round: number; ms: number } | null = null;
    for (const [index, round] of rounds.entries()) {
      const last = index === rounds.length - 1;
      const running = current && last && (!round.ended || paused(round.outcome));
      const runningSince =
        running && !round.ended ? (step.activeSinceMs ?? round.startedAtMs) : null;
      const elapsed =
        (round.elapsedMs ?? 0) + (runningSince === null ? 0 : Math.max(0, now - runningSince));
      if (running && runningSince !== null) liveRound = { round: round.round, ms: elapsed };
      const known = round.elapsedMs !== null || runningSince !== null;
      const words = running && !round.ended ? "in progress" : outcomeWords(round.outcome);
      const label = [`${step.label} round ${round.round}`, words].filter(Boolean).join(" · ");
      segments.push({
        fill: running ? currentFill : "solid",
        tone: running ? step.tone : roundTone(round),
        label,
        hint: [
          [`Round ${round.round}`, words].filter(Boolean).join(" · "),
          [round.model, known ? duration(elapsed) : null].filter(Boolean).join(" · "),
          span(round.startedAtMs, round.endedAtMs, now),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    const lastRound = rounds.at(-1);
    if (
      current &&
      (!lastRound || (lastRound.ended && !paused(lastRound.outcome)))
    ) {
      // The next round, before its run starts.
      const round = (lastRound?.round ?? 0) + 1;
      segments.push({
        fill: currentFill,
        tone: step.tone,
        label: role ? `${step.label} round ${round} · in progress` : `${step.label} · in progress`,
        hint: role ? `Round ${round}` : (step.note ?? step.label),
      });
    }
    if (segments.length === 0) {
      segments.push({
        fill: step.state === "done" ? "solid" : "track",
        tone: step.state === "done" ? "success" : "muted",
        label: `${step.label} · ${step.state === "done" ? "complete" : "not started"}`,
        hint: step.state === "done" ? "Complete" : "Not started",
      });
    }

    // Values: every one a duration. Role steps sum their rounds; the rest sum visits.
    let ms: number | null = null;
    let live = false;
    if (role && rounds.length > 0) {
      const known = rounds.filter((round) => round.elapsedMs !== null);
      ms = known.length ? known.reduce((sum, round) => sum + (round.elapsedMs ?? 0), 0) : null;
      if (liveRound) {
        const before = rounds.at(-1)?.elapsedMs ?? 0;
        ms = (ms ?? 0) + (liveRound.ms - before);
        live = true;
      }
    } else if (role && (step.elapsedMs !== null || step.activeSinceMs !== null)) {
      ms =
        (step.elapsedMs ?? 0) +
        (step.activeSinceMs === null ? 0 : Math.max(0, now - step.activeSinceMs));
      live = step.activeSinceMs !== null && current;
    } else if (!role) {
      ({ ms, live } = visitTime(step, now));
    }
    // Without a transcript (the board list), the engine's own round label still counts.
    const labelled = Number(step.roundLabel?.match(/\d+/)?.[0] ?? 0);
    const lastNumber = lastRound?.round ?? labelled;
    const roundPrefix = role && lastNumber >= 2 ? `Round ${lastNumber}` : null;
    const shown =
      liveRound && roundPrefix
        ? duration(liveRound.ms)
        : ms === null
          ? null
          : live
            ? duration(ms)
            : formatSpan(ms);
    const since =
      current && context.stateSinceMs !== null
        ? duration(now - context.stateSinceMs)
        : null;
    let waitingText: string | null = null;
    let value: string | null;
    if (blocked) {
      waitingText = "blocked";
      value = [since ?? shown].filter(Boolean).join("") || null;
    } else {
      value = [roundPrefix, shown].filter(Boolean).join(" · ") || null;
      if (waiting && role && since) waitingText = `waiting ${since}`;
    }
    const enteredHint =
      step.enteredAtMs != null || step.leftAtMs != null
        ? span(step.enteredAtMs ?? null, step.leftAtMs ?? null, now)
        : null;
    const hint = [
      role && rounds.length > 0
        ? rounds.length === 1
          ? "One round"
          : `${rounds.length} rounds`
        : null,
      enteredHint,
      step.note,
      step.state !== "todo" && ms === null && !live ? "Time not recorded" : null,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      key: step.key,
      label: step.label,
      state,
      tone,
      segments,
      value,
      waiting: waitingText,
      hint,
      live: live || (since !== null && (blocked || waitingText !== null)),
    };
  });
}
