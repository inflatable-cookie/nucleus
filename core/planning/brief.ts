import { createHash } from "node:crypto";
import { BRIEF_MAX_LENGTH, type BriefVersion, type Submission, type Task } from "../../shared/contracts";

/**
 * Spec 020 brief mode. A brief is submitted as content and pinned by Queue; the
 * repository holds no copy. Handoff-mode tasks never reach this module's checks.
 */
export const briefDigest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
export const isBriefMode = (input: Pick<Submission, "brief">) => Boolean(input.brief);

/** Exactly one instruction source: a committed handoff path or a Queue-held brief. */
export function assertOneInstructionSource(input: Pick<Submission, "brief" | "handoffPath">) {
  if (Boolean(input.brief) === Boolean(input.handoffPath)) throw new Error("A submission carries exactly one of handoffPath or brief");
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

/** Whether a lead body starts with a frontmatter brief. */
export const hasBriefFrontmatter = (text: string): boolean => /^---\r?\n/.test(text);
