import { z } from "zod";
import { serviceRollSchema } from "../service-roll";

/**
 * Typed standalone-service state for the thin bridge (Contract 007). The
 * bridge never starts an in-plugin Queue, inspects SQLite or infers failure
 * from an unknown response; it reports exactly one of these states.
 */
export const serviceStateSchema = z.object({
  state: z.enum(["absent", "starting", "running", "incompatible", "upgrading", "unhealthy"]),
  detail: z.string(),
  buildId: z.string().nullable().default(null),
  pid: z.number().int().positive().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  ready: z.boolean().nullable().default(null),
  paused: z.boolean().nullable().default(null),
  hostId: z.string().nullable().default(null),
  error: z.string(),
  /**
   * Whether the post-connect bootstrap is pending and since when. A bootstrap that
   * hangs is otherwise invisible, which is how the runtime wedged while every surface
   * reported ready.
   */
  bootstrap: z.object({ pending: z.boolean(), startedAt: z.string().nullable() }).default({ pending: false, startedAt: null }),
  /** Build the plugin (bridge and UI bundle) loaded with; differs from `buildId` after an automatic roll. */
  pluginBuildId: z.string().nullable().default(null),
  /** Latest automatic roll after a checkout change; a failed roll is operator attention. */
  roll: serviceRollSchema.nullable().default(null),
}).strict();

export type QueueServiceState = z.infer<typeof serviceStateSchema>;
