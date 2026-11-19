import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROOF_FILES_NONE_NOTE,
  PROOF_FILES_RULE,
  REQUIRED_PROOF_AUTHOR_NOTE,
  briefNamesVisualProof,
  proofFilesNote,
  runPrompt,
  workerPrompt,
} from '../core/dispatch/prompts';
import { briefDigest } from '../core/planning/brief';
import { PROOF_FILES_SIZE_REFUSAL } from '../shared/service/proof-files.mjs';
import type { Run, Task } from '../shared/contracts';

/**
 * nucleus#1382: prompt notes are notes. Proof files, the run context and the
 * recorded build-output cleanup are optional reference unless the brief names
 * the proof, so no prompt may read them as a step the agent owes before it can
 * continue.
 */
const head = 'a'.repeat(40);
const planning = 'b'.repeat(40);
const cleanup = {
  workspaceId: 'workspace', directory: '/worktree', runId: 'previous-run', state: 'complete',
  detail: 'Removed task-local Cargo target output at /worktree/target', observations: ['removed'],
  at: '2026-11-18T00:00:00.000Z',
};
const brief = (text: string) => [{ version: 1, digest: briefDigest(text), text, reason: 'Submitted' }];

function task(text: string): Task {
  return {
    id: 'task', runId: 'worker-run', title: 'Fixture', originAgentId: 'origin', coordinatorAgentId: null,
    dependsOn: [], branch: 'ns-task', baseBranch: 'main', repoPath: '/repo', workspaceId: 'workspace',
    directory: '/worktree', temporaryDirectory: '/scratch/run', planningCommit: planning, planningBase: planning,
    retiredWorkers: [], skipPRReview: false, prUrl: 'https://example.test/pr/1', resumePrNumber: 7,
    briefVersions: brief(text),
    completion: { runId: 'previous-run', prNumber: 7, head, status: 'blocked' },
    resolution: { review: { summary: 'Fix the route', reviewCommentId: 1 }, reviews: [], buildOutputCleanups: [cleanup] },
    proofFiles: [{ runId: 'previous-run', head, label: 'Board capture', path: '/evidence/board.png', sha256: 'a1'.repeat(32), bytes: 42 }],
  } as unknown as Task;
}

const run = (role: 'revision' | 'reviewer'): Run => ({ id: `${role}-run`, role, head, base: planning, generation: 1, temporaryDirectory: `/scratch/${role}` }) as Run;

const prompts = (text: string) => {
  const fixture = task(text);
  return {
    worker: workerPrompt(fixture, true),
    workerContinuation: workerPrompt({ ...fixture, retiredWorkers: [{ agentId: 'old', runId: 'previous-run', profile: { model: 'm' }, reason: 'Continue' }] } as unknown as Task, true),
    revision: runPrompt(fixture, run('revision'), '/helper', '/ticket', true),
    reviewer: runPrompt(fixture, run('reviewer'), '/helper', '/ticket', true),
  };
};

/** The single prompt lines that carry the optional material, so a claim about one does not read the whole prompt. */
const optionalLines = (prompt: string) => prompt.split('\n').filter(line =>
  /Proof files for the retained reviewer|Earlier build outputs may be gone|Extended context:|proof files? recorded for head/.test(line));

const REQUIREMENT_WORDS = /\brequired\b|\bmust\b|before continuing/i;

test('a brief with no visual proof says there are no proof files to deliver, without requirement language', () => {
  const noProof = '## Outcome\n\nChange the parser and run the tests.\n';
  assert.equal(briefNamesVisualProof(task(noProof)), false);
  const rendered = prompts(noProof);
  for (const [role, prompt] of Object.entries(rendered)) {
    assert.ok(prompt.includes(PROOF_FILES_NONE_NOTE), `${role} prompt says there is nothing to deliver`);
    assert.ok(!prompt.includes(PROOF_FILES_RULE), `${role} prompt carries no delivery mechanics it does not need`);
  }
  assert.match(PROOF_FILES_NONE_NOTE, /there are none to deliver/);
  assert.doesNotMatch(PROOF_FILES_NONE_NOTE, REQUIREMENT_WORDS);
});

