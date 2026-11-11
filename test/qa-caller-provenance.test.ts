/**
 * Task 445: a milestone Project QA host run's caller is minted from the key the
 * run was submitted under, and a contract-010 host-run row is history — a
 * repository re-key never rewrites it. A re-key does move the QA row's *current*
 * key and repository, so task 444's check (recompute the canonical caller from
 * the current key) rejects the authentic producer of every run the re-key moved:
 * the parent shape this file falsifies first.
 *
 * The correction keeps 444's positive evidence — the exact host-run id has a
 * `project_qa_runs` row of that id, the caller is exactly the canonical identity
 * for the run's submitted key and id, the two records name the same repository
 * and the QA row pins the run's epoch — and resolves the submitted key only from
 * durable evidence bound to that exact run: the row's own key while it still
 * names the row's repository, the `submittedKey` the re-key recorded in the same
 * transaction, or the applied re-key receipts that moved this repository. A
 * re-key receipt corroborates an earlier identity only when its direction is the
 * one that moved the row, it happened after the run was submitted, it moved at
 * least one QA row, it is the single step into that identity, and the walk stays
 * bounded; a step back into an identity the walk already holds is an out-and-back
 * round trip and is collapsed as a net no-op.
 *
 * Every fixture here is an in-memory store and a fresh mktemp; no live database,
 * live state directory, QA log or process is read or written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { classifyRetainedOutputOwnership } from '../core/host-runs/host-run-output-ownership';
import { qaCallerIdentity, qaCallerRunId } from '../core/qa/qa-caller';
import { resolveQaCallerKey } from '../core/qa/qa-caller-provenance';
import { projectQaRunSchema, hostRunRecordSchema, type ProjectQaRun } from '../shared/contracts';
import { suggestedRepositoryRekeyKey, type RepositoryRekeyReceipt } from '../shared/repository-rekey';

const STAMP = '2026-01-01T00:00:00.000Z';
const OLD = 'acme/old';
const MID = 'acme/mid';
const NEW = 'acme/new';
const OLD_PATH = '/fixture/old';

const absent = {
  stdout: { state: 'absent' as const, reason: 'no stdout file' },
  stderr: { state: 'absent' as const, reason: 'no stderr file' },
};

/** An authentic milestone QA row: key = origin, repository = the same identity. */
function qaRow(id: string, options: { key?: string; origin?: string | null; path?: string; epoch?: number; submittedAt?: string;
  submittedKey?: string } = {}): ProjectQaRun {
  const key = options.key ?? OLD;
  const origin = options.origin === undefined ? OLD : options.origin;
  return projectQaRunSchema.parse({
    id, key, repository: { origin, path: options.path ?? OLD_PATH },
    state: 'passed', baseBranch: 'main', base: 'a'.repeat(40), argv: ['effigy', 'qa'], digest: 'b'.repeat(64),
    exitCode: 0, durationMs: 1_000, outputTail: '', startedAt: options.submittedAt ?? STAMP,
    finishedAt: '2026-01-01T00:01:00.000Z', pid: null, capacityWait: null, capacityUnavailable: false,
    submittedAt: options.submittedAt ?? STAMP, hostRunEpoch: options.epoch ?? 1,
    ...(options.submittedKey ? { submittedKey: options.submittedKey } : {}),
  });
}

/** The run fields the sweep reads, with the caller the producer minted at submission. */
const runView = (id: string, options: { callerFor?: string; caller?: string; origin?: string; path?: string; epoch?: number } = {}) => ({
  id, epoch: options.epoch ?? 1,
  caller: options.caller ?? qaCallerIdentity(options.callerFor ?? OLD, id),
  repository: { origin: options.origin ?? OLD, path: options.path ?? OLD_PATH },
});

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'qcp-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const rekey = (source: string, target: string, options: { path?: string; reason?: string } = {}) => store.rekeyRepository({
    source, target: { origin: target, ...(options.path ? { path: options.path } : {}) },
    expectedSourceRevision: store.repositoryFor(source)?.revision ?? null,
    reason: options.reason ?? `GitHub rename ${source} to ${target}`, author: 'operator',
    idempotencyKey: suggestedRepositoryRekeyKey({ source, target: { origin: target } }),
  });
  const classify = (run: ReturnType<typeof runView>, qaRun: ProjectQaRun | null,
    rekeys?: () => readonly RepositoryRekeyReceipt[]) =>
    classifyRetainedOutputOwnership({ run, qaRun, streams: absent, ...(rekeys ? { rekeys } : {}) });
  return {
    dir, store, rekey, classify,
    /** What the sweep reads by default: the applied receipts, or none at all. */
    receipts: () => store.repositoryRekeys(),
  };
}

