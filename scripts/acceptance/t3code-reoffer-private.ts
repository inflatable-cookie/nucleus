/**
 * nucleus#1395's private proof: an open Inbox decision keeps exactly one live card on a
 * private T3 server when a card is lost with its ACP turn.
 *
 * One private T3 environment runs on the installed nightly's own server: its own home,
 * base directory, port and databases, a clean environment (only PATH is inherited), and
 * the checkout's own `nucleus-acp` launcher. It never reads or touches an operator's T3
 * home, and it refuses to start without the run's scratch volume.
 *
 * The scenario is the live shape (2026-11-19): an open decision is offered, then the
 * callback socket is replaced — the service stops, its socket file is removed, and a new
 * service binds the same path. The held turn ends with "Nucleus is unreachable" and its
 * card is left pending on T3. The sweep then settles that card from T3's own pending
 * requests and re-enters the inbox.
 *
 * The second cycle interrupts the live ACP run through T3 with the socket still
 * available. A third cycle replaces the socket again to check repeated losses.
 *
 * - `--expect=reoffer` (this branch): every cycle ends with a new live card for the same
 *   decision version, in the same inbox thread and ACP session, and the decision still
 *   open. The title keeps naming it.
 * - `--expect=lost` (`origin/main`): every loss leaves the still-open decision with no
 *   card, and the title keeps naming a decision nobody can see — the reported stuck
 *   state. The card the ended turn left is settled on T3, its run is live again, and the
 *   version is simply never offered again.
 *
 * Evidence is compact JSON per step with the pending-card state before and after each
 * loss, plus the server log's sha256. Raw logs stay in run scratch. Run through
 * `effigy proof:t3code:reoffer` (the branch) and, for the before state, from a main tree.
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
import { activeStatuses } from "../../hosts/t3code/reads";
import { acpBindingPath, readAcpBinding } from "../../shared/acp/binding";
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

type Projection = {
  thread: { id: string; title: string; pinnedAt?: string | null };
  messages: Array<{ id: string; role: string; text: string }>;
  runs: Array<{ id: string; status: string }>;
  runtimeRequests: Array<{ id: string; kind: string; status: string }>;
  turnItems: Array<{
    type: string;
    runId?: string;
    requestId?: string;
    questions?: Array<{ id: string }>;
  }>;
};

interface Step {
  step: string;
  facts: Record<string, unknown>;
}

interface Environment {
  root: string;
  endpoint: string;
  bearer: string;
  runtimeBearer: string;
  serverVersion: string;
  logPath: string;
  socketPath: string;
  bindingPath: string;
  rpc: T3RpcClient;
  service: QueueService;
  inboxThreadId: string;
  steps: Step[];
  children: ChildProcess[];
  sweepTimer: NodeJS.Timeout | null;
  restartService: (gapMs?: number) => Promise<void>;
}

const field = (decisionId: string) => `nucleus_${decisionId}_1`;

function record(
  env: Environment,
  step: string,
  facts: Record<string, unknown>,
): void {
  env.steps.push({ step, facts });
  console.log(`ok ${step} ${JSON.stringify(facts)}`);
}

type Snapshot = {
  projects: Array<{ id: string; title: string }>;
  threads: Array<{
    id: string;
    projectId: string;
    title: string;
    pinnedAt?: string | null;
    archivedAt?: string | null;
    deletedAt?: string | null;
  }>;
};

/** The thread and project rows the adapter itself reads: the live shell. */
async function shell(rpc: T3RpcClient): Promise<Snapshot | null> {
  let live: (Snapshot & { archivedThreads?: Snapshot["threads"] }) | null =
    null;
  await rpc.readStream(
    "orchestration.subscribeShell",
    { requestCompletionMarker: true },
    (value) => {
      const item = value as {
        kind?: string;
        snapshot?: Snapshot & { archivedThreads?: Snapshot["threads"] };
      };
      if (
        item.kind === "snapshot" &&
        item.snapshot &&
        !("resolvedRepositoryIdentityRoots" in item)
      )
        live = item.snapshot;
      return item.kind === "synchronized";
    },
  );
  return live;
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
        runId: item?.runId,
      };
    });
}

