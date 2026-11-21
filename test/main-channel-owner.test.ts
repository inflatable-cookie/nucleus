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
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { briefDigest } from "../core/planning/brief";
import { install, installBase } from "../service/install/install.mjs";
import { configureChannel } from "../service/install/main-channel.mjs";
import { ROLL_OWNER_FILE } from "../service/roll/owner";
import { ServiceBridge } from "../hosts/paseo/plugin/bridge";
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import {
  readServiceInfo,
  readServiceRoll,
} from "../service/transport/identity";
import { ServiceClient } from "../shared/service/client";
import { readT3Connection, writeT3Connection } from "../shared/t3/settings";
import { scratchFixtureParent } from "./support/scratch-fixture";
import { installFixtureBbCli } from "./support/bb-cli-fixture";
import { t3Fake } from "./support/t3code-fake";

const exec = promisify(execFile);

async function waitUntil<T>(
  label: string,
  read: () =>
    | T
    | null
    | undefined
    | false
    | Promise<T | null | undefined | false>,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerPid(dataDir: string): number | null {
  try {
    return (
      JSON.parse(readFileSync(join(dataDir, ROLL_OWNER_FILE), "utf8")).pid ??
      null
    );
  } catch {
    return null;
  }
}

/** Issue one authenticated RPC against the running fixture service. */
async function serviceRequest<T>(
  dataDir: string,
  method: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const info = readServiceInfo(dataDir);
  assert.ok(info, "a service identity file names the running service");
  const client = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  try {
    await client.connect();
    return (await client.request(method, input)) as T;
  } finally {
    await client.close();
  }
}

/** The running service answers its own health: the build it names is the one it serves. */
function serviceHealth(dataDir: string): Promise<Record<string, unknown>> {
  return serviceRequest<Record<string, unknown>>(dataDir, "service.health");
}

timingTest(
  "timing: a T3-only cold start owns the main roll, a restart resumes it, Paseo joins the same owner, and a failed build keeps the service",
  { timeout: 600_000 },
  async (t) => {
    const root = await mkdtemp(join(scratchFixtureParent(), "t3roll-"));
    const home = join(root, "home"),
      dataDir = join(root, "nucleus-data"),
      paseoHome = join(root, "paseo");
    const previous = {
      HOME: process.env.HOME,
      NUCLEUS_DATA_HOME: process.env.NUCLEUS_DATA_HOME,
      PASEO_HOME: process.env.PASEO_HOME,
    };
    process.env.HOME = home;
    process.env.NUCLEUS_DATA_HOME = dataDir;
    process.env.PASEO_HOME = paseoHome;
    await mkdir(home, { recursive: true });
    installFixtureBbCli(home);
    await mkdir(paseoHome, { recursive: true });
    const spawned: ChildProcess[] = [];
    t.after(async () => {
      // Stop only what this test started: the launcher's detached daemon and owner, by pid.
      const pids = [readServiceInfo(dataDir)?.pid, ownerPid(dataDir)].filter(
        (pid): pid is number => Boolean(pid) && alive(pid),
      );
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      await waitUntil(
        "the fixture service and owner to stop",
        () => pids.every((pid) => !alive(pid)) || null,
        30_000,
      ).catch(() => {});
      for (const child of spawned) child.kill("SIGTERM");
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    });

    // A private source repository with the package built and installed as the initial main version.
    const source = join(root, "repository");
    await mkdir(source);
    const run = (command: string, args: string[], cwd = source) =>
      exec(command, args, {
        cwd,
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      });
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
    await run("/usr/bin/tar", [
      "--format=ustar",
      "-czf",
      tarball,
      "-C",
      pkg,
      ".",
    ]);
    await install(tarball);
    const current = join(installBase(), "current");
    const initialRoot = await realpath(current);
    const initialBuild = JSON.parse(
      await readFile(join(initialRoot, "build.json"), "utf8"),
    ).buildId as string;
    await configureChannel("main", source);
    // A tiny private fixture repository with an origin remote for task submission,
    // and a private loopback T3Code server so the daemon connects, reconciles, and
    // proves unchanged credentials across replacement.
    const taskOrigin = join(root, "task-origin.git");
    const taskRepo = join(root, "task-repo");
    await run("git", ["init", "--bare", taskOrigin], root);
    await run("git", ["clone", taskOrigin, taskRepo], root);
    await run("git", ["checkout", "-b", "main"], taskRepo);
    await run("git", ["config", "user.name", "Fixture"], taskRepo);
    await run(
      "git",
      ["config", "user.email", "fixture@example.invalid"],
      taskRepo,
    );
    await writeFile(join(taskRepo, "README.md"), "Synthetic task fixture\n");
    await run("git", ["add", "."], taskRepo);
    await run("git", ["commit", "-m", "initial task fixture"], taskRepo);
    await run("git", ["push", "origin", "main"], taskRepo);
    const taskPlanningCommit = (
      await run("git", ["rev-parse", "HEAD"], taskRepo)
    ).stdout.trim();
    const fakeT3 = await t3Fake(t, taskRepo);
    writeT3Connection(dataDir, {
      endpoint: fakeT3.endpoint,
      bearer: "synthetic-bearer",
      probeThreadId: "synthetic-probe",
    });

    // 1. T3-only cold start: the launcher runs the way T3 runs it, starting the daemon and the owner.
    const launch = () => {
      const child = spawn(
        join(current, "runtime", "node"),
        [join(current, "bin", "nucleus-acp.mjs")],
        {
          cwd: current,
          env: { ...process.env, TMPDIR: root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin!.end();
      child.stderr!.on("data", () => {});
      spawned.push(child);
      return child;
    };
    launch();
    await waitUntil(
      "the daemon and the owner to start",
      () => readServiceInfo(dataDir) && ownerPid(dataDir),
      90_000,
    );
    const firstOwner = ownerPid(dataDir)!;
    const firstService = readServiceInfo(dataDir)!;
    assert.equal(
      firstService.buildId,
      initialBuild,
      "the cold start serves the installed build",
    );
    assert.equal((await serviceHealth(dataDir)).buildId, initialBuild);

    // Record baseline install, credential, attribution and pause state before the roll.
    const versionsDir = join(installBase(), "versions");
    const initialVersions = (await readdir(versionsDir)).filter(
      (name) => !name.startsWith("."),
    );
    assert.equal(
      initialVersions.length,
      1,
      "only the initial version is installed before the roll",
    );
    const initialT3 = readT3Connection(dataDir);
    assert.deepEqual(initialT3, {
      endpoint: fakeT3.endpoint,
      bearer: "synthetic-bearer",
      probeThreadId: "synthetic-probe",
    });
    const initialSettingsMode =
      statSync(join(dataDir, "settings.json")).mode & 0o777;
    const initialChannel = JSON.parse(
      await readFile(join(installBase(), "channel.json"), "utf8"),
    );
    // Persist pause state and a real queued task before replacement so we prove
    // store state survives the roll and dispatch/reconciliation continue after it.
    await serviceRequest(dataDir, "queue.control", { paused: true });
    const fixtureBrief =
      "## Outcome\n\nSynthetic roll-acceptance fixture task.\n";
    const submittedReply = await serviceRequest<{
      id?: string;
      phase?: string;
      operation?: { id: string; state: string; diagnostic?: string | null };
    }>(dataDir, "queue.submit", {
      submissionId: "roll-acceptance-pre-roll",
      title: "Pre-roll synthetic task",
      repoPath: taskRepo,
      planningCommit: taskPlanningCommit,
      complexity: "low",
      brief: {
        text: fixtureBrief,
        mediaType: "text/markdown",
        digest: briefDigest(fixtureBrief),
      },
      originAgentId: "origin",
      baseBranch: "main",
    });
    const submittedTaskId =
      submittedReply.id ??
      (await waitUntil(
        `pre-roll task to be durably persisted (reply=${JSON.stringify(submittedReply)})`,
        async () => {
          const page = await serviceRequest<{
            tasks: Array<{ id: string; title: string }>;
          }>(dataDir, "queue.queued-page", { repoPath: taskRepo });
          return page.tasks.find(
            (task) => task.title === "Pre-roll synthetic task",
          )?.id;
        },
        15_000,
      ));
    assert.ok(submittedTaskId, "pre-roll task is durably accepted");
    assert.equal(
      (await serviceHealth(dataDir)).taskIdentities,
      1,
      "store records the submitted task before the roll",
    );
    const boardBeforeRoll = await waitUntil(
      "board projection to reflect paused state before the roll",
      async () => {
        const board = await serviceRequest<{
          paused: boolean;
          dispatchHeld: boolean;
        }>(dataDir, "queue.ui-snapshot");
        return board.paused ? board : null;
      },
      15_000,
    );
    assert.equal(
      boardBeforeRoll.paused,
      true,
      "pause state is persisted before the roll",
    );

    // 2. A new local main commit while the runtime serves: the owner settles, builds and rolls.
    await writeFile(
      join(source, "shared/main-marker.mjs"),
      "export const marker = 2;\n",
    );
    await run("git", ["add", "."]);
    await run("git", ["commit", "-m", "merged change"]);
    const mergedRevision = (
      await run("git", ["rev-parse", "HEAD"])
    ).stdout.trim();
    // The owner records typechecking while it builds, then deferred while the settle window runs; a slow build skips deferred.
    const inRollout = await waitUntil(
      "the owner to start the roll",
      () => {
        const roll = readServiceRoll(dataDir);
        return roll && ["typechecking", "deferred"].includes(roll.status)
          ? roll
          : null;
      },
      420_000,
    );
    assert.equal(inRollout.fromBuild, initialBuild);

    // 3. Paseo joins during the same roll: its bridge starts the same owner, never a second one.
    const bridge = new ServiceBridge({
      processActions: bridgeProcessActions,
      dataDir,
      paseoHome,
      sourcePath: current,
      rollOwnerLaunch: true,
      rollCheckMs: 0,
      serviceCommand: () => {
        throw new Error("the bridge must not spawn in this proof");
      },
    });
    try {
      bridge.watch();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(
        ownerPid(dataDir),
        firstOwner,
        "a joining bridge reports the existing owner and starts none",
      );
    } finally {
      bridge.close();
    }

    // 4. A restart during the rollout: the owner dies while the roll is in flight, and a fresh T3 start resumes it.
    process.kill(firstOwner, "SIGKILL");
    await waitUntil(
      "the killed owner to stop",
      () => !alive(firstOwner) || null,
      15_000,
    );
    launch();
    const resumedOwner = await waitUntil(
      "a fresh owner after the restart",
      () => {
        const pid = ownerPid(dataDir);
        return pid && pid !== firstOwner && alive(pid) ? pid : null;
      },
      60_000,
    );
    assert.notEqual(resumedOwner, firstOwner);

    // 5. The new build is activated once, answers by health, and dispatch/reconciliation continue.
    const rolled = await waitUntil(
      "the resumed owner to land the roll",
      () => {
        const roll = readServiceRoll(dataDir);
        return roll?.status === "rolled" && roll.toBuild !== initialBuild
          ? roll
          : null;
      },
      600_000,
    );
    const rolledRoot = await realpath(current);
    assert.notEqual(
      rolledRoot,
      initialRoot,
      "current points at the activated version",
    );
    assert.equal(
      await realpath(join(installBase(), "previous")),
      initialRoot,
      "previous points at the replaced version",
    );
    assert.equal(
      existsSync(join(installBase(), "activation.json")),
      false,
      "activation converged with no pending marker",
    );
    const versionsAfterRoll = (await readdir(versionsDir)).filter(
      (name) => !name.startsWith("."),
    );
    assert.equal(
      versionsAfterRoll.length,
      2,
      "exactly one new version was activated",
    );
    const rolledBuildJson = JSON.parse(
      await readFile(join(rolledRoot, "build.json"), "utf8"),
    ) as { buildId: string; revision: string };
    assert.equal(
      rolledBuildJson.buildId,
      rolled.toBuild,
      "activated version build.json matches the rolled build",
    );
    assert.equal(
      rolledBuildJson.revision,
      mergedRevision,
      "activated version revision matches the merged main commit",
    );

    const health = await serviceHealth(dataDir);
    assert.equal(
      health.buildId,
      rolled.toBuild,
      "the new build answers by health",
    );
    assert.equal(
      health.taskIdentities,
      1,
      "submitted task identity survived service replacement",
    );
    assert.notEqual(
      readServiceInfo(dataDir)!.pid,
      firstService.pid,
      "the service was replaced",
    );

    // Store pause state and task survived replacement, dispatch controls work, and reconciliation runs.
    const preservedDetail = await serviceRequest<{
      task: { id: string; phase: string };
    }>(dataDir, "queue.detail", { taskId: submittedTaskId });
    assert.equal(
      preservedDetail.task.id,
      submittedTaskId,
      "replacement service serves the pre-roll task",
    );
    const boardAfterRoll = await serviceRequest<{
      paused: boolean;
      dispatchHeld: boolean;
    }>(dataDir, "queue.ui-snapshot");
    assert.equal(
      boardAfterRoll.paused,
      true,
      "pause state survived service replacement",
    );
    await serviceRequest(dataDir, "queue.control", { paused: false });
    const boardResumed = await waitUntil(
      "board projection to reflect resumed dispatch on the replacement service",
      async () => {
        const board = await serviceRequest<{
          paused: boolean;
          dispatchHeld: boolean;
        }>(dataDir, "queue.ui-snapshot");
        return !board.paused && !board.dispatchHeld ? board : null;
      },
      15_000,
    );
    assert.equal(
      boardResumed.paused,
      false,
      "dispatch resumes on the replacement service",
    );
    assert.equal(
      boardResumed.dispatchHeld,
      false,
      "dispatch is not held after resuming",
    );
    // Replacement reconnects to T3 and continues host reconciliation and task dispatch.
    const t3RequestsBeforeResume = fakeT3.requests.length;
    const replacementConnected = await waitUntil(
      "replacement service to connect to T3 and reconcile",
      async () => {
        const latest = await serviceHealth(dataDir);
        const detail = await serviceRequest<{
          task: { id: string; phase: string; reason: string };
          events: unknown[];
        }>(dataDir, "queue.detail", { taskId: submittedTaskId });
        const dispatched =
          detail.task.reason.length > 0 || detail.task.phase !== "queued";
        const reconciled =
          fakeT3.requests.length > t3RequestsBeforeResume ||
          fakeT3.upgrades >= 2;
        return latest.connected === true &&
          latest.reconciliation &&
          dispatched &&
          reconciled
          ? { latest, detail }
          : null;
      },
      45_000,
    );
    assert.equal(
      replacementConnected.latest.connected,
      true,
      "replacement service is connected to the T3 host",
    );
    assert.ok(
      replacementConnected.detail.task.reason.length > 0 ||
        replacementConnected.detail.task.phase !== "queued",
      "replacement service evaluated the queued task for dispatch",
    );
    const lanes = await serviceRequest<unknown[]>(dataDir, "lanes");
    assert.ok(
      Array.isArray(lanes),
      "lanes read continues on the replacement service",
    );

    // No attribution, credential, channel, or release publication changes occurred.
    assert.equal(
      fakeT3.unauthorized.length,
      0,
      "no unauthorized T3 requests occurred across the roll",
    );
    assert.ok(
      fakeT3.upgrades >= 2,
      "replacement service reconnected to the T3 host",
    );
    assert.ok(
      fakeT3.bearers.length >= 2 &&
        fakeT3.bearers.every((bearer) => bearer === "Bearer synthetic-bearer"),
      "initial and replacement services used the exact unchanged T3 bearer",
    );
    assert.deepEqual(
      readT3Connection(dataDir),
      initialT3,
      "T3 credentials are unchanged by the roll",
    );
    assert.equal(
      statSync(join(dataDir, "settings.json")).mode & 0o777,
      initialSettingsMode,
      "settings permissions remain owner-only",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(installBase(), "channel.json"), "utf8")),
      initialChannel,
      "channel configuration is unchanged",
    );
    assert.equal(
      (await run("git", ["config", "user.name"])).stdout.trim(),
      "Fixture",
      "git user.name attribution is unchanged",
    );
    assert.equal(
      (await run("git", ["config", "user.email"])).stdout.trim(),
      "fixture@example.invalid",
      "git user.email attribution is unchanged",
    );
    assert.equal(
      (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
      mergedRevision,
      "roll created no commits in the source repository",
    );
    assert.equal(
      (await run("git", ["tag", "--list"])).stdout.trim(),
      "",
      "no release tags were published",
    );
    assert.equal(
      (await run("git", ["status", "--porcelain"])).stdout.trim(),
      "",
      "source repository working tree is untouched",
    );
    assert.equal(
      (await run("git", ["branch", "--list"])).stdout.trim(),
      "* main",
      "no release branches were created",
    );

    // 6. A failing build keeps the running service serving and records why.
    const servingPid = readServiceInfo(dataDir)!.pid;
    const script = join(source, "scripts/build-runtime.mjs");
    await writeFile(script, "throw Error('fixture build failure');\n");
    await run("git", ["add", "."]);
    await run("git", ["commit", "-m", "broken build"]);
    const failed = await waitUntil(
      "the failed build to be recorded",
      () => {
        const roll = readServiceRoll(dataDir);
        return roll?.status === "failed" &&
          /fixture build failure/.test(roll.detail)
          ? roll
          : null;
      },
      600_000,
    );
    assert.match(failed.detail, /fixture build failure/);
    assert.equal(
      readServiceInfo(dataDir)!.pid,
      servingPid,
      "the failed build leaves the running service serving",
    );
    assert.equal((await serviceHealth(dataDir)).buildId, rolled.toBuild);
    assert.equal(
      await realpath(current),
      rolledRoot,
      "failed build leaves current version active",
    );
    assert.equal(
      (await readdir(versionsDir)).filter((name) => !name.startsWith("."))
        .length,
      2,
      "failed build activates no new version",
    );
    assert.deepEqual(
      readT3Connection(dataDir),
      initialT3,
      "failed build leaves credentials unchanged",
    );
    assert.equal(
      (await run("git", ["tag", "--list"])).stdout.trim(),
      "",
      "failed build publishes no release tags",
    );
  },
);
