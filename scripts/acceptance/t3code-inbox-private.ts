/**
 * nucleus#1384's and nucleus#1415's private proof: the pinned T3 inbox is idle between
 * decisions, shows a readable project name, and its `ui` command shows the board.
 *
 * Two private T3 environments run on the installed nightly's own server. Each has an
 * isolated home, base directory, port and databases, and a clean environment (only
 * PATH is inherited). Neither reads or touches an operator's T3 home.
 *
 * - `fresh`: the service creates the inbox, its project and its pinned thread.
 * - `existing`: the inbox's registration exists before the service starts, with the
 *   title and id the shipped code gave it, so the adoption path an upgraded environment
 *   takes is the one exercised. It is renamed in place and keeps its id.
 *
 * The fresh environment proves on the wire that:
 *   1. an empty inbox at startup goes idle (no active run across sweeps);
 *   2. an open decision wakes the idle inbox and its card is posted;
 *   3. an operator's answer in T3's form is recorded and the inbox goes idle;
 *   4. an answer given elsewhere settles the T3 card and the inbox goes idle;
 *   5. a withdrawal settles the card and the inbox goes idle;
 *   6. an operator cancel is re-offered once; the second cancel is final, no third card
 *      is posted, and the decision stays open;
 *   7. decisions arriving around the release are each posted exactly once;
 *   8. after a T3 restart the inbox is idle, and an open decision is posted once more;
 *   9. `ui` shows the board in one tab (a retained tab is replaced by the revealed
 *      open), ignores non-exact text, reopens a closed pane, and — while a decision holds
 *      the turn and T3 queues the message — is served by the pass with the card untouched
 *      and the served result reported when the queued turn runs.
 * Both environments prove the project reads "Nucleus Inbox", the thread stays pinned,
 * and the existing registration keeps its id. The existing Inbox also serves `ui`
 * from a closed pane and is checked for the reply and the revealed preview tab.
 *
 * Evidence is compact JSON per step with sha256 digests of the raw server logs. Raw logs
 * and evidence stay in run scratch. Run through `effigy proof:t3code:inbox`.
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
import { ACP_OPEN_UI_TIMEOUT_MS } from "../../shared/acp/transport";
import { QueueService } from "../../service/transport/server";
import { findT3Cli } from "../../shared/t3/operator";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const NIGHTLY_LINE = /^0\.1\.(11|12)-nightly\.\d+\.\d+$/;
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
    messageId?: string;
    runId?: string | null;
    text?: string;
    questions?: Array<{ id: string }>;
  }>;
  messages?: Array<{
    id: string;
    role: string;
    text: string;
    runId?: string | null;
  }>;
};

type PreviewSession = {
  tabId: string;
  navStatus: { _tag: string; url?: string };
  runtime?: string;
  reveal?: boolean;
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

async function previewSessions(
  rpc: T3RpcClient,
  threadId: string,
): Promise<PreviewSession[]> {
  const result = (await rpc.call("preview.list", { threadId })) as {
    sessions?: PreviewSession[];
  };
  return result.sessions ?? [];
}

async function sendInboxText(
  env: Environment,
  text: string,
  targetRunId?: string,
): Promise<string> {
  const messageId = `proof-inbox-msg-${randomUUID()}`;
  await env.rpc.call("orchestration.dispatchCommand", {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: `proof-inbox-cmd-${randomUUID()}`,
    threadId: env.inboxThreadId,
    messageId,
    text,
    attachments: [],
    dispatchMode: targetRunId
      ? { type: "restart_active", targetRunId }
      : { type: "queue_after_active" },
  });
  return messageId;
}

function assertNoPairingLeak(
  env: Environment,
  p: Projection,
  context: string,
): void {
  const serialized = JSON.stringify({
    messages: p.messages ?? [],
    turnItems: p.turnItems,
  });
  assert.equal(
    /#token=|pairingUrl:/i.test(serialized),
    false,
    `no pairing URL in inbox projection (${context})`,
  );
  const log = readFileSync(env.logPath, "utf8");
  assert.equal(
    /#token=/i.test(log),
    false,
    `no pairing token in server log (${context})`,
  );
}

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
  const root = mkdtempSync(join(scratch, `${name}-`));
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
  writeFileSync(logPath, "", { mode: 0o600 });
  const children: ChildProcess[] = [];
  const startServer = (): ChildProcess => {
    const child = spawn(
      t3.path!,
      [
        "serve",
        "--mode",
        "web",
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
    // Web mode prints its operator pairing credentials and QR code to stdout.
    child.stdout!.resume();
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
    webBoard: { port: 0 },
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

/** The fresh environment: every wake, settlement, cap and restart case. */
async function freshScenarios(env: Environment) {
  // 1. Empty inbox at startup goes idle.
  const start = await idleFor(env, 3);
  const startTitle = await until(
    async () => ((await threadTitle(env)) === "All quiet" ? "All quiet" : null),
    "the idle inbox title All quiet",
  );
  record(env, "fresh:empty-start-idle", {
    runs: start.runs,
    quietSweeps: start.quietSweeps,
    title: startTitle,
  });

  // 2. An open decision wakes the inbox, and its card is posted.
  const wake = await addDecision(env, "Proof wake");
  const wakeCard = await waitForCard(env, wake, "the wake card");
  const wakeTitle = await until(async () => {
    const t = await threadTitle(env);
    return t === "1 decision to answer" ? t : null;
  }, "the wake title");
  record(env, "fresh:open-decision-wakes", {
    cardPosted: true,
    title: wakeTitle,
  });

  // 3. An operator's answer in T3's form is recorded; the inbox goes idle.
  await operatorRespond(env.rpc, env.inboxThreadId, wakeCard.requestId, {
    answers: { [wakeCard.questionId!]: "Yes" },
  });
  await until(
    async () =>
      (await decisionStatus(env, wake)) === "answered" ? true : null,
    "the form answer to record",
  );
  const afterForm = await idleFor(env, 3);
  const formTitle = await until(async () => {
    const t = await threadTitle(env);
    return t === "All quiet" ? t : null;
  }, "the title to return to All quiet after the answer");
  record(env, "fresh:form-answer-idle", {
    decision: "answered",
    runs: afterForm.runs,
    title: formTitle,
  });

  // 4. An answer given elsewhere settles the T3 card; the inbox goes idle.
  const elsewhere = await addDecision(env, "Proof elsewhere");
  const elsewhereCard = await waitForCard(env, elsewhere, "the elsewhere card");
  await env.service.debug({
    target: "runtime",
    method: "answerDecision",
    args: [
      {
        id: elsewhere,
        version: 1,
        answer: "Yes",
        answeredBy: "operator",
        relayed: false,
        note: "Answered elsewhere (proof)",
      },
    ],
  });
  await until(async () => {
    await delay(1_000);
    const p = await projection(env.rpc, env.inboxThreadId);
    return p &&
      !p.runtimeRequests.some(
        (request) =>
          request.id === elsewhereCard.requestId &&
          request.status === "pending",
      )
      ? true
      : null;
  }, "the elsewhere card to settle on T3");
  const afterElsewhere = await idleFor(env, 3);
  record(env, "fresh:answer-elsewhere-settles-and-idles", {
    decision: await decisionStatus(env, elsewhere),
    runs: afterElsewhere.runs,
  });

  // 5. A withdrawal settles the card; the inbox goes idle.
  const withdrawn = await addDecision(env, "Proof withdraw");
  const withdrawnCard = await waitForCard(
    env,
    withdrawn,
    "the withdrawal card",
  );
  await env.service.debug({
    target: "runtime",
    method: "withdrawDecision",
    args: [
      {
        id: withdrawn,
        version: 1,
        reason: "proof withdrawal",
        withdrawnBy: "operator",
      },
    ],
  });
  await until(async () => {
    await delay(1_000);
    const p = await projection(env.rpc, env.inboxThreadId);
    return p &&
      !p.runtimeRequests.some(
        (request) =>
          request.id === withdrawnCard.requestId &&
          request.status === "pending",
      )
      ? true
      : null;
  }, "the withdrawn card to settle on T3");
  const afterWithdraw = await idleFor(env, 3);
  record(env, "fresh:withdrawal-handled-and-idles", {
    decision: await decisionStatus(env, withdrawn),
    runs: afterWithdraw.runs,
  });

  // 6. The operator-cancel cap: one re-offer, then the second cancel is final.
  const capped = await addDecision(env, "Proof cap");
  const first = await waitForCard(env, capped, "the first cap card");
  await operatorRespond(env.rpc, env.inboxThreadId, first.requestId, {
    decision: "cancel",
  });
  const second = await until(async () => {
    await delay(1_000);
    const card = await cardFor(env, capped);
    return card && card.requestId !== first.requestId ? card : null;
  }, "the one permitted re-offer after the first cancel");
  await operatorRespond(env.rpc, env.inboxThreadId, second.requestId, {
    decision: "cancel",
  });
  for (let i = 0; i < 12; i++) await delay(1_000);
  const posted = await postedCount(env, capped);
  assert.equal(
    posted,
    2,
    "exactly two cards are posted for the capped decision",
  );
  const capStatus = await decisionStatus(env, capped);
  assert.equal(capStatus, "open", "the capped decision stays open");
  const afterCap = await idleFor(env, 3);
  record(env, "fresh:operator-cancel-cap", {
    cardsPosted: posted,
    decision: capStatus,
    runs: afterCap.runs,
  });

  // 7. Decisions arriving around the release are each posted exactly once.
  const race: string[] = [];
  for (let i = 0; i < 4; i++) {
    race.push(await addDecision(env, `Proof race ${i}`));
    await Promise.all([
      env.service
        .debug({ target: "engine", method: "sweepOnce", args: [] })
        .catch(() => undefined),
      delay(200 + Math.floor(Math.random() * 1_200)),
    ]);
  }
  for (const id of race) {
    const card = await waitForCard(env, id, `race card ${id}`);
    await operatorRespond(env.rpc, env.inboxThreadId, card.requestId, {
      answers: { [card.questionId!]: "Yes" },
    });
    await until(
      async () =>
        (await decisionStatus(env, id)) === "answered" ? true : null,
      `race decision ${id} to record`,
    );
  }
  for (let i = 0; i < 8; i++) await delay(1_000);
  const postedPerDecision: number[] = [];
  for (const id of race) postedPerDecision.push(await postedCount(env, id));
  const raceIdle = await idleFor(env, 3);
  record(env, "fresh:release-race-posted-once", {
    decisions: race.length,
    cardsPostedPerDecision: postedPerDecision,
    runs: raceIdle.runs,
  });
  assert.deepEqual(
    postedPerDecision,
    race.map(() => 1),
    "each race decision is posted exactly once",
  );

  // 8. Restart with nothing open: the inbox is idle after the T3 server restarts (the
  // capped decision is no longer offered, so no re-entry is due).
  await env.restart();
  const afterRestartIdle = await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    return p && !hasActiveRun(p) ? p : null;
  }, "the inbox to be idle after restart with nothing open");
  record(env, "fresh:restart-idle-with-nothing-open", {
    runsAfterRestart: afterRestartIdle.runs.map((run) => run.status),
  });

  // 9. An open decision, then a restart: the decision is posted once more after the
  // restart, as a new card, and answering it records it.
  const restarted = await addDecision(env, "Proof restart");
  const preRestart = await waitForCard(env, restarted, "the pre-restart card");
  await env.restart();
  // The pre-restart card is settled by the adapter; the card to answer is the one posted
  // after the restart, a different request.
  const reposted = await until(async () => {
    const card = await cardFor(env, restarted);
    if (card && card.requestId !== preRestart.requestId) return card;
    const p = await projection(env.rpc, env.inboxThreadId);
    const runs = p ? p.runs.map((run) => run.status).join(",") : "none";
    const requests = p
      ? p.runtimeRequests
          .map((request) => `${request.kind}/${request.status}`)
          .join(",")
      : "none";
    const holds = await decisionStatus(env, restarted).catch(
      () => "unreadable",
    );
    throw new Error(
      `restart card not yet: decision=${holds} runs[${runs}] requests[${requests}]`,
    );
  }, "the open decision re-posted after restart");
  record(env, "fresh:restart-card-reposted", {
    replaced: reposted.requestId !== preRestart.requestId,
  });
  await operatorRespond(env.rpc, env.inboxThreadId, reposted.requestId, {
    answers: { [reposted.questionId!]: "Yes" },
  });
  await until(
    async () =>
      (await decisionStatus(env, restarted)) === "answered" ? true : null,
    "the post-restart answer to record",
  );
  const finalIdle = await idleFor(env, 3);
  record(env, "fresh:restart-open-decision-posted-and-answered", {
    decision: "answered",
    runs: finalIdle.runs,
  });

  // 10. Typing `ui` shows the board in the inbox thread's pane, gives one clear result and
  // finishes the command: a retained healthy tab is replaced by one freshly revealed tab (the
  // nightly reveals only an open), non-exact text never opens anything, a closed pane is
  // reopened with a fresh one-time pairing link, and while a decision holds the inbox's turn
  // the pass answers the `ui` T3 queued behind it without touching the card.
  const openSessions = await until(async () => {
    const sessions = await previewSessions(env.rpc, env.inboxThreadId);
    return sessions.length ? sessions : null;
  }, "an open board preview before testing ui");
  const existingTabId = openSessions[0]!.tabId;
  const uiMessage = await sendInboxText(env, "ui");
  await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    const posted = p?.turnItems.some(
      (item) => item.type === "user_message" && item.messageId === uiMessage,
    );
    return p && posted && !hasActiveRun(p) ? p : null;
  }, "ui on the retained pane to finish idle");
  const uiIdle = await idleFor(env, 3);
  const afterUiSessions = await previewSessions(env.rpc, env.inboxThreadId);
  assert.equal(
    afterUiSessions.length,
    1,
    "exactly one board tab remains after ui",
  );
  assert.notEqual(
    afterUiSessions[0]!.tabId,
    existingTabId,
    "the retained board tab is replaced by the revealed one",
  );
  assert.equal(afterUiSessions[0]!.reveal, true);
  const afterUiProjection = (await projection(env.rpc, env.inboxThreadId))!;
  assertNoPairingLeak(env, afterUiProjection, "retained-pane");
  assert.match(
    JSON.stringify(afterUiProjection.turnItems),
    /Opened the Nucleus board/,
    "the command answers with the board it showed",
  );
  record(env, "fresh:inbox-ui-replaces-retained-tab", {
    previousTabId: existingTabId,
    tabId: afterUiSessions[0]!.tabId,
    reveal: afterUiSessions[0]!.reveal,
    sessions: afterUiSessions.length,
    runs: uiIdle.runs,
  });
  const retainedTabId = afterUiSessions[0]!.tabId;

  // A second `ui` is a second operator message and a second attempt: it shows the board
  // again, replacing the tab rather than adding one, because the retained tab cannot be
  // revealed in place.
  const repeated = await sendInboxText(env, "ui");
  await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    return p &&
      p.turnItems.some(
        (item) => item.type === "user_message" && item.messageId === repeated,
      ) &&
      !hasActiveRun(p)
      ? p
      : null;
  }, "a repeated ui to finish idle");
  const repeatedSessions = await previewSessions(env.rpc, env.inboxThreadId);
  assert.equal(repeatedSessions.length, 1);
  assert.notEqual(
    repeatedSessions[0]!.tabId,
    retainedTabId,
    "a second ui shows the board again, one tab",
  );
  record(env, "fresh:inbox-ui-repeat", {
    previousTabId: retainedTabId,
    tabId: repeatedSessions[0]!.tabId,
    sessions: repeatedSessions.length,
  });
  const closedTabId = repeatedSessions[0]!.tabId;

  // Non-exact text never opens the closed pane.
  await env.rpc.call("preview.close", {
    threadId: env.inboxThreadId,
    tabId: closedTabId,
  });
  await until(
    async () =>
      (await previewSessions(env.rpc, env.inboxThreadId)).length === 0
        ? true
        : null,
    "the closed preview pane",
  );
  const nonUiMessageId = await sendInboxText(env, "ui please");
  await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    const posted = p?.turnItems.some(
      (item) =>
        item.type === "user_message" && item.messageId === nonUiMessageId,
    );
    return p && posted && !hasActiveRun(p) ? p : null;
  }, "non-exact prompt to settle idle");
  await idleFor(env, 3);
  assert.equal(
    (await previewSessions(env.rpc, env.inboxThreadId)).length,
    0,
    "non-exact text does not reopen the closed pane",
  );
  record(env, "fresh:inbox-ui-non-exact-ignored", { sessions: 0 });

  // Exact `ui` reopens from the closed pane with a fresh one-time pairing link and finishes.
  const reopenMessageId = await sendInboxText(env, "ui");
  const reopenedSessions = await until(async () => {
    const sessions = await previewSessions(env.rpc, env.inboxThreadId);
    return sessions.length === 1 && sessions[0]!.tabId !== closedTabId
      ? sessions
      : null;
  }, "ui to reopen the closed board pane");
  assert.equal(reopenedSessions[0]!.reveal, true);
  assert.match(
    reopenedSessions[0]!.navStatus.url ?? "",
    /^http:\/\/127\.0\.0\.1:\d+\//,
  );
  await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    const posted = p?.turnItems.some(
      (item) =>
        item.type === "user_message" && item.messageId === reopenMessageId,
    );
    return p && posted && !hasActiveRun(p) ? p : null;
  }, "ui reopen to return to idle");
  const reopenIdle = await idleFor(env, 3);
  const reopenProjection = (await projection(env.rpc, env.inboxThreadId))!;
  assertNoPairingLeak(env, reopenProjection, "reopen-closed");
  record(env, "fresh:inbox-ui-reopen-closed", {
    previousTabId: closedTabId,
    reopenedTabId: reopenedSessions[0]!.tabId,
    reveal: reopenedSessions[0]!.reveal,
    runs: reopenIdle.runs,
  });
  const closedPaneTabId = reopenedSessions[0]!.tabId;

  // With an offerable decision open, the inbox's turn is held, so T3 queues the operator's
  // own `ui` and the agent never receives it. The pass shows the board anyway, inside the
  // command's bound, and the card stays: the offer, its card and the hold are untouched.
  const heldDecision = await addDecision(env, "Proof ui held decision");
  const heldCard = await waitForCard(
    env,
    heldDecision,
    "the decision card before ui",
  );
  const heldRun = (await projection(env.rpc, env.inboxThreadId))?.runs.find(
    (run) => activeStatuses.has(run.status as never),
  );
  await env.rpc.call("preview.close", {
    threadId: env.inboxThreadId,
    tabId: closedPaneTabId,
  });
  await until(
    async () =>
      (await previewSessions(env.rpc, env.inboxThreadId)).length === 0
        ? true
        : null,
    "closed pane before the held ui",
  );
  const queuedMessageId = await sendInboxText(env, "ui");
  const queuedUi = await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    // A queued message is in the thread's messages before it is a turn item.
    const message = p?.messages?.find(
      (row) =>
        row.role === "user" && row.text === "ui" && row.id === queuedMessageId,
    );
    const run = message?.runId
      ? p?.runs.find((row) => row.id === message.runId)
      : undefined;
    if (run?.status !== "queued") return null;
    const sessions = await previewSessions(env.rpc, env.inboxThreadId);
    return sessions.length === 1 ? { sessions, run, message } : null;
  }, "the pass to answer the ui T3 queued behind the held turn");
  assert.equal(queuedUi.sessions[0]!.reveal, true);
  const heldAfterUi = (await projection(env.rpc, env.inboxThreadId))!;
  assert.equal(
    hasActiveRun(heldAfterUi),
    true,
    "the inbox stays held while an offerable decision is open",
  );
  assert.equal(
    heldAfterUi.runs.some((run) => run.id === heldRun?.id),
    true,
    "the held run is the one that was already live",
  );
  assertNoPairingLeak(env, heldAfterUi, "held-ui");
  const activeCard = await waitForCard(
    env,
    heldDecision,
    "the held decision card after ui",
  );
  assert.equal(
    activeCard.requestId,
    heldCard.requestId,
    "the operator's card is the same card, not a re-raise",
  );
  // Answering the card releases the hold; the queued ui then runs and reports the same
  // served result without opening the board a second time.
  await operatorRespond(env.rpc, env.inboxThreadId, activeCard.requestId, {
    answers: { [activeCard.questionId!]: "Yes" },
  });
  await until(
    async () =>
      (await decisionStatus(env, heldDecision)) === "answered" ? true : null,
    "the held decision answer after ui",
  );
  const afterQueuedTurn = await until(async () => {
    const p = await projection(env.rpc, env.inboxThreadId);
    if (!p || hasActiveRun(p)) return null;
    return p.turnItems.some(
      (item) =>
        item.type === "assistant_message" &&
        /Nucleus board is open|Opened the Nucleus board/.test(
          String(item.text ?? ""),
        ),
    )
      ? p
      : null;
  }, "the queued ui turn to report the served board");
  const afterQueuedSessions = await previewSessions(env.rpc, env.inboxThreadId);
  assert.equal(
    afterQueuedSessions.length,
    1,
    "one board tab after the held ui",
  );
  assert.equal(
    afterQueuedSessions[0]!.tabId,
    queuedUi.sessions[0]!.tabId,
    "the served board tab is not replaced by the queued turn",
  );
  assertNoPairingLeak(env, afterQueuedTurn, "held-ui-finished");
  record(env, "fresh:inbox-ui-serves-queued-message", {
    queuedRun: queuedUi.run.status,
    cardIdBefore: heldCard.requestId,
    cardIdAfter: activeCard.requestId,
    tabId: queuedUi.sessions[0]!.tabId,
    sessions: afterQueuedSessions.length,
    answerReported: true,
  });
}

