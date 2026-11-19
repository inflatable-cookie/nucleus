import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { workerPrompt, runPrompt } from '../core/dispatch/prompts';
import { buildRunContext } from '../core/dispatch/prompt-text/context-store';
import { measureRunPrompt } from '../core/dispatch/prompt-text/measure';
import { briefDigest } from '../core/planning/brief';
import type { Run, Task } from '../shared/contracts';

const head = 'a'.repeat(40);
const planning = 'b'.repeat(40);
const base = 'c'.repeat(40);
const brief = '---\ntitle: Fixture\n---\n\n## Outcome\nBuild the amended fixture.';
const task = {
  id: 'task', runId: 'worker-run', title: 'Fixture', originAgentId: 'origin', coordinatorAgentId: null,
  dependsOn: [], branch: 'ns-task', baseBranch: 'release', repoPath: '/repo', workspaceId: 'ws', directory: '/ws',
  temporaryDirectory: '/scratch/worker', planningCommit: planning, planningBase: planning, retiredWorkers: [],
  resolution: { review: null, reviews: [] }, completion: { prNumber: 1, head }, skipPRReview: false,
  prUrl: 'https://example.test/pr/1',
  briefVersions: [{ version: 2, digest: briefDigest(brief), text: brief, reason: 'Fixture amendment' }],
  proofFiles: [{ runId: 'older-worker-run', head, label: 'Fixture capture', path: '/evidence/capture.png', sha256: 'a1'.repeat(32), bytes: 42 }],
} as unknown as Task;

