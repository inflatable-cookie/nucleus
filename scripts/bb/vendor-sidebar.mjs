#!/usr/bin/env node
/**
 * Copy BB's `plugins/thread-list` into the Nucleus BB plugin package and re-apply
 * the fork's patch set (Spec 062, decision 5a).
 *
 * The copy is upstream's own routine, not a hand copy: this script imports
 * `scripts/lib/plugin-fork.mjs` from the checkout at the pin, so the registry
 * items, the `@/*` tsconfig mapping and the package.json dependency set are
 * exactly what upstream CI's "Plugin Fork Check" produces. Then it applies
 * `hosts/bb/plugin/sidebar/patches/*.patch` in name order and records the result.
 *
 * What one run writes:
 *
 *   hosts/bb/plugin/sidebar/             upstream's app.tsx, app/, shared/,
 *                                        server.ts, its app-level tests,
 *                                        PLUGIN_OVERVIEW.md and LICENSE, with the
 *                                        patch set applied
 *   hosts/bb/plugin/{components,lib,hooks}/  the registry items the tree imports
 *   hosts/bb/plugin/tsconfig.json        the fork's mapping (`@/*` -> `./*`)
 *   hosts/bb/plugin/vitest.config.ts     the fork's own test runner
 *   hosts/bb/plugin/sidebar/UPSTREAM.json  the pin, the SDK floor, the pin's file
 *                                        hashes, the patched and added files, the
 *                                        registry items and the forkable record
 *
 * Usage:
 *   node scripts/bb/vendor-sidebar.mjs --upstream <checkout at the pin>
 *   node scripts/bb/vendor-sidebar.mjs --check       (no network, no writes)
 *
 * `--check` verifies the committed copy against `sidebar/UPSTREAM.json`: every
 * file is byte-identical to its recorded hash or named as patched, and every
 * patched file is listed. It is the rebase's last step and the ordinary unit test
 * runs the same check in-process (`test/bb-sidebar-vendored.test.ts`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_DIR = 'hosts/bb/plugin';
const SIDEBAR_DIR = `${PLUGIN_DIR}/sidebar`;
const COPY_EXCLUDED = new Set(['node_modules', 'dist', '.bundled-runtime', '.turbo']);
/** Upstream files the vendored tree keeps, relative to `plugins/thread-list`. */
const VENDORED = [
  'app.tsx',
  'app',
  'shared',
  'server.ts',
  'PLUGIN_OVERVIEW.md',
  'app.test.tsx',
  'sidebarRowRenders.test.tsx',
];

const args = process.argv.slice(2);
const check = args.includes('--check');
const upstream = args[args.indexOf('--upstream') + 1];
if (!check && (!upstream || upstream.startsWith('--'))) {
  console.error('Usage: node scripts/bb/vendor-sidebar.mjs --upstream <checkout at the pin> | --check');
  process.exit(2);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sdkTuple = value => {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(value ?? ''));
  return match ? match.slice(1).map(Number) : null;
};

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (COPY_EXCLUDED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:tsx?|mts|cts)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

/** The release tag pointing at the pin: the one whose list must be written against. */
function releaseTag(checkout) {
  const tags = execFileSync('git', ['-C', checkout, 'tag', '--points-at', 'HEAD'], { encoding: 'utf8' })
    .split('\n')
    .map(tag => tag.trim())
    .filter(Boolean);
  const release = tags.filter(tag => /^desktop-v\d+\.\d+\.\d+$/u.test(tag)).sort().pop();
  if (!release) throw new Error(`the pin carries no desktop-vX.Y.Z release tag: ${tags.join(', ') || 'none'}`);
  return release;
}

/** The paths one patch file touches, from its `--- a/<path>` / `--- /dev/null` headers. */
function patchedPaths(patch) {
  const paths = new Set();
  for (const line of patch.split('\n')) {
    const match = /^--- (?:a\/)?(.+?)(?:\t.*)?$/u.exec(line);
    if (!match) continue;
    const path = match[1];
    if (path !== '/dev/null') paths.add(path);
  }
  return [...paths];
}

// ---------------------------------------------------------------- --check mode

const manifestPath = join(repoRoot, SIDEBAR_DIR, 'UPSTREAM.json');

