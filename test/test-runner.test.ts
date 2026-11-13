import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { selectTestFiles, splitRunnerArgs, testRunnerArgs } from '../scripts/run-tests';
import { testEnvironmentImport } from '../scripts/test-runner-flags.mjs';
import durations, { durationReporterArgs } from '../scripts/duration-reporter.mjs';
import { SERIAL_LANE_MARKER, isSerialLaneSource, selectTimingFiles } from '../scripts/timing-source.mjs';
import { TIMING_PREFIX, serialTestOptions } from './support/timing';

test('npm test uses explicitly supplied files without expanding the suite', () => {
  assert.deepEqual(
    selectTestFiles(['test/prompts.test.ts'], ['alpha.test.ts', 'prompts.test.ts']),
    ['test/prompts.test.ts'],
  );
});

test('npm test orders measured files longest first and unknown files alphabetically', () => {
  assert.deepEqual(
    selectTestFiles([], ['z.test.ts', 'retained-external-merge.test.ts', 'data-migration-stage.test.ts', 'notes.md', 'a.test.ts', 'store-compaction-bench.test.ts']),
    ['test/retained-external-merge.test.ts', 'test/data-migration-stage.test.ts', 'test/a.test.ts', 'test/z.test.ts'],
  );
});

test('the unit runner keeps its board shape, then options, then the selected files', () => {
  assert.deepEqual(
    testRunnerArgs(['--test-skip-pattern=sentinel'], ['test/a.test.ts'], ['--test-reporter=tap']),
    [
      '--test',
      '--test-concurrency=6',
      '--test-timeout=120000',
      '--test-force-exit',
      testEnvironmentImport,
      '--test-reporter=tap',
      '--test-skip-pattern=sentinel',
      'test/a.test.ts',
    ],
  );
});

test('the runner split separates options from files and keeps an option with its value', () => {
  assert.deepEqual(splitRunnerArgs([]), { options: [], requestedFiles: [] });
  assert.deepEqual(splitRunnerArgs(['test/a.test.ts', '--test-skip-pattern=sentinel']), {
    options: ['--test-skip-pattern=sentinel'],
    requestedFiles: ['test/a.test.ts'],
  });
  assert.deepEqual(splitRunnerArgs(['--test-name-pattern', 'steady state', 'test/a.test.ts']), {
    options: ['--test-name-pattern', 'steady state'],
    requestedFiles: ['test/a.test.ts'],
  });
  assert.deepEqual(splitRunnerArgs(['--test-skip-pattern=sentinel body', 'test/space name.test.ts']), {
    options: ['--test-skip-pattern=sentinel body'],
    requestedFiles: ['test/space name.test.ts'],
  });
  // An explicit separator is the shell convention: everything after it is a file.
  assert.deepEqual(splitRunnerArgs(['--', '--test-skip-pattern=x']), {
    options: [],
    requestedFiles: ['--test-skip-pattern=x'],
  });
});

const runnerScript = fileURLToPath(new URL('../scripts/run-tests.ts', import.meta.url));

/** A bounded fixture whose files write a marker from their test body. */
function unitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'unit-runner-'));
  mkdirSync(join(root, 'test'));
  function file(name: string, testName: string, marker: string, fail = false) {
    writeFileSync(join(root, 'test', name), [
      "import { test } from 'node:test';",
      "import { writeFileSync } from 'node:fs';",
      `test(${JSON.stringify(testName)}, () => {`,
      `  writeFileSync(${JSON.stringify(join(root, marker))}, ${JSON.stringify(testName)});`,
      ...(fail ? ["  throw new Error('fixture failure');"] : []),
      '});',
      '',
    ].join('\n'));
  }
  file('sentinel.test.mjs', 'sentinel body', 'sentinel-ran.txt');
  file('other.test.mjs', 'other body', 'other-ran.txt');
  file('space sentinel.test.mjs', 'space body', 'space-ran.txt');
  file('failing.test.mjs', 'failing body', 'failing-ran.txt', true);
  return root;
}