async function cardFor(env: Environment, decisionId: string) {
  const p = await projection(env.rpc, env.inboxThreadId);
  if (!p) return undefined;
  const cards = cardsOf(p).filter(
    (card) => card.questionId === field(decisionId),
  );
  assert.ok(
    cards.length <= 1,
    "T3 has at most one pending card for the version",
  );
  return cards[0] ?? null;
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

async function threadTitle(env: Environment): Promise<string> {
  const snap = await shell(env.rpc);
  return snap?.threads.find((row) => row.id === env.inboxThreadId)?.title ?? "";
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
    // An operator-asked decision names its repository; no task links it, so the inbox owns it.
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

const serviceOf = (nucleusData: string) =>
  new QueueService({
    owner: { dataDir: nucleusData, timers: false },
    fixture: "fake",
    debug: true,
  });

async function startEnvironment(scratch: string): Promise<Environment> {
  const root = mkdtempSync(join(scratch, "t3-reoffer-"));
  console.log(JSON.stringify({ proofRoot: root }));
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
  const server = spawn(
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
  children.push(server);
  spawned.push(server);
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
  collect(server.stdout!);
  collect(server.stderr!);
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
    }, "the private T3Code server");
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
  let rpc = new T3RpcClient({
    endpoint,
    bearer: session.token,
    timeoutMs: 30_000,
  });
  await rpc.connect();

  let service = serviceOf(nucleusData);
  await service.start();
  const health = () =>
    service.health() as unknown as {
      t3code?: { id?: string | null; connected?: boolean };
    };
  const ensureBootstrap = async () => {
    await service
      .debug({ target: "runtime", method: "ensureBootstrap", args: [] })
      .catch(() => undefined);
  };
  const installTicker = setInterval(() => void ensureBootstrap(), 2_000);
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
    await ensureBootstrap();
    return health().t3code?.connected === true && health().t3code?.id === hostId
      ? true
      : null;
  }, "the service to come online as the private T3 host");

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

  const inbox = await acpInboxDirectory(nucleusData, hostId);
  const env: Environment = {
    root,
    endpoint,
    bearer: session.token,
    runtimeBearer,
    serverVersion: descriptor.serverVersion,
    logPath,
    socketPath: join(nucleusData, "callback.sock"),
    bindingPath: acpBindingPath(nucleusData, inbox),
    rpc,
    service,
    inboxThreadId: "",
    steps: [],
    children,
    sweepTimer: null,
    restartService: async (gapMs = 4_000) => {
      // The callback socket is replaced: the service stops, its socket file goes, and a
      // new service binds the same path. The agent keeps running under T3, so its held
      // turn fails to reach Nucleus and ends, exactly as the live evidence shows.
      if (env.sweepTimer) clearInterval(env.sweepTimer);
      env.sweepTimer = null;
      await env.service.stop();
      assert.equal(existsSync(env.socketPath), false, "the old socket is gone");
      await delay(gapMs);
      service = serviceOf(nucleusData);
      env.service = service;
      await service.start();
      await until(async () => {
        await ensureBootstrap();
        return health().t3code?.connected === true ? true : null;
      }, "the service to reconnect to the same T3 host");
      env.sweepTimer = setInterval(
        () =>
          void env.service
            .debug({ target: "engine", method: "sweepOnce", args: [] })
            .catch(() => undefined),
        1_000,
      );
    },
  };
  env.sweepTimer = setInterval(
    () =>
      void env.service
        .debug({ target: "engine", method: "sweepOnce", args: [] })
        .catch(() => undefined),
    1_000,
  );
  record(env, "server-and-install", {
    serverVersion: descriptor.serverVersion,
    isolated: true,
    inboxDirectory: inbox,
    install: install.steps,
  });

  // The inbox appears once the sweep has made its first pass; it is found through its
  // readable project, never through a title the live signal may have replaced.
  const found = await until(async () => {
    const snap = await shell(rpc);
    const project = snap?.projects.find((row) => row.title === "Nucleus Inbox");
    const thread = project
      ? snap!.threads.find(
          (row) =>
            row.projectId === project.id && !row.deletedAt && !row.archivedAt,
        )
      : undefined;
    return thread ? { thread } : null;
  }, "the pinned Nucleus inbox");
  env.inboxThreadId = found.thread.id;
  await until(
    async () => (LIVE_TITLE.test(await threadTitle(env)) ? true : null),
    "the inbox thread's live title",
  );
  record(env, "inbox-ready", {
    thread: found.thread.id,
    title: await threadTitle(env),
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

/** The same decision loses its card across a socket replacement and an independent turn end. */
async function reofferScenarios(
  env: Environment,
  expect: "reoffer" | "lost",
  cycles: number,
) {
  const decision = await addDecision(env, "Proof re-offer");
  const first = await until(
    async () => cardFor(env, decision),
    "the decision's first card",
  );
  assert.equal(
    first.questionId,
    field(decision),
    "the card's field carries the decision id and version",
  );
  const binding = digest(env.bindingPath).sha256;
  const session = readAcpBinding(env.bindingPath).sessionId;
  const pinnedAt = (await shell(env.rpc))?.threads.find(
    (row) => row.id === env.inboxThreadId,
  )?.pinnedAt;
  assert.ok(pinnedAt, "the decision belongs to the pinned Inbox");
  record(env, "card-offered", {
    decision,
    request: first.requestId,
    field: first.questionId,
    title: await threadTitle(env),
    session,
    pinnedAt,
  });

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const before = await cardFor(env, decision);
    const postedBefore = await postedCount(env, decision);
    if (before === null && expect === "lost") {
      // Nothing is left to lose: the decision already has no card, which is the finding.
      record(env, `cycle-${cycle}`, {
        lostCard: null,
        replacementCard: null,
        cardsPostedBefore: postedBefore,
        cardsPostedAfter: postedBefore,
        title: await threadTitle(env),
        decisionStatus: await decisionStatus(env, decision),
      });
      continue;
    }
    assert.ok(before, `cycle ${cycle} starts with a live card`);

    const interrupted = cycle === 2;
    assert.ok(
      existsSync(env.socketPath),
      "the callback socket exists before the loss",
    );
    if (interrupted) {
      assert.ok(before.runId, "the pending card names its ACP run");
      await env.rpc.call("orchestration.dispatchCommand", {
        type: "run.interrupt",
        commandId: randomUUID(),
        threadId: env.inboxThreadId,
        runId: before.runId,
      });
    } else {
      await env.restartService();
    }
    assert.ok(
      existsSync(env.socketPath),
      "the callback socket exists after the loss",
    );

    // The card the ended turn left behind is settled from T3's own pending requests, and
    // the inbox is re-entered for the decision that is still open.
    const settled = await until(async () => {
      const card = await cardFor(env, decision);
      return card === null || (card && card.requestId !== before.requestId)
        ? { settled: card === null }
        : null;
    }, `cycle ${cycle} to settle the card the ended turn left`);
    const replacement = await until(
      async () => {
        const card = await cardFor(env, decision);
        return card && card.requestId !== before.requestId ? card : null;
      },
      `cycle ${cycle}'s replacement card`,
      expect === "reoffer" ? 150_000 : 45_000,
    ).catch(async (error) => {
      const p = await projection(env.rpc, env.inboxThreadId);
      console.error(
        JSON.stringify({
          cycle,
          diagnostic: {
            runs: p?.runs.map((row) => row.status),
            requests: p?.runtimeRequests.map(
              (row) => `${row.kind}/${row.status}`,
            ),
            cards: p ? cardsOf(p).map((card) => card.questionId) : null,
            title: await threadTitle(env).catch(() => "unreadable"),
            posted: await postedCount(env, decision).catch(() => -1),
          },
        }),
      );
      if (expect === "reoffer") throw error;
      return null;
    });
    const postedAfter = await postedCount(env, decision);
    const title = await threadTitle(env);
    const status = await decisionStatus(env, decision);
    const p = await projection(env.rpc, env.inboxThreadId);
    assert.ok(p, "T3 returned the Inbox projection after the loss");
    const oldRun = p.runs.find((run) => run.id === before.runId);
    assert.ok(
      oldRun && !activeStatuses.has(oldRun.status as never),
      "the old card's run ended",
    );
    assert.equal(
      digest(env.bindingPath).sha256,
      binding,
      "the same binding and session remain",
    );
    const pin = (await shell(env.rpc))?.threads.find(
      (row) => row.id === env.inboxThreadId,
    )?.pinnedAt;
    assert.equal(pin, pinnedAt, "the same Inbox thread is still pinned");
    const liveCards = cardsOf(p).filter(
      (card) => card.questionId === field(decision),
    ).length;
    record(env, `cycle-${cycle}`, {
      lostCard: before.requestId,
      settledOnly: settled.settled,
      replacementCard: replacement ? replacement.requestId : null,
      replacementField: replacement ? replacement.questionId : null,
      cardsPostedBefore: postedBefore,
      cardsPostedAfter: postedAfter,
      title,
      decisionStatus: status,
      loss: interrupted ? "run.interrupt" : "callback-socket-replacement",
      oldRunStatus: oldRun.status,
      liveCards,
      sameBindingAndPin: true,
    });

    if (expect === "reoffer") {
      assert.ok(
        replacement,
        `cycle ${cycle} re-offers the still-open version as a new card`,
      );
      assert.equal(
        replacement!.questionId,
        field(decision),
        "the replacement carries the same decision version",
      );
      assert.equal(
        postedAfter,
        postedBefore + 1,
        `cycle ${cycle} posts exactly one more card`,
      );
      assert.equal(liveCards, 1, "the replacement is the only live card");
      assert.equal(status, "open", "the card still asks the open decision");
      assert.equal(
        title,
        "1 decision to answer",
        `cycle ${cycle} keeps naming the decision`,
      );
    } else {
      assert.equal(status, "open", `cycle ${cycle} leaves the decision open`);
      assert.equal(
        replacement,
        null,
        `cycle ${cycle} leaves the open decision with no card`,
      );
      assert.equal(liveCards, 0, "T3 confirms the card is absent");
      assert.equal(
        postedAfter,
        postedBefore,
        `cycle ${cycle} posts no further card`,
      );
      assert.equal(
        title,
        "1 decision to answer",
        `cycle ${cycle} still names the decision nobody can answer`,
      );
    }
  }
  const posted = await postedCount(env, decision);
  record(env, "final", { cardsPosted: posted, expectation: expect, cycles });
}

/**
 * Fault lines shown on the Inbox thread. T3 may append a later chunk to the same assistant
 * message, so the count is occurrences across message text, never a count of messages.
 */
async function faultLineCount(env: Environment): Promise<number> {
  const p = await projection(env.rpc, env.inboxThreadId);
  return p
    ? p.messages.reduce(
        (total, message) =>
          total + (message.text.split("Nucleus is unreachable").length - 1),
        0,
      )
    : -1;
}

/**
 * nucleus#1400: a socket gap never ends a held turn. The Inbox's open decision keeps its
 * one live card, its run stays live, and the same binding, session and pin remain. The
 * short gap is a roll; the long gap is a sustained outage that shows one fault line.
 */
async function heldScenarios(env: Environment) {
  const decision = await addDecision(env, "Proof socket gap");
  const first = await until(
    async () => cardFor(env, decision),
    "the decision's first card",
  );
  const binding = digest(env.bindingPath).sha256;
  const session = readAcpBinding(env.bindingPath).sessionId;
  const pinnedAt = (await shell(env.rpc))?.threads.find(
    (row) => row.id === env.inboxThreadId,
  )?.pinnedAt;
  assert.ok(pinnedAt, "the decision belongs to the pinned Inbox");
  record(env, "card-offered", {
    decision,
    request: first.requestId,
    run: first.runId,
    session,
  });
  const postedBefore = await postedCount(env, decision);

  const cases = [
    { name: "roll-while-held", gapMs: 4_000 },
    { name: "sustained-outage", gapMs: 40_000 },
  ];
  for (const testCase of cases) {
    const before = await cardFor(env, decision);
    assert.ok(before, `${testCase.name} starts with the live card`);
    const faultsBefore = await faultLineCount(env);
    assert.ok(
      existsSync(env.socketPath),
      "the callback socket exists before the gap",
    );
    await env.restartService(testCase.gapMs);
    assert.ok(
      existsSync(env.socketPath),
      "the callback socket exists after the gap",
    );
    // The re-attached turn settles on the new service before the proof reads it.
    await delay(8_000);
    const after = await cardFor(env, decision);
    const p = await projection(env.rpc, env.inboxThreadId);
    assert.ok(p, "T3 returned the Inbox projection after the gap");
    const run = p.runs.find((row) => row.id === before.runId);
    assert.ok(
      run && activeStatuses.has(run.status as never),
      `${testCase.name} keeps the held run live`,
    );
    assert.equal(
      after?.requestId,
      before.requestId,
      `${testCase.name} keeps the same live card, with no loss and no re-post`,
    );
    assert.equal(
      await postedCount(env, decision),
      postedBefore,
      `${testCase.name} posts no card`,
    );
    assert.equal(
      digest(env.bindingPath).sha256,
      binding,
      "the same binding remains",
    );
    assert.equal(
      readAcpBinding(env.bindingPath).sessionId,
      session,
      "the same session remains",
    );
    const pin = (await shell(env.rpc))?.threads.find(
      (row) => row.id === env.inboxThreadId,
    )?.pinnedAt;
    assert.equal(pin, pinnedAt, "the same Inbox thread is still pinned");
    assert.equal(
      await decisionStatus(env, decision),
      "open",
      `${testCase.name} leaves the decision open`,
    );
    const faults = (await faultLineCount(env)) - faultsBefore;
    if (testCase.gapMs > 10_000)
      assert.equal(faults, 1, "a sustained outage shows one fault line");
    record(env, testCase.name, {
      gapMs: testCase.gapMs,
      run: before.runId,
      runStatus: run.status,
      sameCard: after?.requestId === before.requestId,
      faultLinesAdded: faults,
      title: await threadTitle(env),
    });
  }
  record(env, "final", {
    cardsPosted: await postedCount(env, decision),
    expectation: "held",
  });
}

export async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--expect=held")) {
    const env = await startEnvironment(scratchRoot());
    try {
      await heldScenarios(env);
      const path = join(env.root, "evidence.json");
      writeFileSync(
        path,
        `${JSON.stringify({ nightlyLine: String(NIGHTLY_LINE), expectation: "held", steps: env.steps, logs: [{ name: "t3-server.log", ...digest(env.logPath) }] }, null, 2)}\n`,
        { mode: 0o600 },
      );
      console.log(JSON.stringify({ passed: true, evidence: path }));
    } finally {
      await teardown(env);
    }
    return;
  }
  const expect = args.includes("--expect=lost") ? "lost" : "reoffer";
  const cycleArg = args.find((arg) => arg.startsWith("--cycles="));
  const cycles = cycleArg
    ? Number(cycleArg.split("=")[1])
    : expect === "lost"
      ? 1
      : 3;
  const scratch = scratchRoot();
  const env = await startEnvironment(scratch);
  try {
    await reofferScenarios(env, expect, cycles);
    const path = join(env.root, "evidence.json");
    writeFileSync(
      path,
      `${JSON.stringify({ nightlyLine: String(NIGHTLY_LINE), expectation: expect, cycles, steps: env.steps, logs: [{ name: "t3-server.log", ...digest(env.logPath) }] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ passed: true, evidence: path }));
  } finally {
    await teardown(env);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    killSpawned();
    process.exit(1);
  },
);
