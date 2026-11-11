import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nonDeliveryFor, reportsExternalCause, unfinishedReturnFor, continuationInstruction } from '../core/recovery/non-delivery';
import { deriveTaskTelemetry } from '../core/telemetry/telemetry';
import { Store } from '../core/store/store';
import { submissionSchema, type Completion, type Task } from '../shared/contracts';

test('non-delivery needs an unchanged readable head and no external cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-non-delivery-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    run('init'); run('config', 'user.name', 'Queue test'); run('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(dir, 'README.md'), 'base\n'); run('add', 'README.md'); run('commit', '-m', 'base');
    const baseline = run('rev-parse', 'HEAD');
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'non-delivery', title: 'Task', repoPath: dir,
      planningCommit: baseline, handoffPath: '', originAgentId: 'origin' }), 'host', 'brief', baseline);
    const task = store.update(inserted.id, { responsible: true, directory: dir, runId: 'worker-run', profile: { id: 'terra', name: 'Terra',
      provider: 'openai', model: 'gpt-6.1-terra', notes: '', available: true, problem: '', supportedThinking: [] } }) as Task;
    const completion = { taskId: task.id, runId: task.runId!, eventId: 'blocked', status: 'blocked', summary: 'No external blocker; I did not implement', impediment: 'npm ci exited 1: registry unreachable' } as Completion;
    assert.equal(nonDeliveryFor(task, null, completion, [])?.observedHead, baseline);
    assert.equal(nonDeliveryFor(task, null, { ...completion, status: 'error' }, [])?.status, 'error');
    assert.equal(nonDeliveryFor(task, null, { ...completion, summary: 'Missing dependency: package is unavailable' }, []), null);
    assert.equal(nonDeliveryFor(task, null, { ...completion, cause: { kind: 'external', name: 'preflight guard refusal' } }, []), null);
    assert.equal(reportsExternalCause({ ...completion, summary: 'No external blocker; unchanged', cause: { kind: 'external', name: 'preflight guard refusal' } }, [], task.runId!), true,
      'the structured cause wins over contrary summary wording');
    assert.equal(nonDeliveryFor(task, null, { ...completion, summary: 'quota exhausted', cause: { kind: 'internal' } }, [] )?.observedHead, baseline,
      'a structured internal cause wins over legacy keyword fallback');
    assert.equal(nonDeliveryFor(task, null, { ...completion, cause: { kind: 'internal' } },
      [{ kind: 'runnable_proof_refused', detail: `${task.runId}: budget admission refused` }]), null,
      'Queue proof and admission evidence overrides an internal worker label');
    assert.equal(nonDeliveryFor(task, null, { ...completion, providerUnavailable: true }, []), null);
    assert.equal(nonDeliveryFor(task, null, completion, [{ kind: 'agent_ask', detail: `ask: run ${task.runId}` }]), null);
    writeFileSync(join(dir, 'README.md'), 'changed\n'); run('add', 'README.md'); run('commit', '-m', 'implementation');
    assert.equal(nonDeliveryFor(task, null, completion, []), null);
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit no-automatic-retry brief prevents automatic non-delivery and unfinished continuations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-no-retry-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    run('init'); run('config', 'user.name', 'Queue test'); run('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(dir, 'README.md'), 'base\n'); run('add', 'README.md'); run('commit', '-m', 'base');
    const baseline = run('rev-parse', 'HEAD');
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'no-retry', title: 'Task', repoPath: dir,
      planningCommit: baseline, handoffPath: '', originAgentId: 'origin' }), 'host', 'No automatic retry or step 2 until the owner reconciles.', baseline);
    const task = store.update(inserted.id, { responsible: true, directory: dir, runId: 'worker-run' }) as Task;
    const completion = { taskId: task.id, runId: task.runId!, eventId: 'blocked', status: 'blocked', summary: 'Still unfinished; no change', cause: { kind: 'internal' } } as Completion;
    assert.equal(nonDeliveryFor(task, null, completion, []), null);
    assert.equal(unfinishedReturnFor(task, null, completion, []), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an unfinished return with new commits continues the same round instead of non-delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-unfinished-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    run('init'); run('config', 'user.name', 'Queue test'); run('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(dir, 'README.md'), 'base\n'); run('add', 'README.md'); run('commit', '-m', 'base');
    const baseline = run('rev-parse', 'HEAD');
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'unfinished', title: 'Task', repoPath: dir,
      planningCommit: baseline, handoffPath: '', originAgentId: 'origin' }), 'host', 'brief', baseline);
    const task = store.update(inserted.id, { responsible: true, directory: dir, runId: 'worker-run', profile: { id: 'terra', name: 'Terra',
      provider: 'openai', model: 'gpt-6.1-terra', notes: '', available: true, problem: '', supportedThinking: [] } }) as Task;
    const blocked = (summary: string) => ({ taskId: task.id, runId: task.runId!, eventId: 'blocked', status: 'blocked', summary }) as Completion;
    // No progress yet and no impediment: the same worker continues (Task 676); the words never decide it.
    assert.equal(unfinishedReturnFor(task, null, blocked('Implementation remains unfinished; the wrapper is still unwritten'), [])?.reason, 'no_impediment');
    // Partial progress: the incident shape (project-c#240) is a continuation, not a non-delivery.
    writeFileSync(join(dir, 'wrapper.ts'), 'partial\n'); run('add', 'wrapper.ts'); run('commit', '-m', 'partial wrapper');
    const progressed = run('rev-parse', 'HEAD');
    const continuation = unfinishedReturnFor(task, null,
      blocked('Error: implementation remains unfinished; the wrapper is in but the full inventory is still unwritten'), []);
    assert.deepEqual(continuation, { runId: 'worker-run', role: 'worker', status: 'blocked', provider: 'openai',
      model: 'gpt-6.1-terra', baselineHead: baseline, observedHead: progressed });
    // The two shapes are mutually exclusive: new commits exclude the #575 no-change rule.
    assert.equal(nonDeliveryFor(task, null, blocked('No external blocker and no change'), []), null);
    // A named external cause keeps the ordinary blocked path even with progress and unfinished wording.
    assert.equal(unfinishedReturnFor(task, null,
      blocked('Blocked: awaiting operator decision on the remaining scope'), []), null);
    // A failure report with new pushed commits and no recorded external cause is unfinished work too:
    // the positive Git evidence decides, not the summary's wording.
    assert.equal(unfinishedReturnFor(task, null, blocked('Something failed in the harness'), [])?.observedHead, progressed);
    assert.equal(unfinishedReturnFor(task, null, { ...blocked('Still unfinished'), status: 'ready_for_review' }, []), null);
    const revision = { id: 'revision-1', role: 'revision', head: baseline } as unknown as Parameters<typeof unfinishedReturnFor>[1];
    assert.equal(unfinishedReturnFor(task, revision,
      { ...blocked('Partial progress; half the files are done, the rest is not yet implemented'), runId: 'revision-1' }, [])?.role, 'revision');
    const reviewer = { id: 'reviewer-1', role: 'reviewer', head: baseline } as unknown as Parameters<typeof unfinishedReturnFor>[1];
    assert.equal(unfinishedReturnFor(task, reviewer, blocked('Still unfinished'), []), null);
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('a blocked return with no impediment and no new commit continues the same thread twice, then the ladder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-no-impediment-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    run('init'); run('config', 'user.name', 'Queue test'); run('config', 'user.email', 'queue-test@example.test');
    writeFileSync(join(dir, 'README.md'), 'base\n'); run('add', 'README.md'); run('commit', '-m', 'base');
    const baseline = run('rev-parse', 'HEAD');
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'no-impediment', title: 'Task', repoPath: dir,
      planningCommit: baseline, handoffPath: '', originAgentId: 'origin' }), 'host', 'brief', baseline);
    const task = store.update(inserted.id, { responsible: true, directory: dir, runId: 'worker-run', agentId: 'worker-thread', profile: { id: 'terra', name: 'Terra',
      provider: 'openai', model: 'gpt-6.1-terra', notes: '', available: true, problem: '', supportedThinking: [] } }) as Task;
    const blocked = (summary: string, extra: Partial<Completion> = {}) => ({ taskId: task.id, runId: task.runId!, eventId: 'blocked', status: 'blocked', summary, ...extra }) as Completion;
    const continuation = (agentId: string) => ({ kind: 'unfinished_continuation', detail: JSON.stringify({ runId: 'earlier', role: 'worker', status: 'blocked',
      provider: 'openai', model: 'gpt-6.1-terra', baselineHead: baseline, observedHead: baseline, reason: 'no_impediment', agentId }) });
    const first = unfinishedReturnFor(task, null, blocked('Setup is confirmed'), []);
    assert.equal(first?.reason, 'no_impediment');
    assert.equal(first?.agentId, 'worker-thread');
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed', { status: 'error' }), [continuation('worker-thread')])?.reason, 'no_impediment');
    // The bound counts this thread's continuations: the third empty return goes to the ladder.
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed'), [continuation('worker-thread'), continuation('worker-thread')]), null);
    // Another thread's continuations do not spend this thread's bound.
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed'), [continuation('other-thread'), continuation('other-thread')])?.reason, 'no_impediment');
    // An impediment, a typed external cause, a provider failure or a ready report keeps today's handling.
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed', { impediment: 'npm ci exited 1' }), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed', { cause: { kind: 'external', name: 'registry outage' } }), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed', { providerUnavailable: true }), []), null);
    // Provider failures Queue classifies from wording keep their existing handling.
    assert.equal(unfinishedReturnFor(task, null, blocked('Provider quota exhausted on the codex key'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Rate limit reached; retry later'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('insufficient_quota from the provider'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Service unavailable from the registry'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Network unavailable while fetching'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Credentials unavailable for the forge'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Permission denied writing the branch'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Upgrade your plan to continue'), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Missing dependency: package is unavailable'), []), null);
    // A negated external phrase is not an external cause: the no-impediment continuation still applies.
    assert.equal(unfinishedReturnFor(task, null, blocked('No external blocker; setup is confirmed'), [])?.reason, 'no_impediment');
    assert.equal(unfinishedReturnFor(task, null, { ...blocked('Setup is confirmed'), status: 'ready_for_review' } as Completion, []), null);
    // Retained workers predating the prompt update return to their task through the existing continuation.
    const forge = blocked('Push failed twice', { impediment: 'git push returned HTTP 502 from github.com', cause: { kind: 'external', name: 'GitHub outage' } });
    const waiting = unfinishedReturnFor(task, null, forge, []);
    assert.equal(waiting?.reason, 'forge_transient');
    assert.equal(nonDeliveryFor(task, null, forge, []), null);
    assert.match(continuationInstruction(waiting!), /observing the remote branch or existing PR before every retry/);
    const record = (forgeStartedAt: number) => ({ kind: 'unfinished_continuation', detail: JSON.stringify({ ...waiting, runId: 'previous', forgeStartedAt }) });
    const started = Date.now() - 5 * 60_000;
    assert.equal(unfinishedReturnFor(task, null, forge, [record(started)])?.forgeStartedAt, started);
    assert.equal(unfinishedReturnFor(task, null, forge, [record(Date.now() - 15 * 60_000)]), null, 'a persistent outage keeps the blocker route after the bound');
    assert.equal(unfinishedReturnFor(task, null, blocked('Push refused', { impediment: 'git push: permission denied', cause: { kind: 'external', name: 'authentication' } }), []), null);
    assert.equal(unfinishedReturnFor(task, null, blocked('Model API HTTP 502', { impediment: 'provider unavailable', cause: { kind: 'external', name: 'provider' } }), []), null);
    // A new pushed commit is unfinished progress with no external cause, whatever the summary says.
    writeFileSync(join(dir, 'wrapper.ts'), 'partial\n'); run('add', 'wrapper.ts'); run('commit', '-m', 'partial wrapper');
    assert.equal(unfinishedReturnFor(task, null, blocked('Setup is confirmed'), [])?.observedHead, run('rev-parse', 'HEAD'));
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('task telemetry reports non-delivery totals and model attribution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-non-delivery-telemetry-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'non-delivery-telemetry', title: 'Task', repoPath: '/repo',
      planningCommit: 'a'.repeat(40), handoffPath: '', originAgentId: 'origin' }), 'host', 'brief', 'a'.repeat(40));
    const event = { runId: 'worker-run', role: 'worker', status: 'blocked', provider: 'openai', model: 'gpt-6.1-terra',
      baselineHead: 'a'.repeat(40), observedHead: 'a'.repeat(40) };
    store.event(inserted.id, 'non_delivery', JSON.stringify(event));
    const task = store.task(inserted.id);
    const telemetry = deriveTaskTelemetry(task, store.eventsAll(task.id), [], [], [], new Date(task.createdAt));
    assert.deepEqual(telemetry.nonDelivery, { count: 1, byModel: [{ provider: 'openai', model: 'gpt-6.1-terra', count: 1 }] });
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
