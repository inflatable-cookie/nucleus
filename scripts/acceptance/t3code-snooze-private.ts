/**
 * nucleus#1366's private proof: the one attention projection's row rule on a T3
 * server this run owns.
 *
 * The server is the installed nightly's own entry point, started with `env -i`
 * style isolation: a fresh base directory, its own HOME, its own port and its own
 * databases. The operator's live T3 home, sessions and data are never read or
 * touched. What is proved end to end, against the real nightly:
 *
 * 1. a waiting task's row is snoozed once, `snoozedUntil` is read back from the
 *    thread, a repeated pass sends nothing, and a renewal before the horizon
 *    writes a full horizon without the row waking itself;
 * 2. a task that needs a person has the row unsnoozed;
 * 3. a manually settled row is left alone;
 * 4. the nightly's own snooze refusal is real and stays observation-only;
 * 5. the adapter sends no `thread.settle` for a task thread;
 * 6. a role create with no ACP provider refuses with the reason and the
 *    `nucleus t3 install` fix and launches no thread;
 * 7. the board's attention count excludes the waiting task.
 *
 * Evidence is written beside the run in `evidence.json` with no bearer. Run it
 * through `effigy proof:t3code:snooze`; the archive comes from
 * `NUCLEUS_T3_PROOF_ASAR` or `--asar`.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3RpcClient, T3RpcError } from "../../hosts/t3code/rpc";
import { createAdapter, createHost } from "../../hosts/t3code";
import { holdPatch, keepPatch } from "../../core/merge/merge-hold";
import { HiddenRows } from "../../core/scheduling/hidden-row";
import { taskRowAttention } from "../../core/workspaces/task-row-attention";
import { canonical } from "../../hosts/t3code/state";
import { pipelineBoard } from "../../shared/pipeline-board";
import {
  submissionSchema,
  type Task,
  type TaskSummary,
} from "../../shared/contracts";
import { HostPolicies } from "../../core/host/host-policies";
import type { HostPolicyConstructor } from "../../core/host";
import { Store } from "../../core/store/store";
import { Engine } from "../../core/engine";
import { AcpSessions } from "../../core/acp/sessions";
import { QueueService } from "../../service/transport/server";
import { storedT3Labels } from "../../test/support/t3code-labels";

/** The nightly line this proof reads; the exact installed build is recorded, never pinned. */
const NIGHTLY_LINE = /^0\.1\.(?:11|12)-nightly\.\d+\.\d+$/;
const TASK_ID = "proof-task-1366";
const SNOOZE_HORIZON_MS = 48 * 60 * 60_000;

function scratchRoot(): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (!root || !existsSync(root) || !statSync(root).isDirectory())
    throw new Error("The run scratch volume is required");
  return realpathSync(root);
}

type ArchiveEntry = {
  files?: Record<string, ArchiveEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
};

/** Extract the nightly's server bundle and root manifest from its app archive. */
function extractArchive(source: string, destination: string): void {
  const fd = openSync(source, "r");
  try {
    const prelude = Buffer.alloc(16);
    assert.equal(readSync(fd, prelude, 0, 16, 0), 16);
    const headerSize = prelude.readUInt32LE(12);
    assert.ok(
      headerSize > 0 && headerSize < 16 * 1024 * 1024,
      "bounded header",
    );
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    const tree = JSON.parse(header.toString()) as ArchiveEntry;
    const base = prelude.readUInt32LE(4) + 8;
    const walk = (entry: ArchiveEntry, relative: string) => {
      const target = resolve(destination, relative);
      assert.ok(
        target === destination || target.startsWith(destination + sep),
        "archive entry stays inside the fixture",
      );
      if (entry.files) {
        mkdirSync(target, { recursive: true });
        for (const [name, child] of Object.entries(entry.files))
          walk(child, join(relative, name));
      } else if (entry.link) {
        const linkTarget = resolve(destination, entry.link);
        assert.ok(
          linkTarget.startsWith(destination + sep),
          "link stays inside the fixture",
        );
        symlinkSync(linkTarget, target);
      } else if (entry.unpacked) {
        // A native module the archive carries beside itself in `.unpacked`.
        mkdirSync(resolve(target, ".."), { recursive: true });
        copyFileSync(join(source + ".unpacked", relative), target);
      } else {
        assert.ok(
          typeof entry.size === "number" &&
            entry.size >= 0 &&
            entry.size < 64 * 1024 * 1024,
          "bounded archive entry",
        );
        const bytes = Buffer.alloc(entry.size);
        readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
        mkdirSync(resolve(target, ".."), { recursive: true });
        writeFileSync(target, bytes);
      }
    };
    const manifest = tree.files?.["package.json"];
    assert.ok(manifest, "the archive carries its manifest");
    walk(manifest, "package.json");
    const modules = tree.files?.node_modules;
    assert.ok(modules, "the archive carries its dependencies");
    walk(modules, "node_modules");
    const serverBundle = tree.files?.apps?.files?.server;
    assert.ok(serverBundle, "the archive carries apps/server");
    walk(serverBundle, "apps/server");
  } finally {
    closeSync(fd);
  }
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((closed) => socket.close(() => closed()));
  return port;
}

async function until<T>(
  read: () => Promise<T>,
  what: string,
  milliseconds = 60_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + milliseconds;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!/changed during snapshot|snapshotSequence changed/.test(last))
        throw error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