test('the parent recomputation rejects a re-keyed run that the corrected check accepts', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('milestone-1'));
  f.rekey(OLD, NEW);
  const rekeyed = f.store.qaRun('milestone-1')!;
  assert.equal(rekeyed.key, NEW);
  assert.equal(rekeyed.repository.origin, NEW);
  assert.equal(rekeyed.submittedKey, OLD, 'the re-key records the key the caller was minted from');

  // Falsification of the parent rule, executed exactly as 444 wrote it.
  const caller = qaCallerIdentity(OLD, 'milestone-1');
  assert.equal(qaCallerRunId(caller, rekeyed.key, rekeyed.id), null,
    'recomputing the caller from the current key rejects an authentic re-keyed run');
  assert.equal(qaCallerRunId(caller, rekeyed.submittedKey!, rekeyed.id), 'milestone-1');

  const ownership = f.classify(runView('milestone-1'), rekeyed, f.receipts);
  assert.equal(ownership.owner, 'project_qa', JSON.stringify(ownership));
  if (ownership.owner !== 'project_qa') return;
  assert.equal(ownership.qaRunId, 'milestone-1', 'the exact QA row id is the accepted identity');
  assert.equal(ownership.key, OLD, 'the accepted key is the submitted one, not a name the repository later held');
  assert.equal(ownership.repository, NEW, 'the ownership names the repository the QA record owns today');
  assert.match(ownership.detail, /^retained output owned by Project QA run milestone-1/);
  assert.match(ownership.detail, /recorded as this run's submitted key and now acme\/new/);
  assert.doesNotMatch(ownership.detail, /expired|zero|passed/, 'ownership evidence never claims QA success or a zero offset');
});

test('a legacy pre-receipt rename is resolved from the applied receipts, and without them stays unknown', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('legacy-1'));
  const applied = f.rekey(OLD, NEW);
  // The live shape of the 17 rows: re-keyed before per-run provenance existed.
  const stored = f.store.qaRun('legacy-1')!;
  const legacied = { ...stored } as Record<string, unknown>;
  delete legacied.submittedKey;
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(legacied), 'legacy-1');
  const row = f.store.qaRun('legacy-1')!;
  assert.equal(row.submittedKey, undefined);

  const ownership = f.classify(runView('legacy-1'), row, f.receipts);
  assert.equal(ownership.owner, 'project_qa', JSON.stringify(ownership));
  if (ownership.owner !== 'project_qa') return;
  assert.equal(ownership.key, OLD);
  assert.deepEqual(ownership.lineage.map(step => [step.from, step.to, step.receiptId]),
    [[OLD, NEW, applied.receipt.id]], 'the evidenced lineage is the applied step itself');
  // A step that left the checkout alone reconstructs it exactly, so the run must
  // name both the identity and that checkout.
  const exact = resolveQaCallerKey({ runId: 'legacy-1', caller: qaCallerIdentity(OLD, 'legacy-1'), qaRun: row,
    runRepository: { origin: OLD, path: OLD_PATH }, rekeys: f.receipts });
  assert.ok(!('reason' in exact));
  if ('reason' in exact) return;
  assert.deepEqual(exact.repository, { origin: OLD, path: OLD_PATH });
  const otherCheckout = resolveQaCallerKey({ runId: 'legacy-1', caller: qaCallerIdentity(OLD, 'legacy-1'), qaRun: row,
    runRepository: { origin: OLD, path: '/fixture/elsewhere' }, rekeys: f.receipts });
  assert.ok('reason' in otherCheckout, 'an unchanged checkout is compared exactly');
  assert.match(ownership.detail, new RegExp(`acme/old → acme/new at ${applied.receipt.at}`));
  assert.match(ownership.detail, /now acme\/new/);

  // The same row with the receipt gone has no exact-run evidence of its original
  // key: it stays unknown with the reason, and is never guessed back.
  f.store.db.prepare('DELETE FROM repository_rekeys WHERE id=?').run(applied.receipt.id);
  const withoutEvidence = f.classify(runView('legacy-1'), row, f.receipts);
  assert.equal(withoutEvidence.owner, 'unknown');
  if (withoutEvidence.owner === 'unknown') {
    assert.match(withoutEvidence.reason, /no applied repository re-key explains why its caller's key differs from acme\/new/);
    assert.doesNotMatch(withoutEvidence.reason, /owned by Project QA/);
  }
  // No receipt reader at all is the same absence, not an assumption.
  assert.equal(f.classify(runView('legacy-1'), row).owner, 'unknown');
});

