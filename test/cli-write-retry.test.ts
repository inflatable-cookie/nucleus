import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyVersionedWrite, uncertainFailure, VersionedWriteError } from '../bin/versioned-write.mjs';
import { credentialFor, readRunTicket, runTicketPath } from '../bin/run-ticket.mjs';

/** A client that answers `queue.detail` from a script and the write from a script. */
function scriptedClient({ versions, write }) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async request(method, input) {
      calls.push({ method, input });
      if (method === 'queue.detail') return { task: { id: input.taskId, version: versions[Math.min(index, versions.length - 1)] } };
      const outcome = write[index++];
      if (outcome instanceof Error) throw outcome;
      if (outcome && typeof outcome === 'object' && 'code' in outcome) throw Object.assign(new Error(outcome.message), { code: outcome.code });
      return outcome;
    },
  };
}

const settle = async () => {};

test('an idempotent versioned write retries an uncertain failure with a fresh version', async () => {
  const client = scriptedClient({
    versions: [4, 5],
    write: [{ code: 'internal', message: 'Task changed; refresh before retrying' }, { id: 'task', version: 6 }],
  });
  const result = await applyVersionedWrite(client, {
    taskId: 'task', method: 'queue.completion-subscription', input: { agentId: 'thread', action: 'subscribe' },
    idempotent: true, delay: settle,
  });
  assert.deepEqual(result, { id: 'task', version: 6 });
  assert.deepEqual(client.calls.map(call => call.method),
    ['queue.detail', 'queue.completion-subscription', 'queue.detail', 'queue.completion-subscription']);
  const writes = client.calls.filter(call => call.method === 'queue.completion-subscription');
  assert.deepEqual(writes.map(call => call.input.version), [4, 5], 'each attempt sends the version it just read');
  assert.deepEqual(client.calls[1].input, { agentId: 'thread', action: 'subscribe', taskId: 'task', version: 4 });
});

test('a definitive refusal is answered once and never repeated', async () => {
  for (const code of ['refused', 'invalid_input', 'method_unknown', 'unauthenticated', 'protocol_version', 'something_new']) {
    const client = scriptedClient({ versions: [1], write: [{ code, message: `refused with ${code}` }] });
    await assert.rejects(applyVersionedWrite(client, {
      taskId: 'task', method: 'queue.completion-subscription', input: {}, idempotent: true, delay: settle,
    }), new RegExp(`refused with ${code}`), `${code} must not repeat`);
    assert.equal(client.calls.filter(call => call.method === 'queue.completion-subscription').length, 1, `${code} was repeated`);
    assert.equal(uncertainFailure({ code }), false);
  }
});

test('a write not declared idempotent is never repeated, even for a lost connection', async () => {
  const client = scriptedClient({ versions: [1], write: [new Error('Service socket closed')] });
  await assert.rejects(applyVersionedWrite(client, {
    taskId: 'task', method: 'queue.task', input: { action: 'promote' }, idempotent: false, delay: settle,
  }), /Service socket closed/);
  assert.equal(client.calls.filter(call => call.method === 'queue.task').length, 1);
});

test('exhaustion reports how many attempts ran and that the service was still uncertain', async () => {
  const uncertain = new Error('Service socket closed');
  const client = scriptedClient({ versions: [1, 2, 3], write: [uncertain, uncertain, uncertain] });
  const error = await applyVersionedWrite(client, {
    taskId: 'task', method: 'queue.completion-subscription', input: {}, idempotent: true, attempts: 3, delay: settle,
  }).catch(caught => caught);
  assert.ok(error instanceof VersionedWriteError);
  assert.equal(error.attempts, 3);
  assert.equal(error.uncertain, true);
  assert.equal(error.message, 'Service socket closed (still changing after 3 attempts; retry shortly)');
  assert.equal(client.calls.filter(call => call.method === 'queue.completion-subscription').length, 3);
});

test('a run ticket is read once, and a continuation of another run is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-ticket-'));
  try {
    const path = join(dir, 'run.json');
    writeFileSync(path, JSON.stringify({ socketPath: join(dir, 'c.sock'), token: 'secret', taskId: 'task-1', runId: 'run-1' }));
    const env = { NUCLEUS_TICKET: path };
    assert.equal(runTicketPath(env), path);
    const ticket = readRunTicket(env);
    assert.deepEqual({ taskId: ticket.taskId, runId: ticket.runId, participantId: ticket.participantId }, { taskId: 'task-1', runId: 'run-1', participantId: null });
    assert.deepEqual(credentialFor(ticket, 'self-force'), { socketPath: join(dir, 'c.sock'), token: 'secret' });
    // A continuation ticket wins, and it must belong to the continuation's own run.
    assert.equal(runTicketPath({ ...env, NUCLEUS_CONTINUATION_TICKET: path }), path);
    assert.throws(() => readRunTicket({ ...env, NUCLEUS_CONTINUATION_RUN_ID: 'run-2' }),
      /Continuation ticket is for run run-1, not current run run-2/);
    assert.equal(readRunTicket({}), null, 'a process with no ticket reads none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a participant ticket has no run credential to act with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-ticket-'));
  try {
    const path = join(dir, 'participant.json');
    writeFileSync(path, JSON.stringify({ socketPath: join(dir, 'c.sock'), token: 'secret', participantId: '00000000-0000-4000-8000-000000000001' }));
    const ticket = readRunTicket({ NUCLEUS_TICKET: path });
    assert.equal(ticket.participantId, '00000000-0000-4000-8000-000000000001');
    assert.throws(() => credentialFor(ticket, 'self-force'), /ticket is incomplete; self-force is unavailable/);
    const incomplete = join(dir, 'incomplete.json');
    writeFileSync(incomplete, JSON.stringify({ taskId: 'task-1' }));
    assert.throws(() => credentialFor(readRunTicket({ NUCLEUS_TICKET: incomplete }), 'question.answer'),
      /ticket is incomplete; question\.answer is unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
