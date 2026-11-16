import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FRAME_BYTES as PLUGIN_MAX_FRAME_BYTES,
  PROTOCOL_VERSION as PLUGIN_PROTOCOL_VERSION,
  asServiceRequest,
  createFrameReader as createPluginFrameReader,
  encodeFrame as encodePluginFrame,
} from "../hosts/bb/plugin/protocol";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  createFrameReader,
  encodeFrame,
} from "../shared/service/protocol";
import { HOST_OPERATIONS as SHARED_OPERATIONS } from "../shared/host-operation";
import { HOST_OPERATIONS as PLUGIN_OPERATIONS, workspaceHandleForPath as pluginHandle } from "../hosts/bb/plugin/operations";
import { hostIdFromDataDir, workspaceHandleForPath } from "../shared/host-operation";

/**
 * The plugin package is installed from its own directory, so it carries a pinned
 * copy of the socket codec instead of importing `shared/service/protocol.ts`. These
 * tests are the pin: a drift in either implementation fails here instead of
 * corrupting a live service socket.
 */
test("the plugin codec encodes and frames exactly like the shared owner", () => {
  assert.equal(PLUGIN_PROTOCOL_VERSION, PROTOCOL_VERSION);
  assert.equal(PLUGIN_MAX_FRAME_BYTES, MAX_FRAME_BYTES);
  const frames = [
    { v: PROTOCOL_VERSION, id: "a", method: "service.auth", input: { credential: "0".repeat(64) } },
    { v: PROTOCOL_VERSION, id: "b", method: "host.op", input: { op: "identity.probe", input: {} } },
    { v: PROTOCOL_VERSION, id: "c", result: { ok: true } },
    { v: PROTOCOL_VERSION, id: "d", error: { code: "refused", message: "no" } },
    { v: PROTOCOL_VERSION, id: "unicode", result: { text: "héllo — ✓" } },
  ];
  for (const frame of frames) assert.deepEqual(encodePluginFrame(frame), encodeFrame(frame));
});

test("the plugin frame reader accepts the same stream and refuses the same faults", () => {
  const accept = (factory: typeof createFrameReader | typeof createPluginFrameReader, chunks: Buffer[]) => {
    const frames: unknown[] = [];
    const faults: string[] = [];
    const reader = factory(frame => frames.push(frame), error => faults.push(error.code));
    for (const chunk of chunks) reader.feed(chunk);
    return { frames, faults };
  };
  const stream = Buffer.concat([encodeFrame({ v: 1, id: "one", method: "service.auth", input: {} }), encodeFrame({ v: 1, id: "two", method: "host.op", input: {} })]);
  const split = [stream.subarray(0, 3), stream.subarray(3, 11), stream.subarray(11)];
  assert.deepEqual(accept(createFrameReader, split), accept(createPluginFrameReader, split));

  const oversize = Buffer.alloc(4);
  oversize.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.deepEqual(accept(createFrameReader, [oversize]), accept(createPluginFrameReader, [oversize]));
  assert.deepEqual(accept(createFrameReader, [oversize]).faults, ["oversize"]);

  const malformed = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
  assert.deepEqual(accept(createFrameReader, [malformed]).faults, accept(createPluginFrameReader, [malformed]).faults);

  assert.throws(
    () => encodePluginFrame({ blob: "x".repeat(MAX_FRAME_BYTES + 1) }),
    (error: unknown) => (error as { name?: string; code?: string }).name === "ProtocolError" && (error as { code?: string }).code === "oversize",
  );
});

test("the plugin narrows a frame to a request only when it is one", () => {
  assert.deepEqual(asServiceRequest({ v: PROTOCOL_VERSION, id: "x", method: "host.op", input: { op: "call.counters" } }), {
    v: PROTOCOL_VERSION, id: "x", method: "host.op", input: { op: "call.counters" },
  });
  assert.equal(asServiceRequest({ v: 2, id: "x", method: "host.op" }), null);
  assert.equal(asServiceRequest({ v: PROTOCOL_VERSION, id: "", method: "host.op" }), null);
  assert.equal(asServiceRequest({ v: PROTOCOL_VERSION, id: "x" }), null);
  assert.equal(asServiceRequest(null), null);
});

test("the plugin executes exactly the operations the service can send it", () => {
  assert.deepEqual([...PLUGIN_OPERATIONS], [...SHARED_OPERATIONS]);
});

test("the plugin derives the workspace handle and host identity exactly as the service does", () => {
  for (const path of ["/tmp/example-worktree", "/tmp/example-worktree/", "/does/not/exist"]) {
    assert.equal(pluginHandle(path), workspaceHandleForPath(path));
  }
  assert.match(hostIdFromDataDir("/tmp/example-data"), /^bb:[a-f0-9]{32}$/);
  assert.equal(hostIdFromDataDir("/tmp/example-data/"), hostIdFromDataDir("/tmp/example-data"));
  assert.notEqual(hostIdFromDataDir("/tmp/example-data"), hostIdFromDataDir("/tmp/other-data"));
});
