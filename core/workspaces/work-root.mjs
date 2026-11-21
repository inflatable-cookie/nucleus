import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { dataHome } from '../../shared/data-home.mjs';
import { writeOwnedJson } from '../machine/owned-file.mjs';

/**
 * The work-volume placement owner (service-boundary contract, "Work placement").
 *
 * Every class Nucleus writes on the work volume is one setting: the work root,
 * local task worktrees, database backups, legacy milestone QA history, run
 * scratch and Barge custodian records. Each class has a portable default derived
 * from `workRoot` and its own environment override, and every one resolves through
 * the same guard (`validSubpathInsideMount`): canonical, absolute, strictly inside
 * `workRoot`, never `/`. Nothing here names a machine or a drive.
 *
 * An install that still has data in the retired `<workRoot>/queue/...` locations
 * keeps working: `retiredWorkPlacement` names those paths so readers can find
 * existing data, and nothing here writes to them.
 *
 * `test/work-root-settings.test.ts` proves the defaults, overrides and refusals;
 * `test/storage-placement.test.ts` proves the Storage page's write path.
 */
const CLASSES = [
  // Projects the class default, its settings key and environment override, and
  // the retired `queue/...` location an existing install may still hold.
  { field: 'worktreesRoot', setting: 'localWorkspaceRoot', env: 'NUCLEUS_LOCAL_WORKSPACE_ROOT', defaultParts: ['worktrees', 'nucleus'], retiredParts: ['queue', 'workspaces'] },
  { field: 'backupRoot', setting: 'backupRoot', env: 'NUCLEUS_BACKUP_ROOT', defaultParts: ['archives', 'nucleus-backups'], retiredParts: ['queue', 'backups'] },
  { field: 'projectQaRoot', setting: 'projectQaRoot', env: 'NUCLEUS_PROJECT_QA_ROOT', defaultParts: ['archives', 'nucleus-project-qa'], retiredParts: ['queue', 'project-qa'] },
  { field: 'scratchRoot', setting: 'scratchRoot', env: 'NUCLEUS_SCRATCH_ROOT', defaultParts: ['scratch', 'nucleus'] },
  // Custodian control files carry one lease's live start/stop handshake, so they
  // belong to the scratch class rather than the archive one.
  { field: 'custodianRoot', setting: 'custodianRoot', env: 'NUCLEUS_CUSTODIAN_ROOT', defaultParts: ['scratch', 'nucleus', 'barge-custodians'], retiredParts: ['queue', 'barge-custodians'] },
];
/** Every placement setting that holds one path. */
export const WORK_PLACEMENT_SETTINGS = [...new Set(CLASSES.map(entry => entry.setting))];

const portableRoots = new Set();
const refusal = message => Object.assign(Error(message), { code: 'WORK_PLACEMENT_REFUSAL' });
const settingsFor = dataDir => {
  const path = join(dataDir, 'settings.json');
  const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal('Work storage settings must be an object');
  for (const key of ['workRoot', 'workVolumeId', ...WORK_PLACEMENT_SETTINGS]) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw refusal(`${key} must be a string`);
  }
  if (value.retainedWorkspaceRoots !== undefined &&
      (!Array.isArray(value.retainedWorkspaceRoots) || value.retainedWorkspaceRoots.some(item => typeof item !== 'string'))) {
    throw refusal('retainedWorkspaceRoots must be an array of strings');
  }
  return { path, value };
};
const validMount = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || resolve(value) !== value)
    throw refusal('workRoot must be a canonical absolute directory');
  return value;
};
export function validSubpathInsideMount(mount, value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || resolve(value) !== value)
    throw refusal(`${label} must be a canonical absolute directory`);
  const rel = relative(mount, value);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw refusal(`${label} must be inside workRoot (${mount})`);
  return value;
}

const storageFrom = (value, dataDir, env) => {
  const root = env.NUCLEUS_WORK_ROOT?.trim() || value.workRoot;
  const volumeId = env.NUCLEUS_WORK_VOLUME_ID?.trim() || value.workVolumeId;
  return { root: root ? validMount(root) : join(resolve(dataDir), 'work'),
    ...(volumeId ? { volumeId: String(volumeId) } : {}) };
};

/** Read only. Startup completes adoption before any allocation or migration backup. */
export function getWorkStorage(dataDir = dataHome(), env = process.env) {
  const { value } = settingsFor(dataDir);
  const storage = storageFrom(value, dataDir, env);
  const portable = join(resolve(dataDir), 'work');
  const root = env.NUCLEUS_WORK_ROOT?.trim() || value.workRoot;
  const volumeId = env.NUCLEUS_WORK_VOLUME_ID?.trim() || value.workVolumeId;
  if (!root && !volumeId && !portableRoots.has(resolve(dataDir))) {
    const roots = recordedWorkRoots(existingAllocations(dataDir));
    if (roots.some(recorded => recorded !== portable))
      throw Error('Existing work records require startup adoption before storage can be selected');
    portableRoots.add(resolve(dataDir));
  }
  return storage;
}
export const getWorkRoot = (dataDir, env) => getWorkStorage(dataDir, env).root;

