import { z } from "zod";
import { projectRemovalBlockerKindSchema, projectRemovalBlockerSchema, projectSchema, projectTombstoneSchema } from "./projects";
import { bulkDispositionSchema } from "./bulk-disposition";

/**
 * Spec 040 (Tom, 2026-10-26): change the owner of open tasks in one write each -
 * the listed tasks, or every open task of a project that one thread owns. The
 * caller is the operator at the board, the project's owner thread or the tasks'
 * current owner; the new owner must be a live planning thread.
 */
const reparentBase = { toAgentId: z.string().min(1).max(240), caller: z.string().min(1).max(240), reason: z.string().trim().min(1).max(2000) };

export const reparentInputSchema = z.union([
  z.object({ ...reparentBase, taskIds: z.array(z.string().min(1).max(160)).min(1).max(1000) }).strict(),
  z.object({ ...reparentBase, project: projectSchema.shape.key, fromAgentId: z.string().min(1).max(240) }).strict(),
]);

export type ReparentInput = z.infer<typeof reparentInputSchema>;

export const reparentResultSchema = z.object({
  toAgentId: z.string(), workspaceId: z.string(),
  changed: z.array(z.object({ taskId: z.string(), version: z.number().int().positive(), from: z.string() }).strict()),
  unchanged: z.array(z.string()),
}).strict();

export type ReparentResult = z.infer<typeof reparentResultSchema>;

/** Spec 027: server-authoritative cleanup confirmation, never a filtered board inventory. */
export const projectManagementItemSchema = z.object({
  kind: projectRemovalBlockerKindSchema, id: z.string(), label: z.string(), shared: z.boolean(),
}).strict();

export const projectManagementPreviewSchema = z.object({
  project: projectSchema, target: projectSchema.nullable(), digest: z.string(),
  items: z.array(projectManagementItemSchema), cancellation: bulkDispositionSchema.nullable(),
  tasks: z.array(z.object({ taskId: z.string(), version: z.number().int().positive() }).strict()),
}).strict();

export type ProjectManagementPreview = z.infer<typeof projectManagementPreviewSchema>;

export const projectManageInputSchema = z.object({
  key: projectSchema.shape.key, version: z.number().int().positive(), digest: z.string().min(1),
  reason: z.string().trim().min(1).max(4000), target: projectSchema.shape.key.optional(),
  cancellationOperationId: z.string().optional(),
}).strict();

export type ProjectManageInput = z.infer<typeof projectManageInputSchema>;

export const projectRemoveInputSchema = z.object({ key: projectSchema.shape.key, version: z.number().int().positive(), reason: z.string().trim().min(1).max(4000) }).strict();

export type ProjectRemoveInput = z.infer<typeof projectRemoveInputSchema>;

/** `repository` (an `owner/name` origin or checkout path of a member) scopes the scan to that one member (nucleus#967). */
export const projectRemovalBlockersInputSchema = z.object({ key: projectSchema.shape.key, repository: z.string().min(1).optional() }).strict();

/**
 * nucleus#967: take a member out of a project and delete the one-repository
 * project it would become, in one transaction. Refused, with nothing changed,
 * for the primary or while that repository has removal blockers.
 */
export const projectRemoveRepositoryInputSchema = z.object({
  key: projectSchema.shape.key, version: z.number().int().positive(), repository: z.string().min(1), reason: z.string().trim().min(1).max(4000),
}).strict();

export type ProjectRemoveRepositoryInput = z.infer<typeof projectRemoveRepositoryInputSchema>;

/**
 * nucleus#969: move a project into another, in one transaction. Without
 * `repository` every member of `source` becomes a member of `target` and `source`
 * is removed (its name, planner and slot override go; the target's stay, and so
 * does its primary; its saved plan entries join the target's). With `repository`
 * only that member moves; when it is the source's only member the source is
 * removed the same way. Records on the moving repositories follow them. Refused,
 * with nothing changed, while `project.merge-check` names a blocker (nucleus#984).
 */
export const projectMergeInputSchema = z.object({
  source: projectSchema.shape.key, target: projectSchema.shape.key,
  versions: z.object({ source: z.number().int().positive(), target: z.number().int().positive() }).strict(),
  repository: z.string().min(1).optional(), reason: z.string().trim().min(1).max(4000),
}).strict();

export type ProjectMergeInput = z.infer<typeof projectMergeInputSchema>;

export const projectMergeOutputSchema = z.object({ project: projectSchema, source: projectSchema.nullable(), tombstone: projectTombstoneSchema.nullable() }).strict();

export type ProjectMergeResult = z.infer<typeof projectMergeOutputSchema>;

/**
 * nucleus#984: Move into's confirm. `blockers` is what refuses `project.merge`
 * (a queued or running project QA, or an in-flight repository re-key, on a
 * moving repository); `carried` is what comes along, as `project.removal-blockers`
 * names it, so the confirm can count it.
 */
export const projectMergeCheckInputSchema = z.object({ source: projectSchema.shape.key, repository: z.string().min(1).optional() }).strict();

export type ProjectMergeCheckInput = z.infer<typeof projectMergeCheckInputSchema>;

export const projectMergeCheckSchema = z.object({ blockers: z.array(projectRemovalBlockerSchema), carried: z.array(projectRemovalBlockerSchema) }).strict();

export type ProjectMergeCheck = z.infer<typeof projectMergeCheckSchema>;
