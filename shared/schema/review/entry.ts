import { z } from "zod";
import { briefDigestSchema } from "../briefs";
import { repoRelativePathSchema } from "../../hooks";
import { submissionRecordFromLegacy } from "../settings";
import { authorDeclarationSchema } from "./acceptance";
import { reviewedInputListSchema } from "./evidence";
import { submissionSchema } from "./submission";
import { retiredSubmissionRefusals } from "./retired-submission";

/**
 * Review entry: taking an existing external PR into the queue under a verified
 * identity, the operation record it leaves, the refusal codes it answers with,
 * and the preview the lead CLI reads before it acts. Here also lives the
 * mechanical review proof a docs-only carry binds, because that proof is the
 * entry's own evidence about the exact head.
 */

export const mechanicalReviewClassificationSchema = z.object({
  path: repoRelativePathSchema,
  kind: z.enum(["task", "incoming", "owning_document_union", "fact_relocation_source", "fact_relocation_destination"]),
  reviewedMode: z.string().nullable(), reviewedBlob: z.string().nullable(),
  incomingMode: z.string().nullable(), incomingBlob: z.string().nullable(),
  candidateMode: z.string().nullable(), candidateBlob: z.string().nullable(),
}).strict();

export const mechanicalReviewProofSchema = z.object({
  version: z.literal(1),
  originalReviewRunId: z.string().min(1), originalReviewEventId: z.string().min(1),
  originalReviewHead: z.string().regex(/^[a-f0-9]{40}$/), originalPublicationKind: z.enum(["review", "comment"]),
  originalPublicationId: z.number().int().positive(), candidateHead: z.string().regex(/^[a-f0-9]{40}$/),
  incomingBase: z.string().regex(/^[a-f0-9]{40}$/), commonAncestor: z.string().regex(/^[a-f0-9]{40}$/),
  mergeCommit: z.string().regex(/^[a-f0-9]{40}$/), proofScope: z.array(repoRelativePathSchema).min(1).max(8),
  relocations: z.array(z.object({ fromPath: repoRelativePathSchema, toPath: repoRelativePathSchema, blockSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(4),
  reviewedInputs: reviewedInputListSchema,
  taskScopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  classifications: z.array(mechanicalReviewClassificationSchema).max(512),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(proof => new TextEncoder().encode(JSON.stringify(proof)).byteLength <= 256 * 1024,
  "Mechanical review proof must be at most 256 KiB");

export type MechanicalReviewProof = z.infer<typeof mechanicalReviewProofSchema>;

export const reviewEntryInputSchema = z.object({
  submission:z.preprocess(raw=>submissionRecordFromLegacy(raw),submissionSchema), workspaceId:z.string().trim().min(1).max(240), prNumber:z.number().int().positive(),
  expectedBranch:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  expectedHead:z.string().regex(/^[a-f0-9]{40}$/), expectedBaseCommit:z.string().regex(/^[a-f0-9]{40}$/),
  authority:z.string().trim().min(1).max(4000), authorDeclaration:authorDeclarationSchema,
  // Omission preserves external ownership and legacy operation input hashes.
  workspaceOwnership:z.enum(["external","intake"]).optional(),
  // Omission keeps existing review-entry operation keys byte-compatible.
  // Retained so callers receive a typed unsupported-mode refusal instead of
  // silently interpreting an old shared-canonical request as isolated.
  workspaceMode:z.enum(["isolated","shared_canonical"]).optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.submission.skipPRReview)ctx.addIssue({code:"custom",path:["submission","skipPRReview"],message:"Review entry requires independent PR review"});
  for(const refusal of retiredSubmissionRefusals(input.submission,"submission"))
    ctx.addIssue({code:"custom",path:["submission",refusal.field],message:refusal.message});
  if(input.expectedBranch===input.submission.baseBranch)ctx.addIssue({code:"custom",path:["expectedBranch"],message:"Review entry requires a non-base source branch"});
});

export type ReviewEntryInput=z.infer<typeof reviewEntryInputSchema>;

export const reviewEntryRecordSchema=z.object({
  operationId:z.string().regex(/^[a-f0-9]{64}$/), prNumber:z.number().int().positive(), repository:z.string().min(1),
  branch:z.string().min(1), workspaceId:z.string().min(1), verifiedHead:z.string().regex(/^[a-f0-9]{40}$/),
  verifiedBase:z.string().regex(/^[a-f0-9]{40}$/), dispatchBase:z.string().regex(/^[a-f0-9]{40}$/).nullable().default(null),
  planningCommit:z.string().regex(/^[a-f0-9]{40}$/), authority:z.string().min(1), authorDeclaration:authorDeclarationSchema,
  checkedAt:z.string(), preserveWorkspace:z.boolean(), directory:z.string().default(""),
  workspaceMode:z.enum(["isolated","shared_canonical"]).default("isolated"),
  briefDigest:briefDigestSchema.nullable().default(null), briefVersion:z.number().int().positive().nullable().default(null),
}).strict();

export type ReviewEntryRecord=z.infer<typeof reviewEntryRecordSchema>;

export const reviewEntryRefusalCodeSchema=z.enum(["identity_mismatch","planning_invalid","ownership_conflict","workspace_busy","author_identity_unverified","permission_unverified","hook_incompatible","exclusive_writer_unavailable"]);

export const reviewEntryPreviewResultSchema=z.object({
  eligible:z.boolean(), refusals:z.array(z.object({code:reviewEntryRefusalCodeSchema,explanation:z.string().max(2000)}).strict()).max(16),
  // Eligibility is acceptance, not execution: an active source writer is a
  // pending handover intake may accept, and this names the activity a fresh
  // admission proof must first observe yielded. Null means the preview proved
  // readiness to execute now.
  pendingHandover:z.string().trim().max(2000).nullable().default(null),
  resolved:z.object({workspaceId:z.string(),directory:z.string(),repository:z.string(),branch:z.string(),head:z.string(),base:z.string(),prNumber:z.number().int().positive(),prUrl:z.string(),workspaceMode:z.enum(["isolated","shared_canonical"]),planningCommit:z.string(),briefDigest:briefDigestSchema.nullable(),briefVersion:z.number().int().positive().nullable()}).strict().nullable(),
}).strict();

/** Operator-only: rearms one attention-held review-entry operation under its existing key, ID and stored payload. */
export const reviewEntryReconcileInputSchema=z.object({
  operationId:z.string().regex(/^[a-f0-9]{64}$/),
  inputHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Service-owned workspace preparation for the lead review-entry CLI. */
export const reviewEntryWorkspaceInputSchema=z.object({
  hostId:z.string().min(1).optional(),leadId:z.string().min(1),leadVersion:z.number().int().positive(),
  prNumber:z.number().int().positive(),title:z.string().min(1),repoPath:z.string().min(1),
}).strict();
export type ReviewEntryWorkspaceInput=z.infer<typeof reviewEntryWorkspaceInputSchema>;
