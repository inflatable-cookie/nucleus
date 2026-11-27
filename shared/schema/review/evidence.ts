import { z } from "zod";
import { repoRelativePathSchema } from "../../hooks";
import { dedupeReviewedInputs, reviewedInputListRefusals } from "../../service/reviewed-inputs.mjs";

/**
 * The evidence an authentic approval and a worker report rest on: the reviewer's
 * structured judgments and the exact repository inputs it read. Each list has
 * one shape and one refusal rule, shared with the `nucleus_report` bridge.
 */

export const MAX_REVIEW_VERDICTS = 500;

export const MAX_REVIEW_VERDICT_BYTES = 4 * 1024 * 1024;

/**
 * Spec 037: one structured reviewer judgment. `id` is unique within a review and
 * stable across re-reviews of the same subject, so a published value can be tied
 * back to the verdict the reviewer recorded.
 */
export const reviewVerdictValueSchema = z.enum(["pass", "fail", "insufficient", "not_applicable"]);

export type ReviewVerdictValue = z.infer<typeof reviewVerdictValueSchema>;

export const reviewVerdictSchema = z.object({
  id: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(600),
  verdict: reviewVerdictValueSchema,
  evidence: z.string().trim().min(1).max(4000),
  note: z.string().trim().max(4000).optional(),
}).strict();

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/** A bounded verdict list whose ids are unique within the review. */
export const reviewVerdictListSchema = z.array(reviewVerdictSchema).max(MAX_REVIEW_VERDICTS)
  .refine(verdicts => new Set(verdicts.map(verdict => verdict.id)).size === verdicts.length, "Verdict ids must be unique within a review")
  .refine(verdicts => new TextEncoder().encode(JSON.stringify(verdicts)).byteLength <= MAX_REVIEW_VERDICT_BYTES, `Verdicts must be at most ${MAX_REVIEW_VERDICT_BYTES} bytes`);

/** Authenticated reviewer declaration of the exact repository inputs used for an approval. */
export const reviewedInputSchema = z.object({
  path: repoRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ReviewedInput = z.infer<typeof reviewedInputSchema>;

/** One bounded `reviewedInputs` entry: exact files, a path summary or a digest summary. */
export type ReviewedInputEntry = ReviewedInput | { directory: string } | { glob: string } | { digest: string; count: number };

export type ReviewedInputList = ReviewedInputEntry[];

/**
 * Papercut 8647384e (2026-11-10): a verdict refused for a malformed entry became
 * a planner escalation twice (nucleus#1070 duplicate path, nucleus#1098 malformed
 * SHA-256). The list rule lives in `shared/service/reviewed-inputs.mjs`, which the
 * report schema and the `nucleus_report` bridge both read: a refusal names the
 * exact entry, field and expected shape, and a harmless duplicate is
 * de-duplicated instead of refused. Only entries that claim different content for
 * the same path still refuse.
 */
export const reviewedInputListSchema = z.array(z.unknown())
  .transform(rows => dedupeReviewedInputs(rows) as ReviewedInputList)
  .superRefine((rows, ctx) => {
    for (const issue of reviewedInputListRefusals(rows))
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
