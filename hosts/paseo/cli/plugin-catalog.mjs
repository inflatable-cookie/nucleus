// The one plugin ID in Paseo's catalog, read by the explicit `--via-paseo`
// bridge. Two nucleus registrations can create two bridges, so never choose
// between them: more than one ID is still the same plugin, and a catalog
// without it is a refusal.

/** The one plugin ID in Paseo's catalog; refuses when the Nucleus plugin is absent. */
export function pluginCatalogId(catalog) {
  const ids = catalog.map(plugin => plugin?.id).filter(id => id === 'nucleus');
  if (!ids.length) throw Error('No Nucleus plugin is available in Paseo');
  return ids[0];
}