/** The portable class defaults a fresh install uses, each derived from the work root. */
export function defaultWorkPlacement(root) {
  return Object.fromEntries(CLASSES.map(entry => [entry.field, join(root, ...entry.defaultParts)]));
}

/** The retired `<workRoot>/queue/...` locations existing data may still live in. */
export function retiredWorkPlacement(root) {
  return Object.fromEntries(CLASSES.filter(entry => entry.retiredParts)
    .map(entry => [entry.field, join(root, ...entry.retiredParts)]));
}

const classEntry = field => {
  const entry = CLASSES.find(candidate => candidate.field === field);
  if (!entry) throw refusal(`Unknown work placement class ${field}`);
  return entry;
};

/** One class's path: its environment override, else its setting, else its portable default. */
const resolveClass = (entry, value, storage, env) => {
  const fromEnv = env[entry.env]?.trim();
  const configured = fromEnv || value[entry.setting];
  if (!configured) return join(storage.root, ...entry.defaultParts);
  return validSubpathInsideMount(storage.root, configured, fromEnv ? entry.env : entry.setting);
};

/**
 * One class's resolved path without validating the classes a caller does not use.
 * The backup worker reads the live store's own location this way, so a fixture
 * that names a different work root for its own writes cannot make that read
 * refuse over an unrelated class path.
 */
export function getWorkClassPath(field, dataDir = dataHome(), env = process.env) {
  const entry = classEntry(field);
  return resolveClass(entry, settingsFor(dataDir).value, getWorkStorage(dataDir, env), env);
}

/** One class's retired `queue/...` location, or null when the class never lived there. */
export function getRetiredWorkClassPath(field, dataDir = dataHome(), env = process.env) {
  const entry = classEntry(field);
  return entry.retiredParts ? join(getWorkStorage(dataDir, env).root, ...entry.retiredParts) : null;
}

function placementFrom(value, storage, env) {
  const defaults = defaultWorkPlacement(storage.root);
  const retired = retiredWorkPlacement(storage.root);
  const resolved = {}, overrides = {};
  for (const entry of CLASSES) {
    const path = resolveClass(entry, value, storage, env);
    resolved[entry.field] = path;
    if (path !== defaults[entry.field]) overrides[entry.field] = path;
  }
  const retained = new Set();
  // A task workspace allocated before this class moved is still supported for
  // continuation and cleanup, so the retired root is always retained while it is
  // not the active one.
  if (retired.worktreesRoot && resolved.worktreesRoot !== retired.worktreesRoot) retained.add(retired.worktreesRoot);
  const retainedOverride = env.NUCLEUS_RETAINED_WORKSPACE_ROOTS?.trim();
  const configuredRetained = retainedOverride
    ? retainedOverride.split(delimiter).map(entry => validSubpathInsideMount(storage.root, entry, 'NUCLEUS_RETAINED_WORKSPACE_ROOTS'))
    : (value.retainedWorkspaceRoots ?? []).map(entry => validSubpathInsideMount(storage.root, entry, 'retainedWorkspaceRoots'));
  for (const entry of configuredRetained) {
    if (entry !== resolved.worktreesRoot) retained.add(entry);
  }
  return {
    workRoot: storage.root,
    ...(storage.volumeId ? { volumeId: storage.volumeId } : {}),
    ...resolved,
    defaults,
    retired,
    overrides,
    retainedRoots: [...retained],
  };
}

/**
 * Every work-volume location Nucleus writes, resolved from `settings.json` and the
 * environment. A configured path is refused here, at startup and at every read,
 * when it is not canonical, not absolute or not strictly inside `workRoot`.
 */
export function getWorkPlacement(dataDir = dataHome(), env = process.env) {
  return placementFrom(settingsFor(dataDir).value, getWorkStorage(dataDir, env), env);
}

/** The local task-workspace roots, as the allocation, resume and cleanup paths read them. */
export function getLocalWorkspacePlacement(dataDir = dataHome(), env = process.env) {
  const placement = getWorkPlacement(dataDir, env);
  return {
    workRoot: placement.workRoot,
    ...(placement.volumeId ? { volumeId: placement.volumeId } : {}),
    activeRoot: placement.worktreesRoot,
    defaultRoot: placement.defaults.worktreesRoot,
    retainedRoots: placement.retainedRoots,
  };
}

/**
 * The settings one Storage save would persist. `undefined` leaves a class alone,
 * and `null` or `''` clears its override so the portable default applies again.
 */
export function mergedWorkSettings(dataDir, update = {}) {
  const { value } = settingsFor(dataDir);
  const next = { ...value };
  const assign = (setting, candidate) => {
    if (candidate === undefined) return;
    if (candidate === null || candidate === '') { delete next[setting]; return; }
    if (typeof candidate !== 'string') throw refusal(`${setting} must be a string`);
    next[setting] = candidate;
  };
  assign('workRoot', update.workRoot);
  assign('workVolumeId', update.workVolumeId);
  for (const entry of CLASSES) assign(entry.setting, update[entry.field]);
  return next;
}

