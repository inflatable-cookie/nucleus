import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { T3RpcClient, T3RpcError } from '../hosts/t3code/rpc';

type Frame = Record<string, unknown>;
type Reply = (frame: unknown) => void;
const contract = JSON.parse(readFileSync(new URL('./fixtures/t3code-contract.json', import.meta.url), 'utf8'));

function wsFrame(text: string) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10);
  header[0] = 0x81;
  if (header.length === 2) header[1] = payload.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

/** Real HTTP ticket exchange and WebSocket framing; no mocked client methods. */
async function fakeServer(t: TestContext, handle: (frame: Frame, send: Reply, socket: Socket) => void, status = 200) {
  const frames: Frame[] = [];
  const sockets = new Set<Socket>();
  let upgrades = 0;
  let ticketRequest: IncomingMessage | undefined;
  const server = createServer((request, response) => {
    ticketRequest = request;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/auth/websocket-ticket/rpc');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ticket: 'synthetic-ticket', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  });
  server.on('upgrade', (request, rawSocket) => {
    const socket = rawSocket as Socket;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    upgrades++;
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(url.pathname, '/ws');
    assert.equal(url.searchParams.get('wsTicket'), 'synthetic-ticket');
    assert.equal(url.searchParams.get('orchestrationProtocol'), '2');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send: Reply = value => { socket.write(wsFrame(JSON.stringify(value))); };
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffer[1]! & 128);
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const frame = JSON.parse(payload.toString()) as Frame;
        frames.push(frame);
        handle(frame, send, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, frames, get upgrades() { return upgrades; }, get ticketRequest() { return ticketRequest; } };
}

const success = (request: Frame, value: unknown) => ({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value } });
const failure = (request: Frame, reason: unknown) => ({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Failure', cause: [reason] } });
async function clientFor(t: TestContext, server: { endpoint: string }, timeoutMs = 1_000) {
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer: 'synthetic-bearer', timeoutMs });
  t.after(() => client.close());
  await client.connect();
  return client;
}

test('ticket auth and unary requests use the nightly Effect RPC envelope without exposing credentials', async t => {
  const server = await fakeServer(t, (request, send) => { if (request._tag === 'Request') send(success(request, { environment: 'synthetic' })); });
  const client = await clientFor(t, server);
  assert.deepEqual(await client.call('server.getConfig', {}), { environment: 'synthetic' });
  assert.equal(server.ticketRequest?.headers.authorization, 'Bearer synthetic-bearer');
  assert.deepEqual(server.frames[0], { _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] });
  assert.doesNotMatch(JSON.stringify(client), /synthetic-bearer|synthetic-ticket|wsTicket/);
});

test('the pinned nightly contract examples retain direct command payloads and stable identities', async t => {
  const server = await fakeServer(t, (request, send) => { if (request._tag === 'Request') send(success(request, { sequence: 1 })); });
  const client = await clientFor(t, server);
  assert.equal(contract.sourceRevision, '97e35bcf23e4dcf34c2dcffadd37c08db0e01e52');
  for (const example of contract.examples) {
    await client.call(example.method, example.payload);
    const request = server.frames.at(-1)!;
    assert.equal(request.tag, example.method);
    assert.deepEqual(request.payload, example.payload);
    if (example.method === 'orchestration.dispatchCommand') {
      const definition = contract.commands[example.payload.type];
      for (const field of definition.required) assert.ok(Object.hasOwn(example.payload, field), field);
      if (example.payload.type === 'message.dispatch') {
        assert.ok(contract.creationFields.createdBy.includes(example.payload.createdBy));
        assert.ok(contract.creationFields.creationSource.includes(example.payload.creationSource));
      }
    }
  }
});

test('stream chunks are acknowledged and interrupted after the accepted coverage marker', async t => {
  const server = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send([
      { _tag: 'Chunk', requestId: request.id, values: [{ kind: 'snapshot', threads: [] }] },
      { _tag: 'Chunk', requestId: request.id, values: [{ kind: 'synchronized', sequence: 2 }] },
    ]);
  });
  const client = await clientFor(t, server);
  const seen: unknown[] = [];
  const marker = await client.readStream('orchestration.subscribeShell', { requestCompletionMarker: true }, value => {
    seen.push(value);
    return (value as { kind?: string }).kind === 'synchronized';
  });
  assert.deepEqual(marker, { kind: 'synchronized', sequence: 2 });
  assert.equal(seen.length, 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.frames.filter(frame => frame._tag === 'Ack').length, 2);
  assert.equal(server.frames.filter(frame => frame._tag === 'Interrupt').length, 1);
});

