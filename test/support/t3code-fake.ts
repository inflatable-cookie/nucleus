import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { readFileSync } from 'node:fs';

type Value = Record<string, any>;
const contract = JSON.parse(readFileSync(new URL('../fixtures/t3code-contract.json', import.meta.url), 'utf8')) as Value;
export const STAMP = '2026-01-01T00:00:00.000Z';

export function threadProjection(id: string, directory: string): Value {
  return { thread: { id, projectId: 'synthetic-project', title: 'Synthetic thread', providerInstanceId: 'synthetic-provider',
    modelSelection: { instanceId: 'synthetic-provider', model: 'synthetic-model' }, worktreePath: directory, branch: 'synthetic',
    archivedAt: null, deletedAt: null, updatedAt: STAMP },
    runs: [], runtimeRequests: [], turnItems: [], messages: [], updatedAt: STAMP };
}

/** Exercises the real HTTP ticket exchange and WebSocket RPC client. */
export async function t3Fake(t: TestContext, directory: string) {
  const requests: Value[] = [];
  const commands: Value[] = [];
  const threads = new Map<string, Value>([['synthetic-probe', threadProjection('synthetic-probe', directory)]]);
  const controls = { environmentId: 'synthetic-environment', version: 'nightly-synthetic-unseen', protocol: 2,
    synchronized: true, incompleteThread: false, enrichment: false, shellMissingField: '',
    disconnectMutation: false, refuseMutation: false, mutationObserver: (() => {}) as () => void };
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/auth/websocket-ticket/rpc');
    assert.equal(request.headers.authorization, 'Bearer synthetic-bearer');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ticket: 'synthetic-ticket', expiresAt: '2099-01-01T00:00:00.000Z' }));
  });
  const shell = (p: Value) => {
    const active = p.runs.find((run: Value) => ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(run.status));
    const pending = p.runtimeRequests.find((request: Value) => request.status === 'pending');
    const value: Value = { ...p.thread, activeRunId: active?.id ?? null, status: active?.status ?? 'idle',
      pendingRuntimeRequest: pending ? { id: pending.id, kind: pending.kind, createdAt: STAMP, blocking: true } : null,
      latestUserMessageAt: p.messages.length ? STAMP : null, lastError: null };
    if (controls.shellMissingField) delete value[controls.shellMissingField];
    return value;
  };
  const projects = () => [{ id: 'synthetic-project', title: 'Synthetic project', workspaceRoot: directory }];
  server.on('upgrade', (request, rawSocket) => {
    const socket = rawSocket as Socket;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const url = new URL(request.url!, 'http://localhost');
    assert.equal(url.pathname, '/ws'); assert.equal(url.searchParams.get('wsTicket'), 'synthetic-ticket');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
      header[0] = 0x81;
      if (header.length === 2) header[1] = bytes.length;
      else { header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
      socket.write(Buffer.concat([header, bytes]));
    };
    const handle = (request: Value) => {
      if (request._tag !== 'Request') return;
      requests.push(request);
      const payload = request.payload as Value;
      const success = (value: unknown) => send({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value } });
      const failure = (reason: unknown) => send({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Failure', cause: [reason] } });
      const stream = (values: unknown[]) => send({ _tag: 'Chunk', requestId: request.id, values });
      const marker = () => controls.synchronized ? [{ kind: 'synchronized', sequence: 1 }] : [];
      switch (request.tag) {
        case 'server.getConfig':
          return success({ environment: { environmentId: controls.environmentId, serverVersion: controls.version, orchestrationProtocolVersion: controls.protocol },
            providers: [{ instanceId: 'synthetic-provider', displayName: 'Synthetic provider', enabled: true, status: 'ready', models: [{ slug: 'synthetic-model', name: 'Synthetic model' }] }], unrelatedAdditiveField: true });
        case 'orchestration.subscribeShell': {
          const active = [...threads.values()].filter(p => !p.thread.archivedAt && !p.thread.deletedAt).map(shell);
          return stream([{ kind: 'snapshot', snapshot: { schemaVersion: 1, snapshotSequence: 1, projects: projects(), threads: active, archivedThreads: [] } },
            ...(controls.enrichment ? [{ kind: 'snapshot', resolvedRepositoryIdentityRoots: [directory], snapshot: { threads: [], archivedThreads: [] } }] : []), ...marker()]);
        }
        case 'orchestration.getArchivedShellSnapshot':
          return success({ schemaVersion: 1, snapshotSequence: 1, projects: projects(), threads: [...threads.values()].filter(p => p.thread.archivedAt).map(shell) });
        case 'orchestration.subscribeThread': {
          const p = threads.get(payload.threadId);
          if (!p) return failure({ _tag: 'Fail', error: { _tag: 'ThreadNotFoundError' } });
          return stream([{ kind: 'snapshot', snapshotSequence: 1, projection: p, ...(controls.incompleteThread ? { hasMoreHistory: true } : {}) }, ...marker()]);
        }
        case 'orchestration.launchThread': {
          for (const field of contract.launchThread.required) assert.ok(Object.hasOwn(payload, field), `launchThread.${field}`);
          assert.equal(payload.workspaceStrategy.type, 'existing_worktree');
          assert.ok(contract.launchThread.runtimeModes.includes(payload.runtimeMode));
          assert.ok(contract.launchThread.interactionModes.includes(payload.interactionMode));
          for (const field of contract.launchThread.modelSelectionRequired) assert.ok(Object.hasOwn(payload.modelSelection, field), `modelSelection.${field}`);
          commands.push({ method: request.tag, ...payload }); controls.mutationObserver();
          if (controls.disconnectMutation) return socket.destroy();
          const p = threadProjection(payload.threadId, payload.workspaceStrategy.worktreePath);
          p.thread.title = payload.title; p.thread.modelSelection = payload.modelSelection; p.thread.providerInstanceId = payload.modelSelection.instanceId;
          p.messages.push({ id: payload.initialMessage.messageId, role: 'user', text: payload.initialMessage.text });
          threads.set(payload.threadId, p);
          return success({ threadId: payload.threadId, projection: p, resumed: false, sequence: 1 });
        }
        case 'orchestration.dispatchCommand': {
          const definition = contract.commands[payload.type];
          if (definition) for (const field of definition.required) assert.ok(Object.hasOwn(payload, field), `${payload.type}.${field}`);
          if (payload.type === 'message.dispatch') assert.ok(definition.dispatchModes.includes(payload.dispatchMode.type));
          if (payload.type === 'runtime-request.respond') {
            if (payload.decision) assert.ok(definition.decisions.includes(payload.decision));
            if (payload.answers) for (const answer of Object.values(payload.answers)) assert.ok(Array.isArray(answer), 'question answer uses provider answer array');
          }
          commands.push({ method: request.tag, ...payload }); controls.mutationObserver();
          if (controls.refuseMutation) return failure({ _tag: 'Die', defect: contract.boundaryDecodeExample });
          if (controls.disconnectMutation) return socket.destroy();
          const p = threads.get(payload.threadId)!;
          switch (payload.type) {
            case 'message.dispatch': p.messages.push({ id: payload.messageId, role: 'user', text: payload.text }); break;
            case 'thread.stop': for (const run of p.runs) run.status = 'cancelled'; break;
            case 'thread.archive': p.thread.archivedAt = STAMP; break;
            case 'runtime-request.respond': {
              const item = p.runtimeRequests.find((r: Value) => r.id === payload.requestId)!;
              item.status = 'resolved'; if (payload.answers) item.answers = payload.answers;
              break;
            }
            case 'thread.user-input.dismiss': p.runtimeRequests.find((r: Value) => r.id === payload.requestId)!.status = 'cancelled'; break;
          }
          return success({ sequence: 1 });
        }
        default: return failure({ _tag: 'Die', defect: `Unknown request tag: ${request.tag}` });
      }
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127, offset = 2;
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
        if (opcode === 1) handle(JSON.parse(payload.toString()));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, controls, threads, commands, requests };
}
