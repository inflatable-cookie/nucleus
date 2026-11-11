/** Admission for the configured work root and its optional volume identity. */
import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getWorkRoot, getWorkStorage, readWorkVolume } from "./work-root.mjs";
import { defaultDataDir } from "../../shared/service/default-data-dir";

/** Whether a path names the checkout volume or something under it. Anything else is just a path. */
export function onCheckoutVolume(path: string, mount: string = getWorkRoot()): boolean {
  return path === mount || path.startsWith(`${mount}${sep}`);
}

/** Private Queue data directories never select the live checkout roots. */
export function liveCheckoutDataDir(dataDir: string): string | null {
  let live: boolean;
  try { live = realpathSync(dataDir) === realpathSync(defaultDataDir()); }
  catch { live = resolve(dataDir) === resolve(defaultDataDir()); }
  return live ? join(getWorkRoot(), "queue") : null;
}

export interface CheckoutVolumeInfo {
  MountPoint?: string;
  VolumeUUID?: string;
  Internal?: boolean;
  Writable?: boolean;
  WritableVolume?: boolean;
}

/** diskutil's volume UUID is stable across device-node changes. */
export function readCheckoutVolume(mount: string): CheckoutVolumeInfo { return readWorkVolume(mount); }

/**
 * Prove the mount and every existing Queue root component before an effect.
 * Missing leaf components may be created only after this check. Call again at
 * each creation/registration boundary; failure must not be treated as absence.
 * The injected observer and mount are for private fixtures, never configuration.
 */
export function assertCheckoutAvailable(options: {
  mount?: string;
  uuid?: string;
  observe?: (mount: string) => CheckoutVolumeInfo;
  /** Fixture seam for the cached diskutil reader. */
  read?: (mount: string) => CheckoutVolumeInfo;
  /** Exact candidate; existing descendants must also be canonical on this volume. */
  target?: string;
} = {}): void {
  const mount = options.mount ?? getWorkRoot();
  try {
    const mountStat = proveWorkRoot(mount, options.uuid, options.observe, options.read);
    const components = [join(mount, "queue"), join(mount, "queue", "workspaces"), join(mount, "queue", "project-qa")];
    if (options.target) {
      const base = join(mount, "queue"), rel = relative(base, options.target);
      if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(options.target) !== options.target ||
          !["workspaces", "project-qa"].includes(rel.split(sep)[0])) throw new CheckoutRefusalError("target is outside Nucleus checkout roots");
      let path = base;
      for (const part of rel.split(sep)) { path = join(path, part); components.push(path); }
    }
    proveCheckoutComponents(mountStat, components);
  } catch (error) {
    throw checkoutUnavailable(error);
  }
}

/**
 * `diskutil` and `plutil` run synchronously, and every workspace preflight proves the
 * mount, so each dispatch blocked the service on two child processes (24-40% of its time
 * in a live profile, 2026-11-04). The volume's identity can't change while the mount point
 * stays the same directory, and `lstat` above re-reads that on every proof, so a disconnect
 * or remount still refuses at once. Only a successful read is kept, and only briefly.
 */
export const CHECKOUT_VOLUME_READ_TTL_MS = 30_000;
const cachedVolumes = new Map<string, { key: string; at: number; info: CheckoutVolumeInfo }>();
export function cachedCheckoutVolume(mount: string, stat: Pick<Stats, "dev" | "ino" | "birthtimeMs">, read: (mount: string) => CheckoutVolumeInfo, at = Date.now()): CheckoutVolumeInfo {
  const key = `${mount}\0${stat.dev}\0${stat.ino}\0${stat.birthtimeMs}`;
  const cachedVolume = cachedVolumes.get(mount);
  if (cachedVolume?.key === key && at >= cachedVolume.at && at - cachedVolume.at < CHECKOUT_VOLUME_READ_TTL_MS) return cachedVolume.info;
  cachedVolumes.delete(mount);
  const info = read(mount);
  cachedVolumes.set(mount, { key, at, info });
  return info;
}

