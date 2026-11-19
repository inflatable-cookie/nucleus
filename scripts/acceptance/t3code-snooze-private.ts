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
import { T3RpcClient } from "../../hosts/t3code/rpc";
import { createHost } from "../../hosts/t3code";
import { canonical } from "../../hosts/t3code/state";
import { pipelineBoard } from "../../shared/pipeline-board";
import type { Task, TaskSummary } from "../../shared/contracts";

/** The nightly line this proof reads; the exact installed build is recorded, never pinned. */
const NIGHTLY_LINE = /^0\.1\.11-nightly\.\d+\.\d+$/;
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
    assert.ok(headerSize > 0 && headerSize < 16 * 1024 * 1024, "bounded header");
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
        assert.ok(linkTarget.startsWith(destination + sep), "link stays inside the fixture");
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
  const asar = asarArg >= 0 ? args[asarArg + 1] : process.env.NUCLEUS_T3_PROOF_ASAR;
  if (!asar)
    throw new Error(
      "Set NUCLEUS_T3_PROOF_ASAR or pass --asar with the installed nightly app archive",
    );
  const root = mkdtempSync(join(scratchRoot(), "t3-snooze-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const evidence: Record<string, unknown> = { nightlyLine: String(NIGHTLY_LINE), steps: [] };
  const steps = evidence.steps as unknown[];

  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  extractArchive(resolve(asar), bundle);
  const metadata = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8")) as {
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
  const repository = join(root, "synthetic-repository");
  const worktree = join(root, "synthetic-worktree");
  for (const path of [privateHome, data, join(data, "userdata"), repository])
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
  };
  await run(["git", "init", "--quiet", "--initial-branch=main"], repository, environment);
  await run(["git", "config", "user.email", "fixture@example.invalid"], repository, environment);
  await run(["git", "config", "user.name", "Synthetic fixture"], repository, environment);
  writeFileSync(join(repository, "fixture.txt"), "Synthetic private proof\n");
  await run(["git", "add", "fixture.txt"], repository, environment);
  await run(["git", "commit", "--quiet", "-m", "Synthetic fixture"], repository, environment);
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
  writeFileSync(
    join(data, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: provider, homePath: codexHome, setupMode: "existing" },
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
  const startServer = async () => {
    const log = openSync(join(root, "server.log"), "a", 0o600);
    server = spawn(
      process.execPath,
      [entry, "--base-dir", data, "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
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
        (await fetch(`${endpoint}/.well-known/t3/environment`).catch(() => null))?.ok ===
        true,
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
      environment: { serverVersion: string; orchestrationProtocolVersion: number };
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
        nesting: { state: "unavailable", reason: "no ACP sessions in this proof", at: new Date().toISOString() },
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
      )) as { projection: { thread: { snoozedUntil: string | null; settledOverride: string | null } } };
      return value.projection.thread;
    };
    const adapterSettles = () =>
      (host!.state.read().intents &&
        Object.values(host!.state.read().intents).filter(
          (intent) =>
            (intent as { kind?: string }).kind === "thread.settle" ||
            JSON.parse((intent as { payload: string }).payload).payload?.type ===
              "thread.settle",
        ).length) || 0;

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
    assert.equal(record?.until, first, "the adapter recorded the horizon it read back");
    assert.equal((await readThread()).settledOverride, null, "the row is never settled");
    steps.push({ step: "snooze-once-read-back", result: "passed" });

    // 2. A repeated pass inside the horizon adds no write.
    const commandsBefore = adapterIntentCount(host);
    await host.reconcileTaskRow(TASK_ID, { state: "waiting", cause: "Waiting on nucleus#1364" });
    await host.reconcileTaskRow(TASK_ID, { state: "waiting", cause: "Waiting on nucleus#1364" });
    assert.equal(adapterIntentCount(host), commandsBefore, "a repeated pass writes nothing");
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
    await host.reconcileTaskRow(TASK_ID, { state: "waiting", cause: "Waiting on nucleus#1364" });
    const renewed = await until(
      async () => {
        const untilValue = (await readThread()).snoozedUntil;
        return untilValue && Date.parse(untilValue) - Date.now() > SNOOZE_HORIZON_MS / 2
          ? untilValue
          : null;
      },
      "the renewed horizon",
    );
    assert.ok(Date.parse(renewed) > Date.now() + SNOOZE_HORIZON_MS / 2);
    steps.push({ step: "renew-before-horizon", result: "passed", horizon: renewed });

    // 4. A task that needs a person has the row unsnoozed.
    await host.reconcileTaskRow(TASK_ID, {
      state: "attention",
      cause: "Worker creation refused before send",
    });
    await until(async () => (await readThread()).snoozedUntil === null, "the unsnoozed row");
    assert.equal(host.state.read().snoozes?.[seedThreadId], undefined);
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
    await host.reconcileTaskRow(TASK_ID, { state: "waiting", cause: "Waiting on nucleus#1364" });
    await host.reconcileTaskRow(TASK_ID, { state: "attention", cause: "Needs a person" });
    assert.equal(
      adapterIntentCount(host),
      settledCommands,
      "a manual settle is neither snoozed over nor unsettled",
    );
    assert.equal((await readThread()).settledOverride, "settled");
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
    const pendingApproval = await until(
      async () => {
        const projection = await host!.readProjection(seedThreadId, "observation");
        return projection.runtimeRequests.find(
          (request) => request.status === "pending" && request.kind !== "user_input",
        );
      },
      "the pending approval",
    );
    assert.ok(pendingApproval, "the nightly holds a pending non-user-input approval");
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
    assert.equal(adapterSettles(), 0, "the adapter sent no thread.settle for the task");
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
    const ready = served.providers.find((provider) => provider.models.length > 0);
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
          /T3 provider not ready: this process serves no ACP sessions/.test(message) &&
          /nucleus t3 install/.test(message)
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
          until: { kind: "task", taskId: "0f8a2b3c-0000-4000-8000-000000000001" },
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

    evidence.result = "passed";
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    host?.close();
    rpc?.close();
    await stopServer();
    writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2), {
      mode: 0o600,
    });
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
function adapterIntentCount(host: { state: { read(): { intents: Record<string, unknown> } } }): number {
  return Object.keys(host.state.read().intents).length;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
