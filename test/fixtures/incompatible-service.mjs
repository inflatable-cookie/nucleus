#!/usr/bin/env node
// Fixture: a protocol-compatible service that advertises an incompatible
// build identity. Answers auth, health and drain like the real service.
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { unlinkSync, rmSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const dataDir = process.env.PASEO_HOME ? join(process.env.PASEO_HOME, 'northstar-queue') : '';
const socketPath = join(dataDir, 'queue-service.sock');
const credential = randomBytes(32).toString('hex');
const frames = [];

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

const server = createServer(socket => {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const frame = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      frames.push(frame);
      if (frame.method === 'service.auth') {
        socket.write(encodeFrame({ v: 1, id: frame.id, result: { ok: true, buildId: 'incompatible-build', protocolVersion: 1, pid: process.pid } }));
      } else if (frame.method === 'service.health') {
        socket.write(encodeFrame({ v: 1, id: frame.id, result: { service: 'northstar-queue', protocolVersion: 1, buildId: 'incompatible-build', pid: process.pid, startedAt: new Date().toISOString(), ready: true, paused: true } }));
      } else if (frame.method === 'service.drain') {
        socket.write(encodeFrame({ v: 1, id: frame.id, result: { ok: true, draining: true } }));
        setImmediate(() => {
          server.close();
          rmSync(socketPath, { force: true });
          rmSync(join(dataDir, 'queue-service.json'), { force: true });
          process.exit(0);
        });
      } else {
        socket.write(encodeFrame({ v: 1, id: frame.id, error: { code: 'method_unknown', message: 'fixture' } }));
      }
    }
  });
  socket.on('error', () => {});
});

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (existsSync(socketPath)) rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  const info = { protocolVersion: 1, buildId: 'incompatible-build', socketPath, credential, pid: process.pid, startedAt: new Date().toISOString() };
  const temp = `${join(dataDir, 'queue-service.json')}.tmp`;
  writeFileSync(temp, JSON.stringify(info), { mode: 0o600 });
  renameSync(temp, join(dataDir, 'queue-service.json'));
  console.log('incompatible fixture service ready');
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