function runUnitSelector(root: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  // The outer file runs under `node --test`, which marks its children with
  // NODE_TEST_CONTEXT; the selector must start its own run, not inherit the
  // outer one's recursion guard.
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [createRequire(import.meta.url).resolve('tsx/cli'), runnerScript, ...args],
    { cwd: root, encoding: 'utf8', timeout: 60_000, env },
  );
}

test('each physical test isolates its default data home before product imports and preserves explicit helper homes', () => {
  const root = unitFixture();
  const home = join(root, 'sentinel-home');
  const sentinel = join(home, '.nucleus');
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(join(sentinel, 'queue.sqlite'), 'A test must never open this sentinel as SQLite.');
  const dataModule = new URL('../shared/data-home.mjs', import.meta.url).href;
  const workModule = new URL('../core/workspaces/work-root.mjs', import.meta.url).href;
  for (const name of ['first', 'second']) {
    writeFileSync(join(root, 'test', `${name}.test.mjs`), [
      "import { test } from 'node:test';",
      "import { writeFileSync } from 'node:fs';",
      `import { dataHome } from ${JSON.stringify(dataModule)};`,
      `import { getWorkRoot } from ${JSON.stringify(workModule)};`,
      `test('isolated default', () => writeFileSync(${JSON.stringify(join(root, `${name}.json`))}, JSON.stringify({`,
      '  home: dataHome(), work: getWorkRoot(),',
      '  rootOverride: process.env.NUCLEUS_WORK_ROOT ?? null, pin: process.env.NUCLEUS_WORK_VOLUME_ID ?? null,',
      '})));',
    ].join('\n'));
  }
  const explicit = join(root, 'explicit-data');
  const helperHome = join(root, 'helper-data');
  const helperWork = join(root, 'helper-work');
  const helper = join(root, 'helper.mjs');
  writeFileSync(helper, [
    `import { dataHome } from ${JSON.stringify(dataModule)};`,
    'process.send({ home: dataHome(), work: process.env.NUCLEUS_WORK_ROOT, pin: process.env.NUCLEUS_WORK_VOLUME_ID });',
  ].join('\n'));
  writeFileSync(join(root, 'test', 'explicit.test.mjs'), [
    "import { test } from 'node:test';",
    "import { fork } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `import { dataHome } from ${JSON.stringify(dataModule)};`,
    `process.env.NUCLEUS_DATA_HOME = ${JSON.stringify(explicit)};`,
    "test('explicit test and helper homes', async () => {",
    `  const child = fork(${JSON.stringify(helper)}, [], {`,
    `    execArgv: [${JSON.stringify(testEnvironmentImport)}],`,
    `    env: { ...process.env, NUCLEUS_DATA_HOME: ${JSON.stringify(helperHome)}, NUCLEUS_WORK_ROOT: ${JSON.stringify(helperWork)}, NUCLEUS_WORK_VOLUME_ID: 'helper-volume' },`,
    "    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],",
    '  });',
    '  const finished = new Promise(resolve => child.once("exit", resolve));',
    '  const message = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });',
    '  const exit = await finished;',
    `  writeFileSync(${JSON.stringify(join(root, 'explicit.json'))}, JSON.stringify({ home: dataHome(), message, exit }));`,
    '});',
  ].join('\n'));
  const result = runUnitSelector(root, [
    'test/first.test.mjs', 'test/second.test.mjs', 'test/explicit.test.mjs',
  ], {
    HOME: home,
    NUCLEUS_DATA_HOME: sentinel,
    NUCLEUS_WORK_ROOT: join(sentinel, 'work'),
    NUCLEUS_WORK_VOLUME_ID: 'ambient-volume',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const first = JSON.parse(readFileSync(join(root, 'first.json'), 'utf8'));
  const second = JSON.parse(readFileSync(join(root, 'second.json'), 'utf8'));
  assert.notEqual(first.home, second.home, 'parallel physical files do not share a default store');
  for (const observed of [first, second]) {
    assert.ok(observed.home.startsWith(`${tmpdir()}/nt-`));
    assert.equal(observed.work, join(observed.home, 'work'));
    assert.equal(observed.rootOverride, null);
    assert.equal(observed.pin, null);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'explicit.json'), 'utf8')), {
    home: explicit, message: { home: helperHome, work: helperWork, pin: 'helper-volume' }, exit: 0,
  });
  assert.equal(readFileSync(join(sentinel, 'queue.sqlite'), 'utf8'), 'A test must never open this sentinel as SQLite.');
  assert.deepEqual(readdirSync(sentinel), ['queue.sqlite'], 'the supplied live-home sentinel is unchanged');
});