test('auth refusal never opens a socket and errors contain no credentials', async t => {
  const server = await fakeServer(t, () => assert.fail('no WebSocket request expected'), 401);
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer: 'synthetic-bearer' });
  t.after(() => client.close());
  await assert.rejects(client.connect(), error => error instanceof T3RpcError && error.code === 'auth' && !error.message.includes('synthetic-bearer'));
  assert.equal(server.upgrades, 0);
});

test('closing during the ticket exchange cannot open a late connection', async t => {
  const server = await fakeServer(t, () => assert.fail('closed client must send no requests'));
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer: 'synthetic-bearer' });
  const connecting = client.connect();
  client.close();
  await assert.rejects(connecting, error => error instanceof T3RpcError && error.delivery === 'not_sent');
  assert.equal(client.connected, false);
  assert.equal(server.upgrades, 0);
});

test('all remote Die failures stay unknown even when their text matches the RPC decoder', async t => {
  const appliedEffects: string[] = [];
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    // The handler performs an effect before emitting exactly the same Die that
    // the RPC boundary would emit. Its wire response has no phase evidence.
    appliedEffects.push(String(request.tag));
    const defect = request.tag === 'missing.method' ? 'Unknown request tag: missing.method' : contract.boundaryDecodeExample;
    send(failure(request, { _tag: 'Die', defect }));
  });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('missing.method', {}), error => error instanceof T3RpcError && error.code === 'unsupported_method' && error.delivery === 'unknown');
  await assert.rejects(client.call('orchestration.dispatchCommand', { type: 'thread.stop', commandId: 'synthetic-command', threadId: 'synthetic-thread' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.command, 'thread.stop');
    assert.equal('field' in error, false, 'no remote location is ever named');
    assert.match(error.message, /command thread\.stop(?!.*field)/);
    return true;
  });
  assert.deepEqual(appliedEffects, ['missing.method', 'orchestration.dispatchCommand']);
  assert.equal(server.frames.filter(frame => frame._tag === 'Request').length, 2);
});

test('schema diagnostics keep only the shape name: no location text is ever retained', async t => {
  let calls = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    const defect = ++calls === 1
      ? 'Expected string, got "synthetic-bearer prompt secret"\n  at ["modelSelection"]["options"][0]["value"]'
      : 'Missing key\n  at ["synthetic-bearer prompt secret"]';
    send(failure(request, { _tag: 'Die', defect }));
  });
  const client = await clientFor(t, server);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('orchestration.dispatchCommand', { type: i ? 'synthetic-bearer prompt secret' : 'message.dispatch' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    // Locations are remote text: nothing from them is named, not even our own
    // payload field names.
    assert.equal('field' in error, false);
    assert.equal(error.command, i ? undefined : 'message.dispatch');
    assert.equal(error.reason, i ? 'schema_missing_key' : 'schema_expected');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic-bearer|prompt secret|got "|options|value|modelSelection/);
    return true;
  });
  assert.equal(calls, 2);
});

