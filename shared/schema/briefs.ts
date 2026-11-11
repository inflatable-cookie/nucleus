import { z } from "zod";
import { mediaTypeSchema } from "../hooks";
import { laneKeySchema } from "../schema/task-primitives";

/** Spec 020: the existing 128 KB instruction limit applies to a Queue-held brief. */
export const BRIEF_MAX_LENGTH = 128000;

export const briefDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** A brief submitted as content. Queue computes the digest; a supplied digest must match it. */
export const briefInputSchema = z.object({
  text: z.string().min(1).max(BRIEF_MAX_LENGTH),
  mediaType: mediaTypeSchema.default("text/markdown"),
  digest: briefDigestSchema.optional(),
}).strict();

export type BriefInput = z.infer<typeof briefInputSchema>;

/** One pinned brief version. Earlier versions stay on the task after an amendment. */
export const briefVersionSchema = z.object({
  version: z.number().int().positive(), digest: briefDigestSchema, mediaType: mediaTypeSchema,
  text: z.string().min(1).max(BRIEF_MAX_LENGTH), reason: z.string().max(4000), pinnedAt: z.string(),
}).strict();

export type BriefVersion = z.infer<typeof briefVersionSchema>;

export const draftCheckSchema = z.object({ ok: z.boolean(), message: z.string(), checkedAt: z.string(), planningCommit: z.string().nullable() }).strict();

/** Lead branch input is a portable ASCII subset of git refs; planning rechecks with git itself. */
export const gitBranchNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(value =>
  !value.endsWith("/") && !value.includes("..") && value.split("/").every(part => part.length > 0
    && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")), "Invalid Git branch name");

export const leadCheckSchema = draftCheckSchema.extend({ baseBranch: gitBranchNameSchema.optional() });

export const draftApprovalSchema = z.object({ version: z.number().int().positive(), digest: briefDigestSchema, approver: z.string().min(1), approvedAt: z.string(), note: z.string(), relayed: z.boolean(),
  baseBranch: gitBranchNameSchema.optional(), planningCommit: z.string().regex(/^[a-f0-9]{40}$/).optional() }).strict();

export const draftProvenanceSchema = z.object({ id: z.string(), version: z.number().int().positive(), approval: draftApprovalSchema, earlierDigests: z.array(briefDigestSchema) }).strict();

export const leadProvenanceSchema = draftProvenanceSchema.omit({ id: true });

export const planningSourceSchema = z.object({ kind: z.enum(["lead", "papercut"]), id: z.string().min(1) }).strict();

/** Spec 026: a lane document's version as a run was given it. The text stays on the task only. */
export const laneDocumentRefSchema = z.object({ key: laneKeySchema, version: z.number().int().positive(), digest: briefDigestSchema }).strict();

export const laneDocumentPinSchema = laneDocumentRefSchema.extend({ text: z.string() }).strict();

export type LaneDocumentPin = z.infer<typeof laneDocumentPinSchema>;

export type LaneDocumentRef = z.infer<typeof laneDocumentRefSchema>;

/** A lane document reaches prompts, so it keeps the brief's bound. */
export const LANE_DOCUMENT_MAX = BRIEF_MAX_LENGTH;
