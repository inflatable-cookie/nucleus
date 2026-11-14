import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { readFileSync } from 'node:fs';

type Value = Record<string, any>;
const contract = JSON.parse(readFileSync(new URL('../fixtures/t3code-contract.json', import.meta.url), 'utf8')) as Value;
export const STAMP = '2026-01-01T00:00:00.000Z';

/**
 * The Nightly's record shapes, captured read-only from its own wire (contract
 * `wireShapes`: keys only, values synthetic). A test may override any field it
 * needs; the transport completes every served record to this shape and checks
 * it, so the fixture is always a Nightly wire record and never an invented
 * partial one (nucleus#1188 review).
 */
const shapes = contract.wireShapes as {
  threadKeys: string[]; runKeys: string[]; runtimeRequestKeys: string[];
  turnItemBaseKeys: string[]; turnItemTypeKeys: Record<string, string[]>; messageKeys: string[] };
const modelSelection = { instanceId: 'synthetic-provider', model: 'synthetic-model' };

export function syntheticThread(id: string, directory: string, overrides: Value = {}): Value {
  const thread: Value = { id, projectId: 'synthetic-project', title: 'Synthetic thread',
    providerInstanceId: 'synthetic-provider', modelSelection, runtimeMode: 'full-access', interactionMode: 'default',
    branch: 'synthetic', worktreePath: directory, linkedPullRequest: null, pullRequests: [], activeProviderThreadId: null,
    createdBy: 'user', creationSource: 'web', lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null, createdAt: STAMP, updatedAt: STAMP, archivedAt: null, deletedAt: null,
    settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null,
    opens: [], titleRegeneration: null, ...overrides };
  return thread;
}

export function syntheticRun(threadId: string, ordinal: number, overrides: Value = {}): Value {
  const id = overrides.id ?? `synthetic-run-${ordinal}`;
  return { id, threadId, ordinal, providerInstanceId: 'synthetic-provider', modelSelection,
    providerThreadId: null, userMessageId: `synthetic-message-${id}`, rootNodeId: null, activeAttemptId: null,
    status: 'completed', queuePosition: null, requestedAt: STAMP, startedAt: STAMP, completedAt: STAMP,
    checkpointId: null, contextHandoffId: null, workspacePreparation: null, ...overrides };
}

export function syntheticRuntimeRequest(overrides: Value = {}): Value {
  const id = overrides.id ?? 'synthetic-request';
  return { id, nodeId: `synthetic-node-${id}`, providerTurnId: null, nativeRequestRef: null, kind: 'user_input',
    status: 'pending', responseCapability: { type: 'live', providerSessionId: 'synthetic-session' },
    createdAt: STAMP, resolvedAt: null, ...overrides };
}

export function syntheticTurnItem(threadId: string, ordinal: number, overrides: Value = {}): Value {
  const id = overrides.id ?? `synthetic-item-${ordinal}`;
  const type = overrides.type ?? 'assistant_message';
  const base: Value = { id, threadId, type, status: 'completed', title: null, ordinal,
    runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
    startedAt: STAMP, completedAt: STAMP, updatedAt: STAMP };
  const member: Record<string, Value> = {
    assistant_message: { messageId: `synthetic-message-${id}`, text: 'Synthetic reply', streaming: false },
    user_message: { messageId: `synthetic-message-${id}`, createdBy: 'user', creationSource: 'web', inputIntent: 'turn_start',
      text: 'Synthetic prompt', attachments: [] },
    user_input_request: { requestId: `synthetic-request-${id}`,
      questions: [{ id: `synthetic-question-${id}`, header: 'Synthetic', question: 'Synthetic question?',
        options: [{ label: 'Yes', description: 'Accept the synthetic choice' }, { label: 'No', description: 'Refuse it' }] }] },
    command_execution: { input: 'synthetic-command', exitCode: 0, outputIndicatesFailure: false, outputOmitted: false },
    reasoning: { text: 'Synthetic reasoning', streaming: false },
  };
  return { ...base, ...(member[type] ?? {}), ...overrides };
}

