import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dataHome } from '../../shared/data-home.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const home = () => resolve(process.env.HOME || homedir());
const base = () => join(home(), '.local/share/nucleus');
const current = () => join(base(), 'current');
async function stat(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function atomicLink(target, path) {
  const temp = `${path}.${randomUUID()}`;
  await symlink(target, temp);
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}

// A deliberately small archive format: regular files/directories in ustar,
// with a complete SHA-256 inventory. Never pass untrusted paths to tar.
export function unpack(bytes) {
  let tar;
  try { tar = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 }); }
  catch { throw Error('Tarball is corrupt or too large; rebuild or download it again'); }
  const files = new Map();
  const seen = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(b => b === 0)) break;
    const str = (start, length) => h.subarray(start, start + length).toString().split('\0')[0];
    const number = (start, length) => parseInt(str(start, length).trim() || '0', 8);
    const checksum = [...h].reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== number(148, 8)) throw Error('Archive header is corrupt; rebuild or download the package again');
    const name = [str(345, 155), str(0, 100)].filter(Boolean).join('/').replace(/^\.\//, '').replace(/\/$/, '');
    if (name === '' || name === '.') { offset += 512; continue; }
    if (isAbsolute(name) || name.split('/').some(p => !p || p === '..' || p === '.') || name.includes('\\') || seen.has(name)) throw Error('Archive has an unsafe or repeated path; use a Nucleus runtime package');
    seen.add(name);
    const type = str(156, 1);
    const size = number(124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw Error('Archive is incomplete; download it again');
    if (type !== '5' && type !== '0' && type !== '') throw Error('Archive contains links or extended entries; rebuild with tar --format=ustar');
    if (type !== '5') files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.has('manifest.json')) throw Error('Package has no manifest.json; build a Nucleus runtime package');
  const manifest = JSON.parse(files.get('manifest.json').toString());
  if (manifest.format !== 'nucleus-package-v1' || !manifest.files || typeof manifest.files !== 'object') throw Error('Package manifest is invalid; rebuild the package');
  for (const [name, bytes] of files) {
    if (name !== 'manifest.json' && manifest.files[name] !== sha(bytes)) throw Error(`Package verification failed for ${name}; download it again`);
  }
  for (const name of Object.keys(manifest.files)) if (!files.has(name)) throw Error(`Package is missing ${name}; download it again`);
  // `nucleus` is the only skill a package ships (nucleus#1049); a package that
  // still carries the retired alias is only ever an older, verified version.
  for (const required of ['build.json', 'runtime/node', 'bin/nucleus.mjs', 'bin/queue-cli.mjs', 'skills/nucleus/SKILL.md']) if (!files.has(required)) throw Error(`Package is missing ${required}; rebuild it`);
  const build = JSON.parse(files.get('build.json').toString());
  if (build.platform !== process.platform || build.arch !== process.arch) throw Error('Package is for another platform; download the package for this machine');
  if (!/^[a-f0-9]{40}$/.test(build.revision)) throw Error('Package revision is invalid; rebuild it');
  return { files, build, digest: sha(bytes) };
}

async function download(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) throw Error('Use HTTPS for a release, or a loopback fixture server');
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok) throw Error(`Download failed (${response.status}); check the release URL and try again`);
  return Buffer.from(await response.arrayBuffer());
}
async function sourceBytes(source, expected) {
  if (!source) throw Error('Pass a local tarball, release manifest URL, or owner/repository@tag to nucleus install');
  let url = source;
  if (!/^https?:/.test(source) && !await stat(resolve(source))) {
    const match = /^([\w.-]+\/[\w.-]+)@([\w.-]+)$/.exec(source);
    if (!match) throw Error('Package was not found; pass a tarball path or owner/repository@tag');
    // GitHub redirects release assets to its download host. Resolve via the API.
    const release = JSON.parse((await download(`https://api.github.com/repos/${match[1]}/releases/tags/${match[2]}`)).toString());
    const name = `nucleus-${process.platform}-${process.arch}.json`;
    const asset = release.assets?.find(a => a.name === name);
    if (!asset) throw Error(`Release has no ${name}; choose a release for this platform`);
    url = asset.browser_download_url;
  }
  let bytes;
  if (/^https?:/.test(url)) {
    const manifest = JSON.parse((await downloadRelease(url)).toString());
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.url !== 'string') throw Error('Release manifest needs url and sha256; choose a verified release');
    expected = manifest.sha256;
    bytes = await downloadRelease(new URL(manifest.url, url).href);
  } else bytes = await readFile(resolve(source));
  if (expected && sha(bytes) !== expected) throw Error('Tarball checksum does not match; download it again');
  return bytes;
}
// Permit only verified HTTPS redirects (GitHub's normal asset delivery path).
async function downloadRelease(url) {
  for (let hops = 0; hops < 6; hops++) {
    try { return await download(url); } catch (error) {
      // Inspect redirects explicitly so a release cannot redirect to a local service.
      const u = new URL(url);
      if (u.protocol !== 'https:') throw error;
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if (r.status < 300 || r.status >= 400 || !r.headers.get('location')) throw error;
      const next = new URL(r.headers.get('location'), url);
      if (next.protocol !== 'https:') throw Error('Release redirected to an insecure address; choose a trusted release');
      url = next.href;
    }
  }
  throw Error('Too many release redirects; check the release URL');
}

