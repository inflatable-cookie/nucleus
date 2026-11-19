/**
 * The reviewer's own rules: what a review must read before it judges, the
 * structured verdicts it may attach and how a re-review re-judges them, the
 * reference a finding cites, and the two rules that keep an unrun check out of
 * a finding. Separated from the prompt text so the reviewer, the operator
 * continuation and the closeout read one copy.
 */
import type { Task } from "../../../shared/contracts";
import { latestReviewVerdictRecord } from "../../review/review-verdicts";

export const REVIEWER_NO_FINDING_FOR_UNRUN_TESTS =
  "Do not request changes, or mark a verdict fail or insufficient, solely for checks outside the change's covering validation scope (AGENTS.md Validate section). Require a format check only for changed formatted source that has a covering Effigy format selector; docs, JSON and Cargo.toml-only changes need none. A missing format selector is a papercut, not a review blocker.";

export const LIVE_STORE_COUNTS_REVIEWER_NOTE =
  "Counts that require reading the live Nucleus store are planner evidence. Judge the worker's recorded counts; do not open or query the live store. List any requested live-store check as a planner follow-up, never as an awaiting proof or a reason to block this review.";

/**
 * Mandatory reading finishes before any verdict. A review checkpoint is a stop,
 * never a verdict, and a closed review run cannot be supplemented.
 */
export const REVIEWER_READING_RULE =
  "Read every input the brief names personally before you judge it. Never report a verdict, or pass, while any required input is unread: a closed review run cannot be supplemented. Set reviewResponsibility=author only for changes_required that names a concrete author defect, and environment only for blocked/error that names an external impediment. A ready_to_merge report omits reviewResponsibility. Unfinished reading is yours: report review_in_progress with reviewResponsibility=reviewer, a covered/remaining/notes checkpoint and no verdicts; never return it to the author. If this reader cannot finish, set checkpoint.exhausted to true and list the unread items so an owner can authorize a fresh review.";

export const COORDINATOR_NO_ESCALATE_FOR_UNRUN_TESTS =
  "Do not escalate a recovery solely because tests or checks the repository validation rule says not to run were not run.";

/**
 * Spec 033: a formal review is named by its review id; a comment path keeps its
 * comment id. The two identities are never conflated in a prompt.
 */
export function reviewReference(task: Pick<Task, "resolution" | "prUrl">) {
  const review = task.resolution.review;
  if (review?.reviewId != null) return `Review ID: ${review.reviewId}`;
  if (review?.reviewCommentId == null) return "Review comment: missing";
  const prUrl = task.prUrl?.replace(/\/$/, "");
  return prUrl
    ? `PR issue comment URL: ${prUrl}#issuecomment-${review.reviewCommentId}`
    : `PR issue comment ID: ${review.reviewCommentId} (fetch with gh api repos/{owner}/{repo}/issues/comments/${review.reviewCommentId}; this is not a PR review ID)`;
}

/**
 * The reviewer-facing rule for structured verdicts, which stay ordinary
 * evidence: the reviewer may attach a bounded list and Nucleus publishes it with
 * the findings. Brief frontmatter no longer opts in or gates a merge (Spec 058
 * cutover 2). On a re-review the earlier recorded list travels so the reviewer
 * can judge the current head and check worker citations against the exact
 * verdict record they name. A task with no earlier list keeps its exact prompt.
 */
export function reviewerVerdictsRule(task: Pick<Task, "resolution">) {
  const lines: string[] = [REVIEWER_NO_FINDING_FOR_UNRUN_TESTS];
  lines.push(
    "You may also attach an optional verdicts array (id, subject, verdict, evidence, optional note) recording the judgments this review made; Nucleus publishes it with your findings and a later review re-checks it by id.",
  );
  const earlier = latestReviewVerdictRecord(task);
  if (earlier?.verdicts.length) {
    const identity =
      earlier.reviewId != null
        ? `review ID ${earlier.reviewId}`
        : earlier.reviewCommentId != null
          ? `review comment ID ${earlier.reviewCommentId}`
          : "the earlier review (no published ID recorded)";
    lines.push(
      `On re-review, perform these two separate checks against the exact current PR head. First, report every subject at the current exact head; on a retained delta round re-judge affected subjects using the delta and your earlier evidence, and on an evidence-only turn judge the arriving proofs without re-reading unchanged source. A changed judgment is allowed when the head supports it; keep the same verdict id and use the new verdict's optional note to say it supersedes the earlier verdict by id. Never mark a fresh verdict \`fail\` solely because its value differs from the earlier review. Second, separately inspect values the worker published that cite an earlier review ID (or review comment ID). Compare each value only with the immutable verdict for that id in the exact review it cites, and report \`fail\` on that id only when the worker-published value differs from that cited record. This equality check does not apply to your fresh verdicts.\nEarlier recorded verdicts from ${identity}:\n\`\`\`json\n${JSON.stringify(earlier.verdicts, null, 2)}\n\`\`\``,
    );
  }
  return lines.join("\n");
}

/** Spec 037: the revision run's copy of the latest review's verdicts as JSON. */
export function reviewVerdictsBlock(task: Pick<Task, "resolution">) {
  const record = latestReviewVerdictRecord(task);
  if (!record?.verdicts.length) return "";
  const identity =
    record.reviewId != null
      ? `review ID ${record.reviewId}`
      : record.reviewCommentId != null
        ? `review comment ID ${record.reviewCommentId}`
        : "accepted review (no published ID recorded)";
  return `Review verdicts (recorded by ${identity}; when you publish a value cite its verdict id and this review identity):\n\`\`\`json\n${JSON.stringify(record.verdicts, null, 2)}\n\`\`\`\n`;
}
