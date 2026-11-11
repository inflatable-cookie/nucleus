import { BOARD_QA_OUTPUT_LINES, BOARD_QA_OUTPUT_LINE_MAX, type BoardQaRun, type ProjectQaRun } from "../../shared/contracts";
import { execFileSync } from "node:child_process";

export interface StaleQaRun { commitsSince: number; runAt: string }
type GitRunner = (repository: string, args: string[]) => string;

/** Cache branch heads and base/head comparisons so board rebuilds never invoke Git per card. */
export function createQaStalenessResolver(options: { runGit?: GitRunner; now?: () => number; headTtlMs?: number } = {}) {
  const runGit = options.runGit ?? ((repository, args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim());
  const now = options.now ?? Date.now;
  const headTtlMs = options.headTtlMs ?? 30_000;
  const heads = new Map<string, { head: string | null; at: number }>();
  const comparisons = new Map<string, StaleQaRun | null>();
  return (run: ProjectQaRun): StaleQaRun | null => {
    if (!["failed", "timed_out", "hold"].includes(run.state)) return null;
    const branchKey = `${run.repository.path}\0${run.baseBranch}`;
    let cachedHead = heads.get(branchKey);
    if (!cachedHead || now() - cachedHead.at >= headTtlMs) {
      let head: string | null = null;
      try { head = runGit(run.repository.path, ["rev-parse", `refs/remotes/origin/${run.baseBranch}`]); } catch { /* Missing or unreadable ref: no guess. */ }
      cachedHead = { head, at: now() };
      heads.set(branchKey, cachedHead);
    }
    const head = cachedHead.head;
    if (!head || head === run.base) return null;
    const compareKey = `${branchKey}\0${head}\0${run.base}`;
    if (comparisons.has(compareKey)) return comparisons.get(compareKey) ?? null;
    let stale: StaleQaRun | null = null;
    try {
      runGit(run.repository.path, ["merge-base", "--is-ancestor", run.base, head]);
      const count = Number(runGit(run.repository.path, ["rev-list", "--count", `${run.base}..${head}`]));
      if (Number.isSafeInteger(count) && count > 0) stale = { commitsSince: count, runAt: run.startedAt };
    } catch { /* Rewritten or unavailable history: no guess. */ }
    comparisons.set(compareKey, stale);
    return stale;
  };
}

/**
 * Tom, 2026-11-01: "Pass fades, fail stays". A passing run leaves the board this long after it
 * finishes; the QA runs page keeps its history. Nothing else fades.
 */
export const QA_BOARD_PASS_FADE_MS = 5 * 60_000;

/**
 * The board cards for milestone QA (Tom, 2026-11-01). Input is the latest run per repository, so a
 * repository's card follows its newest run: a re-run that is queued or running replaces the card of
 * the failure it re-runs, and a passing re-run clears the failure. A finished run that is not passing
 * stays until it is dismissed or a later run passes. A passing run stays for the fade window only.
 * Dismissed runs never show; their records stay.
 */
export function boardQaRuns(latestRuns: readonly ProjectQaRun[], nowMs: number, staleForRun?: (run: ProjectQaRun) => StaleQaRun | null): BoardQaRun[] {
  const cards: BoardQaRun[] = [];
  for (const run of latestRuns) {
    if (run.dismissal) continue;
    if (run.state === "passed" && run.finishedAt !== null && Date.parse(run.finishedAt) + QA_BOARD_PASS_FADE_MS <= nowMs) continue;
    cards.push(boardQaRunView(run, staleForRun?.(run) ?? null));
  }
  return cards;
}

/** The card a run projects to: its state and placement facts, the step it is on, and the last output lines. */
export function boardQaRunView(run: ProjectQaRun, stale: StaleQaRun | null = null): BoardQaRun {
  const lines = run.outputTail.split("\n").map(line => line.trimEnd()).filter(line => line.length > 0)
    .slice(-BOARD_QA_OUTPUT_LINES).map(line => line.slice(0, BOARD_QA_OUTPUT_LINE_MAX));
  // A step records when it ends; the last step without an end is the one running now.
  const open = run.state === "running" ? run.steps.filter(step => !step.endedAt).at(-1) : undefined;
  return {
    id: run.id,
    repository: run.repository,
    key: run.key,
    selector: run.selector ?? "qa",
    baseBranch: run.baseBranch,
    state: run.state,
    queuePosition: run.queuePosition ?? null,
    startedAt: run.startedAt,
    submittedAt: run.submittedAt ?? null,
    finishedAt: run.finishedAt,
    currentStep: open?.name ?? null,
    failedStep: run.failedStep,
    exitCode: run.exitCode,
    outputLines: lines,
    cancelReason: run.cancelReason,
    stale,
  };
}

