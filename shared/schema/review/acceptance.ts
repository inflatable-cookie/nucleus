import { z } from "zod";
import { briefDigestSchema, laneDocumentRefSchema } from "../briefs";
import { holdKindSchema } from "../task-primitives";
import { reviewVerdictSchema } from "./evidence";
import { completionSchema } from "./completion";

/**
 * Who accepted what, at which exact head: owner acceptance of a reviewed PR, an
 * owner's acceptance of a report-only task's lane document, review supersession
 * history, the external owner's revision receipt, and the author declaration
 * every review entry and external revision binds. Each record is history the
 * moment its head changes and never rewrites a reviewer verdict.
 */

/** Owner acceptance for the exact Queue lane document that completed a report-only task. */
export const reportAcceptanceSchema = z.object({
  /** The exact lane document an owner accepted, when the completion names one. */
  artifact: laneDocumentRefSchema.optional(),
  acceptedBy: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(4000),
  acceptedAt: z.string().datetime(),
  taskVersion: z.number().int().positive(),
  /** Spec 050 `complete`: an owner-completed no-PR outcome. Absent on report acceptances written before it. */
  kind: z.enum(["report_acceptance", "owner_completed"]).optional(),
}).strict();

export type ReportAcceptance = z.infer<typeof reportAcceptanceSchema>;

/**
 * Spec 037: one immutable review record. It keeps the reviewer agent, run, head,
 * published review id and the reviewer's verdicts, so a later review appends its
 * own record and never rewrites an earlier one.
 */
export const reviewRecordSchema = z.object({
  runId: z.string().min(1), agentId: z.string().nullable().default(null),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.enum(["ready_to_merge", "changes_required"]),
  // Spec 033: a formal review and a comment carry separate ids; either may be absent pre-publication.
  reviewId: z.number().int().positive().nullable().default(null),
  reviewCommentId: z.number().int().positive().nullable().default(null),
  at: z.string(), verdicts: z.array(reviewVerdictSchema).default([]),
}).strict();

export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

/**
 * Qualified owner acceptance (orchestration contract, 2026-10-17): one durable
 * owner decision recorded through `move to=merge`. The task project's authorized
 * owner (or an operator ruling relayed with its note) accepts the reviewed PR at
 * the exact current head over the independent reviewer's disclosed findings. The
 * reviewer verdict, its publication and every historical record stay unchanged:
 * this record never rewrites a verdict, never counts as reviewer credit and
 * never classifies a finding as non-blocking. It binds the exact task, PR, head
 * and authentic review identities, and a later PR head invalidates it for merge
 * while its history remains.
 *
 * Operator source acceptance (2026-10-20, introduced through an agent relay):
 * `kind: "operator_source"` records the same authority accepting the exact
 * published source head AS IS when no review evidence binds that head — an
 * interrupted or unfinished reviewer, an unpublished verdict, or a head a
 * docs-only resolution moved after the verdict. It binds no review identity and
 * invents none; it records the concrete missing evidence beside the accepted
 * risk. It is history the moment the head changes, never inherited by a new
 * head.
 */
const sourceAndOwnerAcceptanceSchema = z.object({
  at: z.string(),
  /** What the acceptance binds. Absent parses as `reviewed`, so stored records keep loading unchanged. */
  kind: z.enum(["reviewed", "operator_source"]).default("reviewed"),
  /** The exact PR head accepted; a different current head leaves the record as history. */
  head: z.string().regex(/^[a-f0-9]{40}$/),
  prNumber: z.number().int().positive(),
  /** The authentic review a `reviewed` acceptance binds — a finished released reviewer verdict, never an approval minted for it. Null exactly for `operator_source`. */
  review: z.object({
    runId: z.string().min(1), eventId: z.string().min(1), head: z.string().regex(/^[a-f0-9]{40}$/),
    status: z.enum(["ready_to_merge", "changes_required"]),
    reviewId: z.number().int().positive().nullable(),
    reviewCommentId: z.number().int().positive().nullable(),
  }).strict().nullable(),
  actor: z.object({ agentId: z.string().min(1), role: z.enum(["project_owner", "operator", "authorized_relay", "delegated", "planner"]) }).strict(),
  authority: z.object({ kind: z.enum(["project_owner", "operator", "relayed_note", "delegated", "planner"]), note: z.string().max(4000).nullable() }).strict(),
  reason: z.string().trim().min(1).max(4000),
  /** The disclosed qualification the owner accepts over the reviewer findings, with any deferred work named. */
  qualification: z.string().trim().min(1).max(4000),
  /** `operator_source` only: the concrete review evidence Queue found missing at the accepted head. It records the accepted risk, never a check result. */
  missingEvidence: z.string().trim().min(1).max(4000).nullable().default(null),
}).strict();

export const ownerAcceptanceRecordSchema = z.union([
  sourceAndOwnerAcceptanceSchema,
  sourceAndOwnerAcceptanceSchema.extend({
    kind: z.literal("external_merge_source"),
    mergedCommit: z.string().regex(/^[a-f0-9]{40}$/),
    review: z.null(),
    actor: sourceAndOwnerAcceptanceSchema.shape.actor.extend({
      role: z.enum(["operator", "planner"]),
    }),
    authority: sourceAndOwnerAcceptanceSchema.shape.authority.extend({
      kind: z.enum(["operator", "planner"]),
    }),
    missingEvidence: z.string().trim().min(1).max(4000),
  }),
]);

