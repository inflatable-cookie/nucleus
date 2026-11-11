/**
 * The host-run front worker boundary (Spec 035, "Accepts off the runtime
 * loop"): the public contract-010 socket is owned by a small worker thread that
 * pipes accepted clients to this runtime's private inner socket. The endpoint
 * still authenticates every request, publishes authority, journals evidence and
 * decides health; the front only accepts, holds and copies bytes.
 *
 * What these tests pin, beyond the end-to-end behaviour the endpoint suite
 * already exercises through this boundary:
 *
 * - a client accepted before the runtime's private socket exists is held, never
 *   refused, and served once the runtime is up;
 * - the private connection is retried while the runtime is not listening, and a
 *   client whose private connection never answers is closed at a bound and
 *   reported instead of held forever;
 * - stopping the endpoint settles the worker and removes both sockets, and a
 *   dead process's private socket is cleared while a live owner's is kept;
 * - a refused bind (live holder, failed chain check) is reported and never
 *   answered for;
 * - a roll's incoming front owns the live path while the outgoing front's
 *   existing clients keep flowing, and neither owner removes the other's socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRunEndpoint, hostRunAuthorityPath, hostRunSocketAnswers, hostRunSocketPath } from "../service/callbacks/host-run-endpoint";
import { HostRunFront } from "../service/executor/host-run-front";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { Store } from "../core/store/store";
import { HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS } from "./support/budgets";

const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(20);
}

interface Wire { socket: Socket; send(value: unknown): void; next(timeoutMs?: number): Promise<Record<string, any>>; close(): void }

function wire(socketPath: string): Wire {
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<{ resolve(line: string): void; reject(error: Error): void; timer: NodeJS.Timeout }> = [];
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); } else queued.push(line);
    }
  });
  socket.on("error", error => { for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } });
  return {
    socket,
    send(value: unknown) { socket.write(`${JSON.stringify(value)}\n`); },
    next(timeoutMs = HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS): Promise<Record<string, any>> {
      const take = (line: string) => JSON.parse(line) as Record<string, any>;
      if (queued.length) return Promise.resolve(take(queued.shift()!));
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (line: string) => resolve(take(line)),
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("timed out waiting for a response line"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close() { socket.destroy(); },
  };
}

const status = (id = "probe") => ({ v: 1, id, method: "status", epoch: 1, body: {} });

interface Fixture {
  stateDir: string;
  socketPath: string;
  scheduler: HostRunScheduler;
  store: Store;
  endpoint: HostRunEndpoint | null;
  front: HostRunFront | null;
}

function fixture(t: { after(fn: () => void | Promise<void>): void }): Fixture {
  // A short root keeps both socket paths under macOS's 104-byte unix limit.
  const stateDir = mkdtempSync(join(tmpdir(), "f-"));
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const f: Fixture = { stateDir, socketPath: hostRunSocketPath(stateDir), scheduler, store, endpoint: null, front: null };
  t.after(async () => {
    try { await f.endpoint?.stop(); } catch { /* already stopped */ }
    try { await f.front?.stop(); } catch { /* already stopped */ }
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return f;
}

async function startEndpoint(f: Fixture, front: HostRunFront): Promise<HostRunEndpoint> {
  const endpoint = new HostRunEndpoint(f.scheduler, { stateDir: f.stateDir, front, supervisorSpawn: () => { /* no run is submitted */ } });
  f.endpoint = endpoint;
  await endpoint.start();
  return endpoint;
}

test("a client accepted before the runtime's private socket exists is held, then served", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  f.front = await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath, innerRetryMs: 20 });
  // No runtime yet: nothing is listening on the private socket the front pipes to.
  assert.equal(existsSync(f.front.innerSocketPath()), false, "the runtime's private socket does not exist yet");
  const client = wire(f.socketPath);
  t.after(() => client.close());
  client.send(status("held-before-runtime"));
  await sleep(300);
  assert.equal(f.front.state().held > 0, true, "the front holds the client while the runtime is absent");

  await startEndpoint(f, f.front);
  const reply = await client.next();
  assert.equal(reply.ok, true, `the held client was served once the runtime was up: ${JSON.stringify(reply)}`);
  assert.equal(reply.body.budget.cpuCapacity, 4, "the request was answered by the runtime, not by the front");
});

