/**
 * The T3Code cold-start daemon launch (nucleus#1394): a probe of the registered
 * `nucleus-acp` launcher starts one daemon for a configured local T3 host, and
 * nothing else. Every spawn is a fake; the private proof covers the real process.
 */
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDaemonForT3, isLoopbackEndpoint, T3_LAUNCH_CLAIM_FILE } from "../service/t3code-launch";
import { writeT3Connection } from "../shared/t3/settings";

function scratchDataDir(): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(root, "the run scratch volume is required");
  const dataDir = mkdtempSync(join(realpathSync(root), "t3-launch-"));
  mkdirSync(join(dataDir, "userdata"), { recursive: true });
  return dataDir;
}

const LOCAL = { endpoint: "http://127.0.0.1:3773", bearer: "synthetic-bearer" };

function fakeSpawn(pid = 4242) {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawnProcess = (command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    return { pid, unref() {}, on() { return this; } } as unknown as ChildProcess;
  };
  return { calls, spawnProcess };
}

const alive = (pid: number) => pid === 4242 || pid === process.pid;
const dead = () => false;

function writeInfo(dataDir: string, pid: number) {
  writeFileSync(join(dataDir, "queue-service.json"), JSON.stringify({
    protocolVersion: 1,
    buildId: "synthetic-build-id",
    socketPath: join(dataDir, "queue-service.sock"),
    credential: "a".repeat(64),
    pid,
    startedAt: new Date().toISOString(),
  }));
}

function writeRoll(dataDir: string, status: string) {
  writeFileSync(join(dataDir, "queue-service-roll.json"), JSON.stringify({
    status, fromBuild: "a", toBuild: "b", digest: "c", at: new Date().toISOString(), detail: "synthetic", deferrals: [],
  }));
}

test("a daemon starts only for a stored, loopback T3Code connection", () => {
  const dataDir = scratchDataDir();
  const { calls, spawnProcess } = fakeSpawn();
  const options = { dataDir, root: process.cwd(), spawnProcess, pidAlive: alive };
  assert.equal(ensureDaemonForT3(options).status, "no-t3-host");
  writeT3Connection(dataDir, { ...LOCAL, endpoint: "https://t3.example.invalid" });
  assert.equal(ensureDaemonForT3(options).status, "no-t3-host");
  assert.equal(calls.length, 0);
  assert.equal(isLoopbackEndpoint("ws://localhost:3773/ws"), true);
  assert.equal(isLoopbackEndpoint("http://[::1]:3773"), true);
  assert.equal(isLoopbackEndpoint("not a url"), false);
});

test("a cold local start spawns one detached daemon for this data home and does not wait for it", () => {
  const dataDir = scratchDataDir();
  writeT3Connection(dataDir, LOCAL);
  const { calls, spawnProcess } = fakeSpawn();
  const launch = ensureDaemonForT3({ dataDir, root: process.cwd(), spawnProcess, pidAlive: alive });
  assert.deepEqual(launch, { status: "started", pid: 4242 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.detached, true);
  assert.ok(calls[0]!.args.includes(`--data-dir=${dataDir}`));
  assert.ok(calls[0]!.args.some((arg) => arg.endsWith("queue-service.mjs")));
  const claim = JSON.parse(readFileSync(join(dataDir, T3_LAUNCH_CLAIM_FILE), "utf8"));
  assert.equal(claim.pid, 4242, "the claim names the daemon while it boots");
});

test("repeated and concurrent probes converge on the one daemon", () => {
  const dataDir = scratchDataDir();
  writeT3Connection(dataDir, LOCAL);
  const { calls, spawnProcess } = fakeSpawn();
  const options = { dataDir, root: process.cwd(), spawnProcess, pidAlive: alive };
  const first = ensureDaemonForT3(options);
  // A second probe during the daemon's boot finds the fresh claim of a live process.
  const second = ensureDaemonForT3(options);
  const third = ensureDaemonForT3(options);
  assert.equal(first.status, "started");
  assert.equal(second.status, "claimed");
  assert.equal(third.status, "claimed");
  assert.equal(calls.length, 1, "exactly one spawn for three probes");
  // Once the daemon answers with its identity, the probe reports it running.
  writeInfo(dataDir, 4242);
  assert.deepEqual(ensureDaemonForT3(options), { status: "running", pid: 4242 });
  assert.equal(calls.length, 1);
});

test("a live daemon, a rolling service and a fresh Paseo bridge claim each start nothing", () => {
  const dataDir = scratchDataDir();
  writeT3Connection(dataDir, LOCAL);
  const { calls, spawnProcess } = fakeSpawn();
  const options = { dataDir, root: process.cwd(), spawnProcess, pidAlive: alive };
  writeInfo(dataDir, 4242);
  assert.deepEqual(ensureDaemonForT3(options), { status: "running", pid: 4242 });

  const rolling = scratchDataDir();
  writeT3Connection(rolling, LOCAL);
  writeRoll(rolling, "replacing");
  assert.deepEqual(ensureDaemonForT3({ ...options, dataDir: rolling }), { status: "rolling", roll: "replacing" });

  const bridging = scratchDataDir();
  writeT3Connection(bridging, LOCAL);
  writeFileSync(join(bridging, "queue-service.claim.json"), JSON.stringify({ pid: 4242, at: new Date().toISOString() }));
  assert.equal(ensureDaemonForT3({ ...options, dataDir: bridging }).status, "claimed");
  assert.equal(calls.length, 0);
});

test("a stale claim from a dead process is reclaimed once and a failed spawn leaves no claim", () => {
  const dataDir = scratchDataDir();
  writeT3Connection(dataDir, LOCAL);
  writeFileSync(join(dataDir, T3_LAUNCH_CLAIM_FILE), JSON.stringify({ pid: 999_999, at: new Date(0).toISOString() }));
  const { calls, spawnProcess } = fakeSpawn();
  assert.equal(ensureDaemonForT3({ dataDir, root: process.cwd(), spawnProcess, pidAlive: dead }).status, "started");
  assert.equal(calls.length, 1);

  const failing = scratchDataDir();
  writeT3Connection(failing, LOCAL);
  assert.throws(() => ensureDaemonForT3({
    dataDir: failing,
    root: process.cwd(),
    pidAlive: alive,
    spawnProcess: () => { throw new Error("spawn refused"); },
  }), /spawn refused/);
  assert.equal(existsSync(join(failing, T3_LAUNCH_CLAIM_FILE)), false, "the next probe may try again");
});
