import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerFlags } from './test-runner-flags.mjs';
import durations from './test-durations.json';
import { durationReporterArgs, durationTablePath, flushDurationTable } from './duration-reporter.mjs';

/**
 * Node test-runner options that take their value as the next argv entry rather
 * than after `=`. They are moved with their value so an option and its value
 * never separate; every other option is self-contained or fails at Node.
 */
const VALUE_TEST_OPTIONS = new Set([
  '--experimental-test-isolation',
  '--test-concurrency',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
]);

/** The unit selector's argv split into Node test options and requested files. */
export interface RunnerArgs {
  options: string[];
  requestedFiles: string[];
}

/**
 * Split the selector's arguments at the runner boundary.
 *
 * Effigy appends its passthrough after the suite command, so a file and an
 * option can arrive in either order. Node only reads its own options before
 * the first positional file and silently ignores them afterwards: a requested
 * `--test-skip-pattern` placed beside a file would run the fixture it excludes.
 * Everything from an explicit `--` on is a file, as in the shell convention.
 */
export function splitRunnerArgs(argv: string[]): RunnerArgs {
  const options: string[] = [];
  const requestedFiles: string[] = [];
  let afterSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (afterSeparator) {
      requestedFiles.push(arg);
    } else if (arg === '--') {
      afterSeparator = true;
    } else if (!arg.startsWith('-')) {
      requestedFiles.push(arg);
    } else {
      options.push(arg);
      if (!arg.includes('=') && VALUE_TEST_OPTIONS.has(arg)) {
        const value = argv[index + 1];
        if (value !== undefined) {
          options.push(value);
          index += 1;
        }
      }
    }
  }
  return { options, requestedFiles };
}

export function selectTestFiles(requestedFiles: string[], availableFiles: string[]) {
  if (requestedFiles.length) return [...requestedFiles];
  return availableFiles
    .filter(file => file.endsWith('.test.ts') && file !== 'store-compaction-bench.test.ts')
    .sort((a, b) => ((durations as Record<string, number>)[b] ?? 0) - ((durations as Record<string, number>)[a] ?? 0) || a.localeCompare(b))
    .map(file => `test/${file}`);
}

/** The Node test invocation: the board's fixed shape, then options, then files. */
export function testRunnerArgs(
  options: string[],
  files: string[],
  reporters: string[] = durationReporterArgs(),
): string[] {
  return [
    ...runnerFlags(6, 120000),
    ...reporters,
    ...options,
    ...files,
  ];
}

function run() {
  const require = createRequire(import.meta.url);
  const availableFiles = readdirSync('test', { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name);
  const { options, requestedFiles } = splitRunnerArgs(process.argv.slice(2));
  const files = selectTestFiles(requestedFiles, availableFiles);
  const installFiles = files.filter(file => /(?:^|\/)nucleus-install(?:-safety|-release)?\.test\.ts$/.test(file));
  const installEnv: NodeJS.ProcessEnv = { ...process.env };
  if (installFiles.length) {
    // These scenarios need a real installed package, but building the same
    // runtime in three parallel test processes needlessly competes for CPU.
    // Build it once per unit invocation; each scenario copies it into its own
    // fixture before mutation or installation.
    const cacheRoot = mkdtempSync(resolve(tmpdir(), 'nucleus-install-runtime-'));
    const cache = resolve(cacheRoot, 'package');
    execFileSync(process.execPath, ['scripts/build-runtime.mjs', cache], { stdio: 'ignore' });
    installEnv.NUCLEUS_INSTALL_RUNTIME_CACHE = cache;
  }
  const table = durationTablePath();
  const result = spawnSync(process.execPath, [
    require.resolve('tsx/cli'),
    ...testRunnerArgs(options, files),
  ], { stdio: 'inherit', env: { ...installEnv, QUEUE_QA_DURATIONS_FILE: table } });
  flushDurationTable(table);

  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
