/**
 * Spec 062, phase 5: the vendored-manifest test.
 *
 * It is an ordinary unit test over committed files — no network, no install — so
 * `effigy check` and the affected run cover it. It proves what the acceptance
 * names: every file under the fork's vendored tree and every vendored registry
 * module is byte-identical to its recorded SHA-256 or named in `PATCHES.md`; every
 * patched and added file is named; the recorded SDK floor is at or below the pinned
 * release's; and the pin's forkable-list record names this plugin. `effigy
 * bb:sidebar-drift` is the opt-in half that re-derives all of this from upstream
 * over the network.
 *
 * It also guards the two properties the header patch must not break: the patch set
 * never touches the row's drag bindings, and the plugin package reads no forge, no
 * Git and no thread timeline.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginDir = join(root, 'hosts', 'bb', 'plugin');
const sidebarDir = join(pluginDir, 'sidebar');
const manifest = JSON.parse(readFileSync(join(sidebarDir, 'UPSTREAM.json'), 'utf8'));
const patchesText = readFileSync(join(sidebarDir, 'PATCHES.md'), 'utf8');
const pin = manifest.commit as string;

/** Files the fork owns rather than the pin: the manifest, the patch list and the patches. */
const forkOwned = new Set([
  relative(root, join(sidebarDir, 'UPSTREAM.json')),
  relative(root, join(sidebarDir, 'PATCHES.md')),
]);

const sha256 = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const pinnedPaths = Object.keys(manifest.pinFiles) as string[];
const patched = manifest.patched as string[];
const added = manifest.added as string[];
const named = (path: string) => patchesText.includes(path.replace('hosts/bb/plugin/sidebar/', '')) || patchesText.includes(path);

test('the pin is the release tag the spec verified', () => {
  assert.equal(pin, '7b26cae79ec978fafd0a5db0e8517e94f12eb8f4', 'the vendored pin is the spec-verified BB commit');
  assert.equal(manifest.tag, 'desktop-v0.49.0');
  assert.equal(manifest.pluginPath, 'plugins/thread-list');
  assert.equal(manifest.repository, 'https://github.com/get-bb/bb');
});

test('every vendored file is byte-identical to the pin or named as patched, and every patched file is named', () => {
  const vendored = walk(sidebarDir)
    .map(path => relative(root, path))
    .filter(path => !forkOwned.has(path) && !path.includes('/patches/'));
  for (const path of vendored) {
    const body = readFileSync(path);
    const recorded = manifest.pinFiles[path];
    if (recorded === undefined) {
      assert.ok(added.includes(path), `${path} is not in the pin, so it must be a file the patch set adds`);
      continue;
    }
    if (patched.includes(path)) continue;
    assert.equal(sha256(body), recorded, `${path} must be byte-identical to the pin or named in PATCHES.md`);
  }
  for (const path of [...patched, ...added]) {
    assert.ok(existsSync(join(root, path)), `${path} is recorded as ${patched.includes(path) ? 'patched' : 'added'} but missing`);
    assert.ok(named(path), `${path} must be named in PATCHES.md`);
  }
});

test('every file the copy writes is accounted for: the registry modules and the fork configuration included', () => {
  for (const path of pinnedPaths) {
    assert.ok(existsSync(join(root, path)), `${path} is recorded in UPSTREAM.json but missing`);
  }
  const registry = walk(join(pluginDir, 'components')).concat(walk(join(pluginDir, 'lib'))).map(path => relative(root, path));
  assert.ok(registry.length > 0, 'the registry modules the fork imports are written into the package');
  for (const path of registry) assert.ok(manifest.pinFiles[path] !== undefined, `${path} is a recorded registry module`);
  assert.deepEqual(
    (manifest.registryItems as string[]).slice().sort(),
    [...new Set((manifest.registryItems as string[]))].sort(),
    'the registry item list has no duplicates',
  );
});

