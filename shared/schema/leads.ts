import { z } from "zod";
import { papercutSchema } from "./papercuts";
import { laneKeyListSchema, laneKeySchema } from "../schema/task-primitives";
import { REPOSITORY_IDENTITY_SHAPE, papercutRepositorySchema, repositoryIdentityInputSchema } from "./repository-identity";
import { briefDigestSchema, draftApprovalSchema, gitBranchNameSchema, leadCheckSchema } from "./briefs";
import { MAX_TITLE_LENGTH } from "./task-common";
import { operationAcceptanceSchema } from "../operations";

/** Spec 026: a triage lead body is long-form Markdown, up to 1 MB. */
export const LEAD_BODY_MAX = 1_000_000;

export const leadStateSchema = z.enum(["open", "promoted", "dropped", "closed"]);

export const leadTagSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** Spec 026: tags Queue owns, with their display names. They list ahead of free-form tags. */
export const RESERVED_LEAD_TAGS: Readonly<Record<string, string>> = { papercut: "Papercut" };

export const leadTagsSchema = z.array(leadTagSchema).max(32).refine(tags => new Set(tags).size === tags.length, "Duplicate tag");

export const leadClosureSchema = z.object({ reason: z.enum(["completed", "deprecated"]), note: z.string().nullable(), at: z.string() }).strict();

export const leadPapercutSchema = papercutSchema.pick({ area: true, happened: true, impact: true, fix: true, source: true, draftId: true });

export const leadTargetSchema = z.object({
  kind: z.enum(["draft", "task", "question", "knowledge"]),
  repository: z.string().nullable(),
  reference: z.string().trim().min(1).max(4000),
  at: z.string(),
}).strict();

/** Durable planning audit for one reopen of a dropped lead: the actor, time and reason, plus the prior drop's disposition kept after its current-state fields clear. */
export const leadReopenSchema = z.object({
  reason: z.string().min(1), by: z.string().min(1), at: z.string(),
  drop: z.object({ reason: z.string().nullable(), at: z.string().nullable() }).strict(),
}).strict();

export type LeadReopen = z.infer<typeof leadReopenSchema>;

export const leadSchema = z.object({
  id: z.string(), title: z.string().trim().min(1).max(400), body: z.string().max(LEAD_BODY_MAX),
  repositories: z.array(papercutRepositorySchema).min(1).max(32)
    .refine(repos => new Set(repos.map(repo => repo.origin)).size === repos.length, "Duplicate repository origin"),
  lanes: laneKeyListSchema.default([]),
  tags: leadTagsSchema.default([]), papercut: leadPapercutSchema.nullable().default(null), closure: leadClosureSchema.nullable().default(null),
  author: z.string().min(1), state: leadStateSchema, version: z.number().int().positive(),
  digest: briefDigestSchema.optional(), check: leadCheckSchema.nullable().default(null),
  /** Durable brief check accepted for this current version; cleared with its result. */
  checkOperationId: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), approval: draftApprovalSchema.nullable().default(null),
  originAgentId: z.string().min(1).optional(), baseBranch: gitBranchNameSchema.default("main"),
  dropReason: z.string().nullable(), reopens: z.array(leadReopenSchema).default([]), targets: z.array(leadTargetSchema),
  source: z.object({ file: z.string(), contentKey: z.string() }).strict().nullable(),
  createdAt: z.string(), updatedAt: z.string(), closedAt: z.string().nullable(),
}).strict();

export type Lead = z.infer<typeof leadSchema>;

export const leadVersionSchema = z.object({ version: z.number().int().positive(), title: z.string(), body: z.string(), author: z.string(), createdAt: z.string(), digest: briefDigestSchema.optional(), check: leadCheckSchema.nullable().default(null), approval: draftApprovalSchema.nullable().default(null) }).strict();

export type LeadVersion = z.infer<typeof leadVersionSchema>;

export const leadVersionMetadataSchema = leadVersionSchema.omit({ body: true });

export const leadHistoryVersionSchema = z.union([leadVersionSchema, leadVersionMetadataSchema]);

