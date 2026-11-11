import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewPolicy, type ReviewPolicyHost } from '../core/review/review-policy';
import { reviewEntryInputSchema } from '../shared/contracts';

test('review workspace inspection uses separately observed origin host evidence', async () => {
  let wrongHostReads = 0;
  const host = { workspaceHost: { workspaceRef: () => ({ directory: '/workspace', refresh: async () => {}, current: () => ({ projectRootPath: '/repo' }) }), activeThreads: async () => [] },
    originAgent: async () => { wrongHostReads++; throw Error('origin is on another host'); }, observe: async () => { wrongHostReads++; throw Error('wrong host'); } } as unknown as ReviewPolicyHost;
  const input = reviewEntryInputSchema.parse({ submission: { submissionId: 'review-origin', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }, workspaceId: 'workspace', prNumber: 1, expectedBranch: 'feature', expectedHead: 'b'.repeat(40), expectedBaseCommit: 'a'.repeat(40), authority: 'approved', authorDeclaration: { models: ['test/model'], githubAuthor: 'author', authoringSystem: 'external', attestedBy: 'operator', provenance: 'fixture' } });
  const origin = { id: 'origin', workspaceId: 'origin-ws', title: 'Origin', archived: false };
  const state = { id: 'origin', workspaceId: 'origin-ws', status: 'idle', active: false, permissions: false, error: '' };
  const result = await new ReviewPolicy(host).inspectReviewEntry(input, undefined, { origin, state });
  assert.equal(result.originWorkspaceId, 'origin-ws'); assert.equal(result.busyReason, ''); assert.equal(wrongHostReads, 0);
});
