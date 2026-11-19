import { z } from 'zod';

/** Evidence for a persisted host selection; migration never invents an identity. */
export const hostSelectionSchema = z.object({
  hostId: z.string().min(1),
  basis: z.enum(['explicit', 'sole_online_host', 'migrated', 'repository_host', 'repository_override', 'operator_default', 'planner_host', 'worker_profile', 'available_host']),
  reason: z.string().min(1).optional(),
}).strict();
export type HostSelection = z.infer<typeof hostSelectionSchema>;