/** Every record of a projection, completed to the recorded wire shape. */
function wireProjection(p: Value, bounded = false): Value {
  const threadId = p.thread.id;
  const thread = syntheticThread(threadId, p.thread.worktreePath ?? '/synthetic', p.thread);
  const runs = (p.runs ?? []).map((run: Value, index: number) => syntheticRun(threadId, index + 1, run));
  const runtimeRequests = (p.runtimeRequests ?? []).map((request: Value, index: number) =>
    syntheticRuntimeRequest({ id: `synthetic-request-${index + 1}`, ...request }));
  const turnItems = (p.turnItems ?? []).map((item: Value, index: number) => syntheticTurnItem(threadId, index + 1, item));
  const messages = (p.messages ?? []).map((message: Value, index: number) => ({ id: `synthetic-message-${index + 1}`,
    threadId, runId: null, nodeId: null, createdBy: 'user', creationSource: 'web', role: 'user', text: 'Synthetic message',
    attachments: [], streaming: false, createdAt: STAMP, updatedAt: STAMP, ...message }));
  const projection = { ...p, thread, runs, runtimeRequests, turnItems, messages,
    // The wire carries the visible rows beside the window; each row points at its item.
    visibleTurnItems: bounded ? turnItems.map((item: Value, index: number) => ({ position: index + 1,
      sourceItemId: item.id, sourceThreadId: threadId, visibility: 'local', item })) : [] };
  assertWireRecords(projection);
  return projection;
}

/** Refuse a served record that is missing a field the Nightly's wire always carries. */
function assertWireRecords(projection: Value): void {
  const missing = (records: Value[], keys: string[], kind: string) => {
    for (const record of records)
      for (const key of keys)
        assert.ok(Object.hasOwn(record, key), `${kind} ${record.id ?? record.type} is missing the wire field ${key}`);
  };
  missing([projection.thread], shapes.threadKeys, 'thread');
  missing(projection.runs, shapes.runKeys, 'run');
  missing(projection.runtimeRequests, shapes.runtimeRequestKeys, 'runtimeRequest');
  missing(projection.messages, shapes.messageKeys, 'message');
  for (const item of projection.turnItems) {
    const extra = shapes.turnItemTypeKeys[item.type] ?? [];
    missing([item], [...shapes.turnItemBaseKeys, 'type', ...extra.filter((key: string) => !shapes.turnItemBaseKeys.includes(key))], `turnItem ${item.type}`);
  }
}

export function threadProjection(id: string, directory: string): Value {
  return { thread: syntheticThread(id, directory), runs: [], runtimeRequests: [], turnItems: [], messages: [], updatedAt: STAMP };
}

