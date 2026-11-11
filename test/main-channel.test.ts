import test from "node:test";
import { timingTest } from "./support/timing";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { install, installBase } from "../service/install/install.mjs";
import { MainChannel, configureChannel, requestRollback } from "../service/install/main-channel.mjs";
import { serviceNotices } from "../shared/service-roll";
import { bridgeSupport } from "./support/bridge-fixture";

import { scratchFixtureParent } from "./support/scratch-fixture";

const exec = promisify(execFile);
const { trackedBridge } = bridgeSupport("nmc");

test("startup proof derives scratch from workRoot when the developer override is unset", async () => {
  const previous = process.env.NUCLEUS_SCRATCH_ROOT;
  const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
  delete process.env.NUCLEUS_SCRATCH_ROOT;
  process.env.NUCLEUS_WORK_ROOT = join(scratchFixtureParent(), "derived-work");
  const channel = new MainChannel({ scratch: join(process.env.NUCLEUS_WORK_ROOT, "scratch") });
  let launched = false;
  channel.command = async () => "";
  channel.startService = async (_node, _args, _root, env) => { launched = env.TMPDIR === join(process.env.NUCLEUS_WORK_ROOT!, "scratch"); };
  try {
    await channel.proveStartup({ root: "/fixture/package" });
    assert.equal(launched, true);
  } finally {
    if (previous === undefined) delete process.env.NUCLEUS_SCRATCH_ROOT;
    else process.env.NUCLEUS_SCRATCH_ROOT = previous;
    if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
    else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  }
});