if (check) {
  const recorded = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const drift = [];
  for (const [path, expected] of Object.entries(recorded.pinFiles)) {
    const absolute = join(repoRoot, path);
    if (!existsSync(absolute)) { drift.push(`${path}: missing`); continue; }
    if (recorded.patched.includes(path) || recorded.added.includes(path)) continue;
    if (sha256(readFileSync(absolute)) !== expected) drift.push(`${path}: differs from the pin`);
  }
  for (const path of [...recorded.patched, ...recorded.added]) {
    if (!existsSync(join(repoRoot, path))) drift.push(`${path}: named in UPSTREAM.json but missing`);
  }
  if (drift.length > 0) {
    console.error(drift.join('\n'));
    process.exit(1);
  }
  console.log(`No drift: ${Object.keys(recorded.pinFiles).length} files match the recorded pin (${recorded.patched.length} patched, ${recorded.added.length} added).`);
  process.exit(0);
}

// ---------------------------------------------------------------- copy the pin

const pin = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const upstreamPlugin = join(upstream, 'plugins', 'thread-list');
if (!existsSync(upstreamPlugin)) throw new Error(`${upstream} has no plugins/thread-list; clone BB at the pinned release tag`);
const pluginManifest = JSON.parse(readFileSync(join(upstreamPlugin, 'package.json'), 'utf8'));
const forkableList = JSON.parse(readFileSync(join(upstream, 'scripts', 'forkable-plugins.json'), 'utf8'));
if (!forkableList.plugins.includes('plugins/thread-list')) {
  throw new Error("plugins/thread-list is not on upstream's forkable list at this commit");
}
const releaseSdk = JSON.parse(readFileSync(join(upstream, 'packages', 'plugin-sdk', 'package.json'), 'utf8')).version;
const routine = await import(pathToFileURL(join(upstream, 'scripts', 'lib', 'plugin-fork.mjs')).href);
const registryItems = readdirSync(join(upstream, 'packages', 'plugin-registry', 'r'))
  .filter(name => name.endsWith('.json') && name !== 'index.json')
  .map(name => JSON.parse(readFileSync(join(upstream, 'packages', 'plugin-registry', 'r', name), 'utf8')));

/** Upstream's own item closure for the alias imports the vendored tree makes. */
function registryFor(tree) {
  const specifiers = new Set();
  for (const file of sourceFiles(tree)) {
    for (const specifier of routine.registryAliasImports(readFileSync(file, 'utf8'))) specifiers.add(specifier);
  }
  return routine.registryItemsForImports(specifiers, registryItems);
}

/** Upstream's fork mapping, with the fork's own files included in the program. */
function forkTsconfig() {
  const forked = routine.forkPluginTsconfig(JSON.parse(readFileSync(join(upstreamPlugin, 'tsconfig.json'), 'utf8')));
  return {
    ...forked,
    compilerOptions: { ...forked.compilerOptions, baseUrl: '.' },
    include: [
      'app.tsx',
      'server.ts',
      'vitest.config.ts',
      'sidebar/**/*.ts',
      'sidebar/**/*.tsx',
      'components/**/*.ts',
      'components/**/*.tsx',
      'hooks/**/*.ts',
      'lib/**/*.ts',
      'lib/**/*.tsx',
    ],
    exclude: ['node_modules', 'sidebar/**/*.test.ts', 'sidebar/**/*.test.tsx'],
  };
}

/** The fork's test runner: jsdom tests under the vendored tree, `@/*` mapped. */
function vitestConfig() {
  return `// The vendored fork's own test runner (Spec 062, decision 5a): upstream's
// \`vitest.config.ts\`, with the fork's \`@/*\` mapping spelled out for Vite.
import { defineConfig } from "vitest/config";

// The copy root: the fork's tsconfig maps \`@/*\` here.
const root = new URL("./", import.meta.url).pathname;

export default defineConfig({
  // One runner, wherever it is started from: the config owns its root.
  root,
  resolve: { alias: { "@": root } },
  test: {
    alias: { "@": root },
    silent: "passed-only",
    name: "bb-plugin-nucleus-sidebar",
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    setupFiles: ["./test-setup.ts"],
    include: ["sidebar/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", "sidebar/**/node_modules/**"],
  },
});
`;
}

