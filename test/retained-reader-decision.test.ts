import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { retainedReaderDecision } from '../core/verbs/moves';
import { REVIEW_AGENT_CLOSED, REVIEW_BUDGET_EXHAUSTED, REVIEW_FRESH_REPLACEMENT_EXIT } from '../core/review/review-continuation';

test('retained reader decision preserves, continues or refuses each observed state', () => {
  const base = { reader: true, state: 'awaiting' as const, busy: false, status: 'idle', waitReason: 'pending', agentId: 'agent', runId: 'run' };
  const cases: Array<[Partial<Parameters<typeof retainedReaderDecision>[0]>, ReturnType<typeof retainedReaderDecision>]> = [
    [{ reader: false }, { kind: 'fallthrough' }],
    [{ reader: false, busy: true }, { kind: 'preserve' }],
    [{ state: 'reserved' }, { kind: 'refuse', message: 'Move to review cannot act while a reviewer delivery is unsettled: pending. Inspect the retained reviewer thread; no review turn was sent' }],
    [{ state: 'uncertain', busy: true }, { kind: 'refuse', message: 'Move to review cannot act while a reviewer delivery is unsettled: pending. Inspect the retained reviewer thread; no review turn was sent' }],
    [{ state: 'exhausted' }, { kind: 'refuse', message: `Move to review preserves a reader it can continue, and this one cannot: ${REVIEW_BUDGET_EXHAUSTED} ${REVIEW_FRESH_REPLACEMENT_EXIT}` }],
    [{ state: 'closed' }, { kind: 'refuse', message: `Move to review preserves a reader it can continue, and this one cannot: ${REVIEW_AGENT_CLOSED} ${REVIEW_FRESH_REPLACEMENT_EXIT}` }],
    [{ status: 'closed', busy: true }, { kind: 'refuse', message: `Move to review preserves a reader it can continue, and this one cannot: ${REVIEW_AGENT_CLOSED} ${REVIEW_FRESH_REPLACEMENT_EXIT}` }],
    [{ state: 'continuing' }, { kind: 'preserve' }],
    [{ busy: true }, { kind: 'preserve' }],
    [{}, { kind: 'continue' }],
    [{ status: 'error' }, { kind: 'refuse', message: `The retained reviewer (agent agent, run run) is error with an awaiting checkpoint, so move to review cannot continue it. ${REVIEW_FRESH_REPLACEMENT_EXIT}` }],
  ];
  for (const [changes, expected] of cases) assert.deepEqual(retainedReaderDecision({ ...base, ...changes }), expected);
});