test('a chained rename accepts only keys the verified chain establishes', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('chain-1'));
  const first = f.rekey(OLD, MID);
  const second = f.rekey(MID, NEW);
  // SQLite timestamps have millisecond precision. Pin both receipts to the same
  // instant so the chain must use their durable insertion order as its tie-break.
  const sameInstant = { ...second.receipt, at: first.receipt.at };
  f.store.db.prepare('UPDATE repository_rekeys SET at=?, data=? WHERE id=?')
    .run(sameInstant.at, JSON.stringify(sameInstant), second.receipt.id);
  const strip = (id: string) => {
    const stored = f.store.qaRun(id)! as Record<string, unknown>;
    delete stored.submittedKey;
    f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(stored), id);
  };
  strip('chain-1');
  const row = f.store.qaRun('chain-1')!;

  // The caller minted at submission names the first identity of a two-step chain.
  const ownership = f.classify(runView('chain-1'), row, f.receipts);
  assert.equal(ownership.owner, 'project_qa', JSON.stringify(ownership));
  if (ownership.owner !== 'project_qa') return;
  assert.equal(ownership.key, OLD);
  assert.deepEqual(ownership.lineage.map(step => [step.from, step.to, step.receiptId]),
    [[MID, NEW, second.receipt.id], [OLD, MID, first.receipt.id]], 'both moves are named, newest first');

  // A run submitted between the two moves names the intermediate identity, and
  // only the moves that happened after it are part of its lineage.
  const between = f.store.qaRun('chain-1')!;
  f.store.putQaRun(qaRow('between-1', { submittedAt: first.receipt.at }));
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify({
    ...between, id: 'between-1', submittedAt: first.receipt.at, startedAt: first.receipt.at,
  }), 'between-1');
  const resolved = resolveQaCallerKey({
    runId: 'between-1', caller: qaCallerIdentity(MID, 'between-1'), qaRun: f.store.qaRun('between-1')!, rekeys: f.receipts,
  });
  assert.ok(!('reason' in resolved), JSON.stringify(resolved));
  if ('reason' in resolved) return;
  assert.equal(resolved.key, MID);
  assert.equal(resolved.source, 'rekey_lineage');
  assert.deepEqual(resolved.lineage.map(step => step.receiptId), [second.receipt.id]);

  // A run that only appears after both moves cannot have been submitted under the
  // vacated first key, so that key does not authorise it.
  const late = qaRow('late-1', { key: NEW, origin: NEW, submittedAt: new Date(Date.parse(second.receipt.at) + 60_000).toISOString() });
  const lateResolved = resolveQaCallerKey({
    runId: 'late-1', caller: qaCallerIdentity(OLD, 'late-1'), qaRun: late, rekeys: f.receipts,
  });
  assert.ok('reason' in lateResolved, 'a stale key on a later run proves nothing');
  assert.match((lateResolved as { reason: string }).reason, /no applied repository re-key moved acme\/new after the run was submitted/);
});

