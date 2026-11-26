/**
 * The task timeline (Spec 071, "Timeline bar"), derived from the engine's lifecycle:
 * equal steps, one segment per round on Working and Review, durations as values and
 * clock times only in tooltips. Liveness comes from the engine's active-run fact
 * (`activeSinceMs`), never from a card's start; times the engine did not record stay
 * unknown, and a cancelled task's timeline stops where it was cancelled.
 */
import { formatSpan } from "../../shared/task-detail-summary";
import type {
  RustLifecycle,
  RustPhase,
  RustQuestion,
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
  /** "blocked", "stopped" or "waiting 14m", coloured as the step's tone. */
  waiting: string | null;
  hint: string;
  live: boolean;
};

export type TimelineContext = {
  phase: RustPhase;
  attention: "finished" | "attention" | "active" | "waiting";
  wait: string | null;
  question: RustQuestion | null;
  held: boolean;
  stateSinceMs: number | null;
  now: number;
};

type Round = {
  round: number;
  cards: RustTranscriptCard[];
  startedAtMs: number | null;
  endedAtMs: number | null;
  ended: boolean;
  outcome: RustTranscriptOutcome | null;
  model: string | null;
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
        startedAtMs: null,
        endedAtMs: null,
        ended: true,
        outcome: null,
        model: null,
      };
      rounds.push(round);
    }
    round.cards.push(card);
    if (round.startedAtMs === null) round.startedAtMs = card.startedAtMs;
    // The round's end and model are its latest attempt's, never an earlier attempt's.
    round.endedAtMs = card.endedAtMs ?? null;
    round.ended = card.ended;
    round.outcome = card.outcome ?? round.outcome;
    round.model = card.model;
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

const outcomeTone = (outcome: RustTranscriptOutcome | null): TimelineTone =>
  outcome?.kind === "review" && outcome.decision === "changes"
    ? "warning"
    : outcome?.kind === "blocked"
      ? "danger"
      : outcome?.kind === "provider_limit" || outcome?.kind === "question"
        ? "warning"
        : "success";

function span(start: number | null, end: number | null, now: number): string | null {
  if (start === null) return end === null ? null : `Until ${clockTime(end, now)}`;
  return end === null
    ? `Since ${clockTime(start, now)}`
    : `${clockTime(start, now)} → ${clockTime(end, now)}`;
}

/** Known time across a step's visits; null when any visit was not recorded. */
function visitTime(
  step: RustLifecycle["steps"][number],
  now: number,
  running: boolean,
): { ms: number | null; live: boolean } {
  const visits = step.visits ?? [];
  if (visits.length === 0) return { ms: null, live: false };
  let total = 0;
  let live = false;
  for (const visit of visits) {
    if (visit.enteredAtMs === null) return { ms: null, live: false };
    if (visit.leftAtMs !== null) total += Math.max(0, visit.leftAtMs - visit.enteredAtMs);
    else if (running) {
      total += Math.max(0, now - visit.enteredAtMs);
      live = true;
    } else return { ms: null, live: false };
  }
  return { ms: total, live };
}

/** The waits a person or the engine resolves; a running role is not waiting. */
const PERSON_WAITS = new Set(["hold", "question", "operator_declined", "permission", "usage_permission", "input"]);

