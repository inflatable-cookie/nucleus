import { z } from "zod";

/**
 * Nucleus#1543: a parked lead stays open and off the to-do list. `revisitAt` is the ISO time
 * Nucleus unparks it again, or null for a park with no date. `by` and `at` record the park.
 */
export const leadParkSchema = z
  .object({
    reason: z.string().trim().min(1).max(4000),
    revisitAt: z.string().nullable(),
    by: z.string().min(1),
    at: z.string(),
  })
  .strict();

export type LeadPark = z.infer<typeof leadParkSchema>;

/**
 * Nucleus#1543: set when a parked lead's recheck came due. Nucleus unparked it and told the
 * planner once; the lead shows "Due for a recheck" until its next park, unpark, edit,
 * promotion or drop clears it.
 */
export const leadRecheckSchema = z
  .object({ reason: z.string().min(1), at: z.string() })
  .strict();

export type LeadRecheck = z.infer<typeof leadRecheckSchema>;