test("requests over the front are authenticated and framed by the runtime, not the front", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  f.endpoint = await startEndpoint(f, await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath }));

  const stale = wire(f.socketPath);
  t.after(() => stale.close());
  stale.send({ v: 1, id: "stale", method: "status", epoch: 99, body: {} });
  const refused = await stale.next();
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "stale_epoch", "the runtime still refuses a stale epoch through the private socket");

  // Contract 010's 1 MiB request-line bound still applies: the front copies
  // bytes and adds no protocol meaning of its own.
  const oversized = wire(f.socketPath);
  t.after(() => oversized.close());
  oversized.socket.write("x".repeat(1024 * 1024 + 16));
  const failure = await oversized.next();
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "invalid");
  assert.match(failure.error.message, /1 MiB/);
});

test("a client the private socket never answers is closed at the bound and reported", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  f.front = await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath, innerRetryMs: 10, innerWaitMs: 150 });
  const client = wire(f.socketPath);
  let closed = false;
  client.socket.once("close", () => { closed = true; });
  client.send(status("never-answered"));
  await waitFor(() => closed, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(closed, true, "a client whose private connection never answers is closed, not held forever");
  await waitFor(() => f.front!.state().abandoned === 1, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(f.front.state().abandoned, 1, "the front reports the client it gave up on");
});

test("stopping the endpoint settles the front worker and removes both sockets", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  const front = await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath });
  const endpoint = await startEndpoint(f, front);
  const innerPath = front.innerSocketPath();
  assert.ok(existsSync(innerPath), "the runtime's private socket is bound while it serves");
  assert.equal(await hostRunSocketAnswers(f.socketPath, 500), true);
  assert.equal(endpoint.serving(), true);

  await endpoint.stop();
  await waitFor(() => front.dead(), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS);
  assert.equal(front.dead(), true, "the front worker thread exited");
  assert.equal(existsSync(f.socketPath), false, "the contract socket was removed");
  assert.equal(existsSync(innerPath), false, "the private socket was removed");
  assert.deepEqual(readdirSync(join(f.stateDir, "run")), [], "no socket was left behind in the run directory");
});

test("a front bind refused by a live holder is reported and leaves the holder serving", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  f.endpoint = await startEndpoint(f, await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath }));
  await assert.rejects(
    () => HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath }),
    /live holder/,
    "a second front never takes a live holder's contract path",
  );
  const intruder = new HostRunEndpoint(f.scheduler, { stateDir: f.stateDir, supervisorSpawn: () => { /* nothing submits */ } });
  t.after(() => intruder.stop());
  await assert.rejects(() => intruder.start(), /live holder/);
  assert.match(intruder.error() ?? "", /live holder/);
  assert.equal(await hostRunSocketAnswers(f.socketPath, 500), true, "the holder still answers after the refused starts");
  const client = wire(f.socketPath);
  t.after(() => client.close());
  client.send(status("after-refusal"));
  assert.equal((await client.next()).ok, true);
});

test("a bind whose socket fails the chain check is refused and removed", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  await assert.rejects(
    () => HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath, testAfterBindChmod: 0o644 }),
    /verified chain check/,
  );
  assert.equal(existsSync(f.socketPath), false, "the refused socket is removed, not left at the live path");
  assert.equal(existsSync(hostRunAuthorityPath(f.stateDir)), false, "no authority is published for a refused bind");
});

