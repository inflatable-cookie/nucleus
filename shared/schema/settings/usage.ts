import { z } from "zod";
import { usageLevelSchema } from "./capability";

/**
 * Spec 052: the operator's stored usage setting and the view the board shows,
 * plus the standing planner grants that let one planner reach held
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
