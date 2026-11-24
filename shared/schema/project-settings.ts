import { z } from "zod";
import {
  projectRepositorySchema,
  projectSchema,
  repositorySettingsSchema,
} from "./projects";
import { projectAgentViewSchema } from "./project-agents";
import { RESPONSIBLE_THREAD_REASONS } from "../responsible-thread";

/**
 * Settings → Projects (nucleus#948): one read for the page. Writes stay on
 * `project.upsert`, `project.set-planner`, `queue.project-dispatch-limit` and
 * `repository.set`. In-flight is always twice the slots (Tom, 2026-11-08).
 */
export const projectQaStateSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "hold",
  "timed_out",
  "cancelled",
  "lost",
]);

export type ProjectQaState = z.infer<typeof projectQaStateSchema>;

export const projectSettingsProblemSchema = z.union([
  z.enum([
    "Planner thread is gone",
    "No planner",
    "Planner ticket pending",
  ]),
  z.string().startsWith("Planner unroutable: "),
]);

export type ProjectSettingsProblem = z.infer<
  typeof projectSettingsProblemSchema
>;

export const projectSettingsRepositorySchema = z
  .object({
    repository: projectRepositorySchema,
    primary: z.boolean(),
    settings: repositorySettingsSchema.nullable(),
  })
  .strict();

export type ProjectSettingsRepository = z.infer<
  typeof projectSettingsRepositorySchema
>;

const responsibleThreadFieldsSchema = {
  agentId: z.string(),
  hostId: z.string(),
  lastInteraction: z.string().nullable(),
  /** Why this thread was chosen: registration, dispatch, repository work. */
  reasons: z.array(z.enum(RESPONSIBLE_THREAD_REASONS)),
};

export const responsibleObservationViewSchema = z.object({
  /** routable; unverified (slow, failed or inconclusive read, kept in rank); unroutable (a different thread). */
  state: z.enum(["routable", "unverified", "unroutable"]),
  detail: z.string().nullable(),
  observedAt: z.string(),
}).strict();

export const responsibleThreadViewSchema = z.object({
  thread: z.object(responsibleThreadFieldsSchema).strict().nullable(),
  cacheAgeMs: z.number().nonnegative(),
  /** Every shortlisted thread in rank order, with its last observation; null when it was not read. */
  shortlist: z.array(z.object({
    ...responsibleThreadFieldsSchema,
    observation: responsibleObservationViewSchema.nullable(),
  }).strict()),
}).strict();

export const projectSettingsRowSchema = z
  .object({
    project: projectSchema,
    repositories: z.array(projectSettingsRepositorySchema),
    slots: z
      .object({
        value: z.number().int().min(0).max(64),
        override: z.number().int().min(0).max(64).nullable(),
      })
      .strict(),
    responsibleThread: responsibleThreadViewSchema.optional(),
    plannerLive: z.boolean().nullable(),
    /** Whether the project's planner thread holds its participant identity ticket yet. */
    plannerTicket: z.enum(["pending", "issued"]).nullable(),
    /** Task 1110: the project's named agents with live state; the board shows the same list `project.agents` returns. */
    agents: z.array(projectAgentViewSchema).optional(),
    problems: z.array(projectSettingsProblemSchema),
    /** Rust engine (Spec 070 ruling 8): an archived project takes no new work. */
    archived: z.boolean().optional(),
  })
  .strict();

export type ProjectSettingsRow = z.infer<typeof projectSettingsRowSchema>;

export const projectSettingsSchema = z
  .object({
    defaultSlots: z.number().int().min(0).max(64),
    projects: z.array(projectSettingsRowSchema),
  })
  .strict();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
