/**
 * The local web board's transport surface (service-boundary contract, "Local web
 * board").
 *
 * The service's HTTP server serves the shared catalogue with `via: "web"` only
 * after a valid bearer token. That token is the operator's board gate, as the
 * Paseo bridge is for the plugin. Settings writes count as the Settings surface
 * only when the request is marked as coming from the web Settings screen
 * (`SETTINGS_SURFACE_HEADER`). Only a worker's own self-registration stays off the
 * web: `task.register` names the registering thread from its own shell.
 *
 * Dependency-free: shared modules load in the client bundle too.
 */

/** The transport value the HTTP server stamps on every catalogue call it serves. */
export const WEB_SURFACE = "web" as const;

/** Methods the web surface refuses even with a valid token. */
export const WEB_REFUSED_METHODS: ReadonlySet<string> = new Set([
  "task.register",
]);

/** The refusal for a method the web surface does not serve, or `null` when it is served. */
export function webSurfaceRefusal(method: string): string | null {
  if (!WEB_REFUSED_METHODS.has(method)) return null;
  return `${method} is refused over the web board: a worker registers itself from its own thread's shell. Nothing changed; do not retry over the web.`;
}

/**
 * The Settings-screen writes: every catalogue method the native Settings screen
 * calls to change a host-wide or repository setting, a backup, a
 * trusted-operator grant or an agent profile. Over the web they need the Settings
 * marker. Each name must be a mutating catalogue entry (test/web-board.test.ts).
 */
export const SETTINGS_WRITE_METHODS: ReadonlySet<string> = new Set([
  "queue.capacity",
  "queue.pool",
  "queue.profile",
  "queue.availability",
  "queue.demand-offsets",
  "queue.usage",
  "queue.project-dispatch-limit",
  "queue.routing-grant",
  "repository.set",
  "backup.now",
  "profile.create",
  "profile.update",
  "profile.remove",
]);

/**
 * The request header the web Settings screen sends with every Settings write. It is
 * transport provenance, like `via`, not an authorization claim: a token holder can
 * send it, which the contract states as accident prevention.
 */
export const SETTINGS_SURFACE_HEADER = "x-nucleus-surface";
export const SETTINGS_SURFACE_VALUE = "settings";

/**
 * The refusal for a Settings write that arrives over the web without the Settings
 * marker, or `null` when the request may proceed. Other web calls need only the token.
 */
export function webSettingsRefusal(
  method: string,
  marker: string | string[] | undefined,
): string | null {
  if (!SETTINGS_WRITE_METHODS.has(method) || marker === SETTINGS_SURFACE_VALUE)
    return null;
  return `${method} is a Settings write: the web board takes it only from the Settings screen, which marks its requests ${SETTINGS_SURFACE_HEADER}: ${SETTINGS_SURFACE_VALUE}. Nothing changed; do not retry from another web client.`;
}

/** Every transport surface a catalogue call may carry; a socket frame names only the bridge's. */
export type CatalogueSurface = "paseo" | typeof WEB_SURFACE;
