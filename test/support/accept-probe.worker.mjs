/**
 * Worker body for the host-run accept-isolation fixture (test-only). See
 * `test/support/accept-probe.ts` for the contract.
 *
 * It does two things on its own event loop, so the test's runtime thread can be
 * blocked without stopping the probe or the held client:
 *
 * 1. real connects at a fixed cadence, each recorded with its own outcome and
 *    error code on this context's monotonic clock;
 * 2. one held client that connects at a configured instant, writes a single
 *    NDJSON request, and records when (and whether) its reply arrives.
 *
 * Nothing is invented: a connect that has not completed is not sampled, and a
 * reply that never arrives stays `null`.
 */
import { connect } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const socketPath = String(workerData?.socketPath ?? "");
const probeMs = Math.max(1, Number(workerData?.probeMs ?? 4));
const holdAfterMs = Math.max(0, Number(workerData?.holdAfterMs ?? 100));
const request = String(workerData?.request ?? "");
if (!socketPath || !parentPort) throw new Error("accept probe worker requires a socket path");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const samples = [];
let sent = 0;
let running = true;
const startedAt = performance.now();
let holdStarted = false;
let held = { connectedAt: null, wroteAt: null, replyAt: null, line: null, error: null };
let buffer = "";
parentPort.postMessage({ type: "ready", wallOffset: Date.now() - performance.now() });

parentPort.on("message", message => {
  if (message.type === "flush") {
    parentPort.postMessage({ type: "samples", from: sent, samples: samples.slice(sent) });
    sent = samples.length;
    return;
  }
  if (message.type === "stop") running = false;
});

const connectOnce = path => new Promise(resolve => {
  const socket = connect(path);
  socket.once("connect", () => { socket.destroy(); resolve({ ok: true }); });
  socket.once("error", error => { socket.destroy(); resolve({ ok: false, code: error.code }); });
});

function startHeldClient() {
  holdStarted = true;
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  socket.once("connect", () => {
    held.connectedAt = performance.now();
    socket.write(request, error => { if (!error) held.wroteAt = performance.now(); });
  });
  socket.on("data", chunk => {
    buffer += chunk;
    const index = buffer.indexOf("\n");
    if (index < 0) return;
    held.replyAt = performance.now();
    held.line = buffer.slice(0, index);
    socket.destroy();
  });
  socket.once("error", error => { held.error = error.code || error.message; });
  // The connect either completes (recorded above) or fails (recorded here); a
  // pending attempt stays unobserved, like the probe's own samples.
}

(async () => {
  while (running) {
    if (!holdStarted && performance.now() - startedAt >= holdAfterMs) startHeldClient();
    const result = await connectOnce(socketPath);
    samples.push({ at: performance.now(), ...result });
    await sleep(probeMs);
  }
  parentPort.postMessage({ type: "samples", from: sent, samples: samples.slice(sent) });
  sent = samples.length;
  parentPort.postMessage({ type: "held", held });
  parentPort.postMessage({ type: "stopped" });
  parentPort.close();
})();
