#!/usr/bin/env node
/**
 * Spec 062, phase 5: the opt-in sidebar drift check.
 *
 * It fetches the pinned upstream commit (or the ref given), re-derives every hash
 * the vendored tree records, and reports what changed upstream since the pin, what
 * the pin no longer ships, whether `plugins/thread-list` is still on upstream's
 * forkable list, and whether the pinned release's SDK still covers the fork's
 * declared floor.
 *
 * It needs the network, so it never runs inside `effigy check`: it is the first
 * step of a planned rebase and the answer to "is the pin still what we forked".
 *
 *   effigy bb:sidebar-drift            # the recorded pin
 *   effigy bb:sidebar-drift desktop-v0.50.0   # a candidate release tag
 *
 * Exit 0 when the pin (or the named ref against the recorded pin) reports no drift
 * in a file the fork does not patch; 1 when it does, so CI or a planner sees it.
 * The clone lives under this run's TMPDIR and is removed afterwards.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'hosts/bb/plugin/sidebar/UPSTREAM.json'), 'utf8'));
const ref = process.argv[2] ?? manifest.tag;
const sha256 = body => createHash('sha256').update(body).digest('hex');
const repository = 'https://github.com/get-bb/bb';

const scratch = process.env.TMPDIR?.trim();
if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory()) {
  console.error('The run scratch volume is required: set TMPDIR to an existing directory');
  process.exit(2);
}

function git(argv, cwd) {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const work = mkdtempSync(join(scratch, 'bb-sidebar-drift-'));
let drift = false;
try {
  const checkout = join(work, 'bb');
  git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', ref, repository, checkout], work);
  const commit = git(['rev-parse', 'HEAD'], checkout);
  // A sparse clone in cone mode fetches only the trees this check reads.
  git(['sparse-checkout', 'init', '--cone'], checkout);
  git(['sparse-checkout', 'set', 'plugins/thread-list', 'scripts', 'packages/plugin-sdk', 'packages/plugin-registry'], checkout);
  git(['checkout', '--quiet', 'HEAD'], checkout);

  console.log(`Upstream ${ref} (${commit.slice(0, 12)}), recorded pin ${manifest.tag} (${manifest.commit.slice(0, 12)})`);
  if (commit !== manifest.commit) {
    console.log(`- the ref is not the recorded pin; every changed file below is a candidate for the rebase`);
  }

  // The release's SDK must still cover the fork's declared floor.
  const releaseSdk = JSON.parse(readFileSync(join(checkout, 'packages', 'plugin-sdk', 'package.json'), 'utf8')).version;
  const tuple = value => (value.match(/\d+\.\d+\.\d+/)?.[0] ?? '0.0.0').split('.').map(Number).join('.');
  const floorCovers = tuple(manifest.sdkFloor) <= tuple(releaseSdk);
  console.log(`${floorCovers ? 'ok  ' : 'FAIL'} SDK floor ${manifest.sdkFloor} ${floorCovers ? 'is covered by' : 'is above'} the release SDK ${releaseSdk}`);
  drift ||= !floorCovers;

  // Forkability: the list must still name the plugin.
  const forkable = JSON.parse(readFileSync(join(checkout, 'scripts', 'forkable-plugins.json'), 'utf8')).plugins;
  const listed = forkable.includes(manifest.forkable.entry);
  console.log(`${listed ? 'ok  ' : 'FAIL'} ${manifest.forkable.entry} ${listed ? 'is' : 'is no longer'} on upstream's forkable list`);
  drift ||= !listed;

  // Every vendored file: unchanged, patched (so expected to differ), or gone. The
  // plugin directory carries no LICENSE of its own, so that record compares with
  // the repository root's notice.
  const used = new Set(manifest.patched.concat(manifest.added));
  const upstreamRoot = join(checkout, 'plugins', 'thread-list');
  const changed = [];
  const missing = [];
  const sourceFor = path => {
    const vendored = path.replace('hosts/bb/plugin/sidebar/', '');
    return vendored === 'LICENSE' ? join(checkout, 'LICENSE') : join(upstreamRoot, vendored);
  };
  for (const [path, recorded] of Object.entries(manifest.pinFiles)) {
    if (!path.startsWith('hosts/bb/plugin/sidebar/')) continue;
    if (used.has(path)) continue;
    const source = sourceFor(path);
    if (!existsSync(source)) { missing.push(path.replace('hosts/bb/plugin/sidebar/', '')); continue; }
    if (sha256(readFileSync(source)) !== recorded) changed.push(path.replace('hosts/bb/plugin/sidebar/', ''));
  }

  // The registry modules the fork imports: upstream's items must still serve the
  // same file content, or the rebase has to move them.
  const registryDir = join(checkout, 'packages', 'plugin-registry', 'r');
  for (const name of manifest.registryItems) {
    const itemPath = join(registryDir, `${name}.json`);
    if (!existsSync(itemPath)) { missing.push(`registry item ${name}`); continue; }
    const item = JSON.parse(readFileSync(itemPath, 'utf8'));
    for (const file of item.files) {
      const recorded = manifest.pinFiles[join('hosts/bb/plugin', file.target)];
      if (recorded === undefined) { added.push(`registry target ${file.target}`); continue; }
      if (sha256(file.content) !== recorded) changed.push(`registry item ${name}: ${file.target}`);
    }
  }
  // Files upstream gained under the vendored trees.
  const added = [];
  const recordedUpstream = new Set(Object.keys(manifest.pinFiles).filter(path => path.startsWith('hosts/bb/plugin/sidebar/')));
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
  for (const dir of ['app', 'shared']) {
    const root = join(upstreamRoot, dir);
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      const vendored = `hosts/bb/plugin/sidebar/${relative(upstreamRoot, file)}`;
      if (!recordedUpstream.has(vendored)) added.push(vendored.replace('hosts/bb/plugin/sidebar/', ''));
    }
  }
  for (const path of ['app.tsx', 'server.ts', 'PLUGIN_OVERVIEW.md', 'app.test.tsx', 'sidebarRowRenders.test.tsx']) {
    if (!existsSync(join(upstreamRoot, path))) missing.push(path);
  }

  for (const path of changed) console.log(`- changed upstream: ${path}`);
  for (const path of missing) console.log(`- gone at the ref: ${path}`);
  for (const path of added) console.log(`+ new upstream file: ${path}`);
  if (changed.length + missing.length + added.length > 0) drift = true;
  if (!drift) console.log('No drift: every unpatched vendored file is byte-identical to the ref.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(drift ? 1 : 0);