const launcher = '#!/bin/sh\n# nucleus-owned-command-v1\nroot="$HOME/.local/share/nucleus/current"\nexec "$root/runtime/node" "$root/bin/nucleus.mjs" "$@"\n';
const retiredSkillName = 'northstar-queue';
async function prepareEntrypoints(created) {
  const command = join(home(), '.local/bin/nucleus');
  await mkdir(dirname(command), { recursive: true });
  if (await stat(command)) {
    if (await readFile(command, 'utf8') !== launcher) throw Error(`Command collision at ${command}; move the existing command before installing`);
  } else { await writeFile(command, launcher, { mode: 0o755, flag: 'wx' }); created.push(command); }
  const roots = [join(home(), '.agents/skills')];
  for (const app of ['.codex', '.claude']) if (await stat(join(home(), app))) roots.push(join(home(), app, 'skills'));
  roots.push(...(process.env.NUCLEUS_SKILL_DIRS || '').split(delimiter).filter(Boolean).map(p => resolve(p)));
  // `nucleus` is the only skill name this installer links (nucleus#1049). The
  // link follows `current`; a nucleus link left over from a package predating
  // skills/nucleus (the retired compat-skills alias) is repointed, and anything
  // else unowned is still a collision.
  const retiredAliasDir = join(base(), 'compat-skills/nucleus');
  // A repoint or a removal replaces pre-existing state, so a failure after it
  // must put that state back: a failed install leaves the prior links active.
  // The replacement itself is atomic: the old link stays until the rename
  // lands. Fresh links are tracked in created for the caller to remove.
  const repointed = [];
  const removed = [];
  try {
    for (const root of new Set(roots)) {
      await mkdir(root, { recursive: true });
      await removeRetiredSkillLink(join(root, retiredSkillName), removed);
      const path = join(root, 'nucleus');
      const target = join(current(), 'skills/nucleus');
      const existing = await stat(path);
      if (existing) {
        const link = existing.isSymbolicLink() ? await readlink(path) : null;
        if (link === target) continue;
        if (link === retiredAliasDir) {
          const temp = `${path}.${randomUUID()}`;
          await symlink(target, temp);
          try { await rename(temp, path); }
          catch (e) { await rm(temp, { force: true }); throw e; }
          repointed.push({ path, previous: link });
          continue;
        }
        throw Error(`Skill collision at ${path}; move that skill or choose another skill folder`);
      } else { await symlink(target, path); created.push(path); }
    }
  } catch (e) {
    await restoreRepoints(repointed);
    await restoreRemovals(removed);
    throw e;
  }
  return { repointed, removed };
}
// A `northstar-queue` entry that resolves inside the Nucleus install is this
// installer's own leftover from a package that shipped the retired alias, so
// install and roll remove it. Any entry of that name that points anywhere else
// belongs to the operator, so it is left exactly as it is.
async function removeRetiredSkillLink(path, removed) {
  const existing = await stat(path);
  if (!existing?.isSymbolicLink()) return;
  const link = await readlink(path);
  const owned = candidate => candidate === base() || candidate.startsWith(base() + sep);
  let inside = owned(resolve(dirname(path), link));
  if (!inside) { try { inside = owned(await realpath(resolve(dirname(path), link))); } catch {} }
  if (!inside) return;
  await rm(path);
  removed.push({ path, link });
}
async function restoreRemovals(removed) {
  for (const { path, link } of removed.reverse()) {
    try { await rm(path, { force: true }); await symlink(link, path); } catch {}
  }
}
async function restoreRepoints(repointed) {
  for (const { path, previous } of repointed.reverse()) {
    try { await rm(path); await symlink(previous, path); } catch {}
  }
}
export async function install(source, expected, { activate = true } = {}) {
  const { files, build, digest } = unpack(await sourceBytes(source, expected));
  const packageVersion = JSON.parse(files.get('package.json')).version;
  if (typeof packageVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(packageVersion)) throw Error('Package version is invalid; rebuild the package');
  const versions = join(base(), 'versions');
  await mkdir(versions, { recursive: true });
  const stage = await mkdtemp(join(versions, '.stage-'));
  const destination = join(versions, `${packageVersion}-${build.revision}-${digest}`);
  try {
    for (const [name, bytes] of files) {
      const path = join(stage, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: name === 'runtime/node' ? 0o755 : 0o644 });
    }
    // A version is never rewritten. Verify an existing version before reusing it.
    if (await stat(destination)) {
      for (const [name, bytes] of files) if (sha(await readFile(join(destination, name))) !== sha(bytes)) throw Error(`Installed version was changed at ${destination}; inspect it before reinstalling`);
    } else await rename(stage, destination);
    if (!activate) return { root: destination, ...build };
    await activateVersion(destination);
    return await version();
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function version() {
  const root = await realpath(current());
  const build = await json(join(root, 'build.json')).catch(() => null);
  const pkg = await json(join(root, 'package.json'));
  const configured = await json(join(base(), 'channel.json')).catch(() => null);
  return { version: pkg.version, revision: build?.revision || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), channel: root.startsWith(join(base(), 'versions') + '/') ? (configured?.channel === 'main' ? 'main' : 'release') : 'development', dataHome: dataHome() };
}
export async function integrate(host) {
  if (host !== 'paseo') throw Error('Supported integration: paseo. Run nucleus integrate paseo');
  await realpath(current());
  const path = join(process.env.PASEO_HOME || join(home(), '.paseo'), 'config.json');
  const config = await stat(path) ? await json(path) : {};
  config.plugins ??= {};
  // Registration knows only `nucleus` (nucleus#971): a config that still names
  // the retired `northstar-queue` ID is ignored, not migrated or removed, and an
  // existing nucleus registration is always an explicit review before replace.
  if (config.plugins.nucleus) throw Error(`Paseo already registers nucleus at ${config.plugins.nucleus.path}; review that registration before replacing it`);
  const target = current();
  config.plugins.nucleus = { path: target };
  await mkdir(dirname(path), { recursive: true });
  writeOwnedJson(path, config);
  return { host, path, plugin: target, next: 'Registration saved. Reload the plugin when you are ready.' };
}