test('a schema location retains nothing, whatever it names', async t => {
  let calls = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    // Call 2's location coincides with one of our own payload field names; it
    // is still remote-chosen text and retains nothing (brief v2).
    const defect = ++calls === 1
      ? 'Missing key\n  at ["synthetic_secret"]'
      : 'Missing key\n  at ["text"]';
    send(failure(request, { _tag: 'Die', defect }));
  });
  const client = await clientFor(t, server);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('orchestration.dispatchCommand', { type: 'thread.stop' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal('field' in error, false, 'no remote location is ever named');
    assert.equal(error.reason, 'schema_missing_key');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic_secret/);
    return true;
  });
});

test('the nightly dispatch union refuses project.create before any handler and the reason stays bounded', async t => {
  const server = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(failure(request, { _tag: 'Die',
      defect: 'Expected union member, got {"type":"project.create","commandId":"stable","projectId":"synthetic-project","title":"synthetic-repository","workspaceRoot":"/private/synthetic/repository"}' }));
  });
  const client = await clientFor(t, server);
  // Swallowtail #225's observed failure: the command never reached a handler, so
  // delivery stays unknown and the recorded names stay diagnostic text only.
  await assert.rejects(client.call('orchestration.dispatchCommand', { type: 'project.create', commandId: 'stable',
    projectId: 'synthetic-project', title: 'synthetic-repository', workspaceRoot: '/private/synthetic/repository' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.command, 'project.create');
    assert.equal('field' in error, false);
    assert.equal(error.reason, 'schema_expected');
    assert.doesNotMatch(String(error), /synthetic-project|synthetic-repository|private/);
    return true;
  });
  // A secret in the decoder's expected-shape position retains only the shape name.
  const secretServer = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(failure(request, { _tag: 'Die', defect: 'Expected synthetic-secret got value' }));
  });
  const secretClient = await clientFor(t, secretServer);
  await assert.rejects(secretClient.call('projects.mutate', { type: 'project.create', commandId: 'stable' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.reason, 'schema_expected');
    assert.doesNotMatch(String(error), /synthetic-secret/);
    return true;
  });
  // The method-name position of the unknown-tag text retains only the shape name.
  const methodServer = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(failure(request, { _tag: 'Die', defect: 'Unknown request tag: synthetic-secret' }));
  });
  const methodClient = await clientFor(t, methodServer);
  await assert.rejects(methodClient.call('projects.mutate', { type: 'project.create', commandId: 'stable' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.reason, 'unknown_request_tag');
    assert.doesNotMatch(String(error), /synthetic-secret/);
    return true;
  });
});

test('unquoted Die secrets retain no reason text at all', async t => {
  const server = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(failure(request, { _tag: 'Die', defect: 'Authentication failed: synthetic-secret' }));
  });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('projects.mutate', { type: 'project.create', commandId: 'stable' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.reason, 'remote_failure', 'an unrecognized remote failure keeps only its shape name');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic-secret|Authentication failed/);
    return true;
  });
});

test('typed project mutation failures retain the fixed wire message and drop arbitrary text to the tag', async t => {
  let calls = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(failure(request, { _tag: 'Fail', error: {
      _tag: 'ProjectMutationError', commandId: 'stable',
      // Call 1 is the handler's own fixed wire message; call 2 carries an
      // unquoted secret that no template names, so only the tag may survive.
      message: ++calls === 1 ? 'Failed to mutate project.' : 'Failed for api_key=synthetic-secret' } }));
  });
  const client = await clientFor(t, server);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('projects.mutate', { type: 'project.create', commandId: 'stable',
    projectId: 'synthetic-project', title: 'synthetic-repository', workspaceRoot: '/private/synthetic/repository' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.command, 'project.create');
    assert.equal(error.reason, i === 0 ? 'ProjectMutationError:project_mutation_failed' : 'ProjectMutationError');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /api_key|synthetic-secret/);
    return true;
  });
  assert.equal(calls, 2);
});