/** Resolve an unsaved candidate placement, so a refusal names the field before anything is written. */
export function previewWorkPlacement(update = {}, dataDir = dataHome(), env = process.env) {
  const value = mergedWorkSettings(dataDir, update);
  return placementFrom(value, storageFrom(value, dataDir, env), env);
}

/** Persist a validated candidate; the caller proves the volume and paths first. */
export function writeWorkSettings(dataDir, update = {}) {
  const { path } = settingsFor(dataDir);
  const next = mergedWorkSettings(dataDir, update);
  writeOwnedJson(path, next);
  return next;
}

/** Observe the volume mounted at a root without creating that root. */
export function readWorkVolume(root) {
  const plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', root], { timeout: 10_000 });
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
    { input: plist, encoding: 'utf8', timeout: 10_000 }));
}

// Match only allocation fields, never prose, repository paths or arbitrary strings.
const allocationFields = new Set(['directory', 'temporaryDirectory', 'workspaceDirectory', 'checkoutPath', 'backupDir', 'backupDirectory', 'scratchRoot']);
export function recordedWorkRoots(records) {
  const roots = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (allocationFields.has(key) && typeof child === 'string' && isAbsolute(child)) {
        // Every class's current and retired shape, so an install whose settings
        // were lost still adopts the volume its records name.
        const match = child.match(/^(.+)(?:\/(?:queue|archives)\/(?:workspaces|project-qa|backups|barge-custodians|nucleus-backups|nucleus-project-qa)(?:\/|$)|\/worktrees\/nucleus(?:\/|$)|\/scratch\/[^/]+(?:\/|$))/);
        if (match) roots.add(validMount(match[1]));
      } else if (typeof child === 'object') visit(child);
    }
  }
  for (const record of records) visit(record);
  return [...roots].sort();
}

/** Read the previous store without instantiating Store or performing migrations. */
function existingAllocations(dataDir) {
  const current = [settingsFor(dataDir).value];
  const status = join(dataDir, 'backup-status.json');
  if (existsSync(status)) current.push(JSON.parse(readFileSync(status, 'utf8')));
  const path = join(dataDir, 'queue.sqlite');
  if (!existsSync(path)) return current;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const retained = [];
    for (const table of ['tasks', 'runs', 'project_qa_runs', 'outcomes']) {
      if (!tables.has(table)) continue;
      for (const row of database.prepare(`SELECT data FROM ${table}`).iterate()) {
        const record = JSON.parse(row.data);
        retained.push(record);
        // Current allocations select the roll's root; disposed/finished history
        // on retired storage cannot pull a live install back to that storage.
        const active = table === 'tasks' ? !record.removedAt && !['done', 'cancelled'].includes(record.phase)
          : table === 'runs' ? !record.released && ['intent', 'running', 'uncertain', 'stopped'].includes(record.status)
          : table === 'project_qa_runs' ? !record.finishedAt && ['queued', 'running', 'hold'].includes(record.state) : false;
        if (active) current.push(record);
      }
    }
    if (tables.has('meta')) {
      for (const row of database.prepare('SELECT key, value FROM meta').iterate()) retained.push({ [row.key]: JSON.parse(row.value) });
    }
    return recordedWorkRoots(current).length ? current : [...current, ...retained];
  } finally { database.close(); }
}

/** One-time adoption refuses rather than falling back while its volume is absent. */
export function initializeWorkRoot(dataDir, env = process.env, options = {}) {
  const settings = settingsFor(dataDir);
  if (env.NUCLEUS_WORK_ROOT?.trim() || env.NUCLEUS_WORK_VOLUME_ID?.trim() || settings.value.workRoot || settings.value.workVolumeId) {
    const storage = getWorkStorage(dataDir, env);
    // Every class's path is validated once at startup, before any write.
    getLocalWorkspacePlacement(dataDir, env);
    return storage;
  }
  const roots = recordedWorkRoots(options.records ?? existingAllocations(dataDir));
  if (roots.length > 1) throw Error('Recorded allocations name different work roots; set workRoot explicitly');
  const portable = join(resolve(dataDir), 'work');
  if (!roots.length || (roots.length === 1 && roots[0] === portable)) {
    portableRoots.add(resolve(dataDir));
    getLocalWorkspacePlacement(dataDir, env);
    return { root: portable };
  }
  const root = roots[0];
  const volume = (options.observe ?? readWorkVolume)(root);
  if (volume.MountPoint !== root || typeof volume.VolumeUUID !== 'string' || !volume.VolumeUUID || volume.Internal !== false || volume.Writable !== true || volume.WritableVolume !== true)
    throw Error('Recorded work root is not an available writable external volume; adoption refused');
  writeOwnedJson(settings.path, { ...settings.value, workRoot: root, workVolumeId: volume.VolumeUUID });
  const storage = getWorkStorage(dataDir, env);
  getLocalWorkspacePlacement(dataDir, env);
  return storage;
}
