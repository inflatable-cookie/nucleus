import { parseDelegateReply } from "../question-delegation";
import {
  PLANNER_ESCALATION_CHOICES,
  type EscalationVerbChoice,
} from "./questions";

/**
 * What a delegate's reply means. The last lines win, and a reply arrives in one of
 * three shapes: an offered choice, a free-form direction, or an operator-only
 * classification. This is the one decode of that text into a typed answer.
 */

export type EscalationReply =
  | { kind: "choice"; choice: string; reason: string }
  | { kind: "answer"; answer: string; reason: string }
  | { kind: "operator"; reason: string };

/** Reads a delegate's reply in any of its three shapes; the last lines win. */
export function parseEscalationReply(
  text: string | null | undefined,
  choices: readonly string[],
): EscalationReply | null {
  return parseDelegateReply(text, "escalation", choices);
}

type EscalationControl =
  /** `move to=work` with the answer as the worker's direction. */
  | { action: "work"; instruction: string }
  /** The owner `stop` verb: live work halts, the branch and PR stay. */
  | { action: "stop" }
  /** Reject a legacy bare wait; a named wake is required. */
  | { action: "wait" };

/** Maps an answer onto the ordinary verb that applies it; a free-form answer is a direction. */
export function escalationAnswerControl(answer: string): EscalationControl {
  const text = answer.trim();
  const matched = PLANNER_ESCALATION_CHOICES.find(
    (choice) => text === choice || text.startsWith(choice),
  );
  if (matched === "Stop and keep the work") return { action: "stop" };
  if (/^(?:leave it waiting|wait|keep waiting)(?:\b|$)/i.test(text))
    return { action: "wait" };
  if (matched === "Return to the worker with a new approach") {
    const direction = text
      .slice(matched.length)
      .replace(/^[\s:—-]+/, "")
      .trim();
    return { action: "work", instruction: direction || text };
  }
  return { action: "work", instruction: text };
}

/** Decode the legacy text boundary once; settlement consumes a typed choice. */
export function decodeEscalationChoice(
  answer: string,
  offered: readonly EscalationVerbChoice[],
):
  | { kind: "owner"; choice: EscalationVerbChoice; reason: string }
  | { kind: "task" | "time" | "decision"; reason: string }
  | { kind: "other"; reason: string } {
  const choice =
    offered.find((item) => answer === item.label) ??
    offered
      .filter((item) => answer.startsWith(`${item.label} — `))
      .reduce<
        EscalationVerbChoice | undefined
      >((longest, item) => (!longest || item.label.length > longest.label.length ? item : longest), undefined);
  if (choice)
    return {
      kind: "owner",
      choice,
      reason: answer.slice(choice.label.length + 3).trim() || choice.label,
    };
  const reason = answer.includes(" — ")
    ? answer.slice(answer.indexOf(" — ") + 3).trim()
    : answer.trim();
  if (answer.startsWith("Wait for a task (")) return { kind: "task", reason };
  if (answer.startsWith("Wait until a time (")) return { kind: "time", reason };
  if (answer.startsWith("Wait for an operator decision ("))
    return { kind: "decision", reason };
  return { kind: "other", reason };
}

/** The first ISO-8601 timestamp with a timezone in the reason; the rest is a note. */
export function extractFirstIsoTimestamp(text: string): string | null {
  const match = text.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/,
  );
  return match ? match[0] : null;
}

/** Ordered task-reference candidates in the reason; the first that resolves is the target. */
export function extractTaskReferenceCandidates(text: string): string[] {
  const matches = text.match(
    /(?:[A-Za-z0-9_.-]+#\d+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|#\d+|\b\d+\b)/g,
  );
  return matches ?? [];
}

/** Ordered decision-ID candidates in the reason; the first that resolves is the target. */
export function extractDecisionIdCandidates(text: string): string[] {
  const uuids = text.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  );
  if (uuids?.length) return uuids;
  const first = text
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^[“"'(\[]+|[”"')\].,;]+$/g, "");
  return first ? [first] : [];
}