timingTest("scratch main build, standby activation, failure notice and rollback", { timeout: 300_000 }, async t => {
  const previousTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const root = await mkdtemp(join(scratchFixtureParent(), "nmc-"));
  assert.ok(root.startsWith(`${scratchFixtureParent()}/`));
  const previousScratchRoot = process.env.NUCLEUS_SCRATCH_ROOT;
  delete process.env.NUCLEUS_SCRATCH_ROOT;
  const previousHome = process.env.HOME;
  const previousPaseo = process.env.PASEO_HOME;
  process.env.HOME = join(root, "home");
  process.env.PASEO_HOME = join(root, "p");
  await mkdir(join(process.env.HOME, ".nucleus"), { recursive: true });
  await writeFile(join(process.env.HOME, ".nucleus", "settings.json"), JSON.stringify({ workRoot: root }));
  t.after(() => {
    if (previousScratchRoot === undefined) delete process.env.NUCLEUS_SCRATCH_ROOT;
    else process.env.NUCLEUS_SCRATCH_ROOT = previousScratchRoot;
    process.env.HOME = previousHome;
    if (previousPaseo === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousPaseo;
    for (const [key, value] of Object.entries(previousTemp)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  await mkdir(process.env.PASEO_HOME, { recursive: true });
  const source = join(root, "repository");
  await mkdir(source);
  const run = (command: string, args: string[], cwd = source) => exec(command, args, { cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  // Export bytes, not a worktree, link or clone of the real checkout.
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
  const initial = await realpath(current);
  await writeFile(join(process.env.PASEO_HOME!, "config.json"), JSON.stringify({ plugins: { nucleus: { path: current } } }));
  const bridge = trackedBridge({ sourcePath: current, paseoHome: process.env.PASEO_HOME, rollSettleMs: 0, rollCheckMs: 0 });
  const before = await bridge.serviceState();
  assert.equal(before.state, "running", before.detail);
  assert.equal(await bridge.checkSource(), null, "an install without a channel stays pinned");
  bridge.close();
  await configureChannel("main", source);
  const rolling = trackedBridge({ sourcePath: current, paseoHome: process.env.PASEO_HOME, rollSettleMs: 60_000, rollCheckMs: 0 });
  await writeFile(join(source, "shared/main-marker.mjs"), "export const marker = 2;\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "merged change"]);
  // Fail the first clone after leaving partial contents, then advance main.
  // The same bridge must recover without a plugin reload or retrying that SHA.
  const commands = MainChannel.prototype as unknown as {
    command(command: string, args: string[], cwd?: string, environment?: NodeJS.ProcessEnv): Promise<string>;
  };
  const originalCommand = commands.command;
  let clones = 0;
  commands.command = async function(command, args, cwd, environment) {
    if (command === "git" && args[0] === "clone" && ++clones === 1) {
      await mkdir(args.at(-1)!, { recursive: true });
      await writeFile(join(args.at(-1)!, "partial"), "incomplete clone");
      throw Error("fixture initial clone failure");
    }
    return originalCommand.call(this, command, args, cwd, environment);
  };
  t.after(() => { commands.command = originalCommand; });
  const cloneFailure = await rolling.checkSource();
  assert.equal(cloneFailure?.status, "failed");
  assert.match(cloneFailure!.detail, /fixture initial clone failure/);
  assert.equal(await realpath(current), initial);
  assert.equal((await rolling.serviceState()).pid, before.pid);
  assert.equal(await rolling.checkSource(), null, "the failed clone revision is suppressed");
  assert.equal(clones, 1);
  await writeFile(join(source, "shared/main-marker.mjs"), "export const marker = 3;\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "advance after clone failure"]);
  const started = Date.now();
  const electronHelper = join(root, "electron-helper");
  await writeFile(electronHelper, "#!/bin/sh\necho 'Electron helper cannot run standalone' >&2\nexit 1\n");
  await chmod(electronHelper, 0o755);
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  let building;
  try {
    Object.defineProperty(process, "execPath", { ...execPath, value: electronHelper });
    building = await rolling.checkSource();
  } finally { Object.defineProperty(process, "execPath", execPath); }
  commands.command = originalCommand;
  assert.equal(clones, 2, "a new revision gets a fresh clone in the same bridge");
  const buildAndStageMs = Date.now() - started;
  let roll = building;
  if (building?.status === "deferred") {
    assert.equal(await realpath(current), initial, "a build inside the settle window leaves the current install active");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(building!.deferrals.at(-1)!.until!) + 50 - Date.now())));
    roll = await rolling.checkSource();
  } else {
    assert.equal(building?.status, "rolled", building?.detail);
    assert.ok(buildAndStageMs >= 60_000, "a build that outlasts the settle window can roll immediately");
  }
  assert.equal(roll?.status, "rolled", roll?.detail);
  const elapsed = Date.now() - started;
  const active = await realpath(current);
  assert.notEqual(active, initial);
  const after = await rolling.serviceState();
  assert.equal(after.buildId, roll?.toBuild);
  assert.notEqual(after.pid, before.pid);
  assert.equal(rolling.standbyReadiness()?.warm, true);
  const receipt = JSON.parse(await readFile(join(active, "build.json"), "utf8"));
  assert.equal(receipt.revision, (await run("git", ["rev-parse", "HEAD"])).stdout.trim());
  console.log(JSON.stringify({ mainMergeToLiveMs: elapsed, buildAndStageMs, packageBuildMs: receipt.buildMs, packageBytes: receipt.bytes, settleMs: 60_000 }));
  // A valid runtime whose plugin throws must never reach activation.
  const entry = await readFile(join(source, "index.server.ts"), "utf8");
  await writeFile(join(source, "index.server.ts"), entry + "\nthrow Error('fixture plugin load failure');\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "broken plugin"]);
  const pluginFailure = await rolling.checkSource();
  assert.equal(pluginFailure?.status, "failed", pluginFailure?.detail);
  assert.match(pluginFailure!.detail, /fixture plugin load failure/);
  assert.equal(await realpath(current), active);
  assert.equal((await rolling.serviceState()).pid, after.pid);
  await writeFile(join(source, "index.server.ts"), entry);
  await writeFile(join(source, "scripts/build-runtime.mjs"), "throw Error('fixture build failure');\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "broken build"]);
  const failed = await rolling.checkSource();
  assert.equal(failed?.status, "failed");
  assert.match(failed!.detail, /fixture build failure/);
  assert.equal(await realpath(current), active);
  assert.equal((await rolling.serviceState()).pid, after.pid);
  assert.match(serviceNotices({ ...after, roll: failed })[0].text, /kept its running service/);
  assert.equal(await rolling.checkSource(), null, "failed main is suppressed");
  await requestRollback();
  const rollback = await rolling.checkSource(true);
  assert.equal(rollback?.status, "rolled", rollback?.detail);
  assert.equal(await realpath(current), initial);
  assert.equal((await rolling.serviceState()).buildId, before.buildId);
  // The bad main remains suppressed rather than undoing rollback.
  assert.equal(await rolling.checkSource(), null);
  rolling.close();

});


test("main build refuses hosts without a working standalone Node", async () => {
  const channel = new MainChannel({});
  const attempted: string[] = [];
  channel.command = async (command: string) => { attempted.push(command); throw Error("not standalone Node"); };
  await assert.rejects(channel.buildNode(), /requires a working standalone Node runtime/);
  assert.ok(attempted[0].endsWith("current/runtime/node"));
  assert.ok(attempted.includes(process.execPath));
});

test("staged runtime and service startup failures are build failures", async t => {
  const previousScratchRoot = process.env.NUCLEUS_SCRATCH_ROOT;
  process.env.NUCLEUS_SCRATCH_ROOT = scratchFixtureParent();
  t.after(() => {
    if (previousScratchRoot === undefined) delete process.env.NUCLEUS_SCRATCH_ROOT;
    else process.env.NUCLEUS_SCRATCH_ROOT = previousScratchRoot;
  });
  const channel = new MainChannel({ scratch: scratchFixtureParent() });
  channel.command = async () => { throw Error("runtime failed --version"); };
  await assert.rejects(channel.proveStartup({ root: "/fixture/package" }), /runtime failed --version/);
  const commands: string[][] = [];
  channel.command = async (_command: string, args: string[]) => {
    commands.push(args);
    return "v22.0.0";
  };
  channel.startService = async (_node: string, args: string[]) => {
    assert.equal(args[0], "bin/queue-service.mjs");
    assert.match(args[1], /--data-dir=.*\/s-[^/]+\/q$/);
    throw Error("service failed to load");
  };
  await assert.rejects(channel.proveStartup({ root: "/fixture/package" }), /service failed to load/);
  assert.deepEqual(commands, [["--version"]]);
});
