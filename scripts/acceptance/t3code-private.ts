/** Opt-in proof against an unmodified, privately extracted T3 nightly server. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { T3RpcClient } from '../../hosts/t3code/rpc';
import { HostRegistry, type KnownHost } from '../../core/host/host-registry';
import type { Adapter } from '../../core/host';
import { ProvenPreSendRefusalError } from '../../core/host';
import { Admission, admitAdapter } from '../../core/host/admission';

async function main() {
const expectedVersion = '0.1.6-nightly.20261030.3917';
const expectedRevision = '97e35bcf23e4dcf34c2dcffadd37c08db0e01e52';
const args = process.argv.slice(2);
const asarArg = args.indexOf('--asar');
const asar = asarArg >= 0 ? args[asarArg + 1] : process.env.NUCLEUS_T3_PROOF_ASAR;
if (!asar) throw Error('Set NUCLEUS_T3_PROOF_ASAR or pass --asar with the target nightly app archive');
const scratch = process.env.TMPDIR;
if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory()) throw Error('The run scratch volume is required');
const root = mkdtempSync(join(realpathSync(scratch), 't3-private-'));
console.log(JSON.stringify({ proofRoot: root }));
const evidence: Record<string, unknown> = { targetVersion: expectedVersion, targetRevision: expectedRevision, steps: [] };
const steps = evidence.steps as unknown[];
const bundle = join(root, 'bundle');
mkdirSync(bundle);

type ArchiveEntry = { files?: Record<string, ArchiveEntry>; size?: number; offset?: string; unpacked?: boolean; link?: string };
function extractArchive(source: string, destination: string) {
  const fd = openSync(source, 'r');
  try {
    const prelude = Buffer.alloc(16);
    assert.equal(readSync(fd, prelude, 0, 16, 0), 16);
    const headerSize = prelude.readUInt32LE(12);
    assert.ok(headerSize > 0 && headerSize < 16 * 1024 * 1024, 'Bounded archive header');
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    const tree = JSON.parse(header.toString()) as ArchiveEntry;
    const base = prelude.readUInt32LE(4) + 8;
    function walk(entry: ArchiveEntry, relative: string) {
      const target = resolve(destination, relative);
      assert.ok(target === destination || target.startsWith(destination + sep), 'Archive entry stays inside the fixture');
      if (entry.files) {
        mkdirSync(target, { recursive: true });
        for (const [name, child] of Object.entries(entry.files)) walk(child, join(relative, name));
      } else if (entry.link) {
        const linkTarget = resolve(destination, entry.link);
        assert.ok(linkTarget.startsWith(destination + sep), 'Archive link stays inside the fixture');
        symlinkSync(linkTarget, target);
      } else if (entry.unpacked) {
        copyFileSync(join(source + '.unpacked', relative), target);
      } else {
        assert.ok(typeof entry.size === 'number' && entry.size >= 0 && entry.size < 64 * 1024 * 1024, 'Bounded archive entry');
        const bytes = Buffer.alloc(entry.size);
        readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
        writeFileSync(target, bytes);
      }
    }
    for (const [name, entry] of Object.entries(tree.files ?? {})) {
      if (name === 'node_modules' || name === 'package.json') walk(entry, name);
      if (name === 'apps') walk(entry.files!.server, 'apps/server');
    }
  } finally { closeSync(fd); }
}
extractArchive(resolve(asar), bundle);
const metadata = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'));
assert.equal(metadata.version, expectedVersion);
assert.ok(expectedRevision.startsWith(metadata.t3codeCommitHash));
evidence.archiveSha256 = createHash('sha256').update(readFileSync(resolve(asar))).digest('hex');
const entry = join(bundle, 'apps/server/dist/bin.mjs');
const privateHome = join(root, 'home');
const data = join(root, 't3-data');
const repository = join(root, 'synthetic-repository');
const worktree = join(root, 'synthetic-worktree');
for (const path of [privateHome, join(data, 'userdata'), repository, join(root, 'codex-home')]) mkdirSync(path, { recursive: true });
const peer = fileURLToPath(new URL('./t3code-provider.mjs', import.meta.url));
const provider = join(root, 'synthetic-codex');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(provider, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(peer)} "$@"\n`, { mode: 0o700 });
writeFileSync(join(data, 'userdata/settings.json'), JSON.stringify({
  providerInstances: { codex: { driver: 'codex', enabled: true, config: { binaryPath: provider, homePath: join(root, 'codex-home'), setupMode: 'existing' } } },
  notifications: { enabled: false },
}), { mode: 0o600 });
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: privateHome, TMPDIR: root, TMP: root, TEMP: root,
  XDG_CONFIG_HOME: join(privateHome, '.config'), XDG_DATA_HOME: join(privateHome, '.local/share'), XDG_CACHE_HOME: join(privateHome, '.cache'),
  T3CODE_HOME: data, T3CODE_NO_BROWSER: 'true', T3CODE_LOG_LEVEL: 'Warn', T3CODE_TRACE_TIMING_ENABLED: 'false',
  NUCLEUS_T3_PROVIDER_LOG: join(root, 'provider-protocol.ndjson'),
};
async function run(argv: string[], cwd = root, secret = false): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', bytes => { stdout += bytes; });
    child.stderr!.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolveRun(stdout.trim());
      writeFileSync(join(root, 'command-error.log'), stderr, { mode: 0o600 });
      writeFileSync(join(root, 'command-output.log'), stdout, { mode: 0o600 });
      reject(Error(`Private ${secret ? 'credential' : 'setup'} command failed (${code}); ${secret ? 'output retained privately in command-error.log' : stderr.slice(-2000)}`));
    });
  });
}
await run(['git', 'init', '--quiet'], repository);
await run(['git', 'config', 'user.email', 'fixture@example.invalid'], repository);
await run(['git', 'config', 'user.name', 'Synthetic fixture'], repository);
writeFileSync(join(repository, 'fixture.txt'), 'Synthetic private proof\n');
await run(['git', 'add', 'fixture.txt'], repository);
await run(['git', 'commit', '--quiet', '-m', 'Synthetic fixture'], repository);
await run(['git', 'worktree', 'add', '--quiet', '-b', 'proof-worktree', worktree], repository);
const bearer = await run([process.execPath, entry, 'auth', 'session', 'issue', '--base-dir', data, '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--token-only'], root, true);
assert.ok(bearer.length > 20, 'Private session bearer issued');
async function reservePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>(resolveListen => socket.listen(0, '127.0.0.1', resolveListen));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolveClose => socket.close(() => resolveClose()));
  return port;
}
const port = await reservePort();
const endpoint = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let rpc: T3RpcClient | undefined;
let host: { close(): void } | undefined;
async function startServer() {
  const log = openSync(join(root, 'server.log'), 'a', 0o600);
  server = spawn(process.execPath, [entry, '--base-dir', data, '--host', '127.0.0.1', '--port', String(port), '--no-browser'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = (stream: NodeJS.ReadableStream) => {
    let buffered = '';
    stream.on('data', bytes => {
      buffered += bytes;
      const lines = buffered.split('\n'); buffered = lines.pop() || '';
      for (const line of lines) writeFileSync(log, `${/pairingUrl:|#token=/.test(line) ? '[private pairing URL redacted]' : line}\n`);
    });
  };
  output(server.stdout!); output(server.stderr!);
  server.once('close', () => closeSync(log));
  await until(async () => {
    if (server?.exitCode !== null) throw Error(`Private server exited (${server?.exitCode}); see retained server log`);
    return (await fetch(`${endpoint}/.well-known/t3/environment`).catch(() => null))?.ok === true;
  }, 'private server startup', 60000);
}
async function stopServer(signal: NodeJS.Signals = 'SIGTERM') {
  const child = server;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveStop, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Private server did not exit')); }, 10000);
    child.once('close', () => { clearTimeout(timer); resolveStop(); });
    child.kill(signal);
  });
  server = undefined;
}
async function until<T>(read: () => Promise<T>, description: string, milliseconds = 30000): Promise<NonNullable<T>> {
  const deadline = Date.now() + milliseconds;
  let lastFailure = '';
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result) return result as NonNullable<T>;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (!lastFailure.includes('state changed during snapshot') && !lastFailure.includes('inventory.snapshotSequence changed')) throw error;
    }
    await delay(100);
  }
  throw Error(`Timed out waiting for ${description}${lastFailure ? ': ' + lastFailure : ''}`);
}
async function connectRpc() {
  rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 15000 });
  await rpc.connect();
  return rpc;
}
async function compatibilityFault(readConfig: () => Promise<unknown>) {
  const calls: string[] = [];
  const sockets = new Set<import('node:stream').Duplex>();
  const http = createHttpServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ticket: 'synthetic-ticket', expiresAt: Date.now() + 60000 })); });
  http.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const key = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 2) {
        let size = buffered[1]! & 127, offset = 2;
        if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); offset = 4; }
        if (size === 127) { socket.destroy(); return; }
        const masked = Boolean(buffered[1]! & 128), mask = masked ? buffered.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffered.length < offset + size) return;
        const payload = Buffer.from(buffered.subarray(offset, offset + size));
        const opcode = buffered[0]! & 15;
        buffered = buffered.subarray(offset + size);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString());
        if (message._tag !== 'Request') continue;
        calls.push(message.tag);
        if (message.tag !== 'server.getConfig') { socket.destroy(); continue; }
        void readConfig().then(config => {
          const changed = structuredClone(config) as { environment: { orchestrationProtocolVersion: number } };
          changed.environment.orchestrationProtocolVersion = 999;
          const value = Buffer.from(JSON.stringify({ _tag: 'Exit', requestId: message.id, exit: { _tag: 'Success', value: changed } }));
          const frame = Buffer.alloc(value.length < 126 ? 2 : 4); frame[0] = 0x81;
          if (value.length < 126) frame[1] = value.length; else { frame[1] = 126; frame.writeUInt16BE(value.length, 2); }
          socket.write(Buffer.concat([frame, value]));
        }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise<void>(ready => http.listen(0, '127.0.0.1', ready));
  return { endpoint: `http://127.0.0.1:${(http.address() as { port: number }).port}`, calls, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(closed => http.close(() => closed())); } };
}
async function publicSourceDrift(newestRevision: string) {
  const sourcePath = 'packages/contracts/src/orchestrationV2.ts';
  const read = async (revision: string) => {
    const response = await fetch(`https://raw.githubusercontent.com/pingdotgg/t3code/${revision}/${sourcePath}`);
    assert.ok(response.ok, 'Nightly contract source is readable');
    const text = await response.text();
    writeFileSync(join(root, `contract-${revision}.ts`), text, { mode: 0o600 });
    return text;
  };
  const [target, newest] = await Promise.all([read(expectedRevision), read(newestRevision)]);
  const declaration = (text: string, name: string) => {
    const begin = text.indexOf(`const ${name} =`);
    assert.ok(begin >= 0, `Source declaration ${name} exists`);
    const end = text.indexOf('\nexport ', begin + name.length + 8);
    assert.ok(end > begin, `Source declaration ${name} is bounded`);
    return text.slice(begin, end).trim();
  };
  const command = (text: string, name: string) => {
    const typeAt = text.indexOf(`type: Schema.Literal("${name}")`);
    assert.ok(typeAt >= 0, `Source command ${name} exists`);
    const begin = text.lastIndexOf('Schema.Struct({', typeAt);
    const end = text.indexOf('\n  Schema.Struct({', typeAt);
    assert.ok(begin >= 0 && end > typeAt, `Source command ${name} is bounded`);
    return text.slice(begin, end).trim();
  };
  const shapes = [
    ['launchThread', (text: string) => declaration(text, 'OrchestrationV2ThreadLaunchInput')],
    ['existingWorktree', (text: string) => declaration(text, 'OrchestrationV2ThreadLaunchWorkspaceStrategy')],
    ['subscribeThread', (text: string) => declaration(text, 'OrchestrationV2SubscribeThreadInput')],
    ...['message.dispatch', 'runtime-request.respond', 'thread.stop', 'thread.archive'].map(name => [name, (text: string) => command(text, name)] as const),
  ] as const;
  const result = shapes.map(([name, extract]) => {
    const before = extract(target), after = extract(newest);
    const oldLines = new Set(before.split('\n').map(line => line.trim()).filter(Boolean));
    const newLines = new Set(after.split('\n').map(line => line.trim()).filter(Boolean));
    return { name, changed: before !== after,
      targetSha256: createHash('sha256').update(before).digest('hex'),
      newestSha256: createHash('sha256').update(after).digest('hex'),
      added: [...newLines].filter(line => !oldLines.has(line)), removed: [...oldLines].filter(line => !newLines.has(line)) };
  });
  return { sourcePath, targetRevision: expectedRevision, newestRevision, shapes: result, note: 'Source comparison only; runtime qualification targets the installed nightly revision' };
}
try {
  await startServer();
  const client = await connectRpc();
  const config = await client.call('server.getConfig', {}) as { environment: { serverVersion: string; orchestrationProtocolVersion: number } };
  assert.equal(config.environment.serverVersion, expectedVersion);
  assert.equal(config.environment.orchestrationProtocolVersion, 2);
  steps.push({ step: 'private-nightly-config', result: 'passed' });
  const projectId = randomUUID();
  const probeThreadId = randomUUID();
  await client.call('projects.mutate', { type: 'project.create', commandId: randomUUID(), projectId, title: 'Synthetic adapter proof', workspaceRoot: repository });
  const selection = { instanceId: 'codex', model: 'gpt-5.4' };
  await client.call('orchestration.launchThread', { commandId: randomUUID(), threadId: probeThreadId, projectId, title: 'Synthetic compatibility seed', modelSelection: selection, runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree, branch: 'proof-worktree' } });
  if (args.includes('--bootstrap-only')) {
    steps.push({ step: 'bootstrap-only', result: 'passed', note: 'Adapter lifecycle proof not run' });
  } else {
    const { createHost, createAdapter } = await import('../../hosts/t3code');
    const { answerHostPermission } = await import('../../service/host-permissions');
    const hostOptions = { endpoint, bearer, statePath: join(root, 'adapter-state.json'), timeoutMs: 15000 };
    let adapter = createHost(hostOptions);
    let nativeRuntimeResponses = 0;
    const traceRuntimeResponses = (client: T3RpcClient) => {
      const call = client.call.bind(client);
      client.call = (method, payload) => {
        if (method === 'orchestration.dispatchCommand' && payload !== null && typeof payload === 'object' && 'type' in payload && payload.type === 'runtime-request.respond') nativeRuntimeResponses++;
        return call(method, payload);
      };
    };
    traceRuntimeResponses(adapter.rpc);
    host = adapter;
    await adapter.connect(probeThreadId);
    let knownHosts: readonly KnownHost[] = [];
    const registry = new HostRegistry<{ adapter: Adapter; admission: Admission }>({ read: () => knownHosts, write: value => { knownHosts = value; }, transaction: fn => fn() });
    const admission = registry.resource(adapter.hostId, () => new Admission({ observationCacheMs: 0 }));
    let registryClaim = registry.connect(adapter.hostId, endpoint, { adapter: admitAdapter(createAdapter(adapter), admission), admission });
    const registered = registry.get(adapter.hostId);
    assert.ok(registered, 'Authenticated native host is registered');
    await assert.rejects(registered.adapter.validate({} as never), /CLI reporting and board/);
    steps.push({ step: 'compatibility-probe', result: 'passed' });
    const fault = await compatibilityFault(() => rpc!.call('server.getConfig', {}));
    const incompatible = createHost({ ...hostOptions, endpoint: fault.endpoint, statePath: join(root, 'fault-state.json') });
    try {
      await assert.rejects(incompatible.connect(probeThreadId), /orchestrationProtocolVersion/);
      assert.deepEqual(fault.calls, ['server.getConfig']);
    } finally { incompatible.close(); await fault.close(); }
    steps.push({ step: 'compatibility-refusal', result: 'passed', note: 'Read-only relay injected incompatible protocol into the real private config response; zero mutation calls' });
    const workspace = await adapter.createWorkspace({ requestId: randomUUID(), title: 'Synthetic worktree', directory: worktree, project: { projectId } });
    const attemptId = randomUUID();
    const agent = await adapter.createAgent({ workspaceId: workspace.id, title: 'Synthetic worker', profile: { id: 'synthetic', name: 'Synthetic', provider: 'codex', model: 'gpt-5.4' } as never, mcpBindingPath: null,
      attempt: () => ({ requestId: attemptId, prompt: 'proof-initial', labels: { taskId: 'synthetic-task', runId: 'synthetic-run' }, environment: {} }) });
    type Detail = { thread: { worktreePath: string; archivedAt: string | null }, messages: Array<{ id: string; text: string; role: string }>; runs: Array<{ id: string; userMessageId: string; status: string }>; runtimeRequests: Array<{ id: string; kind: string; status: string; responseCapability: { type: string } }> };
    const detail = async () => (await rpc!.readStream('orchestration.subscribeThread', { threadId: agent.id }, value => (value as { kind?: string })?.kind === 'snapshot') as { projection: Detail }).projection;
    const settled = async (text: string) => until(async () => {
      const p = await detail();
      const message = p.messages.find(message => message.role === 'user' && message.text === text);
      const run = message && p.runs.find(run => run.userMessageId === message.id);
      if (run?.status === 'failed') throw Error(`Synthetic provider failed ${text}; see private server log`);
      return run?.status === 'completed' ? run : null;
    }, `${text} completed run`);
    const idle = async () => { const state = await adapter.observe(agent.id); return !state.active && !state.permissions && state.status === 'idle' ? state : null; };
    await settled('proof-initial');
    await until(idle, 'initial idle');
    assert.equal((await detail()).thread.worktreePath, worktree);
    steps.push({ step: 'create-existing-worktree', result: 'passed' });
    await adapter.sendMessage(agent.id, { messageId: randomUUID(), text: 'proof-followup' });
    await settled('proof-followup');
    await until(idle, 'follow-up idle');
    steps.push({ step: 'follow-up', result: 'passed' });
    await adapter.sendMessage(agent.id, { messageId: randomUUID(), text: 'proof-question' });
    const question = await until(async () => (await adapter.observe(agent.id)).pendingRequest, 'pending question');
    await adapter.answerNativeQuestion(agent.id, workspace.id, question.id, { continue: 'Yes' });
    await settled('proof-question');
    await until(idle, 'question answer');
    const questionResponses = nativeRuntimeResponses;
    await adapter.answerNativeQuestion(agent.id, workspace.id, question.id, { continue: 'Yes' });
    assert.equal(nativeRuntimeResponses, questionResponses, 'Settled native question replays locally');
    steps.push({ step: 'answer-question', result: 'passed', note: 'Settled answer replay sends no second native response' });
    await adapter.sendMessage(agent.id, { messageId: randomUUID(), text: 'proof-approval' });
    const approval = await until(async () => (await adapter.observe(agent.id)).pendingRequest, 'pending permission');
    const completedControls = admission.snapshot().control.completed;
    const permissionInput = { hostId: adapter.hostId, agentId: agent.id, workspaceId: workspace.id, requestId: approval.id, decision: 'accept' as const, intentId: randomUUID() };
    await answerHostPermission(registry, permissionInput);
    assert.equal(admission.snapshot().control.completed, completedControls + 1, 'Registered permission answer uses host control admission');
    await settled('proof-approval');
    await until(idle, 'permission answer');
    const permissionResponses = nativeRuntimeResponses;
    await answerHostPermission(registry, permissionInput);
    await answerHostPermission(registry, { ...permissionInput, intentId: randomUUID() });
    await assert.rejects(answerHostPermission(registry, { ...permissionInput, intentId: randomUUID(), decision: 'decline' }), ProvenPreSendRefusalError);
    assert.equal(nativeRuntimeResponses, permissionResponses, 'Settled permission replays and conflicting answers send no second native response');
    steps.push({ step: 'answer-permission', result: 'passed', note: 'Host-qualified admitted Adapter/HostFacade route; same-intent and new-intent replay are local, conflicting outcome refused, lifecycle dispatch still refused' });
    await adapter.sendMessage(agent.id, { messageId: randomUUID(), text: 'proof-hold' });
    await until(async () => (await adapter.observe(agent.id)).active, 'active run');
    await adapter.stopAgentTurn(agent.id);
    await until(idle, 'stop idle');
    steps.push({ step: 'observe-active-and-stop', result: 'passed' });
    async function restart() {
      registry.disconnect(adapter.hostId, registryClaim);
      adapter.close(); rpc?.close();
      await stopServer('SIGKILL');
      await startServer();
      await connectRpc();
      adapter = createHost(hostOptions); host = adapter;
      traceRuntimeResponses(adapter.rpc);
      await adapter.connect(probeThreadId);
      assert.equal(registry.resource(adapter.hostId, () => new Admission()), admission, 'Reconnect retains per-host admission');
      registryClaim = registry.connect(adapter.hostId, endpoint, { adapter: admitAdapter(createAdapter(adapter), admission), admission });
    }
    await adapter.sendMessage(agent.id, { messageId: randomUUID(), text: 'proof-question' });
    const restartQuestion = await until(async () => (await adapter.observe(agent.id)).pendingRequest, 'restart question');
    await restart();
    const retained = (await detail()).runtimeRequests.find(request => request.id === restartQuestion.id);
    assert.equal(retained?.status, 'pending');
    assert.equal(retained?.responseCapability.type, 'message');
    const responsesAfterRestart = nativeRuntimeResponses;
    await answerHostPermission(registry, permissionInput);
    assert.equal(nativeRuntimeResponses, responsesAfterRestart, 'Settled permission replays locally after reconnect');
    const priorRunCount = (await detail()).runs.length;
    await adapter.answerNativeQuestion(agent.id, workspace.id, restartQuestion.id, { continue: 'Yes' });
    await until(async () => { const p = await detail(); return p.runtimeRequests.find(r => r.id === restartQuestion.id)?.status === 'resolved' && p.runs.length > priorRunCount && p.runs.at(-1)?.status === 'completed'; }, 'message-answer after restart');
    await until(idle, 'restart question idle');
    steps.push({ step: 'restart-pending-question', result: 'passed' });
    await adapter.sendMessage(agent.id, { messageId: randomUUID(), text: 'proof-approval' });
    const restartApproval = await until(async () => (await adapter.observe(agent.id)).pendingRequest, 'restart approval');
    await restart();
    const expired = (await detail()).runtimeRequests.find(request => request.id === restartApproval.id);
    assert.equal(expired?.status, 'expired');
    assert.equal(expired?.responseCapability.type, 'not_resumable');
    await assert.rejects(answerHostPermission(registry, { hostId: adapter.hostId, agentId: agent.id, workspaceId: workspace.id, requestId: restartApproval.id, decision: 'accept', intentId: randomUUID() }), /no longer answerable/);
    await until(idle, 'restart approval idle');
    steps.push({ step: 'restart-pending-permission', result: 'passed' });
    await adapter.archiveAgent(agent.id);
    await until(async () => (await adapter.observe(agent.id)).status === 'archived', 'archive');
    steps.push({ step: 'archive', result: 'passed' });
  }
  const releases = await fetch('https://api.github.com/repos/pingdotgg/t3code/releases?per_page=20', { headers: { 'User-Agent': 'nucleus-private-proof', Accept: 'application/vnd.github+json' } });
  assert.ok(releases.ok, 'Newest nightly metadata is readable');
  const newest = (await releases.json() as Array<{ tag_name: string; target_commitish: string; published_at: string }>).find(release => release.tag_name.includes('-nightly.'));
  assert.ok(newest, 'Newest nightly is identified');
  evidence.newestNightly = newest;
  evidence.sourceDrift = await publicSourceDrift(newest.target_commitish);
  evidence.result = args.includes('--bootstrap-only') ? 'bootstrap-only' : 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  host?.close();
  rpc?.close();
  await stopServer();
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: evidence.result, steps, evidence: join(root, 'evidence.json') }));
}
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