export function rustTimeline(
  lifecycle: RustLifecycle,
  context: TimelineContext,
): TimelineStep[] {
  const { now } = context;
  const cards = lifecycle.transcript?.cards ?? [];
  const stopped = context.phase === "cancelled";
  const question = context.question;
  const repair = question !== null && ("repair" in question || "retry" in question);
  return lifecycle.steps.map((step) => {
    const role =
      step.key === "working" ? "worker" : step.key === "review" ? "reviewer" : null;
    const rounds = role ? roundsFor(cards, role) : [];
    const current = step.state === "current";
    const active = current && !stopped;
    const blocked =
      active &&
      (step.tone === "danger" ||
        context.phase === "blocked" ||
        context.phase === "error" ||
        repair ||
        (context.attention === "attention" && question === null && !context.held && context.wait !== "operator_declined"));
    const waiting =
      active &&
      !blocked &&
      (context.attention === "waiting" ||
        context.attention === "attention" ||
        (context.wait !== null && PERSON_WAITS.has(context.wait)));
    const tone: TimelineTone = blocked ? "danger" : current ? step.tone : "muted";
    const currentFill = waiting ? "wait" : "solid";

    const segments: TimelineSegment[] = [];
    /** The live attempt's own time, from the engine's active-run start. */
    let attemptMs: number | null = null;
    /** The live round's whole time; null when an earlier attempt has no recorded time. */
    let liveMs: number | null = null;
    /** Each round's recorded time, null when any attempt that is not live lacks one. */
    const roundMs = new Map<number, number | null>();
    const lastRound = rounds.at(-1);
    for (const round of rounds) {
      const last = round === lastRound;
      const latest = round.cards.at(-1);
      // Live only while the engine reports an active run and the attempt has not reported.
      const live =
        active && last && latest !== undefined && !latest.ended && latest.outcome === null && step.activeSinceMs !== null;
      const counted = round.cards.filter((card) => !(live && card === latest));
      const recorded = counted.some((card) => card.elapsedMs === null)
        ? null
        : counted.reduce((sum, card) => sum + (card.elapsedMs ?? 0), 0);
      roundMs.set(round.round, recorded);
      if (live) {
        attemptMs = Math.max(0, now - (step.activeSinceMs ?? now));
        liveMs = recorded === null ? null : recorded + attemptMs;
      }
      const resting = active && last && !live && paused(round.outcome);
      const unreported = !live && latest !== undefined && !latest.ended && latest.outcome === null;
      const words = live
        ? "in progress"
        : unreported
          ? stopped
            ? "stopped"
            : "not reported"
          : outcomeWords(round.outcome);
      const ms = live ? liveMs : recorded;
      const timing =
        ms !== null
          ? duration(ms)
          : live && attemptMs !== null
            ? `round time not recorded, this attempt ${duration(attemptMs)}`
            : "time not recorded";
      segments.push({
        fill: live || resting ? currentFill : "solid",
        tone: live || resting ? tone : unreported ? "muted" : outcomeTone(round.outcome),
        label: [`${step.label} round ${round.round}`, words].filter(Boolean).join(" · "),
        hint: [
          [`Round ${round.round}`, words].filter(Boolean).join(" · "),
          [round.model, timing].filter(Boolean).join(" · "),
          span(round.startedAtMs, live ? null : round.endedAtMs, now),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    const lastLive = attemptMs !== null;
    const lastResting = lastRound !== undefined && paused(lastRound.outcome);
    // A reported run that has not ended yet keeps its outcome; the next round waits for the end.
    if (active && !lastLive && !lastResting && (lastRound === undefined || lastRound.ended)) {
      // The current step before (or between) its runs, or a step with no rounds.
      const round = (lastRound?.round ?? 0) + 1;
      segments.push({
        fill: currentFill,
        tone,
        label: role ? `${step.label} round ${round} · ${blocked ? "blocked" : "in progress"}` : `${step.label} · ${blocked ? "blocked" : "in progress"}`,
        hint: role ? `Round ${round}` : (step.note ?? step.label),
      });
    } else if (current && stopped && rounds.length === 0) {
      segments.push({ fill: "solid", tone: "muted", label: `${step.label} · stopped`, hint: "Cancelled here" });
    }
    if (segments.length === 0) {
      segments.push({
        fill: step.state === "done" ? "solid" : "track",
        tone: step.state === "done" ? "success" : "muted",
        label: `${step.label} · ${step.state === "done" ? "complete" : "not started"}`,
        hint: step.state === "done" ? "Complete" : "Not started",
      });
    }

    const state: TimelineState = step.state === "todo" && rounds.length > 0 ? "lit" : step.state;
    const stepTone: TimelineTone = current
      ? tone
      : state === "lit"
        ? rounds.some((round) => outcomeTone(round.outcome) === "warning")
          ? "warning"
          : "success"
        : step.state === "done"
          ? "success"
          : "muted";

    // Values: every one a duration. Role steps sum their rounds; the rest sum visits.
    let ms: number | null = null;
    let live = false;
    if (role && rounds.length > 0) {
      const totals = rounds.map((round) => roundMs.get(round.round) ?? null);
      if (!totals.includes(null)) {
        ms = totals.reduce<number>((sum, value) => sum + (value ?? 0), 0) + (attemptMs ?? 0);
      }
      live = attemptMs !== null;
    } else if (role && (step.elapsedMs !== null || step.activeSinceMs !== null)) {
      const running = active && step.activeSinceMs !== null;
      ms = (step.elapsedMs ?? 0) + (running ? Math.max(0, now - (step.activeSinceMs ?? now)) : 0);
      live = running;
    } else if (!role) {
      ({ ms, live } = visitTime(step, now, active));
    }
    // Without a transcript (the board list), the engine's own round label still counts.
    const labelled = Number(step.roundLabel?.match(/\d+/)?.[0] ?? 0);
    const lastNumber = lastRound?.round ?? labelled;
    const roundPrefix = role && lastNumber >= 2 ? `Round ${lastNumber}` : null;
    // An unknown round total stays unknown; the live attempt's own time is named as such.
    const shown =
      attemptMs !== null && (liveMs === null || ms === null)
        ? liveMs !== null && roundPrefix
          ? duration(liveMs)
          : `attempt ${duration(attemptMs)}`
        : liveMs !== null && roundPrefix
          ? duration(liveMs)
          : ms === null
            ? null
            : live
              ? duration(ms)
              : formatSpan(ms);
    const since = active && context.stateSinceMs !== null ? duration(now - context.stateSinceMs) : null;
    let waitingText: string | null = null;
    let value: string | null;
    if (blocked) {
      waitingText = "blocked";
      value = since ?? shown;
    } else {
      value = [roundPrefix, shown].filter(Boolean).join(" · ") || null;
      // Queued's own time is its wait.
      if (waiting && since && step.key !== "queued") waitingText = `waiting ${since}`;
      if (current && stopped) waitingText = "stopped";
    }
    const enteredHint =
      step.enteredAtMs != null || step.leftAtMs != null
        ? span(step.enteredAtMs ?? null, step.leftAtMs ?? null, now)
        : null;
    // The step tooltip repeats each round, so the evidence is reachable from the keyboard too.
    const roundLines = rounds.map((round) => {
      const segment = segments.find((candidate) => candidate.label.startsWith(`${step.label} round ${round.round}`));
      return segment?.hint.split("\n").slice(0, 2).join(" · ") ?? `Round ${round.round}`;
    });
    const hint = [
      ...roundLines,
      enteredHint,
      step.note,
      step.state !== "todo" && ms === null && !live && (rounds.length > 0 || !role || step.state === "done")
        ? "Time not recorded"
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      key: step.key,
      label: step.label,
      state,
      tone: stepTone,
      segments,
      value,
      waiting: waitingText,
      hint,
      live: live || since !== null,
    };
  });
}
