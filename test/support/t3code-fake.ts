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
    archivedAt: null, deletedAt: null, settledOverride: null, settledAt: null, updatedAt: STAMP },
    runs: [], runtimeRequests: [], turnItems: [], messages: [], updatedAt: STAMP };
}

/** Exercises the real HTTP ticket exchange and WebSocket RPC client. */
export async function t3Fake(t: TestContext, directory: string) {
  const requests: Value[] = [];
  const commands: Value[] = [];
  const projectRows: Value[] = [{ id: 'synthetic-project', title: 'Synthetic project', workspaceRoot: directory }];
  const archivedProjects = new Set<string>();
  const threads = new Map<string, Value>([['synthetic-probe', threadProjection('synthetic-probe', directory)]]);
  const controls = { environmentId: 'synthetic-environment', version: 'nightly-synthetic-unseen', protocol: 2,
    synchronized: true, incompleteThread: false, enrichment: false, shellMissingField: '',
    snapshotSequence: 1, threadCoverage: {} as Record<string, unknown>, beforeArchiveRead: (() => {}) as () => void,
    /** The next N thread reads end with an Interrupt frame instead of a snapshot (a stream cut mid-turn). */
    interruptThreadReads: 0,
    disconnectMutation: false, disconnectAfterEffect: false, refuseMutation: false, postEffectDefect: false,
    unsupportedProjectCreate: false, projectMutationFailure: false, projectMutationSecretFailure: false, projectMutationIdSecretFailure: false, secretDefect: false, secretLocationDefect: false, mutationObserver: (() => {}) as () => void,
    /** Replaces the single synthetic provider in `server.getConfig` when set (nightly provider shapes). */
    providers: undefined as Value[] | undefined };
  /** Command receipts make a replayed project mutation answer with its recorded outcome. */
  const projectReceipts = new Map<string, { type: string; projectId: string }>();
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
  const projects = () => projectRows.map(row => ({ ...row, archivedAt: archivedProjects.has(row.id) ? STAMP : null }));
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
        case 'server.getConfig': {
          const reasoning: Value = { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'medium',
            options: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High', isDefault: true }] };
          const serviceTier: Value = { id: 'serviceTier', label: 'Service Tier', type: 'select', currentValue: 'standard',
            options: [{ id: 'standard', label: 'Standard', isDefault: true }, { id: 'priority', label: 'Priority' }] };
          const verbose: Value = { id: 'verbose', label: 'Verbose', type: 'boolean', currentValue: true };
          if (controls.providers) return success({
            environment: { environmentId: controls.environmentId, serverVersion: controls.version, orchestrationProtocolVersion: controls.protocol },
            providers: controls.providers,
          });
          return success({
            environment: { environmentId: controls.environmentId, serverVersion: controls.version, orchestrationProtocolVersion: controls.protocol },
            providers: [
              {
                instanceId: 'synthetic-provider', displayName: 'Synthetic provider', enabled: true, status: 'ready',
                models: [
                  {
                    slug: 'synthetic-model', name: 'Synthetic model', aliases: ['synthetic-alias'],
                    // Nightly 0.1.10 shape: each model lists its configurable options.
                    capabilities: { optionDescriptors: [reasoning, serviceTier, verbose] },
                  },
                  { slug: 'synthetic-model-2', name: 'Synthetic model two' },
                ],
              },
            ],
            unrelatedAdditiveField: true,
          });
        }
        case 'orchestration.subscribeShell': {
          const active = [...threads.values()].filter(p => !p.thread.archivedAt && !p.thread.deletedAt).map(shell);
          return stream([{ kind: 'snapshot', snapshot: { schemaVersion: 1, snapshotSequence: controls.snapshotSequence, projects: projects(), threads: active, archivedThreads: [] } },
            ...(controls.enrichment ? [{ kind: 'snapshot', resolvedRepositoryIdentityRoots: [directory], snapshot: { threads: [], archivedThreads: [] } }] : []), ...marker()]);
        }
        case 'orchestration.getArchivedShellSnapshot':
          controls.beforeArchiveRead();
          return success({ schemaVersion: 1, snapshotSequence: controls.snapshotSequence, projects: projects(), threads: [...threads.values()].filter(p => p.thread.archivedAt).map(shell) });
        case 'orchestration.subscribeThread': {
          const p = threads.get(payload.threadId);
          if (!p) return failure({ _tag: 'Fail', error: { _tag: 'ThreadNotFoundError' } });
          if (controls.interruptThreadReads > 0) { controls.interruptThreadReads--; return send({ _tag: 'Interrupt', requestId: request.id }); }
          return stream([{ kind: 'snapshot', snapshotSequence: controls.snapshotSequence, projection: p, ...(controls.incompleteThread ? { hasMoreHistory: true } : {}), ...controls.threadCoverage }, ...marker()]);
        }
        case 'orchestration.launchThread': {
          for (const field of contract.launchThread.required) assert.ok(Object.hasOwn(payload, field), `launchThread.${field}`);
          assert.equal(payload.workspaceStrategy.type, 'existing_worktree');
          assert.ok(contract.launchThread.runtimeModes.includes(payload.runtimeMode));
          assert.ok(contract.launchThread.interactionModes.includes(payload.interactionMode));
          const launched = (controls.providers ?? []).find(provider => provider.instanceId === payload.modelSelection.instanceId);
          if (launched?.supportedRuntimeModes?.length)
            assert.ok(launched.supportedRuntimeModes.includes(payload.runtimeMode), 'a provider only runs a runtime mode it reports');
          for (const field of contract.launchThread.modelSelectionRequired) assert.ok(Object.hasOwn(payload.modelSelection, field), `modelSelection.${field}`);
          if (payload.modelSelection.options !== undefined) {
            assert.ok(Array.isArray(payload.modelSelection.options), 'modelSelection.options is the nightly selection array');
            for (const selection of payload.modelSelection.options) {
              for (const field of contract.modelOptions.optionSelectionRequired) assert.ok(Object.hasOwn(selection, field), `modelSelection.options.${field}`);
              assert.ok(contract.modelOptions.optionSelectionValueTypes.includes(typeof selection.value), `modelSelection.options value type ${typeof selection.value}`);
            }
          }
          commands.push({ method: request.tag, ...payload }); controls.mutationObserver();
          if (controls.disconnectMutation) return socket.destroy();
          const p = threadProjection(payload.threadId, payload.workspaceStrategy.worktreePath);
          p.thread.title = payload.title; p.thread.modelSelection = payload.modelSelection; p.thread.providerInstanceId = payload.modelSelection.instanceId;
          p.thread.runtimeMode = payload.runtimeMode;
          p.messages.push({ id: payload.initialMessage.messageId, role: 'user', text: payload.initialMessage.text });
          threads.set(payload.threadId, p);
          return success({ threadId: payload.threadId, projection: p, resumed: false, sequence: 1 });
        }
        case 'orchestration.dispatchCommand': {
          const definition = contract.commands[payload.type];
          // The nightly decodes the command union before any handler runs, so an
          // unknown command type is a decoder defect with no effect and no span.
          if (!definition) return failure({ _tag: 'Die', defect: contract.dispatchUnknownCommandExample });
          for (const field of definition.required) assert.ok(Object.hasOwn(payload, field), `${payload.type}.${field}`);
          if (payload.type === 'message.dispatch') {
            assert.ok(definition.dispatchModes.includes(payload.dispatchMode.type));
            if (definition.steerModes.includes(payload.dispatchMode.type) && definition.steerRequiresTargetRunId)
              assert.equal(typeof payload.dispatchMode.targetRunId, 'string', `${payload.dispatchMode.type}.targetRunId`);
          }
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
            case 'thread.settle':
              if (payload.expectedLatestRunId && p.runs.at(-1)?.id !== payload.expectedLatestRunId)
                return failure({ _tag: 'Die', defect: 'Latest run changed before thread settlement.' });
              p.thread.settledOverride = 'settled'; p.thread.settledAt = payload.settledAt ?? STAMP; break;
            case 'thread.unsettle': p.thread.settledOverride = 'active'; p.thread.settledAt = null; break;
            case 'thread.metadata.update': if (payload.title !== undefined) p.thread.title = payload.title; break;
            case 'runtime-request.respond': {
              const item = p.runtimeRequests.find((r: Value) => r.id === payload.requestId)!;
              item.status = 'resolved'; if (payload.answers) item.answers = payload.answers;
              break;
            }
            case 'thread.user-input.dismiss': p.runtimeRequests.find((r: Value) => r.id === payload.requestId)!.status = 'cancelled'; break;
          }
          if (controls.disconnectAfterEffect) return socket.destroy();
          if (controls.postEffectDefect) return failure({ _tag: 'Die', defect: contract.boundaryDecodeExample });
          if (controls.secretDefect) return failure({ _tag: 'Die', defect: 'Expected synthetic-secret got value\n  at ["text"]' });
          if (controls.secretLocationDefect) return failure({ _tag: 'Die', defect: 'Missing key\n  at ["synthetic_secret"]' });
          return success({ sequence: 1 });
        }
        case 'projects.mutate': {
          const mutation = contract.projectMutation;
          if (payload.type === 'project.update') {
            for (const field of mutation.updateRequired) assert.ok(Object.hasOwn(payload, field), `projects.mutate.${field}`);
            commands.push({ method: request.tag, ...payload }); controls.mutationObserver();
            if (controls.refuseMutation) return failure({ _tag: 'Die', defect: contract.boundaryDecodeExample });
            if (controls.disconnectMutation) return socket.destroy();
            const project = projectRows.find((row: Value) => row.id === payload.projectId);
            if (!project) return failure({ _tag: 'Fail', error: { _tag: 'ProjectMutationError', commandId: payload.commandId, message: 'Failed to mutate project.' } });
            if (payload.archived === true) archivedProjects.add(payload.projectId);
            else if (payload.archived === false) archivedProjects.delete(payload.projectId);
            if (controls.disconnectAfterEffect) return socket.destroy();
            return success({ ...project, archivedAt: payload.archived ? STAMP : null });
          }
          assert.equal(payload.type, 'project.create', 'only project.create and project.update mutations are exercised');
          for (const field of mutation.createRequired) assert.ok(Object.hasOwn(payload, field), `projects.mutate.${field}`);
          commands.push({ method: request.tag, ...payload }); controls.mutationObserver();
          if (controls.refuseMutation) return failure({ _tag: 'Die', defect: contract.boundaryDecodeExample });
          if (controls.disconnectMutation) return socket.destroy();
          if (controls.unsupportedProjectCreate) return failure({ _tag: 'Die', defect: `Unknown request tag: ${mutation.method}` });
          if (controls.projectMutationFailure) return failure({ _tag: 'Fail', error: { _tag: 'ProjectMutationError', commandId: payload.commandId, message: 'Failed to mutate project.' } });
          if (controls.projectMutationSecretFailure) return failure({ _tag: 'Fail', error: { _tag: 'ProjectMutationError', commandId: payload.commandId, message: 'Failed for api_key=synthetic-secret' } });
          if (controls.projectMutationIdSecretFailure) return failure({ _tag: 'Fail', error: { _tag: 'ProjectMutationError', commandId: payload.commandId, message: 'Project synthetic-secret is not empty.' } });
          const project = (id: string, title: string, workspaceRoot: string) => ({ id, title, workspaceRoot,
            repositoryIdentity: null, defaultModelSelection: null, scripts: [], createdAt: STAMP, updatedAt: STAMP, deletedAt: null });
          const receipt = projectReceipts.get(payload.commandId);
          if (receipt) {
            assert.equal(receipt.type, payload.type, 'a command id is never reused for another mutation');
            const settled = projectRows.find((row: Value) => row.id === receipt.projectId)!;
            return success(project(settled.id, settled.title, settled.workspaceRoot));
          }
          const owner = projectRows.find((row: Value) => row.workspaceRoot === payload.workspaceRoot);
          if (owner) return failure({ _tag: 'Fail', error: { _tag: 'ProjectMutationError', commandId: payload.commandId, message: 'Failed to mutate project.' } });
          projectRows.push({ id: payload.projectId, title: payload.title, workspaceRoot: payload.workspaceRoot });
          projectReceipts.set(payload.commandId, { type: payload.type, projectId: payload.projectId });
          if (controls.disconnectAfterEffect) return socket.destroy();
          return success(project(payload.projectId, payload.title, payload.workspaceRoot));
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
  /** Drops every live WebSocket, as a T3 restart or network reset does. */
  const dropSockets = () => { for (const socket of sockets) socket.destroy(); };
  return { endpoint: `http://127.0.0.1:${address.port}`, controls, threads, commands, requests, projects: projectRows, dropSockets };
}
