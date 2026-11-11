import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskControlInputSchema } from '../../shared/contracts';
import type { ReviewContinuationFixture } from './review-continuation-fixture';

/**
 * A real retained task checkout for the placement scenarios (task 496): the
 * canonical repository plus one worktree of it on the task branch. Only the
 * facts the placement proof reads are built, so a scenario costs five Git
 * spawns; nothing here is stubbed or shared between fixtures.
 */
export function checkoutPlacement(options: { branch?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-review-placement-')));
  const repo = join(root, 'repo'), checkout = join(root, 'ns-task');
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const identity = ['-c', 'user.name=Queue placement fixture', '-c', 'user.email=queue@example.test'];
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), 'base\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, ...identity, 'commit', '-m', 'planning');
  const branch = options.branch ?? `ns-${randomUUID()}`;
  gitIn(repo, 'worktree', 'add', '-b', branch, checkout, 'main');
  return { root, repo, checkout, branch, head: gitIn(checkout, 'rev-parse', 'HEAD'), git: gitIn, identity,
    close: () => rmSync(root, { recursive: true, force: true }) };
}

export type CheckoutPlacement = ReturnType<typeof checkoutPlacement>;

/** Record the real repository and checkout as this task's exact source at its reviewed head. */
export function placeTask(f: ReviewContinuationFixture, placement: CheckoutPlacement) {
  f.store.update(f.submitted.id, { repoPath: placement.repo, directory: placement.checkout, branch: placement.branch, prHead: placement.head });
  f.store.putRun({ ...f.run(), head: placement.head });
}

/** The owner restart and the `move to=review` control both reach the one retained-continuation implementation. */
export function placementControl(f: ReviewContinuationFixture, action: 'restart' | 'move') {
  return taskControlInputSchema.parse(action === 'restart'
    ? { action, role: 'reviewer', taskId: f.submitted.id, version: f.current().version, caller: 'owner',
        reason: 'Continue the retained review', instruction: 'Finish the remaining reading' }
    : { action, to: 'review', taskId: f.submitted.id, version: f.current().version, caller: 'owner',
        reason: 'Continue the retained review' });
}
