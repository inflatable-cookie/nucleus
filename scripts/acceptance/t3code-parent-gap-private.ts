/**
 * nucleus#1400's private proof for the task parent: a held parent keeps its turn, binding
 * and ACP session through a callback-socket gap while a child runs, and the same held parent
 * takes a new child for the next role after the first child is interrupted.
 *
 * The T3 server is the installed nightly's own `t3` command, started with its own home, base
 * directory and databases. The Nucleus service is a private
 * data home whose callback socket carries the parent's held turn; a restart replaces that
 * socket. The parent and its children are created by an in-process T3 host over the same
 * store, as the held-turn proof does. A child's provider is the synthetic codex app-server in
 * this directory, which keeps a turn running while its prompt carries `proof-hold`.
 *
 * Steps:
 * 1. launch: the first reviewer child launches the parent, the parent holds a live run, and
 *    the child runs;
 * 2. roll while held: a 4 s socket gap leaves the parent run, the child run, the binding and
 *    the session as they were;
 * 3. sustained outage: a 40 s gap leaves the same facts and shows one fault line;
 * 4. child resuming: the first child is interrupted, a second child is created under the same
 *    held parent, and a short gap leaves the parent and the second child running.
 *
 * Not covered: an open decision on the parent (the decision card is raised by the service's
 * own adapter, which is not in this process). Evidence is compact JSON per step with the
 * server log's sha256. Run through `effigy proof:t3code:parent-gap`.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3RpcClient } from "../../hosts/t3code/rpc";
import { T3CodeHost } from "../../hosts/t3code/adapter";
import { activeStatuses } from "../../hosts/t3code/reads";
import { QueueService } from "../../service/transport/server";
import { AcpSessions } from "../../core/acp/sessions";
import { Store } from "../../core/store/store";
import type { Engine } from "../../core/engine";
import { acpBindingPath, readAcpBinding } from "../../shared/acp/binding";
import { submissionSchema } from "../../shared/contracts";
import type { Profile } from "../../shared/schema/settings/pool";
import { WIRE_LABEL_KEYS } from "../../shared/wire-labels";
import {
  NIGHTLY_LINE,
  freePort,
  run,
  scratchRoot,
  until,
} from "./t3code-private-kit";
import { findT3Cli } from "../../shared/t3/operator";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const FAULT = "Nucleus is unreachable";
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const decisionStatusOf = async (service: QueueService, id: string) =>
  (
    (await service.debug({
      target: "runtime",
      method: "getDecision",
      args: [{ id }],
    })) as { status: string }
  ).status;

type Message = { id: string; role: string; text: string };
type Projection = {
  thread: { id: string; providerInstanceId: string };
  runs: Array<{ id: string; status: string; rootNodeId?: string | null }>;
  messages: Message[];
  runtimeRequests: Array<{ id: string; kind: string; status: string }>;
  turnItems: Array<{
    type: string;
    requestId?: string;
    questions?: Array<{ id: string }>;
  }>;
};

async function main() {
  const root = mkdtempSync(join(scratchRoot(), "t3-parent-gap-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const steps: Array<{ step: string; facts: Record<string, unknown> }> = [];
  const note = (step: string, facts: Record<string, unknown>) => {
    steps.push({ step, facts });
    console.log(`ok ${step} ${JSON.stringify(facts)}`);
  };

  // The installed nightly's own `t3` command, as the reoffer proof starts it.
  const t3Cli = findT3Cli({ explicit: process.env.NUCLEUS_T3_CLI ?? null });
  assert.ok(
    t3Cli.path,
    `No installed t3 command was found. Tried: ${t3Cli.tried.join(", ")}`,
  );
  const t3 = t3Cli.path;

  // Private homes: T3's base directory, this run's HOME, the Nucleus data home and temp.
  const privateHome = join(root, "home");
  const t3Data = join(root, "t3-data");
  const nucleusData = join(root, "ns");
  const codexHome = join(root, "codex-home");
  for (const path of [
    privateHome,
    join(t3Data, "userdata"),
    nucleusData,
    codexHome,
    join(root, "bin"),
    join(root, "tmp"),
  ])
    mkdirSync(path, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
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

  // The synthetic codex app-server a child runs on, and its provider instance in T3's settings.
  const peer = join(checkout, "scripts/acceptance/t3code-provider.mjs");
  const codex = join(root, "bin", "synthetic-codex");
  writeFileSync(
    codex,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(peer)} "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(t3Data, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: {
            binaryPath: codex,
            homePath: codexHome,
            setupMode: "existing",
          },
        },
      },
      notifications: { enabled: false },
    }),
    { mode: 0o600 },
  );

  // The Nucleus ACP launcher the T3 provider runs.
  const acpLauncher = join(root, "bin", "nucleus-acp");
  const tsxLoader = join(checkout, "node_modules/tsx/dist/loader.mjs");
  const acpStderr = join(root, "acp-stderr.log");
  // The launcher keeps the agent's stderr in this run's scratch by redirecting the shell's own
  // stderr before the exec. The install's marker check reads the final exec line, so the shape
  // of that line is the same as the held-turn proof's launcher.
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec 2>>${JSON.stringify(acpStderr)}\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsxLoader)} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(nucleusData, "settings.json"),
    JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
    { mode: 0o600 },
  );

  // A synthetic repository and the task's worktree.
  const repository = join(root, "synthetic-repository");
  const taskDir = join(root, "task-worktree");
  mkdirSync(repository);
  const git = (argv: string[]) =>
    run(["git", ...argv], {
      env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      cwd: repository,
    });
  await git(["init", "--quiet", "."]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Synthetic fixture"]);
  writeFileSync(join(repository, "fixture.txt"), "Synthetic private proof\n");
  await git(["add", "fixture.txt"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", "-b", "proof-task-parent", taskDir]);

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const t3Log = join(root, "t3-server.log");
  const collect = (stream: NodeJS.ReadableStream) =>
    stream.on("data", (bytes) =>
      writeFileSync(
        t3Log,
        `${bytes}`.replace(
          /pairingUrl:\S+|#token=\S+/g,
          "[private pairing URL redacted]",
        ),
        { flag: "a" },
      ),
    );
  let server: ChildProcess | null = spawn(
    t3,
    [
      "--base-dir",
      t3Data,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  assert.match(descriptor.serverVersion, NIGHTLY_LINE);
  note("private-t3-server", {
    serverVersion: descriptor.serverVersion,
    isolated: true,
  });

  const bearer = JSON.parse(
    await run(
      [
        t3,
        "auth",
        "session",
        "issue",
        "--base-dir",
        t3Data,
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
      ],
      { env: environment, cwd: root, secret: true },
    ),
  ).token as string;

  // The Nucleus service: its callback socket carries the held turn, and a restart replaces it.
  const socketPath = join(nucleusData, "callback.sock");
  let service = new QueueService({
    owner: { dataDir: nucleusData, timers: false },
    fixture: "fake",
    debug: true,
  });
  await service.start();
  const hostId = `t3code:${descriptor.environmentId}`;
  const tick = async () => {
    await service
      .debug({ target: "runtime", method: "ensureBootstrap", args: [] })
      .catch(() => undefined);
  };
  const health = () =>
    service.health() as unknown as {
      t3code?: { connected?: boolean; id?: string | null };
    };
  // The provider's own test session can refuse on the first install while the service's
  // socket is still settling; `nucleus t3 install` is the route that says so, and it is run
  // again until the provider reports ready.
  type InstallStep = { step: string; ok: boolean; detail?: string };
  const installOnce = async (): Promise<{ steps: InstallStep[] }> => {
    const timer = setInterval(() => void tick(), 2_000);
    try {
      await tick();
      return JSON.parse(
        (
          await run(
            [
              process.execPath,
              join(checkout, "bin/nucleus-t3.mjs"),
              "t3",
              "install",
              "--base-dir",
              t3Data,
              "--t3",
              t3,
              "--acp-command",
              acpLauncher,
              "--json",
            ],
            { env: environment, cwd: root },
          )
        ).trim(),
      ) as { steps: InstallStep[] };
    } finally {
      clearInterval(timer);
    }
  };
  const isReady = (result: { steps: InstallStep[] }) =>
    result.steps.some(
      (row) =>
        row.step === "Provider instance" && /, ready\b/.test(row.detail ?? ""),
    );
  let install = await installOnce();
  for (let attempt = 2; attempt <= 3 && !isReady(install); attempt++) {
    await delay(5_000);
    install = await installOnce();
  }
  if (!isReady(install))
    throw new Error(
      `the nucleus provider reports ready after install: ${JSON.stringify(install.steps)}`,
    );
  await until(
    async () => {
      await tick();
      return health().t3code?.connected === true &&
        health().t3code?.id === hostId
        ? true
        : null;
    },
    "the service to adopt the private T3Code",
    90_000,
  );
  note("install-and-adopt", { install: install.steps, hostId });

  // The task: a real checkout in the store, with the T3 host that will run it.
  const planning = "a".repeat(40);
  const task = (await service.debug({
    target: "store",
    method: "insert",
    args: [
      submissionSchema.parse({
        submissionId: "parent-gap-proof",
        title: "Parent gap proof",
        repoPath: repository,
        planningCommit: planning,
        brief: { text: "Synthetic parent gap proof" },
        originAgentId: "proof-origin",
      }),
      hostId,
      "brief",
      planning,
    ],
  })) as { id: string };
  await service.debug({
    target: "store",
    method: "update",
    args: [task.id, { directory: taskDir, phase: "working" }],
  });
  await service.debug({
    target: "store",
    method: "setMeta",
    args: ["paused", false],
  });

  // The in-process T3 host over the same store: it creates the parent and its children.
  const rowStore = new Store(join(nucleusData, "queue.sqlite"));
  const rowAcp = new AcpSessions({ store: rowStore } as unknown as Engine, {
    dataHome: nucleusData,
    socketPath,
  });
  const rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 30_000 });
  await rpc.connect();
  const projectId = `parent-gap-project-${Date.now()}`;
  await rpc.call("projects.mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "Synthetic parent gap",
    workspaceRoot: repository,
  });
  const rowHost = new T3CodeHost({
    endpoint,
    bearer,
    statePath: join(root, "host.json"),
    acp: () => rowAcp,
  });
  await rowHost.connect();
  const workspace = await rowHost.createWorkspace({
    title: "Parent gap proof",
    requestId: "parent-gap-workspace",
    directory: taskDir,
    project: { projectId },
  });
  const workspaceRecord = rowHost.state.read().workspaces[workspace.id]!;
  const nesting = rowHost.nesting as unknown as {
    parentOf(
      taskId: string,
    ): { threadId: string; sessionId: string } | undefined;
  };

  const profile: Profile = {
    id: "codex-proof",
    name: "Codex proof",
    provider: "codex",
    model: "gpt-5.4",
    notes: "",
    available: true,
    problem: "",
    supportedThinking: [],
  };
  const createChild = (requestId: string) =>
    rowHost.createAgent({
      workspaceId: workspace.id,
      profile,
      title: "Parent gap proof",
      taskNumber: null,
      mcpBindingPath: null,
      attempt: () => ({
        requestId,
        prompt: `proof-hold reviewer child ${requestId}`,
        labels: {
          [WIRE_LABEL_KEYS.task]: task.id,
          [WIRE_LABEL_KEYS.role]: "reviewer",
        },
        environment: {},
      }),
    } as unknown as Parameters<T3CodeHost["createAgent"]>[0]) as Promise<{
      id: string;
    }>;

  const project = async (threadId: string): Promise<Projection | null> => {
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
          const frame = value as { kind?: string; projection?: Projection };
          if (frame.kind === "snapshot" && frame.projection)
            found = frame.projection;
          return frame.kind === "synchronized";
        },
      )
      .catch(() => undefined);
    return found;
  };
  const liveRun = (view: Projection | null) =>
    view?.runs.find((row) => activeStatuses.has(row.status as never)) ?? null;
  const faultLines = (view: Projection | null) =>
    view
      ? view.messages.reduce(
          (total, message) => total + (message.text.split(FAULT).length - 1),
          0,
        )
      : -1;
  const parentThread = () => nesting.parentOf(task.id)!;

  // 1. launch: the first child launches the parent, the parent holds a live run, and the child runs.
  const child1 = await createChild("gap-child-1");
  const parent = parentThread();
  // The parent's run is live and its first line is shown: the ACP session has attached, so the
  // roll below meets a held turn rather than a session still opening.
  const parentFirst = await until(
    async () => {
      const view = await project(parent.threadId);
      return liveRun(view) &&
        view!.messages.some((message) => message.role === "assistant")
        ? view
        : null;
    },
    "the parent to hold a live run and show its first line",
    150_000,
  );
  const parentRun = liveRun(parentFirst)!;
  const childRun = await until(
    async () => {
      const view = await project(child1.id);
      return liveRun(view) ? liveRun(view) : null;
    },
    "the first child to run",
    150_000,
  );
  const bindingPath = acpBindingPath(nucleusData, taskDir);
  const binding = sha256(bindingPath);
  const session = readAcpBinding(bindingPath).sessionId;
  assert.equal(
    session,
    parent.sessionId,
    "the parent's binding names its ACP session",
  );
  note("launch", {
    parentThread: parent.threadId,
    parentRun: parentRun.id,
    childThread: child1.id,
    childRun: childRun.id,
    session,
  });

  const restartService = async (gapMs: number) => {
    await service.stop();
    assert.equal(existsSync(socketPath), false, "the old socket is gone");
    await delay(gapMs);
    service = new QueueService({
      owner: { dataDir: nucleusData, timers: false },
      fixture: "fake",
      debug: true,
    });
    await service.start();
    await until(
      async () => {
        await tick();
        return health().t3code?.connected === true ? true : null;
      },
      "the service to reconnect to the same T3 host",
      90_000,
    );
    assert.equal(existsSync(socketPath), true, "the new socket exists");
  };

  // The facts a gap must leave alone: the parent's run, the child's run, the binding and the session.
  const gapFacts = async (
    label: string,
    gapMs: number,
    faultsBefore: number,
    expectRun: string,
    childId: string,
  ) => {
    await restartService(gapMs);
    await delay(8_000);
    const view = await project(parent.threadId);
    assert.ok(
      view,
      `${label}: the parent projection is readable after the gap`,
    );
    const run = view.runs.find((row) => row.id === expectRun);
    const diagnostic = () =>
      JSON.stringify({
        runs: view.runs.map((row) => [row.id, row.status]),
        messages: view.messages.map((message) => [
          message.role,
          message.text.slice(0, 160),
        ]),
      });
    assert.ok(
      run && activeStatuses.has(run.status as never),
      `${label}: the parent's run stays live: ${diagnostic()}`,
    );
    const child = await project(childId);
    assert.ok(
      child && liveRun(child),
      `${label}: the child keeps running: ${JSON.stringify(child?.runs.map((row) => [row.id, row.status]) ?? null)}`,
    );
    assert.equal(
      sha256(bindingPath),
      binding,
      `${label}: the same binding remains`,
    );
    assert.equal(
      readAcpBinding(bindingPath).sessionId,
      session,
      `${label}: the same session remains`,
    );
    return {
      parentRun: run.id,
      parentRunStatus: run.status,
      faultLinesAdded: faultLines(view) - faultsBefore,
    };
  };

  // 2. roll while held, with the child running.
  const rollFaults = faultLines(parentFirst);
  const roll = await gapFacts(
    "roll-while-held",
    4_000,
    rollFaults,
    parentRun.id,
    child1.id,
  );
  note("roll-while-held", { gapMs: 4_000, child: child1.id, ...roll });

  // 3. sustained outage, with the child running.
  const sustainedFaultsBefore = faultLines(await project(parent.threadId));
  const sustained = await gapFacts(
    "sustained-outage",
    40_000,
    sustainedFaultsBefore,
    parentRun.id,
    child1.id,
  );
  // The outage's fault line is the agent's own record, and T3 can land a streamed chunk
  // after the first read. The count gets a bounded window before it is called absent.
  let sustainedAdded = sustained.faultLinesAdded;
  for (let waited = 0; sustainedAdded !== 1 && waited < 30_000; waited += 1_000) {
    await delay(1_000);
    sustainedAdded =
      faultLines(await project(parent.threadId)) - sustainedFaultsBefore;
  }
  if (sustainedAdded !== 1) {
    const view = await project(parent.threadId);
    const agentLog = existsSync(acpStderr)
      ? readFileSync(acpStderr, "utf8").split("\n").filter(Boolean).slice(-12)
      : [];
    throw new Error(
      `a sustained outage shows one fault line, saw ${sustainedAdded}: ${JSON.stringify(
        {
          runs: view?.runs.map((row) => [row.id, row.status]) ?? null,
          messages:
            view?.messages.map((message) => [
              message.role,
              message.text.slice(0, 200),
            ]) ?? null,
          agentLog,
        },
      )}`,
    );
  }
  note("sustained-outage", {
    gapMs: 40_000,
    child: child1.id,
    ...sustained,
    faultLinesAdded: sustainedAdded,
  });

  // 4. child resuming: interrupt the first child, then a second child for the next role under the same held parent.
  await rpc.call("orchestration.dispatchCommand", {
    type: "run.interrupt",
    commandId: randomUUID(),
    threadId: child1.id,
    runId: childRun.id,
  });
  await until(
    async () => {
      const view = await project(child1.id);
      return view && !liveRun(view) ? true : null;
    },
    "the first child to end after the interrupt",
    60_000,
  );
  const child2 = await createChild("gap-child-2");
  await until(
    async () => {
      const view = await project(child2.id);
      return liveRun(view) ? true : null;
    },
    "the second child to run under the held parent",
    150_000,
  );
  const resumed = await gapFacts(
    "child-resumes-under-held-parent",
    4_000,
    faultLines(await project(parent.threadId)),
    parentRun.id,
    child2.id,
  );
  note("child-resumes", { child: child2.id, ...resumed });

  // 5. open decision on the parent: a task-scoped decision the held parent raises as a card,
  //    kept through a roll while the card is open.
  const decisionId = (
    (await service.debug({
      target: "runtime",
      method: "addDecision",
      args: [
        {
          question: "Proof parent decision?",
          headline: "Proof parent decision",
          choices: [
            { label: "Yes", consequence: "Proceed" },
            { label: "No", consequence: "Hold" },
          ],
          recommended: "Yes",
          askedBy: "operator",
          tasks: [task.id],
          project: { origin: "proof/synthetic-repository", path: repository },
        },
      ],
    })) as { id: string }
  ).id;
  // The host observes the parent's scope with no card present, so the next held poll raises it.
  await service.debug({
    target: "acp",
    method: "observedCards",
    args: [{ taskId: task.id }, []],
  });
  const cardFor = (view: Projection | null) => {
    if (!view) return null;
    const pending = view.runtimeRequests.find(
      (row) => row.kind === "user_input" && row.status === "pending",
    );
    if (!pending) return null;
    const item = view.turnItems.find(
      (row) =>
        row.type === "user_input_request" && row.requestId === pending.id,
    );
    return item?.questions?.[0]?.id === `nucleus_${decisionId}_1`
      ? pending.id
      : null;
  };
  const postedCards = (view: Projection | null) =>
    view
      ? view.turnItems.filter(
          (row) =>
            row.type === "user_input_request" &&
            row.questions?.[0]?.id === `nucleus_${decisionId}_1`,
        ).length
      : -1;
  const card = await until(
    async () => {
      const view = await project(parent.threadId);
      return cardFor(view) ? { requestId: cardFor(view)!, view } : null;
    },
    "the parent to raise the decision as a card",
    120_000,
  );
  const postedBefore = postedCards(card.view);
  note("parent-card-offered", {
    decision: decisionId,
    requestId: card.requestId,
    parentRun: parentRun.id,
  });
  await restartService(4_000);
  await delay(8_000);
  const afterGap = await project(parent.threadId);
  assert.ok(afterGap, "the parent projection is readable after the gap");
  const parentRunAfter = afterGap.runs.find((row) => row.id === parentRun.id);
  assert.ok(
    parentRunAfter && activeStatuses.has(parentRunAfter.status as never),
    "the parent's run stays live with the card open",
  );
  assert.equal(
    cardFor(afterGap),
    card.requestId,
    "the same card stays live through the roll",
  );
  assert.equal(
    postedCards(afterGap),
    postedBefore,
    "the roll posts no further card",
  );
  assert.equal(
    await decisionStatusOf(service, decisionId),
    "open",
    "the decision stays open",
  );
  assert.equal(
    sha256(bindingPath),
    binding,
    "the same binding remains through the card's gap",
  );
  note("parent-open-decision-roll", {
    decision: decisionId,
    requestId: card.requestId,
    parentRun: parentRun.id,
    postedCards: postedBefore,
  });

  // The parent's binding and session never changed, and its one run stayed the held run.
  assert.equal(
    parentThread().threadId,
    parent.threadId,
    "the same parent thread",
  );
  note("final", {
    parentThread: parent.threadId,
    parentRun: parentRun.id,
    bindingSha256: binding,
    session,
    expectation: "held",
  });

  // Teardown: every process this run started.
  rpc.close();
  await service.stop().catch(() => undefined);
  if (server && server.exitCode === null) server.kill("SIGTERM");
  await delay(300);
  if (server && server.exitCode === null) server.kill("SIGKILL");
  server = null;
  const evidence = join(root, "evidence.json");
  writeFileSync(
    evidence,
    `${JSON.stringify({ nightlyLine: String(NIGHTLY_LINE), steps, logs: [{ name: "t3-server.log", sha256: existsSync(t3Log) ? sha256(t3Log) : null }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ passed: true, evidence }));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
