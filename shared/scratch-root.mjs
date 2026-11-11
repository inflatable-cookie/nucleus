import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Local scratch is explicit: an unavailable configured root has no fallback. */
export function configuredScratchRoot(env = process.env) {
  const value = env.NUCLEUS_SCRATCH_ROOT;
  if (!value || !isAbsolute(value)) throw Error('Set NUCLEUS_SCRATCH_ROOT to an existing absolute scratch directory');
  const root = resolve(value);
  if (realpathSync(root) !== root || !statSync(root).isDirectory()) throw Error('Configured scratch root must be a real directory');
  return root;
}

/** Prove an existing scratch directory without following a redirected ancestor. */
export function scratchDirectory(directory, env = process.env) {
  const root = configuredScratchRoot(env);
  if (!directory || !isAbsolute(directory)) throw Error('Choose an existing directory under NUCLEUS_SCRATCH_ROOT');
  const canonical = realpathSync(directory);
  const rel = relative(root, canonical);
  if (canonical !== resolve(directory) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(canonical).isDirectory())
    throw Error('Scratch directory is outside NUCLEUS_SCRATCH_ROOT or redirected');
  return canonical;
}
