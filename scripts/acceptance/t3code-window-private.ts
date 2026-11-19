/**
 * nucleus#1407's private proof: a settled Inbox wake outside T3's bounded projection
 * does not suppress the next decision's wake.
 *
 * One fresh private T3 environment runs on the installed nightly's own server, with an
 * isolated home, base directory, port and databases, a clean environment (only PATH is
 * inherited), and a private Nucleus data home. Neither reads or touches an operator's T3
 * home. The real `nucleus-acp` process and the real service run as in the inbox proof.
 *
 * Steps, each read on the wire or from the service's own on-disk hold record:
 *   1. an empty inbox goes idle;
 *   2. an earlier decision wakes the inbox, its card is answered, and its turn ends; the
 *      wake's receipt is settled;
 *   3. manual operator turns push that wake outside the bounded projection, confirmed by a
 *      bounded snapshot read with `hasMoreHistory` and without the wake's message;
 *   4. a fresh decision is offered. `--expect blocked` (the pre-fix code) records that no
 *      card and no new occurrence appear within 90 seconds. `--expect woken` (the fixed
 *      code) records exactly one card, answerable, and one new occurrence.
 *
 * Evidence is compact JSON per step. Raw server logs and evidence stay in run scratch.
 * Run through `effigy proof:t3code:window`.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { T3RpcClient } from "../../hosts/t3code/rpc";
import { identity } from "../../hosts/t3code/intents";
import { canonical } from "../../hosts/t3code/state";
import { activeStatuses } from "../../hosts/t3code/reads";
import { acpInboxDirectory } from "../../shared/acp/inbox-binding";
import { QueueService } from "../../service/transport/server";
import { findT3Cli } from "../../shared/t3/operator";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const NIGHTLY_LINE = /^0\.1\.11-nightly\.\d+\.\d+$/;
/** Every process this run starts, so a failed setup never leaves a server behind. */
const spawned: ChildProcess[] = [];
const killSpawned = () => {
  for (const child of spawned)
    if (child.exitCode === null) child.kill("SIGKILL");
};
process.on("exit", killSpawned);

/** The inbox thread's live signal (decisions, running tasks, or All quiet). */
const LIVE_TITLE = /^(All quiet|\d+ decisions? to answer|\d+ tasks? running)$/;
const CHOICES = [
  { label: "Yes", consequence: "Proceed" },
  { label: "No", consequence: "Hold" },
];

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
  milliseconds = 150_000,
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
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

async function run(
  argv: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
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
      reject(new Error(`setup command exited ${code}: ${detail}`));
    });
  });
}

