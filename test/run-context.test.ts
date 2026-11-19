import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { submissionSchema } from '../shared/contracts';
import { materializeRunContext } from '../core/dispatch/prompt-text/context-store';
import { startCallbacks } from '../service/callbacks/callback';
import { observeIdle } from './support/fakes';

test('run context is available only through the current run credential', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-context-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  const engine = new Engine(store, { observe: observeIdle('ws', 'worker') } as unknown as Adapter);
  const task = store.insert(submissionSchema.parse({ submissionId: 'context', title: 'Context', repoPath: '/fixture', planningCommit: 'a'.repeat(40), originAgentId: 'origin' }), 'host', 'brief', 'a'.repeat(40));
  store.update(task.id, { phase: 'working', runId: 'run-one', agentId: 'worker', workspaceId: 'ws', temporaryDirectory: dir });
  store.setCredential('run-one', 'one');
  store.setCredential('run-two', 'two');
  materializeRunContext(dir, 'run-one', { rules: 'rules', validation: 'validation', proofs: 'proofs', history: 'history' });
  const socketPath = join(dir, 'socket');
  const stop = await startCallbacks(socketPath, join(dir, 'helper.mjs'), engine);
  const call = (token: string, run: string, section?: string) => new Promise<{status: number; body: string}>((resolve, reject) => {
    const data = JSON.stringify({ callerTaskId: task.id, callerRunId: run, ...(section ? { section } : {}) });
    const req = request({ socketPath, path: '/run-context', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject); req.end(data);
  });
  try {
    for (const section of ['rules', 'validation', 'proofs', 'history']) {
      const result = await call('one', 'run-one', section);
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body), section);
    }
    assert.equal((await call('two', 'run-one', 'proofs')).status, 401);
    assert.notEqual((await call('two', 'run-two', 'proofs')).status, 200);
    assert.notEqual((await call('one', 'run-one', '../proofs')).status, 200);
  } finally {
    await engine.stop(); await stop(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