test('typed variable positions retain the known tag and the fixed shape name only', async t => {
  let calls = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    const tag = ++calls === 1 ? 'ProjectMutationError' : 'EnvironmentAuthorizationError';
    const message = calls === 1 ? 'Project synthetic-secret is not empty.' : 'The authenticated token is missing required scope: synthetic-secret.';
    send(failure(request, { _tag: 'Fail', error: { _tag: tag, commandId: 'stable', message } }));
  });
  const client = await clientFor(t, server);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('projects.mutate', { type: 'project.create', commandId: 'stable' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.reason, i === 0
      ? 'ProjectMutationError:project_not_empty'
      : 'EnvironmentAuthorizationError:scope_missing');
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic-secret/);
    return true;
  });
});

test('reasons stay bounded and nameless for unknown tags, giant defects and value dumps', async t => {
  let calls = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    send(failure(request, ++calls === 1
      ? { _tag: 'Fail', error: { _tag: 'SomethingUnrecognized', detail: 'synthetic-bearer prompt secret' } }
      : { _tag: 'Die', defect: `Expected ${'{"a":1}, '.repeat(300)}got "${'x'.repeat(500)}"` }));
  });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('projects.mutate', { type: 'project.create', commandId: 'stable' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.reason, undefined, 'an unrecognized tag contributes no reason text');
    assert.doesNotMatch(String(error), /prompt secret/);
    return true;
  });
  await assert.rejects(client.call('projects.mutate', { type: 'project.create', commandId: 'stable-2' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.reason, 'schema_expected', 'the giant defect retains only its shape name');
    assert.doesNotMatch(String(error), /xxxxx/);
    return true;
  });
});

async function failingTicketServer(t: TestContext, status: number) {
  return fakeServer(t, () => assert.fail('no WebSocket request expected'), status);
}

test('the ticket exchange names its HTTP status in the refusal', async t => {
  const server = await failingTicketServer(t, 403);
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer: 'synthetic-bearer' });
  t.after(() => client.close());
  await assert.rejects(client.connect(), error => error instanceof T3RpcError && error.code === 'auth' && error.reason === 'HTTP 403'
    && String(error).includes('reason HTTP 403') && !String(error).includes('synthetic-bearer'));
  assert.equal(server.upgrades, 0);
});

test('a schema location containing the configured bearer is discarded even when it is a valid identifier', async t => {
  const bearer = 'synthetic_secret';
  const server = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(failure(request, { _tag: 'Die', defect: `Missing key\n  at ["${bearer}"]` }));
  });
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.call('orchestration.dispatchCommand', { type: 'thread.stop' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.command, 'thread.stop');
    assert.equal('field' in error, false);
    assert.ok(!String(error).includes(bearer));
    assert.ok(!JSON.stringify(error).includes(bearer));
    return true;
  });
});

test('typed remote command diagnostics accept known commands and reject arbitrary text', async t => {
  let calls = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    send(failure(request, { _tag: 'Fail', error: {
      _tag: 'OrchestrationV2DispatchCommandError',
      commandType: ++calls === 1 ? 'thread.archive' : 'synthetic-bearer prompt secret',
      detail: 'synthetic-bearer prompt secret',
    } }));
  });
  const client = await clientFor(t, server);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('orchestration.dispatchCommand', { type: 'thread.stop' }), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.equal(error.command, i ? 'thread.stop' : 'thread.archive');
    assert.equal('field' in error, false);
    assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /synthetic-bearer|prompt secret/);
    return true;
  });
  assert.equal(calls, 2);
});

test('only local pre-write failures prove that no request was sent', async t => {
  const server = await fakeServer(t, () => assert.fail('a disconnected client cannot send'));
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer: 'synthetic-bearer' });
  await assert.rejects(client.call('orchestration.dispatchCommand', {}), error => error instanceof T3RpcError && error.delivery === 'not_sent');
  assert.equal(server.frames.length, 0);
});

