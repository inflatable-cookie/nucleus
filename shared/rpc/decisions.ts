import { defineRpc } from "../rpc";
import { z } from "zod";
import { decisionAgentProjectsInputSchema, decisionChoiceSchema, decisionDraftShape, decisionStateFilterSchema, decisionViewSchema } from "../schema/decisions";
import { repositoryIdentityInputSchema } from "../schema/repository-identity";

export const decisionAdd = defineRpc({ name: "decision.add", input: z.object(decisionDraftShape).strict().superRefine((value, ctx) => {
  if (value.choices && value.recommended && !value.choices.some(choice => choice.label === value.recommended))
    ctx.addIssue({ code: "custom", path: ["recommended"], message: "Recommended must match one choice label" });
}), output: decisionViewSchema });

export const decisionGet = defineRpc({ name: "decision.get", input: z.object({ id: z.string().min(1) }).strict(), output: decisionViewSchema });

/** Task 1183: retarget project-less decisions at the asker's project. The planner runs the real backfill after merge. */
export const decisionBackfill = defineRpc({ name: "decision.backfill",
  input: z.object({ dryRun: z.boolean().default(true) }).strict(),
  output: z.object({ total: z.number().int().nonnegative(), resolved: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(), unresolvable: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative() }).strict() });

export const decisionAgentProjects = defineRpc({ name: "decision.agent-projects", input: decisionAgentProjectsInputSchema,
  output: z.array(z.object({ agentId: z.string(), project: z.object({ key: z.string(), name: z.string() }).nullable() }).strict()) });

export const decisionList = defineRpc({ name: "decision.list", input: z.object({
  status: decisionStateFilterSchema, asker: z.string().min(1).optional(), project: z.string().min(1).optional(),
  task: z.string().min(1).optional(), lead: z.string().min(1).optional(), papercut: z.string().min(1).optional(),
}).strict(), output: z.array(decisionViewSchema) });

export const decisionAnswer = defineRpc({ name: "decision.answer", input: z.object({
  id: z.string().min(1), version: z.number().int().positive(), answer: z.string().trim().min(1).max(48000),
  answeredBy: z.string().min(1).max(240), relayed: z.boolean().default(true), note: z.string().default(""),
  overtakes: z.array(z.string().min(1).max(160)).max(100).default([]),
}).strict(), output: decisionViewSchema });

export const decisionWithdraw = defineRpc({ name: "decision.withdraw", input: z.object({
  id: z.string().min(1), version: z.number().int().positive(), reason: z.string().trim().min(1).max(4000),
  withdrawnBy: z.string().min(1).max(240).default("operator"),
}).strict(), output: decisionViewSchema });

/** Spec 032: adds links to an open decision in place, so linking never supersedes it and never changes its id. */
export const decisionLink = defineRpc({ name: "decision.link", input: z.object({
  id: z.string().min(1), version: z.number().int().positive(), by: z.string().min(1).max(240).default("operator"),
  tasks: z.array(z.string().min(1).max(160)).max(100).optional(),
  leads: z.array(z.string().min(1).max(160)).max(100).optional(),
  papercuts: z.array(z.string().min(1).max(160)).max(100).optional(),
}).strict(), output: decisionViewSchema });

export const decisionSupersede = defineRpc({ name: "decision.supersede", input: z.object({
  id: z.string().min(1), version: z.number().int().positive(), by: z.string().min(1).max(240).default("operator"),
  question: z.string().trim().min(1).max(4000),
  headline: z.string().trim().min(1).max(140).regex(/^[^\r\n]*$/).optional(),
  choices: z.array(decisionChoiceSchema).min(2).max(3).optional(),
  recommended: z.string().trim().min(1).max(120).optional(), details: z.string().max(48000).nullable().optional(),
  context: z.string().max(20000).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(16).optional(),
  recommendation: z.string().max(4000).nullable().optional(),
  askedBy: z.string().min(1).max(240).optional(), project: z.union([repositoryIdentityInputSchema, z.null()]).optional(),
  tasks: z.array(z.string().min(1).max(160)).max(100).optional(),
  leads: z.array(z.string().min(1).max(160)).max(100).optional(),
  papercuts: z.array(z.string().min(1).max(160)).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.choices && value.recommended && !value.choices.some(choice => choice.label === value.recommended))
    ctx.addIssue({ code: "custom", path: ["recommended"], message: "Recommended must match one choice label" });
}), output: decisionViewSchema });
