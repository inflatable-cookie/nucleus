// `effigy test:affected [base] [--run] [--head=<ref>]`: the test files a change can affect.
//
// The selection is the tests near a change, read from one git ref (default HEAD,
// so committed work only): tests that import a changed file directly or through
// the test tree's own helpers and shard case files, plus a path-literal rule for
// tests that reach a file without importing it (spawned entries, files read by
// path). The import walk never passes through production modules: following hubs
// such as the engine or the store reached ~92% of the suite, so every core task
// ran a full suite in all but name (Tom, 2026-11-18: "we need to avoid slamming
// the machine with concurrent large test runs"). The transitive sweep is milestone
// QA's job. At most MAX_AFFECTED files run, nearest first; the rest are listed as
// deferred to milestone QA. A change the graph cannot place is listed as unmapped. Pure selection (selectAffected) takes plain maps so the
// fixture tests need no git; the CLI reads the ref through git.
import { spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEdges } from './check-folder-imports.mjs';
import activeTests from './active-tests.json' with { type: 'json' };

/** Trees whose code is parsed for import edges. Root entry files are listed separately. */
const GRAPH_ROOTS = ['core', 'service', 'hosts', 'shared', 'client', 'bin', 'scripts', 'test'];
const ROOT_FILES = ['index.client.tsx', 'mcp-report.mjs'];
const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
/** Tests the unit runner would run by default; the expensive benchmark is opt-in. */
const EXCLUDED_TESTS = new Set(['test/store-compaction-bench.test.ts']);
const ACTIVE_TESTS_PATH = 'scripts/active-tests.json';
const TEST = /^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/;
/** Emitted-JavaScript specifiers resolve to their TypeScript sources first. */
const EMITTED = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] };
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.d.mts', '.d.ts', '.d.cts', '.json'];
/** Changed paths that are documentation: checked by `effigy qa:docs`, not by tests. */
const DOCS = /\.md$|^(?:docs|skills|changelog\.d)\//;

export const SERIAL_LANE_SOURCE = './support/timing';
/** The most test files one affected run starts; the rest are deferred to milestone QA. */
export const MAX_AFFECTED = 60;
/** Nearest first: a changed test, an importer, a test naming the path, a directory walk. */
const TIERS = ['changed test', 'imports', 'names', 'reads directory'];

export function isGraphNode(path) {
  return CODE.test(path) && (ROOT_FILES.includes(path) || GRAPH_ROOTS.some(root => path.startsWith(`${root}/`)));
}

export function isTestFile(path) {
  return TEST.test(path) && !EXCLUDED_TESTS.has(path);
}

/** A declaration's implementation file: editing `x.d.mts` changes what imports `x.mjs`. */
function implementationsOf(path) {
  const declared = path.match(/^(.*)\.d\.(mts|ts)$/);
  if (!declared) return [path];
  return declared[2] === 'mts' ? [path, `${declared[1]}.mjs`, `${declared[1]}.mts`] : [path, `${declared[1]}.ts`, `${declared[1]}.tsx`];
}

/**
 * The repository file a relative specifier names, or null. Bare specifiers are
 * packages; `known` holds every path that exists at the ref plus the changed paths.
 */
export function resolveLocal(known, from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base];
  const emitted = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (emitted) {
    const stem = base.slice(0, -emitted[0].length);
    candidates.push(...EMITTED[emitted[0]].map(ext => stem + ext));
  }
  candidates.push(...EXTENSIONS.map(ext => base + ext), ...EXTENSIONS.map(ext => `${base}/index${ext}`));
  return candidates.find(path => known.has(path)) ?? null;
}

/**
 * @param {object} input
 * @param {string[]} input.changed repository-relative paths changed against the base
 * @param {Set<string>} input.files every path that exists at the ref
 * @param {Map<string, string>} input.sources text of each graph node (code under the roots)
 * @param {Iterable<string>} [input.testFiles] test entries eligible to run
 * @param {number} [input.max] the most files to select (default MAX_AFFECTED)
 * @returns {{ tests: { file: string, reasons: string[] }[], deferred: { file: string, reasons: string[] }[], unmapped: string[], serial: string[] }}
 */
