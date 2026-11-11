import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performanceAssert } from './support/timing';

type Failure = { name: string; performance: boolean };
type Verdict = { verdict: 'pass' | 'fail' | 'inconclusive'; exit: number; load?: number };
type Input = { status: number | null; loads: number[]; cores: number; strict?: boolean; failures?: Failure[]; failed?: number; cancelled?: number };
const modulePath = new URL('../scripts/timing-verdict.mjs', import.meta.url).href;

test('only explicitly marked performance assertion failures may be inconclusive under load', async () => {
  const { timingVerdict } = await import(modulePath) as { timingVerdict: (input: Input) => Verdict };
  const performance = { failures: [{ name: 'timing: measured budget', performance: true }], failed: 1, cancelled: 0 };
  const loaded = { status: 1, loads: [10, 40], cores: 18 };
  assert.deepEqual(timingVerdict({ status: 0, loads: [60, 60], cores: 18 }), { verdict: 'pass', exit: 0 });
  assert.deepEqual(timingVerdict({ ...loaded, ...performance }), { verdict: 'inconclusive', exit: 0, load: 40 });
  assert.equal(timingVerdict({ ...loaded, ...performance, loads: [40, 10] }).verdict, 'inconclusive');
  for (const input of [
    { ...loaded },
    { ...loaded, ...performance, loads: [4, 6] },
    { ...loaded, ...performance, loads: [18, 18] },
    { ...loaded, ...performance, strict: true },
    { ...loaded, ...performance, status: null },
    { ...loaded, ...performance, status: 2 },
    { ...loaded, ...performance, failed: 2 },
    { ...loaded, ...performance, cancelled: 1 },
    { ...loaded, ...performance, failures: [{ name: 'timing: bootstrap regression', performance: false }] },
    { ...loaded, ...performance, failed: 2, failures: [...performance.failures, { name: 'functional regression', performance: false }] },
  ]) assert.equal(timingVerdict(input).verdict, 'fail', JSON.stringify(input));
});

test('the reporter classifies the thrown assertion, not the test title or parent echo', async () => {
  const { timingFailure } = await import(modulePath);
  let oracle: unknown;
  try { performanceAssert(false, 'CPU budget exceeded'); } catch (error) { oracle = error; }
  assert.deepEqual(timingFailure({ name: 'budget', details: { error: { failureType: 'testCodeFailure', cause: oracle } } }), { name: 'budget', performance: true });
  for (const error of [
    new Error('functional failure'),
    { failureType: 'testCodeFailure', cause: new Error('setup failed') },
    { failureType: 'testTimeoutFailure', cause: oracle },
    { failureType: 'cancelledByParent' },
  ]) assert.equal(timingFailure({ name: 'timing: performance oracle', details: { error } }).performance, false);
  assert.equal(timingFailure({ details: { error: { failureType: 'subtestsFailed' } } }), null);
  performanceAssert(true, 'passing assertion');
});


test('the real Node reporter preserves assertion markers and complete failure counts', async () => {
  const { timingVerdict } = await import(modulePath) as { timingVerdict: (input: Input) => Verdict };
  const root = mkdtempSync(join(tmpdir(), 'timing-reporter-proof-'));
  const fixture = join(root, 'oracle.test.mjs');
  const reporter = fileURLToPath(new URL('../scripts/timing-reporter.mjs', import.meta.url));
  const helper = join(root, 'timing.ts');
  writeFileSync(helper, readFileSync(new URL('./support/timing.ts', import.meta.url)));

  for (const mixed of [false, true]) {
    const evidencePath = join(root, mixed ? 'mixed.json' : 'performance.json');
    writeFileSync(fixture, `import { test } from 'node:test';
import { performanceAssert } from ${JSON.stringify(helper)};
test('timing: measured budget', () => performanceAssert(false, 'CPU budget exceeded'));
${mixed ? "test('timing: bootstrap regression', () => { throw new Error('missing module'); });" : ''}
`);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, QUEUE_TIMING_FAILURES_FILE: evidencePath };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-force-exit', '--test-timeout=30000',
      `--test-reporter=${reporter}`, '--test-reporter-destination=/dev/null', fixture],
    { env: childEnv, encoding: 'utf8', timeout: 40000 });
    assert.equal(child.status, 1, child.stderr);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { failures: Failure[]; failed: number; cancelled: number };
    assert.equal(evidence.failed, mixed ? 2 : 1);
    assert.equal(evidence.cancelled, 0);
    assert.deepEqual(evidence.failures, [{ name: 'timing: measured budget', performance: true },
      ...(mixed ? [{ name: 'timing: bootstrap regression', performance: false }] : [])]);
    assert.equal(timingVerdict({ ...evidence, status: child.status, loads: [100, 100], cores: 2 }).verdict,
      mixed ? 'fail' : 'inconclusive');
  }
});