test('handler errors and encoding defects remain unknown and redact remote payloads', async t => {
  let n = 0;
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    send(failure(request, ++n === 1
      ? { _tag: 'Fail', error: { _tag: 'OrchestratorDispatchError', detail: 'synthetic-bearer prompt secret' } }
      : { _tag: 'Die', defect: `Failed to encode response for RPC "orchestration.dispatchCommand": ${contract.boundaryDecodeExample}` }));
  });
  const client = await clientFor(t, server);
  for (let i = 0; i < 2; i++) await assert.rejects(client.call('orchestration.dispatchCommand', {}), error => {
    assert.ok(error instanceof T3RpcError);
    assert.equal(error.delivery, 'unknown');
    assert.doesNotMatch(String(error), /synthetic-bearer|prompt secret/);
    return true;
  });
  assert.equal(server.frames.length, 2);
});

test('incomplete stream termination is unknown rather than an empty snapshot', async t => {
  const server = await fakeServer(t, (request, send) => { if (request._tag === 'Request') send(success(request, undefined)); });
  const client = await clientFor(t, server);
  await assert.rejects(client.readStream('orchestration.subscribeThread', { threadId: 'synthetic' }, () => false), error => error instanceof T3RpcError && error.code === 'protocol');
});

test('disconnect after a mutation is unknown and never replays the request', async t => {
  const server = await fakeServer(t, (request, _send, socket) => { if (request._tag === 'Request') socket.destroy(); });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('orchestration.dispatchCommand', { type: 'thread.stop', commandId: 'stable', threadId: 'synthetic' }), error => error instanceof T3RpcError && error.delivery === 'unknown');
  assert.ok(['socket_close', 'socket_error'].includes(client.lastDisconnectReason!), 'abrupt loss retains the socket event that arrived first');
  assert.equal(server.frames.filter(frame => frame._tag === 'Request').length, 1);
  assert.equal(server.upgrades, 1);
});

test('a stalled snapshot times out, releases only its subscription and does not retry', async t => {
  const server = await fakeServer(t, () => {});
  const client = await clientFor(t, server, 100);
  await assert.rejects(client.readStream('orchestration.subscribeShell', {}, () => false), error => error instanceof T3RpcError && error.code === 'timeout');
  assert.equal(client.connected, true);
  assert.equal(server.frames.filter(frame => frame._tag === 'Request').length, 1);
});

test('malformed server frames invalidate pending reads without leaking raw contents', async t => {
  const server = await fakeServer(t, (request, send) => { if (request._tag === 'Request') send({ _tag: 'synthetic-bearer' }); });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('server.getConfig', {}), error => error instanceof T3RpcError && error.code === 'protocol' && !error.message.includes('synthetic-bearer'));
  assert.equal(client.connected, false);
  assert.equal(client.lastDisconnectReason, 'protocol_error');
  assert.deepEqual(client.lastProtocolError, { branch: 'unknown_control', tag: null });
  assert.doesNotMatch(JSON.stringify(client.lastProtocolError), /synthetic-bearer/);
});

test('one timed-out mutation leaves other in-flight and later requests on the shared connection', async t => {
  const replies = new Map<string, () => void>();
  const received = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  for (const method of ['orchestration.dispatchCommand', 'server.getConfig'])
    received.set(method, new Promise(resolve => releases.set(method, resolve)));
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    const method = String(request.tag);
    replies.set(method, () => send(success(request, method)));
    releases.get(method)?.();
    if (method === 'later.read') send(success(request, 'later'));
  });
  const client = await clientFor(t, server);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = assert.rejects(client.call('orchestration.dispatchCommand', {
    type: 'thread.stop', commandId: 'synthetic-command', threadId: 'synthetic-thread',
  }), error => error instanceof T3RpcError && error.code === 'timeout' && error.delivery === 'unknown');
  await received.get('orchestration.dispatchCommand');
  t.mock.timers.tick(500);
  const other = client.call('server.getConfig', {});
  await received.get('server.getConfig');
  t.mock.timers.tick(500);
  await timeout;
  assert.equal(client.connected, true);
  assert.equal(client.lastDisconnectReason, null);
  replies.get('server.getConfig')!();
  assert.equal(await other, 'server.getConfig');
  assert.equal(await client.call('later.read', {}), 'later');
  assert.equal(server.upgrades, 1);
  assert.equal(server.frames.filter(frame => frame.tag === 'orchestration.dispatchCommand').length, 1, 'unknown mutation is never resent');
});

