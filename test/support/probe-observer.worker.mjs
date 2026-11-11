/**
 * Worker body for the roll oracle's real-socket probe (test-only). See
 * roll-oracle-observer.ts for the contract: real connects at the fixed cadence,
 * samples recorded on this context's own monotonic clock, one wall-to-monotonic
 * offset published at startup, incremental flushes in message order, and a
 * cooperative stop. The probe never invents a sample: only completed connects
 * are recorded, and a pending connect at stop stays unobserved.
 */
import { connect } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const socketPath = String(workerData?.socketPath ?? "");
if (!socketPath || !parentPort) throw new Error("probe observer worker requires a socket path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connectOnce = (path) => new Promise((resolve) => {
  const socket = connect(path);
  socket.once("connect", () => { socket.destroy(); resolve({ ok: true }); });
  socket.once("error", (error) => { socket.destroy(); resolve({ ok: false, code: error.code }); });
});

const samples = [];
let sent = 0;
let running = true;

// Clock handshake first: the main context maps this wall-to-monotonic offset
// onto its own, so sample times are monotonic and comparable across contexts.
parentPort.postMessage({ type: "ready", wallOffset: Date.now() - performance.now() });

parentPort.on("message", (message) => {
  if (message.type === "flush") {
    parentPort.postMessage({ type: "samples", from: sent, samples: samples.slice(sent) });
    sent = samples.length;
    return;
  }
  if (message.type === "stop") running = false;
});

(async () => {
  while (running) {
    const result = await connectOnce(socketPath);
    samples.push({ at: performance.now(), ...result });
    await sleep(4);
  }
  // Deliver everything observed, then close so the worker exits on its own.
  parentPort.postMessage({ type: "samples", from: sent, samples: samples.slice(sent) });
  sent = samples.length;
  parentPort.postMessage({ type: "stopped" });
  parentPort.close();
})();