/** Exercises the real HTTP ticket exchange and WebSocket RPC client. */
export async function t3Fake(t: TestContext, directory: string) {
  const requests: Value[] = [];
  const commands: Value[] = [];
  /** Every thread snapshot this fake served: what the client asked for and what it got. */
  const snapshots: Value[] = [];
  const projectRows: Value[] = [{ id: 'synthetic-project', title: 'Synthetic project', workspaceRoot: directory }];
  const archivedProjects = new Set<string>();
  const threads = new Map<string, Value>([['synthetic-probe', threadProjection('synthetic-probe', directory)]]);
  /**
   * The nightly's bounded snapshot (recorded `subscribeThread` contract): only a
   * client that sends `acceptBoundedSnapshot` receives one. The thread record is
   * whole; runs keep the active-status set, the window's own runs and the run the
   * shell presents; runtime requests keep the pending set and the window's own
   * requests; plans and context handoffs are filtered; and only the timeline is a
   * window with `hasMoreHistory` and an opaque `historyCursor`. Items a pending
   * runtime request needs are retained outside the window, as the nightly keeps
   * them (contract `subscribeThread.projectionRetained`).
   */
  const boundedSnapshot = (raw: Value, rowLimit: number) => {
    const p = wireProjection(raw, true);
    const active = new Set(['queued', 'preparing', 'starting', 'running', 'waiting']);
    const pending = new Set(p.runtimeRequests.filter((request: Value) => ['pending', 'waiting'].includes(request.status)).map((request: Value) => request.id));
    const kept = new Set(p.turnItems.slice(-rowLimit).map((item: Value) => item.id));
    for (const item of p.turnItems)
      if (item.type === 'run_interrupt_request' || ['user_input_request', 'approval_request'].includes(item.type) && pending.has(item.requestId))
        kept.add(item.id);
    const windowItems = p.turnItems.filter((item: Value) => kept.has(item.id));
    const windowRuns = new Set(windowItems.flatMap((item: Value) => item.runId ? [item.runId] : []));
    const presented = [...p.runs].reverse().find((run: Value) => run.status !== 'queued' || !run.queueHeld);
    const runs = p.runs.filter((run: Value) => active.has(run.status) || windowRuns.has(run.id) || run.id === presented?.id);
    const windowNodes = new Set(windowItems.flatMap((item: Value) => item.nodeId ? [item.nodeId] : []));
    const runtimeRequests = p.runtimeRequests.filter((request: Value) => ['pending', 'waiting'].includes(request.status) || windowNodes.has(request.nodeId));
    const plans = (p.plans ?? []).filter((plan: Value) => plan.status === 'active');
    const contextHandoffs = (p.contextHandoffs ?? []).filter((handoff: Value) => ['pending', 'ready'].includes(handoff.status));
    const hasMoreHistory = windowItems.length < p.turnItems.length;
    const snapshot = { projection: { ...p, runs, runtimeRequests, plans, contextHandoffs, turnItems: windowItems, messages: p.messages.slice(-1) },
      hasMoreHistory, historyCursor: hasMoreHistory ? 'synthetic-history-cursor' : null, latestLocalTurnOrdinal: null };
    // The fixture is checked against the recorded contract on every bounded
    // answer, so a hand-made coverage field cannot enter a test unobserved.
    for (const field of contract.subscribeThread.boundedRequired)
      assert.ok(field === 'snapshotSequence' || Object.hasOwn(snapshot, field), `bounded snapshot.${field}`);
    return snapshot;
  };
  const controls = { environmentId: 'synthetic-environment', version: 'nightly-synthetic-unseen', protocol: 2,
    synchronized: true, incompleteThread: false, enrichment: false, shellMissingField: '',
    snapshotSequence: 1, threadCoverage: {} as Record<string, unknown>, beforeArchiveRead: (() => {}) as () => void,
    /** The next N thread reads end with an Interrupt frame instead of a snapshot (a stream cut mid-turn). */
    interruptThreadReads: 0,
    disconnectMutation: false, disconnectAfterEffect: false, refuseMutation: false, postEffectDefect: false,
    unsupportedProjectCreate: false, projectMutationFailure: false, projectMutationSecretFailure: false, projectMutationIdSecretFailure: false, secretDefect: false, secretLocationDefect: false, mutationObserver: (() => {}) as () => void,
    /** Rows the bounded snapshot keeps before it pages; the nightly's own limit is a policy, not a contract field. */
    boundedRowLimit: 20,
    /**
     * Millisecond delay before a whole-projection answer (a read that did not opt
     * into the bounded snapshot), modelling the measured slow full read of a very
     * long thread: the nightly sends all 1986 of a long worker's turn items in one
     * 8.1 MiB frame, and a busy service outlives the 10 s read bound doing it.
     */
    slowFullSnapshotMs: 0,
    /** Millisecond delay before any thread snapshot answer (a busy or wedged read). */
    slowSnapshotMs: 0,
    /** A nightly that ignores `acceptBoundedSnapshot` and always answers the whole projection. */
    ignoreBoundedSnapshot: false,
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
  const shell = (raw: Value) => {
    const p = wireProjection(raw);
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
          // A removed thread is in no list: the nightly's own shell reads filter
          // `deleted_at IS NULL`, so absence is the positive answer there.
          const archived = [...threads.values()].filter(p => p.thread.archivedAt && !p.thread.deletedAt).map(shell);
          return stream([{ kind: 'snapshot', snapshot: { schemaVersion: 1, snapshotSequence: controls.snapshotSequence, projects: projects(), threads: active, archivedThreads: archived } },
            ...(controls.enrichment ? [{ kind: 'snapshot', resolvedRepositoryIdentityRoots: [directory], snapshot: { threads: [], archivedThreads: [] } }] : []), ...marker()]);
        }
        case 'orchestration.getArchivedShellSnapshot':
          controls.beforeArchiveRead();
          return success({ schemaVersion: 1, snapshotSequence: controls.snapshotSequence, projects: projects(), threads: [...threads.values()].filter(p => p.thread.archivedAt && !p.thread.deletedAt).map(shell) });
        case 'orchestration.subscribeThread': {
          for (const field of Object.keys(payload))
            assert.ok(contract.subscribeThread.input.includes(field), `subscribeThread.${field} is not a recorded input field`);
          const p = threads.get(payload.threadId);
          // The nightly refuses a removed thread's projection outright.
          if (!p || p.thread.deletedAt !== null) return failure({ _tag: 'Fail', error: { _tag: 'ThreadNotFoundError' } });
          if (controls.interruptThreadReads > 0) { controls.interruptThreadReads--; return send({ _tag: 'Interrupt', requestId: request.id }); }
          // A bounded snapshot is answered only to a read that opts in, and only
          // by a nightly that understands the field (recorded server guard).
          const bounded = payload.acceptBoundedSnapshot === true && !controls.ignoreBoundedSnapshot;
          const coverage = bounded ? boundedSnapshot(p, controls.boundedRowLimit) : { projection: wireProjection(p) };
          // A coverage claim that says more history exists without a cursor: the
          // pair the nightly never sends, which no read may use.
          const incoherent = controls.incompleteThread ? { hasMoreHistory: true, historyCursor: null } : {};
          const frame = { kind: 'snapshot', snapshotSequence: controls.snapshotSequence, ...coverage, ...incoherent, ...controls.threadCoverage } as Value;
          snapshots.push({ threadId: payload.threadId, acceptBoundedSnapshot: payload.acceptBoundedSnapshot === true, bounded,
            hasMoreHistory: frame.hasMoreHistory === true, historyCursor: frame.historyCursor ?? null,
            turnItems: frame.projection?.turnItems?.length ?? 0, runs: frame.projection?.runs?.length ?? 0 });
          const answer = () => stream([frame, ...marker()]);
          // A whole projection of a very long thread is the slow read; a bounded
          // window never pays that cost (contract `slowFullSnapshotMs`). A wedged
          // or busy server delays either answer (`slowSnapshotMs`).
          const delay = controls.slowSnapshotMs || (!bounded ? controls.slowFullSnapshotMs : 0);
          if (delay > 0) { setTimeout(answer, delay); return; }
          return answer();
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
          return success({ threadId: payload.threadId, projection: wireProjection(p), resumed: false, sequence: 1 });
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
            case 'thread.delete':
              // The nightly cancels active work and answers success; `onlyIfUnused`
              // is the shape that silently changes nothing, so it must not be sent.
              assert.equal(payload.onlyIfUnused, undefined, 'thread.delete must not ask the nightly to skip a used thread');
              if (p.thread.deletedAt === null) p.thread.deletedAt = STAMP;
              for (const run of p.runs) if (['preparing', 'queued', 'starting', 'running', 'waiting'].includes(run.status)) run.status = 'cancelled';
              break;
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
  return { endpoint: `http://127.0.0.1:${address.port}`, controls, threads, commands, requests, snapshots, projects: projectRows, dropSockets };
}
