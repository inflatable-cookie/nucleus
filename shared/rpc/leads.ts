import { defineRpc } from "../rpc";
import { z } from "zod";
import { laneKeyListSchema } from "../schema/task-primitives";
import { aliasRepositoryField, repositoryIdentityInputSchema } from "../schema/repository-identity";
import { LEAD_BODY_MAX, boardLeadLinkSchema, boardLeadSchema, leadDetailSchema, leadImportReportSchema, leadListInputSchema, leadPageSchema, leadRepositoriesInputSchema, leadSchema, leadTagsSchema, leadTitleInputSchema, leadVersionSchema, sourcePromotionOutputSchema } from "../schema/leads";
import { briefDigestSchema, gitBranchNameSchema } from "../schema/briefs";
import { sourcePromotionInputSchema } from "../schema/operations";

/** Submit an authorized brief through the existing check, approval and promotion gates. */
export const leadSubmit = defineRpc({ name: "lead.submit", input: z.object({
  repository: repositoryIdentityInputSchema, title: leadTitleInputSchema, body: z.string().min(1).max(LEAD_BODY_MAX),
  baseBranch: gitBranchNameSchema.default("main"), lanes: laneKeyListSchema.default([]), tags: leadTagsSchema.default([]),
  agent: z.string().trim().min(1).refine(value => value !== "operator (board)", "Identify the relaying agent"),
  note: z.string().trim().min(1), hostId: z.string().trim().min(1).max(240).optional(),
  /** The promoting caller's own identity source, filled by the CLI from its environment. */
  identitySource: sourcePromotionInputSchema.shape.identitySource,
  hold: sourcePromotionInputSchema.shape.hold,
}).strict(), output: z.union([sourcePromotionOutputSchema, z.object({ lead: leadSchema }).strict()]) });

export const leadAdd = defineRpc({ name: "lead.add", input: z.preprocess((value) => aliasRepositoryField(value, "repositories"), z.object({ repositories: leadRepositoriesInputSchema, title: leadTitleInputSchema, body: z.string().max(LEAD_BODY_MAX).default(""), baseBranch: gitBranchNameSchema.default("main"), lanes: laneKeyListSchema.default([]), tags: leadTagsSchema.default([]), author: z.string().min(1).default("operator") }).strict()), output: leadSchema });

export const leadEdit = defineRpc({ name: "lead.edit", input: z.object({ id: z.string().min(1), version: z.number().int().positive(), title: leadTitleInputSchema.optional(), body: z.string().max(LEAD_BODY_MAX).optional(), baseBranch: gitBranchNameSchema.optional(), author: z.string().min(1) }).strict(), output: leadSchema });

export const leadGet = defineRpc({ name: "lead.get", input: z.object({ id: z.string().min(1) }).strict(), output: leadDetailSchema });

export const leadVersion = defineRpc({ name: "lead.version", input: z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict(), output: leadVersionSchema });

export const leadList = defineRpc({ name: "lead.list", input: leadListInputSchema, output: z.union([z.array(leadSchema), leadPageSchema]) });

export const leadSetLanes = defineRpc({ name: "lead.set-lanes", input: z.object({ id: z.string().min(1), lanes: laneKeyListSchema }).strict(), output: leadSchema });

export const leadSetTags = defineRpc({ name: "lead.set-tags", input: z.object({ id: z.string().min(1), tags: leadTagsSchema }).strict(), output: leadSchema });

export const leadDrop = defineRpc({ name: "lead.drop", input: z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(4000) }).strict(), output: leadSchema });

/** Undoes one mistaken drop in place: identity, content version, saved versions, checks and approval history are untouched, and the reopen plus the prior drop's disposition enter durable history. */
export const leadReopen = defineRpc({ name: "lead.reopen", input: z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(4000), author: z.string().min(1) }).strict(), output: leadSchema });

/** Hand promotion to a question or knowledge change; task and draft targets arrive with one-step promotion. */
export const leadPromote = defineRpc({ name: "lead.promote", input: z.object({ id: z.string().min(1), kind: z.enum(["question", "knowledge"]), reference: z.string().trim().min(1).max(4000) }).strict(), output: leadSchema });

export const leadCheck = defineRpc({ name: "lead.check", input: z.object({ id: z.string().min(1), repository: z.string().optional(), baseBranch: gitBranchNameSchema.optional() }).strict(), output: leadSchema });

export const leadApprove = defineRpc({ name: "lead.approve", input: z.object({ id: z.string().min(1), version: z.number().int().positive(), digest: briefDigestSchema, approver: z.string().min(1), note: z.string().default(""), relayed: z.boolean().default(true) }).strict(), output: leadSchema });

export const leadPromoteTask = defineRpc({ name: "lead.promote-task", input: sourcePromotionInputSchema, output: sourcePromotionOutputSchema });

export const papercutPromoteTask = defineRpc({ name: "papercut.promote-task", input: sourcePromotionInputSchema, output: sourcePromotionOutputSchema });

export const leadImport = defineRpc({ name: "lead.import", input: z.preprocess((value) => aliasRepositoryField(value, "repository"), z.object({ repository: repositoryIdentityInputSchema, path: z.string().min(1), dryRun: z.boolean().default(false), author: z.string().min(1).optional() }).strict().transform(({ author: _author, ...rest }) => rest)), output: leadImportReportSchema });

/**
 * Internal narrow read for the board's planning lists (Queue, Planning, Lanes, the project
 * selector and Triage cards). `cards` holds every open lead plus every promoted lead that still
 * has a repository without a draft/task target — exactly the records the Pipeline projection
 * shows. `links` holds promoted leads outside that set which an open decision links, so decision
 * placement keeps its lanes and scoping without downloading promoted history. lead.list stays
 * the documented full-body read; agents and skills keep using it.
 */
export const leadBoard = defineRpc({ name: "lead.board", input: z.object({}).strict(),
  output: z.object({ cards: z.array(boardLeadSchema), links: z.array(boardLeadLinkSchema) }).strict() });
