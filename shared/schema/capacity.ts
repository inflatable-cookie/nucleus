import { z } from "zod";
import { projectSchema } from "./projects";

export const projectDispatchLimitSchema = z.object({
  projectKey: projectSchema.shape.key,
  /** A project's in-flight cap is always twice its slot limit (Tom, 2026-11-08), so the slot limit is the only per-project override. */
  limit: z.number().int().min(0).max(64).nullable(),
}).strict();