async function run(
  argv: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  secret = false,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (bytes) => (stdout += bytes));
    child.stderr!.on("data", (bytes) => (stderr += bytes));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolveRun(stdout.trim());
      reject(
        new Error(
          `Private ${secret ? "credential" : "setup"} command failed (${code}): ${
            secret ? "output withheld" : stderr.slice(-2000)
          }`,
        ),
      );
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const asarArg = args.indexOf("--asar");
  const asar =
    asarArg >= 0 ? args[asarArg + 1] : process.env.NUCLEUS_T3_PROOF_ASAR;
  if (!asar)
    throw new Error(
      "Set NUCLEUS_T3_PROOF_ASAR or pass --asar with the installed nightly app archive",
    );
  const root = mkdtempSync(join(scratchRoot(), "t3-snooze-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const evidence: Record<string, unknown> = {
    nightlyLine: String(NIGHTLY_LINE),
    steps: [],
  };
  const steps = evidence.steps as unknown[];

  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  extractArchive(resolve(asar), bundle);
  const metadata = JSON.parse(
    readFileSync(join(bundle, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  assert.match(metadata.version, NIGHTLY_LINE);
  evidence.installedVersion = metadata.version;
  evidence.archiveSha256 = createHash("sha256")
    .update(readFileSync(resolve(asar)))
    .digest("hex");
  const entry = join(bundle, "apps/server/dist/bin.mjs");

  const privateHome = join(root, "home");
  const data = join(root, "t3-data");
  const nucleusData = join(root, "nucleus-data");
  const repository = join(root, "synthetic-repository");
  const worktree = join(root, "synthetic-worktree");
  for (const path of [
    privateHome,
    data,
    join(data, "userdata"),
    nucleusData,
    repository,
  ])
    mkdirSync(path, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: privateHome,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: join(privateHome, ".config"),
    XDG_DATA_HOME: join(privateHome, ".local/share"),
    XDG_CACHE_HOME: join(privateHome, ".cache"),
    T3CODE_HOME: data,
    T3CODE_NO_BROWSER: "true",
    T3CODE_LOG_LEVEL: "Warn",
    T3CODE_TRACE_TIMING_ENABLED: "false",
    NUCLEUS_DATA_HOME: nucleusData,
  };
  await run(
    ["git", "init", "--quiet", "--initial-branch=main"],
    repository,
    environment,
  );
  await run(
    ["git", "config", "user.email", "fixture@example.invalid"],
    repository,
    environment,
  );
  await run(
    ["git", "config", "user.name", "Synthetic fixture"],
    repository,
    environment,
  );
  writeFileSync(join(repository, "fixture.txt"), "Synthetic private proof\n");
  await run(["git", "add", "fixture.txt"], repository, environment);
  await run(
    ["git", "commit", "--quiet", "-m", "Synthetic fixture"],
    repository,
    environment,
  );
  await run(
    ["git", "worktree", "add", "--quiet", "-b", "proof-worktree", worktree],
    repository,
    environment,
  );
  // The synthetic Codex app-server (no model, no account): only the thread the row
  // rule drives has to exist, and the nightly needs a registered provider to make it.
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const peer = fileURLToPath(new URL("./t3code-provider.mjs", import.meta.url));
  const provider = join(root, "synthetic-codex");
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    provider,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(peer)} "$@"\n`,
    { mode: 0o700 },
  );
  const checkout = fileURLToPath(new URL("../..", import.meta.url));
  const acpLauncher = join(root, "synthetic-nucleus-acp");
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${shellQuote(process.execPath)} --import ${shellQuote(join(checkout, "node_modules/tsx/dist/loader.mjs"))} ${shellQuote(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(nucleusData, "settings.json"),
    JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    join(data, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: {
            binaryPath: provider,
            homePath: codexHome,
            setupMode: "existing",
          },
        },
        nucleus: {
          driver: "acpRegistry",
          displayName: "Nucleus",
          enabled: true,
          config: { source: "local", commandPath: acpLauncher },
        },
      },
      notifications: { enabled: false },
    }),
    { mode: 0o600 },
  );
  environment.NUCLEUS_T3_PROVIDER_LOG = join(root, "provider-protocol.ndjson");

  const bearer = await run(
    [
      process.execPath,
      entry,
      "auth",
      "session",
      "issue",
      "--base-dir",
      data,
      "--scope",
      "orchestration:read",
      "--scope",
      "orchestration:operate",
      "--token-only",
    ],
    root,
    environment,
    true,
  );
  assert.ok(bearer.length > 20, "private session bearer issued");

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let rpc: T3RpcClient | undefined;
  let host: ReturnType<typeof createHost> | undefined;
  let service: QueueService | undefined;
  let acpEngine: Engine | undefined;
  let acpStore: Store | undefined;
  let acpHost: ReturnType<typeof createHost> | undefined;
  const startServer = async () => {
    const log = openSync(join(root, "server.log"), "a", 0o600);
    server = spawn(
      process.execPath,
      [
        entry,
        "--base-dir",
        data,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
      ],
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const relay = (stream: NodeJS.ReadableStream) => {
      let buffered = "";
      stream.on("data", (bytes: Buffer) => {
        buffered += bytes.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines)
          writeFileSync(
            log,
            `${/pairingUrl:|#token=/.test(line) ? "[private pairing URL redacted]" : line}\n`,
          );
      });
    };
    relay(server.stdout!);
    relay(server.stderr!);
    server.once("close", () => closeSync(log));
    await until(
      async () =>
        (
          await fetch(`${endpoint}/.well-known/t3/environment`).catch(
            () => null,
          )
        )?.ok === true,
      "private server startup",
    );
  };
  const stopServer = async () => {
    const child = server;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Private server did not exit"));
      }, 10_000);
      child.once("close", () => {
        clearTimeout(timer);
        done();
      });
      child.kill("SIGTERM");
    });
    server = undefined;
  };

  try {
    await startServer();
    rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 15_000 });
    await rpc.connect();
    const config = (await rpc.call("server.getConfig", {})) as {
      environment: {
        serverVersion: string;
        orchestrationProtocolVersion: number;
      };
    };
    assert.match(config.environment.serverVersion, NIGHTLY_LINE);
    evidence.serverVersion = config.environment.serverVersion;
    assert.equal(config.environment.orchestrationProtocolVersion, 2);
    steps.push({ step: "private-nightly-config", result: "passed" });

    // One project and one seeded thread: the row this proof drives.
    const projectId = crypto.randomUUID();
    const seedThreadId = crypto.randomUUID();
    await rpc.call("projects.mutate", {
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "Synthetic snooze proof",
      workspaceRoot: repository,
    });
    await rpc.call("orchestration.launchThread", {
      commandId: crypto.randomUUID(),
      threadId: seedThreadId,
      projectId,
      title: "Proof row",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "existing_worktree", worktreePath: worktree },
    });

    // The adapter's own state: a task parent record naming the seeded thread, and
    // the workspace handle it was launched into. This is the stored shape the host
    // reads; no ACP surface is needed for the row rules.
    const statePath = join(root, "hosts", "t3code.json");
    mkdirSync(join(root, "hosts"), { recursive: true });
    const workspaceId = `nucleus-worktree-${"0".repeat(40)}`;
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        hostId: "",
        lastPassedVersion: "",
        workspaces: {
          [workspaceId]: {
            id: workspaceId,
            directory: worktree,
            projectId,
            title: "Proof worktree",
          },
        },
        agents: {},
        intents: {},
        parents: {
          [TASK_ID]: {
            taskId: TASK_ID,
            threadId: seedThreadId,
            sessionId: `session:${TASK_ID}`,
            bindingPath: join(root, "acp", `${TASK_ID}.json`),
            workspaceId,
            projectId,
            directory: worktree,
            createdAt: new Date().toISOString(),
            title: "Waiting on nucleus#1364: 1366 proof",
          },
        },
        nesting: {
          state: "unavailable",
          reason: "no ACP sessions in this proof",
          at: new Date().toISOString(),
        },
      }),
      { mode: 0o600 },
    );
    host = createHost({
      endpoint,
      bearer,
      statePath,
      timeoutMs: 15_000,
      probeThreadId: seedThreadId,
      acp: () => null,
    });
    await host.connect();
    steps.push({ step: "adapter-connect", result: "passed" });

    const readThread = async () => {
      const value = (await rpc!.readStream(
        "orchestration.subscribeThread",
        { threadId: seedThreadId },
        (chunk) => (chunk as { kind?: string }).kind === "snapshot",
      )) as {
        projection: {
          thread: {
            snoozedUntil: string | null;
            settledOverride: string | null;
          };
        };
      };
      return value.projection.thread;
    };
    const adapterSettles = () =>
      (host!.state.read().intents &&
        Object.values(host!.state.read().intents).filter(
          (intent) =>
            (intent as { kind?: string }).kind === "thread.settle" ||
            JSON.parse((intent as { payload: string }).payload).payload
              ?.type === "thread.settle",
        ).length) ||
      0;

    // 1. A waiting task's row is snoozed once, and the horizon is read back.
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    const first = await until(
      async () => (await readThread()).snoozedUntil,
      "the row's snoozedUntil",
    );
    assert.ok(Date.parse(first) > Date.now(), "the horizon is in the future");
    const record = host.state.read().snoozes?.[seedThreadId];
    assert.equal(record?.state, "snoozed");
    assert.equal(
      record?.until,
      first,
      "the adapter recorded the horizon it read back",
    );
    assert.ok(
      record?.episodeStartedAt,
      "the adapter recorded the continuous episode start",
    );
    const firstVisibility = await host.rowSnoozeVisibility(TASK_ID);
    assert.equal(
      firstVisibility.kind,
      "snoozed",
      "real T3 read proves the row is snoozed",
    );
    assert.equal(
      firstVisibility.kind === "snoozed" && firstVisibility.episodeStartedAt,
      record?.episodeStartedAt,
      "visibility reports the durable episode start",
    );
    assert.equal(
      (await readThread()).settledOverride,
      null,
      "the row is never settled",
    );
    steps.push({
      step: "snooze-once-read-back",
      result: "passed",
      episodeStartedAt: record?.episodeStartedAt,
    });

    // 2. A repeated pass inside the horizon adds no write.
    const commandsBefore = adapterIntentCount(host);
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    assert.equal(
      adapterIntentCount(host),
      commandsBefore,
      "a repeated pass writes nothing",
    );
    steps.push({ step: "repeat-no-write", result: "passed" });

    // 3. The renewal before the horizon asks for a full one again.
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.snooze",
      commandId: `proof-short-snooze-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      snoozedUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const short = await readThread();
    assert.ok(Date.parse(short.snoozedUntil!) - Date.now() < 2 * 60 * 60_000);
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    const renewed = await until(async () => {
      const untilValue = (await readThread()).snoozedUntil;
      return untilValue &&
        Date.parse(untilValue) - Date.now() > SNOOZE_HORIZON_MS / 2
        ? untilValue
        : null;
    }, "the renewed horizon");
    assert.ok(Date.parse(renewed) > Date.now() + SNOOZE_HORIZON_MS / 2);
    const renewedVisibility = await host.rowSnoozeVisibility(TASK_ID);
    assert.equal(
      renewedVisibility.kind,
      "snoozed",
      "renewal keeps the row snoozed",
    );
    assert.equal(
      renewedVisibility.kind === "snoozed" &&
        renewedVisibility.episodeStartedAt,
      record?.episodeStartedAt,
      "renewal preserves the original episode start on real T3",
    );
    steps.push({
      step: "renew-before-horizon",
      result: "passed",
      horizon: renewed,
      episodeStartedAt: record?.episodeStartedAt,
    });

    // 4. A task that needs a person has the row unsnoozed.
    await host.reconcileTaskRow(TASK_ID, {
      state: "attention",
      cause: "Worker creation refused before send",
    });
    await until(
      async () => (await readThread()).snoozedUntil === null,
      "the unsnoozed row",
    );
    assert.equal(host.state.read().snoozes?.[seedThreadId], undefined);
    assert.deepEqual(
      await host.rowSnoozeVisibility(TASK_ID),
      { kind: "clear" },
      "unsnooze clears row visibility",
    );
    steps.push({ step: "unsnooze-on-attention", result: "passed" });

    // 5. A manually settled row is left alone.
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.settle",
      commandId: `proof-manual-settle-${crypto.randomUUID()}`,
      threadId: seedThreadId,
    });
    await until(
      async () => (await readThread()).settledOverride === "settled",
      "the manual settle",
    );
    const settledCommands = adapterIntentCount(host);
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    await host.reconcileTaskRow(TASK_ID, {
      state: "attention",
      cause: "Needs a person",
    });
    assert.equal(
      adapterIntentCount(host),
      settledCommands,
      "a manual settle is neither snoozed over nor unsettled",
    );
    assert.equal((await readThread()).settledOverride, "settled");
    assert.deepEqual(
      await host.rowSnoozeVisibility(TASK_ID),
      { kind: "clear" },
      "a manual settle is never reported as a Nucleus-owned snooze",
    );
    steps.push({ step: "manual-settle-left-alone", result: "passed" });

    // 6. A snooze refused for a pending approval stays active, with no retry loop.
    // The thread is shown again first: a manual settle and a snoozed row are the
    // operator's and this host's own state, not this proof's.
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.unsnooze",
      commandId: `proof-reset-unsnooze-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      reason: "user",
    });
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.unsettle",
      commandId: `proof-reset-unsettle-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      reason: "user",
    });
    await rpc.call("orchestration.dispatchCommand", {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "server",
      commandId: `proof-approval-message-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      messageId: `proof-approval-${crypto.randomUUID()}`,
      text: "proof-approval",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
    const pendingApproval = await until(async () => {
      const projection = await host!.readProjection(
        seedThreadId,
        "observation",
      );
      return projection.runtimeRequests.find(
        (request) =>
          request.status === "pending" && request.kind !== "user_input",
      );
    }, "the pending approval");
    assert.ok(
      pendingApproval,
      "the nightly holds a pending non-user-input approval",
    );
    const passedSnooze = adapterIntentCount(host);
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    assert.equal(
      (await readThread()).snoozedUntil,
      null,
      "the refused snooze left the row active",
    );
    assert.equal(
      host.state.read().snoozes?.[seedThreadId]?.state,
      "unknown",
      "the remote refusal retains unknown delivery for this wait episode",
    );
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Waiting on nucleus#1364",
    });
    assert.equal(
      adapterIntentCount(host),
      passedSnooze + 1,
      "this wait episode sends exactly one refused snooze and never retries",
    );
    assert.equal(
      adapterSettles(),
      0,
      "the adapter sent no thread.settle for the task",
    );
    assert.deepEqual(
      await host.rowSnoozeVisibility(TASK_ID),
      { kind: "clear" },
      "refused snooze never hides the row",
    );
    steps.push({
      step: "pending-approval-refusal-stays-active",
      result: "passed",
      requestId: pendingApproval.id,
    });

    // 7. A role create with no ACP provider refuses with the fix and launches nothing.
    const creationCommands = () =>
      Object.values(host!.state.read().intents).filter((intent) => {
        const kind = (intent as { kind?: string }).kind;
        const payload = JSON.parse((intent as { payload: string }).payload) as {
          method?: string;
          payload?: { type?: string };
        };
        return (
          kind === "launchThread" ||
          payload.method === "orchestration.launchThread" ||
          payload.payload?.type === "delegated_task.request"
        );
      }).length;
    const launchesBefore = creationCommands();
    // The role's profile is whatever the registered provider reports: the nightly
    // lists a provider only once its own probe settles.
    const served = (await host.rpc.call("server.getConfig", {})) as {
      providers: Array<{ instanceId: string; models: Array<{ slug: string }> }>;
    };
    evidence.providers = served.providers.map((provider) => [
      provider.instanceId,
      provider.models.map((model) => model.slug),
    ]);
    // Any ready provider answers the model fence; the refusal this step proves is
    // the missing ACP surface, which is checked before any child command.
    const ready = served.providers.find(
      (provider) => provider.models.length > 0,
    );
    assert.ok(ready, "a provider reports models");
    const proofProvider = ready.instanceId;
    const proofModel = ready.models[0]!.slug;
    await assert.rejects(
      () =>
        host!.createAgent({
          workspaceId,
          profile: {
            id: "proof",
            name: "Proof",
            provider: proofProvider,
            model: proofModel,
            available: true,
            problem: "",
            notes: "",
            supportedThinking: [],
          },
          title: "Proof role",
          mcpBindingPath: null,
          attempt: () => ({
            requestId: `proof-create-${crypto.randomUUID()}`,
            prompt: "Proof prompt",
            labels: { "nucleus.task": TASK_ID, "nucleus.run": "proof-run" },
            environment: {},
          }),
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        evidence.refusalMessage = message;
        return (
          /T3 provider not ready: this process serves no ACP sessions/.test(
            message,
          ) && /nucleus t3 install/.test(message)
        );
      },
      "the refusal names the reason and the fix",
    );
    assert.equal(
      creationCommands(),
      launchesBefore,
      "no thread is launched for the refused role",
    );
    steps.push({ step: "provider-missing-refusal", result: "passed" });

    // 8. The board's attention count excludes the waiting task: the count is the
    // Attention column, and the one projection keeps a releasing hold out of it.
    const held = {
      id: TASK_ID,
      title: "1366 proof",
      repoPath: repository,
      repository: repository,
      version: 1,
      number: 1366,
      reference: "nucleus#1366",
      entrypoint: "worker",
      phase: "needs_attention",
      reason: "Waiting on nucleus#1364",
      held: true,
      holds: {
        dispatch: {
          owner: "operator",
          reason: "Hold until the prerequisite lands",
          since: new Date().toISOString(),
          until: {
            kind: "task",
            taskId: "0f8a2b3c-0000-4000-8000-000000000001",
          },
        },
      },
      dependsOn: [],
      queuePriority: 0,
      lanes: [],
      resolution: { attention: true },
      waitingOn: "nucleus#1364",
    } as unknown as TaskSummary;
    const project = {
      key: "proof",
      name: "Proof",
      repositories: [{ origin: repository, path: repository }],
      visibility: "visible",
    };
    const board = pipelineBoard({
      projects: [project],
      selection: [],
      leads: [],
      tasks: [held],
    } as never);
    assert.equal(
      board.counts.Attention,
      0,
      "the waiting task is not in the board's attention count",
    );
    assert.equal(board.counts.Working, 1, "it sits with the open work");
    // The same task with no release condition keeps its owner's attention.
    const unheld = {
      ...held,
      holds: {
        dispatch: {
          owner: "operator",
          reason: "Needs the owner to release it",
          since: held.holds!.dispatch!.since,
          until: null,
        },
      },
    } as unknown as TaskSummary;
    const awaiting = pipelineBoard({
      projects: [project],
      selection: [],
      leads: [],
      tasks: [unheld],
    } as never);
    assert.equal(awaiting.counts.Attention, 1);
    steps.push({
      step: "board-attention-count",
      result: "passed",
      counts: board.counts,
    });

    // 9. Delayed apply, unapplied ack retry as a new occurrence, stale pass snapshot,
    //    unknown delivery and operator snooze (<24h) on the real private T3 wire.
    await rpc.call("orchestration.dispatchCommand", {
      type: "runtime-request.respond",
      commandId: `proof-resolve-approval-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      requestId: pendingApproval.id,
      decision: "accept",
    });
    await until(async () => {
      const projection = await host!.readProjection(
        seedThreadId,
        "observation",
      );
      return projection.runtimeRequests.every(
        (request) => request.status !== "pending",
      );
    }, "approval resolved");
    // Clear the refused snooze record from step 6 before driving step 9 on the same thread.
    host.state.update((state) => {
      if (state.snoozes) delete state.snoozes[seedThreadId];
    });
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Delayed apply wait",
    });
    const delayedUntil = await until(
      async () => (await readThread()).snoozedUntil,
      "step 9 snooze",
    );
    const nativeCall = host.rpc.call.bind(host.rpc);
    let dropUnsnoozeAck = true;
    host.rpc.call = async (method, payload) => {
      if (
        dropUnsnoozeAck &&
        method === "orchestration.dispatchCommand" &&
        (payload as { type?: string }).type === "thread.unsnooze"
      ) {
        return { ok: true };
      }
      return nativeCall(method, payload);
    };
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    assert.equal(
      (await readThread()).snoozedUntil,
      delayedUntil,
      "T3 still shows snoozedUntil",
    );
    assert.ok(
      host.state.read().snoozes?.[seedThreadId],
      "snooze record retained until read-back clears",
    );

    // Delayed apply lands before the next pass: re-observe retires the snooze without resending.
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.unsnooze",
      commandId: `proof-delayed-apply-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      reason: "user",
    });
    await until(
      async () => (await readThread()).snoozedUntil === null,
      "delayed unsnooze landed",
    );
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    assert.equal(
      host.state.read().snoozes?.[seedThreadId],
      undefined,
      "delayed apply retired snooze on re-observe",
    );

    // Unapplied ack: settled unsnooze that did not clear retries as a new occurrence.
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Retry occurrence wait",
    });
    await until(
      async () => (await readThread()).snoozedUntil !== null,
      "second snooze landed",
    );
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    assert.ok(
      host.state.read().snoozes?.[seedThreadId],
      "snooze record kept while still snoozed",
    );
    dropUnsnoozeAck = false;
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    await until(
      async () => (await readThread()).snoozedUntil === null,
      "retried unsnooze cleared",
    );
    assert.equal(
      host.state.read().snoozes?.[seedThreadId],
      undefined,
      "snooze retired after read-back",
    );

    // Stale pass snapshot inside beginHostPass: unsnoozeRow bypasses held cache and clears.
    const staleTask = {
      id: TASK_ID,
      number: 1399,
      title: "Stale snapshot",
      phase: "working",
      hostId: host.hostId,
      removedAt: null,
    } as unknown as Task;
    await host.beginHostPass([staleTask]);
    const heldRead = await host.readProjection(seedThreadId, "observation");
    assert.equal(heldRead.thread.snoozedUntil, null);
    const staleUntil = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.snooze",
      commandId: `proof-stale-snooze-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      snoozedUntil: staleUntil,
    });
    await until(
      async () => (await readThread()).snoozedUntil === staleUntil,
      "snooze set during pass",
    );
    host.state.update((state) => {
      state.snoozes = {
        ...state.snoozes,
        [seedThreadId]: {
          episode: 0,
          commandId: "stale-pass-snooze",
          until: staleUntil,
          state: "snoozed",
          recordedAt: new Date().toISOString(),
        },
      };
    });
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    host.endHostPass();
    await until(
      async () => (await readThread()).snoozedUntil === null,
      "stale pass cleared",
    );
    assert.equal(host.state.read().snoozes?.[seedThreadId], undefined);

    // Unknown delivery (timeout): never resent blindly while unknown, settles once cleared.
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Unknown timeout wait",
    });
    await until(
      async () => (await readThread()).snoozedUntil !== null,
      "unknown timeout snooze",
    );
    let timeoutAttempts = 0;
    host.rpc.call = async (method, payload) => {
      if (
        method === "orchestration.dispatchCommand" &&
        (payload as { type?: string }).type === "thread.unsnooze"
      ) {
        timeoutAttempts++;
        throw new T3RpcError("timeout", method);
      }
      return nativeCall(method, payload);
    };
    await assert.rejects(
      host.reconcileTaskRow(TASK_ID, { state: "active" }),
      /Host delivery is unknown/i,
    );
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    assert.equal(
      timeoutAttempts,
      1,
      "unknown unsnooze is never resent blindly",
    );
    assert.ok(
      host.state.read().snoozes?.[seedThreadId],
      "snooze retained while unknown",
    );
    host.rpc.call = nativeCall;
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.unsnooze",
      commandId: `proof-clear-unknown-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      reason: "user",
    });
    await until(
      async () => (await readThread()).snoozedUntil === null,
      "unknown cleared externally",
    );
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    assert.equal(host.state.read().snoozes?.[seedThreadId], undefined);

    // Operator snooze (<24h): left untouched.
    const opUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    await rpc.call("orchestration.dispatchCommand", {
      type: "thread.snooze",
      commandId: `proof-operator-snooze-${crypto.randomUUID()}`,
      threadId: seedThreadId,
      snoozedUntil: opUntil,
    });
    await until(
      async () => (await readThread()).snoozedUntil === opUntil,
      "operator snooze set",
    );
    await host.reconcileTaskRow(TASK_ID, {
      state: "waiting",
      cause: "Operator snooze check",
    });
    await host.reconcileTaskRow(TASK_ID, { state: "active" });
    assert.equal(
      (await readThread()).snoozedUntil,
      opUntil,
      "operator snooze untouched",
    );
    steps.push({
      step: "readback-delayed-stale-unknown-operator",
      result: "passed",
    });

    // 10. A planner's own manual hold on the real wire (nucleus#1419): the row is
    //     snoozed while the hold parks it, the nudge and the answer window decide
    //     whether it stays hidden, and the hold itself is never touched.
    const holdThreadId = crypto.randomUUID();
    await rpc.call("orchestration.launchThread", {
      commandId: crypto.randomUUID(),
      threadId: holdThreadId,
      projectId,
      title: "Proof hold row",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "existing_worktree", worktreePath: worktree },
    });
    const readRow = async (threadId: string) => {
      const value = (await rpc!.readStream(
        "orchestration.subscribeThread",
        { threadId },
        (chunk) => (chunk as { kind?: string }).kind === "snapshot",
      )) as {
        projection: { thread: { snoozedUntil: string | null } };
      };
      return value.projection.thread;
    };
    const holdDbPath = join(root, "hold-proof.sqlite");
    let holdStore = new Store(holdDbPath);
    holdStore.setMeta("paused", false);
    const holdPlanning = "d".repeat(40);
    const holdTask = holdStore.insert(
      submissionSchema.parse({
        submissionId: "proof-planner-hold",
        title: "Approved, waiting for the upgrade day",
        repoPath: repository,
        planningCommit: holdPlanning,
        brief: { text: "Synthetic planner hold proof" },
        originAgentId: "proof-planner",
      }),
      host.hostId,
      "handoff",
      holdPlanning,
    );
    const holdTaskId = holdTask.id;
    host.state.update((state) => {
      state.parents = {
        ...state.parents,
        [holdTaskId]: {
          taskId: holdTaskId,
          threadId: holdThreadId,
          sessionId: `session:${holdTaskId}`,
          bindingPath: join(root, "acp", `${holdTaskId}.json`),
          workspaceId,
          projectId,
          directory: worktree,
          createdAt: new Date().toISOString(),
          title: "1419 proof",
        },
      };
    });
    holdStore.update(holdTask.id, { phase: "needs_attention" });
    holdStore.update(
      holdTask.id,
      holdPatch(
        holdStore.task(holdTask.id),
        "dispatch",
        "proof-planner",
        "Underlay reference approved; held until Effigy v0.15 upgrade day",
        null,
      ),
    );
    const holdNow = () => holdStore.task(holdTask.id);
    const pass = async () => {
      await new HiddenRows({ store: holdStore, adapter: host! }).observe(
        host!.hostId!,
      );
      await host!.reconcileTaskRow(
        holdTask.id,
        taskRowAttention(holdStore, holdStore.task(holdTask.id)),
      );
    };
    const holdEvents = () =>
      holdStore
        .events(holdTask.id)
        .filter((event) => event.kind.startsWith("row_hidden_hold_"));
    const seedAnswer = (
      answer: {
        since: string;
        dueAt: string;
        noticeId: string;
        deliveredAt: string | null;
        unansweredAt: string | null;
        deliveryFault: string;
      },
      notice: { status: "delivered" | "pending"; error: string },
    ) => {
      const fence = holdNow().holds!.dispatch!;
      holdStore.putNotice({
        id: answer.noticeId,
        taskId: holdTask.id,
        agentId: "proof-planner",
        recipientAgentId: "",
        workspaceId: null,
        sources: [],
        originEntry: true,
        kind: "row_hidden",
        status: notice.status,
        error: notice.error,
        text: "Nucleus: a hold still hides a task row on T3",
      });
      holdStore.update(holdTask.id, {
        holds: { dispatch: { ...fence, plannerAnswer: answer } },
      });
    };

    // (a) The manual-hold shape: a quiet planner-owned hold snoozes the real row.
    await pass();
    const heldRow = await until(
      async () => (await readRow(holdThreadId)).snoozedUntil,
      "the planner-held row's snoozedUntil",
    );
    assert.ok(Date.parse(heldRow) > Date.now(), "the hold's row is snoozed");
    assert.equal(
      (await host.rowSnoozeVisibility(holdTask.id)).kind,
      "snoozed",
      "real T3 proves the planner's hold hides the row",
    );
    assert.equal(taskRowAttention(holdStore, holdNow()).state, "waiting");
    steps.push({ step: "planner-hold-row-snoozed", result: "passed" });

    // (b) A keep inside the answer window answers the nudge: a fresh generation
    //     with a fresh clock, and the hold keeps its own reason and owner.
    seedAnswer(
      {
        since: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        dueAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        noticeId: `row-hidden-hold:${holdTask.id}:dispatch:1`,
        deliveredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        unansweredAt: null,
        deliveryFault: "",
      },
      { status: "delivered", error: "" },
    );
    await pass();
    assert.equal(
      holdEvents().length,
      0,
      "an answer window that is still open escalates nothing",
    );
    holdStore.update(
      holdTask.id,
      keepPatch(
        holdStore.task(holdTask.id),
        "dispatch",
        "Upgrade day moved, still approved",
        "proof-planner",
      ),
    );
    assert.equal(holdNow().holdGeneration, 2);
    assert.equal(
      holdNow().holds!.dispatch!.plannerAnswer,
      null,
      "the fresh keep clears the answered generation",
    );
    await pass();
    assert.equal(holdEvents().length, 0, "the keep is the answer");
    assert.ok(
      (await readRow(holdThreadId)).snoozedUntil,
      "the kept hold keeps its row snoozed on real T3",
    );
    steps.push({ step: "planner-hold-timely-keep", result: "passed" });

    // (c) An unanswered nudge shows the row again without touching the hold.
    seedAnswer(
      {
        since: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        dueAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        noticeId: `row-hidden-hold:${holdTask.id}:dispatch:2`,
        deliveredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        unansweredAt: null,
        deliveryFault: "",
      },
      { status: "delivered", error: "" },
    );
    await pass();
    assert.equal(holdEvents().length, 1);
    assert.equal(holdEvents()[0]!.kind, "row_hidden_hold_unanswered");
    await until(
      async () => (await readRow(holdThreadId)).snoozedUntil === null,
      "the escalated row shown again",
    );
    assert.equal(
      taskRowAttention(holdStore, holdNow()).state,
      "attention",
      "the task needs its planner for this hold generation",
    );
    assert.deepEqual(
      {
        generation: holdNow().holdGeneration,
        reason: holdNow().holdReason,
        held: holdNow().held,
      },
      {
        generation: 2,
        reason: "Upgrade day moved, still approved",
        held: true,
      },
      "a timer never releases the hold",
    );
    await pass();
    assert.equal(
      (await readRow(holdThreadId)).snoozedUntil,
      null,
      "the escalated generation stays visible",
    );
    steps.push({ step: "planner-hold-unanswered-shows-row", result: "passed" });

    // (d) A nudge that never reached the planner shows the task and the fault.
    holdStore.update(
      holdTask.id,
      keepPatch(
        holdStore.task(holdTask.id),
        "dispatch",
        "Upgrade day moved again",
        "proof-planner",
      ),
    );
    seedAnswer(
      {
        since: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        dueAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        noticeId: `row-hidden-hold:${holdTask.id}:dispatch:3`,
        deliveredAt: null,
        unansweredAt: null,
        deliveryFault: "",
      },
      { status: "pending", error: "Waiting for the planner's turn to end" },
    );
    await pass();
    const undelivered = holdEvents()[0]!;
    assert.equal(undelivered.kind, "row_hidden_hold_undelivered");
    assert.match(undelivered.detail, /Waiting for the planner's turn to end/);
    assert.match(
      holdNow().holds!.dispatch!.plannerAnswer!.deliveryFault,
      /Waiting for the planner's turn to end/,
      "the fence keeps the delivery fault",
    );
    const undeliveredProjection = taskRowAttention(holdStore, holdNow());
    assert.equal(undeliveredProjection.state, "attention");
    assert.match(
      undeliveredProjection.state === "attention"
        ? undeliveredProjection.cause
        : "",
      /not delivered to the planner/,
    );
    await until(
      async () => (await readRow(holdThreadId)).snoozedUntil === null,
      "the undelivered nudge's row shown again",
    );
    steps.push({
      step: "planner-hold-undelivered-shows-row",
      result: "passed",
    });

    // (e) A restart resumes the same generation: no second escalation, the row
    //     stays visible, and a fresh explicit keep snoozes it again.
    holdStore.close();
    holdStore = new Store(holdDbPath);
    await pass();
    assert.equal(
      holdEvents().length,
      2,
      "a restart records no second escalation for the generation",
    );
    assert.equal(
      (await readRow(holdThreadId)).snoozedUntil,
      null,
      "the restarted service keeps the escalated row visible",
    );
    holdStore.update(
      holdTask.id,
      keepPatch(
        holdStore.task(holdTask.id),
        "dispatch",
        "Upgrade day confirmed",
        "proof-planner",
      ),
    );
    await pass();
    assert.equal(holdEvents().length, 2, "the keep escalates nothing");
    const resnoozed = await until(
      async () => (await readRow(holdThreadId)).snoozedUntil,
      "the fresh generation's snoozed row",
    );
    assert.ok(
      resnoozed && Date.parse(resnoozed) > Date.now(),
      "a fresh keep starts a fresh episode that snoozes the real row again",
    );
    steps.push({
      step: "planner-hold-restart-and-fresh-keep",
      result: "passed",
    });

    // (f) An independent question keeps the row visible whatever the hold says.
    holdStore.update(holdTask.id, {
      resolution: { ...holdNow().resolution, attention: true },
    });
    await pass();
    await until(
      async () => (await readRow(holdThreadId)).snoozedUntil === null,
      "the independently visible row",
    );
    assert.equal(
      taskRowAttention(holdStore, holdNow()).state,
      "attention",
      "an independent call for a person stays visible",
    );
    holdStore.update(holdTask.id, {
      resolution: { ...holdNow().resolution, attention: false },
    });
    await pass();
    assert.ok(
      (await readRow(holdThreadId)).snoozedUntil,
      "with the question answered the planner's hold parks the row again",
    );
    holdStore.close();
    steps.push({ step: "planner-hold-independent-question", result: "passed" });

    // 11. Real ACP parent + same native child going idle and resuming on the real wire,
    //     measuring the reconcile path from role going active to the row showing.
    service = new QueueService({
      owner: { dataDir: nucleusData, timers: false },
      fixture: "fake",
      debug: true,
    });
    await service.start();
    const acpWorktree = join(root, "acp-worktree");
    await run(
      [
        "git",
        "worktree",
        "add",
        "--quiet",
        "-b",
        "proof-acp-worktree",
        acpWorktree,
      ],
      repository,
      environment,
    );
    acpStore = new Store(join(nucleusData, "queue.sqlite"));
    acpStore.setMeta("paused", false);
    const acpSessions = new AcpSessions(
      { store: acpStore } as unknown as Engine,
      {
        dataHome: nucleusData,
        socketPath: join(nucleusData, "callback.sock"),
      },
    );
    acpHost = createHost({
      endpoint,
      bearer,
      statePath: join(root, "hosts", "t3code-acp.json"),
      timeoutMs: 30_000,
      probeThreadId: seedThreadId,
      acp: () => acpSessions,
    });
    await acpHost.connect();
    const acpAdapter = createAdapter(
      HostPolicies as unknown as HostPolicyConstructor,
      acpHost,
    );
    const liveEngine = new Engine(acpStore, acpAdapter, 60_000);
    acpEngine = liveEngine;

    const planning = "a".repeat(40);
    const acpTask = acpStore.insert(
      submissionSchema.parse({
        submissionId: "proof-same-child-resume",
        title: "Same native child resume",
        repoPath: repository,
        planningCommit: planning,
        brief: { text: "Synthetic snooze resume proof" },
        originAgentId: "proof-origin",
      }),
      acpHost.hostId,
      "handoff",
      planning,
    );
    const acpWs = await acpHost.createWorkspace({
      title: "Same child worktree",
      requestId: "acp-ws",
      directory: acpWorktree,
      project: { projectId, workspaceRoot: repository },
    });
    acpStore.update(acpTask.id, {
      directory: acpWorktree,
      workspaceId: acpWs.id,
      phase: "working",
    });
    const prereqTask = acpStore.insert(
      submissionSchema.parse({
        submissionId: "proof-same-child-prereq",
        title: "Prereq task",
        repoPath: repository,
        planningCommit: planning,
        brief: { text: "Prereq" },
        originAgentId: "proof-origin",
      }),
      acpHost.hostId,
      "handoff",
      planning,
    );
    const codexReady = await until(async () => {
      const cfg = (await acpHost!.rpc.call("server.getConfig", {})) as {
        providers: Array<{
          instanceId: string;
          status: string;
          models: Array<{ slug: string }>;
        }>;
      };
      const codex = cfg.providers.find(
        (providerEntry) =>
          providerEntry.instanceId === "codex" &&
          providerEntry.status === "ready" &&
          providerEntry.models.length > 0,
      );
      return codex ?? null;
    }, "codex provider models ready");
    const acpProfile = {
      id: "proof-codex",
      name: "Codex",
      provider: "codex",
      model: codexReady.models[0]!.slug,
      available: true,
      problem: "",
      notes: "",
      supportedThinking: [],
    };
    const workerChild = await acpHost.createAgent({
      workspaceId: acpWs.id,
      profile: acpProfile,
      title: "Same child worker",
      taskNumber: acpTask.number,
      mcpBindingPath: null,
      attempt: () => ({
        requestId: "proof-same-child-launch",
        prompt: "Initial worker turn",
        labels: storedT3Labels("worker", {
          taskId: acpTask.id,
          runId: "proof-run-1",
        }),
        environment: {},
      }),
    });
    const parentRecord = acpHost.nesting.parentOf(acpTask.id)!;
    assert.ok(parentRecord, "real ACP parent created");
    const readParent = async () => {
      const value = (await rpc!.readStream(
        "orchestration.subscribeThread",
        { threadId: parentRecord.threadId },
        (chunk) => (chunk as { kind?: string }).kind === "snapshot",
      )) as {
        projection: {
          thread: {
            snoozedUntil: string | null;
            settledOverride: string | null;
          };
        };
      };
      return value.projection.thread;
    };
    // Wait for initial child turn to go idle.
    await until(async () => {
      const obs = await acpHost!.observe(workerChild.id);
      return !obs.active && obs.status === "idle" ? true : null;
    }, "worker child turn goes idle");
    acpStore.update(acpTask.id, {
      phase: "working",
      workspaceId: acpWs.id,
      directory: acpWorktree,
      agentId: workerChild.id,
      agentIntent: true,
      agentActive: false,
      idleSince: new Date().toISOString(),
      runId: "proof-run-1",
      prerequisiteWait: {
        id: prereqTask.id,
        waitsFor: [prereqTask.id],
        reason: "Waiting on prerequisite before resuming",
        releasedAt: null,
      },
    });
    await liveEngine.auditPass(false);
    const snoozedParentUntil = await until(
      async () => (await readParent()).snoozedUntil,
      "real ACP parent snoozed while waiting",
    );
    assert.ok(snoozedParentUntil);

    // Resume in the same native child ("proof-hold" keeps the resumed turn active), clear the wait,
    // and measure how long the immediate reconcile path takes until the parent row is visible on T3.
    await acpHost.sendMessage(workerChild.id, {
      messageId: `proof-resume-${crypto.randomUUID()}`,
      text: "proof-hold resume same native child",
    });
    await until(async () => {
      const obs = await acpHost!.observe(workerChild.id);
      return obs.active ? true : null;
    }, "same native child resumed active");
    acpStore.update(acpTask.id, {
      prerequisiteWait: null,
      agentActive: true,
      idleSince: null,
    });
    const activatedAt = Date.now();
    acpEngine.enqueueTitle(acpTask.id);
    await acpEngine.drainProjections({ cleanup: false });
    const reconcileMs = Date.now() - activatedAt;
    const afterResume = await readParent();
    assert.equal(
      afterResume.snoozedUntil,
      null,
      "real ACP parent unsnoozed promptly on role resume",
    );
    assert.equal(afterResume.settledOverride, null, "never settled");
    assert.equal(
      acpHost.state.read().snoozes?.[parentRecord.threadId],
      undefined,
    );
    steps.push({
      step: "same-native-child-idle-resume-reconcile",
      result: "passed",
      workerThreadId: workerChild.id,
      parentThreadId: parentRecord.threadId,
      reconcileMs,
    });

    evidence.result = "passed";
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await acpEngine?.stop().catch(() => undefined);
    acpHost?.close();
    acpStore?.close();
    await service?.stop().catch(() => undefined);
    host?.close();
    rpc?.close();
    await stopServer();
    writeFileSync(
      join(root, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      {
        mode: 0o600,
      },
    );
    console.log(
      JSON.stringify({
        result: evidence.result,
        steps,
        evidence: join(root, "evidence.json"),
        sha256: createHash("sha256")
          .update(JSON.stringify(evidence.steps))
          .digest("hex"),
        canonical: canonical(evidence.steps).length,
      }),
    );
  }
}

/** Every command identity this adapter recorded, whatever its status. */
function adapterIntentCount(host: {
  state: { read(): { intents: Record<string, unknown> } };
}): number {
  return Object.keys(host.state.read().intents).length;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
