import { z } from "zod";
import { papercutRepositorySchema, repositoryIdentityInputSchema } from "./repository-identity";

/**
 * Spec 032: a question an agent records because it needs the operator's ruling.
 * Decisions record questions and answers only; they grant no execution authority
 * and change no task, lead or papercut state. Every change is versioned and a
 * stale version is refused, as for leads.
 */
export const decisionStateSchema = z.enum(["open", "answered", "withdrawn", "superseded"]);

export const decisionAskerSchema = z.object({ agentId: z.string().min(1).max(240), project: papercutRepositorySchema.nullable().default(null) }).strict();

export const decisionLinksSchema = z.object({
  tasks: z.array(z.string().min(1).max(160)).max(100).default([]),
  leads: z.array(z.string().min(1).max(160)).max(100).default([]),
  papercuts: z.array(z.string().min(1).max(160)).max(100).default([]),
}).strict();

export const decisionAnswerSchema = z.object({
  text: z.string().trim().min(1).max(48000), answeredBy: z.string().min(1).max(240), answeredAt: z.string(),
  relayed: z.string().min(1).max(240).nullable().default(null), note: z.string().max(4000).default(""),
  overtakes: z.array(z.string().min(1).max(160)).max(100).optional(),
}).strict();

export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

export const decisionOvertakingReferenceSchema = z.object({
  kind: z.enum(["brief_amendment", "decision_answer", "planner_answer"]), id: z.string().min(1).max(160),
  sourceId: z.string().min(1).max(160).optional(), label: z.string().min(1).max(240), at: z.string(),
}).strict();

export const decisionWithdrawalSchema = z.object({
  reason: z.string().trim().min(1).max(4000), withdrawnBy: z.string().min(1).max(240), withdrawnAt: z.string(),
}).strict();

export const decisionDeliverySchema = z.object({
  version: z.number().int().positive(), status: z.enum(["pending", "intent", "delivered", "uncertain"]),
  noticeId: z.string(), agentId: z.string(), text: z.string(), error: z.string().default(""),
  attempts: z.number().int().nonnegative().default(0), deliveredAt: z.string().nullable().default(null),
}).strict();

export const decisionVersionSchema = z.object({
  version: z.number().int().positive(), question: z.string(), context: z.string().nullable(),
  options: z.array(z.string()), recommendation: z.string().nullable(),
  headline: z.string().max(140).regex(/^[^\r\n]*$/).optional(),
  choices: z.array(z.object({ label: z.string().min(1).max(120), consequence: z.string().max(240).regex(/^[^\r\n]*$/) }).strict()).max(3).optional(),
  recommended: z.string().max(120).optional(), details: z.string().max(48000).nullable().optional(),
  // Links join the content snapshot so a link-only edit has a history entry that records it.
  // A snapshot written before links were recorded reads `null`, never empty links.
  links: decisionLinksSchema.nullable().default(null), status: decisionStateSchema,
  answer: decisionAnswerSchema.nullable(), withdrawal: decisionWithdrawalSchema.nullable(),
  supersededBy: z.string().nullable(), by: z.string(), at: z.string(),
}).strict();

export type DecisionVersion = z.infer<typeof decisionVersionSchema>;

export const decisionSchema = z.object({
  id: z.string(), version: z.number().int().positive(), question: z.string().trim().min(1).max(4000),
  headline: z.string().trim().min(1).max(140).regex(/^[^\r\n]*$/).optional(),
  choices: z.array(z.object({ label: z.string().trim().min(1).max(120), consequence: z.string().trim().max(240).regex(/^[^\r\n]*$/) }).strict()).min(2).max(3).optional(),
  recommended: z.string().trim().min(1).max(120).optional(),
  details: z.string().max(48000).nullable().optional(),
  context: z.string().max(20000).nullable().default(null),
  options: z.array(z.string().trim().min(1).max(200)).max(16).default([]),
  recommendation: z.string().max(4000).nullable().default(null),
  overtakenBy: z.array(decisionOvertakingReferenceSchema).max(100).optional(),
  askedBy: decisionAskerSchema, links: decisionLinksSchema, status: decisionStateSchema,
  answer: decisionAnswerSchema.nullable().default(null), withdrawal: decisionWithdrawalSchema.nullable().default(null),
  supersededBy: z.string().nullable().default(null), delivery: decisionDeliverySchema.nullable().default(null),
  createdAt: z.string(), updatedAt: z.string(),
  versions: z.array(decisionVersionSchema).default([]),
}).strict();

export type Decision = z.infer<typeof decisionSchema>;

/** `stale` is derived at read time: every linked task, lead and papercut is terminal, and none closed it. */
/** `projectKey`: the Queue project the asking repository belongs to, derived on read; null for General or an unregistered repository. */
// A view without `projectKey` (a reader or fixture from before #578, or a server
// mid-roll) parses as no project, so its decisions still show.
export const decisionViewSchema = decisionSchema.extend({ stale: z.boolean(), projectKey: z.string().nullable().default(null) }).strict();

export type DecisionView = z.infer<typeof decisionViewSchema>;

export const decisionStateFilterSchema = decisionStateSchema.optional();

export const decisionChoiceSchema = z.object({ label: z.string().trim().min(1).max(120), consequence: z.string().trim().max(240).regex(/^[^\r\n]*$/) }).strict();

export const decisionDraftShape = {
  question: z.string().trim().min(1).max(4000),
  headline: z.string().trim().min(1).max(140).regex(/^[^\r\n]*$/).optional(),
  choices: z.array(decisionChoiceSchema).min(2).max(3).optional(),
  recommended: z.string().trim().min(1).max(120).optional(),
  details: z.string().max(48000).nullable().optional(),
  context: z.string().max(20000).nullable().default(null),
  options: z.array(z.string().trim().min(1).max(200)).max(16).default([]),
  recommendation: z.string().max(4000).nullable().default(null),
  askedBy: z.string().min(1).max(240),
  project: z.union([repositoryIdentityInputSchema, z.null()]).default(null),
  tasks: z.array(z.string().min(1).max(160)).max(100).default([]),
  leads: z.array(z.string().min(1).max(160)).max(100).default([]),
  papercuts: z.array(z.string().min(1).max(160)).max(100).default([]),
};

/**
 * The composer pill's project for each Paseo thread: the project of the task the
 * agent works on, else the project whose repository holds its working directory.
 */
export const decisionAgentProjectsInputSchema = z.object({
  agents: z.array(z.object({ agentId: z.string().min(1).max(240), cwd: z.string().max(4096) }).strict()).max(1000),
}).strict();
