import { z } from "zod";
import { repoRelativePathSchema } from "../../hooks";
import { dedupeReviewedInputs, reviewedInputListRefusals } from "../../service/reviewed-inputs.mjs";
import { dedupeProofFiles, proofFileListRefusals } from "../../service/proof-files.mjs";

/**
 * The evidence an authentic approval and a worker report rest on: the reviewer's
 * structured judgments, the exact repository inputs it read, and the worker's
 * local proof files. Each list has one shape and one refusal rule, shared with
 * the `nucleus_report` bridge.
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

/**
 * nucleus#1142 (papercut 01e88ba5): a worker's local proof files, named by a
 * short label and the absolute path inside its own task scratch or worktree.
 * Nucleus validates, copies and hashes them; the paths themselves are never
 * published to the forge.
 */
export const proofFileEntrySchema = z.object({
  label: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(1024),
}).strict();

export type ProofFileEntry = z.infer<typeof proofFileEntrySchema>;

/** One worker proof file after Nucleus copied and hashed it. */
export const proofFileRecordSchema = z.object({
  /** The exact head the evidence was delivered for. */
  head: z.string().regex(/^[a-f0-9]{40}$/),
  label: z.string().trim().min(1).max(120),
  /** The copied file's own name in the evidence directory. */
  name: z.string().min(1).max(200),
  /** The copied file's absolute path under Nucleus's own scratch. */
  path: z.string().min(1).max(2000),
  /** The original task-owned locator, retained as provenance after the run scratch is removed. */
  sourcePath: z.string().min(1).max(2000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  runId: z.string().min(1),
  eventId: z.string().min(1).max(160),
  at: z.string(),
}).strict();

export type ProofFileRecord = z.infer<typeof proofFileRecordSchema>;

/**
 * The report's proof-file list. Shape refusals name the entry and field (the
 * same words the `nucleus_report` bridge applies); containment inside the task
 * is checked against the task record at intake.
 */
export const proofFileListSchema = z.array(z.unknown())
  .transform(rows => dedupeProofFiles(rows) as ProofFileEntry[])
  .superRefine((rows, ctx) => {
    for (const issue of proofFileListRefusals(rows))
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
