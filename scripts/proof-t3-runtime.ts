/**
 * nucleus#1377's private proof: the T3 task parent is the participant's runtime.
 *
 * A private, unmodified T3 server (an isolated home, base directory, port and
 * databases; never the operator's) hosts a real task parent thread on the Nucleus
 * ACP provider. The real `nucleus-acp` process runs with the task worktree as its
 * cwd, a private Nucleus service holds its turn, and the proof asks the production
 * proof functions, over the real host process listing, whether that process and its
 * native role children are this task's runtime or a tool:
 *
 * 1. the connected server is the process the server's own runtime descriptor
 *    records, under the base directory of the stored connection;
 * 2. the ACP parent is runtime while it holds the task's turn;
 * 3. an idle worker's owned-tool proof and the workspace proof that review and
 *    closeout read pass with the parent alive — and still hold for a real command
 *    running in the worktree;
 * 4. a real T3 delegated child — the parent's native role session — is runtime when
 *    its own environment names the recorded participant thread, and holds when the
 *    binding does not name it.
 * 5. another thread's provider app-server — the `<provider> app-server …` T3 starts
 *    under the same server — and the standing helpers it starts (`cua-driver mcp`,
 *    the provider's `node_repl`) are runtime even with the task worktree as their
 *    cwd; a real command one helper starts, a shell's own same-shaped app-server
 *    and a live run's report helper all still hold (nucleus#1397).
 *
 * Evidence is written to `evidence.json` beside the private root, with no bearer.
 * Run it through `effigy proof:t3:runtime`.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3RpcClient } from "../hosts/t3code/rpc";
import {
  HOLD_MARKER,
  childThreadId,
  parentPromptRules,
} from "../hosts/t3code/nesting";
import { QueueService } from "../service/transport/server";
import { findT3Cli } from "../shared/t3/operator";
import { submissionSchema } from "../shared/contracts";
import { readHostUidProcesses } from "../core/machine/host-process-listing";
import { ownedToolAgentProcessTreeVerdict } from "../core/machine/owned-tool-process-proof";
import {
  participantRuntime,
  t3AcpServerRuntime,
} from "../core/machine/participant-runtime";
import {
  acpTaskRuntimePids,
  possibleAcpRuntimePids,
} from "../core/machine/acp-task-runtime";
import { readAcpProcessIdentities } from "../core/machine/run-process-identity";
import { workspaceToolProcessIssue } from "../core/recovery/stall";

const checkout = fileURLToPath(new URL("..", import.meta.url));

function scratchRoot(): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (!root || !existsSync(root) || !statSync(root).isDirectory())
    throw new Error("The run scratch volume is required");
  return realpathSync(root);
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
  milliseconds = 90_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + milliseconds;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

async function run(
  argv: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; secret?: boolean },
): Promise<string> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr!.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolveRun(stdout);
      const detail = stderr
        .split("\n")
        .filter((line) => line.trim() && !/^\s+at /.test(line))
        .slice(-6)
        .join(" | ");
      reject(
        new Error(
          `${options.secret ? "credential" : "setup"} command exited ${code}: ${detail}`,
        ),
      );
    });
  });
}

interface Evidence {
  target: Record<string, unknown>;
  steps: Array<{ step: string; ok: boolean; facts: Record<string, unknown> }>;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const root = mkdtempSync(join(scratchRoot(), "t3-runtime-proof-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const evidence: Evidence = { target: {}, steps: [] };
  const note = (step: string, facts: Record<string, unknown>, ok = true) => {
    evidence.steps.push({ step, ok, facts });
    console.log(`${ok ? "ok" : "!!"} ${step} ${JSON.stringify(facts)}`);
  };

  const t3 = findT3Cli({ explicit: option("--t3") ?? null });
  assert.ok(
    t3.path,
    `No installed t3 command was found. Tried: ${t3.tried.join(", ")}`,
  );

  const privateHome = join(root, "home");
  const t3Data = join(root, "t3-data");
  const nucleusData = join(root, "ns");
  const tmp = join(root, "tmp");
  const helpersDirectory = join(root, "provider-helpers");
  for (const path of [privateHome, t3Data, nucleusData, tmp, helpersDirectory])
    mkdirSync(path, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: privateHome,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: join(privateHome, ".config"),
    XDG_DATA_HOME: join(privateHome, ".local/share"),
    XDG_CACHE_HOME: join(privateHome, ".cache"),
    T3CODE_HOME: t3Data,
    T3CODE_NO_BROWSER: "true",
    T3CODE_LOG_LEVEL: "Warn",
    NUCLEUS_DATA_HOME: nucleusData,
    // Only this proof's private server sets it: the synthetic provider then
    // writes and starts the session's standing helpers for the thread's cwd.
    NUCLEUS_T3_PROVIDER_HELPERS: helpersDirectory,
  };
  const t3Args = (rest: string[]) => [...rest, "--base-dir", t3Data];
  const acpLauncher = join(root, "bin", "nucleus-acp");
  mkdirSync(join(root, "bin"), { recursive: true });
  const tsx = join(checkout, "node_modules/tsx/dist/loader.mjs");
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsx)} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  // The synthetic Codex provider T3 spawns as `<binary> app-server …`, and the
  // directory its app-server writes the session's standing helpers into. No model
  // or account is used: the app-server answers T3's protocol locally.
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const syntheticCodex = join(root, "bin", "synthetic-codex");
  const syntheticPeer = fileURLToPath(
    new URL("./acceptance/t3code-provider.mjs", import.meta.url),
  );
  writeFileSync(
    syntheticCodex,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(syntheticPeer)} "$@"\n`,
    { mode: 0o755 },
  );
  mkdirSync(join(t3Data, "userdata"), { recursive: true });
  writeFileSync(
    join(t3Data, "userdata", "settings.json"),
    JSON.stringify(
      {
        providerInstances: {
          codex: {
            driver: "codex",
            enabled: true,
            config: { binaryPath: syntheticCodex, homePath: codexHome },
          },
        },
        notifications: { enabled: false },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    join(nucleusData, "settings.json"),
    JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
    { mode: 0o600 },
  );

  const repository = join(root, "synthetic-repository");
  const worktree = join(root, "synthetic-worktree");
  mkdirSync(repository);
  const git = async (argv: string[], cwd = repository) =>
    await run(["git", ...argv], {
      env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      cwd,
    });
  await git(["init", "--quiet", "."]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Synthetic fixture"]);
  writeFileSync(join(repository, "fixture.txt"), "Synthetic private proof\n");
  writeFileSync(
    join(repository, "build.mjs"),
    "setTimeout(() => {}, 120000);\n",
  );
  await git(["add", "fixture.txt", "build.mjs"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", "-b", "proof-worktree", worktree]);

  const children: ChildProcess[] = [];
  // Processes this proof started itself, signalled by pid in the private root.
  const strayPids: number[] = [];
  let server: ChildProcess | null = null;
  let service: QueueService | null = null;
  try {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const log = join(root, "t3-server.log");
    server = spawn(
      t3.path!,
      t3Args(["--host", "127.0.0.1", "--port", String(port), "--no-browser"]),
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(server);
    const collect = (stream: NodeJS.ReadableStream) =>
      stream.on("data", (bytes) => {
        const text = `${bytes}`.replace(
          /pairingUrl:\S+|#token=\S+/g,
          "[private pairing URL redacted]",
        );
        writeFileSync(log, text, { flag: "a" });
      });
    collect(server.stdout!);
    collect(server.stderr!);
    const descriptor = await until(async () => {
      const response = await fetch(
        `${endpoint}/.well-known/t3/environment`,
      ).catch(() => null);
      return response?.ok
        ? ((await response.json()) as {
            environmentId: string;
            serverVersion: string;
          })
        : null;
    }, "the private T3Code server");
    evidence.target = {
      t3Cli: t3.path,
      serverVersion: descriptor.serverVersion,
      environmentId: descriptor.environmentId,
      isolated: true,
    };
    note("private-t3-server", evidence.target);

    const proofSession = JSON.parse(
      await run(
        [
          t3.path!,
          ...t3Args([
            "auth",
            "session",
            "issue",
            "--scope",
            "orchestration:read",
            "--scope",
            "orchestration:operate",
            "--scope",
            "providers:manage",
            "--label",
            "proof",
            "--ttl",
            "1h",
            "--json",
          ]),
        ],
        { env: environment, cwd: root, secret: true },
      ),
    ) as { token: string };

    service = new QueueService({
      owner: { dataDir: nucleusData, timers: false },
      fixture: "fake",
      debug: true,
    });
    await service.start();
    const tick = async () => {
      await service!
        .debug({ target: "runtime", method: "ensureBootstrap", args: [] })
        .catch(() => undefined);
    };
    const whileTicking = async <T>(work: Promise<T>): Promise<T> => {
      const timer = setInterval(() => void tick(), 2_000);
      try {
        await tick();
        return await work;
      } finally {
        clearInterval(timer);
      }
    };
    const health = () =>
      service!.health() as unknown as {
        t3code?: { id?: string | null; connected?: boolean };
      };

    const install = JSON.parse(
      (
        await whileTicking(
          run(
            [
              process.execPath,
              join(checkout, "bin/nucleus-t3.mjs"),
              "t3",
              "install",
              "--base-dir",
              t3Data,
              "--t3",
              t3.path!,
              "--acp-command",
              acpLauncher,
              "--json",
            ],
            { env: environment, cwd: root },
          ),
        )
      ).trim(),
    ) as { steps?: unknown };
    note("install", { steps: install.steps });
    await until(async () => {
      await tick();
      return health().t3code?.connected === true &&
        health().t3code?.id === `t3code:${descriptor.environmentId}`
        ? true
        : null;
    }, "the service to come online as the private T3 host");

    // A synthetic task whose checkout is the private worktree, with the same binding
    // and host rules the production parent launcher mints.
    const task = (await service.debug({
      target: "store",
      method: "insert",
      args: [
        submissionSchema.parse({
          submissionId: "private-t3-runtime-proof",
          title: "Synthetic runtime proof task",
          repoPath: repository,
          planningCommit: "a".repeat(40),
          brief: { text: "Synthetic runtime proof task" },
          originAgentId: "proof-origin",
        }),
        "proof-host",
        "brief",
        "a".repeat(40),
      ],
    })) as { id: string };
    await service.debug({
      target: "store",
      method: "update",
      args: [task.id, { directory: worktree, phase: "working" }],
    });
    await service.debug({
      target: "runtime",
      method: "bindAcpSession",
      args: [{ taskId: task.id, ...parentPromptRules() }],
    });

    const rpc = new T3RpcClient({
      endpoint,
      bearer: proofSession.token,
      timeoutMs: 30_000,
    });
    await rpc.connect();
    try {
      const projectId = `proof-project-${Date.now()}`;
      await rpc.call("projects.mutate", {
        type: "project.create",
        commandId: `proof-project-${Date.now()}`,
        projectId,
        title: "Synthetic runtime proof project",
        workspaceRoot: repository,
      });
      const threadId = `proof-thread-${Date.now()}`;
      await rpc.call("orchestration.launchThread", {
        commandId: `proof-launch-${Date.now()}`,
        threadId,
        projectId,
        title: "runtime proof",
        modelSelection: { instanceId: "nucleus", model: "nucleus" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: worktree,
        },
        initialMessage: {
          messageId: `proof-message-${Date.now()}`,
          text: `${HOLD_MARKER}: ${task.id}`,
          attachments: [],
        },
      });
      type Projection = {
        thread: { id: string };
        runs: Array<{
          id: string;
          status: string;
          rootNodeId?: string;
        }>;
      };
      const snapshot = async (): Promise<Projection | null> => {
        let found: Projection | null = null;
        await rpc
          .readStream(
            "orchestration.subscribeThread",
            {
              threadId,
              requestCompletionMarker: true,
              acceptBoundedSnapshot: true,
            },
            (value) => {
              const item = value as { kind?: string; projection?: Projection };
              if (item.kind === "snapshot" && item.projection)
                found = item.projection;
              return item.kind === "synchronized";
            },
          )
          .catch(() => undefined);
        return found;
      };
      const launched = await until(async () => {
        const projection = await snapshot();
        return projection?.runs.some(
          (run) => run.status === "running" && run.rootNodeId,
        )
          ? projection
          : null;
      }, "the task-bound parent to hold a live turn");
      const held = launched.runs.find(
        (run) => run.status === "running" && run.rootNodeId,
      )!;
      note("parent-holds-turn", { threadId, runId: held.id });

      // 1. The connected server is the process the descriptor names.
      const serverRuntime = t3AcpServerRuntime(nucleusData);
      assert.ok(
        serverRuntime,
        "the stored connection proves a connected server",
      );
      const serverPid = serverRuntime.serverPid;
      let listing = await readHostUidProcesses();
      assert.equal(listing.state, "listed");
      const processes = listing.state === "listed" ? listing.processes : [];
      const serverFact = processes.find((fact) => fact.pid === serverPid);
      assert.ok(
        serverFact,
        "the descriptor's server pid is in the host listing",
      );
      const acpParents = processes.filter(
        (fact) =>
          fact.ppid === serverPid &&
          /nucleus-acp\.mjs(?:\s|$)/.test(fact.command),
      );
      assert.equal(
        acpParents.length,
        1,
        "one ACP parent is a child of the server",
      );
      const parentPid = acpParents[0]!.pid;
      const parentFact = processes.find((fact) => fact.pid === parentPid)!;
      assert.equal(
        realpathSync(parentFact.cwd!),
        realpathSync(worktree),
        "the ACP parent runs in the task worktree",
      );
      const identity = await until(async () => {
        const read = readAcpProcessIdentities([parentPid]).get(parentPid);
        return read ? read : null;
      }, "the ACP parent's own environment");
      note("connected-server-and-parent", {
        serverPid,
        parentPid,
        parentCwd: parentFact.cwd,
        parentEnvironmentRead: identity !== null,
      });

      // 2. The production recognition calls it this task's runtime.
      const runtimeForPass = (threadIds: string[]) =>
        participantRuntime({
          dataHome: nucleusData,
          tasks: [
            {
              id: task.id,
              agentId: null,
              hostId: `t3code:${descriptor.environmentId}`,
            },
          ],
          runs: threadIds.map((agentId) => ({
            taskId: task.id,
            agentId,
            hostId: `t3code:${descriptor.environmentId}`,
          })),
        });
      let runtime = runtimeForPass([]);
      let recognised = acpTaskRuntimePids(processes, runtime.acp ?? null);
      assert.ok(
        recognised.has(parentPid),
        "the ACP parent is this task's runtime",
      );
      assert.equal(
        workspaceToolProcessIssue(processes, worktree, ["proof-run"], runtime),
        null,
        "the parent never blocks the workspace proof",
      );
      note("parent-is-runtime", {
        recognised: [...recognised].sort((a, b) => a - b),
        parentPid,
      });

      // 3. An idle worker's owned-tool proof settles: no run ticket, and the
      // workspace tree carries no tool while the parent's turn is held.
      const idleVerdict = ownedToolAgentProcessTreeVerdict(
        ["proof-run"],
        processes,
        { noTurnLive: true, runtime },
      );
      assert.equal(idleVerdict.state, "unknown");
      const idleCode = idleVerdict.state === "unknown" ? idleVerdict.code : "";
      assert.equal(idleCode, "helper-missing");
      assert.equal(
        workspaceToolProcessIssue(processes, worktree, ["proof-run"], runtime),
        null,
      );
      note("idle-worker-proof", {
        ownedTool: idleCode,
        workspaceProof: "clear",
      });

      // 4. A real command in the worktree still holds, and clears when it exits.
      const command = spawn(process.execPath, [join(worktree, "build.mjs")], {
        cwd: worktree,
        env: environment,
        stdio: "ignore",
      });
      children.push(command);
      await delay(400);
      listing = await readHostUidProcesses();
      const withCommand = listing.state === "listed" ? listing.processes : [];
      const blocked = workspaceToolProcessIssue(
        withCommand,
        worktree,
        ["proof-run"],
        runtime,
      );
      assert.match(blocked ?? "", new RegExp(`process ${command.pid}`));
      command.kill("SIGKILL");
      await delay(400);
      listing = await readHostUidProcesses();
      const afterCommand = listing.state === "listed" ? listing.processes : [];
      assert.equal(
        workspaceToolProcessIssue(
          afterCommand,
          worktree,
          ["proof-run"],
          runtime,
        ),
        null,
      );
      note("command-holds-and-clears", { commandPid: command.pid });

      // 5. A real native role child: T3 creates the delegated task under the held
      // parent run and starts its own provider process for it.
      const commandId = `proof-child-${Date.now()}`;
      await rpc.call("orchestration.dispatchCommand", {
        type: "delegated_task.request",
        createdBy: "user",
        creationSource: "server",
        commandId,
        parentThreadId: threadId,
        parentRunId: held.id,
        parentNodeId: held.rootNodeId,
        task: "synthetic role session",
        title: "Synthetic role session",
        modelSelection: { instanceId: "nucleus", model: "nucleus" },
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "settled_only",
      });
      const child = childThreadId(commandId);
      const childPid = await until(
        async () => {
          const read = await readHostUidProcesses();
          const current = read.state === "listed" ? read.processes : [];
          const candidates = current.filter(
            (fact) => fact.ppid === serverPid && fact.pid !== parentPid,
          );
          const identities = readAcpProcessIdentities(
            candidates.map((fact) => fact.pid),
          );
          const match = candidates.find(
            (fact) => identities.get(fact.pid)?.t3ThreadId === child,
          );
          return match ? match.pid : null;
        },
        "T3 to start the delegated child session",
        60_000,
      );
      // The child's own environment is the fact the thread rule reads.
      const childIdentity = readAcpProcessIdentities([childPid]).get(childPid);
      assert.equal(childIdentity?.t3ThreadId, child);
      listing = await readHostUidProcesses();
      const childListing = listing.state === "listed" ? listing.processes : [];
      runtime = runtimeForPass([child]);
      assert.ok(
        acpTaskRuntimePids(childListing, runtime.acp ?? null).has(childPid),
        "the real native child is runtime through the shared recognition",
      );
      // The binding, not the shape, decides: a binding that names another task
      // leaves the same live child out.
      assert.equal(
        acpTaskRuntimePids(childListing, {
          ...runtime.acp!,
          taskIds: ["another-task"],
        }).has(childPid),
        false,
        "a child the binding does not name holds",
      );
      assert.equal(
        workspaceToolProcessIssue(
          childListing,
          worktree,
          ["proof-run"],
          runtime,
        ),
        null,
        "the native child never blocks review or closeout",
      );
      note("native-child-session", {
        childPid,
        childThread: child,
        childEnvironmentThread: childIdentity?.t3ThreadId,
        recognisedWithBinding: true,
        recognisedWithAnotherTaskBinding: false,
      });

      // 6. The provider app-server this server hosts (nucleus#1397): T3 starts
      // another thread's provider as `<provider> app-server …` under the same
      // server, and that app-server starts the session's standing helpers —
      // `cua-driver mcp` and the provider's `node_repl` — with the task worktree
      // as their cwd. They belong to no task, so one recognition owns them and
      // the workspace proof passes; a real command a helper starts, a shell's own
      // same-shaped app-server, and a live run's report helper all still hold.
      const served = (await rpc.call("server.getConfig", {})) as {
        providers: Array<{
          instanceId: string;
          models: Array<{ slug: string }>;
        }>;
      };
      const codexProvider = served.providers.find(
        (provider) => provider.instanceId === "codex" && provider.models.length,
      );
      assert.ok(
        codexProvider,
        "the private T3 lists the synthetic codex provider",
      );
      const codexThread = `proof-codex-${Date.now()}`;
      await rpc.call("orchestration.launchThread", {
        commandId: `proof-codex-launch-${Date.now()}`,
        threadId: codexThread,
        projectId,
        title: "provider app-server proof",
        modelSelection: {
          instanceId: "codex",
          model: codexProvider.models[0]!.slug,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: worktree,
        },
        initialMessage: {
          messageId: `proof-codex-message-${Date.now()}`,
          text: "proof-hold",
          attachments: [],
        },
      });
      const chain = await until(
        async () => {
          const read = await readHostUidProcesses();
          const current = read.state === "listed" ? read.processes : [];
          const appServer = current.find(
            (fact) =>
              fact.ppid === serverPid &&
              /(?:^|\s)app-server(?:\s|$)/.test(fact.command),
          );
          if (!appServer) return null;
          const helpers = current.filter((fact) => fact.ppid === appServer.pid);
          return helpers.length >= 2 ? { current, appServer, helpers } : null;
        },
        "the provider app-server and its standing helpers",
        60_000,
      );
      const chainRuntime = acpTaskRuntimePids(
        chain.current,
        runtime.acp ?? null,
      );
      assert.ok(
        chainRuntime.has(chain.appServer.pid),
        "the provider app-server is this server's own",
      );
      for (const helper of chain.helpers) {
        assert.ok(
          chainRuntime.has(helper.pid),
          `the standing helper ${helper.pid} is runtime`,
        );
        assert.equal(
          realpathSync(helper.cwd!),
          realpathSync(worktree),
          "the helper inherited the task worktree as its cwd",
        );
      }
      assert.equal(
        workspaceToolProcessIssue(
          chain.current,
          worktree,
          ["proof-run"],
          runtime,
        ),
        null,
        "the provider's own helpers never block review",
      );
      // Both ends of the chain are this proof's own processes: stop them even if
      // the private server's teardown does not.
      strayPids.push(
        chain.appServer.pid,
        ...chain.helpers.map((fact) => fact.pid),
      );
      note("provider-app-server-helpers", {
        appServerPid: chain.appServer.pid,
        helperPids: chain.helpers.map((fact) => fact.pid).sort((a, b) => a - b),
        helperCommands: chain.helpers.map((fact) => fact.command),
        helperCwd: chain.helpers[0]?.cwd ?? null,
      });

      // 6a. A real command the MCP helper started is work, not runtime.
      const helperMarker = join(helpersDirectory, "spawn-command");
      writeFileSync(helperMarker, "");
      const helperChildPid = await until(
        async () => {
          if (!existsSync(`${helperMarker}.pid`)) return null;
          const pid = Number(
            readFileSync(`${helperMarker}.pid`, "utf8").trim(),
          );
          return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
        },
        "a command the provider helper started",
        30_000,
      );
      strayPids.push(helperChildPid);
      listing = await readHostUidProcesses();
      const withHelperCommand =
        listing.state === "listed" ? listing.processes : [];
      assert.equal(
        acpTaskRuntimePids(withHelperCommand, runtime.acp ?? null).has(
          helperChildPid,
        ),
        false,
        "a command a helper starts is never runtime",
      );
      assert.match(
        workspaceToolProcessIssue(
          withHelperCommand,
          worktree,
          ["proof-run"],
          runtime,
        ) ?? "",
        new RegExp(`process ${helperChildPid} remains in the task workspace`),
        "a command a helper starts still holds",
      );
      process.kill(helperChildPid, "SIGKILL");
      await delay(400);

      // 6b. A shell's own same-shaped app-server is a tool: it holds, and cleanup
      // does not preserve it either.
      const strayShell = spawn(
        "/bin/sh",
        // A command list, not a single command: the shell stays and keeps the
        // pipe open, exactly as a shell a task's tools started would.
        ["-c", `${JSON.stringify(syntheticCodex)} app-server && true`],
        {
          cwd: worktree,
          env: { ...environment, NUCLEUS_T3_PROVIDER_HELPERS: "" },
          // The synthetic provider exits on stdin EOF, as its protocol says.
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      children.push(strayShell);
      const stray = await until(
        async () => {
          const read = await readHostUidProcesses();
          const current = read.state === "listed" ? read.processes : [];
          const appServer = current.find(
            (fact) => fact.ppid === strayShell.pid,
          );
          return appServer ? { processes: current, appServer } : null;
        },
        "a shell's own provider app-server",
        30_000,
      );
      strayPids.push(stray.appServer.pid);
      assert.equal(
        acpTaskRuntimePids(stray.processes, runtime.acp ?? null).has(
          stray.appServer.pid,
        ),
        false,
        "a same-shaped app-server a shell started is not T3's",
      );
      assert.equal(
        possibleAcpRuntimePids(stray.processes).has(stray.appServer.pid),
        false,
        "cleanup does not preserve a shell's app-server",
      );
      // The shell itself is in the worktree and owns no runtime shape, so it is
      // the first rooted process the proof names; its app-server is the other.
      assert.match(
        workspaceToolProcessIssue(
          stray.processes,
          worktree,
          ["proof-run"],
          runtime,
        ) ?? "",
        new RegExp(
          `process (?:${strayShell.pid}|${stray.appServer.pid}) remains in the task workspace`,
        ),
        "a shell's own app-server still holds",
      );
      strayShell.kill("SIGKILL");
      process.kill(stray.appServer.pid, "SIGKILL");
      await delay(400);

      // 6c. A live run's report helper keeps its own fence.
      const ticketRun = "11111111-2222-3333-4444-555555555555";
      const helperDir = join(root, "report-helper");
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(
        join(helperDir, "mcp-report.mjs"),
        "setInterval(() => {}, 120000);\n",
      );
      const reportHelper = spawn(
        process.execPath,
        [
          join(helperDir, "mcp-report.mjs"),
          join(root, "tickets", `mcp-${ticketRun}.json`),
        ],
        { cwd: worktree, env: environment, stdio: "ignore" },
      );
      children.push(reportHelper);
      await delay(400);
      listing = await readHostUidProcesses();
      const withReportHelper =
        listing.state === "listed" ? listing.processes : [];
      assert.match(
        workspaceToolProcessIssue(
          withReportHelper,
          worktree,
          [ticketRun],
          runtime,
        ) ?? "",
        new RegExp(
          `provider process ${reportHelper.pid} still carries the run MCP ticket`,
        ),
        "a live run's report helper still holds",
      );
      reportHelper.kill("SIGKILL");
      await delay(400);
      note("provider-helpers-negative-cases", {
        helperChildPid,
        shellAppServerPid: stray.appServer.pid,
        reportHelperPid: reportHelper.pid,
      });

      evidence.target.passed = true;
      writeFileSync(
        join(root, "evidence.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          passed: true,
          evidence: join(root, "evidence.json"),
          steps: evidence.steps.length,
        }),
      );
    } finally {
      rpc.close();
    }
  } catch (error) {
    writeFileSync(
      join(root, "evidence.json"),
      `${JSON.stringify(
        {
          ...evidence,
          failed: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    throw error;
  } finally {
    try {
      await service?.stop();
    } catch {
      /* the socket teardown is best effort */
    }
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue;
      child.kill("SIGTERM");
      await delay(200);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    for (const pid of strayPids)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    // The private server's own children — its provider app-servers — can outlive
    // it. Every process whose command names this run's private root is this
    // proof's own, so it is stopped here and named in the output.
    try {
      const read = await readHostUidProcesses();
      const leftovers =
        read.state === "listed"
          ? read.processes.filter((fact) => fact.command.includes(root))
          : [];
      for (const fact of leftovers)
        try {
          process.kill(fact.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      if (leftovers.length)
        console.log(
          JSON.stringify({
            leftoverChildPids: leftovers.map((fact) => fact.pid),
          }),
        );
    } catch {
      /* diagnostics only */
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
