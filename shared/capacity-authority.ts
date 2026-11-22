/**
 * The Settings-only capacity rule's one message and its surface names
 * (service-boundary contract, "Settings-only capacity writes").
 *
 * Host-wide dispatch limits are written only from the operator's Settings
 * surface. Two routes reach it, and both carry transport provenance the service
 * derives itself: the Paseo plugin bridge (`via: "paseo"`, plugin RPC →
 * `ServiceBridge.forward` → the service socket) and the local web board with a
 * valid token (`via: "web"`, the HTTP server in `server/service/web-board.ts`),
 * and the BB plugin's Settings section (`via: "bb"`, plugin RPC → the plugin's
 * retained host-executor connection; Spec 062, phase 6).
 * Every other route — the documented CLI, a direct socket client, any agent
 * shell, a web request without a token — refuses.
 *
 * This is accident prevention, not authorization. The service reads provenance
 * from the transport, never from a field a caller puts in the capacity body, and
 * a same-uid process that deliberately speaks a bridge frame or holds a web token
 * is recorded exactly like the operator's Settings screen. Tom accepted that
 * limit (2026-10-25); what the durable change record buys is that an applied
 * change is never silent afterwards.
 *
 * Deliberately dependency-free: the client bundle imports shared modules, so
 * nothing here may reach for `node:path` or `process`.
 */

/**
 * The surfaces a capacity write may arrive from: the Paseo plugin bridge and the
 * web board's Settings with a valid token. The record says `paseo` or `web`
 * rather than `settings` because neither transport can tell an operator's press
 * from a same-uid process that sends the same frame.
 */
export const CAPACITY_WRITE_SURFACES = ["paseo", "web", "bb"] as const;
export type CapacityWriteSurface = (typeof CAPACITY_WRITE_SURFACES)[number];
/** The bridge surface, the default for a write that names no transport (fixtures and the in-process owner). */
export const CAPACITY_WRITE_SURFACE: CapacityWriteSurface = "paseo";

/**
 * The surface a request's transport provenance names, or `null` when it names no
 * writable surface. This is the only place the wire value becomes a surface, so
 * the dispatch refusal and the recorded attribution cannot disagree.
 */
export function capacityWriteSurface(
  via: string | null | undefined,
): CapacityWriteSurface | null {
  return via === "paseo" || via === "web" || via === "bb" ? via : null;
}

/**
 * The refusal every non-Settings route answers with, before any handler runs and
 * with nothing changed. It is deliberately plain: the caller is told who owns the
 * setting, where, and not to retry, because a retry cannot succeed.
 */
export function capacityWriteRefusalMessage(): string {
  return (
    "queue.capacity is refused: only the operator changes Nucleus's dispatch limits, in Settings. " +
    "Nothing changed; do not retry. Every applied Settings change is recorded with its time, surface and before and after values (`queue.capacity-state`)."
  );
}

/**
 * Settings → Hosts (nucleus#1325): `host.remove` follows the same Settings-only
 * rule and the same transport surfaces. An agent cannot forget a host.
 */
export function hostRemoveRefusalMessage(): string {
  return (
    "host.remove is refused: only the operator removes a registered host, in Settings → Hosts. " +
    "Nothing changed; do not retry. Clear what still uses the host with the ordinary owner verbs, then ask the operator."
  );
}

/** The Settings-only methods and the refusal each answers off the Settings surface. */
export const SETTINGS_ONLY_METHODS: Readonly<Record<string, () => string>> = {
  "queue.capacity": capacityWriteRefusalMessage,
  "host.remove": hostRemoveRefusalMessage,
  "queue.work-storage.set": workStorageWriteRefusalMessage,
};

/**
 * Settings → Storage (nucleus#1526) follows the same Settings-only rule: the
 * operator's paths for the work volume are not an agent's to choose, and a path
 * change re-places every future write on that volume.
 */
export function workStorageWriteRefusalMessage(): string {
  return (
    "queue.work-storage.set is refused: only the operator changes Nucleus's storage paths, on Settings → Storage. " +
    "Nothing changed; do not retry."
  );
}
