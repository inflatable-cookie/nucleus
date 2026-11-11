import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { dataHome } from '../../shared/data-home.mjs';
import { writeOwnedJson } from '../machine/owned-file.mjs';

const portableRoots = new Set();
const settingsFor = dataDir => {
  const path = join(dataDir, 'settings.json');
  const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Work storage settings must be an object');
  for (const key of ['workRoot', 'workVolumeId']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw Error(`${key} must be a string`);
  }
  return { path, value };
};
const validMount = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || resolve(value) !== value)
    throw Error('workRoot must be a canonical absolute directory');
  return value;
};

/** Read only. Startup completes adoption before any allocation or migration backup. */
export function getWorkStorage(dataDir = dataHome(), env = process.env) {
  const { value } = settingsFor(dataDir);
  const override = env.NUCLEUS_WORK_ROOT?.trim();
  const root = override || value.workRoot;
  const volumeId = env.NUCLEUS_WORK_VOLUME_ID?.trim() || value.workVolumeId;
  const portable = join(resolve(dataDir), 'work');
  if (!root && !volumeId && !portableRoots.has(resolve(dataDir))) {
    const roots = recordedWorkRoots(existingAllocations(dataDir));
    if (roots.some(recorded => recorded !== portable))
      throw Error('Existing work records require startup adoption before storage can be selected');
    portableRoots.add(resolve(dataDir));
  }
  return { root: root ? validMount(root) : portable,
    ...(volumeId ? { volumeId: String(volumeId) } : {}) };
}
export const getWorkRoot = (dataDir, env) => getWorkStorage(dataDir, env).root;

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
        const match = child.match(/^(.+)(?:\/queue\/(?:workspaces|project-qa|backups)(?:\/|$)|\/scratch\/[^/]+(?:\/|$))/);
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
  if (env.NUCLEUS_WORK_ROOT?.trim() || env.NUCLEUS_WORK_VOLUME_ID?.trim() || settings.value.workRoot || settings.value.workVolumeId)
    return getWorkStorage(dataDir, env);
  const roots = recordedWorkRoots(options.records ?? existingAllocations(dataDir));
  if (roots.length > 1) throw Error('Recorded allocations name different work roots; set workRoot explicitly');
  const portable = join(resolve(dataDir), 'work');
  if (!roots.length || (roots.length === 1 && roots[0] === portable)) {
    portableRoots.add(resolve(dataDir));
    return { root: portable };
  }
  const root = roots[0];
  const volume = (options.observe ?? readWorkVolume)(root);
  if (volume.MountPoint !== root || typeof volume.VolumeUUID !== 'string' || !volume.VolumeUUID || volume.Internal !== false || volume.Writable !== true || volume.WritableVolume !== true)
    throw Error('Recorded work root is not an available writable external volume; adoption refused');
  writeOwnedJson(settings.path, { ...settings.value, workRoot: root, workVolumeId: volume.VolumeUUID });
  return getWorkStorage(dataDir, env);
}
