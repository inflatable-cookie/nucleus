import { z } from "zod";
import { defineRpc } from "../rpc";
import { hostKindSchema } from "../host-kind";

/**
 * Settings → Hosts (nucleus#1325): the durable host catalogue (`meta.hostRegistry`)
 * as the operator reads it, and the one operator verb that prunes it.
 *
 * Status and its reason come from the same projection as `service.health`'s
 * `hosts`, and BB's identity, versions and heartbeat from its `bb` block, so the
 * two never disagree. A field the host never reported is absent, not empty.
 */

/** What still uses a host. Every kind but `repository` refuses `host.remove`. */
export const hostDependencyKindSchema = z.enum(["task", "run", "effect", "repository"]);
export type HostDependencyKind = z.infer<typeof hostDependencyKindSchema>;
export const hostDependencySchema = z.object({
  kind: hostDependencyKindSchema,
  /** Singular noun the confirm and the details count with ("live task"). */
  label: z.string(),
  names: z.array(z.string()),
}).strict();
export type HostDependency = z.infer<typeof hostDependencySchema>;

export const hostVersionSchema = z.object({ label: z.string(), value: z.string() }).strict();

export const hostViewSchema = z.object({
  id: z.string(),
  kind: hostKindSchema,
  /** The readable name: the host kind's label. */
  label: z.string(),
  endpoint: z.string(),
  state: z.enum(["online", "offline", "conflict", "unknown"]),
  /** Why it is offline (or the online host's note); empty when there is nothing to say. */
  reason: z.string(),
  /** The host the operator default host kind resolves to. */
  isDefault: z.boolean(),
  /** When the live session began; only while online. */
  connectedAt: z.string().optional(),
  /** When Nucleus last saw it connected; only when recorded. */
  lastSeenAt: z.string().optional(),
  /** Version strings the host reported, in the order it reported them. */
  versions: z.array(hostVersionSchema),
  /** BB's liveness heartbeat; only for a BB host. */
  heartbeat: z.object({ at: z.string().nullable(), stale: z.boolean() }).strict().optional(),
  dependents: z.array(hostDependencySchema),
  /** Why `host.remove` would refuse right now; empty when it would succeed. */
  removalBlockers: z.array(z.string()),
}).strict();
export type HostView = z.infer<typeof hostViewSchema>;

/** One applied removal: what was forgotten, when, and from which surface. */
export const hostRemovalRecordSchema = z.object({
  at: z.string(),
  hostId: z.string(),
  endpoint: z.string(),
  surface: z.string(),
}).strict();
export type HostRemovalRecord = z.infer<typeof hostRemovalRecordSchema>;

export const hostList = defineRpc({
  name: "host.list",
  input: z.object({}).strict(),
  output: z.object({
    hosts: z.array(hostViewSchema),
    /** The operator default host kind in force, or null for the planner's host. */
    defaultHostKind: hostKindSchema.nullable(),
    removals: z.array(hostRemovalRecordSchema),
  }).strict(),
});

/**
 * Forget one offline, unreferenced host. Settings-only, like `queue.capacity`:
 * the service reads the surface from the transport and refuses every other route
 * before the handler runs. Threads, workspaces, events and run records keep the
 * old host ID; a host that connects again registers again.
 */
export const hostRemove = defineRpc({
  name: "host.remove",
  input: z.object({ hostId: z.string().min(1).max(500) }).strict(),
  output: z.object({ removed: hostRemovalRecordSchema }).strict(),
});