export type OwnerAcceptanceRecord = z.infer<typeof ownerAcceptanceRecordSchema>;

export const mechanicalVerificationSchema = z.object({ at: z.string(), head: z.string(), base: z.string() }).strict();

/** Spec 039: evidence invalidated by an operator-requested fresh review stays auditable. */
export const reviewSupersessionSchema = z.object({
  id: z.string().min(1), at: z.string(), reason: z.string().trim().min(1).max(4000),
  reviewRunId: z.string().min(1), reviewId: z.number().int().positive().nullable(),
  reviewCommentId: z.number().int().positive().nullable(), head: z.string().regex(/^[a-f0-9]{40}$/),
  review: completionSchema, verification: completionSchema.nullable(),
  mechanicalVerification: mechanicalVerificationSchema.nullable(),
}).strict();

export type ReviewSupersession = z.infer<typeof reviewSupersessionSchema>;

const concreteModelSchema = z.string().trim().min(3).max(200).refine(value => {
  const normalized=value.toLowerCase();
  return value.includes('/') && !['unknown','default'].includes(normalized) && !['cursor','grok bot','codex','claude code'].includes(normalized);
}, "Author models must be concrete provider/model identities");

export const authorDeclarationSchema = z.object({
  models:z.array(concreteModelSchema).min(1).max(16).transform(models=>[...new Set(models.map(model=>model.toLowerCase()))].sort()),
  githubAuthor:z.string().trim().min(1).max(100), authoringSystem:z.string().trim().min(1).max(200),
  attestedBy:z.string().trim().min(1).max(240), provenance:z.string().trim().min(1).max(4000),
}).strict();

/**
 * Legacy Spec 039 receipt shape retained so historical task rows remain
 * parseable. Current Queue controls never create or treat these receipts as
 * authority for a changed review-entry head.
 */
const datedActorObservationSchema = z.object({
  at: z.string().datetime(), agentId: z.string(), workspaceId: z.string(), status: z.literal("idle"),
  active: z.literal(false), permissions: z.literal(false),
  model:z.string().nullable().optional(),provider:z.string().nullable().optional(),
  tools: z.array(z.object({ name: z.string(), status: z.string(), at: z.string().datetime(),
    callId:z.string(),kind:z.string(),detailDigest:z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict();

export const externalOwnerRevisionReceiptSchema = z.object({
  guarantee: z.literal("dated_git_head").optional(),
  ownerScope:z.object({projectKey:z.string(),ownerAgentId:z.string()}).strict().optional(),
  canonicalObservations: z.object({pr:z.object({at:z.string().datetime(),head:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
    branch:z.object({at:z.string().datetime(),head:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
    base:z.object({at:z.string().datetime(),head:z.string().regex(/^[a-f0-9]{40}$/)}).strict()}).strict().optional(),
  observations: z.object({ owner: datedActorObservationSchema, sourceOwner:datedActorObservationSchema.optional(), coordinator: datedActorObservationSchema.nullable(),
    sourceStartedAt: z.string().datetime(), sourceCompletedAt: z.string().datetime() }).strict().optional(),
  at: z.string(),
  // The durable task-control operation that recorded the receipt; null for a
  // direct synchronous call. A settled operation reconciles to this receipt.
  operationId: z.string().nullable(),
  actor: z.object({ agentId: z.string().min(1), role: z.enum(["project_owner", "authorized_relay"]) }).strict(),
  authorization: z.object({ kind: z.enum(["project_owner", "relayed_note"]), note: z.string().max(4000).nullable() }).strict(),
  reason: z.string().trim().min(1).max(4000),
  previousHead: z.string().regex(/^[a-f0-9]{40}$/),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  task: z.object({ id: z.string(), prNumber: z.number().int().positive(), repository: z.string().min(1),
    branch: z.string().min(1), workspaceId: z.string().min(1), directory: z.string().min(1) }).strict(),
  brief: z.object({ digest: briefDigestSchema.nullable(), version: z.number().int().positive().nullable() }).strict(),
  authorDeclaration: authorDeclarationSchema,
  // The fence observed at recording time, preserved unchanged; recording never
  // releases a hold, and a changed fence refuses at the atomic boundary.
  fence: z.object({ kind: holdKindSchema, owner: z.string().min(1), generation: z.number().int().nonnegative(),
    at: z.string().min(1), reason: z.string().min(1) }).strict().nullable(),
  proof: z.object({ localHead: z.string().regex(/^[a-f0-9]{40}$/), pushedHead: z.string().regex(/^[a-f0-9]{40}$/),
    prHead: z.string().regex(/^[a-f0-9]{40}$/), prUrl: z.string().min(1), base: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  // Retired Spec 039 inert-scaffold reconciliation: null on new receipts,
  // kept readable on stored ones.
  reconciliation: z.object({
    recoveryId: z.string().min(1).max(240),
    recoveryKey: z.string().min(1).max(256),
    recoveryGeneration: z.number().int().nonnegative(),
    recoverySnapshot: z.record(z.string(),z.unknown()).optional(),
    incidentSnapshot: z.record(z.string(),z.unknown()).nullable().optional(),
    incidentId: z.string().min(1).max(240).nullable(),
    incidentCause: z.string().min(1).max(240).nullable(),
    incidentDetail: z.string().min(1).max(4000).nullable(),
    integrationBase: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  }).strict().nullable().optional(),
}).strict();

export type ExternalOwnerRevisionReceipt = z.infer<typeof externalOwnerRevisionReceiptSchema>;