test('a two-way swap through a temporary namespace still names the submitted key', async t => {
  const f = fixture(t);
  const temp = 'acme/temp-swap';
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('swap-1'));
  const out = f.rekey(OLD, temp);
  const back = f.rekey(temp, NEW);
  const stored = f.store.qaRun('swap-1')! as Record<string, unknown>;
  delete stored.submittedKey;
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(stored), 'swap-1');
  const ownership = f.classify(runView('swap-1'), f.store.qaRun('swap-1')!, f.receipts);
  assert.equal(ownership.owner, 'project_qa', JSON.stringify(ownership));
  if (ownership.owner !== 'project_qa') return;
  assert.equal(ownership.key, OLD, 'the temporary namespace is not mistaken for the submitted identity');
  assert.deepEqual(ownership.lineage.map(step => step.receiptId), [back.receipt.id, out.receipt.id]);
});

test('an out-and-back move through a temporary namespace is a net no-op for the walk', async t => {
  const f = fixture(t);
  const TEMP = 'acme/relocating';
  const TEMP_PATH = '/fixture/preserved';
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('trip-1'));
  const first = f.rekey(OLD, NEW);
  // The live shape (project-d, 2026-10-26): the first move predates per-run
  // provenance, so the round trip below records the already-moved key as the
  // "submitted" one, and the row then rests where it started the trip.
  const stripped = f.store.qaRun('trip-1')! as Record<string, unknown>;
  delete stripped.submittedKey;
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(stripped), 'trip-1');
  const out = f.rekey(NEW, TEMP, { path: TEMP_PATH });
  const back = f.rekey(TEMP, NEW, { path: TEMP_PATH });
  const row = f.store.qaRun('trip-1')!;
  assert.equal(row.key, NEW);
  assert.equal(row.submittedKey, NEW, 'the trip recorded the already-moved key as the submitted one');

  const ownership = f.classify(runView('trip-1'), row, f.receipts);
  assert.equal(ownership.owner, 'project_qa', JSON.stringify(ownership));
  if (ownership.owner !== 'project_qa') return;
  assert.equal(ownership.key, OLD, 'the walk skips the round trip and reaches the real ancestor');
  assert.deepEqual(ownership.lineage.map(step => step.receiptId), [first.receipt.id],
    'the evidenced lineage is the one step that moved the row, not the trip');
  assert.notEqual(out.receipt.id, back.receipt.id);

  // The trip moved the checkout, so the pre-trip checkout is unevidenced: the
  // identity alone is compared, and another repository is still refused.
  const foreign = f.classify(runView('trip-1', { origin: 'bob/beta' }), row, f.receipts);
  assert.equal(foreign.owner, 'unknown');
  // A caller naming the temporary namespace, or a key never held, is not placed.
  const temp = f.classify(runView('trip-1', { callerFor: TEMP }), row, f.receipts);
  assert.equal(temp.owner, 'unknown');
  const never = f.classify(runView('trip-1', { callerFor: 'acme/never' }), row, f.receipts);
  assert.equal(never.owner, 'unknown');
});

test('a run submitted after a re-key under the vacated key is unknown, and a foreign digest authorises nothing', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.patchRepository({ origin: 'bob/beta', path: '/fixture/shared' }, { closeout: 'queue', note: 'beta settings' });
  f.store.putQaRun(qaRow('before-1'));
  const applied = f.rekey(OLD, NEW);

  // Created after the re-key from stale configuration: its key names the vacated
  // identity, not its own repository, and the run postdates every move.
  const stale = qaRow('stale-1', { key: OLD, origin: NEW, submittedAt: new Date(Date.parse(applied.receipt.at) + 1_000).toISOString() });
  const staleOwnership = f.classify(runView('stale-1', { origin: NEW, callerFor: OLD }), stale, f.receipts);
  assert.equal(staleOwnership.owner, 'unknown');
  if (staleOwnership.owner === 'unknown')
    assert.match(staleOwnership.reason, /not the canonical milestone identity|name different repositories/);

  // Another repository that shares the checkout path and later holds the vacated
  // name: its own digest never authorises the re-keyed run, and the re-keyed
  // run's digest never authorises its row.
  f.store.putQaRun(qaRow('beta-1', { key: 'bob/beta', origin: 'bob/beta', path: '/fixture/shared' }));
  const beta = f.store.qaRun('beta-1')!;
  const foreign = f.classify(runView('beta-1', { origin: 'bob/beta', path: '/fixture/shared', callerFor: OLD }), beta, f.receipts);
  assert.equal(foreign.owner, 'unknown');
  if (foreign.owner === 'unknown') assert.match(foreign.reason, /is not the canonical milestone identity/);
  const hijack = f.classify(runView('beta-1', { origin: 'bob/beta', path: '/fixture/shared', callerFor: 'bob/beta' }),
    { ...beta, repository: { origin: NEW, path: OLD_PATH } }, f.receipts);
  assert.equal(hijack.owner, 'unknown');

  // A caller naming another run is not ownership, whatever its key.
  const wrongRun = f.classify(runView('before-1', { caller: qaCallerIdentity(OLD, 'another-run') }), f.store.qaRun('before-1')!, f.receipts);
  assert.equal(wrongRun.owner, 'unknown');
  if (wrongRun.owner === 'unknown') assert.match(wrongRun.reason, /is not the canonical milestone identity/);
});

