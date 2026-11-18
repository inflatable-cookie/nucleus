import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mount, useNativeStubs, type HostNode } from './support/render';
import {
  pullRequestBadge,
  pullRequestBadgeLabel,
  pullRequestNumberLabel,
} from '../shared/pull-request-badge';
import { repositoryLabel, repositoryShortName } from '../shared/repository-label';
import type { TaskSummary } from '../shared/contracts';

/**
 * nucleus#1313 (Tom, 2026-11-17, live trial poodle-lab#029): the container's PR is the
 * standard icon plus `#39` in the state colour with the state in the label, and the
 * container says what repository the task works on. One shared module owns both
 * mappings so the board's `PullRequestBadge` and the BB sidebar's
 * `TaskGroupPullRequest` cannot drift.
 */
useNativeStubs();
const h = React.createElement;
const theme = {
  surface0: '#101010', surface1: '#181818', surface2: '#202020', border: '#333333',
  foreground: '#f0f0f0', foregroundMuted: '#9a9a9a', accent: '#4a90e2', accentForeground: '#ffffff',
  statusSuccess: '#4caf50', statusWarning: '#e0a800', statusDanger: '#d9534f',
} as const;
const c = theme as never;

const iconOf = (node: HostNode): string | undefined => {
  if (node.type === 'Icon') return node.props.name;
  for (const child of node.children) if (typeof child !== 'string') { const found = iconOf(child); if (found) return found; }
  return undefined;
};
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');

test('the one PR mapping: open is success, merged accent, closed danger, blocked warning, unknown muted', () => {
  assert.deepEqual(pullRequestBadge({ state: 'OPEN' }), { icon: 'GitPullRequest', tone: 'success', stateLabel: 'open' });
  assert.deepEqual(pullRequestBadge({ state: 'MERGED' }), { icon: 'GitMerge', tone: 'accent', stateLabel: 'merged' });
  assert.deepEqual(pullRequestBadge({ state: 'CLOSED' }), { icon: 'GitPullRequestClosed', tone: 'danger', stateLabel: 'closed' });
  // Terminal state wins over task attention; attention only colours an open PR.
  assert.equal(pullRequestBadge({ state: 'OPEN', blocked: true }).tone, 'warning');
  assert.equal(pullRequestBadge({ state: 'MERGED', blocked: true }).tone, 'accent');
  assert.equal(pullRequestBadge({ state: 'OPEN', blocked: true }).stateLabel, 'open, task needs attention');
  assert.deepEqual(pullRequestBadge({ state: null }), { icon: 'GitPullRequest', tone: 'muted', stateLabel: 'status unavailable' });
  // `#39`, never a padded number, and the state in the label.
  assert.equal(pullRequestNumberLabel(39), '#39');
  assert.equal(pullRequestNumberLabel(null), '#');
  assert.equal(pullRequestBadgeLabel(39, pullRequestBadge({ state: 'OPEN' })), 'Pull request #39, open');
});

test('the board badge draws the standard icon and #39 in the state colour with no text label', async () => {
  const { PullRequestBadge } = await import('../client/board/badges');
  const task = {
    id: 'task_1', repoPath: '/repos/poodle-lab', title: 'Add a selector', phase: 'awaiting_review',
    prUrl: 'https://example.invalid/poodle-lab/pull/39', resumePrNumber: 39, held: false,
    resolution: { mergedCommit: null },
  } as unknown as TaskSummary;
  const ui = mount(h(PullRequestBadge, { task, state: 'OPEN', c }));
  const label = ui.get('Pull request #39, open');
  assert.equal(iconOf(label), 'GitPullRequest');
  assert.equal(textOf(label), '#39', 'no `PR`, no state word, just the number');

  const merged = mount(h(PullRequestBadge, { task: { ...task, resolution: { mergedCommit: 'a'.repeat(40) } } as unknown as TaskSummary, state: 'MERGED', c }));
  assert.equal(iconOf(merged.get('Pull request #39, merged')), 'GitMerge');
  assert.equal(textOf(merged.get('Pull request #39, merged')), '#39');
});

test('one repository label for every surface: the short name, owner/name only when it is ambiguous', () => {
  assert.equal(repositoryShortName('/synthetic/repos/poodle-lab'), 'poodle-lab');
  assert.equal(repositoryLabel({ repoPath: '/synthetic/repos/poodle-lab', repository: 'tom/poodle-lab' }), 'poodle-lab');
  // Two different `poodle-lab` origins on one board: both are disambiguated.
  const mine = { repoPath: '/synthetic/repos/poodle-lab', repository: 'tom/poodle-lab' };
  const theirs = { repoPath: '/synthetic/forks/poodle-lab', repository: 'sam/poodle-lab' };
  assert.equal(repositoryLabel(mine, [mine, theirs]), 'tom/poodle-lab');
  assert.equal(repositoryLabel(theirs, [mine, theirs]), 'sam/poodle-lab');
  // The same origin twice is not ambiguous.
  assert.equal(repositoryLabel(mine, [mine, { ...mine }]), 'poodle-lab');
  // A task with no recorded origin keeps the short name (the board's rule).
  assert.equal(repositoryLabel({ repoPath: '/synthetic/repos/poodle-lab' }, [mine, { repoPath: '/synthetic/forks/poodle-lab' }]), 'poodle-lab');
});
