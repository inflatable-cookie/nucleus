import { z } from "zod";

const triageOutcomeSchema = z.object({
  version: z.number().int(), status: z.enum(["proposed", "applied", "refused", "superseded"]), disposition: z.enum(["promote", "close", "defer", "operator"]).nullable(),
  reason: z.string(), by: z.string(), at: z.string(), canonical: z.string().nullable(), closure: z.enum(["duplicate", "fixed", "out_of_scope"]).nullable(),
  revisitAt: z.string().nullable(), question: z.string().nullable(), task: z.string().nullable(), diagnostic: z.string(),
});

export const triageRecordItemSchema = z.object({
  recordId: z.string(), kind: z.enum(["lead", "papercut"]), title: z.string(), createdAt: z.string(), leadVersion: z.number().int(), digest: z.string(),
  outcome: triageOutcomeSchema.nullable(),
});

const planningTriageBatchSchema = z.object({
  id: z.string(),
  items: z.array(triageRecordItemSchema.pick({ recordId: true, title: true }).extend({
    kind: triageRecordItemSchema.shape.kind.nullable(),
    outcome: triageOutcomeSchema.omit({ version: true, by: true, at: true }).nullable(),
    taskId: z.string().nullable(), canonicalTaskId: z.string().nullable(),
  })),
});

export const planningTriageSchema = z.object({
  enabled: z.boolean(), waiting: z.enum(["capacity"]).nullable(), awaitingPlanner: z.boolean(),
  current: planningTriageBatchSchema.nullable(), latest: planningTriageBatchSchema.nullable(),
});

export type PlanningTriage = z.infer<typeof planningTriageSchema>;