const floors = {
  worker: { rule: 'Worker', duty: /Before editing, confirm/, result: /prNumber/, validation: /Affected tests: this repository configures its own affected-tests command, so after you commit/ },
  revision: { rule: 'Worker', duty: /Resume implementation in this same workspace/, result: /ready_for_review.*prNumber/, validation: /Affected tests: this repository configures its own affected-tests command, so after you commit/ },
  reviewer: { rule: 'Reviewer', duty: /Inspect the diff/, result: /reviewText/, validation: /Affected tests: judge the author's/ },
  recovery: { rule: 'Recovery', duty: /Do not edit tracked files/, result: /Report exactly one coordinatorAction/ },
  executor: { rule: null, duty: /Run exactly ONE brief-named selector/, result: /proof_executed with proofResult/ },
} as const;

for (const role of ['worker', 'revision', 'reviewer', 'recovery', 'executor'] as const) {
  test(`${role} prompts retain the role's brief, identity, binding and required instructions`, () => {
    const id = `${role}-run`;
    const scratch = `/scratch/${role}`;
    const run = {
      id, role, head, base, generation: 1, temporaryDirectory: scratch,
      ...(role === 'executor' ? { proofExecution: { selector: 'effigy proof:fixture', inputs: [], prNumber: 1 } } : {}),
    } as Run;
    const floor = floors[role];
    for (const mcp of [true, false]) {
      const { prompt, size } = measureRunPrompt(section => role === 'worker'
        ? workerPrompt(task, mcp, [], null, '/helper', '/ticket', 'effigy test:affected --run', section)
        : runPrompt(task, run, '/helper', '/ticket', mcp, null, null, 'effigy test:affected --run', section));

      assert.ok(prompt.includes(brief));
      assert.match(prompt, /version 2[\s\S]*Fixture amendment/);
      assert.ok(prompt.includes(role === 'worker' ? `Task ID: ${task.id};` : `Nucleus task ${task.id}:`));
      assert.ok(prompt.includes(`run ID: ${id}`));
      assert.ok(prompt.includes(`base: ${task.baseBranch}`));
      assert.ok(prompt.includes(`base commit: ${role === "worker" ? planning : base}`));
      assert.match(prompt, new RegExp(`(?:starting|Expected|Recovery reference) head: ${head}`));
      assert.ok(prompt.includes(scratch));
      assert.match(prompt, /Report only through this run's own binding/);
      assert.match(prompt, /include cause and impediment/);
      assert.match(prompt, /Never resend an unknown delivery or use another thread's ticket/);
      assert.ok(prompt.includes('nucleus helper report context [rules|validation|proofs|history]'));
      if (mcp) assert.match(prompt, new RegExp(`nucleus_report MCP tool with runId "${id}"`));
      else {
        assert.match(prompt, /nucleus helper report <<'NUCLEUS_RESULT'/);
        assert.match(prompt, /ticket (?:binds this report to exactly this run|supplies task\/run identity)/i);
      }

      assert.match(prompt, floor.duty);
      assert.match(prompt, floor.result);
      if ('validation' in floor) {
        assert.match(prompt, floor.validation);
        assert.ok(prompt.includes('effigy test:affected --run'));
        assert.match(prompt, /covering checks never waive a proof this brief names/);
      } else assert.doesNotMatch(prompt, /Affected tests:/);
      if (role === 'reviewer' || role === 'executor') assert.match(prompt, /must never edit tracked files/);
      if (role !== 'reviewer') assert.doesNotMatch(prompt, /checkpoint: \{covered, remaining, notes\}/);
      if (role !== 'recovery') assert.doesNotMatch(prompt, /Report exactly one coordinatorAction/);
      if (role !== 'worker' && role !== 'revision') {
        assert.doesNotMatch(prompt, /how to fix what the reviewer found|Revision ready_for_review requires|after you commit/);
      }
      const headings = [...prompt.matchAll(/Follow '(Worker|Reviewer|Recovery) rules'/g)].map(match => match[1]);
      assert.deepEqual(headings, floor.rule ? [floor.rule] : []);

      assert.equal(size.total, prompt.length);
      assert.equal(Object.values(size.sections).reduce((sum, value) => sum + value, 0), size.total);
      for (const name of ['identity', 'workspace', 'brief', 'contextIndex', 'report']) assert.ok(size.sections[name], name);
      assert.equal(Boolean(size.sections.standingRules), Boolean(floor.rule));
      assert.equal(Boolean(size.sections.validation), 'validation' in floor);
      assert.equal(Boolean(size.sections.proofFiles), role === 'reviewer');
      assert.equal(Boolean(size.sections.recoverySnapshot), role === 'recovery');
    }
  });
}

test('rules read from each role’s run context match the skill and preserve callback guidance', () => {
  const skill = readFileSync('skills/nucleus/SKILL.md', 'utf8');
  for (const role of ['worker', 'revision', 'reviewer', 'recovery'] as const) {
    const { rules } = buildRunContext(task, { id: `${role}-run`, role, head });
    assert.ok(skill.includes(`## ${floors[role].rule} rules\n\n${rules}\n`));
    assert.match(rules, /\{kind: 'external', name: '[^']+'\}.*\{kind: 'internal'\}.*\{kind: 'unfinished'\}/);
    assert.match(rules, /`impediment` with the failed command(?: or|,) observed provider message/);
    if (role !== 'recovery') {
      assert.match(rules, /stdin to `nucleus ask -`/);
      assert.match(rules, /and `nucleus tell -`/);
    }
    assert.equal(rules.includes("PR's Decisions list"), role === 'worker' || role === 'revision');
  }
});

test('BB context reads carry the same current run binding as the report', () => {
  const bbTask = { ...task, hostId: 'bb:fixture' };
  const worker = workerPrompt(bbTask, false, [], null, '/helper', '/worker-ticket');
  const reviewer = runPrompt(bbTask, { id: 'reviewer-run', role: 'reviewer', head } as Run, '/helper', '/reviewer-ticket');
  for (const [role, prompt] of [['worker', worker], ['reviewer', reviewer]]) {
    const command = `NUCLEUS_CONTINUATION_RUN_ID='${role}-run' NUCLEUS_CONTINUATION_TICKET='/${role}-ticket' nucleus helper report`;
    assert.ok(prompt.includes(`${command} context rules`));
    assert.ok(prompt.includes(`${command} <<'NUCLEUS_RESULT'`));
  }
});