test('the unit selector transports a requested option instead of running the fixture it excludes', () => {
  const root = unitFixture();
  const result = runUnitSelector(root, [
    'test/space sentinel.test.mjs',
    'test/sentinel.test.mjs',
    '--test-skip-pattern=sentinel body',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(existsSync(join(root, 'space-ran.txt')), true, 'a requested path with a space still runs');
  assert.equal(existsSync(join(root, 'sentinel-ran.txt')), false, 'the excluded test body does not run');
  assert.equal(existsSync(join(root, 'other-ran.txt')), false, 'an unrequested file stays out of the run');
});

test('an option and its separate value reach node in that order', () => {
  const root = unitFixture();
  const result = runUnitSelector(root, [
    '--test-name-pattern',
    'sentinel body',
    'test/sentinel.test.mjs',
    'test/other.test.mjs',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(existsSync(join(root, 'sentinel-ran.txt')), true, 'the named test runs');
  assert.equal(existsSync(join(root, 'other-ran.txt')), false, 'the unselected test body does not run');
});

test('an unknown option fails the run instead of being ignored', () => {
  const root = unitFixture();
  const result = runUnitSelector(root, ['test/other.test.mjs', '--not-a-node-option']);
  assert.notEqual(result.status, 0, 'an unrecognized option is not a pass');
  assert.match(`${result.stdout}${result.stderr}`, /bad option: --not-a-node-option/);
  assert.equal(existsSync(join(root, 'other-ran.txt')), false, 'a rejected invocation runs nothing');
});

test('a failing selected file still fails the selector run', () => {
  const root = unitFixture();
  const result = runUnitSelector(root, ['test/failing.test.mjs']);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(existsSync(join(root, 'failing-ran.txt')), true);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Test failure summary \(1\)/);
  assert.match(output, /failing\.test\.mjs: failing body/);
  const summaryPath = output.match(/Failure summary file: (.+)$/m)?.[1];
  assert.ok(summaryPath, 'the failure summary is saved as a scratch artifact');
  assert.match(readFileSync(summaryPath!, 'utf8'), /failing\.test\.mjs: failing body/);
});

test('serial wall-clock oracles are classified by the support/timing marker', () => {
  assert.equal(isSerialLaneSource(`import { timingTest } from '${SERIAL_LANE_MARKER}';`), true);
  assert.equal(isSerialLaneSource("import { bridgeSupport } from './support/bridge-fixture';"), false);
  // The roll-acceptance files must stay lane members: if the marker import
  // disappears, the parallel suite skips their oracles and the serial lane
  // drops them, losing the coverage silently to both runners at once.
  for (const file of ['test/service-roll.test.ts', 'test/host-run-roll.test.ts']) {
    assert.equal(isSerialLaneSource(readFileSync(file, 'utf8')), true, `${file} stays in the serial wall-clock lane`);
  }
});

test('serial oracles skip the parallel suite and run in the timing lane', () => {
  const lane = process.env.QUEUE_TEST_LANE;
  try {
    delete process.env.QUEUE_TEST_LANE;
    const skipped = serialTestOptions().skip;
    assert.equal(typeof skipped, 'string');
    assert.match(skipped as string, /test:timing/);

    process.env.QUEUE_TEST_LANE = 'timing';
    assert.equal(serialTestOptions().skip, false, 'the lane executes what the parallel suite skips');
  } finally {
    if (lane === undefined) delete process.env.QUEUE_TEST_LANE;
    else process.env.QUEUE_TEST_LANE = lane;
  }
  assert.equal(TIMING_PREFIX, 'timing: ', 'the lane runners select serial oracles by this name prefix');
});

test('QA keeps the console reporter on stdout and gives the duration reporter no destination that can fail', () => {
  for (const tty of [true, false]) {
    const args = durationReporterArgs(tty);
    assert.deepEqual(args.filter(arg => arg.startsWith('--test-reporter-destination=')), ['--test-reporter-destination=stdout', '--test-reporter-destination=/dev/null']);
    assert.equal(args[0], `--test-reporter=${tty ? 'spec' : 'tap'}`);
    assert.match(args[2], /duration-reporter\.mjs$/);
  }
});

test('the duration table lists each file once, slowest first, with failures marked and the lane total', async () => {
  const cwd = process.cwd();
  async function* events() {
    yield { type: 'test:complete', data: { file: `${cwd}/test/a.test.ts`, nesting: 0, name: 'a case', details: { duration_ms: 9000 } } };
    yield { type: 'test:complete', data: { file: `${cwd}/test/a.test.ts`, nesting: 0, name: 'test/a.test.ts', details: { duration_ms: 1500 } } };
    yield { type: 'test:complete', data: { file: `${cwd}/test/b.test.ts`, nesting: 0, name: 'test/b.test.ts', details: { duration_ms: 4200, error: new Error('x') } } };
    yield { type: 'test:summary', data: { file: `${cwd}/test/b.test.ts`, duration_ms: 4100 } };
    yield { type: 'test:summary', data: { duration_ms: 5000 } };
  }
  const file = join(mkdtempSync(join(tmpdir(), 'qa-durations-')), 'table.txt');
  const previous = process.env.QUEUE_QA_DURATIONS_FILE;
  process.env.QUEUE_QA_DURATIONS_FILE = file;
  try { for await (const chunk of durations(events())) assert.fail(`the reporter yields nothing to Node: ${chunk}`); }
  finally { if (previous === undefined) delete process.env.QUEUE_QA_DURATIONS_FILE; else process.env.QUEUE_QA_DURATIONS_FILE = previous; }
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.match(lines[0]!, /^qa-durations: \S+ lane, 2 files, 5\.0 s wall$/);
  assert.match(lines[1]!, /4\.2 s  test\/b\.test\.ts  \(failed\)$/);
  assert.match(lines[2]!, /1\.5 s  test\/a\.test\.ts$/);
  assert.equal(lines.length, 3);
});

test('an unwritable duration file never fails the reporter', async () => {
  const previous = process.env.QUEUE_QA_DURATIONS_FILE;
  process.env.QUEUE_QA_DURATIONS_FILE = '/nonexistent-dir/qa-durations/table.txt';
  async function* none() {}
  try { for await (const _ of durations(none())) void _; }
  finally { if (previous === undefined) delete process.env.QUEUE_QA_DURATIONS_FILE; else process.env.QUEUE_QA_DURATIONS_FILE = previous; }
});


test('the timing lane discovers oracles but runs the compaction benchmark only on request', () => {
  const read = () => "import './support/timing';";
  assert.deepEqual(selectTimingFiles([], ['oracle.test.ts', 'store-compaction-bench.test.ts', 'notes.md'], read), ['test/oracle.test.ts']);
  assert.deepEqual(selectTimingFiles(['test/store-compaction-bench.test.ts'], [], read), ['test/store-compaction-bench.test.ts']);
});
