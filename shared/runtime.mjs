// The package builder replaces this literal, never an environment variable.
export const compiledIdentity = null;
// A path handed to a thread outlives this version: retained threads keep it across
// rolls, and a roll prunes old versions, so launches name the stable link instead.
export const stableInstalledPath = path => path.replace(/\/versions\/[^/]+\//, '/current/');
export const runtimeNodeArgs = () => compiledIdentity ? [] : ['--import', 'tsx'];
export const runtimeEntry = path => compiledIdentity ? path.replace(/\.ts$/, '.mjs') : path;
