import { observeIdle } from './support/fakes';
/**
 * Warm-standby handoff: a read-only prewarm takes no lease, and the host-run
 * endpoint binds before the first board snapshot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, statSync, unlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { Store } from "../core/store/store";
import { QueueRuntime } from "../service/runtime-owner";
import { QueueService } from "../service/transport/server";
import { waitForPidExit, waitForPidExitSync } from "../service/install/standby";
import { prewarmStore, waitForStandbyHandoff } from "../service/install/standby-handoff";
import { hostRunAuthorityPath, hostRunProcessStartIdentity, hostRunSocketAnswers, hostRunSocketPath, readHostRunAuthority } from "../service/callbacks/host-run-endpoint";
import { submissionSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";

function fakeAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "worker-helper.mjs"),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [],
    observe: observeIdle("ws", "worker"),
  } as unknown as Adapter;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function connectOnce(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

test("prewarmStore is a no-op on a missing path and takes no processOwner lease", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsq-standby-")));
  try {
    const missing = prewarmStore(join(root, "absent.sqlite"));
    missing.tick();
    missing.close();
    const path = join(root, "queue.sqlite");
    const owner = new Store(path);
    owner.setMeta("paused", false);
    const prewarm = prewarmStore(path);
    prewarm.tick();
    owner.setMeta("paused", true);
    assert.equal(owner.getMeta("paused"), true, "the writable owner still writes while a reader is open");
    assert.equal(owner.getMeta("processOwner"), undefined, "prewarm does not take the process lease");
    prewarm.close();
    owner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prewarm never creates an original SQLite shared-memory sidecar", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsq-standby-wal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "queue.sqlite");
  const program = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('schema','48')");
    process.send('ready'); process.stdin.resume(); process.stdin.on('end',()=>{db.close(); process.exit(0)});`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', program, path], { stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', code => reject(new Error(`writer exited early: ${code}`))); });
    unlinkSync(`${path}-shm`);
    const before = readdirSync(root).sort().map(name => ({ name, bytes: readFileSync(join(root, name)), mode: statSync(join(root, name)).mode }));
    const warm = prewarmStore(path); warm.tick(); warm.close();
    const after = readdirSync(root).sort().map(name => ({ name, bytes: readFileSync(join(root, name)), mode: statSync(join(root, name)).mode }));
    assert.deepEqual(after, before);
    assert.equal(existsSync(`${path}-shm`), false);
  } finally {
    child.stdin?.end();
    await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once('exit', () => resolve()));
  }
});

test("waitForStandbyHandoff returns after the old pid exits and leaves the store writable", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsq-standby-wait-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "queue.sqlite");
  const owner = new Store(path);
  owner.setMeta("paused", false);
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  assert.ok(child.pid && child.pid > 0);
  // Reap in this process so pidAlive sees the exit; waitForPidExitSync blocks
  // the event loop and would otherwise leave a zombie whose pid still answers.
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  waitForStandbyHandoff(child.pid, path, 5_000);
  owner.setMeta("paused", true);
  owner.close();
  const next = new Store(path);
  assert.equal(next.getMeta("paused"), true);
  next.close();
});

test("waitForPidExitSync gives up when the pid never exits", () => {
  assert.throws(() => waitForPidExitSync(process.pid, 40), /gave up waiting/);
});

test("waitForPidExit stays cooperative so a copied listen keeps accepting", async t => {
  // A warm standby's swapped host-run socket is owned by the executor worker's
  // event loop. A blocking wait starves that loop while the old service drains,
  // and the live path then refuses clients once the kernel accept queue fills
  // (2026-10-06 milestone QA: a 1.6 s ECONNREFUSED gap on a reported-warm roll).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsb-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copied = join(root, "copied.sock");
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(copied, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let accepted = 0;
  server.on("connection", socket => { accepted += 1; socket.destroy(); });
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  const probe = connectOnce(copied);
  try {
    await assert.rejects(waitForPidExit(process.pid, 150), /gave up waiting/);
  } finally { clearInterval(ticker); }
  assert.equal(await probe, true, "the copied listen accepted while the wait was in flight");
  assert.ok(accepted > 0 && ticks >= 3, `event loop ran during the wait (accepted ${accepted}, ticks ${ticks})`);
});

test("hostRunReady settles once the host-run socket accepts, before the first board snapshot is required", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsb-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const hostRunStateDir = join(root, "host-run");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const runtime = new QueueRuntime({
    dataDir, hostRunEndpoint: true, hostRunStateDir, adapterFactory: () => fakeAdapter(dataDir), timers: false,
  });
  t.after(() => runtime.drain());
  const socketPath = hostRunSocketPath(hostRunStateDir);
  assert.equal(existsSync(socketPath), false, "constructor does not wait for the bind");
  await runtime.hostRunReady;
  assert.equal(await hostRunSocketAnswers(socketPath, 200), true, "the endpoint is bound when hostRunReady settles");
  const board = runtime.uiSnapshot();
  assert.ok("tasks" in board && Array.isArray(board.tasks));
});

test("a QueueService with the host-run endpoint binds it before executor boot finishes", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsb-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "northstar-queue");
  const hostRunStateDir = join(root, "host-run");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(dataDir, "queue.sqlite"));
  const template = store.insert(submissionSchema.parse({
    submissionId: "seed", title: "seed", repoPath: "/repo", planningCommit: "a".repeat(40),
    handoffPath: "seed.md", originAgentId: "origin",
  }), "fixture-host", "handoff", "b".repeat(40));
  const insertTask = store.db.prepare("INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)");
  store.transaction(() => {
    for (let i = 0; i < 80; i++) {
      const id = `seed-${i}`;
      insertTask.run(id, id, id, JSON.stringify({
        ...template, id, submissionId: id, phase: "done",
        reason: "Closed", finishedAt: template.updatedAt,
        completion: { eventId: id, taskId: id, runId: id, status: "closed", summary: "c".repeat(2_000) },
      }));
    }
  });
  store.close();

  const service = new QueueService({
    owner: { dataDir, hostRunEndpoint: true, hostRunStateDir, timers: false },
    fixture: "fake",
  });
  t.after(() => service.stop());
  const socketPath = hostRunSocketPath(hostRunStateDir);
  let firstAccept = 0;
  const started = performance.now();
  const probe = (async () => {
    while (!firstAccept && performance.now() - started < 30_000) {
      if (await connectOnce(socketPath)) firstAccept = performance.now() - started;
      else await sleep(4);
    }
  })();
  await service.start();
  const startedAt = performance.now() - started;
  await probe;
  assert.ok(firstAccept > 0, "the host-run endpoint accepted during start");
  assert.ok(firstAccept < startedAt, `endpoint bound at ${firstAccept.toFixed(0)} ms; executor boot finished at ${startedAt.toFixed(0)} ms`);
});

test("a runtime whose host-run endpoint bind was refused binds it once the holder is gone", async t => {
  // 2026-10-04: a roll that handed the endpoint away and fell back left the process
  // still serving queue-service.sock with no host-run endpoint, and every heavy run
  // on the machine failed closed until an operator restart. The serving runtime must
  // bind as soon as the foreign holder is gone, without a restart.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nsb-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const hostRunStateDir = join(root, "host-run");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(hostRunStateDir, "run"), { recursive: true, mode: 0o700 });
  const socketPath = hostRunSocketPath(hostRunStateDir);

  // A foreign live holder answers the socket; authority.json names a dead pid, as a
  // roll that lost the endpoint leaves behind.
  const holder = createServer();
  await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.listen(socketPath, () => resolve()); });
  chmodSync(socketPath, 0o600);
  t.after(() => { try { holder.close(); } catch { /* already closed */ } });
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>(resolve => dead.once("exit", () => resolve()));
  assert.ok(dead.pid && dead.pid > 0);
  writeFileSync(hostRunAuthorityPath(hostRunStateDir), JSON.stringify({
    format: "host.run.authority", version: 1, holder: "queue", endpoint: socketPath, epoch: 1,
    pid: dead.pid, startIdentity: hostRunProcessStartIdentity(dead.pid),
  }), { mode: 0o600 });

  const runtime = new QueueRuntime({
    dataDir, hostRunEndpoint: true, hostRunStateDir, adapterFactory: () => fakeAdapter(dataDir), timers: false,
  });
  t.after(() => runtime.drain());
  await runtime.hostRunReady;
  assert.equal(runtime.health().hostRunEndpoint?.serving, false, "the refused bind reports itself unhealthy");
  assert.match(runtime.health().hostRunEndpoint?.error ?? "", /live holder/);

  // The foreign holder exits: the same process binds the socket and republishes
  // authority instead of leaving the machine without a scheduler.
  await new Promise<void>(resolve => holder.close(() => resolve()));
  await runtime.ensureHostRunEndpoint();
  assert.equal(runtime.health().hostRunEndpoint?.serving, true, "the endpoint is bound without a restart");
  assert.equal(runtime.health().hostRunEndpoint?.error, "");
  assert.equal(await hostRunSocketAnswers(socketPath, 500), true);
  assert.equal(readHostRunAuthority(hostRunStateDir)!.pid, process.pid, "authority.json names the serving process");
});
