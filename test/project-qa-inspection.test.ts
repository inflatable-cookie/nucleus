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

test('service history distinguishes an observed restart, a quiet window and missing history', async () => {
  const { qaServiceWindow, recordQaServiceLifecycle } = await import('../core/qa/project-qa-diagnostics');
  const meta = new Map<string, unknown>();
  const store = { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: unknown) => { meta.set(key, value); } } as any;
  assert.equal(qaServiceWindow(store, '2026-11-16T10:00:00Z', '2026-11-16T10:05:00Z').restart, 'unknown');
  recordQaServiceLifecycle(store, 'start', '2026-11-16T09:00:00Z');
  assert.equal(qaServiceWindow(store, '2026-11-16T10:00:00Z', '2026-11-16T10:05:00Z').restart, 'not_observed');
  recordQaServiceLifecycle(store, 'roll', '2026-11-16T10:01:00Z');
  recordQaServiceLifecycle(store, 'start', '2026-11-16T10:02:00Z');
  const window = qaServiceWindow(store, '2026-11-16T10:00:00Z', '2026-11-16T10:05:00Z');
  assert.equal(window.roll, 'observed');
  assert.equal(window.restart, 'observed');
  assert.deepEqual(window.events.map(event => event.kind), ['roll', 'start']);
  for (let i = 0; i < 64; i++) recordQaServiceLifecycle(store, 'roll', '2026-11-16T11:00:00Z');
  assert.equal(qaServiceWindow(store, '2026-11-16T10:00:00Z', '2026-11-16T10:05:00Z').roll, 'unknown', 'retention never invents a quiet gap');
});
