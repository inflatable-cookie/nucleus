import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { submissionSchema, proofExecutionRecordSchema, taskControlInputSchema } from '../shared/contracts';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import type { Adapter } from '../core/host';

const head = 'a'.repeat(40), selector = 'effigy check', inputs = [`sha256:${'b'.repeat(64)}`];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-acceptance-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const submission = submissionSchema.parse({ submissionId: randomUUID(), title: 'qualification', repoPath: '/repo', planningCommit: head,
    brief: { text: 'qualification', mediaType: 'text/markdown' }, originAgentId: 'origin', proofOnly: { commit: head }, proofExecution: { selector, inputs } });
  const initial = store.insert(submission, 'host', 'qualification', head);
  const receipt = proofExecutionRecordSchema.parse({ runId: 'run', workspaceId: 'workspace', selector, inputs, branch: '', head,
    authorizedBy: { role: 'queue_dispatch' }, activatedAt: '2026-11-08T00:00:00Z', settledAt: '2026-11-08T00:01:00Z', status: 'passed', exitCode: 0, evidence: 'all checks passed' });
  store.update(initial.id, { phase: 'done', proofExecutions: [receipt], proofOnlyResult: { status: 'failed', commit: head, selector, executionRunId: 'run', reviewerRunId: 'reviewer', evidence: 'Reviewer: profile preference' } });
  const engine = new Engine(store, {} as Adapter, 0);
  return { store, engine, task: () => store.task(initial.id) };
}

test('board alone lists receipt acceptance; a relayed operator note and completion notice are retained', async () => {
  const f = fixture();
  try {
    const task = f.task();
    const facts = collectOwnerVerbFacts(f.store, task);
    assert.equal(ownerTaskNext(facts).verbs.some(v => v.verb === 'accept_receipt'), false);
    const action = ownerTaskNext({ ...facts, operatorBoard: true }).verbs.find(v => v.verb === 'accept_receipt');
    assert.equal(action?.available, true);
    f.store.putNotice({ id: 'notice', taskId: task.id, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null,
      sources: ['origin'], originEntry: true, kind: 'completion', status: 'pending', error: '', text: 'Completed failed' });
    const input = { taskId: task.id, version: task.version, action: 'accept_receipt', reason: 'Unrelated finding' };
    for (const caller of ['planner', 'worker', 'reviewer', 'decider'])
      await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ ...input, caller })), /operator/);
    const accepted = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...input, caller: 'relay', relayed: true, note: 'Tom: accept this receipt' }));
    assert.deepEqual(accepted.proofReceiptAcceptance?.authorization, { role: 'authorized_relay', note: 'Tom: accept this receipt' });
    const notices = f.store.notices(task.id);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /accepted receipt run/);
    assert.match(notices[0]!.text, /Reviewer: profile preference/);
    assert.equal(notices[0]!.status, 'pending');
  } finally { f.store.close(); }
});
