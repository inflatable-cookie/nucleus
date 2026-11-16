import { z } from "zod";
import { usageLevelSchema } from "./capability";

/**
 * Spec 052: the operator's stored usage setting and the view the board shows,
 * plus the standing planner grants that let one planner reach above-ceiling
 * profiles for a block of work. This is the operator authority over cost; the
 * routing rows in `./routing.ts` explain what selection did with it.
 */

/** The stored setting; `until` returns the level to `normal` when it passes. */
export const usageSettingSchema = z.object({
  level: usageLevelSchema,
  until: z.string().datetime({ offset: true }).nullable().default(null),
  setAt: z.string().datetime({ offset: true }),
}).strict();

export type UsageSetting = z.infer<typeof usageSettingSchema>;

/** What the board shows: the level in force, and the stored setting behind it. */
export const usageViewSchema = z.object({
  level: usageLevelSchema, setLevel: usageLevelSchema, until: z.string().nullable(), expired: z.boolean(),
}).strict();

export type UsageView = z.infer<typeof usageViewSchema>;

/**
 * Spec 052 planner grant (Tom, 2026-11-06): standing permission for one planner
 * to use frontier and above-ceiling profiles for a block of work. Stored in meta.
 */
export const routingGrantStatuses = ["pending", "active", "ended", "revoked", "expired", "archived", "declined"] as const;

export const routingGrantSchema = z.object({
  id: z.string().min(1),
  planner: z.string().min(1).max(300),
  reason: z.string().min(1).max(4000),
  /** Empty: every profile that needs sign-off. Named: only those ids. */
  profiles: z.array(z.string().trim().min(1)).default([]),
  until: z.string().datetime({ offset: true }).nullable().default(null),
  status: z.enum(routingGrantStatuses),
  requestedAt: z.string().datetime({ offset: true }),
  requestedBy: z.string().min(1).max(300),
  decisionId: z.string().nullable().default(null),
  activatedAt: z.string().datetime({ offset: true }).nullable().default(null),
  activatedBy: z.string().nullable().default(null),
  endedAt: z.string().datetime({ offset: true }).nullable().default(null),
  endedBy: z.string().nullable().default(null),
  endReason: z.string().max(400).nullable().default(null),
  runCount: z.number().int().nonnegative().default(0),
}).strict();

export type RoutingGrant = z.infer<typeof routingGrantSchema>;

/** What the board lists: live grants, newest first. */
export const routingGrantViewSchema = routingGrantSchema;

export type RoutingGrantView = RoutingGrant;
