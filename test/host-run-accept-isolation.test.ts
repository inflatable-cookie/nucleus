import { tmpdir } from "node:os";
/**
 * Accepts do not depend on the runtime's event loop (Spec 035, "Accepts off the
 * runtime loop").
 *
 * Milestone b1ced28b at ac1fe3f1 lost real in-window `ECONNREFUSED` spells of
 * 146 ms and 109 ms during rolls 2 and 5, and the Supervisor's isolated backlog
 * reproduction measured the same shape outside rolls: 230-330 ms of runtime work
 * followed by 495-884 ms inside one synchronous `validateWSOutboundMessage` call.
 * A `net.Server` whose connection handler lives on the blocked thread cannot
 * accept during that time, so the kernel queue fills (macOS `somaxconn` 128) and
 * further connects are refused.
 *
 * The regression below blocks the runtime's own thread for two seconds with its
 * event loop deliberately stalled (`Atomics.wait`, a deterministic fixture seam —
 * not CPU load and not a changed oracle) while a probe on another thread connects
 * every ~4 ms. The front worker accepts those clients and pipes them to the
 * runtime's private socket, so nothing is refused and the held request is served
 * once the stall ends.
 *
 */
import { timingTest } from "./support/timing";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HostRunEndpoint } from "../service/callbacks/host-run-endpoint";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { Store } from "../core/store/store";
import { startAcceptProbe, type AcceptProbe, type ProbeSample } from "./support/accept-probe";

/** The stall from the Supervisor's reproduction: one long synchronous call. */
const STALL_MS = 2_000;
/** The probe cadence the roll oracle and the Supervisor's reproduction already use. */
const PROBE_MS = 4;
const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const now = () => performance.now();

/**
 * Stall this thread's event loop for `ms`. `Atomics.wait` is a real synchronous
 * block: no timer, socket or promise callback on this thread runs until it
 * returns, which is exactly the shape one large validation call has.
 */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface Fixture {
  endpoint: HostRunEndpoint;
  stateDir: string;
}

async function fixture(t: { after(fn: () => void | Promise<void>): void }): Promise<Fixture> {
  // A short root keeps the contract and private socket paths under macOS's
  // 104-byte unix socket limit.
  const stateDir = mkdtempSync(join(tmpdir(), "hra-"));
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const endpoint = new HostRunEndpoint(scheduler, {
    stateDir, supervisorSpawn: () => { /* no run is submitted here */ },
  });
  t.after(async () => { await endpoint.stop(); store.close(); rmSync(stateDir, { recursive: true, force: true }); });
  await endpoint.start();
  return { endpoint, stateDir };
}

function refusals(samples: ProbeSample[]): ProbeSample[] {
  return samples.filter(sample => !sample.ok);
}

function describe(samples: ProbeSample[]): string {
  const refused = refusals(samples);
  if (refused.length === 0) return "no refused samples";
  const codes = [...new Set(refused.map(sample => sample.code ?? "unknown"))].join(",");
  return `${refused.length} refused samples (${codes})`;
}

timingTest("a 2 s runtime stall accepts every client instead of refusing it", { timeout: 120_000 }, async t => {
  const { endpoint } = await fixture(t);
  // The held client connects 250 ms into the stall and writes its request at
  // once, so its reply can only arrive after the stall ends.
  const probe = await startAcceptProbe(endpoint.socketPath, { probeMs: PROBE_MS, holdAfterMs: 250 });
  t.after(async () => { await probe.stop(); });
  // Let the probe establish its cadence first.
  await sleep(120);

  const stallFrom = now();
  blockEventLoop(STALL_MS);
  const stallTo = now();
  assert.ok(stallTo - stallFrom >= STALL_MS - 50, `the stall lasted ${(stallTo - stallFrom).toFixed(0)} ms`);

  // The held client's request must be answered once the loop runs again.
  const deadline = Date.now() + 10_000;
  while (probe.held().replyAt === null && Date.now() < deadline) await sleep(25);
  await sleep(150);
  await probe.stop();

  const during = probe.samples.filter(sample => sample.at >= stallFrom && sample.at <= stallTo);
  assert.ok(during.length >= STALL_MS / PROBE_MS / 2, `the probe covered the stall with ${during.length} samples`);
  assert.equal(refusals(probe.samples).length, 0, `the stalled runtime refused clients: ${describe(probe.samples)}`);
  assert.equal(during.filter(sample => sample.ok).length, during.length, "every connect during the stall was accepted");
  assert.ok(during.some(sample => sample.ok), "clients were accepted while the runtime loop was blocked");

  const held = probe.held();
  assert.equal(held.error, null, `the held client failed: ${held.error}`);
  assert.ok(held.connectedAt !== null && held.connectedAt >= stallFrom && held.connectedAt <= stallTo,
    `the held client connected at ${held.connectedAt?.toFixed(0)} ms, not inside the stall`);
  assert.ok(held.replyAt !== null, "the held client was never served after the stall");
  assert.ok(held.replyAt >= stallTo - 50,
    `the reply arrived at ${held.replyAt?.toFixed(0)} ms, before the ${stallTo.toFixed(0)} ms stall end`);
  const reply = JSON.parse(held.line ?? "{}") as { ok?: boolean; body?: { budget?: { cpuCapacity?: number } } };
  assert.equal(reply.ok, true, `the held request was answered through the runtime: ${held.line}`);
  assert.equal(reply.body?.budget?.cpuCapacity, 4, "status answered the host summary through the private socket");
  t.diagnostic(`front: ${during.length}/${during.length} connects accepted inside the ${(stallTo - stallFrom).toFixed(0)} ms stall, ${refusals(probe.samples).length} refusals in the probe's lifetime, held reply ${((held.replyAt ?? 0) - stallTo).toFixed(0)} ms after the stall`);
});