test('a late reply to an expired request cannot settle a different request', async t => {
  let late!: () => void;
  let firstReceived!: () => void;
  const first = new Promise<void>(resolve => { firstReceived = resolve; });
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    if (request.tag === 'expired.read') {
      late = () => send(success(request, 'expired-value'));
      firstReceived();
    } else {
      late();
      send(success(request, 'current-value'));
    }
  });
  const client = await clientFor(t, server);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const expired = assert.rejects(client.call('expired.read', {}), error => error instanceof T3RpcError && error.code === 'timeout');
  await first;
  t.mock.timers.tick(1_000);
  await expired;
  assert.equal(await client.call('current.read', {}), 'current-value');
  assert.equal(client.connected, true);
  assert.equal(server.upgrades, 1);
});

test('thread snapshots have a method-specific minute while small commands keep ten seconds', async t => {
  let snapshot!: () => void;
  let received!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    if (request.tag === 'orchestration.subscribeThread') {
      snapshot = () => send({ _tag: 'Chunk', requestId: request.id, values: [{ kind: 'synchronized', sequence: 1 }] });
      received();
    }
  });
  const client = new T3RpcClient({ endpoint: server.endpoint, bearer: 'synthetic-bearer' });
  t.after(() => client.close());
  await client.connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const thread = client.readStream('orchestration.subscribeThread', { threadId: 'synthetic-thread', requestCompletionMarker: true }, () => true)
    .finally(() => { settled = true; });
  const command = assert.rejects(client.call('server.getConfig', {}), error => error instanceof T3RpcError && error.code === 'timeout');
  await ready;
  t.mock.timers.tick(10_000);
  await command;
  t.mock.timers.tick(49_999);
  await Promise.resolve();
  assert.equal(settled, false);
  snapshot();
  assert.deepEqual(await thread, { kind: 'synchronized', sequence: 1 });
  assert.equal(client.connected, true);
});

const protocolFrames = contract.protocolFrames as {
  attributable: { defect: Frame; chunk: Frame; exit: Frame };
  unattributable: { connectionDefect: Frame };
};

function wsSend(socket: Socket, text: string) { socket.write(wsFrame(text)); }

/** Two in-flight calls: the faulting one is named, the other succeeds, the socket stays up. */
async function attributableFault(
  t: TestContext,
  options: {
    fault: (request: Frame, send: Reply) => void;
    branch: string;
    tag: string;
    stream?: boolean;
  },
) {
  const replies = new Map<string, () => void>();
  const received = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  for (const method of ['faulty.read', 'server.getConfig'])
    received.set(method, new Promise(resolve => releases.set(method, resolve)));
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    const method = String(request.tag);
    if (method === 'faulty.read') replies.set(method, () => options.fault(request, send));
    else if (method === 'later.read') send(success(request, 'later'));
    else replies.set(method, () => send(success(request, method)));
    releases.get(method)?.();
  });
  const client = await clientFor(t, server);
  const failed = options.stream
    ? client.readStream('faulty.read', {}, () => false)
    : client.call('faulty.read', {});
  await received.get('faulty.read');
  const other = client.call('server.getConfig', {});
  await received.get('server.getConfig');
  replies.get('faulty.read')!();
  await assert.rejects(failed, error => error instanceof T3RpcError && error.code === 'protocol' && error.delivery === 'unknown');
  replies.get('server.getConfig')!();
  assert.equal(await other, 'server.getConfig');
  assert.equal(client.connected, true);
  assert.equal(client.lastDisconnectReason, null);
  assert.deepEqual(client.lastProtocolError, { branch: options.branch, tag: options.tag });
  assert.equal(await client.call('later.read', {}), 'later');
  assert.equal(server.upgrades, 1);
  if (options.stream) {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.frames.filter(frame => frame._tag === 'Interrupt' && String(frame.requestId) === '1').length, 1);
  }
  return { client, server };
}