test('the submitted key is bound by identity, and the epoch stays exact', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('shape-1'));
  f.rekey(OLD, NEW);
  const row = f.store.qaRun('shape-1')!;

  // The run's historical checkout path may legitimately differ: an explicit-path
  // re-key moves the checkout, and a checkout that had already moved before the run
  // was submitted is the run's own fact. The identity is what binds it.
  const otherPath = f.classify(runView('shape-1', { path: '/fixture/elsewhere' }), row, f.receipts);
  assert.equal(otherPath.owner, 'project_qa', JSON.stringify(otherPath));
  // A different repository identity is not the submitted key, whatever the path.
  const otherIdentity = f.classify(runView('shape-1', { origin: 'bob/beta', path: OLD_PATH }), row, f.receipts);
  assert.equal(otherIdentity.owner, 'unknown');
  if (otherIdentity.owner === 'unknown') assert.match(otherIdentity.reason, /name different repositories/);

  // A caller key the row never recorded is not accepted just because the run id matches.
  const invented = f.classify(runView('shape-1', { callerFor: 'carol/gamma' }), row, f.receipts);
  assert.equal(invented.owner, 'unknown');

  // Positive ownership still requires the pinned epoch the run now holds.
  const changedEpoch = f.classify(runView('shape-1', { epoch: 2 }), row, f.receipts);
  assert.equal(changedEpoch.owner, 'unknown');
  if (changedEpoch.owner === 'unknown') assert.match(changedEpoch.reason, /pins host-run epoch 1, not 2/);
  const unpinned = f.classify(runView('shape-1'), { ...row, hostRunEpoch: undefined }, f.receipts);
  assert.equal(unpinned.owner, 'unknown');
  if (unpinned.owner === 'unknown') assert.match(unpinned.reason, /does not pin the host-run epoch/);
});

