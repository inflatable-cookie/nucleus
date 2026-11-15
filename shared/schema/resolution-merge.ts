import { z } from "zod";

/** The merge the task is driving: its intent, the head and base it bound, its response and retry state, and the merged commit. */
export const resolutionMergeFields = {
  externalMerge: z.boolean().default(false),
  // A verified merge with no applied ready_to_merge verdict and no operator
  // source acceptance at that head. Closeout uses the merge commit anyway.
  mergedWithNone: z.boolean().default(false),
  mergeIntent: z.boolean().default(false), mergeHead: z.string().nullable().default(null), mergeBase: z.string().nullable().default(null),
  mergeRequestedAt: z.string().nullable().default(null),
  mergeResponseOutcome: z.enum(["pending", "accepted", "uncertain"]).default("pending"),
  mergeProofSince: z.string().nullable().default(null),
  mergeRetryAt: z.string().nullable().default(null),
  mergeRetryOutcome: z.enum(["pending", "accepted", "uncertain"]).nullable().default(null),
  mergeAutoRetryExhausted: z.boolean().default(false),
  mergedCommit: z.string().nullable().default(null), syncedCommit: z.string().nullable().default(null),
  integrationTurn: z.object({ sequence: z.number().int().positive(), acceptedAt: z.string() }).nullable().default(null),
};
