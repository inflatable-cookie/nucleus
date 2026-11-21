/**
 * Host environment at the boundary (nucleus#1483): the shared roll options, the
 * spawner, the host-independent roll owner and the generic standalone entry carry
 * no host-specific names. The host integration supplies the environment a spawned
 * service reads through one composition owner, so a T3Code-only or hostless
 * install rolls exactly as before and a Paseo fixture still points its service at
 * a private Paseo home.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hostEnvironment, hostHome } from "../service/host-environment.mjs";
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import { RollOwner } from "../service/roll/owner";
import { ServiceBridge } from "../hosts/paseo/plugin/bridge";
import { ServiceSpawner } from "../shared/service/roll/spawn";
import { hostEnvironmentNames } from "../scripts/check-host-environment.mjs";
import { importEdges } from "../scripts/check-folder-imports.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

function scratchRoot(prefix: string): string {
  const scratch = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (!scratch) throw new Error("the run scratch volume is required");
  return realpathSync(mkdtempSync(join(realpathSync(scratch), prefix)));
}

/** A fake child that never becomes ready: the spawn is what this file proves. */
function captureSpawn(env: Array<NodeJS.ProcessEnv>) {
  return ((
    _command: string,
    _args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => {
    env.push(options.env);
    return {
      pid: 9_999_991,
      on() {
        return this;
      },
      unref() {},
    } as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
}

function dataDirWithNoService(prefix: string): string {
  const dataDir = join(scratchRoot(prefix), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
}

test("the composition owner maps a private host home into the host's own environment", () => {
  const home = join(scratchRoot("host-env-"), "host-home");
  // The generic composition names the host's own variable; nothing above it does.
  assert.deepEqual(hostEnvironment(home), { PASEO_HOME: home });
  assert.deepEqual(bridgeProcessActions.hostEnvironment(home), {
    PASEO_HOME: home,
  });
  // With no override, the composition owner resolves the host's own default home.
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    assert.equal(hostHome(), home);
    assert.deepEqual(hostEnvironment(), { PASEO_HOME: home });
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  }
});

test("a hostless or T3Code-only roll owner passes the composed host environment to its service", async () => {
  const dataDir = dataDirWithNoService("owner-env-");
  const hostHomeFixture = join(scratchRoot("owner-host-"), "host");
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = hostHomeFixture;
  const spawnedEnvironments: Array<NodeJS.ProcessEnv> = [];
  const processActions = {
    ...bridgeProcessActions,
    spawn: captureSpawn(spawnedEnvironments),
  };
  const owner = new RollOwner({
    dataDir,
    processActions,
    serviceCommand: () => ({ command: process.execPath, args: ["-e", ""] }),
    readinessBudgetMs: 1,
    readinessPollMs: 1,
  });
  try {
    // No host-specific option: the owner is the T3Code launcher's or the entry's,
    // and the composition still supplies the host home the service must read.
    await assert.rejects(owner.spawner.spawnService("fixture"));
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    owner.close();
  }
  assert.equal(spawnedEnvironments.length, 1);
  assert.equal(spawnedEnvironments[0]!.PASEO_HOME, hostHomeFixture);
});

test("a fixture host home pins the spawned service's environment for a roll owner and the Paseo bridge", async () => {
  const dataDir = dataDirWithNoService("pinned-env-");
  const pinned = join(scratchRoot("pinned-host-"), "pinned");
  const spawnedEnvironments: Array<NodeJS.ProcessEnv> = [];
  const processActions = {
    ...bridgeProcessActions,
    spawn: captureSpawn(spawnedEnvironments),
  };
  const owner = new RollOwner({
    dataDir,
    hostHome: pinned,
    processActions,
    serviceCommand: () => ({ command: process.execPath, args: ["-e", ""] }),
    readinessBudgetMs: 1,
    readinessPollMs: 1,
  });
  const bridge = new ServiceBridge({
    dataDir: join(scratchRoot("pinned-bridge-"), "data"),
    hostHome: pinned,
    processActions,
    serviceCommand: () => ({ command: process.execPath, args: ["-e", ""] }),
    readinessBudgetMs: 1,
    readinessPollMs: 1,
  });
  try {
    await assert.rejects(owner.spawner.spawnService("fixture"));
    const bridgeSpawner = (bridge as unknown as { spawner: ServiceSpawner })
      .spawner;
    await assert.rejects(bridgeSpawner.spawnService("fixture"));
  } finally {
    owner.close();
    bridge.close();
  }
  assert.equal(spawnedEnvironments.length, 2);
  assert.equal(spawnedEnvironments[0]!.PASEO_HOME, pinned);
  assert.equal(spawnedEnvironments[1]!.PASEO_HOME, pinned);
});

test("the shared roll, the roll owner and the generic entries name no host environment or host module", () => {
  const neutral = [
    "shared/service/roll/options.ts",
    "shared/service/roll/spawn.ts",
    "service/roll/owner.ts",
    "service/standalone.ts",
    "service/executor/executor.ts",
    "service/runtime-owner.ts",
    "service/install/main-channel.mjs",
    "service/install/install.mjs",
  ];
  for (const path of neutral) {
    assert.deepEqual(
      hostEnvironmentNames(path, read(path)),
      [],
      `${path} must not name a host environment variable`,
    );
  }
  // The copy of the environment lives in one composition owner; nothing in the
  // shared roll or the host-independent owner imports a host integration.
  for (const path of [
    "shared/service/roll/options.ts",
    "shared/service/roll/spawn.ts",
    "service/roll/owner.ts",
  ]) {
    assert.deepEqual(
      importEdges(path, read(path)).filter((specifier) =>
        specifier.includes("hosts/"),
      ),
      [],
      `${path} imports no host integration`,
    );
  }
});

test("the installer's isolated startup proof reads a private host home", async () => {
  const { MainChannel } = await import("../service/install/main-channel.mjs");
  const workRoot = join(scratchRoot("proof-env-"), "work");
  const previousScratch = process.env.NUCLEUS_SCRATCH_ROOT;
  const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
  delete process.env.NUCLEUS_SCRATCH_ROOT;
  process.env.NUCLEUS_WORK_ROOT = workRoot;
  const channel = new MainChannel({
    scratch: join(workRoot, "scratch"),
  });
  let proved: NodeJS.ProcessEnv | null = null;
  channel.command = async () => "";
  channel.startService = async (_node, args, _root, env) => {
    const dataDir = args
      .find((arg) => arg.startsWith("--data-dir="))!
      .slice("--data-dir=".length);
    assert.equal(
      env.PASEO_HOME,
      join(dirname(dataDir), "p"),
      "the proof points the host integration at a private home",
    );
    proved = env;
  };
  try {
    await channel.proveStartup({ root: "/fixture/package" });
  } finally {
    if (previousScratch === undefined) delete process.env.NUCLEUS_SCRATCH_ROOT;
    else process.env.NUCLEUS_SCRATCH_ROOT = previousScratch;
    if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
    else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  }
  assert.ok(proved, "the staged proof started its private service");
});