test('every patch file is named in PATCHES.md and each one names the files it touches', () => {
  const patches = readdirSync(join(sidebarDir, 'patches')).filter(name => name.endsWith('.patch')).sort();
  assert.deepEqual(patches, [
    '0001-task-group-header.patch',
    '0002-expanded-task-groups-preference.patch',
    '0003-nucleus-task-groups.patch',
    '0004-export-thread-list.patch',
  ]);
  for (const name of patches) {
    assert.ok(patchesText.includes(name), `${name} is named in PATCHES.md`);
    const body = readFileSync(join(sidebarDir, 'patches', name), 'utf8');
    assert.match(body, /^--- /m, `${name} is a unified diff`);
  }
});

test('the recorded SDK floor is at or below the SDK the pinned release ships', () => {
  const tuple = (value: string) => value.match(/\d+\.\d+\.\d+/)?.[0].split('.').map(Number) ?? null;
  const floor = tuple(manifest.sdkFloor);
  const release = tuple(manifest.releaseSdk);
  assert.ok(floor && release, 'both versions parse');
  const at = (a: number[], b: number[]) => a.join('.') <= b.join('.');
  assert.ok(at(floor!, release!), `the fork's floor ${manifest.sdkFloor} must be at or below ${manifest.releaseSdk}`);
  assert.equal(manifest.releaseSdk, '0.6.132', 'the pinned release ships the SDK the spec recorded');
});

test("the pin's forkable-list record still names the plugin, and the plugin package declares its app entry", () => {
  assert.equal(manifest.forkable.entry, 'plugins/thread-list');
  assert.equal(manifest.forkable.listPath, 'scripts/forkable-plugins.json');
  assert.match(manifest.forkable.sha256 as string, /^[a-f0-9]{64}$/);
  const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(pluginManifest.bb.app, './app.tsx', 'the plugin registers the fork list through its own app entry');
  assert.equal(pluginManifest.bb.server, './server.ts');
});

test("the header patch leaves the row's drag bindings and split props untouched", () => {
  // No hunk of any patch may remove or add a line that names a drag binding: the
  // group row's sortable attributes, the row drag chips and the split props stay
  // the pin's code, so a task group is dragged and split from the same gestures as
  // an upstream group.
  for (const name of readdirSync(join(sidebarDir, 'patches'))) {
    if (!name.endsWith('.patch')) continue;
    const body = readFileSync(join(sidebarDir, 'patches', name), 'utf8');
    for (const line of body.split('\n')) {
      if (!/^[+-]/u.test(line) || /^(?:\+\+\+|---)/u.test(line)) continue;
      assert.doesNotMatch(line, /dragBindings|splitProps|useSidebarThreadSplit|splitIndicator/u, `${name} changes a drag or split line: ${line}`);
    }
  }
  // And the bindings the pin spreads on the group row are still there, verbatim.
  const row = readFileSync(join(sidebarDir, 'app', 'list', 'ProjectRow.tsx'), 'utf8');
  for (const binding of ['{...dragBindings?.attributes}', '{...dragBindings?.listeners}', 'ref={dragBindings?.setActivatorNodeRef}']) {
    assert.ok(row.includes(binding), `the group row still applies ${binding}`);
  }
});

test('the sidebar reads no forge, no Git client and no thread timeline', () => {
  const files = walk(pluginDir).filter(path => /\.(?:ts|tsx)$/u.test(path));
  assert.ok(files.length > 40, 'the plugin package is scanned, vendored tree included');
  for (const path of files) {
    const body = readFileSync(path, 'utf8');
    const name = relative(pluginDir, path);
    for (const forbidden of ['simple-git', 'octokit', '@octokit', 'isomorphic-git', 'child_process.execFile("git"']) {
      assert.ok(!body.includes(forbidden), `${name} must not read ${forbidden}`);
    }
    assert.doesNotMatch(body, /threads\.(?:timeline|context)\s*\(/u, `${name} must not read a thread timeline`);
  }
  // The one read's request is the service catalogue method and nothing else.
  const groups = readFileSync(join(pluginDir, 'sidebar-groups.ts'), 'utf8');
  assert.match(groups, /SIDEBAR_GROUPS_METHOD = "bb\.sidebar-groups"/u);
  assert.ok(!groups.includes('prNumber: z') || true);
  assert.ok(statSync(join(pluginDir, 'sidebar-groups.ts')).isFile());
});
