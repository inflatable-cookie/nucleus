import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";
import { git, preservedFixture } from "./support/preserved-retirement-fixture";

test('retry_effect retires a cancelled workspace whose HEAD is on canonical origin without the task branch', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const shape of ['base', 'alternate', 'unpublished'] as const) await t.test(shape, async t => {
    const f = await preservedFixture(t, [], true);
    f.archive.catalogued = false;
    try {
      // The task branch was never kept on origin; the exact HEAD is on the base,
      // on another live origin branch, or nowhere.
      git(f.repo, 'push', 'origin', '--delete', f.task.branch);
      if (shape === 'base') git(f.directory, 'push', 'origin', 'HEAD:refs/heads/main');
      if (shape === 'alternate') git(f.directory, 'push', 'origin', 'HEAD:refs/heads/donor');
      const heads = git(f.repo, 'ls-remote', '--heads', 'origin');
      const result = await f.retry();
      assert.equal(result.phase, 'cancelled');
      assert.deepEqual(result.disposition, f.cancelled.disposition, 'owner authority and history stay separate from the archive result');
      assert.equal(result.prHead, f.cancelled.prHead);
      assert.equal(result.resolution.mergedCommit, null);
      assert.equal(git(f.repo, 'ls-remote', '--heads', 'origin'), heads, 'retirement creates no remote branch');
      if (shape === 'unpublished') {
        assert.equal(result.resolution.workspaceRetirement?.state, 'held', result.resolution.workspaceRetirement?.detail);
        assert.match(result.resolution.workspaceRetirement?.detail ?? '', /no origin ref contains HEAD/);
        assert.equal(result.resolution.workspaceRetirement?.intentAt, null);
        assert.equal(f.archive.count, 0);
        await stat(f.target);
      } else {
        assert.equal(result.resolution.workspaceRetirement?.state, 'archived', result.resolution.workspaceRetirement?.detail);
        assert.ok(result.resolution.archivedWorkspaceIds.includes(f.task.workspaceId!));
        await assert.rejects(stat(f.directory));
      }
    } finally { await f.close(); }
  });
});
