import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Completion, Run, Task } from '../shared/contracts';
import { completionRefusal, RunCallbackIntake } from '../core/intake/callback-intake';
import type { Resolution } from '../core/resolution';

test('completion role and status refusals preserve precedence', () => {
  const cases: Array<[Run['role'], string, boolean, object, string | null]> = [
    ['reviewer', 'ready_to_merge', false, {}, null],
    ['revision', 'report_ready', true, {}, null],
    ['revision', 'report_ready', false, {}, 'Result is not valid for this run role'],
    ['executor', 'proof_executed', false, { proofResult: { selector: 'test' } }, null],
    ['recovery', 'recovered', false, { coordinatorAction: { verb: 'cannot', reason: 'x' } }, null],
    ['closeout', 'closed', false, { closeoutCommit: 'abc' }, null],
    ['reviewer', 'closed', false, { closeoutCommit: 'abc', providerUnavailable: true }, 'Published closeout commit requires a closed coordinator result'],
    ['reviewer', 'ready_to_merge', false, { providerUnavailable: true }, 'Provider unavailability requires blocked/error status'],
    ['reviewer', 'error', false, { providerUnavailable: true }, null],
  ];
  for (const [role, status, reportOnly, extra, expected] of cases) {
    assert.equal(completionRefusal({ status, head: 'head', prNumber: 1, reviewText: 'review', ...extra } as Completion, { role, head: 'head', proofExecution: { selector: 'test' } } as Run, { resolution: {} } as Task, reportOnly), expected, `${role}: ${status}`);
  }
});

test('source approval with empty awaitingProofs names the ready_to_merge route', () => {
  const intake = new RunCallbackIntake({} as Resolution);
  const head = 'a'.repeat(40);
  const run = { role: 'reviewer', head } as Run;
  const task = { resolution: {} } as Task;
  const input = {
    status: 'blocked',
    reviewResponsibility: 'environment',
    sourceApproved: true,
    head,
    reviewText: 'Source is ready; only owner-activated release gates remain',
    summary: 'blocked',
  } as Completion;
  const refusal = /Source approval requires an exact-head environment blocked review with findings and named awaiting proofs; if only release gates remain, report ready_to_merge/;
  assert.throws(() => intake.completeValidate(input, run, task), refusal);
  assert.throws(() => intake.completeValidate({ ...input, awaitingProofs: [] }, run, task), refusal);
});