test('a brief that names visual proof carries the optional delivery mechanics, and the limits are packaging', () => {
  const visual = '## Outcome\n\nAttach before-and-after screenshots of the board.\n';
  assert.equal(briefNamesVisualProof(task(visual)), true);
  const rendered = prompts(visual);
  const paragraph = proofFilesNote(task(visual));
  assert.match(paragraph, /They are optional delivery for proof the brief names, never a gate of their own/);
  assert.match(paragraph, /summarise larger evidence into compact evidence plus hashes/);
  assert.doesNotMatch(paragraph, REQUIREMENT_WORDS);
  assert.doesNotMatch(paragraph, /exceeds the limits|Deliver the subset the brief allows|reviewResponsibility/);
  for (const [role, prompt] of Object.entries(rendered)) {
    assert.ok(prompt.includes(PROOF_FILES_RULE), `${role} prompt carries the delivery mechanics`);
    assert.doesNotMatch(prompt, /exceeds the limits|Deliver the subset the brief allows/);
  }
  // The old wording attached the limits to "required" delivery, which is what a
  // worker read as a reason to stop before writing any code.
  assert.match(PROOF_FILES_SIZE_REFUSAL, /packaging, never a reason to stop/);
  assert.doesNotMatch(PROOF_FILES_SIZE_REFUSAL, /required|blocked|reviewResponsibility/i);
  assert.doesNotMatch(REQUIRED_PROOF_AUTHOR_NOTE, /exceeds the limits|subset the brief allows/);
  assert.match(REQUIRED_PROOF_AUTHOR_NOTE, /never waive a proof this brief names as required/);
});

test('the run context is reference material: read if you need it, and a failed read is never a blocker', () => {
  for (const text of ['## Outcome\n\nChange the parser.\n', '## Outcome\n\nAttach screenshots.\n']) {
    const rendered = prompts(text);
    for (const [role, prompt] of Object.entries(rendered)) {
      assert.match(prompt, /These sections are reference material: read one if you need it/);
      assert.match(prompt, /a failed or refused optional read is never a blocker — continue and mention it in your report/);
      // The one exception the prompt names is the brief or a review finding.
      assert.match(prompt, /Nothing in them is needed to finish this turn unless the brief or a review finding names it/);
      assert.ok(prompt.includes('context [rules|validation|proofs|history]'), `${role} keeps the section list`);
    }
  }
});

test('the build-output cleanup note says only what it means and names no history lookup', () => {
  const rendered = prompts('## Outcome\n\nChange the parser.\n');
  for (const role of ['workerContinuation', 'revision', 'reviewer'] as const) {
    const prompt = rendered[role];
    assert.match(prompt, /Earlier build outputs may be gone: re-run a command whose output you rely on/);
    assert.doesNotMatch(prompt, /cleanup history|context history/);
    assert.doesNotMatch(prompt, /Removed task-local Cargo target output/, `${role} does not quote the record as a step`);
  }
  // A prompt without a recorded cleanup keeps its exact text.
  const clean = workerPrompt({ ...task('## Outcome\n\nChange the parser.\n'), resolution: { reviews: [] } } as unknown as Task, true);
  assert.doesNotMatch(clean, /Earlier build outputs may be gone/);
});

test('no optional-material line uses requirement language, with or without brief-required visual proof', () => {
  for (const text of ['## Outcome\n\nChange the parser.\n', '## Outcome\n\nAttach screenshots of the board.\n']) {
    const rendered = prompts(text);
    for (const [role, prompt] of Object.entries(rendered)) {
      for (const line of optionalLines(prompt)) {
        assert.doesNotMatch(line, REQUIREMENT_WORDS, `${role}: ${line}`);
      }
    }
  }
});
