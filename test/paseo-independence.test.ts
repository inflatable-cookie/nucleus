import assert from "node:assert/strict";
import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ReviewContinuations } from "../core/review/review-continuation/index";
import { Store } from "../core/store/store";
import { ExternalWorkspaceArchive } from "../core/workspaces/external-workspace-archive-policy";
import { OwnedWorkspaceArchive } from "../core/workspaces/owned-workspace-archive";
import { runHostChannel } from "../hosts/bb/plugin/channel";
import { createHostOperations, type BbHostSdk } from "../hosts/bb/plugin/operations";
import { integrate } from "../service/install/install.mjs";
import { submissionSchema, type Run, type Task } from "../shared/contracts";
import {
  BB_LAUNCH_CLAIM_FILE,
  ensureDaemonForBb,
} from "../shared/service/daemon-launch";
import { t3Fake } from "./support/t3code-fake";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fakeT3Cli = join(repoRoot, "test", "support", "t3-cli-fake.mjs");

function scratchDir(prefix: string): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(root, "run scratch TMPDIR is required");
  return mkdtempSync(join(realpathSync(root), prefix));
}

function fakeSpawn(pid = 5150) {
  const calls: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
  }> = [];
  const spawnProcess = (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    calls.push({ command, args, options });
    return {
      pid,
      unref() {},
      on() {
        return this;
      },
    } as unknown as ChildProcess;
  };
  return { calls, spawnProcess };
}

