/**
 * One pull-request badge mapping for every surface (nucleus#1313, Tom 2026-11-17).
 *
 * The board's `PullRequestBadge` and the BB sidebar's task-group pull-request chip
 * draw the same thing: a state icon and `#<number>` in the state's colour, with the
 * state in the accessible label rather than as visible text. They read this module so
 * the two cannot drift; each surface maps the returned tone onto its own palette
 * (the board's theme roles, the host app's CSS variables).
 *
 * Precedence, in the order the board has always applied it: a terminal state wins
 * over task attention, then attention makes an open PR a warning, and an unknown
 * state is muted.
 */
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

/** The four theme roles plus muted, exactly as `client/board/badges.tsx` renders them. */
export type PullRequestTone = "success" | "accent" | "danger" | "warning" | "muted";

export type PullRequestIcon = "GitPullRequest" | "GitMerge" | "GitPullRequestClosed";

export interface PullRequestBadgeFacts {
  /** The PR state the surface observed; null while it is unknown. */
  state: PullRequestState | null | undefined;
  /** The task needs attention; only an open PR reads as blocked. */
  blocked?: boolean;
}

export interface PullRequestBadge {
  icon: PullRequestIcon;
  tone: PullRequestTone;
  /** The state word the accessible label carries, never the visible chip. */
  stateLabel: string;
}

export function pullRequestBadge(facts: PullRequestBadgeFacts): PullRequestBadge {
  const merged = facts.state === "MERGED";
  const closed = facts.state === "CLOSED";
  const blocked = facts.blocked === true && facts.state === "OPEN";
  return {
    icon: merged ? "GitMerge" : closed ? "GitPullRequestClosed" : "GitPullRequest",
    tone: merged ? "accent" : closed ? "danger" : blocked ? "warning" : facts.state === "OPEN" ? "success" : "muted",
    stateLabel: blocked ? "open, task needs attention" : facts.state ? facts.state.toLowerCase() : "status unavailable",
  };
}

/** `#39`, or `#` alone when the number is unknown. */
export function pullRequestNumberLabel(number: number | string | null | undefined): string {
  return number === null || number === undefined || number === "" ? "#" : `#${number}`;
}

/** `Pull request #39, open, task needs attention` — the one accessible label both surfaces carry. */
export function pullRequestBadgeLabel(number: number | string | null | undefined, badge: PullRequestBadge): string {
  const label = pullRequestNumberLabel(number);
  return `Pull request${label === "#" ? "" : ` ${label}`}, ${badge.stateLabel}`;
}
