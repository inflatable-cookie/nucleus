// Discovery knows only the `nucleus` plugin ID (nucleus#971). A Paseo config
// that still names the retired `northstar-queue` ID is ignored, not migrated.
// Two nucleus registrations can create two bridges, even when they point at
// the same files, so never choose between them: more than one is a refusal.

/** The one registered Nucleus plugin, or null when no enabled registration exists. */
export function pluginRegistration(plugins = {}) {
  const registration = plugins?.nucleus;
  if (registration == null || registration?.enabled === false) return null;
  const path = registration?.path;
  if (typeof path !== 'string' || !path) throw Error('Paseo registration nucleus has no plugin path');
  return { id: 'nucleus', path };
}

/** The one plugin ID in Paseo's catalog; refuses when the Nucleus plugin is absent. */
export function pluginCatalogId(catalog) {
  const ids = catalog.map(plugin => plugin?.id).filter(id => id === 'nucleus');
  if (!ids.length) throw Error('No Nucleus plugin is available in Paseo');
  return ids[0];
}