test("CLI usage text names --via-paseo as an optional bridge route without bridge-only claims", () => {
  const help = spawnSync(
    process.execPath,
    [join(repoRoot, "bin/queue-cli.mjs"), "--help"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--via-paseo routes through the Paseo plugin bridge/);
  assert.doesNotMatch(help.stdout, /bridge-only/);
  assert.match(help.stdout, /service-state/);
});

test("BB-only daemon launcher starts one detached daemon when an installed package root exists", () => {
  const dir = scratchDir("bb-launch-");
  try {
    const dataDir = join(dir, "data");
    const home = join(dir, "home");
    const versionDir = join(home, ".local/share/nucleus/versions/v1");
    const current = join(home, ".local/share/nucleus/current");
    mkdirSync(join(versionDir, "bin"), { recursive: true });
    mkdirSync(join(versionDir, "runtime"), { recursive: true });
    writeFileSync(join(versionDir, "bin/queue-service.mjs"), "");
    writeFileSync(join(versionDir, "manifest.json"), "{}");
    writeFileSync(join(versionDir, "runtime/node"), "");
    const { calls, spawnProcess } = fakeSpawn();

    const missing = ensureDaemonForBb({
      dataDir,
      env: { ...process.env, HOME: home, NUCLEUS_PACKAGE_ROOT: "" },
      spawnProcess,
      pidAlive: () => true,
    });
    assert.equal(missing.status, "no-package-root");
    assert.equal(calls.length, 0);

    const started = ensureDaemonForBb({
      dataDir,
      packageRoot: versionDir,
      env: { ...process.env, HOME: home },
      spawnProcess,
      pidAlive: () => true,
    });
    assert.deepEqual(started, { status: "started", pid: 5150 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, join(realpathSync(versionDir), "runtime/node"));
    assert.ok(calls[0]!.args.includes(`--data-dir=${dataDir}`));
    assert.ok(existsSync(join(dataDir, BB_LAUNCH_CLAIM_FILE)));

    const claimed = ensureDaemonForBb({
      dataDir,
      packageRoot: versionDir,
      env: { ...process.env, HOME: home },
      spawnProcess,
      pidAlive: () => true,
    });
    assert.deepEqual(claimed, { status: "claimed", pid: 5150 });
    assert.equal(calls.length, 1);

    void current;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BB host channel invokes ensureDaemon before polling queue-service.json", async () => {
  const dir = scratchDir("bb-channel-launch-");
  const controller = new AbortController();
  let launches = 0;
  try {
    const operations = createHostOperations({
      sdk: {} as BbHostSdk,
      pluginId: "nucleus",
      sdkVersion: "0.6.132",
      dataDir: () => dir,
    });
    await runHostChannel({
      serviceDataDir: dir,
      operations,
      declaration: () => ({
        dataDir: dir,
        bbVersion: "0.49.0",
        sdkVersion: "0.6.132",
      }),
      log: { info() {}, warn() {}, error() {} },
      signal: controller.signal,
      backoff: { minMs: 10, maxMs: 20 },
      ensureDaemon: () => {
        launches++;
        if (launches >= 2) controller.abort();
      },
    });
    assert.ok(launches >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrate supports paseo, t3code (and t3) and bb, and refuses unknown hosts", async (t) => {
  await assert.rejects(
    integrate("unknown-host"),
    /Supported integrations: paseo, t3code \(or t3\), bb/,
  );

  const dir = scratchDir("integrate-");
  const previousHome = process.env.HOME;
  const previousDataHome = process.env.NUCLEUS_DATA_HOME;
  const previousT3Home = process.env.T3CODE_HOME;
  const previousT3State = process.env.T3_CLI_FAKE_STATE;
  const fakeServer = await t3Fake(t, join(dir, "t3-fake"));
  try {
    const home = join(dir, "home");
    const dataDir = join(dir, "data");
    const t3Base = join(dir, "t3");
    const t3State = join(dir, "t3-state");
    const acpCommand = join(dir, "bin/nucleus-acp");
    const fakeBb = join(dir, "bin/bb");
    const pluginDir = join(dir, "bb-plugin");
    mkdirSync(join(t3Base, "userdata"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(pluginDir, "dist"), { recursive: true });
    writeFileSync(
      acpCommand,
      '#!/bin/sh\n# nucleus-owned-command-v1\nexec "$HOME/bin/node" "$HOME/bin/nucleus-acp.mjs" "$@"\n',
      { mode: 0o755 },
    );
    chmodSync(acpCommand, 0o755);
    writeFileSync(
      join(t3Base, "userdata", "server-runtime.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: fakeServer.endpoint,
        serverVersion: "nightly-synthetic",
      }),
    );
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-nucleus",
        version: "0.1.0",
        bb: { server: "./dist/server.js" },
      }),
    );
    writeFileSync(join(pluginDir, "dist/server.js"), "export default async () => {};\n");
    writeFileSync(
      join(pluginDir, "dist/server.meta.json"),
      JSON.stringify({ pluginId: "nucleus" }),
    );
    writeFileSync(
      join(pluginDir, "nucleus-build.json"),
      JSON.stringify({ buildId: "a".repeat(64), revision: "b".repeat(40) }),
    );

    process.env.HOME = home;
    process.env.NUCLEUS_DATA_HOME = dataDir;
    process.env.T3CODE_HOME = t3Base;
    process.env.T3_CLI_FAKE_STATE = t3State;

    const t3Report = await integrate(
      "t3",
      "--base-dir",
      t3Base,
      "--t3",
      fakeT3Cli,
      "--acp-command",
      acpCommand,
    );
    assert.equal(t3Report.host, "t3code");
    assert.equal(t3Report.command, "install");

    const t3CodeReport = await integrate(
      "t3code",
      "--base-dir",
      t3Base,
      "--t3",
      fakeT3Cli,
      "--acp-command",
      acpCommand,
    );
    assert.equal(t3CodeReport.host, "t3code");
    assert.equal(t3CodeReport.command, "install");

    // Verify `integrate("bb", ...)` dispatches through `bin/nucleus-bb.mjs` and returns its parsed report.
    const bbState = join(dir, "bb-state.json");
    writeFileSync(bbState, JSON.stringify({ plugins: [], serviceDataDir: null }));
    writeFileSync(
      fakeBb,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nconst stateFile = ${JSON.stringify(bbState)};\nconst state = JSON.parse(fs.readFileSync(stateFile, "utf8"));\nif (args[0] === "plugin" && args[1] === "list") { console.log(JSON.stringify({ plugins: state.plugins })); process.exit(0); }\nif (args[0] === "plugin" && args[1] === "install") { const dir = args[2].replace(/^path:/, ""); state.plugins = [{ id: "nucleus", version: "0.1.0", enabled: true, status: "active", rootDir: dir }]; fs.writeFileSync(stateFile, JSON.stringify(state)); console.log("{}"); process.exit(0); }\nif (args[0] === "plugin" && args[1] === "config" && args[3] === "set") { state.serviceDataDir = args[5]; fs.writeFileSync(stateFile, JSON.stringify(state)); console.log("{}"); process.exit(0); }\nif (args[0] === "plugin" && args[1] === "config" && args[3] === "--json") { console.log(JSON.stringify({ values: { serviceDataDir: state.serviceDataDir } })); process.exit(0); }\nif (args[0] === "plugin" && args[1] === "reload") { console.log("{}"); process.exit(0); }\nprocess.exit(1);\n`,
      { mode: 0o755 },
    );
    chmodSync(fakeBb, 0o755);
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/bb"), readFileSync(fakeBb));
    chmodSync(join(home, ".local/bin/bb"), 0o755);

    const bbReport = await integrate("bb", "--plugin-dir", pluginDir);
    assert.equal(bbReport.host, "bb");
    assert.equal(bbReport.action, "installed");
    assert.equal(bbReport.dataDir, dataDir);
    void fakeT3Cli;
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDataHome === undefined) delete process.env.NUCLEUS_DATA_HOME;
    else process.env.NUCLEUS_DATA_HOME = previousDataHome;
    if (previousT3Home === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = previousT3Home;
    if (previousT3State === undefined) delete process.env.T3_CLI_FAKE_STATE;
    else process.env.T3_CLI_FAKE_STATE = previousT3State;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace archive and review continuation refusals use the host-kind label instead of Paseo", async () => {
  const dir = scratchDir("host-labels-");
  try {
    const ownedArchive = new OwnedWorkspaceArchive({
      hostId: "bb:0123456789abcdef0123456789abcdef",
      workspaceHost: {
        workspaceRef: () => ({
          current: () => ({ id: "ws-1", directory: dir }),
          refresh: async () => {},
          archive: async () => ({ archivedAt: null, error: "busy" }),
        }),
        archiveThreadPage: async () => ({
          entries: [],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
      } as never,
      observe: async () => null,
      classifyOrphan: () => ({ orphaned: false } as never),
      ownedDataDirFor: async () => null,
      dataDir: () => dir,
      workspaceAllocationBridge: {
        task: () => ({
          id: "task-1",
          workspaceAllocation: {
            provider: "barge",
            checkoutPath: dir,
            state: "returned",
            sequence: 1,
          },
        }),
      } as never,
    } as never);
    await assert.rejects(
      ownedArchive.archiveTaskWorkspace(
        { id: "task-1", hostId: "bb:0123456789abcdef0123456789abcdef" } as Task,
        "ws-1",
        dir,
        "a".repeat(40),
        () => true,
        false,
      ),
      /BB workspace\.archive failed: busy/,
    );

    const extDir = join(dir, "preserved");
    mkdirSync(extDir, { recursive: true });
    const externalArchive = new ExternalWorkspaceArchive({
      hostId: "t3code:env-1",
      workspaceHost: {
        workspaceRef: () => ({
          current: () => ({
            id: "ws-2",
            workspaceDirectory: extDir,
            placement: {
              kind: "non-worktree",
              provenance: "user",
              checkoutDirectory: extDir,
              hostOwnedWorktree: false,
            },
          }),
          refresh: async () => {},
          archive: async () => {
            throw new Error("boom");
          },
        }),
        workspaceThreads: async () => ({ ok: true, threads: [] }),
        workspaceTerminals: async () => ({ ok: true, terminals: [] }),
      } as never,
      proveExternalWorktreeSource: async () => ({ reason: "unused" }),
      catalogEntryPresent: async () => true,
      preservedGitIdentity: async () => "id",
      observe: async () => null,
    });
    const outcome = await externalArchive.archiveExternalWorkspace({
      taskId: "task-2",
      workspaceId: "ws-2",
      directory: extDir,
      ownedAgentIds: new Set(),
      requestId: "req-1",
      expected: {
        repoPath: dir,
        repository: null,
        baseBranch: "main",
        expectedHead: "a".repeat(40),
      } as never,
      samePathWorkspaceIds: [],
      folderRemoval: null,
      allowed: () => true,
    });
    assert.equal(outcome.status, "uncertain");
    assert.match(outcome.reason, /T3Code workspace\.archive failed: boom/);

    const store = new Store(join(dir, "queue.sqlite"));
    const task = store.insert(
      submissionSchema.parse({
        submissionId: "rc-1",
        title: "Review continuation host label",
        repoPath: dir,
        planningCommit: "a".repeat(40),
        brief: { text: "Test\n" },
        originAgentId: "origin",
      }),
      "t3code:env-1",
      "brief",
      "a".repeat(40),
    );
    const prHead = "b".repeat(40);
    const updatedTask = store.update(task.id, {
      prUrl: "https://github.com/example/repo/pull/1",
      prHead,
    });
    const run = {
      id: "run-rc",
      taskId: task.id,
      role: "review",
      generation: 1,
      head: prHead,
      agentId: "rev-1",
      workspaceId: "ws-1",
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run;
    const continuations = new ReviewContinuations({
      store,
      adapter: { hostId: "t3code:env-1" } as never,
      onTaskHost: (_owner, work) => work(),
      host: { observe: async () => ({ status: "idle" } as never) },
      paused: () => false,
      ownedToolHold: async () => null,
      settleVerbFences: () => {},
      settleReviewDelivery: () => {},
      reconcileReviewDelivery: async () => ({ status: "none" } as never),
      assertReviewProfileIndependent: () => {},
      stopResumeState: () => ({ kind: "none" }),
      reviewContinuationGate: () => ({
        task: { ...updatedTask, resumePrNumber: 1 },
        run,
        checkpoint: { ordinal: 1 },
        resumeStop: false,
      }) as never,
      assertIdleReviewerObservation: () => {},
      inspectReviewContinuation: async () => ({} as never),
      admitReviewContinuation: async () => ({} as never),
      assertReviewCheckpointProvenance: () => "",
    });
    await assert.rejects(
      continuations.admitReviewContinuation(
        {
          taskId: task.id,
          version: updatedTask.version,
          runId: run.id,
          head: prHead,
          checkpointOrdinal: 1,
          reason: "continue",
          instruction: "continue",
        },
        "op-1",
      ),
      /T3Code cannot prove and deliver a permission-free same-run reviewer continuation/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
