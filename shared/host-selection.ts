import { z } from 'zod';

/** Evidence for a persisted host selection; migration never invents an identity. */
export const hostSelectionSchema = z.object({
  hostId: z.string().min(1),
  basis: z.enum(['explicit', 'sole_online_host', 'migrated']),
  reason: z.string().min(1).optional(),
}).strict();
export type HostSelection = z.infer<typeof hostSelectionSchema>;
