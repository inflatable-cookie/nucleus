import { defineRpc } from "../rpc";
import { z } from "zod";
import { planEntriesSchema, planningPlanSnapshotSchema, projectPlanSchema } from "../schema/plans";

export const planGet = defineRpc({ name: "plan.get", input: z.object({ project: z.string().min(1).optional(), repository: z.string().min(1).optional(), version: z.number().int().positive().optional() }).strict()
  .refine(input => Boolean(input.project) !== Boolean(input.repository), "Provide project or repository"), output: projectPlanSchema });

/** Every project's current plan in one response, so the board and Planning tab never fan out one request per project. */
export const plans = defineRpc({ name: "plans", input: z.object({}).strict(), output: z.array(planningPlanSnapshotSchema) });

export const planSet = defineRpc({ name: "plan.set", input: z.object({ project: z.string().min(1).optional(), repository: z.string().min(1).optional(), version: z.number().int().nonnegative(), entries: planEntriesSchema, author: z.string().min(1),
  /** Why the board is intentionally idle; valid only for a plan with no now or next lane. */
  idle: z.string().trim().min(1).max(300).optional() }).strict()
  .refine(input => Boolean(input.project) !== Boolean(input.repository), "Provide project or repository")
  .refine(input => !input.idle || !input.entries.some(entry => entry.horizon === "now" || entry.horizon === "next"), { path: ["idle"], message: "An idle plan has no now or next lane; move them to later or drop idle" }),
  output: projectPlanSchema });
