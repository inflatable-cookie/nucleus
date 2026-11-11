import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../shared/contracts';
import { RPC_CATALOGUE, BRIDGE_CATALOGUE } from '../shared/rpc-catalogue';
import { QueueRuntime } from '../service/runtime-owner';

/**
 * Every served method is classified mutating or read-only, because the client
 * retries only a read whose outcome is unknown. This list is the deliberate
 * read-only expectation: a new method must be added here or marked mutating, and
 * a method may not silently change classification.
 */
const READ_ONLY_METHODS = new Set(['caller.resolve', 'host.run.list', 'host.run.accounting.status', 'host.run.accounting.list', 'host.run.board',
  'queue.snapshot', 'backup.list', 'queue.ui-snapshot', 'queue.queued-page', 'lane.task-page', 'queue.detail',
  'queue.outcome', 'queue.outcome-search', 'papercut.list', 'papercut.get', 'lead.get', 'lead.version', 'lead.list', 'lead.board',
  'question.native-list', 'decision.get', 'decision.list', 'decision.agent-projects', 'lane.document.get', 'plan.get', 'plans', 'lanes', 'repository.get',
  'repositories', 'repository.rekey-preview', 'repository.rekey-receipt', 'project.get', 'projects', 'project.removal-blockers', 'project.merge-check', 'project.owner-candidates', 'project.settings', 'project.qa.get', 'project.qa.list', 'queue.telemetry',
  'queue.review-entry-preview', 'queue.bulk-disposition-detail', 'queue.capacity-state',
  'task.next',
  // Nucleus's own profile list is read through these; the host catalog is the host's report.
  'profile.list', 'profile.providers', 'host.catalog',
  // Read-only on the catalogue since ed40faa8; its deliberate read-only entry landed late (2026-10-14).
  'project.management-preview', 'project.qa.request-status', 'project.qa.fence-status',
  // Spec 059: the usage gauge reads stored readings and projections only; reads are paced by the service.
  'usage.state',
]);

/**
 * Generated registration parity (Contract 007): the shared catalogue must
 * cover every RPC contract exported from shared/contracts exactly once, and
 * every catalogue method must bind to a real owner handler, so interaction
 * coverage cannot drift between the service and the bridge.
 */
test('the shared catalogue covers every plugin RPC contract exactly once', () => {
  const values: unknown[] = Object.values(contracts);
  const contractsServed = values.filter((entry): entry is { name: string; input: unknown; output: unknown } =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as { name?: unknown }).name === 'string'
    && !!(entry as { input?: unknown }).input
    && !!(entry as { output?: unknown }).output);
  const catalogueNames = [...RPC_CATALOGUE, ...BRIDGE_CATALOGUE].map(entry => entry.name);
  assert.equal(new Set(catalogueNames).size, catalogueNames.length, 'catalogue entries must be unique');
  assert.deepEqual(catalogueNames.sort(), contractsServed.map(contract => contract.name).sort());
});

test('every catalogue entry binds to a QueueRuntime owner method', () => {
  const owner = Object.getOwnPropertyNames(QueueRuntime.prototype);
  for (const entry of RPC_CATALOGUE) {
    assert.ok(owner.includes(entry.method), `catalogue method ${entry.name} has no owner handler ${entry.method}`);
  }
  assert.ok(RPC_CATALOGUE.length >= 26, 'the catalogue must remain the complete interaction surface');
});

test('every catalogue method is classified mutating or read-only, and the split is deliberate', () => {
  for (const entry of RPC_CATALOGUE) {
    assert.equal(typeof entry.mutating, 'boolean', `${entry.name} must be classified`);
    assert.equal(entry.mutating, !READ_ONLY_METHODS.has(entry.name),
      `${entry.name} classification changed; update the deliberate read-only list`);
  }
  const readOnly = RPC_CATALOGUE.filter(entry => !entry.mutating).map(entry => entry.name);
  assert.deepEqual([...readOnly].sort(), [...READ_ONLY_METHODS].sort(), 'the read-only list must stay exact');
  assert.equal(BRIDGE_CATALOGUE.every(entry => entry.mutating === false), true, 'bridge-only methods are reads on the service');
});

test('papercut filing controls remain available after file import retirement', () => {
  const names = new Set<string>(RPC_CATALOGUE.map(entry => entry.name));
  assert.equal(names.has('papercut.import'), false);
  for (const name of ['papercut.add', 'papercut.get', 'papercut.list', 'papercut.edit', 'papercut.close', 'papercut.promote', 'papercut.promote-task', 'papercut.set-lanes', 'project.qa.request-status'])
    assert.ok(names.has(name), `${name} remains available`);
});
