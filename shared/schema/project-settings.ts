import { z } from "zod";
import { projectRepositorySchema, projectSchema, repositorySettingsSchema } from "./projects";

/**
 * Settings → Projects (nucleus#948): one read for the page. Writes stay on
 * `project.upsert`, `project.set-planner`, `queue.project-dispatch-limit` and
 * `repository.set`. In-flight is always twice the slots (Tom, 2026-11-08).
 */
export const projectQaStateSchema = z.enum(["queued", "running", "passed", "failed", "hold", "timed_out", "cancelled", "lost"]);

export type ProjectQaState = z.infer<typeof projectQaStateSchema>;

export const projectSettingsProblemSchema = z.enum(["Planner thread is gone", "No planner", "Last QA failed"]);

export type ProjectSettingsProblem = z.infer<typeof projectSettingsProblemSchema>;

export const projectSettingsQaSchema = z.object({
  key: z.string().min(1).max(320),
  state: projectQaStateSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
}).strict();

export type ProjectSettingsQa = z.infer<typeof projectSettingsQaSchema>;

export const projectSettingsRepositorySchema = z.object({
  repository: projectRepositorySchema,
  primary: z.boolean(),
  settings: repositorySettingsSchema.nullable(),
}).strict();

export type ProjectSettingsRepository = z.infer<typeof projectSettingsRepositorySchema>;

export const projectSettingsRowSchema = z.object({
  project: projectSchema,
  repositories: z.array(projectSettingsRepositorySchema),
  slots: z.object({
    value: z.number().int().min(0).max(64),
    override: z.number().int().min(0).max(64).nullable(),
  }).strict(),
  plannerLive: z.boolean().nullable(),
  /** Whether the project's planner thread holds its participant identity ticket yet. */
  plannerTicket: z.enum(["pending", "issued"]).nullable(),
  latestQa: projectSettingsQaSchema.nullable(),
  problems: z.array(projectSettingsProblemSchema),
}).strict();

export type ProjectSettingsRow = z.infer<typeof projectSettingsRowSchema>;

export const projectSettingsSchema = z.object({
  defaultSlots: z.number().int().min(0).max(64),
  projects: z.array(projectSettingsRowSchema),
}).strict();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