// Only verified, immutable versions may enter the installed roll path.
export async function verifyVersion(root) {
  root = await realpath(root);
  if (dirname(root) !== join(base(), 'versions')) throw Error('Choose a staged Nucleus version');
  const manifest = await json(join(root, 'manifest.json'));
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (isAbsolute(name) || name.split('/').some(p => !p || p === '..' || p === '.')) throw Error('Unsafe installed manifest');
    if (sha(await readFile(join(root, name))) !== digest) throw Error(`Installed version changed: ${name}`);
  }
  return { root, ...await json(join(root, 'build.json')) };
}
export async function activateVersion(root) {
  const verified = await verifyVersion(root);
  root = verified.root;
  // Entrypoints follow `current`, so install, roll, rollback and recover-previous
  // all converge the CLI launcher and skill links here. Prepare before switching
  // the pointer: a failed prepare leaves the prior current in place.
  const created = [];
  let prepared = { repointed: [], removed: [] };
  try {
    prepared = await prepareEntrypoints(created);
    const previous = await realpath(current()).catch(() => null);
    if (previous && previous !== root) await atomicLink(previous, join(base(), 'previous'));
    await atomicLink(root, current());
  } catch (e) {
    await restoreRepoints(prepared.repointed);
    await restoreRemovals(prepared.removed);
    for (const path of created.reverse()) await rm(path, { force: true });
    throw e;
  }
}
export const installBase = base;

// Emergency recovery when the plugin cannot start its normal roll owner.
export async function recoverPrevious() {
  const prior = await verifyVersion(join(base(), 'previous'));
  const active = await verifyVersion(current());
  if (prior.root === active.root) throw Error('Previous version is already current');
  if (await stat(join(base(), 'activation.json'))) throw Error('A roll is in progress; settle it before recovery');
  const configPath = join(base(), 'channel.json');
  const config = await json(configPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (config?.channel === 'main') {
    writeOwnedJson(configPath, { ...config, rollback: undefined, ignoredRevision: active.revision });
  }
  await activateVersion(prior.root);
  return { revision: prior.revision, next: 'Run paseo plugin reload nucleus' };
}
