/**
 * Spec 064 P5: the one cumulative first-effect clock.
 *
 * Required time origin **t0** is immediately before the attempt's first
 * mandatory effect — scheduler persistence and reservation persistence included.
 * One elapsed interval covers admission, work, stop requests, waits,
 * finalization and acknowledged delivery; the 560/530/20/2 cutoffs overlap
 * inside the same 600 s target and are never added to it. A retry continues the
 * attempt's existing clock instead of starting a new one, and an effect ordered
 * before the origin refuses. The clock is a local elapsed measurement: it is not
 * the qualified common elapsed clock across participating processes, which
 * remains a required external input (see `qualification-inputs.ts`).
 */
import { randomUUID } from "node:crypto";
import {
  QUALIFICATION_FIRST_EFFECT_TARGET_MS,
  type QualificationFirstEffectClock,
} from "../../shared/schema/review/proof";

/** One mandatory effect the route would cause, with the tick it happened (or would happen) at. */
export interface QualificationEffect {
  name: string;
  tick: number;
}

/** P5's overlapping cutoffs, counted from the same origin. Nothing here is addable to the target. */
export const QUALIFICATION_CUTOFFS = {
  candidateMs: 560_000,
  suiteMs: 530_000,
  stopAllocationMs: 20_000,
  exitAllocationMs: 2_000,
} as const;

export interface FirstEffectClockReading {
  clockId: string;
  originTick: number;
  targetMs: number;
  nowTick: number;
  elapsedMs: number;
  remainingMs: number;
  /** The target is met while `nowTick` is at or before `originTick + targetMs`. */
  withinTarget: boolean;
  targetHit: boolean;
}

export interface FirstEffectClockChoice {
  clock: QualificationFirstEffectClock;
  /** True when the attempt's earlier origin was kept instead of a new one minted. */
  reused: boolean;
}

const isTick = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Mint one origin, taken immediately before the attempt's first mandatory effect. */
export function establishFirstEffectClock(originTick: number, clockId: string = randomUUID()): QualificationFirstEffectClock {
  if (!isTick(originTick)) throw new Error(`A first-effect origin must be a non-negative integer tick, not ${JSON.stringify(originTick)}`);
  return { clockId, originTick, targetMs: QUALIFICATION_FIRST_EFFECT_TARGET_MS };
}

/**
 * The clock a new attempt continues. A retry never resets it: the earliest
 * recorded origin (by tick, then by clock id) is kept, so a fresh dispatch after
 * a failure or a restart cannot restart or lengthen the target. A recorded clock
 * that cannot be read is not reused as if it were absent; the caller decides.
 */
export function continueFirstEffectClock(
  recorded: readonly (QualificationFirstEffectClock | null | undefined)[],
  nowTick: number,
): FirstEffectClockChoice {
  const present = recorded.filter((clock): clock is QualificationFirstEffectClock => clock != null);
  if (!present.length) return { clock: establishFirstEffectClock(nowTick), reused: false };
  const earliest = [...present].sort((left, right) =>
    left.originTick - right.originTick || (left.clockId < right.clockId ? -1 : left.clockId > right.clockId ? 1 : 0))[0]!;
  return {
    clock: establishFirstEffectClock(earliest.originTick, earliest.clockId),
    reused: true,
  };
}

/** Read one clock at a tick. Elapsed work always reduces the remaining target. */
export function firstEffectClockReading(clock: QualificationFirstEffectClock, nowTick: number): FirstEffectClockReading {
  const elapsedMs = Math.max(0, nowTick - clock.originTick);
  const remainingMs = Math.max(0, clock.targetMs - elapsedMs);
  return {
    clockId: clock.clockId, originTick: clock.originTick, targetMs: clock.targetMs, nowTick,
    elapsedMs, remainingMs, withinTarget: elapsedMs <= clock.targetMs, targetHit: elapsedMs > clock.targetMs,
  };
}

/**
 * Refuse an effect that would precede the attempt's origin. A mandatory effect
 * ordered before t0 is not this attempt's evidence, and the route refuses rather
 * than resting a proof on a clock that started late (Spec 064 P5).
 */
export function firstEffectClockRefusal(clock: QualificationFirstEffectClock, effects: readonly QualificationEffect[]): string | null {
  const early = effects.filter(effect => effect.tick < clock.originTick);
  if (!early.length) return null;
  return `The first-effect clock ${clock.clockId} (origin ${clock.originTick}) is preceded by ${early.length === 1 ? "a mandatory effect" : "mandatory effects"}: `
    + `${early.map(effect => `${effect.name} at ${effect.tick}`).join(", ")}; the route refuses rather than crediting an effect it never covered`;
}

/**
 * The target is permanent: once hit, nothing later makes the attempt pass. This
 * is the one owner of that sentence, so the endpoint, S and the intake read the
 * same rule.
 */
export function firstEffectTargetRefusal(reading: FirstEffectClockReading, what: string): string | null {
  if (!reading.targetHit) return null;
  return `${what} completed at +${reading.elapsedMs} ms, past the ${reading.targetMs} ms first-effect target counted from ${reading.originTick}; the target is permanently failed and late completion changes closure only`;
}
