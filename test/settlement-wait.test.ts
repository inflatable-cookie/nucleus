import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceClient } from '../shared/service/client';
import { createFrameReader, encodeFrame, PROTOCOL_VERSION } from '../shared/service/protocol';
import { PersistenceExecutor } from '../service/executor/executor';

for (const [method, input] of [['lead.submit', {}], ['project.qa.run', { wait: true }]] as const) {
  test(`${method} settlement survives client deadlines and still rejects socket loss`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wait-'));
    const socketPath = join(root, 's');
    const sockets = new Set<import('node:net').Socket>();
    let reply!: () => void;
    const server = createServer(socket => {
      sockets.add(socket);
      const reader = createFrameReader((frame: any) => {
        const respond = () => socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: frame.id, result: { settled: true } }));
        if (frame.method === 'service.auth') respond();
        else reply = respond;
      }, error => { throw error; });
      socket.on('data', chunk => reader.feed(chunk));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const client = new ServiceClient({ socketPath, credential: 'a'.repeat(64) });
    try {
      await client.connect();
      const request = client.request(method, input, 10);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(client.inFlight, 1);
      reply();
      assert.deepEqual(await request, { settled: true });
      const lost = client.request(method, input, 10);
      const rejection = assert.rejects(lost, /socket closed/);
      for (const socket of sockets) socket.destroy();
      await rejection;
      assert.equal(client.inFlight, 0);
    } finally {
      client.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test('executor settlement calls have no call timer while ordinary calls keep their deadline', async () => {
  // Isolate the parent transport: a worker that captures delivery and answers when released.
  const executor = new PersistenceExecutor({ owner: { dataDir: tmpdir() } } as any);
  const internal = executor as any;
  const sent: any[] = [];
  internal.worker = { postMessage: (message: any) => sent.push(message) };
  for (const [method, input, waiting] of [
    ['lead.submit', {}, true], ['project.qa.run', { wait: true }, true],
    ['project.qa.run', {}, false], ['project.qa.get', {}, false],
  ] as const) {
    const request = executor.rpc(method, input);
    const message = sent.at(-1);
    const pending = internal.pending.get(message.id);
    assert.equal(Boolean(pending.timer), !waiting);
    internal.receive({ kind: 'reply', id: message.id, ok: true, result: 'settled' });
    assert.equal(await request, 'settled');
  }
});