const digest = (path: string) => {
  const bytes = readFileSync(path);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

type Snapshot = {
  projects: Array<{
    id: string;
    title: string;
    workspaceRoot: string;
    archivedAt?: string | null;
  }>;
  threads: Array<{
    id: string;
    projectId: string;
    title: string;
    pinnedAt?: string | null;
    archivedAt?: string | null;
    deletedAt?: string | null;
  }>;
};

type Projection = {
  thread: { id: string; title: string; pinnedAt?: string | null };
  runs: Array<{ id: string; status: string }>;
  runtimeRequests: Array<{ id: string; kind: string; status: string }>;
  turnItems: Array<{
    type: string;
    requestId?: string;
    questions?: Array<{ id: string }>;
  }>;
};

interface Step {
  step: string;
  ok: boolean;
  facts: Record<string, unknown>;
}

interface Environment {
  name: string;
  root: string;
  endpoint: string;
  bearer: string;
  serverVersion: string;
  logPath: string;
  rpc: T3RpcClient;
  service: QueueService;
  inboxThreadId: string;
  steps: Step[];
  children: ChildProcess[];
  sweepTimer: NodeJS.Timeout | null;
  restart: () => Promise<void>;
}

const field = (decisionId: string) => `nucleus_${decisionId}_1`;

function record(
  env: Environment,
  step: string,
  facts: Record<string, unknown>,
): void {
  env.steps.push({ step, ok: true, facts });
  console.log(`ok ${step} ${JSON.stringify(facts)}`);
}

/** The raw shape of the last shell read, named in a timeout so a mismatch is visible. */
const shapeProbe: {
  live?: string;
  archived?: string;
  items?: string;
  byId?: string;
} = {};

/**
 * The thread and project rows the adapter itself reads: the live shell, its archived
 * threads, and the archived snapshot. Reading one list alone misses rows the adapter sees.
 */
async function shell(rpc: T3RpcClient): Promise<Snapshot | null> {
  let live: (Snapshot & { archivedThreads?: Snapshot["threads"] }) | null =
    null;
  const items: string[] = [];
  await rpc.readStream(
    "orchestration.subscribeShell",
    { requestCompletionMarker: true },
    (value) => {
      const item = value as {
        kind?: string;
        snapshot?: Snapshot & { archivedThreads?: Snapshot["threads"] };
      };
      items.push(
        `${item.kind}:${Object.keys(item).join("|")}:${item.snapshot ? `threads=${item.snapshot.threads?.length}` : ""}`,
      );
      // The roots-carrying snapshot is a separate item with no thread rows; the adapter skips
      // it, and so does the proof, so the authoritative snapshot is the one that carries rows.
      if (
        item.kind === "snapshot" &&
        item.snapshot &&
        !("resolvedRepositoryIdentityRoots" in item)
      )
        live = item.snapshot;
      return item.kind === "synchronized";
    },
  );
  shapeProbe.items = items.join(" ; ");
  if (!live) return null;
  const archived = (await rpc.call(
    "orchestration.getArchivedShellSnapshot",
    {},
  )) as Snapshot;
  const current = live as Snapshot & { archivedThreads?: Snapshot["threads"] };
  shapeProbe.live = `${Object.keys(current).join(",")} threads=${current.threads?.length} archivedThreads=${current.archivedThreads?.length}`;
  shapeProbe.archived = `${Object.keys(archived).join(",")} threads=${archived.threads?.length}`;
  return {
    projects: current.projects,
    threads: [
      ...current.threads,
      ...(current.archivedThreads ?? []),
      ...archived.threads,
    ],
  };
}

async function projection(
  rpc: T3RpcClient,
  threadId: string,
): Promise<Projection | null> {
  let found: Projection | null = null;
  await rpc
    .readStream(
      "orchestration.subscribeThread",
      { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true },
      (value) => {
        const item = value as { kind?: string; projection?: Projection };
        if (item.kind === "snapshot" && item.projection)
          found = item.projection;
        return item.kind === "synchronized";
      },
    )
    .catch(() => undefined);
  return found;
}

/** Pending user-input cards on the thread, each with the decision field it carries. */
function cardsOf(p: Projection) {
  return p.runtimeRequests
    .filter(
      (request) =>
        request.kind === "user_input" && request.status === "pending",
    )
    .map((request) => {
      const item = p.turnItems.find(
        (row) =>
          row.type === "user_input_request" && row.requestId === request.id,
      );
      return {
        requestId: request.id,
        questionId: item?.questions?.[0]?.id ?? null,
      };
    });
}

const hasActiveRun = (p: Projection) =>
  p.runs.some((run) => activeStatuses.has(run.status as never));

/** The operator's answer or cancel in T3's own form: the wire call the operator's UI sends. */
async function operatorRespond(
  rpc: T3RpcClient,
  threadId: string,
  requestId: string,
  response: { answers: Record<string, string> } | { decision: "cancel" },
) {
  await rpc.call("orchestration.dispatchCommand", {
    type: "runtime-request.respond",
    commandId: `proof-operator-${randomUUID()}`,
    threadId,
    requestId,
    ...response,
  });
}

async function decisionStatus(env: Environment, id: string): Promise<string> {
  const view = (await env.service.debug({
    target: "runtime",
    method: "getDecision",
    args: [{ id }],
  })) as { status: string };
  return view.status;
}

async function addDecision(env: Environment, label: string): Promise<string> {
  const view = (await env.service.debug({
    target: "runtime",
    method: "addDecision",
    // An operator-asked decision names its repository, so the board places it; the
    // inbox offers it because no task owns it.
    args: [
      {
        question: `${label}?`,
        headline: label,
        choices: CHOICES,
        recommended: "Yes",
        askedBy: "operator",
        project: {
          origin: "proof/synthetic-repository",
          path: join(env.root, "synthetic-repository"),
        },
      },
    ],
  })) as { id: string };
  return view.id;
}

/** Every card the sweep has ever posted for one decision, answered or not. */
async function postedCount(
  env: Environment,
  decisionId: string,
): Promise<number> {
  const p = await projection(env.rpc, env.inboxThreadId);
  return p
    ? p.turnItems.filter(
        (item) =>
          item.type === "user_input_request" &&
          item.questions?.[0]?.id === field(decisionId),
      ).length
    : -1;
}

/** The card for one decision on the inbox thread, once the sweep has posted it. */
async function cardFor(env: Environment, decisionId: string) {
  const p = await projection(env.rpc, env.inboxThreadId);
  return p
    ? (cardsOf(p).find((card) => card.questionId === field(decisionId)) ?? null)
    : null;
}

async function waitForCard(env: Environment, decisionId: string, what: string) {
  return await until(async () => cardFor(env, decisionId), what);
}

/** Wait until the inbox has no active run for `sweeps` consecutive sweeps. */
async function threadTitle(env: Environment): Promise<string> {
  const snap = await shell(env.rpc);
  return snap?.threads.find((row) => row.id === env.inboxThreadId)?.title ?? "";
}

async function idleFor(
  env: Environment,
  sweeps: number,
): Promise<{ runs: string[]; quietSweeps: number }> {
  let quiet = 0;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && quiet < sweeps) {
    await delay(1_000);
    const p = await projection(env.rpc, env.inboxThreadId);
    quiet = p && !hasActiveRun(p) ? quiet + 1 : 0;
  }
  assert.ok(quiet >= sweeps, `the inbox went idle within ${sweeps} sweeps`);
  const p = await projection(env.rpc, env.inboxThreadId);
  return { runs: (p?.runs ?? []).map((run) => run.status), quietSweeps: quiet };
}