export function selectAffected({ changed, files, sources, testFiles = files, max = MAX_AFFECTED }) {
  const known = new Set([...files, ...changed]);
  const importers = new Map();
  const imports = new Map();
  for (const [from, text] of sources) {
    const targets = new Set();
    for (const specifier of importEdges(from, text)) {
      const target = resolveLocal(known, from, specifier);
      if (!target || target === from) continue;
      targets.add(target);
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(from);
    }
    imports.set(from, targets);
  }

  const tests = new Set([...testFiles].filter(path => isTestFile(path) && files.has(path)).sort());
  // A test's own text plus the test-tree helpers it reaches, where paths can be named.
  const scope = new Map([...tests].map(test => {
    const seen = new Set([test]);
    const queue = [test];
    while (queue.length) {
      const node = queue.shift();
      for (const next of imports.get(node) ?? []) {
        if (!seen.has(next) && next.startsWith('test/') && sources.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return [test, [...seen].map(path => sources.get(path) ?? '').join('\n')];
  }));

  const reasons = new Map();
  const tier = new Map();
  const depth = new Map();
  const add = (test, reason, kind, hops = 0) => {
    if (!reasons.has(test)) reasons.set(test, []);
    const list = reasons.get(test);
    if (!list.includes(reason)) list.push(reason);
    const rank = TIERS.indexOf(kind);
    if (!tier.has(test) || rank < tier.get(test)) tier.set(test, rank);
    if (hops && (!depth.has(test) || hops < depth.get(test))) depth.set(test, hops);
  };
  const unmapped = [];

  for (const path of changed) {
    if (tests.has(path)) add(path, 'changed test', 'changed test');
    let graphReached = false;
    for (const start of implementationsOf(path)) {
      // Breadth-first over importers, but only through the test tree (helpers and
      // shard case files): a production importer ends the walk, so a hub module
      // never pulls in every test that reaches it.
      const via = new Map([[start, null]]);
      const queue = [start];
      while (queue.length) {
        const node = queue.shift();
        for (const importer of importers.get(node) ?? []) {
          if (via.has(importer) || !importer.startsWith('test/')) continue;
          via.set(importer, node);
          queue.push(importer);
          if (tests.has(importer)) {
            graphReached = true;
            const chain = [importer];
            for (let next = via.get(importer); next; next = via.get(next)) chain.push(next);
            add(importer, `${chain.join(' → ')}`, 'imports', chain.length);
          }
        }
      }
    }
    // A path is named by its suffixes of two or more segments, with or without the
    // extension: tests read fixtures relative to their own directory.
    const segments = path.split('/');
    const names = segments.slice(0, -1).map((_, index) => segments.slice(index).join('/'))
      .flatMap(name => [name, name.replace(/\.[^/.]+$/, '')]);
    // A test that walks a directory names it as a whole literal, not the file. Any
    // ancestor directory counts: a test that recurses `client/` reads `client/board/x.tsx`.
    const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
    // A documentation change is checked by `effigy qa:docs`, and a changed test runs
    // itself; tests that merely walk `docs/` or `test/` would fill the cap without
    // testing the change. Milestone QA runs them.
    const directoryLiterals = DOCS.test(path) || isTestFile(path) ? [] : ancestors.flatMap(dir => [`'${dir}'`, `"${dir}"`, `\`${dir}\``, `'${dir}/'`, `"${dir}/"`].map(literal => [dir, literal]));
    let named = false;
    for (const test of tests) {
      const text = scope.get(test);
      if (names.some(name => text.includes(name))) {
        named = true;
        add(test, `names ${path}`, 'names');
      } else {
        const hit = directoryLiterals.find(([, literal]) => text.includes(literal));
        if (hit) {
          named = true;
          add(test, `reads directory ${hit[0]}`, 'reads directory');
        }
      }
    }
    if (!graphReached && !named && !isGraphNode(path) && !DOCS.test(path) && !isTestFile(path)) unmapped.push(path);
  }

  // Nearest first: tier, then a direct import before a chain through test helpers,
  // then the test the most changed files reach, then path. The cap keeps the nearest.
  const ranked = [...reasons.keys()].sort((a, b) => tier.get(a) - tier.get(b)
    || (depth.get(a) ?? Infinity) - (depth.get(b) ?? Infinity)
    || reasons.get(b).length - reasons.get(a).length
    || (a < b ? -1 : a > b ? 1 : 0));
  const selected = ranked.slice(0, max).sort();
  const deferred = ranked.slice(max).sort();
  // Scope text folds in the `.cases` files a shard entry requires, as timing-source.mjs does.
  const serial = selected.filter(test => scope.get(test)?.includes(SERIAL_LANE_SOURCE));
  return {
    tests: selected.map(file => ({ file, reasons: reasons.get(file) })),
    deferred: deferred.map(file => ({ file, reasons: reasons.get(file) })),
    unmapped: unmapped.sort(),
    serial,
  };
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

/** Read many blobs from one ref in a single `git cat-file --batch` process. */
export function readBlobs(ref, paths) {
  if (!paths.length) return new Map();
  const input = paths.map(path => `${ref}:${path}\n`).join('');
  const { stdout } = spawnSync('git', ['cat-file', '--batch'], { input, maxBuffer: 1 << 30 });
  const result = new Map();
  let position = 0;
  for (const path of paths) {
    const end = stdout.indexOf(10, position);
    const header = stdout.toString('utf8', position, end).split(' ');
    position = end + 1;
    if (header.at(-1) === 'missing') continue;
    const size = Number(header.at(-1));
    result.set(path, stdout.toString('utf8', position, position + size));
    position += size + 1;
  }
  return result;
}

/** Changed paths between the merge base of base and head, and the head tree the graph is read from. */
export function readRepository(base, head, paths = null) {
  const changed = paths ?? git(['diff', '-z', '--no-renames', '--name-only', `${base}...${head}`]).split('\0').filter(Boolean);
  const files = new Set(git(['ls-tree', '-r', '-z', '--name-only', head]).split('\0').filter(Boolean));
  const testFiles = files.has(ACTIVE_TESTS_PATH)
    ? JSON.parse(readBlobs(head, [ACTIVE_TESTS_PATH]).get(ACTIVE_TESTS_PATH))
    : activeTests;
  const runnable = new Set(testFiles);
  const nodes = [...files].filter(path => isGraphNode(path) && (!isTestFile(path) || runnable.has(path)));
  return { changed, files, sources: readBlobs(head, nodes), testFiles };
}

function main(argv) {
  const run = argv.includes('--run');
  const head = argv.find(arg => arg.startsWith('--head='))?.slice('--head='.length) ?? 'HEAD';
  const base = argv.find(arg => !arg.startsWith('-')) ?? 'origin/main';
  let mergeBase;
  try {
    mergeBase = git(['merge-base', base, head]).trim().slice(0, 10);
  } catch {
    console.error(`test:affected: no base ${base} (fetch it or pass a base)`);
    return 2;
  }
  // --paths replaces the diff: measuring a named change's selection and run time.
  const paths = argv.find(arg => arg.startsWith('--paths='))?.slice('--paths='.length).split(',').filter(Boolean) ?? null;
  const repository = readRepository(base, head, paths);
  const { changed } = repository;
  const { tests, deferred, unmapped, serial } = selectAffected(repository);
  const dirty = paths ? '' : git(['status', '--porcelain', '--untracked-files=no']).trim();

  console.log(`test:affected: ${changed.length} changed path(s) against ${mergeBase} (head ${head})`);
  if (dirty) console.log('test:affected: uncommitted changes are not selected; commit first');
  for (const { file, reasons } of tests) console.log(`  ${file}  ← ${reasons[0]}`);
  console.log(`test:affected: ${tests.length} test file(s) affected`);
  if (deferred.length) console.log(`test:affected: ${deferred.length} more file(s) are past the ${MAX_AFFECTED}-file cap and deferred to milestone QA; this is not a finding`);
  if (serial.length) console.log(`test:affected: wall-clock cases in ${serial.length} selected file(s) require explicit test:timing runs`);
  if (unmapped.length) console.log(`test:affected: not in the import graph, so no test is selected for: ${unmapped.join(', ')}`);
  if (!run || !tests.length) return 0;
  const result = spawnSync('npm', ['test', '--', ...tests.map(test => test.file)], { stdio: 'inherit' });
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
