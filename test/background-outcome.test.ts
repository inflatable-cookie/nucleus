import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleted, cleanupDiagnostic, describeError, observeOutcome, STOPPED_BEFORE_DRAIN_MESSAGE } from './support/background-outcome';

// #609: a requested drain is rejected when the engine stops first. A test that
// requests background work must observe it at creation and see it complete.

test('a resolved background promise is completed', async () => {
  assert.deepEqual(await observeOutcome(Promise.resolve(7)), { ok: true });
  await assertCompleted(observeOutcome(Promise.resolve()), 'work');
});

test('any rejection, null and undefined included, is a failure on the normal path, a stop too', async () => {
  for (const reason of [null, undefined, 0, '', Error('boom'), Error(STOPPED_BEFORE_DRAIN_MESSAGE)]) {
    const outcome = observeOutcome(Promise.reject(reason));
    assert.equal((await outcome).ok, false, `reject(${String(reason)})`);
    await assert.rejects(assertCompleted(outcome, 'work'), /work did not complete/);
  }
});

test('a rejection is retained from creation, so no unhandled rejection is raised', async () => {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const outcome = observeOutcome(Promise.reject(Error('late')));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, []);
    assert.equal(describeError(((await outcome) as { ok: false; error: unknown }).error), 'Error: late');
  } finally { process.off('unhandledRejection', listener); }
});

test('cleanup after an earlier failure treats only the exact stop as expected and never waits on pending work', async () => {
  assert.equal(await cleanupDiagnostic(undefined, 'work'), null);
  assert.equal(await cleanupDiagnostic(observeOutcome(Promise.resolve()), 'work'), null);
  assert.equal(await cleanupDiagnostic(observeOutcome(Promise.reject(Error(STOPPED_BEFORE_DRAIN_MESSAGE))), 'work'), null);
  assert.equal(await cleanupDiagnostic(observeOutcome(Promise.reject(Error('disk full'))), 'work'), 'work failed: Error: disk full');
  assert.equal(await cleanupDiagnostic(observeOutcome(Promise.reject(null)), 'work'), 'work failed: null');
  assert.equal(await cleanupDiagnostic(observeOutcome(new Promise(() => {})), 'work'), 'work was still pending at cleanup');
});

test('a failing assertion stays primary when cleanup finds an unexpected background failure', async () => {
  const notes: string[] = [];
  const background = observeOutcome(Promise.reject(Error('disk full')));
  await assert.rejects((async () => {
    let failed = false;
    try { assert.equal(1, 2, 'the primary assertion'); }
    catch (error) { failed = true; throw error; }
    finally {
      const note = failed ? await cleanupDiagnostic(background, 'work') : null;
      if (note) notes.push(note);
    }
  })(), /the primary assertion/);
  assert.deepEqual(notes, ['work failed: Error: disk full']);
});

test('error rendering is bounded and never throws', () => {
  assert.ok(describeError(Error('x'.repeat(900))).length <= 501);
  const hostile = { toString() { throw Error('no'); } };
  assert.equal(describeError(hostile), 'unrenderable error');
});

test('the stop message matches the engine rejection', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../core/engine.ts', import.meta.url), 'utf8'), new RegExp(`new Error\\("${STOPPED_BEFORE_DRAIN_MESSAGE}"\\)`));
});
