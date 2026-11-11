/**
 * Spec 056 through the public RuntimeOwner/durable-operation envelope: the
 * preview is read-only, the apply is a durable `repository_rekey` operation, a
 * lost reply reconciles the same operation and receipt, and a refusal settles
 * as a definite failure with nothing written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { submissionSchema } from '../shared/contracts';
import { suggestedRepositoryRekeyKey } from '../shared/repository-rekey';

const SOURCE = { origin: 'acme/app', path: '/fixture/app' };
const TARGET = { origin: 'acme/app-next', path: '' };

test('Spec 056 a repository re-key is one durable operation with one idempotent receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-rekey-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.setRepository({ repository: SOURCE.origin, closeout: 'agent', note: 'service settings' });
    const store = (runtime as unknown as { store: import('../core/store/store').Store }).store;
    const input = submissionSchema.parse({ submissionId: 'sub-service', title: 'Service task', repoPath: SOURCE.path,
      planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
    const task = store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, SOURCE.origin);
    store.update(task.id, { phase: 'done' }, 'done');

    const step = {
      source: SOURCE.origin, target: TARGET, expectedSourceRevision: store.repositoryFor(SOURCE.origin)!.revision,
      reason: 'GitHub rename acme/app to acme/app-next', author: 'operator',
      idempotencyKey: suggestedRepositoryRekeyKey({ source: SOURCE.origin, target: TARGET }),
    };
    const { author: _author, ...request } = step;
    const preview = runtime.previewRepositoryRekey(request);
    assert.equal(preview.ready, true, JSON.stringify(preview.refusals));
    assert.equal(store.repositoryFor(SOURCE.origin)?.note, 'service settings', 'preview writes nothing');

    const result = await runtime.rekeyRepository(step);
    assert.ok('receipt' in result, `expected a settled receipt, got ${JSON.stringify(result)}`);
    if (!('receipt' in result)) return;
    assert.equal(result.replayed, false);
    assert.equal(result.receipt.source.origin, SOURCE.origin);
    assert.equal(result.receipt.target.origin, TARGET.origin);
    assert.equal(result.receipt.reason, step.reason);
    assert.equal(result.receipt.author, 'operator');
    assert.equal(result.receipt.counts.repositorySettings, 1);
    assert.equal(result.receipt.counts.tasks, 1);
    assert.equal(store.repositoryFor(TARGET.origin)?.note, 'service settings');
    assert.equal(store.task(task.id).reference, 'app-next#001');

    // The durable operation is settled under the same key.
    const operations = store.operations({ states: ['succeeded'] }).filter(operation => operation.kind === 'repository_rekey');
    assert.equal(operations.length, 1);
    assert.equal(operations[0].state, 'succeeded');
    assert.equal(operations[0].result?.reference, result.receipt.id);

    // A lost reply reads the same operation and receipt; nothing applies twice.
    const replay = await runtime.rekeyRepository(step);
    assert.ok('receipt' in replay);
    if (!('receipt' in replay)) return;
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, result.receipt);
    assert.equal(runtime.repositoryRekeyReceipt({ key: step.idempotencyKey })?.id, result.receipt.id);
    assert.equal(runtime.repositoryRekeyReceipt({ id: result.receipt.id })?.target.origin, TARGET.origin);
    assert.equal(store.repositoryRekeys().length, 1);

    // A refusal settles as a definite failed operation and writes nothing.
    const unknown = { ...step, source: 'acme/missing', idempotencyKey: 'repository-rekey:unknown' };
    await assert.rejects(runtime.rekeyRepository(unknown), /unknown_source/);
    assert.equal(store.repositoryRekeys().length, 1);
    assert.equal(store.repositoryFor(TARGET.origin)?.note, 'service settings');
  } finally { await runtime.stop(); }
});