async function startEnvironment(
  name: string,
  legacy: boolean,
  scratch: string,
): Promise<Environment> {
  const root = mkdtempSync(join(scratch, `t3-inbox-${name}-`));
  console.log(JSON.stringify({ environment: name, proofRoot: root }));
  const t3 = findT3Cli({ explicit: process.env.NUCLEUS_T3_CLI ?? null });
  assert.ok(
    t3.path,
    `No installed t3 command was found. Tried: ${t3.tried.join(", ")}`,
  );
  const privateHome = join(root, "home");
  const t3Data = join(root, "t3-data");
  const nucleusData = join(root, "ns");
  const tmp = join(root, "tmp");
  for (const path of [privateHome, t3Data, nucleusData, tmp])
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
  };
  const acpLauncher = join(root, "bin", "nucleus-acp");
  mkdirSync(join(root, "bin"), { recursive: true });
  const tsx = join(checkout, "node_modules/tsx/dist/loader.mjs");
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsx)} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(nucleusData, "settings.json"),
    JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
    { mode: 0o600 },
  );

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const logPath = join(root, "t3-server.log");
  const children: ChildProcess[] = [];
  const startServer = (): ChildProcess => {
    const child = spawn(
      t3.path!,
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
    children.push(child);
    spawned.push(child);
    const collect = (stream: NodeJS.ReadableStream) =>
      stream.on("data", (bytes) => {
        writeFileSync(
          logPath,
          `${bytes}`.replace(
            /pairingUrl:\S+|#token=\S+/g,
            "[private pairing URL redacted]",
          ),
          { flag: "a" },
        );
      });
    collect(child.stdout!);
    collect(child.stderr!);
    return child;
  };
  let server = startServer();
  const descriptorOf = () =>
    until(async () => {
      const response = await fetch(
        `${endpoint}/.well-known/t3/environment`,
      ).catch(() => null);
      return response?.ok
        ? ((await response.json()) as {
            environmentId: string;
            serverVersion: string;
          })
        : null;
    }, `the private T3Code server (${name})`);
  const descriptor = await descriptorOf();
  assert.match(
    descriptor.serverVersion,
    NIGHTLY_LINE,
    "the installed nightly is the server",
  );
  const hostId = `t3code:${descriptor.environmentId}`;

  const session = JSON.parse(
    await run(
      [
        t3.path!,
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
        "--base-dir",
        t3Data,
      ],
      { env: environment, cwd: root },
    ),
  ) as { token: string };
  const bearer = session.token;
  let rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 30_000 });
  await rpc.connect();

  // The existing registration: the folder's basename under the id the shipped code derives.
  let legacyProject: { id: string; title: string } | null = null;
  if (legacy) {
    const inboxRoot = acpInboxDirectory(nucleusData, hostId);
    mkdirSync(inboxRoot, { recursive: true });
    const root_ = realpathSync(inboxRoot);
    const legacyId = identity("project", canonical([hostId, root_]));
    const legacyTitle = root_.split("/").pop()!;
    await rpc.call("projects.mutate", {
      type: "project.create",
      commandId: `proof-legacy-project-${randomUUID()}`,
      projectId: legacyId,
      title: legacyTitle,
      workspaceRoot: root_,
    });
    legacyProject = { id: legacyId, title: legacyTitle };
  }

  const service = new QueueService({
    owner: { dataDir: nucleusData, timers: false },
    fixture: "fake",
    debug: true,
  });
  await service.start();
  const health = () =>
    service.health() as unknown as {
      t3code?: { id?: string | null; connected?: boolean };
    };
  const tick = () =>
    service.debug({ target: "engine", method: "sweepOnce", args: [] }).then(
      () => undefined,
      () => undefined,
    );

  // The install waits for the service to come online, so the service keeps bootstrapping
  // while it runs, as the runtime proof does.
  const installTicker = setInterval(() => {
    void service
      .debug({ target: "runtime", method: "ensureBootstrap", args: [] })
      .catch(() => undefined);
  }, 2_000);
  const install = JSON.parse(
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
          t3.path!,
          "--acp-command",
          acpLauncher,
          "--json",
        ],
        { env: environment, cwd: root },
      ).finally(() => clearInterval(installTicker))
    ).trim(),
  ) as { steps?: unknown };
  await until(async () => {
    await service
      .debug({ target: "runtime", method: "ensureBootstrap", args: [] })
      .catch(() => undefined);
    return health().t3code?.connected === true && health().t3code?.id === hostId
      ? true
      : null;
  }, `the service to come online as the private T3 host (${name})`);

  // The adapter reads with the runtime bearer `t3 install` issued and stored in the
  // service's settings; the proof reads with the same credential, so the two see one view.
  const runtimeBearer = (
    JSON.parse(readFileSync(join(nucleusData, "settings.json"), "utf8")) as {
      t3code: { bearer: string };
    }
  ).t3code.bearer;
  rpc.close();
  rpc = new T3RpcClient({ endpoint, bearer: runtimeBearer, timeoutMs: 30_000 });
  await rpc.connect();

  const sweepTimer = setInterval(() => void tick(), 1_000);
  const env: Environment = {
    name,
    root,
    endpoint,
    bearer,
    serverVersion: descriptor.serverVersion,
    logPath,
    rpc,
    service,
    inboxThreadId: "",
    steps: [],
    children,
    sweepTimer,
    restart: async () => {
      server.kill("SIGTERM");
      await new Promise((exited) => server.once("exit", exited));
      server = startServer();
      await descriptorOf();
      rpc = new T3RpcClient({
        endpoint,
        bearer: runtimeBearer,
        timeoutMs: 30_000,
      });
      await rpc.connect();
      env.rpc = rpc;
      // The service reconnects through its bootstrap, which timers drive in production; this
      // proof runs without timers, so it asks for the reconnect as the install does.
      await until(async () => {
        await service
          .debug({ target: "runtime", method: "ensureBootstrap", args: [] })
          .catch(() => undefined);
        return health().t3code?.connected === true ? true : null;
      }, "the service to reconnect to the restarted T3 host");
    },
  };
  record(env, `${name}:server-and-install`, {
    serverVersion: descriptor.serverVersion,
    isolated: true,
    install: install.steps,
  });

  // The inbox appears once the sweep has made its first pass.
  // The inbox is found through its readable project, never through a title the live
  // signal may have replaced.
  const inbox = await until(async () => {
    const snap = await shell(rpc);
    const project = snap?.projects.find(
      (row) => row.title === "Nucleus Inbox" && !row.archivedAt,
    );
    const thread = project
      ? snap!.threads.find(
          (row) =>
            row.projectId === project.id && !row.deletedAt && !row.archivedAt,
        )
      : undefined;
    if (thread && project) return { thread, project };
    // Not yet: the message names what the shell shows, so a timeout is diagnosable. The
    // thread id the service recorded is read by id as well: a thread the server holds shows
    // there even when no list does.
    const recorded = (() => {
      try {
        return (
          JSON.parse(
            readFileSync(join(nucleusData, "hosts", "t3code.json"), "utf8"),
          ) as { inbox?: { threadId: string } }
        ).inbox?.threadId;
      } catch {
        return undefined;
      }
    })();
    const byId = recorded ? await projection(rpc, recorded) : null;
    shapeProbe.byId = `recorded=${recorded ?? "none"} projectionThread=${byId?.thread ? byId.thread.title : "absent"}`;
    throw new Error(
      `shell projects ${JSON.stringify((snap?.projects ?? []).map((row) => [row.title, Boolean(row.archivedAt)]))} threads ${JSON.stringify((snap?.threads ?? []).map((row) => [row.title, row.projectId === project?.id]))} live[${shapeProbe.live}] archived[${shapeProbe.archived}] items[${shapeProbe.items}] byId[${shapeProbe.byId}]`,
    );
  }, `the pinned Nucleus inbox (${name})`);
  env.inboxThreadId = inbox.thread.id;
  assert.equal(
    inbox.project.title,
    "Nucleus Inbox",
    "the inbox project reads Nucleus Inbox",
  );
  // The sweep writes the live title a pass after launch, so the title is awaited, not read once.
  const liveTitle = await until(async () => {
    const snap = await shell(rpc);
    const title =
      snap?.threads.find((row) => row.id === inbox.thread.id)?.title ?? "";
    return LIVE_TITLE.test(title) ? title : null;
  }, `the inbox thread to show a live signal (${name})`);
  inbox.thread.title = liveTitle;
  if (legacyProject)
    assert.equal(
      inbox.project.id,
      legacyProject.id,
      "the existing registration keeps its id",
    );
  const pinned = await until(async () => {
    const snap = await shell(rpc);
    const thread = snap?.threads.find((row) => row.id === env.inboxThreadId);
    return thread?.pinnedAt ? thread : null;
  }, `the inbox thread to be pinned (${name})`);
  record(env, `${name}:naming`, {
    projectTitle: inbox.project.title,
    threadTitle: inbox.thread.title,
    titleIsLiveSignal: LIVE_TITLE.test(inbox.thread.title),
    projectIdKept: legacyProject ? inbox.project.id === legacyProject.id : null,
    legacyProjectTitle: legacyProject?.title ?? null,
    pinned: Boolean(pinned.pinnedAt),
  });
  return env;
}

