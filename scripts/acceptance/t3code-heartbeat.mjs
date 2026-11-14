/** Read-only Nightly wire proof: authenticate, read config, exchange Ping/Pong. */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--settings') || !args.includes('--output')) throw Error('Pass --settings and --output');
const scratch = realpathSync(process.env.TMPDIR);
const output = resolve(option('--output'));
if (!realpathSync(resolve(output, '..')).startsWith(scratch + sep)) throw Error('Output must be in a fresh fixture directory under TMPDIR');
const { t3code } = JSON.parse(readFileSync(option('--settings'), 'utf8'));
if (!t3code?.endpoint || !t3code.bearer) throw Error('T3 settings are required');
const base = new URL(t3code.endpoint);
base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:';
const frames = [];
let socket;
const deadline = setTimeout(() => { socket?.close(); process.exitCode = 1; console.error('Nightly heartbeat proof exceeded 60 seconds'); }, 60_000);
try {
  const response = await fetch(new URL('/api/auth/websocket-ticket/rpc', base), {
    method: 'POST', headers: { Authorization: `Bearer ${t3code.bearer}` }, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw Error(`Ticket exchange HTTP ${response.status}`);
  const { ticket } = await response.json();
  const url = new URL('/ws', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('wsTicket', ticket);
  url.searchParams.set('orchestrationProtocol', '2');
  const environment = await new Promise((resolveProof, reject) => {
    socket = new WebSocket(url);
    let version;
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      _tag: 'Request', id: 'synthetic-read', tag: 'server.getConfig', payload: {}, headers: [],
    })));
    socket.addEventListener('message', event => {
      try {
        const decoded = JSON.parse(event.data);
        for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
          if (frame._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue; }
          if (frame._tag === 'Exit' && frame.requestId === 'synthetic-read') {
            if (frame.exit?._tag !== 'Success') throw Error('Nightly config read failed');
            const observed = frame.exit.value.environment;
            version = { environmentId: 'synthetic-environment', serverVersion: observed.serverVersion,
              orchestrationProtocolVersion: observed.orchestrationProtocolVersion };
            const ping = { _tag: 'Ping' };
            frames.push({ direction: 'sent', frame: ping });
            socket.send(JSON.stringify(ping));
          } else if (frame._tag === 'Pong' && version) {
            frames.push({ direction: 'received', frame: { _tag: 'Pong' } });
            resolveProof(version);
          }
        }
      } catch { reject(Error('Nightly returned an unexpected wire shape')); }
    });
    socket.addEventListener('error', () => reject(Error('Nightly socket error')));
    socket.addEventListener('close', () => reject(Error('Nightly socket closed before proof completed')));
    deadline.refresh();
  });
  writeFileSync(output, JSON.stringify({ environment, frames, mutations: 0 }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, serverVersion: environment.serverVersion, frames: frames.length, mutations: 0 }));
} finally {
  clearTimeout(deadline);
  socket?.close();
}