test('reversed, missing, corrupt and ambiguous re-key evidence all hold instead of authorising', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.patchRepository({ origin: 'carol/gamma', path: '/fixture/gamma' }, { closeout: 'agent', note: 'gamma settings' });
  f.store.putQaRun(qaRow('ev-1'));
  const applied = f.rekey(OLD, NEW);
  const strip = () => {
    const stored = f.store.qaRun('ev-1')! as Record<string, unknown>;
    delete stored.submittedKey;
    f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(stored), 'ev-1');
  };
  strip();
  const row = () => f.store.qaRun('ev-1')!;

  // A caller naming the post-move identity is not this run's caller: the run's
  // own repository is the submitted identity, so a reversed claim is refused.
  const reversed = f.classify(runView('ev-1', { callerFor: NEW }), row(), f.receipts);
  assert.equal(reversed.owner, 'unknown');
  if (reversed.owner === 'unknown') assert.match(reversed.reason, /name different repositories/);

  // A corrupt receipt row cannot be read as the original key.
  f.store.db.prepare('INSERT INTO repository_rekeys(id,key,at,inputHash,data) VALUES(?,?,?,?,?)')
    .run('corrupt-receipt', 'corrupt', '2026-01-02T00:00:00.000Z', 'c'.repeat(64), '{"kind":"repository_rekey"}');
  const corrupt = f.classify(runView('ev-1'), row(), f.receipts);
  assert.equal(corrupt.owner, 'unknown');
  if (corrupt.owner === 'unknown') assert.match(corrupt.reason, /re-key receipts could not be read/);
  f.store.db.prepare('DELETE FROM repository_rekeys WHERE id=?').run('corrupt-receipt');

  // Two moves into the same identity recorded at one instant are ambiguous, so no
  // original key follows from them.
  const duplicated: RepositoryRekeyReceipt = { ...applied.receipt, source: { origin: 'carol/gamma', path: '/fixture/gamma' } };
  f.store.db.prepare('INSERT INTO repository_rekeys(id,key,at,inputHash,data) VALUES(?,?,?,?,?)')
    .run('duplicate-move', 'duplicate', duplicated.at, duplicated.inputHash, JSON.stringify(duplicated));
  const ambiguous = f.classify(runView('ev-1'), row(), f.receipts);
  assert.equal(ambiguous.owner, 'unknown');
  if (ambiguous.owner === 'unknown') assert.match(ambiguous.reason, /different moves into acme\/new .*ambiguous/);

  // A move into the vacated name by another repository afterwards never extends
  // this row's chain: the run predates it and its key never named that identity.
  f.store.db.prepare('DELETE FROM repository_rekeys WHERE id=?').run('duplicate-move');
  f.rekey('carol/gamma', OLD, { reason: 'gamma takes the vacated name' });
  for (const callerFor of [NEW, 'carol/gamma'] as const) {
    const late = f.classify(runView('ev-1', { callerFor }), row(), f.receipts);
    assert.equal(late.owner, 'unknown', `${callerFor} is not this run's submitted identity`);
  }
  // The authentic one is still accepted, now across the reused name.
  const authentic = f.classify(runView('ev-1'), row(), f.receipts);
  assert.equal(authentic.owner, 'project_qa', JSON.stringify(authentic));
  if (authentic.owner !== 'project_qa') return;
  assert.equal(authentic.key, OLD);
  assert.deepEqual(authentic.lineage.map(step => step.receiptId), [applied.receipt.id], 'the later reuse is not part of the lineage');
});

test('an explicit path move is reconstructed from the receipt, never guessed from the current path', async t => {
  const f = fixture(t);
  const NEW_PATH = '/fixture/new';
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('moved-1'));
  f.rekey(OLD, NEW, { path: NEW_PATH });
  const stored = f.store.qaRun('moved-1')!;
  assert.equal(stored.repository.path, NEW_PATH, 'the row moved with the checkout');
  const stripped = { ...stored } as Record<string, unknown>;
  delete stripped.submittedKey;
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(stripped), 'moved-1');
  const legacy = f.store.qaRun('moved-1')!;
  // Without per-run provenance the receipt lineage reconstructs the pre-move
  // identity *and* checkout, which the immutable host-run record names.
  const legacyOwnership = f.classify(runView('moved-1'), legacy, f.receipts);
  assert.equal(legacyOwnership.owner, 'project_qa', JSON.stringify(legacyOwnership));
  if (legacyOwnership.owner === 'project_qa')
    assert.deepEqual(legacyOwnership.lineage.map(step => [step.from, step.to]), [[OLD, NEW]]);
  const resolved = resolveQaCallerKey({ runId: 'moved-1', caller: qaCallerIdentity(OLD, 'moved-1'), qaRun: legacy,
    runRepository: { origin: OLD, path: OLD_PATH }, rekeys: f.receipts });
  assert.ok(!('reason' in resolved));
  if ('reason' in resolved) return;
  assert.equal(resolved.source, 'rekey_lineage');
  // A step that moved the checkout rewrote the row's path to the new one and its
  // receipt records the settings source path, not this row's previous checkout, so
  // the pre-move checkout is not established and is never guessed: the identity is.
  assert.deepEqual(resolved.repository, { origin: OLD, path: '' },
    'the receipt establishes the pre-move identity, and claims no checkout it cannot evidence');

  // The production write path: the same path-changing re-key *keeps* the recorded
  // submitted key, and the checkout the run records is the pre-move one. Both
  // orders of that historical fact are authentic, and neither may be refused.
  const kept = f.store.qaRun('moved-1')!;
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?')
    .run(JSON.stringify({ ...kept, submittedKey: OLD }), 'moved-1');
  const withProvenance = f.store.qaRun('moved-1')!;
  assert.equal(withProvenance.submittedKey, OLD);
  for (const run of [runView('moved-1'), runView('moved-1', { path: NEW_PATH })]) {
    const ownership = f.classify(run, withProvenance, f.receipts);
    assert.equal(ownership.owner, 'project_qa', `submitted ${run.repository.path}: ${JSON.stringify(ownership)}`);
    if (ownership.owner !== 'project_qa') continue;
    assert.equal(ownership.key, OLD);
    assert.equal(ownership.repository, NEW);
  }
  // Another repository at either checkout is still refused.
  const foreign = f.classify(runView('moved-1', { origin: 'bob/beta', path: OLD_PATH }), withProvenance, f.receipts);
  assert.equal(foreign.owner, 'unknown');
  if (foreign.owner === 'unknown') assert.match(foreign.reason, /name different repositories/);
});

