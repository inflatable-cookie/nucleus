/**
 * The T3-only main-channel roll (nucleus#1454), end to end in a private fixture:
 * a T3 cold start runs the real launcher, which starts the daemon and the roll
 * owner; a new main commit rolls while the service serves; a restart in the
 * settle window is resumed by a fresh owner; a Paseo bridge joins the same owner;
 * and a failing build leaves the running service serving.
 *
 * Serial wall-clock oracle: it runs in `npm run test:timing`, alone, like the
 * other roll acceptance files. Every repository, install and service is a fixture
 * under this run's scratch; no real checkout, install base or data home is touched.
 */
import { timingTest } from "./support/timing";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { install, installBase } from "../service/install/install.mjs";
import { configureChannel } from "../service/install/main-channel.mjs";
import { ROLL_OWNER_FILE } from "../service/roll/owner";
import { ServiceBridge } from "../hosts/paseo/plugin/bridge";
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import { readServiceInfo, readServiceRoll } from "../service/transport/identity";
import { ServiceClient } from "../shared/service/client";
import { writeT3Connection } from "../shared/t3/settings";
import { scratchFixtureParent } from "./support/scratch-fixture";
import { installFixtureBbCli } from "./support/bb-cli-fixture";

const exec = promisify(execFile);

async function waitUntil<T>(label: string, read: () => T | null | undefined | false, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ownerPid(dataDir: string): number | null {
  try { return JSON.parse(readFileSync(join(dataDir, ROLL_OWNER_FILE), "utf8")).pid ?? null; } catch { return null; }
}

/** The running service answers its own health: the build it names is the one it serves. */
async function serviceHealth(dataDir: string): Promise<Record<string, unknown>> {
  const info = readServiceInfo(dataDir);
  assert.ok(info, "a service identity file names the running service");
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  try {
    await client.connect();
    return await client.request("service.health", {}) as Record<string, unknown>;
  } finally { await client.close(); }
}

timingTest("timing: a T3-only cold start owns the main roll, a restart resumes it, Paseo joins the same owner, and a failed build keeps the service", { timeout: 600_000 }, async t => {
  const root = await mkdtemp(join(scratchFixtureParent(), "t3roll-"));
  const home = join(root, "home"), dataDir = join(root, "nucleus-data"), paseoHome = join(root, "paseo");
  const previous = { HOME: process.env.HOME, NUCLEUS_DATA_HOME: process.env.NUCLEUS_DATA_HOME, PASEO_HOME: process.env.PASEO_HOME };
  process.env.HOME = home;
  process.env.NUCLEUS_DATA_HOME = dataDir;
  process.env.PASEO_HOME = paseoHome;
  await mkdir(home, { recursive: true });
  installFixtureBbCli(home);
  await mkdir(paseoHome, { recursive: true });
  const spawned: ChildProcess[] = [];
  t.after(async () => {
    // Stop only what this test started: the launcher's detached daemon and owner, by pid.
    const pids = [readServiceInfo(dataDir)?.pid, ownerPid(dataDir)].filter((pid): pid is number => Boolean(pid) && alive(pid));
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    await waitUntil("the fixture service and owner to stop", () => pids.every(pid => !alive(pid)) || null, 30_000).catch(() => {});
    for (const child of spawned) child.kill("SIGTERM");
    Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  });

  // A private source repository with the package built and installed as the initial main version.
  const source = join(root, "repository");
  await mkdir(source);
  const run = (command: string, args: string[], cwd = source) => exec(command, args, { cwd, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  const archive = join(root, "source.tar");
  await run("git", ["archive", "HEAD", "-o", archive], process.cwd());
  await run("/usr/bin/tar", ["-xf", archive, "-C", source]);
  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.name", "Fixture"]);
  await run("git", ["config", "user.email", "fixture@example.invalid"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "initial"]);
  await run("npm", ["ci", "--no-audit", "--no-fund"]);
  const pkg = join(root, "initial-package");
  await run(process.execPath, ["scripts/build-runtime.mjs", pkg]);
  const tarball = join(root, "initial.tgz");
  await run("/usr/bin/tar", ["--format=ustar", "-czf", tarball, "-C", pkg, "."]);
  await install(tarball);
  const current = join(installBase(), "current");
  const initialRoot = await realpath(current);
  const initialBuild = JSON.parse(await readFile(join(initialRoot, "build.json"), "utf8")).buildId as string;
  await configureChannel("main", source);
  // A loopback T3 connection (no server behind it): the daemon starts for it and nothing else is touched.
  writeT3Connection(dataDir, { endpoint: "http://127.0.0.1:9", bearer: "synthetic-bearer" });

  // 1. T3-only cold start: the launcher runs the way T3 runs it, starting the daemon and the owner.
  const launch = () => {
    const child = spawn(join(current, "runtime", "node"), [join(current, "bin", "nucleus-acp.mjs")], {
      cwd: current, env: { ...process.env, TMPDIR: root }, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin!.end();
    child.stderr!.on("data", () => {});
    spawned.push(child);
    return child;
  };
  launch();
  await waitUntil("the daemon and the owner to start", () => readServiceInfo(dataDir) && ownerPid(dataDir), 90_000);
  const firstOwner = ownerPid(dataDir)!;
  const firstService = readServiceInfo(dataDir)!;
  assert.equal(firstService.buildId, initialBuild, "the cold start serves the installed build");
  assert.equal((await serviceHealth(dataDir)).buildId, initialBuild);

  // 2. A new local main commit while the runtime serves: the owner settles, builds and rolls.
  await writeFile(join(source, "shared/main-marker.mjs"), "export const marker = 2;\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "merged change"]);
  // The owner records typechecking while it builds, then deferred while the settle window runs; a slow build skips deferred.
  const inRollout = await waitUntil("the owner to start the roll", () => { const roll = readServiceRoll(dataDir); return roll && ["typechecking", "deferred"].includes(roll.status) ? roll : null; }, 420_000);
  assert.equal(inRollout.fromBuild, initialBuild);

  // 3. Paseo joins during the same roll: its bridge starts the same owner, never a second one.
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, dataDir, paseoHome, sourcePath: current, rollOwnerLaunch: true, rollCheckMs: 0, serviceCommand: () => { throw new Error("the bridge must not spawn in this proof"); } });
  try {
    bridge.watch();
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal(ownerPid(dataDir), firstOwner, "a joining bridge reports the existing owner and starts none");
  } finally { bridge.close(); }

  // 4. A restart during the rollout: the owner dies while the roll is in flight, and a fresh T3 start resumes it.
  process.kill(firstOwner, "SIGKILL");
  await waitUntil("the killed owner to stop", () => !alive(firstOwner) || null, 15_000);
  launch();
  const resumedOwner = await waitUntil("a fresh owner after the restart", () => { const pid = ownerPid(dataDir); return pid && pid !== firstOwner && alive(pid) ? pid : null; }, 60_000);
  assert.notEqual(resumedOwner, firstOwner);

  // 5. The new build is activated once, answers by health, and the old service is replaced.
  const rolled = await waitUntil("the resumed owner to land the roll", () => { const roll = readServiceRoll(dataDir); return roll?.status === "rolled" && roll.toBuild !== initialBuild ? roll : null; }, 600_000);
  const health = await serviceHealth(dataDir);
  assert.equal(health.buildId, rolled.toBuild, "the new build answers by health");
  assert.notEqual(readServiceInfo(dataDir)!.pid, firstService.pid, "the service was replaced");
  assert.notEqual(await realpath(current), initialRoot, "current points at the activated version");
  const lanes = await (async () => {
    const info = readServiceInfo(dataDir)!;
    const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
    try { await client.connect(); return await client.request("lanes", {}); } finally { await client.close(); }
  })();
  assert.ok(Array.isArray(lanes), "dispatch and reads continue on the replacement");

  // 6. A failing build keeps the running service serving and records why.
  const servingPid = readServiceInfo(dataDir)!.pid;
  const script = join(source, "scripts/build-runtime.mjs");
  await writeFile(script, "throw Error('fixture build failure');\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "broken build"]);
  const failed = await waitUntil("the failed build to be recorded", () => { const roll = readServiceRoll(dataDir); return roll?.status === "failed" && /fixture build failure/.test(roll.detail) ? roll : null; }, 600_000);
  assert.match(failed.detail, /fixture build failure/);
  assert.equal(readServiceInfo(dataDir)!.pid, servingPid, "the failed build leaves the running service serving");
  assert.equal((await serviceHealth(dataDir)).buildId, rolled.toBuild);
});
