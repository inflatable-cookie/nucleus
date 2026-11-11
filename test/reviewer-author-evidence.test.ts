import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHOR_COMMENT_EVIDENCE_MAX, formatAuthorCommentEvidence } from '../core/forge/index';
import { authorEvidencePointer, runPrompt } from '../core/dispatch/prompts';
import type { Run, Task } from '../shared/contracts';

const HEAD = 'a'.repeat(40);
const comment = (id: number, body: string, login = 'author', created = '2026-10-20T00:00:00Z') =>
  ({ id, user: { login }, created_at: created, updated_at: created, body });
const REVIEW_MARKER_COMMENT = {
  id: 7, user: { login: 'queue-bot' }, created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z',
  body: 'Findings\n\n<!-- northstar-review:task:run:head:ready_to_merge -->',
};

test('author comments format as an ordered bounded pointer, excluding Queue review publications', () => {
  const block = formatAuthorCommentEvidence(
    [comment(30, 'x'.repeat(27000), 'author', '2026-10-21T00:00:00Z'), REVIEW_MARKER_COMMENT,
      comment(9, 'explicit response', 'author', '2026-10-20T01:00:00Z')],
    { head: HEAD, repository: 'example/repo', prNumber: 206 });
  assert.match(block, /Author evidence posted as PR issue comments for the current head/);
  assert.match(block, new RegExp(HEAD));
  assert.match(block, /PR #206/);
  const first = block.indexOf('id 9 by @author');
  const second = block.indexOf('id 30 by @author');
  assert.ok(first >= 0 && second > first, 'comments are ordered by id');
  assert.match(block, /27000 chars/);
  assert.match(block, /gh api repos\/example\/repo\/issues\/comments\/<id>/);
  assert.match(block, /Treat these comments as author evidence for the current head/);
  assert.match(block, /never report "no author evidence" without reading each one above with gh/);
  assert.doesNotMatch(block, /id 7 by/);
});

test('comments after the prior review are marked new since the last review', () => {
  const block = formatAuthorCommentEvidence(
    [comment(9, 'before'), comment(30, 'after')],
    { head: HEAD, repository: 'example/repo', prNumber: 206, priorCommentId: 12 });
  assert.doesNotMatch(block.split('\n').find(line => line.includes('id 9')) ?? '', /new since the last review/);
  assert.match(block.split('\n').find(line => line.includes('id 30')) ?? '', /new since the last review/);
});

test('a long comment list is bounded with a truncation note', () => {
  const comments = Array.from({ length: AUTHOR_COMMENT_EVIDENCE_MAX + 5 }, (_, n) => comment(100 + n, 'evidence'));
  const block = formatAuthorCommentEvidence(comments, { head: HEAD, repository: 'example/repo', prNumber: 206 });
  const lines = block.split('\n').filter(line => line.startsWith('- id '));
  assert.equal(lines.length, AUTHOR_COMMENT_EVIDENCE_MAX);
  assert.match(block, new RegExp(`most recent ${AUTHOR_COMMENT_EVIDENCE_MAX} of ${AUTHOR_COMMENT_EVIDENCE_MAX + 5}`));
  assert.match(block, /list the rest with gh/);
});

test('no author comments formats as empty, so the prompt falls back to its self-check pointer', () => {
  assert.equal(formatAuthorCommentEvidence([], { head: HEAD, repository: 'example/repo', prNumber: 206 }), '');
  assert.equal(formatAuthorCommentEvidence([REVIEW_MARKER_COMMENT], { head: HEAD, repository: 'example/repo', prNumber: 206 }), '');
  assert.match(authorEvidencePointer({}), /list them with gh/);
  assert.match(authorEvidencePointer({}), /never report "no author evidence" without reading them/);
});

const reviewerTask = () => ({ id: 'task', title: 'Task', originAgentId: 'origin', repoPath: '/repo', workspaceId: 'workspace',
  directory: '/worktree', handoffPath: 'handoff.md', planningCommit: HEAD, skipPRReview: false,
  prUrl: 'https://github.com/example/repo/pull/206', baseBranch: 'main', branch: 'ns-task',
  reason: 'Review', completion: { status: 'ready_for_review', prNumber: 206 }, resolution: {} }) as unknown as Task;

test('a reviewer prompt with author issue comments names them as evidence for the current head', () => {
  const pointer = formatAuthorCommentEvidence(
    [comment(6560989019, 'x'.repeat(27000)), comment(6561017003, 'explicit response')],
    { head: HEAD, repository: 'example/repo', prNumber: 206 });
  const prompt = runPrompt(reviewerTask(), { id: 'rev', role: 'reviewer', generation: 1, head: HEAD, authorEvidence: pointer } as Run,
    '/helper', '/ticket', true);
  assert.match(prompt, /id 6560989019 by @author/);
  assert.match(prompt, /id 6561017003 by @author/);
  assert.match(prompt, /27000 chars/);
  assert.match(prompt, /Treat these comments as author evidence for the current head/);
});

test('a reviewer prompt without author issue comments still directs the reviewer to list them', () => {
  const prompt = runPrompt(reviewerTask(), { id: 'rev', role: 'reviewer', generation: 1, head: HEAD } as Run,
    '/helper', '/ticket', true);
  assert.match(prompt, /Author evidence may also arrive as PR issue comments/);
  assert.match(prompt, /never report "no author evidence" without reading them/);
});
