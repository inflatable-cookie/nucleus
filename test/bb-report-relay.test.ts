/**
 * nucleus#1315: the socket-free report relay a BB role thread uses from inside
 * its provider sandbox.
 *
 * A sandboxed thread cannot open the Nucleus callback socket (Claude Code's
 * sandbox refuses every Unix socket: measured `EPERM`), so the packaged helper
 * hands its exact payload to the BB backend over loopback and the backend
 * forwards it to that run's own ticket-bound route. These tests pin the gate:
 * nothing is forwarded before the ticket, its credential, the run identity and
 * the callback socket are all proved, and the answer is the service's own.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  postToCallbackSocket,
  readRelayTicket,
  relayRequest,
  relayRunReport,
  ReportRelayRefusal,
  REPORT_RELAY_ROUTES,
  type RelayTicket,
} from '../hosts/bb/plugin/report-relay';

interface Fixture {
  dataDir: string;
  socketPath: string;
  server: Server;
  received: Array<{ path: string; auth: string | undefined; body: string }>;
  close(): Promise<void>;
}

/** A callback socket that answers every request with the one receipt this test asserts. */
async function callbackSocket(t: TestContext): Promise<Fixture> {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'bb-report-relay-')));
  mkdirSync(join(dataDir, 'tickets'), { recursive: true, mode: 0o700 });
  const socketPath = join(dataDir, 'callback.sock');
  const received: Fixture['received'] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url ?? '', auth: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, status: request.url === '/complete' ? 'accepted' : 'answered' }));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  };
  t.after(close);
  return { dataDir, socketPath, server, received, close };
}

function writeTicket(fixture: Pick<Fixture, 'dataDir' | 'socketPath'>, runId: string, overrides: Record<string, unknown> = {}): string {
  const ticket = join(fixture.dataDir, 'tickets', `${runId}.json`);
  writeFileSync(ticket, JSON.stringify({ socketPath: fixture.socketPath, taskId: 'task-1', runId, token: 'run-secret', host: 'bb:0123456789abcdef0123456789abcdef', ...overrides }), { mode: 0o600 });
  chmodSync(ticket, 0o600);
  return ticket;
}

const report = (runId: string, extra: Record<string, unknown> = {}) => ({
  route: '/complete', taskId: 'task-1', runId, token: 'run-secret',
  payload: { taskId: 'task-1', runId, status: 'blocked', summary: 'A sandboxed report', eventId: 'a'.repeat(64) }, ...extra,
});

test('a sandboxed thread report reaches the callback socket with the ticket credential', async (t: TestContext) => {
  const fixture = await callbackSocket(t);
  writeTicket(fixture, 'run-1');
  const answer = await relayRunReport({ dataDir: fixture.dataDir, body: report('run-1') });
  assert.equal(answer.status, 200);
  assert.equal(JSON.parse(answer.body).ok, true);
  assert.equal(fixture.received.length, 1);
  assert.equal(fixture.received[0]!.path, '/complete');
  assert.equal(fixture.received[0]!.auth, 'Bearer run-secret');
  assert.deepEqual(JSON.parse(fixture.received[0]!.body), report('run-1').payload);
});

test('the relay answers every route a packaged helper uses and no other route', async (t: TestContext) => {
  const fixture = await callbackSocket(t);
  assert.deepEqual([...REPORT_RELAY_ROUTES], ['/complete', '/ask', '/message', '/answer', '/task-next']);
  for (const [index, route] of REPORT_RELAY_ROUTES.entries()) {
    const runId = `run-${index}`;
    writeTicket(fixture, runId);
    const payload = route === '/task-next'
      ? { callerTaskId: 'task-1', callerRunId: runId }
      : { taskId: 'task-1', runId, summary: route };
    await relayRunReport({ dataDir: fixture.dataDir, body: { route, taskId: 'task-1', runId, token: 'run-secret', payload } });
  }
  assert.deepEqual(fixture.received.map(entry => entry.path), [...REPORT_RELAY_ROUTES]);
  assert.equal(fixture.received.every(entry => entry.auth === 'Bearer run-secret'), true, 'every forward used the ticket credential');
  await assert.rejects(
    relayRunReport({ dataDir: fixture.dataDir, body: { ...report('run-0'), route: '/tasks' } }),
    (error: unknown) => error instanceof ReportRelayRefusal && /not a callback route/.test(error.message));
  assert.equal(fixture.received.length, REPORT_RELAY_ROUTES.length, 'an unlisted route forwarded nothing');
});

