import { z } from "zod";
import { laneKeyListSchema } from "../schema/task-primitives";
import { papercutRepositorySchema, repositoryIdentityInputSchema } from "./repository-identity";

export const papercutStateSchema = z.enum(["open", "promoted", "closed"]);

export const papercutSchema = z.object({
  id: z.string(), repository: papercutRepositorySchema, area: z.string().nullable(),
  title: z.string(), happened: z.string(), impact: z.string(), fix: z.string().nullable(),
  filedBy: z.string(), filedAt: z.string(), state: papercutStateSchema,
  version: z.number().int().positive().default(1),
  taskId: z.string().nullable(), closedReason: z.enum(["completed", "deprecated"]).nullable(),
  draftId: z.string().nullable().default(null),
  note: z.string().nullable(), closedAt: z.string().nullable(),
  source: z.object({ file: z.string(), line: z.number().int().positive(), contentKey: z.string() }).strict().nullable(),
  lanes: laneKeyListSchema.default([]),
}).strict();

export type Papercut = z.infer<typeof papercutSchema>;

export const papercutAddInputSchema = z.object({ repository: repositoryIdentityInputSchema, area: z.string().optional(), title: z.string().trim().min(1), happened: z.string().trim().min(1), impact: z.string().default(""), fix: z.string().optional(), filedBy: z.string().min(1).default("operator"), filedAt: z.string().datetime().optional() }).strict();