test('a positively owned re-keyed run leaves the QA producer’s own logs untouched', async t => {
  const f = fixture(t);
  const qaRoot = join(f.dir, 'qa-logs');
  mkdirSync(qaRoot, { recursive: true });
  const log = join(qaRoot, 'qa.stdout.log');
  writeFileSync(log, 'qa output\n');
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('logs-1'));
  f.rekey(OLD, NEW);
  const ownership = f.classify(runView('logs-1'), f.store.qaRun('logs-1')!, f.receipts);
  assert.equal(ownership.owner, 'project_qa');
  assert.equal(readFileSync(log, 'utf8'), 'qa output\n', 'attribution never reads, moves or rewrites a QA step log');
});

test('the provenance check reads receipts lazily and only when the current key cannot answer', async t => {
  const f = fixture(t);
  f.store.putQaRun(qaRow('current-1'));
  let reads = 0;
  const counted = () => { reads += 1; return f.receipts(); };
  const current = f.classify(runView('current-1'), f.store.qaRun('current-1')!, counted);
  assert.equal(current.owner, 'project_qa');
  assert.equal(reads, 0, 'an ordinary run never reads the re-key receipts');
  const unknown = f.classify(runView('current-1', { callerFor: NEW }), f.store.qaRun('current-1')!, counted);
  assert.equal(unknown.owner, 'unknown');
  assert.equal(reads, 1, 'a caller the stored key cannot answer reads them once');
});

test('a host-run record schema round-trips the QA row’s recorded provenance', async t => {
  const f = fixture(t);
  f.store.patchRepository({ origin: OLD, path: OLD_PATH }, { closeout: 'agent', note: 'old settings' });
  f.store.putQaRun(qaRow('round-trip-1'));
  f.rekey(OLD, NEW);
  // The QA row stays a strict contract record with the additive field, and a
  // contract-010 run row is untouched history that still names the old identity.
  const parsed = projectQaRunSchema.parse(JSON.parse(JSON.stringify(f.store.qaRun('round-trip-1'))));
  assert.equal(parsed.submittedKey, OLD);
  const run = hostRunRecordSchema.parse({
    id: 'round-trip-1', epoch: 1, caller: qaCallerIdentity(OLD, 'round-trip-1'),
    repository: { origin: OLD, path: OLD_PATH }, selector: 'qa', runClass: 'heavy', classSource: 'default',
    priority: 'milestone', state: 'settled', submittedAt: STAMP, capacityDeadlineAt: STAMP, runTimeoutMs: 1_000,
    budgetFallback: { cpu: 1, memoryBytes: 1 }, budget: { cpu: 1, memoryBytes: 1, wallMs: 1_000, source: 'history' },
    position: null, admittedAt: STAMP, launchedAt: STAMP, settledAt: STAMP, capacitySample: null, pid: 1,
    processGroupId: 1, startIdentity: '1@x', settlement: null, wallMs: 1_000, cpuMs: 1, containers: [],
    capacityReleasedAt: STAMP, capacityReleaseReason: 'settled', capacityReleaseKind: 'automatic',
  });
  assert.equal(run.caller, qaCallerIdentity(OLD, 'round-trip-1'));
});
