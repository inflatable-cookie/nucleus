import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const fail = message => { throw Error(message); };
const exists = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function primary(root) {
  const dot = join(root, '.git');
  const info = exists(dot);
  if (info?.isDirectory()) return null;
  if (!info?.isFile()) fail(`target is not a Git checkout: ${root}`);
  const pointer = readFileSync(dot, 'utf8').split(/\r?\n/).filter(line => line.trim().startsWith('gitdir:')).pop()?.trim().slice(7).trim();
  if (!pointer) fail('linked worktree .git file has no gitdir pointer');
  const gitDir = resolve(root, pointer);
  const commonFile = join(gitDir, 'commondir');
  const common = exists(commonFile) ? readFileSync(commonFile, 'utf8').trim() : gitDir;
  if (!common) fail('linked worktree commondir is empty');
  const path = realpathSync(resolve(gitDir, common));
  if (basename(path) !== '.git') fail(`cannot derive primary checkout from Git common directory: ${path}`);
  return dirname(path);
}
function records(root) {
  const path = join(root, '.effigy/local/dependency-links.json');
  if (!exists(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || data.schema !== 'effigy.deps.links.v1' || data.schema_version !== 1 || !Array.isArray(data.links)) fail('invalid Effigy dependency-link ledger');
  return data.links.map(({ key } = {}) => {
    if (!key || !['cargo', 'bun'].includes(key.manager) || typeof key.library_path !== 'string' || !key.library_path) fail('invalid Effigy dependency-link ledger record');
    return { manager: key.manager, source: key.library_path };
  });
}
export function worktree(action, extras, root = process.cwd()) {
  if (!['prepare', 'link', 'unlink'].includes(action) || (action !== 'prepare' && extras.length)) fail('usage: nucleus worktree <prepare [SOURCE[=LINK] ...]|link|unlink>');
  const primaryRoot = primary(root);
  const label = action === 'prepare' ? 'sibling preparation' : `Effigy dependency ${action}`;
  if (!primaryRoot) { console.log(`Paseo ${label}: skipped (primary checkout)`); return; }
  if (action === 'prepare') {
    const sources = new Map();
    for (const spec of [...records(primaryRoot).map(r => r.source), ...extras]) {
      const index = spec.indexOf('=');
      const raw = index < 0 ? spec : spec.slice(0, index);
      if (!raw) fail('sibling source cannot be empty');
      const source = realpathSync(isAbsolute(raw) ? raw : resolve(primaryRoot, raw));
      const name = (index < 0 ? '' : spec.slice(index + 1)) || basename(source);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) fail(`sibling link name must be one safe path component: ${name}`);
      if (sources.has(name) && sources.get(name) !== source) fail(`two sibling sources request the same link name \`${name}\``);
      sources.set(name, source);
    }
    const create = [];
    for (const [name, source] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const dest = join(dirname(root), name), info = exists(dest);
      if (info?.isSymbolicLink()) {
        const observed = realpathSync(dest);
        if (observed !== source) fail(`sibling link \`${dest}\` points to \`${observed}\`, expected \`${source}\``);
        console.log(`[nucleus:worktree] reuse ${dest} -> ${observed}`);
      } else if (info) fail(`sibling destination already exists and is not a symlink: ${dest}`);
      else create.push([dest, source]);
    }
    for (const [dest, source] of create) { symlinkSync(source, dest); console.log(`[nucleus:worktree] create ${dest} -> ${source}`); }
    console.log(`Paseo sibling preparation: OK (sources=${sources.size})`);
  } else {
    const links = records(action === 'link' ? primaryRoot : root);
    for (const record of links) {
      const result = spawnSync('effigy', ['--json', 'deps', action, record.manager, record.source], { cwd: root, encoding: 'utf8' });
      if (result.error || result.status !== 0) fail(`effigy deps ${action} failed: ${result.error?.message || result.stderr || result.stdout}`);
      const evidence = JSON.parse(result.stdout);
      const payload = evidence.result ?? evidence;
      if (payload.schema !== `effigy.deps.${action}.v1`) fail(`effigy deps ${action} returned unexpected evidence for ${record.source}`);
    }
    console.log(`Paseo Effigy dependency ${action}: OK (links=${links.length})`);
  }
}
