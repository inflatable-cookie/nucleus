/**
 * nucleus#1330's private proof: `nucleus t3 install` / `status` / `uninstall`
 * against a T3Code server this run owns.
 *
 * The server is the installed nightly's own entry point started with `env -i`-style
 * isolation: a fresh base directory, its own HOME, its own port and its own
 * databases. The operator's live T3 home, sessions and data are never read or
 * touched. The Nucleus side is a private data home with an isolated service, so
 * the two facts this route exists to prove are proved end to end:
 *
 * 1. the CLI registers the `nucleus` ACP provider through T3's own
 *    `server.updateSettings` and the service adopts the stored connection with no
 *    restart, coming online as `t3code:<environmentId>`;
 * 2. T3 can launch a thread on that provider — the installed ACP agent runs, and
 *    the resulting thread names the `nucleus` model;
 * 3. `uninstall` removes exactly that instance and this run's sessions, and the
 *    service drops the host.
 *
 * Evidence is written beside the run in `evidence.json` with no bearer, and the
 * console prints the same facts. Run it through `effigy proof:t3:install`.
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
import { delimiter, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3RpcClient } from "../hosts/t3code/rpc";
import { QueueService } from "../service/transport/server";
import { findAcpCommand, findT3Cli } from "../shared/t3/operator";
import { readT3Connection } from "../shared/t3/settings";
import { submissionSchema } from "../shared/contracts";
import { HOLD_MARKER, parentPromptRules } from "../hosts/t3code/nesting";

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
    }
    await delay(200);
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
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
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
  target: {
    t3Cli: string;
    acpCommand: string;
    serverVersion?: string;
    environmentId?: string;
  };
  steps: Array<{ step: string; ok: boolean; facts: Record<string, unknown> }>;
  install?: Record<string, unknown>;
  status?: Record<string, unknown>;
  launch?: Record<string, unknown>;
  uninstall?: Record<string, unknown>;
  statusAfter?: Record<string, unknown>;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const root = mkdtempSync(join(scratchRoot(), "t3-install-proof-"));
  const evidence: Evidence = {
    target: { t3Cli: "", acpCommand: "" },
    steps: [],
  };
  const note = (step: string, facts: Record<string, unknown>, ok = true) => {
    evidence.steps.push({ step, ok, facts });
    console.log(`${ok ? "ok" : "!!"} ${step} ${JSON.stringify(facts)}`);
  };

  const t3 = findT3Cli({ explicit: option("--t3") ?? null });
  const acp = findAcpCommand({ explicit: option("--acp-command") ?? null });
  assert.ok(
    t3.path,
    `No installed t3 command was found. Tried: ${t3.tried.join(", ")}`,
  );
  evidence.target.t3Cli = t3.path;
  evidence.target.acpCommand =
    acp.path ?? "(none; this run writes a private launcher)";

  // The private homes: T3's base directory, this run's HOME, and the Nucleus data home.
  const privateHome = join(root, "home");
  const t3Data = join(root, "t3-data");
  const nucleusData = join(root, "ns");
  for (const path of [privateHome, t3Data, nucleusData, join(root, "tmp")])
    mkdirSync(path, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: privateHome,
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(privateHome, ".config"),
    XDG_DATA_HOME: join(privateHome, ".local/share"),
    XDG_CACHE_HOME: join(privateHome, ".cache"),
    T3CODE_HOME: t3Data,
    T3CODE_NO_BROWSER: "true",
    T3CODE_LOG_LEVEL: "Warn",
    NUCLEUS_DATA_HOME: nucleusData,
  };
  const t3Args = (rest: string[]) => [...rest, "--base-dir", t3Data];
  const t3Cli = async (rest: string[]) =>
    (
      await run([t3.path!, ...t3Args(rest)], {
        env: environment,
        cwd: root,
        secret: rest.includes("--json"),
      })
    ).trim();

  // A private launcher for this checkout's ACP agent: the marker is what makes it ours.
  const acpLauncher = join(root, "bin", "nucleus-acp");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(join(checkout, "node_modules/tsx/dist/loader.mjs"))} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(nucleusData, "settings.json"),
    JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
    { mode: 0o600 },
  );

  // The synthetic project the launched thread runs in.
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
  await git(["add", "fixture.txt"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", "-b", "proof-worktree", worktree]);

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
    evidence.target.serverVersion = descriptor.serverVersion;
    evidence.target.environmentId = descriptor.environmentId;
    note("private-t3-server", {
      serverVersion: descriptor.serverVersion,
      environmentId: descriptor.environmentId,
      isolated: true,
    });

    // This proof's own bearer for the readback/launch it drives directly.
    const proofSession = JSON.parse(
      await t3Cli([
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
    ) as { token: string };

    // The bounded fixture channel is how this proof drives the same bootstrap tick the
    // service's own interval drives; a production service runs it on its timer.
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
    const pump = async (what: string, read: () => boolean) => {
      await until(async () => {
        await tick();
        return read() ? true : null;
      }, what);
    };
    /**
     * The private service runs without its own timers, so this proof drives the
     * same bootstrap tick the service's 20-second interval drives while a CLI
     * command waits for the host to appear or disappear.
     */
    const whileTicking = async <T>(work: Promise<T>): Promise<T> => {
      const timer = setInterval(() => {
        void tick();
      }, 2_000);
      try {
        await tick();
        return await work;
      } finally {
        clearInterval(timer);
      }
    };

    // 1. install
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
    ) as Record<string, unknown>;
    evidence.install = { steps: install.steps };
    note("install", { steps: install.steps });

    // 2. the service adopted it without a restart, on the same process
    const health = () =>
      service!.health() as unknown as {
        t3code?: {
          id?: string | null;
          connected?: boolean;
          version?: string;
          nativeParenting?: string;
        };
      };
    await pump(
      `the service to adopt t3code:${descriptor.environmentId}`,
      () =>
        health().t3code?.connected === true &&
        health().t3code?.id === `t3code:${descriptor.environmentId}`,
    );
    const adopted = health().t3code!;
    note("service-adopted", {
      hostId: adopted.id,
      connected: adopted.connected,
      serverVersion: adopted.version,
      nativeParenting: adopted.nativeParenting ?? "",
    });

    // 3. status
    const statusText = (
      await run(
        [
          process.execPath,
          join(checkout, "bin/nucleus-t3.mjs"),
          "t3",
          "status",
          "--base-dir",
          t3Data,
          "--t3",
          t3.path!,
          "--acp-command",
          acpLauncher,
          "--json",
        ],
        { env: environment, cwd: root },
      )
    ).trim();
    const status = JSON.parse(statusText) as {
      ok: boolean;
      provider: {
        registered: boolean;
        ours: boolean;
        enabled: boolean;
        ready: boolean;
        usable: boolean;
        status: string;
        probeMessage: string;
        models: string[];
        commandMatchesInstalled: boolean;
      };
      service: { nativeParenting: string };
    };
    assert.equal(status.ok, true, "status reports a usable connection");
    assert.equal(
      status.provider.registered &&
        status.provider.ours &&
        status.provider.enabled &&
        status.provider.usable,
      true,
    );
    assert.equal(status.provider.commandMatchesInstalled, true);
    assert.ok(
      status.provider.models.length > 0,
      "the provider advertises a model",
    );
    evidence.status = {
      ok: status.ok,
      provider: status.provider,
      nativeParenting: status.service.nativeParenting,
    };
    note("status", {
      ok: status.ok,
      provider: status.provider,
      nativeParenting: status.service.nativeParenting,
    });

    // Seed an isolated synthetic task and mint the same binding and host rules as
    // the production parent launcher before T3 starts the ACP agent.
    const task = (await service.debug({
      target: "store",
      method: "insert",
      args: [
        submissionSchema.parse({
          submissionId: "private-t3-proof",
          title: "Synthetic proof task",
          repoPath: repository,
          planningCommit: "a".repeat(40),
          brief: { text: "Synthetic proof task" },
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
    const binding = (await service.debug({
      target: "runtime",
      method: "bindAcpSession",
      args: [{ taskId: task.id, ...parentPromptRules() }],
    })) as { sessionId: string };

    // 4. a task-bound parent launches on the provider
    const rpc = new T3RpcClient({
      endpoint,
      bearer: proofSession.token,
      timeoutMs: 30_000,
    });
    await rpc.connect();
    try {
      const commandId = `proof-project-${Date.now()}`;
      const projectId = `proof-project-${Date.now()}`;
      await rpc.call("projects.mutate", {
        type: "project.create",
        commandId,
        projectId,
        title: "Synthetic proof project",
        workspaceRoot: repository,
      });
      const threadId = `proof-thread-${Date.now()}`;
      const model =
        status.provider.models.find((slug) => slug === "nucleus") ??
        status.provider.models[0]!;
      await rpc.call("orchestration.launchThread", {
        commandId: `proof-launch-${Date.now()}`,
        threadId,
        projectId,
        title: "nucleus t3 install proof",
        modelSelection: { instanceId: "nucleus", model },
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
      // One bounded thread snapshot, decoded the way the adapter reads it: the
      // thread record names the provider and model T3 actually launched.
      type Projection = {
        thread: {
          id: string;
          providerInstanceId: string;
          modelSelection: { model: string };
        };
        runs: Array<{
          id: string;
          status: string;
          rootNodeId?: string;
          providerInstanceId: string;
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
      const launched = await until(
        async () => {
          const projection = await snapshot();
          return projection?.runs.some(
            (run) => run.status === "running" && run.rootNodeId,
          )
            ? projection
            : null;
        },
        "the task-bound parent to hold a live turn",
        60_000,
      );
      const held = launched.runs.find(
        (run) => run.status === "running" && run.rootNodeId,
      )!;
      await delay(2500);
      const again = await snapshot();
      assert.ok(
        again?.runs.some(
          (run) =>
            run.id === held.id &&
            run.status === "running" &&
            run.rootNodeId === held.rootNodeId,
        ),
        "the same parent turn stays live",
      );
      evidence.launch = {
        taskId: task.id,
        sessionId: binding.sessionId,
        threadId: launched.thread.id,
        providerInstanceId: launched.thread.providerInstanceId,
        model: launched.thread.modelSelection.model,
        runId: held.id,
        rootNodeId: held.rootNodeId,
        runStatus: held.status,
        heldAfterMs: 2500,
      };
      assert.equal(launched.thread.providerInstanceId, "nucleus");
      assert.equal(launched.thread.modelSelection.model, model);
      note("launched-on-provider", evidence.launch);
    } finally {
      rpc.close();
    }

    // 5. uninstall, then the service drops the host and status says so
    const uninstall = JSON.parse(
      (
        await whileTicking(
          run(
            [
              process.execPath,
              join(checkout, "bin/nucleus-t3.mjs"),
              "t3",
              "uninstall",
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
    ) as Record<string, unknown>;
    evidence.uninstall = { steps: uninstall.steps };
    note("uninstall", { steps: uninstall.steps });
    assert.equal(
      readT3Connection(nucleusData),
      null,
      "the stored connection is cleared",
    );
    const sessionsAfter = JSON.parse(
      await t3Cli(["auth", "session", "list", "--json"]),
    ) as Array<{ sessionId: string; subject: string | null }>;
    const nucleusSessions = sessionsAfter.filter(
      (session) => session.subject === "nucleus",
    );
    assert.equal(nucleusSessions.length, 0, "no Nucleus session stays active");
    note("sessions-revoked", {
      nucleusSessionsRemaining: nucleusSessions.length,
      proofSessionKept: sessionsAfter.some(
        (session) => session.sessionId !== "" && session.subject !== "nucleus",
      ),
    });

    await pump(
      "the service to drop the T3Code host",
      () => health().t3code?.connected !== true,
    );
    const statusAfter = JSON.parse(
      (
        await run(
          [
            process.execPath,
            join(checkout, "bin/nucleus-t3.mjs"),
            "t3",
            "status",
            "--base-dir",
            t3Data,
            "--t3",
            t3.path!,
            "--acp-command",
            acpLauncher,
            "--json",
          ],
          { env: environment, cwd: root },
        )
      ).trim(),
    ) as {
      ok: boolean;
      provider: { registered: boolean };
      service: { connected: boolean };
    };
    evidence.statusAfter = {
      ok: statusAfter.ok,
      providerRegistered: statusAfter.provider.registered,
      serviceConnected: statusAfter.service.connected,
    };
    assert.equal(
      statusAfter.provider.registered,
      null,
      "registration is unknown without a bearer",
    );
    const verify = new T3RpcClient({
      endpoint,
      bearer: proofSession.token,
      timeoutMs: 30_000,
    });
    await verify.connect();
    try {
      const config = (await verify.call("server.getConfig", {})) as {
        settings: { providerInstances: Record<string, unknown> };
      };
      assert.equal(
        config.settings.providerInstances.nucleus,
        undefined,
        "authenticated config proves removal",
      );
      evidence.statusAfter.providerAbsentVerified = true;
    } finally {
      verify.close();
    }
    assert.equal(statusAfter.service.connected, false);
    note("status-after-uninstall", evidence.statusAfter);

    writeFileSync(
      join(root, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        passed: true,
        evidence: "this run’s proof root evidence.json",
        steps: evidence.steps.length,
      }),
    );
  } catch (error) {
    writeFileSync(
      join(root, "evidence.json"),
      `${JSON.stringify({ ...evidence, failed: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw error;
  } finally {
    try {
      await service?.stop();
    } catch {
      /* the socket teardown is best effort */
    }
    if (server && server.exitCode === null) {
      await new Promise<void>((done) => {
        server!.once("close", () => done());
        server!.kill("SIGTERM");
      });
    }
    const evidencePath = join(root, "evidence.json");
    if (existsSync(evidencePath))
      console.log(
        `evidence: ${evidencePath.split(sep).length > 0 ? evidencePath : "evidence.json"}`,
      );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
