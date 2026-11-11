import { z } from 'zod';

/** A project's chosen host kind. `paseo` is the default; `t3code` is trial opt-in. */
export const hostKindSchema = z.enum(['paseo', 't3code']);
export type HostKind = z.infer<typeof hostKindSchema>;
export const DEFAULT_HOST_KIND: HostKind = 'paseo';

export function hostKindOf(hostId: string | null | undefined): HostKind {
  return typeof hostId === 'string' && hostId.startsWith('t3code:') ? 't3code' : 'paseo';
}