test("a dead process's private socket is cleared while a live owner's is kept", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  const runDir = join(f.stateDir, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(f.stateDir, 0o700);
  chmodSync(runDir, 0o700);

  // A real bound socket is left behind only by a process that died without
  // closing it, so the fixture binds one in a child and kills it. The name carries
  // the child's own pid, which is what tells a later owner the socket is stale.
  const script = `const {createServer}=require("node:net");
    const path=require("node:path").join(${JSON.stringify(runDir)}, "inner-"+process.pid+"-dead1234.sock");
    const server=createServer();
    server.listen(path,()=>process.stdout.write(path+"\\n"));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const stalePath = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the stale-socket fixture did not bind")), 10_000);
    child.stdout!.once("data", chunk => { clearTimeout(timer); resolve(chunk.toString().trim()); });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  assert.equal(lstatSync(stalePath).isSocket(), true, "the dead process left a socket behind");

  // Another process's live private socket must never be removed by this one.
  const livePath = join(runDir, `inner-${process.pid}-feedface.sock`);
  const live = createServer();
  await new Promise<void>((resolve, reject) => { live.once("error", reject); live.listen(livePath, () => resolve()); });
  chmodSync(livePath, 0o600);
  t.after(() => new Promise<void>(resolve => live.close(() => resolve())));

  f.endpoint = await startEndpoint(f, await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath }));
  assert.equal(existsSync(stalePath), false, "the dead process's private socket was cleared");
  assert.equal(existsSync(livePath), true, "a live owner's private socket was kept");
});

test("an incoming front owns the live path while the outgoing front's clients keep flowing", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  const frontA = await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath });
  const outgoing = new HostRunEndpoint(f.scheduler, { stateDir: f.stateDir, front: frontA, supervisorSpawn: () => { /* nothing submits */ } });
  t.after(async () => { try { await outgoing.stop(); } catch { /* already stopped */ } });
  await outgoing.start();
  const inoA = lstatSync(f.socketPath).ino;

  const outgoingClient = wire(f.socketPath);
  t.after(() => outgoingClient.close());
  outgoingClient.send(status("on-outgoing"));
  assert.equal((await outgoingClient.next()).ok, true, "the outgoing front serves a client before the roll");

  // The incoming process binds its staged inode and swaps it onto the live path
  // before its runtime exists; that is the make-before-break handoff.
  const frontB = await HostRunFront.start({ stateDir: f.stateDir, socketPath: f.socketPath, takeLivePath: true });
  f.front = frontB;
  const inoB = lstatSync(f.socketPath).ino;
  assert.notEqual(inoB, inoA, "the incoming front's inode is now the live path");
  assert.equal(await hostRunSocketAnswers(f.socketPath, 500), true, "new connects reach the incoming front");
  const during = wire(f.socketPath);
  t.after(() => during.close());
  during.send(status("during-handoff"));
  await sleep(100);
  assert.equal(frontB.state().held >= 1, true, "the incoming front holds clients until its runtime is up");

  const incoming = await startEndpoint(f, frontB);
  assert.equal((await during.next()).ok, true, "a client held across the handoff is served by the incoming runtime");
  assert.equal(outgoing.serving(), false, "the outgoing endpoint no longer owns the live path");
  assert.equal(incoming.serving(), true);

  // Existing connections stay on the outgoing inode until that process drains.
  outgoingClient.send(status("still-outgoing"));
  assert.equal((await outgoingClient.next()).ok, true, "the outgoing front's existing client keeps being served");

  await outgoing.stop();
  assert.equal(existsSync(f.socketPath), true, "the outgoing stop did not remove the incoming owner's socket");
  assert.equal(lstatSync(f.socketPath).ino, inoB, "the live path still names the incoming front's inode");
  const after = wire(f.socketPath);
  t.after(() => after.close());
  after.send(status("after-outgoing-stop"));
  assert.equal((await after.next()).ok, true, "the incoming runtime serves after the outgoing process stops");
  assert.equal(frontB.state().ino, inoB, "the incoming front still reports the inode it owns");
});
