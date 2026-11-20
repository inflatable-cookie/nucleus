import { defineRpc } from "../rpc";
import { z } from "zod";

/**
 * Nucleus#1420: automatic lead and papercut triage. A project opts in with `triage.set`; the
 * planner reads its outstanding batch with `triage.get` and answers it with `triage.apply`.
 * Filing text is evidence; these records hold the planner's decisions and their reasons.
 */
const triageRecordItemSchema = z.object({
  recordId: z.string(), kind: z.enum(["lead", "papercut"]), title: z.string(), createdAt: z.string(), leadVersion: z.number().int(), digest: z.string(),
  outcome: z.object({
    version: z.number().int(), status: z.enum(["proposed", "applied", "refused", "superseded"]), disposition: z.enum(["promote", "close", "defer", "operator"]).nullable(),
    reason: z.string(), by: z.string(), at: z.string(), canonical: z.string().nullable(), closure: z.enum(["duplicate", "fixed", "out_of_scope"]).nullable(),
    revisitAt: z.string().nullable(), question: z.string().nullable(), task: z.string().nullable(), diagnostic: z.string(),
  }).nullable(),
});

export const triageViewSchema = z.object({
  enabled: z.boolean(), enabledAt: z.string().nullable(), enabledBy: z.string().nullable(), waiting: z.enum(["capacity"]).nullable(),
  batch: z.object({ id: z.string(), createdAt: z.string(), planner: z.string().nullable(), noticed: z.boolean(), items: z.array(triageRecordItemSchema) }).nullable(),
  operatorQuestions: z.array(z.object({ recordId: z.string(), question: z.string().nullable(), at: z.string() })),
  lastCompleted: z.string().nullable(),
}).strict();

export const triageDecisionInputSchema = z.object({
  recordId: z.string().min(1),
  leadVersion: z.number().int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/, "Use the digest triage.get returned for the record"),
  disposition: z.enum(["promote", "close", "defer", "operator"]),
  reason: z.string().trim().min(1).max(4000),
  canonical: z.string().trim().min(1).max(4000).nullish(),
  closure: z.enum(["duplicate", "fixed", "out_of_scope"]).nullish(),
  revisitAt: z.string().refine(value => !Number.isNaN(Date.parse(value)), "revisitAt must be an ISO time").nullish(),
  question: z.string().trim().min(1).max(4000).nullish(),
}).strict();

export const triageGet = defineRpc({ name: "triage.get", input: z.object({ project: z.string().min(1) }).strict(), output: triageViewSchema });

export const triageSet = defineRpc({ name: "triage.set", input: z.object({ project: z.string().min(1), enabled: z.boolean(), by: z.string().min(1) }).strict(),
  output: triageViewSchema });

export const triageApply = defineRpc({ name: "triage.apply", input: z.object({ project: z.string().min(1), batch: z.string().min(1), by: z.string().min(1),
  decisions: z.array(triageDecisionInputSchema).min(1).max(8) }).strict(),
  output: z.object({ batchId: z.string(), complete: z.boolean(), replayed: z.boolean(),
    outcomes: z.array(z.object({ recordId: z.string(), status: z.string(), disposition: z.string().nullable(), task: z.string().nullable(), diagnostic: z.string() })) }).strict() });
