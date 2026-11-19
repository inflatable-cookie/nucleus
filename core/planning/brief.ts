import { createHash } from "node:crypto";
import { BRIEF_MAX_LENGTH, type BriefVersion, type Submission, type Task } from "../../shared/contracts";

/**
 * Spec 020 brief mode. A brief is submitted as content and pinned by Queue; the
 * repository holds no copy. It is the only instruction source: committed handoffs
 * are retired (nucleus#1368).
 */
export const briefDigest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const isBriefMode = (input: Pick<Submission, "brief">) => Boolean(input.brief);

/** The refusal for any committed-handoff submission or dispatch; the route is a Queue-held brief. */
export const COMMITTED_HANDOFF_RETIRED = "Committed handoffs are retired. Submit the work as a Nucleus-held brief with lead.submit (or nucleus helper submit --brief <file>).";

/** A submission carries a Queue-held brief; a committed handoff path is refused. */
export function assertBriefInstructionSource(input: Pick<Submission, "brief" | "handoffPath">) {
  if (input.handoffPath) throw new Error(COMMITTED_HANDOFF_RETIRED);
  if (!input.brief) throw new Error("A submission carries a Queue-held brief");
}

/** Validate the submitted brief content and return its computed digest. */
export function pinnedBriefDigest(input: Pick<Submission, "brief">): string {
  const brief = input.brief;
  if (!brief?.text || brief.text.length > BRIEF_MAX_LENGTH) throw new Error("Brief is empty or exceeds 128 KB");
  const computed = briefDigest(brief.text);
  if (brief.digest && brief.digest !== computed) throw new Error("Brief digest does not match its content");
  return computed;
}

/** The pinned version a run receives now. */
export function currentBrief(task: Pick<Task, "briefVersions">): BriefVersion | null {
  return task.briefVersions?.at(-1) ?? null; // Tolerates partial task views built before brief mode.
}

/** The first pinned version, built from the accepted submission. */
export function initialBriefVersion(input: Pick<Submission, "brief">, pinnedAt: string): BriefVersion[] {
  if (!input.brief) return [];
  return [{ version: 1, digest: pinnedBriefDigest(input), mediaType: input.brief.mediaType, text: input.brief.text, reason: "Submitted", pinnedAt }];
}

export { hasBriefFrontmatter } from "../../shared/lead-status";
