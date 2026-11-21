import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  paseoHome,
  paseoHomeOverride,
  paseoHomeEnvironment,
} from '../hosts/paseo/index.mjs';

/**
 * The host environment this install's own service reads, composed once for the
 * entrypoints that must not name a host: the standalone entry, the roll owner,
 * the service spawner and the installer's isolated startup proof.
 *
 * Each host integration names its own variables, and this module is the only
 * service path that asks one for them. `home` overrides the host home, so a
 * fixture or a proof can point a spawned service at a private config and never
 * at the operator's. When no Paseo home override is set and no Paseo config is
 * present, `hostEnvironment()` returns an empty object rather than synthesizing
 * Paseo environment variables.
 */
export function hostHome(env = process.env) {
  return paseoHome(env);
}

/** The configured host home override, or undefined when the operator set none. */
export function hostHomeOverride(env = process.env) {
  return paseoHomeOverride(env);
}

/** The host's own environment for a service started at `home`, or `{}` when no Paseo config is present. */
export function hostEnvironment(home) {
  if (home) return paseoHomeEnvironment(home);
  const override = paseoHomeOverride();
  if (override) return paseoHomeEnvironment(override);
  const resolved = paseoHome();
  return existsSync(join(resolved, 'config.json'))
    ? paseoHomeEnvironment(resolved)
    : {};
}
