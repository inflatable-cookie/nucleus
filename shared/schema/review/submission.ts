import { z } from "zod";
import { identitySourceSchema } from "../../host-kind";
import { briefInputSchema, draftProvenanceSchema, leadProvenanceSchema, planningSourceSchema } from "../briefs";
import { instructionArtifactSchema } from "../../hooks";
import { capabilityLevelSchema, completionAgentIdsSchema, profileRequestsSchema, scopeSchema } from "../settings";
import { dependencyIdsSchema, laneKeyListSchema } from "../task-primitives";
import { taskTitleSchema } from "../task-common";
import { reviewContinuationIdsSchema, reviewPassGateSchema, reviewVerdictsOptInSchema } from "./retired-submission";

/**
 * One submission: exactly one instruction source, its origin identity and the
 * routing it asks for. Every retired control it still parses is declared here in
 * its original position, so a frozen submission identity keeps its bytes; the
 * shapes and the refusal rule are `./retired-submission.ts`.
 */
export const submissionSchema = z.object({
  hostId: z.string().trim().min(1).max(240).optional(),
  submissionId: z.string().min(1).max(160), title: taskTitleSchema,
  repoPath: z.string().min(1), baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default("main"),
  // The instruction source is a brief held by Queue (Spec 020). handoffPath is the stored
  // legacy field of committed handoffs (nucleus#1368): stored rows keep parsing; no new submission carries it.
  planningCommit: z.string().regex(/^[a-f0-9]{40}$/), handoffPath: z.string().default(""),
  brief: briefInputSchema.nullable().default(null),
  draftProvenance: draftProvenanceSchema.nullable().default(null),
  leadProvenance: leadProvenanceSchema.nullable().default(null),
  planningSource: planningSourceSchema.nullable().default(null),
  instruction: instructionArtifactSchema.nullable().default(null),
  originAgentId: z.string().min(1).max(240), coordinatorAgentId: z.string().max(240).default(""),
  /**
   * The origin identity's own source, filled by the submitting CLI from the
   * caller resolution it already proved (never a typed name). It names the host
   * that identity belongs to, so an offline host cannot block an origin
   * resolution it has no part in. It is evidence about this identity only; it
   * grants no host and no execution authority.
   */
  originIdentity: identitySourceSchema.optional(),
  scope: scopeSchema.default("general"),
  // Optional task complexity for capability-weighted selection; unset reproduces the previous order exactly.
  complexity: capabilityLevelSchema.nullable().optional(),
  preferredProfileId: z.string().default(""),
  skipPRReview: z.boolean().default(false),
  /** Spec 027: sibling worktrees of a multi-repository project are created by default; false skips them. */
  siblings: z.boolean().default(true),
  notifyOriginOnCloseout: z.boolean().default(false),
  completionNotificationAgentIds: completionAgentIdsSchema.default([]),
  profileRequests: profileRequestsSchema.optional(),
  dependsOn: dependencyIdsSchema.default([]),
  lanes: laneKeyListSchema.default([]),
  // Spec 026: lane documents the prompts carry, pinned at dispatch. Absent keeps legacy identity.
  laneDocuments: laneKeyListSchema.optional(),
  // Retired with the manual verification coordinator (Spec 058 cutover 2); new
  // submissions refuse it, stored rows keep parsing.
  manualVerification: z.boolean().default(false),
  // Spec 051: the operator works with the worker in its thread before it submits for review.
  // Absent keeps legacy identity.
  interactive: z.boolean().optional(),
  /** Spec 058: legacy persisted lifecycle marker. New submissions reject explicit false. */
  responsible: z.boolean().optional(),
  /** Critical tasks require a peer-capability independent automatic reviewer. */
  critical: z.boolean().optional(),
  // Spec 020: a brief or handoff may request a merge hold that does not block dispatch.
  mergeHold: z.boolean().optional(),
  // Spec 040: a brief or handoff that requests a merge hold says why; its owner is the submitting agent.
  mergeHoldReason: z.string().trim().min(1).max(4000).optional(),
  // Task 1109: the thread that answers this task's planning questions first. Null
  // means its owner — the thread that submitted or promoted it; reparenting moves
  // that default with the owner. A brief may name another planner thread through
  // `queue.planner`.
  plannerAgentId: z.string().trim().min(1).max(300).nullable().default(null),
  requirePreferred: z.boolean().default(false), thinkingOptionId: z.string().default(""),
  // Retired with Spec 037's brief gates (Spec 058 cutover 2); new submissions
  // refuse both keys, stored rows keep parsing. Recorded verdicts remain
  // ordinary reviewer evidence.
  reviewVerdicts: reviewVerdictsOptInSchema.optional(),
  reviewPassGate: reviewPassGateSchema.optional(),
  /** Live surfaces the qualification touches; this requires a release-kind operator GO. */
  requiresOperatorGo: z.string().trim().min(1).max(4000).optional(),
  // Retired with the automatic-review-loop concept (2026-10-07); no code reads
  // it any more, and it stays on the schema so stored tasks and historical
  // briefs keep loading and amending without a migration.
  reviewContinuationIds: reviewContinuationIdsSchema.optional(),
}).strict();

export type Submission = z.infer<typeof submissionSchema>;
