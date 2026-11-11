/**
 * Spec 056: the repository namespace re-key's sequence, swap, refusal,
 * fault-injection and restart proofs.
 *
 * Tom's Full swap (2026-10-20) is a two-step sequence, not one rename: the
 * desktop repository moves to a desktop-final name, then the CLI repository
 * takes the now-vacant name. Each step is independently atomic and idempotent,
 * collisions refuse at every step, and no old desktop number ever resolves into
 * the CLI repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Store, digest } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';
import { suggestedRepositoryRekeyKey, type RepositoryRekeyPreview } from '../shared/repository-rekey';
import { projectQaRunSchema } from '../shared/contracts';

/** Pre-708 `server/repository-rekey.ts` at planning `26f80ef0`. */
const PARENT_REKEY_BLOB = 'b7851721bcd437b2fba3b81b98302759f63313f3';
const PARENT_REKEY_COMMIT = '26f80ef006f65ea87f81a4a62eeb720ce311590f';

const A = { origin: 'inflatable-cookie/project-d', path: '/fixture/project-d' };
const A_FINAL = { origin: 'inflatable-cookie/project-d-desktop', path: '' };
const B = { origin: 'inflatable-cookie/project-d-cli', path: '/fixture/project-d-cli' };

function fixture(label = 'seq') {
  const dir = mkdtempSync(join(tmpdir(), `queue-rekey-${label}-`));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  let sequence = 0;
  return {
    dir, path,
    get store() { return store; },
    task(origin: string, repoPath: string) {
      const id = `submission-${++sequence}`;
      const input = submissionSchema.parse({ submissionId: id, title: `Task ${id}`, repoPath,
        planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
      return store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, origin);
    },
    finish(id: string) { store.update(id, { phase: 'done' }, 'done'); },
    /** A settled milestone QA run for this repository: the row a re-key retargets. */
    qa(id: string, repository: { origin: string; path: string }) {
      const run = projectQaRunSchema.parse({
        id, repository, key: repository.origin, state: 'passed', baseBranch: 'main', base: 'f'.repeat(40),
        argv: ['effigy', 'qa'], digest: 'a'.repeat(64), pid: null, capacityWait: null, capacityUnavailable: false,
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:10:00.000Z', exitCode: 0, durationMs: 600_000,
        steps: [], escapedDescendants: [], outputTail: 'green', submittedAt: '2026-01-01T00:00:00.000Z', hostRunEpoch: 1,
      });
      store.putQaRun(run);
      return run;
    },
    reopen() { store.close(); store = new Store(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A complete re-key input against the row a fixture just wrote. */
const step = (store: Store, source: string, target: { origin: string; path?: string }, reason = 'rename') => ({
  source, target,
  expectedSourceRevision: store.repositoryFor(source)?.revision ?? null,
  reason, author: 'operator', idempotencyKey: suggestedRepositoryRekeyKey({ source, target }),
});

test('Spec 056 desktop-final then CLI-takes-name: two atomic steps, no cross association', () => {
  const f = fixture('sequence');
  try {
    const store = f.store;
    store.patchRepository(A, { closeout: 'agent', note: 'desktop settings' });
    store.patchRepository(B, { closeout: 'queue', note: 'cli settings' });
    const desktopOne = f.task(A.origin, A.path);
    const desktopTwo = f.task(A.origin, A.path);
    const cliOne = f.task(B.origin, B.path);
    f.finish(desktopOne.id); f.finish(desktopTwo.id); f.finish(cliOne.id);
    assert.deepEqual([store.task(desktopOne.id).reference, store.task(desktopTwo.id).reference], ['project-d#001', 'project-d#002']);
    assert.equal(store.task(cliOne.id).reference, 'project-d-cli#001');
    // A settled contract-010 host run is history and never occupies a name. Without
    // this rule the documented Full swap could never pass step 2 for a repository
    // that ever ran QA.
    const hostRun = (id: string, repository: { origin: string; path: string }, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ id, repository, selector: 'qa', priority: 'milestone', submittedAt: '2026-01-01T00:00:00.000Z', ...extra });
    const settledHostRun = hostRun('host-desktop', { origin: A.origin, path: A.path }, { state: 'settled', capacityReleasedAt: '2026-01-01T00:05:00.000Z' });
    store.db.prepare('INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
      .run('host-desktop', A.origin, 'settled', settledHostRun);

    // The CLI may not take the desktop's name while the desktop still holds it.
    assert.throws(() => store.rekeyRepository(step(store, B.origin, { origin: A.origin })), /target_occupied/);
    assert.equal(store.repositoryFor(B.origin)?.note, 'cli settings');

    // Step 1: desktop A -> desktop-final, one atomic step.
    const first = store.rekeyRepository(step(store, A.origin, A_FINAL, 'desktop archive to desktop-final'));
    assert.equal(first.receipt.source.origin, A.origin);
    assert.equal(first.receipt.target.origin, A_FINAL.origin);
    assert.equal(store.repositoryFor(A.origin), null);
    assert.equal(store.repositoryFor(A_FINAL.origin)?.note, 'desktop settings');
    assert.deepEqual([store.task(desktopOne.id).reference, store.task(desktopTwo.id).reference],
      ['project-d-desktop#001', 'project-d-desktop#002']);
    assert.equal(store.task(cliOne.id).reference, 'project-d-cli#001', 'the CLI is untouched by the desktop step');

    // Step 2: the CLI takes the now-vacant name and starts its own numbering: its own
    // counter continues at 2, never at the desktop's 3 and never at 1.
    const second = store.rekeyRepository(step(store, B.origin, { origin: A.origin }, 'cli takes the product name'));
    assert.equal(second.receipt.numbering.sourceNext, 2);
    assert.equal(second.receipt.numbering.targetNext, 2);
    assert.equal(store.repositoryFor(A.origin)?.note, 'cli settings');
    assert.equal(store.repositoryFor(B.origin), null);
    assert.equal(store.task(cliOne.id).reference, 'project-d#001');
    const cliTwo = f.task(A.origin, B.path);
    assert.equal(store.task(cliTwo.id).reference, 'project-d#002', 'the CLI counter continues from its own number');
    assert.equal(store.task(desktopTwo.id).reference, 'project-d-desktop#002', 'desktop numbers stay in desktop-final');

    // No old desktop number resolves into the CLI repository.
    assert.equal(store.taskIdByNumber({ reference: 'project-d#1' }), cliOne.id);
    assert.equal(store.taskIdByNumber({ reference: 'project-d-desktop#1' }), desktopOne.id);
    assert.notEqual(store.taskIdByNumber({ reference: 'project-d#1' }), desktopOne.id);

    // The CLI's counter never absorbed a desktop number: a fresh desktop task
    // still numbers in desktop-final.
    store.update(desktopTwo.id, { phase: 'done' }, 'done');
    const desktopThree = f.task(A_FINAL.origin, A.path);
    assert.equal(store.task(desktopThree.id).reference, 'project-d-desktop#003');

    // Settled host-run evidence stays exactly as written, and a repository that
    // later takes the vacated name is not blocked by it.
    assert.equal(store.db.prepare('SELECT data FROM host_run_records WHERE id=?').get('host-desktop')!.data, settledHostRun);
    assert.equal(store.db.prepare('SELECT repository FROM host_run_records WHERE id=?').get('host-desktop')!.repository, A.origin);
    assert.equal(store.db.prepare('SELECT repository FROM host_run_records WHERE id=?').get('host-desktop')!.repository, A.origin,
      'the historical column is never retargeted at the CLI');
  } finally { f.close(); }
});

test('Spec 056 a genuine two-way swap needs an unused temporary namespace, one step at a time', () => {
  const f = fixture('swap');
  try {
    const store = f.store;
    const one = { origin: 'org/one', path: '/fixture/one' };
    const two = { origin: 'org/two', path: '/fixture/two' };
    const temp = { origin: 'org/temp-swap', path: '' };
    store.patchRepository(one, { closeout: 'agent', note: 'one' });
    store.patchRepository(two, { closeout: 'agent', note: 'two' });
    const oneTask = f.task(one.origin, one.path);
    const twoTask = f.task(two.origin, two.path);
    f.finish(oneTask.id); f.finish(twoTask.id);

    // A direct swap has no occupied-target exception.
    assert.throws(() => store.rekeyRepository(step(store, one.origin, { origin: two.origin })), /target_occupied/);
    assert.throws(() => store.rekeyRepository(step(store, two.origin, { origin: one.origin })), /target_occupied/);
    assert.equal(store.repositoryFor(one.origin)?.note, 'one');
    assert.equal(store.repositoryFor(two.origin)?.note, 'two');

    store.rekeyRepository(step(store, one.origin, temp));
    store.rekeyRepository(step(store, two.origin, { origin: one.origin }));
    store.rekeyRepository(step(store, temp.origin, { origin: two.origin }));
    assert.equal(store.repositoryFor(one.origin)?.note, 'two');
    assert.equal(store.repositoryFor(two.origin)?.note, 'one');
    assert.equal(store.repositoryFor(temp.origin), null);
    assert.equal(store.task(oneTask.id).reference, 'two#001');
    assert.equal(store.task(twoTask.id).reference, 'one#001');
    assert.equal(store.taskIdByNumber({ reference: 'one#1' }), twoTask.id);
    assert.equal(store.taskIdByNumber({ reference: 'two#1' }), oneTask.id);
    assert.equal(store.repositoryRekeys().length, 3);
  } finally { f.close(); }
});

test('Spec 056 refusals: unknown, equal, number-only, path, active work, drafts and drift all leave no mutation', () => {
  const f = fixture('refusals');
  try {
    const store = f.store;
    store.patchRepository(A, { closeout: 'agent', note: 'alpha' });
    f.qa('qa-alpha', A);
    const active = f.task(A.origin, A.path);
    const snapshot = () => JSON.stringify({
      settings: store.repositories(), numbers: store.db.prepare('SELECT * FROM task_numbers ORDER BY task_id').all(),
      counters: store.db.prepare('SELECT * FROM task_number_counters ORDER BY repository').all(),
      projects: store.projects(), tasks: store.db.prepare('SELECT id,data FROM tasks ORDER BY id').all(),
      qa: store.db.prepare('SELECT id,repository,data FROM project_qa_runs ORDER BY id').all(),
      receipts: store.repositoryRekeys(),
    });
    const refuse = (input: ReturnType<typeof step>, pattern: RegExp) => {
      const before = snapshot();
      assert.throws(() => store.rekeyRepository(input), pattern);
      assert.equal(snapshot(), before, `refusal ${pattern} wrote nothing`);
      assert.equal(store.repositoryRekeys().length, 0);
    };

    refuse(step(store, 'nobody/nothing', { origin: 'nobody/else' }), /unknown_source/);
    refuse(step(store, A.origin, { origin: A.origin }), /source_equals_target/);
    refuse(step(store, A.origin, { origin: 'not an origin' }), /invalid_target/);
    // Active work under the source refuses.
    refuse(step(store, A.origin, { origin: 'org/next' }), /active_tasks/);
    f.finish(active.id);
    // An unsettled operation that could still write under the source refuses.
    store.db.prepare('INSERT INTO operations(id,key,kind,inputHash,state,taskId,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(digest('op-active'), 'op-active', 'submit', digest('x'), 'running', null, '2026-01-01T00:00:00.000Z',
        JSON.stringify({ type: 'submit', submission: { repoPath: A.path } }), JSON.stringify({ repoPath: A.path, state: 'running' }));
    refuse(step(store, A.origin, { origin: 'org/next' }), /active_operations/);
    store.db.prepare("UPDATE operations SET state='succeeded' WHERE key=?").run('op-active');

    // Unsettled host-run custody refuses; settled and released history does not.
    const hostRow = (id: string, state: string, data: Record<string, unknown>) =>
      store.db.prepare('INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
        .run(id, A.origin, state, JSON.stringify({ id, repository: { origin: A.origin, path: A.path }, selector: 'qa', ...data }));
    hostRow('host-running', 'running', {});
    refuse(step(store, A.origin, { origin: 'org/next' }), /active_host_runs/);
    store.db.prepare('DELETE FROM host_run_records WHERE id=?').run('host-running');
    hostRow('host-held-capacity', 'settled', { capacityReleasedAt: null });
    refuse(step(store, A.origin, { origin: 'org/next' }), /active_host_runs/);
    store.db.prepare('DELETE FROM host_run_records WHERE id=?').run('host-held-capacity');

    // A target that only appears in numbering history is still occupied.
    store.db.prepare('INSERT INTO task_number_counters(repository,next_number) VALUES(?,?)').run('org/purged', 4);
    refuse(step(store, A.origin, { origin: 'org/purged' }), /target_occupied/);
    store.db.prepare('DELETE FROM task_number_counters WHERE repository=?').run('org/purged');

    // A target path used by another repository refuses too.
    store.patchRepository({ origin: 'org/other', path: '/fixture/other' }, { note: 'other' });
    refuse(step(store, A.origin, { origin: 'org/next', path: '/fixture/other' }), /path_occupied/);

    // A revision observed before a concurrent settings write refuses.
    const stale = { ...step(store, A.origin, { origin: 'org/next' }), expectedSourceRevision: store.repositoryFor(A.origin)!.revision };
    store.patchRepository(A, { note: 'changed underneath' });
    const before = snapshot();
    assert.throws(() => store.rekeyRepository(stale), /source_revision_changed/);
    assert.equal(snapshot(), before);
  } finally { f.close(); }
});

test('Spec 056 fault injection at a family write and at the receipt rolls the whole step back', () => {
  const f = fixture('faults');
  try {
    const store = f.store;
    store.patchRepository(A, { closeout: 'agent', note: 'alpha' });
    const done = f.task(A.origin, A.path);
    f.finish(done.id);
    f.qa('qa-fault', A);
    const snapshot = () => JSON.stringify({ settings: store.repositories(), counters: store.db.prepare('SELECT * FROM task_number_counters').all(),
      numbers: store.db.prepare('SELECT * FROM task_numbers ORDER BY task_id').all(), receipts: store.repositoryRekeys(),
      tasks: store.db.prepare('SELECT id,data FROM tasks ORDER BY id').all(),
      qa: store.db.prepare('SELECT id,repository,data FROM project_qa_runs ORDER BY id').all() });
    const before = snapshot();

    // Fail a family write near the end of the transaction.
    store.db.exec(`CREATE TRIGGER rekey_fault BEFORE UPDATE ON qa_schedule_merges BEGIN SELECT RAISE(ABORT,'injected family fault'); END`);
    store.db.prepare('INSERT INTO qa_schedule_merges(taskId,repository) VALUES(?,?)').run(done.id, A.origin);
    const withMerge = snapshot();
    const faulted = step(store, A.origin, { origin: 'org/next' });
    assert.throws(() => store.rekeyRepository(faulted), /injected family fault/);
    assert.equal(snapshot(), withMerge, 'no partial switch after the fault, including the QA row the step had already moved');
    assert.equal(store.qaRun('qa-fault')?.key, A.origin);
    assert.equal(store.qaRun('qa-fault')?.submittedKey, undefined, 'a rolled-back step records no provenance');
    assert.equal(store.repositoryRekeyReceipt({ key: faulted.idempotencyKey }), null);
    store.db.exec('DROP TRIGGER rekey_fault');
    store.db.prepare('DELETE FROM qa_schedule_merges WHERE taskId=?').run(done.id);
    assert.equal(before, withMerge);

    // Fail the receipt write itself (last statement in the transaction).
    const id = digest(`repository-rekey\n${faulted.idempotencyKey}`);
    store.db.prepare('INSERT INTO repository_rekeys(id,key,at,inputHash,data) VALUES(?,?,?,?,?)')
      .run(id, 'someone-elses-key', '2026-01-01T00:00:00.000Z', digest('other'), JSON.stringify({ marker: true }));
    assert.throws(() => store.rekeyRepository(faulted), /UNIQUE|constraint/i);
    store.db.prepare('DELETE FROM repository_rekeys WHERE id=?').run(id);
    assert.equal(snapshot(), withMerge, 'a receipt failure leaves the records untouched, QA provenance included');

    // The same step then applies cleanly and survives a restart.
    const applied = store.rekeyRepository(faulted);
    f.reopen();
    const reopened = f.store;
    assert.equal(reopened.repositoryRekeyReceipt({ id: applied.receipt.id })?.target.origin, 'org/next');
    assert.equal(reopened.repositoryFor('org/next')?.note, 'alpha');
    assert.equal(reopened.qaRun('qa-fault')?.key, 'org/next');
    assert.equal(reopened.qaRun('qa-fault')?.submittedKey, A.origin, 'the QA provenance is durable with the receipt');
    assert.equal(reopened.task(done.id).reference, 'next#001');
    assert.equal(reopened.rekeyRepository(faulted).replayed, true);
  } finally { f.close(); }
});

test('Spec 056 an explicit target path moves the path hints; an origin-only step keeps them', () => {
  const f = fixture('paths');
  try {
    const store = f.store;
    store.patchRepository(A, { closeout: 'agent', note: 'alpha' });
    const done = f.task(A.origin, A.path);
    f.finish(done.id);
    const applied = store.rekeyRepository(step(store, A.origin, { origin: 'org/moved', path: '/fixture/moved' }));
    assert.equal(applied.receipt.pathChanged, true);
    assert.equal(store.task(done.id).repoPath, '/fixture/moved');
    assert.equal(store.repositoryFor('org/moved')?.repository.path, '/fixture/moved');

    // An origin-only step never rewrites a path hint.
    const second = store.rekeyRepository(step(store, 'org/moved', { origin: 'org/moved-again' }));
    assert.equal(second.receipt.pathChanged, false);
    assert.equal(store.task(done.id).repoPath, '/fixture/moved');
    assert.equal(store.repositoryFor('org/moved-again')?.repository.path, '/fixture/moved');
  } finally { f.close(); }
});

test('Spec 056 parent falsification: without the re-key the vacated name absorbs the old numbering', () => {
  const f = fixture('parent');
  try {
    const store = f.store;
    store.patchRepository(A, { closeout: 'agent', note: 'desktop' });
    const desktop = f.task(A.origin, A.path);
    f.finish(desktop.id);
    // Without a re-key the desktop's counter still answers for the vacated name, so a
    // repository that later claims it silently continues the desktop's numbering.
    assert.equal(store.repositoryFor(A.origin)?.note, 'desktop');
    const collided = f.task(A.origin, '/fixture/other-product');
    assert.equal(store.task(collided.id).reference, 'project-d#002', 'unrekeyed history is absorbed by the new claimant');
    // Re-keying the desktop first is what makes the vacated name genuinely free.
    const g = fixture('parent-fixed');
    try {
      g.store.patchRepository(A, { closeout: 'agent', note: 'desktop' });
      const original = g.task(A.origin, A.path);
      g.finish(original.id);
      g.store.rekeyRepository(step(g.store, A.origin, A_FINAL));
      const fresh = g.task(A.origin, '/fixture/cli');
      assert.equal(g.store.task(original.id).reference, 'project-d-desktop#001');
      assert.equal(g.store.task(fresh.id).reference, 'project-d#001', 'the re-keyed history starts the new claimant at one');
    } finally { g.close(); }
  } finally { f.close(); }
});

test('Spec 056 a path-only repository gains an origin without losing its numbering', () => {
  const f = fixture('pathonly');
  try {
    const store = f.store;
    const local = '/fixture/local-only';
    const task = f.task(local, local);
    f.finish(task.id);
    assert.equal(store.task(task.id).reference, 'local-only#001');
    assert.equal(store.task(task.id).repository, local);
    store.patchRepository({ origin: null, path: local }, { closeout: 'agent', note: 'local settings' });

    const applied = store.rekeyRepository(step(store, local, { origin: 'org/published', path: '/fixture/published' }));
    assert.equal(applied.receipt.source.origin, null);
    assert.equal(applied.receipt.source.path, local);
    assert.equal(applied.receipt.target.origin, 'org/published');
    assert.equal(applied.receipt.numbering.targetNext, 2);
    assert.equal(store.task(task.id).repository, 'org/published');
    assert.equal(store.task(task.id).repoPath, '/fixture/published');
    assert.equal(store.task(task.id).reference, 'published#001');
    assert.equal(store.repositoryFor('org/published')?.note, 'local settings');
    assert.equal(store.repositoryFor('org/published')?.repository.path, '/fixture/published');
    assert.equal(store.db.prepare('SELECT next_number FROM task_number_counters WHERE repository=?').get('org/published')?.next_number, 2);
    assert.equal(store.db.prepare('SELECT next_number FROM task_number_counters WHERE repository=?').get(local), undefined);
  } finally { f.close(); }
});

test('Spec 056 a path match never absorbs another known-origin repository (putRepository rule)', () => {
  const f = fixture('sharedpath');
  try {
    const store = f.store;
    // Two origin-known repositories deliberately share one checkout path — the
    // shape a reused or nested checkout produces, and the one putRepository
    // already refuses to merge.
    const shared = '/fixture/shared';
    const alpha = { origin: 'alice/alpha', path: shared };
    const beta = { origin: 'bob/beta', path: shared };
    store.patchRepository(alpha, { closeout: 'agent', note: 'alpha settings' });
    store.patchRepository(beta, { closeout: 'queue', note: 'beta settings' });
    const alphaTask = f.task(alpha.origin, shared);
    const betaTask = f.task(beta.origin, shared);
    f.finish(alphaTask.id); f.finish(betaTask.id);
    const qaRun = (id: string, repository: { origin: string; path: string }) => projectQaRunSchema.parse({
      id, repository, key: repository.origin, state: 'passed', baseBranch: 'main', base: 'f'.repeat(40),
      argv: ['effigy', 'qa'], digest: 'a'.repeat(64), pid: null, capacityWait: null, capacityUnavailable: false,
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:10:00.000Z', exitCode: 0, durationMs: 600000,
      steps: [], escapedDescendants: [], outputTail: 'green', submittedAt: '2026-01-01T00:00:00.000Z',
    });
    store.putQaRun(qaRun('qa-alpha', { origin: alpha.origin, path: shared }));
    store.putQaRun(qaRun('qa-beta', { origin: beta.origin, path: shared }));

    // Naming the shared checkout path cannot choose between two origin-known
    // repositories: it refuses instead of guessing.
    const before = JSON.stringify({ settings: store.repositories(), tasks: store.db.prepare('SELECT id,data FROM tasks ORDER BY id').all(),
      qa: store.db.prepare('SELECT id,repository,data FROM project_qa_runs ORDER BY id').all() });
    assert.throws(() => store.rekeyRepository(step(store, shared, { origin: 'alice/omega' })), /ambiguous_source/);
    assert.equal(JSON.stringify({ settings: store.repositories(), tasks: store.db.prepare('SELECT id,data FROM tasks ORDER BY id').all(),
      qa: store.db.prepare('SELECT id,repository,data FROM project_qa_runs ORDER BY id').all() }), before);

    // An explicit-path re-key of A moves only A's rows, even though B's rows sit
    // on the same checkout path.
    const applied = store.rekeyRepository(step(store, alpha.origin, { origin: 'alice/omega', path: '/fixture/omega' }));
    assert.equal(applied.receipt.counts.tasks, 1, 'only the alpha task follows alpha');
    assert.equal(applied.receipt.counts.projectQaRuns, 1, 'only the alpha QA run moves');

    assert.equal(store.task(alphaTask.id).repository, 'alice/omega');
    assert.equal(store.task(alphaTask.id).repoPath, '/fixture/omega');
    assert.equal(store.task(betaTask.id).repository, beta.origin);
    assert.equal(store.task(betaTask.id).repoPath, shared, 'beta repoPath is untouched');
    assert.equal(store.task(betaTask.id).reference, 'beta#001');


    assert.equal(store.latestQaRun(beta.origin)?.id, 'qa-beta', 'beta keeps its QA routing column');
    assert.equal(store.latestQaRun(beta.origin)?.repository.path, shared);
    assert.equal(store.latestQaRun(beta.origin)?.key, beta.origin);
    assert.equal(store.latestQaRun('alice/omega')?.id, 'qa-alpha');
    assert.equal(store.latestQaRun('alice/omega')?.repository.path, '/fixture/omega');
    assert.equal(store.latestQaRun('alice/omega')?.key, 'alice/omega');
    assert.equal(store.latestQaRun('alice/omega')?.submittedKey, alpha.origin, 'the moved QA row records its submitted key');
    assert.equal(store.latestQaRun(beta.origin)?.submittedKey, undefined, 'the untouched QA row records none');

    // Beta's settings and numbering are untouched; only the origin that moved is gone.
    assert.equal(store.repositoryFor(beta.origin)?.note, 'beta settings');
    assert.equal(store.repositoryFor(alpha.origin), null);
    assert.equal(store.repositoryFor('alice/omega')?.note, 'alpha settings');
    assert.equal(store.db.prepare('SELECT next_number FROM task_number_counters WHERE repository=?').get(beta.origin)?.next_number, 2);
  } finally { f.close(); }
});

test('Spec 056 a path-only step moves every family\'s path hint, including an empty settings path', () => {
  const f = fixture('pathmove');
  try {
    const store = f.store;
    const origin = 'alice/nucleus';
    const oldPath = '/fixture/paseo-northstar-queue';
    const newPath = '/fixture/nucleus';
    const other = { origin: 'bob/other', path: oldPath };
    // Live shape: settings.path is empty while tasks, QA and planning rows still
    // carry the checkout. The next test loads the pre-708 implementation and
    // proves that same request refused before any of those rows could move.
    store.patchRepository({ origin, path: '' }, { closeout: 'agent', note: 'nucleus settings' });
    store.patchRepository(other, { closeout: 'queue', note: 'other settings' });
    const done = f.task(origin, oldPath);
    const otherTask = f.task(other.origin, other.path);
    f.finish(done.id); f.finish(otherTask.id);
    assert.equal(store.repositoryFor(origin)?.repository.path, '', 'settings path stays empty until the step');
    assert.equal(store.task(done.id).repoPath, oldPath);

    store.upsertProject({
      key: 'nucleus-suite', name: 'Nucleus',
      repositories: [{ origin, path: oldPath }, { origin: other.origin, path: other.path }],
      primary: { origin, path: oldPath },
    });
    store.upsertLane({ key: 'general', title: 'General', aim: 'keep it moving',
      repositories: [{ origin, path: oldPath }, { origin: other.origin, path: other.path }] });
    store.addLead({
      id: 'lead-path', title: 'Path lead', body: 'unchanged', repositories: [{ origin, path: oldPath }],
      lanes: ['general'], targets: [{ kind: 'task', repository: origin, reference: done.id, at: '2026-01-01T00:00:00.000Z' }],
      state: 'open', author: 'operator', version: 1, dropReason: null, source: null, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', closedAt: null,
    } as never, 'operator');
    store.addDecision({
      id: 'decision-path', version: 1, question: 'Move the checkout?',
      askedBy: { agentId: 'origin', project: { origin, path: oldPath } },
      links: { tasks: [], leads: [], papercuts: [] }, status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    f.qa('qa-path', { origin, path: oldPath });
    store.db.prepare('INSERT INTO qa_schedule_merges(taskId,repository,coveredRun,attemptedRun,checkedGreenRun) VALUES(?,?,?,?,?)')
      .run(done.id, origin, null, null, null);
    store.db.prepare('INSERT INTO project_tombstones(key,data) VALUES(?,?)')
      .run('retired-suite', JSON.stringify({ key: 'retired-suite', repositories: [{ origin, path: oldPath }], reason: 'retired', removedAt: '2026-01-01T00:00:00.000Z' }));

    const nextBefore = store.db.prepare('SELECT next_number FROM task_number_counters WHERE repository=?').get(origin)?.next_number;
    const request = step(store, origin, { origin, path: newPath }, 'move checkout without renaming');
    const preview = store.previewRepositoryRekey({ source: request.source, target: request.target,
      expectedSourceRevision: request.expectedSourceRevision, reason: request.reason, idempotencyKey: request.idempotencyKey });
    assert.equal(preview.ready, true, JSON.stringify(preview.refusals));
    assert.equal(preview.pathChanged, true);
    assert.equal(preview.source.origin, origin);
    assert.equal(preview.source.path, oldPath, 'derived from the records when settings.path is empty');
    assert.equal(preview.target.origin, origin);
    assert.equal(preview.target.path, newPath);
    assert.equal(preview.numbering.sourceNext, nextBefore);
    assert.equal(preview.numbering.targetNext, nextBefore);
    assert.equal(preview.counts.repositorySettings, 1);
    assert.equal(preview.counts.tasks, 1);
    assert.equal(preview.counts.outcomes, 1);
    assert.equal(preview.counts.leads, 1);
    assert.equal(preview.counts.lanes, 1);
    assert.equal(preview.counts.decisions, 1);
    assert.equal(preview.counts.projects, 1);
    assert.equal(preview.counts.projectTombstones, 1);
    assert.equal(preview.counts.projectQaRuns, 1);
    assert.equal(preview.counts.qaScheduleMerges, 1);
    assert.equal(preview.counts.taskNumberCounters, 1);
    assert.equal(preview.counts.taskNumbers, 1);

    const applied = store.rekeyRepository(request);
    assert.equal(applied.replayed, false);
    assert.equal(applied.receipt.pathChanged, true);
    assert.equal(applied.receipt.source.path, oldPath);
    assert.equal(applied.receipt.target.path, newPath);
    assert.equal(applied.receipt.numbering.sourceNext, nextBefore);
    assert.equal(applied.receipt.numbering.targetNext, nextBefore);
    assert.equal(store.db.prepare('SELECT next_number FROM task_number_counters WHERE repository=?').get(origin)?.next_number, nextBefore);
    assert.equal(store.db.prepare('SELECT repository FROM task_numbers WHERE task_id=?').get(done.id)?.repository, origin);
    assert.equal(store.task(done.id).reference, 'nucleus#001');
    assert.equal(store.task(done.id).repository, origin);
    assert.equal(store.task(done.id).repoPath, newPath, 'empty settings path still moved the task repoPath');
    assert.equal(store.repositoryFor(origin)?.repository.origin, origin);
    assert.equal(store.repositoryFor(origin)?.repository.path, newPath);
    assert.equal(store.outcome(done.id)?.repository.origin, origin);
    assert.equal(store.outcome(done.id)?.repository.path, newPath);
    assert.equal(store.lead('lead-path').repositories[0].origin, origin);
    assert.equal(store.lead('lead-path').repositories[0].path, newPath);
    assert.equal(store.lead('lead-path').targets[0].repository, origin);
    assert.equal(store.laneByKey('general')?.repositories.find(repo => repo.origin === origin)?.path, newPath);
    assert.equal(store.decision('decision-path').askedBy.project?.origin, origin);
    assert.equal(store.decision('decision-path').askedBy.project?.path, newPath);
    const project = store.projectFor(newPath, origin);
    assert.equal(project?.key, 'nucleus-suite');
    assert.equal(project?.primary.origin, origin);
    assert.equal(project?.primary.path, newPath);
    assert.equal(project?.repositories.find(repo => repo.origin === origin)?.path, newPath);
    assert.equal(store.projectTombstones().find(item => item.key === 'retired-suite')?.repositories[0].origin, origin);
    assert.equal(store.projectTombstones().find(item => item.key === 'retired-suite')?.repositories[0].path, newPath);
    assert.equal(store.qaRun('qa-path')?.repository.origin, origin);
    assert.equal(store.qaRun('qa-path')?.repository.path, newPath);
    assert.equal(store.qaRun('qa-path')?.key, origin, 'a path-only step does not move the QA key');
    assert.equal(store.qaScheduleMerges(origin).length, 1);

    assert.equal(store.task(otherTask.id).repository, other.origin);
    assert.equal(store.task(otherTask.id).repoPath, oldPath, 'another origin at the old path is untouched');
    assert.equal(store.repositoryFor(other.origin)?.repository.path, oldPath);

    const replay = store.rekeyRepository(request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, applied.receipt);
  } finally { f.close(); }
});

test('Spec 056 same origin with no path change refuses; another origin at the target path occupies it', () => {
  const f = fixture('pathrefusals');
  try {
    const store = f.store;
    const origin = 'alice/nucleus';
    const oldPath = '/fixture/old';
    const taken = '/fixture/taken';
    store.patchRepository({ origin, path: oldPath }, { closeout: 'agent', note: 'nucleus' });
    const done = f.task(origin, oldPath);
    f.finish(done.id);
    const snapshot = () => JSON.stringify({
      settings: store.repositories(), tasks: store.db.prepare('SELECT id,data FROM tasks ORDER BY id').all(),
      receipts: store.repositoryRekeys(),
    });
    const refuse = (input: ReturnType<typeof step>, pattern: RegExp) => {
      const before = snapshot();
      assert.throws(() => store.rekeyRepository(input), pattern);
      assert.equal(snapshot(), before, `refusal ${pattern} wrote nothing`);
    };

    refuse(step(store, origin, { origin }), /source_equals_target/);
    refuse(step(store, origin, { origin, path: oldPath }), /source_equals_target/);

    store.patchRepository({ origin: 'bob/retired', path: taken }, { note: 'retired' });
    const retired = f.task('bob/retired', taken);
    f.finish(retired.id);
    refuse(step(store, origin, { origin, path: taken }), /path_occupied/);
    assert.equal(store.task(done.id).repoPath, oldPath);
    assert.equal(store.task(retired.id).repoPath, taken);
    assert.equal(store.task(retired.id).repository, 'bob/retired');
  } finally { f.close(); }
});

test('Spec 056 an empty settings path with disagreeing record paths needs sourcePath', () => {
  const f = fixture('pathambiguous');
  try {
    const store = f.store;
    const origin = 'alice/split';
    store.patchRepository({ origin, path: '' }, { closeout: 'agent', note: 'split' });
    const first = f.task(origin, '/fixture/one');
    const second = f.task(origin, '/fixture/two');
    f.finish(first.id); f.finish(second.id);
    const request = step(store, origin, { origin, path: '/fixture/moved' }, 'choose a path');
    assert.throws(() => store.rekeyRepository(request), /ambiguous_source/);
    assert.equal(store.task(first.id).repoPath, '/fixture/one');
    const chosen = { ...request, sourcePath: '/fixture/one' };
    const applied = store.rekeyRepository(chosen);
    assert.equal(applied.receipt.pathChanged, true);
    assert.equal(applied.receipt.source.path, '/fixture/one');
    assert.equal(store.task(first.id).repoPath, '/fixture/moved');
    assert.equal(store.task(second.id).repoPath, '/fixture/two', 'the unchosen path stays');
    assert.equal(store.task(first.id).repository, origin);
    assert.equal(store.task(second.id).repository, origin);
  } finally { f.close(); }
});

/**
 * Attached old-code proof: load blob b7851721 of `server/repository-rekey.ts`
 * (planning 26f80ef0) and run it against the first path-only case. A current-head
 * pass of the new tests is not this; this call is.
 */
test('Spec 056 parent implementation refuses a same-origin path-only step', async () => {
  const repoRoot = join(import.meta.dirname, '..');
  assert.equal(
    execFileSync('git', ['-C', repoRoot, 'rev-parse', `${PARENT_REKEY_COMMIT}:server/repository-rekey.ts`], { encoding: 'utf8' }).trim(),
    PARENT_REKEY_BLOB,
  );
  const parentSource = execFileSync('git', ['-C', repoRoot, 'cat-file', '-p', PARENT_REKEY_BLOB], { encoding: 'utf8' });
  assert.equal(
    execFileSync('git', ['-C', repoRoot, 'hash-object', '--stdin'], { encoding: 'utf8', input: parentSource }).trim(),
    PARENT_REKEY_BLOB,
  );
  const parentContractSource = execFileSync('git', ['-C', repoRoot, 'show', `${PARENT_REKEY_COMMIT}:shared/repository-rekey.ts`], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'queue-rekey-parent-'));
  const outfile = join(dir, 'parent-rekey.mjs');
  try {
    await build({
      stdin: { contents: parentSource, resolveDir: repoRoot, sourcefile: 'repository-rekey.parent.ts', loader: 'ts' },
      bundle: true, format: 'esm', platform: 'node', write: true, outfile, logLevel: 'silent',
      plugins: [{
        name: 'parent-rekey-contract',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/shared\/lanes$/ }, () => ({ path: join(repoRoot, 'shared/lanes.ts') }));
          build.onResolve({ filter: /^\.\.\/shared\/repository-rekey$/ }, () => ({ path: 'repository-rekey', namespace: 'parent-contract' }));
          build.onLoad({ filter: /.*/, namespace: 'parent-contract' }, () => ({ contents: parentContractSource, loader: 'ts', resolveDir: join(repoRoot, 'shared') }));
        },
      }],
    });
    const { previewRepositoryRekey } = await import(pathToFileURL(outfile).href) as {
      previewRepositoryRekey: typeof import('../core/planning/repository-rekey').previewRepositoryRekey;
    };
    const f = fixture('parent-path');
    try {
      const store = f.store;
      const origin = 'alice/nucleus';
      const oldPath = '/fixture/paseo-northstar-queue';
      const newPath = '/fixture/nucleus';
      store.db.exec('CREATE TABLE brief_drafts(id TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL)');
      store.patchRepository({ origin, path: '' }, { closeout: 'agent', note: 'nucleus settings' });
      const done = f.task(origin, oldPath);
      f.finish(done.id);
      const request = step(store, origin, { origin, path: newPath }, 'move checkout without renaming');
      const parentPreview = previewRepositoryRekey(store.db, {
        source: request.source, target: request.target,
        expectedSourceRevision: request.expectedSourceRevision, reason: request.reason,
        idempotencyKey: request.idempotencyKey,
      }, digest('parent-path-only'), '2026-01-01T00:00:00.000Z') as RepositoryRekeyPreview;
      const parentCodes = parentPreview.refusals.map(refusal => refusal.code);
      assert.equal(parentPreview.ready, false, JSON.stringify(parentPreview.refusals));
      assert.ok(parentCodes.includes('source_equals_target'), JSON.stringify(parentCodes));
      assert.ok(parentCodes.includes('target_occupied'), JSON.stringify(parentCodes));
      assert.equal(store.task(done.id).repoPath, oldPath, 'parent preview wrote nothing');

      const current = store.previewRepositoryRekey({
        source: request.source, target: request.target,
        expectedSourceRevision: request.expectedSourceRevision, reason: request.reason,
        idempotencyKey: request.idempotencyKey,
      });
      assert.equal(current.ready, true, JSON.stringify(current.refusals));
      assert.equal(current.pathChanged, true);
      assert.equal(current.source.path, oldPath);
    } finally { f.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