/** The adopted Inbox wakes for decisions and can reopen its board from a closed pane. */
async function existingScenarios(env: Environment) {
  const start = await idleFor(env, 3);
  record(env, "existing:empty-start-idle", {
    runs: start.runs,
    quietSweeps: start.quietSweeps,
  });
  const id = await addDecision(env, "Existing wake");
  const card = await waitForCard(env, id, "the existing wake card");
  await operatorRespond(env.rpc, env.inboxThreadId, card.requestId, {
    answers: { [card.questionId!]: "Yes" },
  });
  await until(
    async () => ((await decisionStatus(env, id)) === "answered" ? true : null),
    "the existing answer to record",
  );
  const after = await idleFor(env, 3);
  record(env, "existing:wakes-answers-idle", {
    decision: "answered",
    runs: after.runs,
  });

  const threadId = env.inboxThreadId;
  const board = env.service.webBoardAddress();
  assert.ok(board, "the private Nucleus board is listening");
  for (const tab of await previewSessions(env.rpc, threadId)) {
    await env.rpc.call("preview.close", { threadId, tabId: tab.tabId });
  }
  assert.equal((await previewSessions(env.rpc, threadId)).length, 0);

  const started = performance.now();
  const messageId = await sendInboxText(env, "ui");
  const result = await until(
    async () => {
      const view = await projection(env.rpc, threadId);
      const message = view?.messages?.find((row) => row.id === messageId);
      const run = view?.runs.find((row) => row.id === message?.runId);
      const reply = view?.messages?.find(
        (row) => row.role === "assistant" && row.runId === run?.id,
      );
      if (!view || !message || run?.status !== "completed" || !reply)
        return null;
      return { view, reply };
    },
    "the existing Inbox ui reply",
    ACP_OPEN_UI_TIMEOUT_MS,
  );
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(elapsedMs < ACP_OPEN_UI_TIMEOUT_MS, "the reply is bounded");
  assert.equal(result.reply.text.trim(), "Opened the Nucleus board.");
  assert.ok(result.view.thread.pinnedAt, "the same Inbox is still pinned");
  assertNoPairingLeak(env, result.view, "existing Inbox board reopen");

  const tabs = await previewSessions(env.rpc, threadId);
  assert.equal(tabs.length, 1, "the Inbox has one preview after ui");
  assert.equal(tabs[0]!.reveal, true);
  assert.equal(tabs[0]!.runtime, "server");
  const url = new URL(tabs[0]!.navStatus.url ?? "");
  assert.equal(url.origin, `http://${board.host}:${board.port}`);
  record(env, "existing:ui-reopens-closed-pane", {
    threadId,
    messageId,
    reply: result.reply.text.trim(),
    elapsedMs,
    previewTabId: tabs[0]!.tabId,
    runtime: tabs[0]!.runtime,
    reveal: true,
  });
}

export async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--existing-only")
    ? "existing"
    : args.includes("--fresh-only")
      ? "fresh"
      : "both";
  const scratch = scratchRoot();
  // Keep the service and callback socket paths within the Unix socket limit.
  const root = mkdtempSync(join(scratch, "inbox-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const environments: Record<string, unknown> = {};

  const runOne = async (
    name: "fresh" | "existing",
    legacy: boolean,
    scenarios: (env: Environment) => Promise<void>,
  ) => {
    const env = await startEnvironment(name, legacy, root);
    try {
      await scenarios(env);
    } finally {
      await teardown(env);
      environments[name] = {
        serverVersion: env.serverVersion,
        steps: env.steps,
        logs: [{ name: "t3-server.log", ...digest(env.logPath) }],
      };
    }
  };
  if (only !== "existing") await runOne("fresh", false, freshScenarios);
  if (only !== "fresh") await runOne("existing", true, existingScenarios);
  const path = join(root, "evidence.json");
  writeFileSync(
    path,
    `${JSON.stringify({ nightlyLine: String(NIGHTLY_LINE), environments }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ passed: true, evidence: path }));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    killSpawned();
    process.exit(1);
  },
);
