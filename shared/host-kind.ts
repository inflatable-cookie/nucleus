import { z } from 'zod';

/**
 * A project's chosen host kind. No host is built in as a default: `paseo`,
 * `t3code` and `bb` are equal optional hosts, selected per repository or
 * operator preference and never changed on a live task.
 */
export const hostKindSchema = z.enum(["paseo", "t3code", "bb"]);
export type HostKind = z.infer<typeof hostKindSchema>;
export const DEFAULT_HOST_KIND: HostKind | null = null;
/** An absent or null setting means no operator default (follow repository override, planner host, or an online host). */
export function effectiveDefaultHostKind(stored: HostKind | null | undefined): HostKind | null {
  return stored ?? DEFAULT_HOST_KIND;
}

/** The host names an operator reads, by host kind. */
export const HOST_KIND_LABELS: Record<HostKind, string> = {
  paseo: "Paseo",
  t3code: "T3Code",
  bb: "BB",
};

/**
 * The plugin reload command a host kind's operator runs to bring its plugin back
 * (Spec 062, "Presence"). A host with no plugin of ours has no command.
 */
export const HOST_PLUGIN_RELOAD_COMMANDS: Partial<Record<HostKind, string>> = {
  paseo: "paseo plugin reload nucleus",
  bb: "bb plugin reload nucleus",
};

/**
 * Compatibility classification for recorded host IDs: old Paseo server IDs
 * were opaque, while T3Code and BB use reserved prefixes. This is not proof
 * that an arbitrary ID is registered or authorized.
 */
export function hostKindOf(hostId: string | null | undefined): HostKind {
  if (typeof hostId !== "string") return "paseo";
  if (hostId.startsWith("t3code:")) return "t3code";
  // Spec 062: a BB host identity is `bb:<hash of the real data directory>`.
  if (hostId.startsWith("bb:")) return "bb";
  return "paseo";
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