async function teardown(env: Environment) {
  if (env.sweepTimer) clearInterval(env.sweepTimer);
  try {
    env.rpc.close();
  } catch {
    /* best effort */
  }
  try {
    await env.service.stop();
  } catch {
    /* best effort */
  }
  for (const child of env.children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await delay(300);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/** The window case (nucleus#1407): a settled wake pushed outside the bounded projection. */
type WindowRow = { type: string; messageId?: string };
async function windowCoverage(
  rpc: T3RpcClient,
  threadId: string,
): Promise<{ hasMoreHistory: boolean; turnItems: WindowRow[] }> {
  const frames: Array<{
    hasMoreHistory?: boolean;
    projection?: { turnItems: WindowRow[] };
  }> = [];
  await rpc.readStream(
    "orchestration.subscribeThread",
    { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true },
    (value) => {
      const item = value as { kind?: string };
      if (item.kind === "snapshot")
        frames.push(value as (typeof frames)[number]);
      return item.kind === "synchronized";
    },
  );
  const frame = frames[0];
  if (!frame?.projection)
    throw new Error("the window read carried no snapshot");
  return {
    hasMoreHistory: frame.hasMoreHistory === true,
    turnItems: frame.projection.turnItems,
  };
}

/** The decision hold and its intent, as the service recorded them on disk. */
function holdState(env: Environment) {
  const state = JSON.parse(
    readFileSync(join(env.root, "ns", "hosts", "t3code.json"), "utf8"),
  ) as {
    decisionHolds?: Record<
      string,
      { generation: number; commandId: string; messageId: string }
    >;
    intents?: Record<string, { status: string }>;
  };
  const hold = state.decisionHolds?.[env.inboxThreadId];
  return {
    hold,
    intentStatus: hold
      ? (state.intents?.[hold.commandId]?.status ?? "absent")
      : "absent",
  };
}

/** One completed manual operator turn on the inbox thread. */
async function manualTurn(env: Environment, index: number): Promise<void> {
  await env.rpc.call("orchestration.dispatchCommand", {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: `proof-manual-${randomUUID()}`,
    threadId: env.inboxThreadId,
    messageId: `proof-manual-message-${randomUUID()}`,
    text: `Proof manual turn ${index}`,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  });
}

async function windowScenarios(env: Environment, expect: "blocked" | "woken") {
  const start = await idleFor(env, 3);
  record(env, "window:empty-start-idle", { runs: start.runs });
  // An earlier decision: its wake is acknowledged, its card answered, and its turn ends.
  const earlier = await addDecision(env, "Window earlier");
  const earlierCard = await waitForCard(env, earlier, "the earlier wake card");
  await operatorRespond(env.rpc, env.inboxThreadId, earlierCard.requestId, {
    answers: { [earlierCard.questionId!]: "Yes" },
  });
  await until(
    async () =>
      (await decisionStatus(env, earlier)) === "answered" ? true : null,
    "the earlier answer to record",
  );
  await idleFor(env, 3);
  const acknowledged = holdState(env);
  assert.ok(
    acknowledged.hold,
    "the earlier wake is recorded as the decision hold",
  );
  assert.equal(
    acknowledged.intentStatus,
    "settled",
    "the earlier wake has an acknowledged receipt",
  );
  const earlierMessage = acknowledged.hold!.messageId;
  // Manual turns push the earlier wake outside the bounded projection, confirmed on the wire.
  let turns = 0;
  let coverage = await windowCoverage(env.rpc, env.inboxThreadId);
  while (
    !(
      coverage.hasMoreHistory &&
      !coverage.turnItems.some(
        (row) =>
          row.type === "user_message" && row.messageId === earlierMessage,
      )
    ) &&
    turns < 40
  ) {
    turns++;
    await manualTurn(env, turns);
    await idleFor(env, 2);
    coverage = await windowCoverage(env.rpc, env.inboxThreadId);
  }
  assert.ok(coverage.hasMoreHistory, "the window is paged");
  assert.ok(
    !coverage.turnItems.some(
      (row) => row.type === "user_message" && row.messageId === earlierMessage,
    ),
    "the earlier wake is outside the window",
  );
  record(env, "window:earlier-wake-outside-window", {
    manualTurns: turns,
    hasMoreHistory: true,
    windowRows: coverage.turnItems.length,
    earlierGeneration: acknowledged.hold!.generation,
    earlierReceipt: acknowledged.intentStatus,
  });

  const later = await addDecision(env, "Window later");
  if (expect === "blocked") {
    let card: unknown = null;
    const deadline = Date.now() + 90_000;
    while (!card && Date.now() < deadline) {
      await delay(1_000);
      card = await cardFor(env, later);
    }
    const after = holdState(env);
    assert.equal(
      card,
      null,
      "pre-fix: no card is posted for the offerable decision",
    );
    assert.equal(
      after.hold!.generation,
      acknowledged.hold!.generation,
      "pre-fix: re-entry does not proceed",
    );
    record(env, "window:later-wake-blocked", {
      cardPosted: false,
      holdGeneration: after.hold!.generation,
      decision: await decisionStatus(env, later),
      hasMoreHistory: true,
    });
    return;
  }
  const card = await waitForCard(env, later, "the later wake card");
  await operatorRespond(env.rpc, env.inboxThreadId, card.requestId, {
    answers: { [card.questionId!]: "Yes" },
  });
  await until(
    async () =>
      (await decisionStatus(env, later)) === "answered" ? true : null,
    "the later answer to record",
  );
  const finalIdle = await idleFor(env, 3);
  const posted = await postedCount(env, later);
  const after = holdState(env);
  assert.equal(
    posted,
    1,
    "exactly one card is posted for the offerable version",
  );
  assert.equal(
    after.hold!.generation,
    acknowledged.hold!.generation + 1,
    "exactly one new occurrence",
  );
  assert.notEqual(
    after.hold!.commandId,
    acknowledged.hold!.commandId,
    "the new occurrence has a new command identity",
  );
  record(env, "window:later-wake-once", {
    cardsPosted: posted,
    decision: "answered",
    holdGeneration: after.hold!.generation,
    intent: after.intentStatus,
    runs: finalIdle.runs,
    hasMoreHistory: (await windowCoverage(env.rpc, env.inboxThreadId))
      .hasMoreHistory,
  });
}

export async function main() {
  const args = process.argv.slice(2);
  const expectFlag = args.indexOf("--expect");
  const expectOutcome = expectFlag >= 0 ? args[expectFlag + 1] : "woken";
  if (expectOutcome !== "blocked" && expectOutcome !== "woken")
    throw new Error("--expect takes blocked or woken");
  const scratch = scratchRoot();
  const root = mkdtempSync(join(scratch, "t3-inbox-window-proof-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const env = await startEnvironment("window", false, root);
  let failure: unknown = null;
  try {
    await windowScenarios(env, expectOutcome);
  } catch (error) {
    failure = error;
  } finally {
    await teardown(env);
  }
  const path = join(root, "evidence.json");
  writeFileSync(
    path,
    `${JSON.stringify({ nightlyLine: String(NIGHTLY_LINE), expect: expectOutcome, serverVersion: env.serverVersion, steps: env.steps, logs: [{ name: "t3-server.log", ...digest(env.logPath) }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (failure) throw failure;
  console.log(
    JSON.stringify({ passed: true, expect: expectOutcome, evidence: path }),
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    killSpawned();
    process.exit(1);
  },
);
