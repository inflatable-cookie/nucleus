import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerRevisionFixture, runGit } from './support/review-entry-fixture';
import { submissionSchema } from '../shared/contracts';
import {
  assertOrdinaryReviewIdentity, ordinaryReviewSource,
} from '../core/review/ordinary-review';
import { reattachTaskCheckout } from '../core/git/checkout-reattach';

/**
 * Boundary tests for the ordinary reviewer's checkout identity: the exact
 * answers `assertOrdinaryReviewIdentity` (inside a transaction or send guard)
 * and `ordinaryReviewSource` (the send boundary, with its clean-tree walk) give
 * for a missing identity, a directory that is not a checkout root, a foreign
 * repository, a moved head or branch, and a dirty tree.
 */
function fixture() {
  const f = ownerRevisionFixture();
  const task = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Ordinary review identity',
    repoPath: f.repo, planningCommit: f.planningCommit, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', 'handoff', f.planningCommit);
  f.store.update(task.id, { branch: 'feature/external', baseBranch: 'main', directory: f.workspace, workspaceIntent: true });
  return { ...f, task: f.store.task(task.id) };
}

test('ordinary reviewer identity refuses each distinct missing or foreign fact by name', async () => {
  const f = fixture();
  try {
    const task = f.task;
    assertOrdinaryReviewIdentity(task, f.oldHead);
    assert.doesNotThrow(() => assertOrdinaryReviewIdentity(task, f.oldHead));
    assert.throws(() => assertOrdinaryReviewIdentity({ ...task, workspaceIntent: false }, f.oldHead),
      /identity is incomplete: .*missing or invalid workspace intent/);

    // A directory that is not a usable checkout root is the Queue-owned-root
    // refusal, not an unreadable-identity one; the typed Git fault decides it.
    const plain = join(f.root, 'not-a-checkout');
    mkdirSync(plain);
    assert.throws(() => assertOrdinaryReviewIdentity({ ...task, directory: plain }, f.oldHead),
      /Ordinary reviewer requires its recorded Queue-owned checkout root/);

    // The same directory for source and checkout is not a separate round.
    assert.throws(() => assertOrdinaryReviewIdentity({ ...task, directory: f.repo }, f.oldHead),
      /Ordinary reviewer requires its recorded Queue-owned checkout root/);

    // A foreign checkout shares neither common dir nor origin.
    const other = join(f.root, 'other');
    runGit(f.root, 'init', '-b', 'main', other);
    runGit(other, 'config', 'user.name', 'Queue Fixture');
    runGit(other, 'config', 'user.email', 'queue@example.test');
    writeFileSync(join(other, 'README.md'), 'other\n');
    runGit(other, 'add', '.');
    runGit(other, 'commit', '-m', 'other');
    assert.throws(() => assertOrdinaryReviewIdentity({ ...task, repoPath: other }, f.oldHead),
      /repository identity changed/);

    assert.throws(() => assertOrdinaryReviewIdentity(task, 'f'.repeat(40)),
      /checkout identity mismatch: expected HEAD f{40}/);
    // No round reads a detached checkout: the guard requires the attached task
    // branch, and the single reattach step is what returns a checkout an earlier
    // round left detached (it moves no commit).
    runGit(f.workspace, 'checkout', '--quiet', '--detach', f.oldHead);
    assert.throws(() => assertOrdinaryReviewIdentity(task, f.oldHead),
      /observed .*branch \(detached\); a detached task checkout is returned to its branch by the reattach step \(run.release, then run.start\)/);
    assert.deepEqual(
      await reattachTaskCheckout(task, [], {}),
      { kind: 'reattached', branch: 'feature/external', head: f.oldHead },
    );
    assert.doesNotThrow(() => assertOrdinaryReviewIdentity(task, f.oldHead));
    assert.throws(() => assertOrdinaryReviewIdentity({ ...task, branch: 'feature/other' }, f.oldHead),
      /branch ref refs\/heads\/feature\/other could not be read: GitIdentityError: Missing ref/);
  } finally { f.close(); }
});

test('ordinary reviewer source proof adds the clean-tree walk at the send boundary', async () => {
  const f = fixture();
  try {
    await ordinaryReviewSource(f.task, f.oldHead);
    writeFileSync(join(f.workspace, 'dirty.txt'), 'uncommitted\n');
    await assert.rejects(() => ordinaryReviewSource(f.task, f.oldHead), /checkout is dirty/);
  } finally { f.close(); }
});
