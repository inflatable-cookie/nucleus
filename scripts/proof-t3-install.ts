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
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
import { decisionSchema, submissionSchema } from "../shared/contracts";
import { HOLD_MARKER, parentPromptRules } from "../hosts/t3code/nesting";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { AcpSessions } from "../core/acp/sessions";
import { Store } from "../core/store/store";
import type { Engine } from "../core/engine";

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
  const proxy = join(root, "bin", "acp-proxy.cjs");
  const acpLog = join(root, "acp-frames.log");
  writeFileSync(proxy, `const {spawn}=require("node:child_process"); const fs=require("node:fs");
` +
    `const child=spawn(${JSON.stringify(process.execPath)},["--import",${JSON.stringify(join(checkout, "node_modules/tsx/dist/loader.mjs"))},process.argv[2],...process.argv.slice(3)],{stdio:["pipe","pipe","pipe"]});
` +
    `function relay(source,dest,label){let buf="";source.on("data",chunk=>{dest.write(chunk);buf+=chunk;let i;while((i=buf.indexOf("\\n"))>=0){fs.appendFileSync(${JSON.stringify(acpLog)},label+buf.slice(0,i)+"\\n");buf=buf.slice(i+1)}})}
` +
    `relay(process.stdin,child.stdin,"IN ");relay(child.stdout,process.stdout,"OUT ");child.stderr.pipe(process.stderr);process.stdin.on("end",()=>child.stdin.end());child.on("exit",code=>process.exit(code??1));
`, { mode: 0o700 });
  writeFileSync(acpLauncher, `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`, { mode: 0o755 });
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
        "--scope",
        "preview:operate",
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
      bearer: { scopes: string[] };
    };
    assert.equal(status.ok, true, "status reports a usable connection");
    assert.ok(status.bearer.scopes.includes("preview:operate"), "runtime bearer can open previews");
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
      scopes: status.bearer.scopes,
      provider: status.provider,
      nativeParenting: status.service.nativeParenting,
    };
    note("status", {
      ok: status.ok,
      scopes: status.bearer.scopes,
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
      // Exercise the actual host sweep on this private service, not the operator's host.
      await service.debug({ target: "store", method: "setMeta", args: ["paused", false] });
      const sweep = async () => { await service!.debug({ target: "engine", method: "sweepOnce", args: [] }); };
      const inboxStatePath = join(nucleusData, "hosts", "t3code.json");
      const readInbox = () => {
        try { return (JSON.parse(readFileSync(inboxStatePath, "utf8")) as { inbox?: { threadId: string } }).inbox ?? null; }
        catch { return null; }
      };
      const inbox = await until(async () => { await sweep(); return readInbox(); }, "the private inbox", 90_000);
      type CardProjection = { thread: { pinnedAt?: string | null; snoozedUntil?: string | null }; runtimeRequests: Array<{ id: string; kind: string; status: string; answers?: Record<string, unknown> }>;
        turnItems: Array<{ type: string; status?: string; requestId?: string; questions?: Array<{ id: string }> }> };
      const threadSnapshot = async (threadId: string): Promise<CardProjection | null> => {
        let found: CardProjection | null = null;
        await rpc.readStream("orchestration.subscribeThread", { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true }, value => {
          const frame = value as { kind?: string; projection?: CardProjection };
          if (frame.kind === "snapshot" && frame.projection) found = frame.projection;
          return frame.kind === "synchronized";
        });
        return found;
      };
      const inboxSnapshot = () => threadSnapshot(inbox.threadId);
      await until(async () => { await sweep(); return (await inboxSnapshot())?.thread.pinnedAt ? true : null; }, "the inbox pin", 90_000);
      const preview = await until(async () => {
        await sweep();
        const value = await rpc.call("preview.list", { threadId: inbox.threadId }) as { sessions?: unknown[] };
        return value.sessions?.length ? value : null;
      }, "the inbox board preview", 90_000);
      note("inbox-preview", { threadId: inbox.threadId, count: preview.sessions?.length });
      const stamp = new Date().toISOString();
      const decisionId = randomUUID();
      await service.debug({ target: "store", method: "addDecision", args: [decisionSchema.parse({ id: decisionId, version: 1,
        question: "Synthetic inbox decision?", headline: "Synthetic decision", choices: [{ label: "Yes", consequence: "Proceed" }, { label: "No", consequence: "Hold" }],
        askedBy: { agentId: "synthetic" }, links: {}, status: "open", createdAt: stamp, updatedAt: stamp })] });
      const card = await until(async () => {
        await sweep();
        const projection = await inboxSnapshot();
        const request = projection?.runtimeRequests.find(row => row.kind === "user_input" && row.status === "pending");
        const item = projection?.turnItems.find(row => row.requestId === request?.id);
        return request && item?.questions?.[0] ? { request, question: item.questions[0] } : null;
      }, "the inbox decision card", 90_000);
      assert.equal(card.question.id, `nucleus_${decisionId}_1`);
      await rpc.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: `proof-answer-${randomUUID()}`,
        threadId: inbox.threadId, requestId: card.request.id, answers: { [card.question.id]: "Yes" } });
      const answered = await until(async () => {
        const value = await service!.debug({ target: "store", method: "decision", args: [decisionId] }) as { status: string; answer?: { answeredBy: string; text: string } };
        return value.status === "answered" ? value : null;
      }, "the operator answer", 90_000);
      assert.equal(answered.answer?.answeredBy, `operator (t3code:${descriptor.environmentId})`);
      assert.equal(answered.answer?.text, "Yes");
      note("inbox-answer", { decisionId, requestId: card.request.id, questionId: card.question.id, answeredBy: answered.answer?.answeredBy });

      const addDecision = async (label: string) => {
        const id = randomUUID();
        await service!.debug({ target: "store", method: "addDecision", args: [decisionSchema.parse({ id, version: 1,
          question: `Synthetic ${label}?`, headline: label, choices: [{ label: "Yes", consequence: "Proceed" }, { label: "No", consequence: "Hold" }],
          askedBy: { agentId: "synthetic" }, links: {}, status: "open", createdAt: stamp, updatedAt: stamp })] });
        return id;
      };
      const cardFor = async (id: string, excluded = "") => await until(async () => {
        await sweep();
        const projection = await inboxSnapshot();
        for (const item of projection?.turnItems ?? []) {
          if (!item.questions?.some(question => question.id === `nucleus_${id}_1`) || !item.requestId || item.requestId === excluded) continue;
          const request = projection?.runtimeRequests.find(row => row.id === item.requestId && row.status === "pending");
          if (request) return { request, question: item.questions[0]! };
        }
        return null;
      }, `card for ${id}`, 90_000);
      const settled = async (requestId: string, expected: string) => await until(async () => {
        await sweep();
        const projection = await inboxSnapshot();
        const request = projection?.runtimeRequests.find(row => row.id === requestId);
        return request?.status === expected ? request : null;
      }, `request to become ${expected}`, 90_000);

      const boardId = await addDecision("Synthetic board answer");
      const boardCard = await cardFor(boardId);
      await service.debug({ target: "runtime", method: "answerDecision", args: [{ id: boardId, version: 1, answer: "No", answeredBy: "operator (board)", relayed: false, note: "" }] });
      const boardSettled = await settled(boardCard.request.id, "resolved");
      assert.deepEqual((boardSettled as { answers?: unknown }).answers, { [boardCard.question.id]: "No" });
      note("board-answer-cleared-card", { decisionId: boardId, requestId: boardCard.request.id, status: boardSettled.status });

      const withdrawnId = await addDecision("Synthetic withdrawn decision");
      const withdrawnCard = await cardFor(withdrawnId);
      await service.debug({ target: "runtime", method: "withdrawDecision", args: [{ id: withdrawnId, version: 1, reason: "Synthetic withdrawal", withdrawnBy: "operator" }] });
      await settled(withdrawnCard.request.id, "resolved");
      assert.equal((await inboxSnapshot())?.turnItems.find(item => item.requestId === withdrawnCard.request.id)?.status, "cancelled");
      const withdrawn = await service.debug({ target: "store", method: "decision", args: [withdrawnId] }) as { status: string; answer: unknown };
      assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.answer, null);
      const frames = readFileSync(acpLog, "utf8").split("\n");
      const outgoing = frames.find(line => line.startsWith("OUT ") && line.includes(`nucleus_${withdrawnId}_1`));
      assert.ok(outgoing);
      const nativeId = (JSON.parse(outgoing.slice(4)) as { id: string }).id;
      await until(async () => readFileSync(acpLog, "utf8").split("\n").some(line => {
        if (!line.startsWith("IN ")) return false;
        try { const frame = JSON.parse(line.slice(3)) as { id?: string; result?: { action?: string } }; return frame.id === nativeId && frame.result?.action === "cancel"; } catch { return false; }
      }) ? true : null, "ACP cancel response", 30_000);
      note("withdrawal-cleared-card", { decisionId: withdrawnId, requestId: withdrawnCard.request.id, action: "cancel", recordedAnswer: false });

      const cancelledId = await addDecision("Synthetic operator cancel");
      const firstCard = await cardFor(cancelledId);
      await rpc.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: `proof-cancel-${randomUUID()}`,
        threadId: inbox.threadId, requestId: firstCard.request.id, decision: "cancel" });
      await settled(firstCard.request.id, "resolved");
      assert.equal((await inboxSnapshot())?.turnItems.find(item => item.requestId === firstCard.request.id)?.status, "cancelled");
      const secondCard = await cardFor(cancelledId, firstCard.request.id);
      await rpc.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: `proof-cancel-${randomUUID()}`,
        threadId: inbox.threadId, requestId: secondCard.request.id, decision: "cancel" });
      await settled(secondCard.request.id, "resolved");
      assert.equal((await inboxSnapshot())?.turnItems.find(item => item.requestId === secondCard.request.id)?.status, "cancelled");
      await delay(22_000); await sweep();
      const afterCancel = await inboxSnapshot();
      assert.equal((afterCancel?.runtimeRequests ?? []).filter(row => row.status === "pending" && (afterCancel?.turnItems ?? []).some(item => item.requestId === row.id && item.questions?.some(question => question.id === `nucleus_${cancelledId}_1`))).length, 0);
      assert.equal((await service.debug({ target: "store", method: "decision", args: [cancelledId] }) as { status: string }).status, "open");
      note("operator-cancel-reoffered-once", { decisionId: cancelledId, firstRequestId: firstCard.request.id, secondRequestId: secondCard.request.id, status: "open" });

      const restartId = await addDecision("Synthetic restart decision");
      const oldCard = await cardFor(restartId);
      rpc.close();
      const stopped = once(server!, "exit");
      server!.kill("SIGTERM");
      await stopped;
      server = spawn(t3.path!, t3Args(["--host", "127.0.0.1", "--port", String(port), "--no-browser"]),
        { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      collect(server.stdout!); collect(server.stderr!);
      await until(async () => (await fetch(`${endpoint}/.well-known/t3/environment`).catch(() => null))?.ok ? true : null, "private T3 restart", 60_000);
      await rpc.connect();
      await pump("the service to reconnect after T3 restart", () => health().t3code?.connected === true);
      const newCard = await cardFor(restartId, oldCard.request.id);
      assert.notEqual(newCard.request.id, oldCard.request.id);
      await rpc.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: `proof-answer-${randomUUID()}`,
        threadId: inbox.threadId, requestId: newCard.request.id, answers: { [newCard.question.id]: "Yes" } });
      const restartAnswer = await until(async () => {
        const row = await service!.debug({ target: "store", method: "decision", args: [restartId] }) as { status: string; version: number; answer?: { text: string } };
        return row.status === "answered" ? row : null;
      }, "the post-restart answer", 90_000);
      assert.equal(restartAnswer.version, 2); assert.equal(restartAnswer.answer?.text, "Yes");
      const reopened = await until(async () => {
        await sweep();
        const value = await rpc.call("preview.list", { threadId: inbox.threadId }) as { sessions?: unknown[] };
        return value.sessions?.length ? value : null;
      }, "the board preview after restart", 90_000);
      note("t3-restart", { decisionId: restartId, oldRequestId: oldCard.request.id, newRequestId: newCard.request.id, answerVersion: restartAnswer.version, previews: reopened.sessions?.length });

      const oldPreviewIds = new Set((reopened.sessions as Array<{ tabId?: string }>).map(row => row.tabId));
      await service.stop();
      service = new QueueService({ owner: { dataDir: nucleusData, timers: false }, fixture: "fake", debug: true });
      await service.start();
      await pump("the service to reconnect after its restart", () => health().t3code?.connected === true);
      const servicePreview = await until(async () => {
        await sweep();
        const value = await rpc.call("preview.list", { threadId: inbox.threadId }) as { sessions?: Array<{ tabId?: string }> };
        return value.sessions?.some(row => !oldPreviewIds.has(row.tabId)) ? value : null;
      }, "the board preview after service restart", 90_000);
      note("service-restart-preview", { threadId: inbox.threadId, previews: servicePreview.sessions?.length });

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
          text: HOLD_MARKER,
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

      // A second synthetic task uses the real parent launcher and row presentation.
      const taskDir = join(root, "task-parent-worktree");
      await git(["worktree", "add", "--quiet", "-b", "proof-task-parent", taskDir]);
      const rowTask = (await service.debug({ target: "store", method: "insert", args: [submissionSchema.parse({
        submissionId: "private-t3-row-proof", title: "Synthetic row", repoPath: repository, planningCommit: "a".repeat(40),
        brief: { text: "Synthetic row proof" }, originAgentId: "proof-origin" }), `t3code:${descriptor.environmentId}`, "brief", "a".repeat(40)] })) as { id: string };
      await service.debug({ target: "store", method: "update", args: [rowTask.id, { directory: taskDir, phase: "working" }] });
      // This second store reads only the private fixture database. The callback still
      // goes to the real private service which owns the answer and its side effects.
      const rowStore = new Store(join(nucleusData, "queue.sqlite"));
      const rowAcp = new AcpSessions({ store: rowStore } as Engine, { dataHome: nucleusData, socketPath: join(nucleusData, "callback.sock") });
      const rowHost = new T3CodeHost({ endpoint, bearer: proofSession.token, statePath: join(root, "row-host.json"), acp: () => rowAcp });
      try {
        await rowHost.connect(threadId);
        const rowWorkspace = await rowHost.createWorkspace({ title: "Synthetic row", requestId: "row-workspace", directory: taskDir, project: { projectId } });
        const workspaceRecord = rowHost.state.read().workspaces[rowWorkspace.id]!;
        const parent = await (rowHost.nesting as unknown as { launchParent(input: unknown, provider: unknown, acp: AcpSessions): Promise<{ threadId: string }> }).launchParent({
          attempt: { labels: { "nucleus.task": rowTask.id } }, spec: {}, title: "Synthetic row",
          workspace: { id: rowWorkspace.id, projectId: workspaceRecord.projectId, directory: taskDir },
        }, { ok: true, model: { slug: "nucleus" }, supportedRuntimeModes: ["full-access"] }, rowAcp);
        await until(async () => (await threadSnapshot(parent.threadId)) ? true : null, "the task parent", 60_000);
        const waiting = { state: "waiting" as const, cause: "Synthetic wait" };
        await rowHost.reconcileTaskRow(rowTask.id, waiting);
        await until(async () => (await threadSnapshot(parent.threadId))?.thread.snoozedUntil ? true : null, "the initial row snooze", 30_000);
        const rowDecision = randomUUID();
        await service.debug({ target: "store", method: "addDecision", args: [decisionSchema.parse({ id: rowDecision, version: 1,
          question: "Synthetic task question?", headline: "Task question", choices: [{ label: "Yes", consequence: "Proceed" }, { label: "No", consequence: "Hold" }],
          askedBy: { agentId: "synthetic" }, links: { tasks: [rowTask.id] }, status: "open", createdAt: stamp, updatedAt: stamp })] });
        const rowCard = await until(async () => {
          await rowHost.reconcileTaskRow(rowTask.id, waiting);
          const view = await threadSnapshot(parent.threadId);
          const item = view?.turnItems.find(item => item.questions?.some(question => question.id === `nucleus_${rowDecision}_1`));
          const request = view?.runtimeRequests.find(request => request.id === item?.requestId && request.status === "pending");
          return request && item?.questions?.[0] && view?.thread.snoozedUntil === null ? { request, question: item.questions[0] } : null;
        }, "task card and unsnoozed row", 90_000);
        await rpc.call("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId: `proof-row-answer-${randomUUID()}`,
          threadId: parent.threadId, requestId: rowCard.request.id, answers: { [rowCard.question.id]: "Yes" } });
        await until(async () => (await service!.debug({ target: "store", method: "decision", args: [rowDecision] }) as { status: string }).status === "answered" ? true : null, "task answer", 60_000);
        await until(async () => { await rowHost.reconcileTaskRow(rowTask.id, waiting); return (await threadSnapshot(parent.threadId))?.thread.snoozedUntil ? true : null; }, "row snoozes after answer", 60_000);
        note("task-parent-question", { taskId: rowTask.id, threadId: parent.threadId, decisionId: rowDecision, requestId: rowCard.request.id, unsnoozed: true, snoozedAfter: true });
      } finally { rowHost.close(); rowStore.close(); }
      await service.debug({ target: "store", method: "update", args: [rowTask.id, { phase: "done", finishedAt: new Date().toISOString() }] });
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
