import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideWorkerFailover, type WorkerFailoverFacts } from '../core/dispatch/worker-failover';

test('worker failover gates and outcomes', () => {
  const cases: [WorkerFailoverFacts, string][] = [
    [{ stage: 'observation', armed: false, sameWorkspace: false, stopped: false }, 'skip'],
    [{ stage: 'observation', armed: true, sameWorkspace: false, stopped: false }, 'workspace_changed'],
    [{ stage: 'observation', armed: true, sameWorkspace: true, stopped: false }, 'wait_old_worker'],
    [{ stage: 'observation', armed: true, sameWorkspace: true, stopped: true }, 'continue'],
    [{ stage: 'suppression', suppressed: true }, 'suppress'],
    [{ stage: 'suppression', suppressed: false }, 'continue'],
    [{ stage: 'ceiling', reached: true, relayed: false }, 'ceiling'],
    [{ stage: 'ceiling', reached: true, relayed: true }, 'continue'],
    [{ stage: 'catalog', known: false }, 'catalog_pending'],
    [{ stage: 'catalog', known: true }, 'continue'],
    [{ stage: 'unselected', instruction: true, alternate: true, cause: 'x' }, 'refuse_instruction'],
    [{ stage: 'unselected', instruction: false, alternate: true, cause: '' }, 'refuse_unavailable'],
    [{ stage: 'unselected', instruction: false, alternate: false, cause: 'x' }, 'refuse_route'],
    [{ stage: 'selected', failure: false, requestedId: null, selectedId: 'a', operatorArmed: false, relayed: false }, 'refuse_same_model'],
    [{ stage: 'selected', failure: false, requestedId: 'b', selectedId: 'a', operatorArmed: false, relayed: false }, 'refuse_superseded'],
    [{ stage: 'selected', failure: true, requestedId: 'b', selectedId: 'a', operatorArmed: false, relayed: false }, 'continue'],
    [{ stage: 'replacement', decision: { allowed: false, rule: 'signoff_pending', detail: 'x' }, selected: {} as never, replacingStoppedRevision: false, replacingStoppedWorker: false }, 'refuse_rule'],
    [{ stage: 'replacement', decision: { allowed: true, cause: 'x' }, selected: {} as never, replacingStoppedRevision: true, replacingStoppedWorker: false }, 'replace'],
  ];
  for (const [facts, expected] of cases) assert.equal(decideWorkerFailover(facts).kind, expected, JSON.stringify(facts));
});