/** Every file the copy writes, path -> Buffer, before any patch is applied. */
function plans() {
  const files = new Map();
  for (const entry of VENDORED) {
    const source = join(upstreamPlugin, entry);
    if (!existsSync(source)) throw new Error(`the pin has no ${entry}`);
    if (statSync(source).isDirectory()) {
      for (const file of sourceFiles(source)) {
        files.set(join(SIDEBAR_DIR, relative(upstreamPlugin, file)), readFileSync(file));
      }
    } else files.set(join(SIDEBAR_DIR, entry), readFileSync(source));
  }
  files.set(join(SIDEBAR_DIR, 'LICENSE'), readFileSync(join(upstream, 'LICENSE')));
  // Discovery reads the pin's own source, which is byte-identical to the copy above.
  const items = registryFor(upstreamPlugin);
  for (const item of items) {
    for (const file of item.files) files.set(join(PLUGIN_DIR, file.target), Buffer.from(file.content, 'utf8'));
  }
  files.set(join(PLUGIN_DIR, 'tsconfig.json'), Buffer.from(`${JSON.stringify(forkTsconfig(), null, 2)}\n`));
  files.set(join(PLUGIN_DIR, 'vitest.config.ts'), Buffer.from(vitestConfig()));
  return { files, items };
}

const { files, items } = plans();
const pinFiles = Object.fromEntries([...files].map(([path, body]) => [relative(repoRoot, path), sha256(body)]).sort(([a], [b]) => a.localeCompare(b)));

// The previous record names every file this routine owns, patched and added
// included. Removing exactly those before writing keeps a rebase from leaving a
// file of the old pin behind, and touches nothing the routine did not write.
if (existsSync(manifestPath)) {
  const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const owned = new Set([
    ...Object.keys(previous.pinFiles ?? {}),
    ...(previous.patched ?? []),
    ...(previous.added ?? []),
    join(SIDEBAR_DIR, 'LICENSE'),
  ]);
  for (const path of owned) {
    try {
      rmSync(join(repoRoot, path), { force: true });
    } catch { /* the next write reports what it cannot place */ }
  }
  for (const dir of ['components', 'lib', 'hooks']) {
    rmSync(join(repoRoot, PLUGIN_DIR, dir), { recursive: true, force: true });
  }
}

for (const [path, body] of files) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// ---------------------------------------------------------- apply the patch set

const patchesDir = join(repoRoot, SIDEBAR_DIR, 'patches');
const patchFiles = existsSync(patchesDir)
  ? readdirSync(patchesDir).filter(name => name.endsWith('.patch')).sort()
  : [];
const failures = [];
for (const name of patchFiles) {
  const patch = readFileSync(join(patchesDir, name), 'utf8');
  try {
    execFileSync('patch', ['-p1', '--forward', '--silent', '--batch', '--input', join(patchesDir, name)], {
      cwd: join(repoRoot, SIDEBAR_DIR),
      stdio: 'pipe',
    });
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
}
if (failures.length > 0) {
  console.error(`The patch set did not apply cleanly; resolve the rejects by updating the patch, never by editing a vendored file in place:\n${failures.join('\n')}`);
  process.exit(1);
}

const patched = [];
const added = [];
for (const name of patchFiles) {
  for (const path of patchedPaths(readFileSync(join(patchesDir, name), 'utf8'))) {
    const repoPath = join(SIDEBAR_DIR, path);
    if (!existsSync(join(repoRoot, repoPath))) continue;
    (pinFiles[repoPath] === undefined ? added : patched).push(repoPath);
  }
}

// ------------------------------------------------------------------- the record

const record = {
  repository: 'https://github.com/get-bb/bb',
  tag: releaseTag(upstream),
  commit: pin,
  pluginPath: 'plugins/thread-list',
  forkable: {
    listPath: 'scripts/forkable-plugins.json',
    entry: 'plugins/thread-list',
    sha256: sha256(readFileSync(join(upstream, 'scripts', 'forkable-plugins.json'))),
  },
  sdkFloor: pluginManifest.engines?.bbPluginSdk ?? null,
  releaseSdk,
  pinFiles,
  patched: [...new Set(patched)].sort(),
  added: [...new Set(added)].sort(),
  registryItems: items.map(item => item.name).sort(),
};
const floor = sdkTuple(record.sdkFloor);
const release = sdkTuple(releaseSdk);
if (!floor || !release) throw new Error(`cannot compare the SDK floor ${record.sdkFloor} with the release SDK ${releaseSdk}`);
if (floor.join('.') > release.join('.')) {
  throw new Error(`the plugin declares SDK floor ${record.sdkFloor} above the pinned release's ${releaseSdk}`);
}
writeFileSync(manifestPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`Vendored ${files.size} files from ${record.tag} (${pin.slice(0, 12)}): ${patchFiles.length} patch file(s), ${record.patched.length} patched and ${record.added.length} added file(s); registry items: ${record.registryItems.length}.`);
