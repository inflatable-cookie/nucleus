// Discovery knows only the `nucleus` plugin ID (nucleus#971). A Paseo config
// that still names the retired `northstar-queue` ID is ignored, not migrated.
// Two nucleus registrations can create two bridges, even when they point at
// the same files, so never choose between them: more than one is a refusal.
//
// The forwarder (`hosts/paseo/plugin/bridge.ts`) and the service runtime both
// read this registration, and the folder gate lets neither reach the other's
// area, so it stays neutral here. The Paseo CLI's own catalog read is
// `hosts/paseo/cli/plugin-catalog.mjs`.

/** The one registered Nucleus plugin, or null when no enabled registration exists. */
export function pluginRegistration(plugins = {}) {
  const registration = plugins?.nucleus;
  if (registration == null || registration?.enabled === false) return null;
  const path = registration?.path;
  if (typeof path !== 'string' || !path) throw Error('Paseo registration nucleus has no plugin path');
  return { id: 'nucleus', path };
}