test('the relay refuses anything that does not prove this run and this data home', async (t: TestContext) => {
  const fixture = await callbackSocket(t);
  writeTicket(fixture, 'run-1');
  const post = async () => ({ status: 200, body: '{"ok":true}' });
  const forward = (body: unknown, dataDir = fixture.dataDir) => relayRunReport({ dataDir, body, deps: { post } });
  const refusals: Array<[string, unknown, RegExp]> = [
    ['another run id', { ...report('run-2') }, /No run ticket/],
    ['a non-run id', { ...report('run-1'), runId: '../ticket' }, /names no run/],
    ['no run id', { ...report('run-1'), runId: undefined }, /names no run/],
    ['another token', { ...report('run-1'), token: 'another' }, /does not match this run's ticket/],
    ['another task', { ...report('run-1'), taskId: 'task-2' }, /another task/],
    ['a payload naming another run', { ...report('run-1'), payload: { ...report('run-1').payload, runId: 'run-9' } }, /another task or run/],
    ['another caller for next', { ...report('run-1'), route: '/task-next', payload: { callerTaskId: 'task-2', callerRunId: 'run-1' } }, /another caller/],
    ['a non-object payload', { ...report('run-1'), payload: 'text' }, /payload is not an object/],
  ];
  for (const [label, body, reason] of refusals) {
    await assert.rejects(forward(body), (error: unknown) => error instanceof ReportRelayRefusal && reason.test(error.message), label);
  }
  assert.equal(fixture.received.length, 0, 'no refusal forwarded anything');
  await assert.rejects(forward(report('run-1'), join(fixture.dataDir, 'elsewhere')), (error: unknown) => error instanceof ReportRelayRefusal && /unreadable/.test(error.message));
  await assert.rejects(relayRunReport({ dataDir: null, body: report('run-1') }), (error: unknown) => error instanceof ReportRelayRefusal && /not configured/.test(error.message));
});

test('a ticket another user can read, a redirected ticket and a foreign socket are refused', async (t: TestContext) => {
  const fixture = await callbackSocket(t);
  const ticketPath = writeTicket(fixture, 'run-1');
  chmodSync(ticketPath, 0o644);
  await assert.rejects(relayRunReport({ dataDir: fixture.dataDir, body: report('run-1') }), (error: unknown) => error instanceof ReportRelayRefusal && /another user/.test(error.message));
  chmodSync(ticketPath, 0o600);
  // A ticket naming another service's socket is refused before a forward.
  writeTicket(fixture, 'run-2', { socketPath: '/tmp/another-service.sock' });
  await assert.rejects(relayRunReport({ dataDir: fixture.dataDir, body: report('run-2') }), (error: unknown) => error instanceof ReportRelayRefusal && /another callback socket/.test(error.message));
  assert.equal(fixture.received.length, 0);
  const ticket = await readRelayTicket(fixture.dataDir, 'run-1');
  assert.equal(ticket.token, 'run-secret');
  assert.equal(relayRequest(report('run-1'), ticket).route, '/complete');
});

test('a callback refusal keeps the service status and body, so the helper refuses exactly as it did', async (t: TestContext) => {
  const fixture = await callbackSocket(t);
  writeTicket(fixture, 'run-1');
  const refused: RelayTicket = await readRelayTicket(fixture.dataDir, 'run-1');
  const answer = await relayRunReport({ dataDir: fixture.dataDir, body: report('run-1'), deps: {
    readTicket: async () => refused,
    post: async () => ({ status: 409, body: '{"error":"Unauthorized callback"}' }),
  } });
  assert.equal(answer.status, 409);
  assert.deepEqual(JSON.parse(answer.body), { error: 'Unauthorized callback' });
  assert.equal(fixture.received.length, 0, 'the fixture post replaced the socket forward');
});

test('the socket forward is one bounded POST and reports an unreachable socket', async (t: TestContext) => {
  const fixture = await callbackSocket(t);
  const answer = await postToCallbackSocket(fixture.socketPath, 'run-secret', '/complete', { eventId: 'b'.repeat(64) });
  assert.equal(answer.status, 200);
  assert.equal(fixture.received[0]!.auth, 'Bearer run-secret');
  await assert.rejects(postToCallbackSocket(join(fixture.dataDir, 'absent.sock'), 'run-secret', '/complete', {}), /could not be reached/);
});
