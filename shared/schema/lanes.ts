import { z } from "zod";
import { laneKeySchema } from "../schema/task-primitives";
import { LANE_AIM_MAX, normalizeRepositoryOrigin } from "../lanes";
import { LANE_DOCUMENT_MAX, briefDigestSchema } from "./briefs";

/** The denormalised title and aim of one attached lane, in membership order, for prompts and detail. */
export const laneContextSchema = z.object({ key: laneKeySchema, title: z.string(), aim: z.string() }).strict();

export type LaneContext = z.infer<typeof laneContextSchema>;

export const laneStatusSchema = z.enum(["active", "paused", "done", "abandoned"]);

export const laneRepositorySchema = z.object({
  origin: z.string().trim().min(3).max(200)
    .refine(value => Boolean(normalizeRepositoryOrigin(value)), "Repository origin must be owner/name")
    .transform(value => normalizeRepositoryOrigin(value)!),
  path: z.string().min(1).max(1024),
}).strict();

/** Spec 041: one drain episode, on a lane or on a project plan. `lane` names the project episode's top `now` step when the episode began. */
export const laneDrainSchema = z.object({
  since: z.string(), lane: laneKeySchema.optional(),
  notices: z.number().int().nonnegative().default(0), lastNoticeAt: z.string().nullable().default(null),
  escalatedAt: z.string().nullable().default(null),
}).strict();

export type LaneDrain = z.infer<typeof laneDrainSchema>;

/** Spec 041: the recorded answer that ended a lane's drain episode. */
export const laneKeepSchema = z.object({ reason: z.string().trim().min(1).max(4000), at: z.string(), by: z.string().min(1).max(240) }).strict();

export type LaneKeep = z.infer<typeof laneKeepSchema>;

export const laneSchema = z.object({
  id: z.string().min(1),
  key: laneKeySchema,
  title: z.string().trim().min(1).max(200),
  aim: z.string().trim().min(1).max(LANE_AIM_MAX),
  status: laneStatusSchema,
  note: z.string().max(4000).default(""),
  repositories: z.array(laneRepositorySchema).min(1)
    .refine(repos => new Set(repos.map(repo => repo.origin)).size === repos.length, "Duplicate repository origin"),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable().default(null),
  // Spec 041: the open drain episode and the last keep answer; episodes re-form from activity.
  drain: laneDrainSchema.nullable().default(null), keep: laneKeepSchema.nullable().default(null),
}).strict();

export type Lane = z.infer<typeof laneSchema>;

export const laneOutcomeSummarySchema = z.object({
  taskId: z.string().min(1),
  title: z.string(),
  outcome: z.enum(["done", "cancelled", "superseded"]),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  finishedAt: z.string().nullable(),
}).strict();

export const laneViewSchema = laneSchema.extend({
  liveByPhase: z.record(z.string(), z.number()),
  liveByRepository: z.record(z.string(), z.number()),
  terminalCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
  recentOutcomes: z.array(laneOutcomeSummarySchema).default([]),
}).strict();

export type LaneView = z.infer<typeof laneViewSchema>;

export const laneUpsertInputSchema = z.object({
  key: laneKeySchema,
  title: z.string().trim().min(1).max(200),
  aim: z.string().trim().min(1).max(LANE_AIM_MAX),
  repositories: z.array(laneRepositorySchema).min(1)
    .refine(repos => new Set(repos.map(repo => repo.origin)).size === repos.length, "Duplicate repository origin"),
}).strict();

export type LaneUpsertInput = z.infer<typeof laneUpsertInputSchema>;

export const laneStatusInputSchema = z.object({
  key: laneKeySchema,
  status: laneStatusSchema,
  note: z.string().max(4000).optional(),
}).strict();

export const lanesQuerySchema = z.object({
  status: laneStatusSchema.optional(),
  repository: z.string().min(1).max(1024).optional(),
}).strict();

/** Spec 022: a project's closeout override for a repository with no manifest. */
export const projectCloseoutSchema = z.enum(["queue", "agent"]);

export type ProjectCloseout = z.infer<typeof projectCloseoutSchema>;

/** Spec 041: keep answers a lane's drain prompt; the required reason ends the episode. */
export const laneKeepInputSchema = z.object({ key: laneKeySchema, reason: z.string().trim().min(1).max(4000), author: z.string().trim().min(1).max(240).default("operator") }).strict();

export const laneDocumentVersionSchema = z.object({ key: laneKeySchema, version: z.number().int().positive(), text: z.string().max(LANE_DOCUMENT_MAX), digest: briefDigestSchema, author: z.string().min(1), createdAt: z.string() }).strict();

export type LaneDocumentVersion = z.infer<typeof laneDocumentVersionSchema>;