/** The one mount proof: canonical root and, when pinned, writable volume with the expected identity. */
function proveWorkRoot(mount: string, uuid?: string, observe?: (mount: string) => CheckoutVolumeInfo, read = readCheckoutVolume): Stats {
  const configured = uuid || observe ? { root: mount, volumeId: undefined } : getWorkStorage();
  const expected = uuid ?? (mount === configured.root ? configured.volumeId : undefined);
  // An unpinned root is ordinary portable storage. Canonical and component checks
  // still apply, but no removable-volume identity is required.
  if (!expected && !observe) {
    let component = resolve(sep);
    for (const part of mount.split(sep).filter(Boolean)) {
      component = join(component, part);
      try {
        const current = lstatSync(component);
        if (current.isSymbolicLink() || !current.isDirectory() || realpathSync(component) !== component)
          throw new CheckoutRefusalError("work root ancestor is redirected or is not a directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(component, { mode: 0o700 });
      }
    }
  }
  const mountStat = lstatSync(mount);
  if (resolve(mount) !== mount || realpathSync(mount) !== mount || !mountStat.isDirectory())
    throw new CheckoutRefusalError("work root is redirected or is not a directory");
  accessSync(mount, constants.W_OK | constants.X_OK);
  if (!expected && !observe) return mountStat;
  const info = observe ? observe(mount) : cachedCheckoutVolume(mount, mountStat, read);
  if (info.MountPoint === mount && expected && info.VolumeUUID && info.VolumeUUID.toUpperCase() !== expected.toUpperCase())
    throw new CheckoutRefusalError("mounted volume identity does not match");
  if (info.MountPoint !== mount || !expected || info.VolumeUUID?.toUpperCase() !== expected.toUpperCase() ||
      info.Writable !== true || info.WritableVolume !== true)
    throw Error("mounted volume identity or writable status is unavailable");
  return mountStat;
}

/**
 * Every listed path that exists is a real directory on the mount's own device. A
 * missing leaf is allowed: callers create it only after this proof.
 */
function proveCheckoutComponents(mountStat: Stats, components: Iterable<string>): void {
  for (const component of new Set(components)) {
    try {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== mountStat.dev || realpathSync(component) !== component)
        throw new CheckoutRefusalError(`${component} is redirected or is not a directory`);
      accessSync(component, constants.W_OK | constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** A positively conflicting identity or unsafe path is not an outage wait. */
export class CheckoutRefusalError extends Error {
  constructor(detail: string) {
    super(`Queue checkout storage unavailable: ${detail}`);
    this.name = "CheckoutRefusalError";
  }
}
export class CheckoutUnavailableError extends Error {
  constructor(error: unknown) {
    super(`Queue checkout storage unavailable: ${error instanceof Error ? error.message : String(error)}`);
    this.name = "CheckoutUnavailableError";
  }
}
function checkoutUnavailable(error: unknown): Error {
  return error instanceof CheckoutUnavailableError || error instanceof CheckoutRefusalError ? error : new CheckoutUnavailableError(error);
}

/**
 * Queue #535 (papercut 5ac8ffb0): create one Queue-launched run's own temp
 * directory under the checkout scratch root, after proving the volume.
 *
 * `mkdir` is recursive, so on its own it happily creates a missing volume root
 * on the internal disk whenever the external volume is absent and hands the run a
 * temp root that is neither isolated nor on the scratch volume the operator's
 * rule names. Before anything is created, the mount's own identity (expected
 * UUID, external, writable) is proved and every level from the mount down to the
 * per-run directory is proved to be a real directory on that device, so a missing
 * intermediate level is checked level by level rather than skipped: a symlinked
 * ancestor cannot be traversed by recursive mkdir and then rejected afterwards.
 * The created directory is proved again afterwards, against the same device, so a
 * mount that is absent or vanishes mid-launch refuses the launch instead of
 * landing on the boot volume.
 */
export function createCheckoutScratchDirectory(input: {
  /** Absolute root Queue owns for run temp directories on the mount. */
  root: string;
  /** The exact per-run directory under `root` to create. */
  target: string;
  mount?: string;
  uuid?: string;
  observe?: (mount: string) => CheckoutVolumeInfo;
  /** Creation seam for private fixtures; the default is the owner-only recursive mkdir. */
  create?: (directory: string) => void;
  /** Run temp leaves are exclusive; their parent chain is admitted first. */
  exclusive?: boolean;
}): void {
  const mount = input.mount ?? getWorkRoot();
  try {
    const mountStat = proveWorkRoot(mount, input.uuid, input.observe);
    const inside = (base: string, path: string): boolean => {
      const rel = relative(base, path);
      return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && resolve(path) === path;
    };
    if (!inside(mount, input.root) || !inside(input.root, input.target))
      throw new CheckoutRefusalError("run temp directory is outside the checkout scratch root");
    // Every level from the proven mount down, not just the two endpoints: a
    // symlinked missing ancestor (`<mount>/scratch`, say) would otherwise only be
    // discovered by the post-check, after recursive mkdir had already created the
    // tree on its target.
    const components: string[] = [];
    let path = mount;
    for (const part of relative(mount, input.root).split(sep)) { path = join(path, part); components.push(path); }
    for (const part of relative(input.root, input.target).split(sep)) { path = join(path, part); components.push(path); }
    proveCheckoutComponents(mountStat, components);
    if (input.exclusive) {
      mkdirSync(dirname(input.target), { recursive: true, mode: 0o700 });
      (input.create ?? ((directory: string) => mkdirSync(directory, { mode: 0o700 })))(input.target);
    } else {
      const create = input.create ?? ((directory: string) => mkdirSync(directory, { recursive: true, mode: 0o700 }));
      create(input.target);
    }
    // Prove what was actually created, against the device proved above.
    const created = lstatSync(input.target);
    if (created.isSymbolicLink() || !created.isDirectory() || created.dev !== mountStat.dev || realpathSync(input.target) !== input.target)
      throw new CheckoutRefusalError(`${input.target} is redirected or is not a directory on the checkout volume`);
  } catch (error) {
    throw checkoutUnavailable(error);
  }
}

/**
 * Remove exactly one recorded run leaf; ambiguity leaves it untouched. A leaf off the
 * checkout volume is history from a drive Queue no longer uses: it is absent, so there
 * is nothing to clean up and nothing to wait for, and the drive is never probed.
 */
export function removeCheckoutRunScratchDirectory(input: {
  root: string; target: string; mount?: string; uuid?: string; observe?: (mount: string) => CheckoutVolumeInfo;
  log?: (message: string) => void;
}): boolean {
  const { root, target } = input;
  const log = input.log ?? (message => console.warn(message));
  let mountProved = false;
  try {
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || dirname(target) !== root || resolve(target) !== target || resolve(root) !== root)
      throw Error("recorded run temp path is not a direct child of the scratch root");
    const mount = input.mount ?? getWorkRoot();
    if (!onCheckoutVolume(target, mount)) return true;
    const mountStat = proveWorkRoot(mount, input.uuid, input.observe);
    mountProved = true;
    const components: string[] = [];
    let path = mount;
    for (const part of relative(mount, root).split(sep)) { path = join(path, part); components.push(path); }
    components.push(target);
    proveCheckoutComponents(mountStat, components);
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.dev !== mountStat.dev || realpathSync(root) !== root)
      throw Error("scratch root identity is uncertain");
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.dev !== mountStat.dev || realpathSync(target) !== target)
      throw Error("recorded run temp path is not a real directory");
    rmSync(target, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (mountProved && (error as NodeJS.ErrnoException).code === "ENOENT") return true;
    log(`Queue left run temp directory in place: ${target}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