export const leadDetailSchema = leadSchema.extend({
  versions: z.array(leadHistoryVersionSchema),
  /** Convenient lookup when this lead has exactly one task target; multi-repository leads use `targets`. */
  promotedTaskId: z.string().nullable().default(null),
}).strict();

export type LeadDetail = z.infer<typeof leadDetailSchema>;

export const leadRepositoriesInputSchema = z.union([
  z.array(repositoryIdentityInputSchema).min(1).max(32),
  repositoryIdentityInputSchema.transform(repo => [repo]),
], { error: `expected ${REPOSITORY_IDENTITY_SHAPE} or an array of those` });

export const leadTitleInputSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH, "Lead title must be 200 characters or fewer");

export const leadListInputSchema = z.object({
  repository: z.string().optional(), lane: laneKeySchema.optional(), state: leadStateSchema.default("open"),
  pageSize: z.number().int().min(1).max(8).optional(),
  before: z.object({ createdAt: z.string(), id: z.string().min(1) }).strict().optional(),
}).strict().refine(input => !input.before || input.pageSize !== undefined, "A lead cursor requires pageSize");

export type LeadListInput = z.infer<typeof leadListInputSchema>;

export const leadPageSchema = z.object({
  items: z.array(leadSchema).max(8),
  next: z.object({ createdAt: z.string(), id: z.string().min(1) }).strict().nullable(),
}).strict();

export type LeadPage = z.infer<typeof leadPageSchema>;

export const sourcePromotionResultSchema = z.object({ taskId: z.string(), reference: z.string() }).strict();

export const sourcePromotionOutputSchema = z.union([sourcePromotionResultSchema, operationAcceptanceSchema]);

const leadImportLocationSchema = z.object({ file: z.string(), line: z.number().int().positive() }).strict();

export const leadImportReportSchema = z.object({ imported: z.array(leadImportLocationSchema), duplicate: z.array(leadImportLocationSchema), unparsed: z.array(leadImportLocationSchema.extend({ text: z.string() }).strict()) }).strict();

/** The lead facts list surfaces read without bodies: board cards, selector counts, roadmap counts and lane leads. Full Lead and the narrow board read both satisfy it. */
export type LeadListFacts = Pick<Lead, "id" | "title" | "state" | "lanes" | "repositories">;

/**
 * Spec 026 board read: one narrow card per planning-list row — list metadata, a bounded body
 * preview, and the target/check/approval/tag facts the Triage card shows. Opening a record still
 * reads the complete body, approval and history through lead.get; this projection never carries
 * bodies, approval notes, versions, reopens or history, so its size does not grow with them.
 */
export const LEAD_PREVIEW_MAX = 400;

export const boardLeadSchema = z.object({
  id: z.string(), title: z.string(),
  /** First characters of the body for the card snippet; never the whole body. */
  preview: z.string().max(LEAD_PREVIEW_MAX),
  repositories: z.array(papercutRepositorySchema),
  lanes: laneKeyListSchema.default([]), tags: leadTagsSchema.default([]),
  papercutArea: z.string().nullable(),
  state: z.enum(["open", "promoted"]), version: z.number().int().positive(),
  check: z.object({ ok: z.boolean() }).strict().nullable(),
  /** Approval presence for the card chip; the full approval comes from lead.get. */
  approved: z.boolean(),
  /** Only the draft/task targets the board projection reads; question and knowledge targets stay in lead.get. */
  targets: z.array(z.object({ kind: z.enum(["draft", "task"]), repository: z.string().nullable() }).strict()),
}).strict();

export type BoardLead = z.infer<typeof boardLeadSchema>;

/** Link facts for a lead outside the card set that an open decision links: enough to place the decision, never a body. */
export const boardLeadLinkSchema = z.object({ id: z.string(), lanes: laneKeyListSchema.default([]), repositories: z.array(papercutRepositorySchema) }).strict();

export type BoardLeadLink = z.infer<typeof boardLeadLinkSchema>;
