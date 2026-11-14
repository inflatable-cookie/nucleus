/** Read-only Nightly reply measurements. Persist keys/counts only, never remote content or IDs. */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--settings') || !args.includes('--output')) throw Error('Pass --settings and --output');
const scratch = realpathSync(process.env.TMPDIR);
const output = resolve(option('--output'));
if (!realpathSync(resolve(output, '..')).startsWith(scratch + sep)) throw Error('Output must be in a fresh fixture directory under TMPDIR');
const { t3code } = JSON.parse(readFileSync(option('--settings'), 'utf8'));
const base = new URL(t3code.endpoint);
base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:';
const measurements = [];
let socket, nextId = 1, pending;
const response = await fetch(new URL('/api/auth/websocket-ticket/rpc', base), {
  method: 'POST', headers: { Authorization: `Bearer ${t3code.bearer}` }, signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw Error(`Ticket exchange HTTP ${response.status}`);
const { ticket } = await response.json();
const url = new URL('/ws', base);
url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
url.searchParams.set('wsTicket', ticket);
url.searchParams.set('orchestrationProtocol', '2');
function read(method, payload, label) {
  return new Promise((resolveRead, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(Error(`Read timed out: ${method}`)); }, 120_000);
    pending = { id: String(nextId++), method, label, resolve: resolveRead, reject, timer, maxBytes: 0, value: undefined };
    socket.send(JSON.stringify({ _tag: 'Request', id: pending.id, tag: method, payload, headers: [] }));
  });
}
function finish(value) {
  const p = pending;
  clearTimeout(p.timer);
  pending = undefined;
  const projection = value?.projection;
  measurements.push({ label: p.label, method: p.method, maxFrameBytes: p.maxBytes,
    messageType: p.messageType, keys: Object.keys(value ?? {}).sort(),
    ...(projection ? { projectionKeys: Object.keys(projection).sort(), threadKeys: Object.keys(projection.thread).sort(),
      collections: Object.fromEntries(Object.entries(projection).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
      hasMoreHistory: value.hasMoreHistory ?? false, historyCursor: value.historyCursor ? 'synthetic-cursor' : null } : {}),
    ...(value?.threads ? { threads: value.threads.length, archivedThreads: value.archivedThreads?.length ?? 0 } : {}),
  });
  p.resolve(value);
}
try {
  await new Promise((ready, reject) => {
    socket = new WebSocket(url);
    socket.addEventListener('open', ready, { once: true });
    socket.addEventListener('error', () => reject(Error('Nightly socket error')), { once: true });
    socket.addEventListener('close', () => {
      if (pending) { clearTimeout(pending.timer); pending.reject(Error('Nightly socket closed during read')); pending = undefined; }
    });
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string') {
          if (pending) { clearTimeout(pending.timer); pending.reject(Error('Nightly sent a binary message')); pending = undefined; }
          return;
        }
        if (pending) { pending.maxBytes = Math.max(pending.maxBytes, Buffer.byteLength(event.data)); pending.messageType = 'text'; }
        const decoded = JSON.parse(event.data);
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
          if (frame._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue; }
          if (!pending || String(frame.requestId) !== pending.id) continue;
          if (frame._tag === 'Chunk') {
            socket.send(JSON.stringify({ _tag: 'Ack', requestId: pending.id }));
            for (const value of frame.values) {
              if (value.kind === 'snapshot' && !('resolvedRepositoryIdentityRoots' in value)) pending.value = value.snapshot ?? value;
              if (value.kind === 'synchronized') {
                socket.send(JSON.stringify({ _tag: 'Interrupt', requestId: pending.id }));
                finish(pending.value);
                break;
              }
            }
          } else if (frame._tag === 'Exit' && frame.exit?._tag === 'Success') finish(frame.exit.value);
          else { clearTimeout(pending.timer); pending.reject(Error(`Read failed: ${pending.method}`)); pending = undefined; }
        }
      } catch {
        if (pending) { clearTimeout(pending.timer); pending.reject(Error('Nightly returned an unexpected wire shape')); pending = undefined; }
      }
    });
  });
  const config = await read('server.getConfig', {}, 'config');
  const shell = await read('orchestration.subscribeShell', { requestCompletionMarker: true }, 'live-inventory');
  const archived = await read('orchestration.getArchivedShellSnapshot', {}, 'archived-inventory');
  const prefix = args.includes('--title-prefix') ? option('--title-prefix') : '';
  const candidates = [...shell.threads, ...shell.archivedThreads, ...archived.threads].filter(thread => thread.title.includes(prefix));
  if (!candidates.length) throw Error('No thread matches the requested title prefix');
  for (const [index, thread] of candidates.entries()) {
    await read('orchestration.subscribeThread', { threadId: thread.id, requestCompletionMarker: true }, `synthetic-thread-${index + 1}-full`);
    await read('orchestration.subscribeThread', { threadId: thread.id, requestCompletionMarker: true, acceptBoundedSnapshot: true }, `synthetic-thread-${index + 1}-bounded`);
  }
  writeFileSync(output, JSON.stringify({ observedAt: new Date().toISOString(), serverVersion: config.environment.serverVersion,
    frameLimitBytes: 16 * 1024 * 1024, mutations: 0, measurements }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ mutations: 0, measurements }));
} finally {
  if (pending) clearTimeout(pending.timer);
  socket?.close();
}
