import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION, MAX_FRAME_BYTES, ProtocolError,
  buildIdentity, createFrameReader, encodeFrame, parseRequest,
} from '../shared/service/protocol';
import { RPC_METHOD_NAMES } from '../shared/rpc-catalogue';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_BUILD, currentServiceBuildId, sourcePathFromModule, serviceBuildIdentity } from '../shared/service/build';

test('frames round-trip exactly and stay inside the bounded length prefix', () => {
  const value = { v: PROTOCOL_VERSION, id: 'frame-1', method: 'queue.ui-snapshot', input: { nested: ['payload', { deep: true }] } };
  const frame = encodeFrame(value);
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  let received: unknown[] = [];
  const reader = createFrameReader(frameItem => received.push(frameItem), () => assert.fail('reader failed a well-formed frame'));
  // Feed in small chunks to prove incremental reassembly.
  for (const byte of frame) reader.feed(Buffer.from([byte]));
  assert.deepEqual(received, [value]);
});

test('oversized frames fail closed and stop the stream', () => {
  let failures = 0;
  const reader = createFrameReader(() => assert.fail('no frame should be emitted'), error => { failures++; assert.equal(error.code, 'oversize'); }, 64);
  reader.feed(Buffer.from([0, 0, 0, 65]));
  reader.feed(Buffer.alloc(64, 0x61));
  assert.equal(failures, 1);
  // The failed reader must refuse further frames.
  let extra = 0;
  const second = createFrameReader(() => { extra++; }, () => {});
  second.feed(encodeFrame({ ok: true }));
  assert.equal(extra, 1);
  assert.ok(reader.failed);
});

test('encodeFrame refuses to produce a frame beyond the protocol bound', () => {
  assert.throws(() => encodeFrame({ blob: 'x'.repeat(MAX_FRAME_BYTES) }), (error: unknown) => error instanceof ProtocolError && error.code === 'oversize');
});

test('request envelopes carry version, bounded id, method and input; bad ones fail closed', () => {
  const good = parseRequest({ v: PROTOCOL_VERSION, id: 'req-1', method: 'queue.control', input: { paused: true } });
  assert.ok(good.ok && good.request.id === 'req-1');
  for (const [frame, code] of [
    [{ v: PROTOCOL_VERSION + 1, id: 'req-2', method: 'm' }, 'protocol_version'],
    [{ v: PROTOCOL_VERSION, id: '', method: 'm' }, 'invalid_input'],
    [{ v: PROTOCOL_VERSION, id: 'x'.repeat(200), method: 'm' }, 'invalid_input'],
    [{ v: PROTOCOL_VERSION, id: 'req-3', method: 'Bad method' }, 'invalid_input'],
    [null, 'invalid_input'],
  ] as [unknown, string][]) {
    const parsed = parseRequest(frame);
    assert.ok(!parsed.ok);
    assert.equal(parsed.error.code, code);
  }
});

test('request envelopes name the transport surface only as the one known value', () => {
  // The Settings-only capacity rule reads this provenance; absent is a direct
  // local client, `paseo` is the plugin bridge, and nothing else is guessed at.
  const direct = parseRequest({ v: PROTOCOL_VERSION, id: 'req-surface-1', method: 'queue.capacity', input: { globalLimit: 20, projectLimit: 4 } });
  assert.ok(direct.ok);
  assert.equal(direct.request.via, undefined, 'a direct client carries no surface');
  const bridged = parseRequest({ v: PROTOCOL_VERSION, id: 'req-surface-2', method: 'queue.capacity', input: {}, via: 'paseo' });
  assert.ok(bridged.ok);
  assert.equal(bridged.request.via, 'paseo');
  for (const via of ['settings', 'paseo ', '', null, 1, true, { via: 'paseo' }]) {
    const parsed = parseRequest({ v: PROTOCOL_VERSION, id: 'req-surface-3', method: 'queue.capacity', input: {}, via });
    assert.equal(parsed.ok, false, `via ${JSON.stringify(via)} must fail closed`);
    if (!parsed.ok) assert.equal(parsed.error.code, 'invalid_input');
  }
});

test('service build identity covers the exact served method set', () => {
  const identity = buildIdentity('1', RPC_METHOD_NAMES, 'source');
  const reordered = buildIdentity('1', [...RPC_METHOD_NAMES].reverse(), 'source');
  const changed = buildIdentity('2', RPC_METHOD_NAMES, 'source');
  assert.equal(identity, reordered, 'method order must not change the build identity');
  assert.notEqual(identity, changed, 'a generation bump must force a different build');
  assert.notEqual(identity, buildIdentity('1', RPC_METHOD_NAMES, 'changed'), 'backend bytes must move the identity');
  assert.match(identity, /^[a-f0-9]{16}$/);
});

test('backend content determines the build while docs, roadmaps and client files do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-build-'));
  try {
    for (const dir of ['core', 'service', 'shared', 'hosts', 'bin', 'docs/roadmaps', 'client']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'core', 'worker.ts'), 'initial');
    writeFileSync(join(root, 'shared', 'contracts.ts'), 'contracts');
    writeFileSync(join(root, 'bin', 'queue-service.mjs'), 'entry');
    const original = serviceBuildIdentity(root);
    assert.equal(serviceBuildIdentity(root), original, 'the unchanged tree remains stable');
    for (const path of ['docs/readme.md', 'docs/roadmaps/plan.md', 'client/screen.tsx']) {
      writeFileSync(join(root, path), 'edited');
      assert.equal(serviceBuildIdentity(root), original, `${path} must not restart the service`);
    }
    for (const path of ['core/worker.ts', 'shared/contracts.ts', 'bin/queue-service.mjs']) {
      const file = join(root, path);
      writeFileSync(file, `changed ${path}`);
      assert.notEqual(serviceBuildIdentity(root), original, `${path} must change the build`);
      writeFileSync(file, path === 'core/worker.ts' ? 'initial' : path === 'shared/contracts.ts' ? 'contracts' : 'entry');
    }
    assert.notEqual(serviceBuildIdentity(root, String(Number(SERVICE_BUILD) + 1)), original, 'the manual generation override still works');
    rmSync(join(root, 'shared'), { recursive: true });
    assert.throws(() => serviceBuildIdentity(root), /Cannot read backend source set/, 'a missing backend set must fail closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(currentServiceBuildId(), serviceBuildIdentity(sourcePathFromModule()), 'the published service identity uses the installed source');
});
