import { z } from 'zod';

/** A project's chosen host kind. `paseo` is the default; `t3code` is trial opt-in. */
export const hostKindSchema = z.enum(['paseo', 't3code']);
export type HostKind = z.infer<typeof hostKindSchema>;
export const DEFAULT_HOST_KIND: HostKind = 'paseo';

export function hostKindOf(hostId: string | null | undefined): HostKind {
  return typeof hostId === 'string' && hostId.startsWith('t3code:') ? 't3code' : 'paseo';
}

/**
 * The caller's identity source for one thread: the native identity, and the host
 * that identity's own source proved (`caller.resolve`, `shared/caller.mjs`). The
 * CLI fills it from the calling thread's resolution, never from a typed name, and
 * the service uses it only as evidence about that same thread — it never grants
 * host attribution to another identity or authority to run anything anywhere.
 */
export const identitySourceSchema = z.object({
  agent: z.string().trim().min(1).max(240),
  hostId: z.string().min(1).max(500),
}).strict();
export type IdentitySource = z.infer<typeof identitySourceSchema>;
