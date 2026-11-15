import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, Store } from '../core/store/store';
import { submissionSchema, completionSchema, type Completion } from '../shared/contracts';
import { reviewRequiredFor } from '../shared/review-requirement';
import { reviewRequiredForTask, reviewerSettingOf } from '../core/review/reviewer-setting';
import { ContinuedPrs, type ContinuedPrBinding, type ContinuedPrContext } from '../core/review/continued-pr';

/**
 * Boundary tests for the review lifecycle owners: the repository reviewer
 * opt-in and the review requirement it decides, the reported-head binding (a
 * task with no PR and a foreign PR are separate false answers), and the
 * continued-PR binding that is identity only.
 */

const head = 'a'.repeat(40), prior = 'b'.repeat(40), url = 'https://github.com/example/repo/pull/44';
const observed = { url, head, repository: 'example/repo', headRepository: 'example/repo' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ns-review-owners-'));
  const store = new Store(join(root, 'queue.sqlite'));
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Review owners',
    repoPath: '/repo', planningCommit: prior, handoffPath: 'handoff.md', originAgentId: 'origin', skipPRReview: true }), 'host', 'handoff', prior);
  const unused = async () => { throw new Error('the adapter is not part of this case'); };
  const context: ContinuedPrContext = {
    store,
    adapter: { verifyPr: unused, verifyPrIdentity: async () => observed, verifyResume: async () => {} },
    continuedPrBinding: (t, number, pr, decided) => ({ decided, number, url: pr.url, head: pr.head, priorHead: t.prHead,
      completionEventId: t.completion!.eventId, branch: t.branch, baseBranch: t.baseBranch, repoPath: t.repoPath,
      agentId: t.agentId, workspaceId: t.workspaceId }),
  };
  // A report is schema-parsed before it is stored, exactly as intake writes it,
  // so the recorded completion's own JSON is what its receipt hashed.
  const completion = (over: Partial<Completion> = {}): Completion => completionSchema.parse({ taskId: task.id, runId: 'worker-run', eventId: 'ready-report',
    status: 'ready_for_review', summary: 'Ready', prNumber: 44, head, ...over });
  /** Record a report and its authenticated receipt, exactly as intake does. */
  const reported = (report: Completion = completion()) => {
    const updated = store.update(task.id, { completion: report, prUrl: null, prHead: null, resumePrNumber: null });
    const stored = updated.completion!;
    store.setCompletionReceipt(stored.eventId, task.id, stored.runId, digest(JSON.stringify(stored)), JSON.stringify({ accepted: true, eventId: stored.eventId }));
    return updated;
  };
  return { root, store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); }, taskId: task.id, context, completion, reported };
}

test('a repository reviewer opt-in makes review required even when the submission skipped it', () => {
  const f = fixture();
  try {
    const task = f.store.task(f.taskId);
    assert.equal(reviewRequiredFor(task, null), false);
    assert.equal(reviewerSettingOf(f.store, task), null);
    assert.equal(reviewRequiredForTask(f.store, task), false);
    f.store.putRepository({ origin: null, path: '/repo' }, null, 'reviewer opt-in', null, { login: 'review-bot' });
    assert.deepEqual(reviewerSettingOf(f.store, task), { login: 'review-bot' });
    assert.equal(reviewRequiredForTask(f.store, task), true);
    assert.equal(reviewRequiredFor(task, null), false, 'the pure rule reads the setting it is given');
    assert.equal(reviewRequiredFor({ skipPRReview: false }, null), true);
  } finally { f.close(); }
});

test('the reported head binds only from an authenticated report on the canonical PR', () => {
  const f = fixture();
  try {
    const prs = new ContinuedPrs(f.context);
    // No PR evidence at all is one answer, and a foreign PR is another: neither binds.
    assert.equal(prs.bindReportedHeadForReview(f.store.task(f.taskId), observed), false, 'a task with no PR binds nothing');
    assert.equal(f.store.events(f.taskId).filter(event => event.kind === 'reported_head_bound').length, 0);

    let task = f.reported();
    assert.equal(prs.bindReportedHeadForReview(task, { ...observed, headRepository: 'someone/fork' }), false, 'a foreign PR is not this task identity');
    assert.equal(prs.bindReportedHeadForReview(task, { ...observed, head: prior }), false, 'an unobserved head is not the report head');
    f.store.db.prepare('DELETE FROM receipts WHERE id=?').run(task.completion!.eventId);
    assert.equal(prs.bindReportedHeadForReview(f.store.task(f.taskId), observed), false, 'a report without its receipt binds nothing');

    task = f.reported(f.completion({ eventId: 'second-report', status: 'blocked' }));
    assert.equal(prs.bindReportedHeadForReview(f.store.task(f.taskId), observed), true);
    const bound = f.store.task(f.taskId);
    assert.equal(bound.prUrl, url);
    assert.equal(bound.prHead, head);
    assert.equal(bound.resumePrNumber, 44);
    assert.match(f.store.events(f.taskId).find(event => event.kind === 'reported_head_bound')!.detail, /identity only/);
    assert.equal(prs.bindReportedHeadForReview(bound, observed), false, 'a bound PR is not rebound');
  } finally { f.close(); }
});

test('a continued PR binding is identity only and binds inside its accepting transaction alone', async () => {
  const f = fixture();
  try {
    const prs = new ContinuedPrs(f.context);
    const task = f.reported();
    assert.throws(() => prs.continuedPrBinding(task, 44, { ...observed, headRepository: 'someone/fork' }),
      /not the canonical example\/repo; nothing was bound/);
    const binding: ContinuedPrBinding = prs.continuedPrBinding(task, 44, observed);
    assert.equal(binding.completionEventId, task.completion!.eventId);
    assert.equal(binding.priorHead, null);
    assert.equal(binding.head, head);

    assert.throws(() => prs.bindContinuedPrInTx(task.id, binding, 'move'), /inside the accepting transaction/);
    assert.equal(f.store.transaction(() => prs.bindContinuedPrInTx(task.id, binding, 'move')), true);
    assert.equal(f.store.transaction(() => prs.bindContinuedPrInTx(task.id, binding, 'move')), false,
      'the same binding does not bind twice');
    assert.equal(f.store.transaction(() => prs.bindContinuedPrInTx(task.id, { ...binding, head: prior }, 'move')), false,
      'a changed head is not accepted against the bound task');
    const after = f.store.task(task.id);
    assert.equal(after.prHead, head);
    assert.equal(after.prUrl, url);
    assert.match(f.store.events(task.id).find(event => event.kind === 'continued_pr_bound')!.detail, /known only from the ready_for_review report ready-report/);

    // A PR known only from a report is verified through the one continuation
    // proof and comes back as the same identity-only binding.
    f.reported(f.completion({ eventId: 'evidence-only-report', runId: 'second-worker' }));
    const verified = await prs.verifyContinuedPr(f.store.task(task.id));
    assert.equal(verified?.number, 44);
    assert.equal(verified?.head, head);
    assert.equal(verified?.completionEventId, 'evidence-only-report');
  } finally { f.close(); }
});
