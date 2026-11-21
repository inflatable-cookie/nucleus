/**
 * nucleus#1378's private proof: the T3 task parent transcript on the installed nightly.
 *
 * The T3 server is the installed nightly's own entry, extracted into this run's
 * scratch and started with `env -i`-style isolation: its own base directory, HOME,
 * port and databases. The operator's live T3 home is never read or touched. The
 * Nucleus side is a private data home with a real QueueService, the real
 * `nucleus t3 install` route, and the production parent launcher, so the held turn,
 * its lines and the release and re-entry all run on the actual wire. Steps:
 *
 * 1. initial launch: the parent launches on the `nucleus` ACP provider and holds one
 *    live run whose first line names the task;
 * 2. same-state writes: writes that change nothing shown send no line, and the run
 *    stays the same run;
 * 3. several milestones within one held turn: review, reviewing, merging each send
 *    one line, the PR link once, and the lines are separate paragraphs on the wire;
 * 4. release and re-entry: the sweep releases a parent with no child, and the
 *    production re-entry holds a new run;
 * 5. the quiet system re-entry check: a `system`-created re-entry is probed for a
 *    visible user bubble and whether it holds the run for native children;
 * 6. closeout: a finished task releases and archives the parent, and the finished
 *    line appears once.
 *
 * No operator message is recorded by any re-entry; no marker, task UUID or protocol
 * frame appears in the operator transcript. Evidence is compact JSON per step with
 * hashes of the raw logs, written beside the run. Run it through
 * `effigy proof:t3code:held-turn`; the archive comes from `--asar` or the installed app.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3RpcClient } from "../../hosts/t3code/rpc";
import { T3CodeHost } from "../../hosts/t3code/adapter";
import { HOLD_MARKER } from "../../hosts/t3code/nesting";
import { activeStatuses } from "../../hosts/t3code/reads";
import { QueueService } from "../../service/transport/server";
import { AcpSessions } from "../../core/acp/sessions";
import { Store } from "../../core/store/store";
import type { Engine } from "../../core/engine";
import { submissionSchema } from "../../shared/contracts";
import {
  NIGHTLY_LINE,
  extractArchive,
  freePort,
  run,
  scratchRoot,
  until,
} from "./t3code-private-kit";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const INSTALLED_APP =
  "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar";
const PR_URL = "https://github.com/example-org/synthetic-repository/pull/276";
const SHOWN_MARKER =
  /nucleus-hold-the-task-thread|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|"jsonrpc"/;
const HOLD_TEXT = HOLD_MARKER;

type Message = { id: string; role: string; text: string };
type Projection = {
  thread: {
    id: string;
    providerInstanceId: string;
    archivedAt?: string | null;
    snoozedUntil?: string | null;
  };
  runs: Array<{ id: string; status: string; rootNodeId?: string | null }>;
  messages: Message[];
};

function sha256(path: string): { path: string; bytes: number; sha256: string } {
  const bytes = readFileSync(path);
  return {
    path: path.split("/").pop()!,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const asar = resolve(
    option("--asar") ?? process.env.NUCLEUS_T3_PROOF_ASAR ?? INSTALLED_APP,
  );
  const root = mkdtempSync(join(scratchRoot(), "t3-held-turn-"));
  console.log(JSON.stringify({ proofRoot: root }));
  const evidence: Record<string, unknown> = {
    steps: [] as Array<Record<string, unknown>>,
  };
  const steps = evidence.steps as Array<Record<string, unknown>>;
  const note = (step: string, facts: Record<string, unknown>) => {
    steps.push({ step, ok: true, facts });
    console.log(`ok ${step} ${JSON.stringify(facts)}`);
  };

  // The nightly's own server entry, extracted into this run's scratch.
  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  extractArchive(asar, bundle);
  const metadata = JSON.parse(
    readFileSync(join(bundle, "package.json"), "utf8"),
  ) as { version: string };
  assert.match(metadata.version, NIGHTLY_LINE);
  evidence.installedVersion = metadata.version;
  evidence.archiveSha256 = createHash("sha256")
    .update(readFileSync(asar))
    .digest("hex");
  const serverEntry = join(bundle, "apps/server/dist/bin.mjs");
  const t3 = join(root, "bin", "t3");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(
    t3,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverEntry)} "$@"\n`,
    { mode: 0o755 },
  );

  // Private homes: T3's base directory, this run's HOME, the Nucleus data home and temp.
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

  // The Nucleus ACP agent the provider launches, with every frame it exchanges logged.
  const acpLauncher = join(root, "bin", "nucleus-acp");
  const proxy = join(root, "bin", "acp-proxy.cjs");
  const acpLog = join(root, "acp-frames.log");
  writeFileSync(
    proxy,
    `const {spawn}=require("node:child_process"); const fs=require("node:fs");
` +
      `const child=spawn(${JSON.stringify(process.execPath)},["--import",${JSON.stringify(join(checkout, "node_modules/tsx/dist/loader.mjs"))},process.argv[2],...process.argv.slice(3)],{stdio:["pipe","pipe","pipe"]});
` +
      `function relay(source,dest,label){let buf="";source.on("data",chunk=>{dest.write(chunk);buf+=chunk;let i;while((i=buf.indexOf("\\n"))>=0){fs.appendFileSync(${JSON.stringify(acpLog)},label+buf.slice(0,i).replace(/Bearer [A-Za-z0-9_.~+\\/-]+/g,"Bearer [redacted]")+"\\n");buf=buf.slice(i+1)}})}
` +
      `relay(process.stdin,child.stdin,"IN ");relay(child.stdout,process.stdout,"OUT ");child.stderr.pipe(process.stderr);process.stdin.on("end",()=>child.stdin.end());child.on("exit",code=>process.exit(code??1));
`,
    { mode: 0o700 },
  );
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(nucleusData, "settings.json"),
    JSON.stringify({ daemonUrl: "ws://127.0.0.1:6767/ws" }, null, 2),
    { mode: 0o600 },
  );

  // A synthetic repository, the task's checkout and a second checkout for the task parent.
  const repository = join(root, "synthetic-repository");
  const taskDir = join(root, "task-parent-worktree");
  mkdirSync(repository);
  const git = async (argv: string[]) =>
    await run(["git", ...argv], {
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

  let server = null as ChildProcess | null;
  let service: QueueService | null = null;
  let rpc: T3RpcClient | null = null;
  let rowHost: T3CodeHost | null = null;
  let rowStore: Store | null = null;
  try {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const t3Log = join(root, "t3-server.log");
    const collect = (stream: NodeJS.ReadableStream) =>
      stream.on("data", (bytes) => {
        writeFileSync(
          t3Log,
          `${bytes}`.replace(
            /pairingUrl:\S+|#token=\S+/g,
            "[private pairing URL redacted]",
          ),
          { flag: "a" },
        );
      });
    const startServer = async () => {
      server = spawn(
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
      return await until(async () => {
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
    };
    const descriptor = await startServer();
    assert.match(descriptor.serverVersion, NIGHTLY_LINE);
    evidence.target = {
      serverVersion: descriptor.serverVersion,
      environmentId: descriptor.environmentId,
      isolated: true,
    };
    note("private-t3-server", {
      serverVersion: descriptor.serverVersion,
      isolated: true,
    });

    // A proof bearer for the reads and launches it drives directly.
    const session = JSON.parse(
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
    ) as { token: string };
    const bearer = session.token;

    // The Nucleus service, in-process, with the same debug seam the install proof uses.
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

    // 1. install the provider through the operator's own route, against this private server.
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
              t3,
              "--acp-command",
              acpLauncher,
              "--json",
            ],
            { env: environment, cwd: root },
          ),
        )
      ).trim(),
    ) as { steps: unknown };
    const health = () =>
      service!.health() as unknown as {
        t3code?: { id?: string | null; connected?: boolean };
      };
    await until(
      async () => {
        await tick();
        return health().t3code?.connected === true &&
          health().t3code?.id === `t3code:${descriptor.environmentId}`
          ? true
          : null;
      },
      "the service to adopt the private T3Code",
      90_000,
    );
    note("install-and-adopt", {
      install: install.steps,
      hostId: health().t3code!.id,
    });

    // The Nucleus side of the parent: a real task checkout and a store the ACP surface reads.
    const hostId = `t3code:${descriptor.environmentId}`;
    const planning = "a".repeat(40);
    const task = (await service.debug({
      target: "store",
      method: "insert",
      args: [
        submissionSchema.parse({
          submissionId: "held-turn-proof",
          title: "Held turn proof",
          repoPath: repository,
          planningCommit: planning,
          brief: { text: "Synthetic held turn proof" },
          originAgentId: "proof-origin",
        }),
        hostId,
        "brief",
        planning,
      ],
    })) as { id: string };
    const setTask = async (fields: Record<string, unknown>) => {
      await service!.debug({
        target: "store",
        method: "update",
        args: [task.id, fields],
      });
    };
    const storedTask = async () =>
      (await service!.debug({
        target: "store",
        method: "task",
        args: [task.id],
      })) as Record<string, unknown> & { phase: string };
    await setTask({ directory: taskDir, phase: "working" });
    await service.debug({
      target: "store",
      method: "setMeta",
      args: ["paused", false],
    });

    // The adapter's own surface over the same store file, as the install proof wires it.
    rowStore = new Store(join(nucleusData, "queue.sqlite"));
    const rowAcp = new AcpSessions({ store: rowStore } as unknown as Engine, {
      dataHome: nucleusData,
      socketPath: join(nucleusData, "callback.sock"),
    });
    rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 30_000 });
    await rpc.connect();
    const projectId = `held-turn-project-${Date.now()}`;
    await rpc.call("projects.mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "Synthetic held turn",
      workspaceRoot: repository,
    });
    rowHost = new T3CodeHost({
      endpoint,
      bearer,
      statePath: join(root, "host.json"),
      acp: () => rowAcp,
    });
    await rowHost.connect();
    const workspace = await rowHost.createWorkspace({
      title: "Held turn proof",
      requestId: "held-turn-workspace",
      directory: taskDir,
      project: { projectId },
    });
    const workspaceRecord = rowHost.state.read().workspaces[workspace.id]!;
    const nesting = rowHost.nesting as unknown as {
      launchParent(
        input: unknown,
        provider: unknown,
        acp: AcpSessions,
      ): Promise<{ threadId: string; sessionId: string }>;
      heldRun(
        parent: unknown,
        requestId: string,
        waitMs: number,
      ): Promise<{ id: string; rootNodeId: string } | null>;
      reconcile(tasks: unknown[]): Promise<void>;
      archiveFinishedParents(tasks: unknown[]): Promise<unknown[]>;
      parentOf(
        taskId: string,
      ): { threadId: string; taskId: string } | undefined;
    };

    // The same parent launch as the production create: the binding, the record, and the T3 thread.
    const parent = await nesting.launchParent(
      {
        attempt: { labels: { "nucleus.task": task.id } },
        spec: {},
        title: "Held turn proof",
        workspace: {
          id: workspace.id,
          projectId: workspaceRecord.projectId,
          directory: taskDir,
        },
      },
      {
        ok: true,
        model: { slug: "nucleus" },
        supportedRuntimeModes: ["full-access"],
      },
      rowAcp,
    );
    const threadId = parent.threadId;

    const project = async (): Promise<Projection | null> => {
      let found: Projection | null = null;
      await rpc!
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
    const assistantText = (view: Projection) =>
      view.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("");
    const liveRun = (view: Projection) =>
      view.runs.find((run) => run.status === "running" && run.rootNodeId);
    const operatorMessages = async () =>
      (
        (await service!.debug({
          target: "store",
          method: "messages",
          args: [task.id],
        })) as Array<{ fromRole: string }>
      ).filter((row) => row.fromRole === "operator").length;
    const operatorBefore = await operatorMessages();
    const audit = (text: string) => ({ markerOrId: SHOWN_MARKER.test(text) });

    // 1. initial launch: a live held run, and the first line names the task.
    const launched = await until(
      async () => {
        const view = await project();
        return view && liveRun(view) && /Working/.test(assistantText(view))
          ? view
          : null;
      },
      "the parent to hold a live run and show its first line",
      120_000,
    );
    const firstRun = liveRun(launched)!;
    const firstText = assistantText(launched);
    assert.equal(
      firstText.split("\n\n").filter(Boolean).length,
      1,
      "one line on launch",
    );
    assert.equal(
      audit(firstText).markerOrId,
      false,
      "no marker or id on screen",
    );
    note("initial-launch", {
      threadId,
      providerInstanceId: launched.thread.providerInstanceId,
      runId: firstRun.id,
      lines: firstText.split("\n\n").filter(Boolean),
      roles: [...new Set(launched.messages.map((m) => m.role))],
    });

    // 2. same-state writes: nothing shown changes, so nothing is sent and the run is the same.
    await setTask({ phase: "working" });
    await setTask({ phase: "working" });
    await delay(3_500);
    const quiet = await project();
    assert.equal(
      assistantText(quiet!),
      firstText,
      "same-state writes add no line",
    );
    assert.equal(liveRun(quiet!)?.id, firstRun.id, "the same held run");
    note("same-state-writes", { writes: 2, runId: firstRun.id, linesAdded: 0 });

    // 3. several milestones within the one held turn: each earns one line, the PR link once.
    await setTask({ phase: "awaiting_review", prUrl: PR_URL });
    await until(
      async () =>
        assistantText((await project())!).includes(`Review · ${PR_URL}`)
          ? true
          : null,
      "the review line",
      60_000,
    );
    await setTask({ phase: "reviewing" });
    await until(
      async () =>
        assistantText((await project())!).includes("Reviewing · PR #276")
          ? true
          : null,
      "the reviewing line",
      60_000,
    );
    await setTask({ phase: "merging" });
    await until(
      async () =>
        assistantText((await project())!).includes("Merging · PR #276")
          ? true
          : null,
      "the merging line",
      60_000,
    );
    const milestones = await project();
    const lines = assistantText(milestones!).split("\n\n").filter(Boolean);
    assert.deepEqual(
      lines,
      [
        firstText.trim(),
        `Review · ${PR_URL}`,
        "Reviewing · PR #276",
        "Merging · PR #276",
      ],
      "one line per milestone, the link once",
    );
    assert.equal(
      liveRun(milestones!)?.id,
      firstRun.id,
      "all milestones arrive in the same held run",
    );
    assert.equal(
      lines.some((line) => audit(line).markerOrId),
      false,
    );
    note("milestones-one-held-turn", {
      runId: firstRun.id,
      lines,
      prLinkCount: lines.filter((line) => line.includes(PR_URL)).length,
    });

    // 4. release and re-entry. The sweep releases a parent with no child; the production
    //    re-entry then holds a new run for the next child.
    // The release the sweep makes for a parent with no child: the held turn's own surface.
    await service.debug({
      target: "acp",
      method: "release",
      args: [parent.sessionId, "no role child is running"],
    });
    const releasedAt = Date.now();
    const released = await until(
      async () => {
        const view = await project();
        return view &&
          !activeStatuses.has(
            view.runs.find((run) => run.id === firstRun.id)?.status ?? "",
          )
          ? view
          : null;
      },
      "the released run to end",
      60_000,
    );
    note("release", {
      runId: firstRun.id,
      runStatus:
        released.runs.find((run) => run.id === firstRun.id)?.status ?? null,
      endedAfterMs: Date.now() - releasedAt,
    });

    const reentered = await nesting.heldRun(
      nesting.parentOf(task.id)!,
      "held-turn-request-1",
      0,
    );
    assert.ok(reentered, "the production re-entry holds a live run");
    assert.notEqual(reentered.id, firstRun.id, "re-entry starts a new run");
    await delay(3_000);
    const afterReentry = await project();
    const reentryRun = afterReentry!.runs.find(
      (run) => run.id === reentered.id,
    );
    assert.ok(
      activeStatuses.has(reentryRun?.status ?? ""),
      "the re-entry turn stays held",
    );
    assert.equal(
      await operatorMessages(),
      operatorBefore,
      "re-entry is never the operator's message",
    );
    const userTexts = afterReentry!.messages
      .filter((m) => m.role === "user")
      .map((m) => m.text);
    assert.ok(
      userTexts.includes(HOLD_TEXT),
      "the re-entry is a visible plain sentence",
    );
    assert.equal(
      userTexts.some((text) => SHOWN_MARKER.test(text)),
      false,
      "no marker or id in any user bubble",
    );
    note("reentry", {
      releasedRunId: firstRun.id,
      runId: reentered.id,
      runStatus: reentryRun?.status,
      operatorMessagesAdded: 0,
      userBubbles: userTexts.length,
      holdText: HOLD_TEXT,
    });

    // 5. the quiet system re-entry check: release the production re-entry, then probe a
    //    `system`-created re-entry on the same parent.
    await service.debug({
      target: "acp",
      method: "release",
      args: [parent.sessionId, "no role child is running"],
    });
    await until(
      async () =>
        !activeStatuses.has(
          (await project())!.runs.find((run) => run.id === reentered.id)
            ?.status ?? "",
        )
          ? true
          : null,
      "the re-entry run to end",
      60_000,
    );
    const beforeSystem = (await project())!;
    const systemDispatch = await rpc
      .call("orchestration.dispatchCommand", {
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
        commandId: `held-turn-system-${randomUUID()}`,
        threadId,
        messageId: `held-turn-system-message-${randomUUID()}`,
        text: HOLD_TEXT,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      })
      .then(
        () => "accepted",
        (error: Error) => `refused: ${error.message.slice(0, 200)}`,
      );
    // The probe records what the nightly did; a refusal or a run that never starts is the finding.
    const systemRunStarted = await until(
      async () => {
        const view = await project();
        return view &&
          view.runs.some(
            (run) =>
              run.status === "running" &&
              !beforeSystem.runs.some((old) => old.id === run.id),
          )
          ? view
          : null;
      },
      "the system re-entry to start a run",
      30_000,
    ).catch(() => null);
    const systemRun =
      systemRunStarted?.runs.find(
        (run) =>
          run.status === "running" &&
          !beforeSystem.runs.some((old) => old.id === run.id),
      ) ?? null;
    await delay(3_000);
    const after = await project();
    const heldSystem = systemRun
      ? (after!.runs.find((run) => run.id === systemRun.id)?.status ?? null)
      : null;
    const systemBubble = Boolean(
      after?.messages.some(
        (m) =>
          m.role === "user" &&
          m.text === HOLD_TEXT &&
          !beforeSystem.messages.some((old) => old.id === m.id),
      ),
    );
    assert.equal(
      await operatorMessages(),
      operatorBefore,
      "a system re-entry is never the operator's message",
    );
    note("quiet-system-reentry", {
      dispatch: systemDispatch,
      runId: systemRun?.id ?? null,
      runStarted: systemRun !== null,
      heldAfterMs: 3000,
      runStatus: heldSystem,
      visibleUserBubble: systemBubble,
      operatorMessagesAdded: 0,
    });

    // 6. closeout: a finished task releases the parent's held turn and archives its thread.
    await setTask({ phase: "done", finishedAt: new Date().toISOString() });
    await service.debug({
      target: "acp",
      method: "release",
      args: [parent.sessionId, "the task is done"],
    });
    await nesting.reconcile([await storedTask()]);
    await nesting.archiveFinishedParents([await storedTask()]);
    const closed = await until(
      async () => {
        const view = await project();
        return view?.thread.archivedAt ? view : null;
      },
      "the finished parent to be archived",
      90_000,
    );
    const finalLines = assistantText(closed).split("\n\n").filter(Boolean);
    assert.equal(
      finalLines.filter((line) => /finished · Done/.test(line)).length,
      1,
      "the finished line appears once",
    );
    assert.equal(
      finalLines.some((line) => audit(line).markerOrId),
      false,
    );
    note("closeout", {
      threadId,
      archivedAt: closed.thread.archivedAt,
      finishedLines: finalLines.filter((line) => /finished/.test(line)),
      lineCount: finalLines.length,
    });

    // The wire: every line the agent sent as a session update, each its own paragraph.
    const frames = existsSync(acpLog)
      ? readFileSync(acpLog, "utf8").split("\n")
      : [];
    const wireChunks = frames
      .filter((line) => line.startsWith("OUT "))
      .flatMap((line) => {
        try {
          const frame = JSON.parse(line.slice(4)) as {
            method?: string;
            params?: {
              update?: { sessionUpdate?: string; content?: { text?: string } };
            };
          };
          return frame.method === "session/update" &&
            frame.params?.update?.sessionUpdate === "agent_message_chunk"
            ? [frame.params.update.content?.text ?? ""]
            : [];
        } catch {
          return [];
        }
      });
    assert.ok(
      wireChunks.every((chunk) => chunk.endsWith("\n\n")),
      "every wire line ends its own paragraph",
    );
    assert.equal(
      wireChunks.some((chunk) => SHOWN_MARKER.test(chunk)),
      false,
      "no protocol or marker in the agent's chunks",
    );
    note("wire", {
      chunks: wireChunks.length,
      paragraphBreaks: wireChunks.every((chunk) => chunk.endsWith("\n\n")),
    });

    evidence.result = "passed";
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    rowHost?.close();
    rowStore?.close();
    rpc?.close();
    if (server && server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped.catch(() => undefined);
    }
    await service?.stop().catch(() => undefined);
    const rawLogs = [t3Log(root), acpLog].filter((path) => existsSync(path));
    evidence.rawLogs = rawLogs.map(sha256);
    // The run root is private scratch: the evidence names it as a placeholder, never a path.
    writeFileSync(
      join(root, "evidence.json"),
      JSON.stringify(evidence, null, 2).split(root).join("<proof-root>"),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        evidence: join(root, "evidence.json"),
        result: evidence.result,
        rawLogs: evidence.rawLogs,
      }),
    );
  }
}

function t3Log(root: string): string {
  return join(root, "t3-server.log");
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
