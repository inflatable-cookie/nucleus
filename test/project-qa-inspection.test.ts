import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { projectQaRunReads, type QaRunReadContext } from '../core/qa/project-qa-inspection';
import type { ProjectQaRun } from '../shared/contracts';

test('QA read reconciliation stays best-effort but reports its failure', async () => {
  const run = { id: 'run-1', key: 'owner/repo' } as ProjectQaRun;
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const context = {
      store: { qaRun: () => run },
      reconcile: async () => { throw new Error('reconcile unavailable'); },
    } as unknown as QaRunReadContext;
    assert.equal(await projectQaRunReads.get.call(context, { id: run.id }), run);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Project QA read reconciliation failed for run run-1/);
    assert.match(String(warnings[0][1]), /reconcile unavailable/);
  } finally {
    console.warn = warn;
  }
});