test('a Defect with a request ID settles that request only', async t => {
  await attributableFault(t, {
    branch: 'defect',
    tag: 'Defect',
    fault: (request, send) => send({ ...protocolFrames.attributable.defect, requestId: request.id }),
  });
});

test('a Chunk for a unary request settles that request only', async t => {
  await attributableFault(t, {
    branch: 'chunk_without_acceptor',
    tag: 'Chunk',
    fault: (request, send) => send({ ...protocolFrames.attributable.chunk, requestId: request.id, values: [{ kind: 'snapshot' }] }),
  });
});

test('a Chunk with non-array values settles that stream only', async t => {
  await attributableFault(t, {
    branch: 'chunk_values',
    tag: 'Chunk',
    stream: true,
    fault: (request, send) => send({ _tag: 'Chunk', requestId: request.id, values: { not: 'array' } }),
  });
});

test('an overlong stream settles that request only', async t => {
  await attributableFault(t, {
    branch: 'stream_overlong',
    tag: 'Chunk',
    stream: true,
    fault: (request, send) => {
      send({ _tag: 'Chunk', requestId: request.id, values: Array.from({ length: 10_000 }, () => 0) });
      send({ _tag: 'Chunk', requestId: request.id, values: [0] });
    },
  });
});

test('an unexpected Exit shape settles that request only', async t => {
  await attributableFault(t, {
    branch: 'unexpected_exit',
    tag: 'Exit',
    fault: (request, send) => send({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Neither' } }),
  });
});

test('an unknown tag with a known request ID settles that request only', async t => {
  await attributableFault(t, {
    branch: 'unknown_tag',
    tag: 'ClientEnd',
    fault: (request, send) => send({ _tag: 'ClientEnd', requestId: request.id }),
  });
});

test('subscribeThread accepts more than the default stream cap once the reader has the marker', async t => {
  const server = await fakeServer(t, (request, send) => {
    if (request._tag !== 'Request') return;
    if (request.tag === 'orchestration.subscribeThread') {
      const values: unknown[] = Array.from({ length: 10_000 }, () => ({ kind: 'snapshot', threads: [] }));
      values.push({ kind: 'synchronized', sequence: 1 });
      send({ _tag: 'Chunk', requestId: request.id, values });
    }
  });
  const client = await clientFor(t, server);
  const marker = await client.readStream('orchestration.subscribeThread', { threadId: 'synthetic', requestCompletionMarker: true }, value =>
    (value as { kind?: string }).kind === 'synchronized');
  assert.deepEqual(marker, { kind: 'synchronized', sequence: 1 });
  assert.equal(client.connected, true);
  assert.equal(client.lastDisconnectReason, null);
});

test('an unparseable frame still closes the shared connection', async t => {
  const server = await fakeServer(t, (request, _send, socket) => {
    if (request._tag === 'Request') wsSend(socket, '{');
  });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('server.getConfig', {}), error => error instanceof T3RpcError && error.code === 'protocol');
  assert.equal(client.connected, false);
  assert.equal(client.lastDisconnectReason, 'protocol_error');
  assert.deepEqual(client.lastProtocolError, { branch: 'unparseable_frame', tag: null });
});

test('a connection-level Defect without a request ID closes the shared connection', async t => {
  const server = await fakeServer(t, (request, send) => {
    if (request._tag === 'Request') send(protocolFrames.unattributable.connectionDefect);
  });
  const client = await clientFor(t, server);
  await assert.rejects(client.call('server.getConfig', {}), error => error instanceof T3RpcError && error.code === 'protocol');
  assert.equal(client.connected, false);
  assert.equal(client.lastDisconnectReason, 'protocol_error');
  assert.deepEqual(client.lastProtocolError, { branch: 'connection_defect', tag: 'Defect' });
});
