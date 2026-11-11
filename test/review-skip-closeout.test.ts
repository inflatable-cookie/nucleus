import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { RepositoryHooks } from '../core/hooks/hooks';
import { git, command } from '../core/git/index';
import { prepareHandoff } from '../core/planning/handoff';
import { submissionSchema, type Submission } from '../shared/contracts';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

/**
 * A review-skipping submission where a required integration-write
 * `task.closeout` hook owns closeout can merge completely and still never
 * close: that hook needs the accepted review identity a review-skipping lane
 * never produces, and no recovery control can invent one. Queue refuses at
 * submission so the dispatcher can still choose an ordinary reviewed lane.
 *
 * The refusal is conditional on the pinned manifest. Both directions are
 * proven here, including that the refusal precedes any repository hook run.
 */

const program = (id: string) => ({ kind: 'repository', executable: `.paseo/hooks/${id}`, argv: [] });
const closeoutHook = (overrides: Record<string, unknown> = {}) => ({
  id: 'lifecycle-state', events: ['task.blocked', 'task.cancelled', 'task.closeout'],
  mode: 'integration_write', delivery: 'required', target: 'integration_base', program: program('lifecycle'),
  timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
  allowedPaths: ['.northstar/lifecycle/'], commitSubject: { prefix: 'lifecycle', maxBytes: 100 },
  ...overrides,
});
const preDispatchHook = () => ({
  id: 'lifecycle-gate', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required',
  target: 'integration_base', program: program('gate'), timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536,
  allowedPaths: [], commitSubject: null,
});
const manifestOf = (...hooks: unknown[]) => ({ schema: 'paseo.queue.control.v4', hooks });

const sections = ['What This Thread Was Doing', 'Why It Matters', 'Current State', 'Boundaries', 'Important Context', 'Suggested Next Move', 'Completion Protocol'];
const handoff = (skipPRReview: boolean) => `---
title: Review-skip disposable handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
status: ready-to-launch
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: Operator approved this disposable test
queue:
  skipPRReview: ${skipPRReview}
---
${sections.map(section => `## ${section}\n\nConcrete task instructions.\n`).join('\n')}`;

async function fixture(t: any, manifest: unknown | null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-review-skip-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  await command('git', ['clone', join(root, 'origin.git'), join(root, 'repo')], root);
  const repo = join(root, 'repo');
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  if (manifest) {
    await mkdir(join(repo, '.paseo'), { recursive: true });
    await writeFile(join(repo, '.paseo/queue.json'), JSON.stringify(manifest, null, 2));
    // Declared programs are pinned as regular executable blobs before any run.
    await mkdir(join(repo, '.paseo/hooks'), { recursive: true });
    for (const hook of (manifest as { hooks?: { program?: { executable?: string } }[] }).hooks ?? []) {
      const executable = hook.program?.executable;
      if (executable) await writeFile(join(repo, executable), '#!/bin/sh\n', { mode: 0o755 });
    }
  }
  await mkdir(join(repo, 'docs/handoffs'), { recursive: true });
  const path = join(repo, 'docs/handoffs/review-skip.md');
  const publish = async (text: string) => { await writeFile(path, text); await git(repo, 'add', '-A'); await git(repo, 'commit', '-m', 'handoff'); await git(repo, 'push', 'origin', 'main'); };
  await publish(handoff(true));
  const head = await git(repo, 'rev-parse', 'HEAD');
  const runs: string[] = [];
  const hooks = new RepositoryHooks(new Store(':memory:'), {
    run: async request => {
      const event = JSON.parse(request.stdin.toString('utf8'));
      runs.push(event.eventId);
      return {
        pid: 1, code: 0, signal: null, timedOut: false, stdoutExceeded: false, stderrExceeded: false, durationMs: 1,
        stdout: Buffer.from(JSON.stringify({ schema: 'paseo.queue.hook-result.v1', eventId: event.eventId, outcome: 'ok', summary: 'stub hook', metadata: {}, changedPaths: [], commitSubjectSuffix: null })),
        stderr: Buffer.alloc(0),
      };
    },
  });
  const submission = (skipPRReview: boolean): Submission => submissionSchema.parse({
    submissionId: randomUUID(), title: 'Review skip', repoPath: repo, handoffPath: 'docs/handoffs/review-skip.md',
    planningCommit: head, originAgentId: 'origin-test', skipPRReview,
  });
  return { repo, path, head, publish, hooks, runs, submission, input: { handoffPath: path, originAgentId: 'origin-test', baseBranch: 'main', dryRun: true } };
}

test('a hook-owned closeout refuses a review-skipping submission before any hook runs', async t => {
  const f = await fixture(t, manifestOf(preDispatchHook(), closeoutHook()));
  await assert.rejects(prepareHandoff(f.input), /skipPRReview is unavailable for this repository/);
  await assert.rejects(f.hooks.previewPreDispatch(f.submission(true), 'handoff', f.head), /skipPRReview is unavailable for this repository/);
  assert.deepEqual(f.runs, [], 'the refusal precedes repository hook execution');
});

test('the refusal is conditional: another closeout binding or none keeps the option', async t => {
  for (const manifest of [
    null,
    manifestOf(),
    manifestOf(closeoutHook({ events: ['task.blocked', 'task.cancelled'] })),
    manifestOf(closeoutHook({ mode: 'read_only', allowedPaths: [], commitSubject: null })),
    manifestOf(closeoutHook({ delivery: 'advisory' })),
  ]) {
    const f = await fixture(t, manifest);
    const prepared = await prepareHandoff(f.input);
    assert.equal(prepared.submission.skipPRReview, true, `the option survives: ${JSON.stringify(manifest)}`);
    await f.hooks.previewPreDispatch(f.submission(true), 'handoff', f.head);
    assert.deepEqual(f.runs, [], 'a closeout-only manifest binds no pre-dispatch policy');
  }
});

test('an opted-in repository refuses a review-skipping submission before any hook runs', async t => {
  const f = await fixture(t, manifestOf(preDispatchHook()));
  f.hooks.store.putRepository({ origin: null, path: f.repo }, null, 'formal reviews', null, { login: 'northstar-reviewer' });
  await assert.rejects(f.hooks.previewPreDispatch(f.submission(true), 'handoff', f.head), /opts into formal PR reviews as northstar-reviewer/);
  assert.deepEqual(f.runs, [], 'the refusal precedes repository hook execution');
  // An ordinary reviewed lane is unaffected.
  await f.hooks.previewPreDispatch(f.submission(false), 'handoff', f.head);
  assert.equal(f.runs.length, 1, 'ordinary pre-dispatch policy still runs');
});

test('a pre-dispatch hook without closeout ownership still runs and allows the flag', async t => {
  const f = await fixture(t, manifestOf(preDispatchHook()));
  const prepared = await prepareHandoff(f.input);
  assert.equal(prepared.submission.skipPRReview, true);
  await f.hooks.previewPreDispatch(f.submission(true), 'handoff', f.head);
  assert.equal(f.runs.length, 1, 'ordinary pre-dispatch policy still runs');
});

test('an ordinary reviewed submission is unaffected by a hook-owned closeout', async t => {
  const f = await fixture(t, manifestOf(closeoutHook()));
  await f.publish(handoff(false));
  const prepared = await prepareHandoff(f.input);
  assert.equal(prepared.submission.skipPRReview, false);
  await f.hooks.previewPreDispatch(f.submission(false), 'handoff', prepared.submission.planningCommit);
});
