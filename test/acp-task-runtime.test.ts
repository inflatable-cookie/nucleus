/**
 * The ACP task-parent runtime recognition (nucleus#1377).
 *
 * The shapes here are the ones the host actually runs: a connected T3 server, the
 * `nucleus-acp` process it starts for a task's parent thread with the worktree as
 * cwd, that thread's native role sessions, and the standing MCP server a session
 * keeps. Identity is proved from the same records the runtime writes: the stored
 * T3 connection, the running server's own runtime descriptor, and the ACP binding
 * minted for the task's checkout. A process the proof cannot identify holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
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
import type { HostProcessFact } from "../core/host/types";
import { mintAcpSession } from "../core/acp/binding";
import { acpBindingPath } from "../shared/acp/binding";
import { readT3RuntimeDescriptor } from "../shared/t3/settings";
import { readHostUidProcesses } from "../core/machine/host-process-listing";
import {
  acpTaskRuntimePids,
  possibleAcpRuntimePids,
} from "../core/machine/acp-task-runtime";
import {
  ownedToolProcessTreeVerdict,
  possibleParticipantRuntimePids,
} from "../core/machine/owned-tool-process-proof";
import {
  participantRuntime,
  storeDataHome,
  t3AcpServerRuntime,
} from "../core/machine/participant-runtime";
import {
  readAcpProcessIdentities,
  type AcpProcessIdentities,
  type AcpProcessIdentity,
} from "../core/machine/run-process-identity";
import { workspaceToolProcessIssue } from "../core/recovery/stall";

const ENV_HOST = "t3code:environment-1";
const SERVER = 500;
const PARENT = 501;
const SESSION = 502;
const MCP = 503;
const COMMAND = 504;
const RUN = "11111111-2222-3333-4444-555555555555";
const OTHER_RUN = "22222222-3333-4444-5555-666666666666";

function scratch(): string {
  const root = process.env.TMPDIR ?? process.env.TMP;
  if (!root) throw Error("The run scratch volume is required");
  return mkdtempSync(join(root, "acp-runtime-"));
}

function fact(
  pid: number,
  ppid: number | null,
  command: string,
  cwd: string | null,
  extra: Partial<HostProcessFact> = {},
): HostProcessFact {
  return {
    pid,
    ppid,
    state: "S",
    pgid: pid,
    uid: 501,
    startIdentity: `${pid}@fixture`,
    command,
    cwd,
    ...extra,
  };
}

/** A private data home whose stored connection, descriptor and bindings are real files. */
function hostFixture(
  options: {
    port?: number;
    descriptorOrigin?: string;
    baseDir?: boolean;
  } = {},
) {
  const root = scratch();
  const worktree = join(root, "task-worktree");
  const otherWorktree = join(root, "other-worktree");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(otherWorktree, { recursive: true });
  const dataHome = join(root, "data");
  const baseDir = join(root, "t3");
  const port = options.port ?? 3773;
  mkdirSync(dataHome, { recursive: true });
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  writeFileSync(
    join(baseDir, "userdata", "server-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid: SERVER,
      host: "127.0.0.1",
      port,
      origin: options.descriptorOrigin ?? `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
      serverVersion: "0.1.6-nightly.fixture",
    })}\n`,
  );
  writeFileSync(
    join(dataHome, "settings.json"),
    `${JSON.stringify({
      daemonUrl: "ws://127.0.0.1:6767/ws",
      t3code: {
        endpoint: `ws://127.0.0.1:${port}/ws`,
        bearer: "fixture-bearer",
        environmentId: "environment-1",
        ...(options.baseDir === false ? {} : { baseDir }),
      },
    })}\n`,
  );
  const mint = (taskId: string, directory: string) =>
    mintAcpSession({
      dataHome,
      socketPath: join(root, "callback.sock"),
      taskId,
      directory,
    });
  mint("task-1", worktree);
  mint("task-other", otherWorktree);
  const task = { id: "task-1", agentId: "parent-thread", hostId: ENV_HOST };
  const runs = [
    { taskId: "task-1", agentId: "role-thread-1", hostId: ENV_HOST },
  ];
  return {
    root,
    worktree,
    otherWorktree,
    dataHome,
    baseDir,
    port,
    task,
    runs,
    bindingPath: acpBindingPath(dataHome, worktree),
  };
}

/** The identities each T3 process carries, as its own environment read answers. */
function identities(
  overrides: Record<number, AcpProcessIdentity | null> = {},
): (pids: readonly number[]) => AcpProcessIdentities {
  const base = new Map<number, AcpProcessIdentity | null>([
    [
      PARENT,
      { t3ThreadId: "parent-thread", sessionPath: null, dataHome: null },
    ],
    [
      SESSION,
      { t3ThreadId: "role-thread-1", sessionPath: null, dataHome: null },
    ],
    [MCP, { t3ThreadId: "role-thread-1", sessionPath: null, dataHome: null }],
    [
      COMMAND,
      { t3ThreadId: "role-thread-1", sessionPath: null, dataHome: null },
    ],
  ]);
  for (const [pid, value] of Object.entries(overrides))
    base.set(Number(pid), value);
  return (pids) => new Map(pids.map((pid) => [pid, base.get(pid) ?? null]));
}

function listing(worktree: string): HostProcessFact[] {
  return [
    fact(
      SERVER,
      1,
      "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code",
      "/",
    ),
    fact(
      PARENT,
      SERVER,
      `node ${join(worktree, "..", "install", "bin", "nucleus-acp.mjs")}`,
      worktree,
    ),
    fact(SESSION, PARENT, "node /fixture/provider-session.mjs", worktree),
    fact(
      MCP,
      SESSION,
      `node /fixture/install/bin/mcp-report.mjs /fixture/tickets/mcp-${RUN}.json`,
      worktree,
    ),
    fact(COMMAND, SESSION, "node build.mjs", worktree),
  ];
}

function runtimeFor(fixture: ReturnType<typeof hostFixture>) {
  return participantRuntime({
    dataHome: fixture.dataHome,
    tasks: [fixture.task],
    runs: fixture.runs,
  });
}

const sorted = (pids: Set<number>) => [...pids].sort((a, b) => a - b);

test("the task parent, its session and the session's MCP server are runtime", () => {
  const fixture = hostFixture();
  const runtime = runtimeFor(fixture);
  assert.equal(runtime.acp?.serverPid, SERVER);
  assert.deepEqual(runtime.acp?.taskIds, ["task-1"]);
  assert.deepEqual(runtime.acp?.threadIds, ["role-thread-1"]);
  const processes = listing(fixture.worktree);
  const pids = acpTaskRuntimePids(processes, runtime.acp, {
    identities: identities(),
  });
  assert.deepEqual(sorted(pids), [PARENT, SESSION, MCP]);
  // A command the session's tools start is work, never the runtime.
  assert.equal(pids.has(COMMAND), false);
});

test("the task's own runtime never blocks the workspace proof", () => {
  const fixture = hostFixture();
  const runtime = runtimeFor(fixture);
  const runtimeOnly = listing(fixture.worktree).filter(
    (process) => process.pid !== COMMAND,
  );
  assert.equal(
    workspaceToolProcessIssue(
      runtimeOnly,
      fixture.worktree,
      [OTHER_RUN],
      runtime,
    ),
    null,
  );
  // And a command beneath the session still holds the proof.
  assert.match(
    workspaceToolProcessIssue(
      listing(fixture.worktree),
      fixture.worktree,
      [OTHER_RUN],
      runtime,
    )!,
    /process 504 remains in the task workspace process tree/,
  );
});

test("a parent whose ancestry, environment or binding proves nothing holds", () => {
  const fixture = hostFixture();
  const runtime = runtimeFor(fixture);
  const strayParents = [
    // A binding for a different task.
    fact(
      505,
      SERVER,
      "node /fixture/install/bin/nucleus-acp.mjs",
      fixture.otherWorktree,
    ),
    // A parent that is not a child of the connected server.
    fact(600, 1, "node /fixture/install/bin/nucleus-acp.mjs", fixture.worktree),
    // An unreadable environment.
    fact(
      601,
      SERVER,
      "node /fixture/install/bin/nucleus-acp.mjs",
      fixture.worktree,
    ),
  ];
  const processes = [...listing(fixture.worktree), ...strayParents];
  const pids = acpTaskRuntimePids(processes, runtime.acp, {
    identities: identities({ 601: null }),
  });
  assert.deepEqual(sorted(pids), [PARENT, SESSION, MCP]);
  assert.match(
    workspaceToolProcessIssue(
      processes.filter((process) => process.pid !== COMMAND),
      fixture.worktree,
      [OTHER_RUN],
      runtime,
    )!,
    /process 600 remains in the task workspace process tree/,
  );
});

test("a session is runtime when its own environment names the participant thread", () => {
  const fixture = hostFixture();
  const runtime = runtimeFor(fixture);
  // The real host parents role sessions on the server; their own thread env names them.
  const processes = [
    fact(SERVER, 1, "T3 Code (Nightly)", "/"),
    fact(
      PARENT,
      SERVER,
      "node /fixture/install/bin/nucleus-acp.mjs",
      fixture.worktree,
    ),
    fact(SESSION, SERVER, "codex app-server", fixture.worktree),
    fact(MCP, SESSION, "cua-driver mcp", fixture.worktree),
    fact(COMMAND, SESSION, "node build.mjs", fixture.worktree),
  ];
  assert.deepEqual(
    sorted(
      acpTaskRuntimePids(processes, runtime.acp, { identities: identities() }),
    ),
    [PARENT, SESSION, MCP],
  );
});

test("the connected server comes from the stored connection's own descriptor", () => {
  const fixture = hostFixture();
  assert.deepEqual(t3AcpServerRuntime(fixture.dataHome), {
    serverPid: SERVER,
    dataHome: fixture.dataHome,
  });
  const mismatched = hostFixture({ descriptorOrigin: "http://127.0.0.1:3999" });
  assert.equal(t3AcpServerRuntime(mismatched.dataHome), null);
  assert.equal(runtimeFor(mismatched).acp ?? null, null);
  const noBaseDir = hostFixture({ baseDir: false });
  assert.equal(t3AcpServerRuntime(noBaseDir.dataHome), null);
  // A task on another host never gets an ACP binding.
  assert.equal(
    participantRuntime({
      dataHome: fixture.dataHome,
      tasks: [{ id: "task-1", agentId: "thread", hostId: "paseo:local" }],
      runs: [],
    }).acp ?? null,
    null,
  );
});

test("the listing must hold the connected server for the parent to be runtime", () => {
  const fixture = hostFixture();
  const runtime = runtimeFor(fixture);
  const processes = listing(fixture.worktree).filter(
    (process) => process.pid !== SERVER,
  );
  assert.equal(
    acpTaskRuntimePids(processes, runtime.acp, {
      identities: identities(),
    }).size,
    0,
  );
});

test("cleanup preserves a plausible ACP runtime whose identity is unreadable", () => {
  const fixture = hostFixture();
  const processes = listing(fixture.worktree);
  assert.deepEqual(sorted(possibleAcpRuntimePids(processes)), [
    PARENT,
    SESSION,
    MCP,
  ]);
  const shared = possibleParticipantRuntimePids(processes);
  for (const pid of [PARENT, SESSION, MCP]) assert.ok(shared.has(pid));
});

test("a report helper's live ticket still settles through the owned-tool proof", () => {
  const fixture = hostFixture();
  const runtime = runtimeFor(fixture);
  const ticket = `/fixture/tickets/mcp-${RUN}.json`;
  const processes: HostProcessFact[] = [
    fact(SESSION, SERVER, "codex app-server", fixture.worktree),
    fact(
      MCP,
      SESSION,
      `node /fixture/install/bin/mcp-report.mjs ${ticket}`,
      fixture.worktree,
    ),
  ];
  assert.deepEqual(
    ownedToolProcessTreeVerdict(RUN, processes, {
      noTurnLive: true,
      runtime,
    }),
    { state: "empty", providerPid: SESSION, helperPid: MCP },
  );
});

test("storeDataHome refuses an in-memory store", () => {
  assert.equal(storeDataHome({ path: ":memory:" }), null);
  assert.equal(storeDataHome({ path: "/tmp/data/queue.sqlite" }), "/tmp/data");
});

test("the descriptor is read from the recorded base directory", () => {
  const fixture = hostFixture();
  assert.equal(readT3RuntimeDescriptor(fixture.baseDir)?.pid, SERVER);
});

test(
  "a real child's own environment is read for its T3 identity",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    const fixture = hostFixture();
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 20000)"],
      {
        cwd: fixture.worktree,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: fixture.root,
          T3CODE_THREAD_ID: "role-thread-1",
          NUCLEUS_ACP_SESSION: fixture.bindingPath,
          NUCLEUS_DATA_HOME: fixture.dataHome,
        },
        stdio: "ignore",
      },
    );
    try {
      await delay(300);
      const identity = readAcpProcessIdentities([child.pid!]).get(child.pid!);
      assert.equal(identity?.t3ThreadId, "role-thread-1");
      assert.equal(identity?.sessionPath, fixture.bindingPath);
      assert.equal(identity?.dataHome, fixture.dataHome);
    } finally {
      child.kill("SIGKILL");
    }
  },
);

/**
 * The shapes through the real proof and a real host listing. The test starts the
 * process the descriptor names, that process starts the real `bin/nucleus-acp.mjs`
 * entry with a minted binding and a real role session, and the session starts a
 * real command. Nothing here synthesises a fact the proof reads from the process
 * table, from the environment or from the files Nucleus owns.
 */
test(
  "real processes: the ACP parent and its session are runtime, a command holds",
  { skip: !["darwin", "linux"].includes(process.platform), timeout: 180_000 },
  async () => {
    const fixture = hostFixture();
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const entry = fileURLToPath(
      new URL("../bin/nucleus-acp.mjs", import.meta.url),
    );
    const sessionPidFile = join(fixture.root, "session.pid");
    const commandPidFile = join(fixture.root, "command.pid");
    const serverScript = join(fixture.root, "fake-t3-server.cjs");
    const sessionScript = join(fixture.root, "fake-session.cjs");
    // The session: a real role thread that starts one real command of its own.
    writeFileSync(
      sessionScript,
      `const { spawn } = require("node:child_process");\n` +
        `const command = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { env: { ...process.env, T3CODE_THREAD_ID: "role-thread-1" }, stdio: "ignore" });\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(commandPidFile)}, String(command.pid));\n` +
        `setTimeout(() => {}, 120000);\n`,
    );
    // The server: it owns the ACP parent and the role session as direct children.
    writeFileSync(
      serverScript,
      `const { spawn } = require("node:child_process");\n` +
        `const acp = spawn(process.execPath, ["--import", ${JSON.stringify(tsx)}, ${JSON.stringify(entry)}], { cwd: ${JSON.stringify(fixture.worktree)}, env: { ...process.env, NUCLEUS_DATA_HOME: ${JSON.stringify(fixture.dataHome)} }, stdio: ["pipe", "ignore", "ignore"] });\n` +
        `const session = spawn(process.execPath, [${JSON.stringify(sessionScript)}], { cwd: ${JSON.stringify(fixture.worktree)}, env: { ...process.env, T3CODE_THREAD_ID: "role-thread-1" }, stdio: "ignore" });\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(sessionPidFile)}, JSON.stringify({ acp: acp.pid, session: session.pid }));\n` +
        `setTimeout(() => {}, 120000);\n`,
    );
    const server = spawn(process.execPath, [serverScript], {
      cwd: fixture.root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: fixture.root,
        TMPDIR: fixture.root,
      },
      stdio: "ignore",
    });
    try {
      const read = async <T>(file: string, what: string): Promise<T> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (existsSync(file)) {
            const text = readFileSync(file, "utf8").trim();
            if (text) return JSON.parse(text) as T;
          }
          await delay(100);
        }
        throw Error(`Timed out waiting for ${what}`);
      };
      const pids = await read<{ acp: number; session: number }>(
        sessionPidFile,
        "the fake server's children",
      );
      const commandPid = await read<number>(
        commandPidFile,
        "the session's command",
      );
      // The descriptor names the server this test started.
      writeFileSync(
        join(fixture.baseDir, "userdata", "server-runtime.json"),
        `${JSON.stringify({
          version: 1,
          pid: server.pid,
          host: "127.0.0.1",
          port: fixture.port,
          origin: `http://127.0.0.1:${fixture.port}`,
          serverVersion: "0.1.6-nightly.fixture",
        })}\n`,
      );
      const runtime = runtimeFor(fixture);
      assert.equal(runtime.acp?.serverPid, server.pid);
      const listingRead = await readHostUidProcesses();
      assert.equal(listingRead.state, "listed");
      const processes =
        listingRead.state === "listed" ? listingRead.processes : [];
      const recognised = acpTaskRuntimePids(processes, runtime.acp);
      assert.ok(recognised.has(pids.acp), "the real ACP parent is runtime");
      assert.ok(recognised.has(pids.session), "the real session is runtime");
      const issue = workspaceToolProcessIssue(
        processes,
        fixture.worktree,
        ["run-1"],
        runtime,
      );
      assert.match(issue!, new RegExp(`process ${commandPid}`));
      const withoutCommand = processes.filter(
        (process) => process.pid !== commandPid,
      );
      assert.equal(
        workspaceToolProcessIssue(
          withoutCommand,
          fixture.worktree,
          ["run-1"],
          runtime,
        ),
        null,
        "the task's own runtime never blocks the workspace proof",
      );
    } finally {
      server.kill("SIGKILL");
    }
  },
);
