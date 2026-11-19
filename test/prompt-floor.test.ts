import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerPrompt, runPrompt } from '../core/dispatch/prompts';
import { REQUIRED_PROOF_AUTHOR_NOTE, REQUIRED_PROOF_REVIEWER_NOTE } from '../core/dispatch/prompt-text/proof-rules';
import { WORKER_RULES, REVIEWER_RULES, RECOVERY_RULES } from '../core/dispatch/prompt-text/standing-rules';
import type { Run, Task } from '../shared/contracts';

const head = 'a'.repeat(40);
const task = {
  id: 'task', runId: 'worker-run', title: 'Fixture', originAgentId: 'origin', coordinatorAgentId: null,
  dependsOn: [], branch: 'ns-task', baseBranch: 'main', repoPath: '/repo', workspaceId: 'ws', directory: '/ws', temporaryDirectory: '/scratch',
  planningCommit: head, planningBase: head, retiredWorkers: [], resolution: { review: null, reviews: [] },
  completion: { prNumber: 1 }, skipPRReview: false, prUrl: 'https://example.test/pr/1',
} as unknown as Task;

test('role prompts keep identity, binding, safety and role-specific validation', () => {
  const worker = workerPrompt(task, true, [], null, '/helper', '/ticket', 'effigy test:affected --run');
  assert.match(worker, /worker-run/); assert.match(worker, /Worker rules/);
  assert.match(worker, /Affected tests: after you commit/); assert.ok(worker.includes(REQUIRED_PROOF_AUTHOR_NOTE));
  assert.match(worker, /Never resend an unknown delivery/);
  for (const role of ['revision', 'reviewer', 'recovery', 'executor'] as const) {
    const run = { id: `${role}-run`, role, generation: 1, head, temporaryDirectory: '/scratch' } as Run;
    const prompt = runPrompt(task, run, '/helper', '/ticket', true, null, null, 'effigy test:affected --run');
    assert.match(prompt, new RegExp(`${role}-run`));
    assert.match(prompt, /Report only through this run's own binding/);
    assert.match(prompt, /Never resend an unknown delivery/); assert.match(prompt, /\/scratch/);
    if (role === 'revision') assert.ok(prompt.includes(REQUIRED_PROOF_AUTHOR_NOTE));
    if (role === 'reviewer') assert.ok(prompt.includes(REQUIRED_PROOF_REVIEWER_NOTE));
    if (role === 'reviewer') {
      assert.match(prompt, /Affected tests: judge the author's/);
      assert.doesNotMatch(prompt, /how to fix what the reviewer found/);
      assert.doesNotMatch(prompt, /Revision ready_for_review requires/);
    }
    if (role === 'executor') assert.match(prompt, /must never edit tracked files/);
  }
});

test('skill carries the same role guidance as the run context', () => {
  const skill = readFileSync('skills/nucleus/SKILL.md', 'utf8');
  for (const text of [WORKER_RULES, REVIEWER_RULES, RECOVERY_RULES]) assert.ok(skill.includes(text));
});
