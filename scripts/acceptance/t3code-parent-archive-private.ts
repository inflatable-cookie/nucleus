/**
 * nucleus#1459's private proof: a finished task's T3 parent is archived by the ordinary
 * host maintenance pass, on the installed nightly.
 *
 * The T3 server is the installed nightly's own entry, extracted into this run's scratch
 * and started with its own base directory, HOME, port and databases; the operator's live
 * T3 home is never read or touched. The Nucleus side is a private data home with a real
 * Store, the real `nucleus t3 install` route, and a real `T3CodeHost` over the same store.
 * Every case runs through `HostPass.run` — the service sweep's own host owner, with the
 * finished-parent archive step, the row step, the title step and the observation steps in
 * their production order — never through a presentation or archive method directly.
 *
 * Cases:
 *
 * 1. archive — a stored done task with a retired workspace handle and a snoozed parent
 *    leaves T3's snoozed list: the pass releases the held turn, sends the one
 *    `thread.archive` under the deterministic command id, observes it and settles the
 *    binding;
 * 2. sibling fault — one parent's own projection read fails, so that parent keeps a typed
 *    wait while its sibling archives in the same pass;
 * 3. roll — an archive whose reply is lost leaves an unknown intent, and a rolled host
 *    settles it from the thread's archived fact with no second command;
 * 4. mismatch — two task records claiming one parent thread are never archived, and a
 *    nonterminal task's manually snoozed parent keeps the operator's snooze.
 *
 * The pinned Inbox fork of the presentation read is not exercised here: an isolated
 * nightly registers the `nucleus` ACP provider as `warning` (its own probe cannot open a
 * test session), so the Inbox is never created and its read cannot be faulted. That fork
 * is covered where the Inbox does exist, in `test/t3code-parent-archive.test.ts` against
 * the private synthetic nightly.
 *
 * No live probe and no manual repair: every thread is one this run created on its own
 * private server. Run it through `effigy proof:t3code:parent-archive`; the nightly is
 * read from `--asar` or the installed app.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { T3RpcClient, T3RpcError } from "../../hosts/t3code/rpc";
import { T3CodeHost } from "../../hosts/t3code/adapter";
import { createAdapter } from "../../hosts/t3code";
import { identity } from "../../hosts/t3code/intents";
import { canonical } from "../../hosts/t3code/state";
import { HostPolicies } from "../../core/host/host-policies";
import type { HostPolicyConstructor } from "../../core/host";
import { AcpSessions } from "../../core/acp/sessions";
import { Store } from "../../core/store/store";
import type { Engine } from "../../core/engine";
import type { Adapter } from "../../core/host";
import type { ParentArchiveWait } from "../../core/host";
import type { Task } from "../../shared/contracts";
import { submissionSchema } from "../../shared/contracts";
import {
  extractArchive,
  freePort,
  run,
  runOrdinaryHostPass,
  scratchRoot,
  until,
} from "./t3code-private-kit";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
/**
 * The nightly lines this proof reads, the same pair the newer T3 proofs accept. The
 * exact installed build is recorded in the evidence, never pinned to one.
 */
const NIGHTLY_BUILD = /^0\.1\.(?:11|12)-nightly\.\d+\.\d+$/;
const INSTALLED_APP =
  "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar";
/** The batch bound the archive step visits in one pass (`PARENT_ARCHIVE_BATCH`). */
const ARCHIVE_BOUND = 4;
/** One pass's worth of retries while a released ACP turn winds down on the nightly. */
const PASS_ATTEMPTS = 20;

type DispatchCommand = {
  type: string;
  commandId: string;
  threadId: string;
  snoozedUntil?: string;
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
  const root = mkdtempSync(join(scratchRoot(), "t3-parent-archive-"));
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
  assert.match(metadata.version, NIGHTLY_BUILD);
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

  // The Nucleus ACP agent T3 launches for a parent, from this checkout.
  const acpLauncher = join(root, "bin", "nucleus-acp");
  writeFileSync(
    acpLauncher,
    `#!/bin/sh\n# nucleus-owned-command-v1\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(checkout, "node_modules/tsx/dist/loader.mjs"))} ${JSON.stringify(join(checkout, "bin/nucleus-acp.mjs"))} "$@"\n`,
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
  writeFileSync(
    join(repository, "fixture.txt"),
    "Synthetic parent archive proof\n",
  );
  await git(["add", "fixture.txt"]);
  await git(["commit", "--quiet", "-m", "Synthetic fixture"]);
  await git(["worktree", "add", "--quiet", "-b", "proof-task-parent", taskDir]);

  let server = null as ChildProcess | null;
  let rpc: T3RpcClient | null = null;
  let store: Store | null = null;
  let host: T3CodeHost | null = null;
  let adapter: Adapter | null = null;
  const t3Log = join(root, "t3-server.log");
  try {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
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
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
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
    assert.match(descriptor.serverVersion, NIGHTLY_BUILD);
    evidence.target = {
      serverVersion: descriptor.serverVersion,
      environmentId: descriptor.environmentId,
      isolated: true,
    };
    note("private-t3-server", {
      serverVersion: descriptor.serverVersion,
      isolated: true,
    });

    // A proof bearer for the reads and commands it drives directly.
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

    // 1. the operator's own install route registers the Nucleus ACP provider.
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
            t3,
            "--acp-command",
            acpLauncher,
            "--json",
          ],
          { env: environment, cwd: root },
        )
      ).trim(),
    ) as { steps: unknown };
    note("install-provider", { steps: install.steps });

    // The Nucleus side: a real store, the adapter's own ACP surface, and the real host.
    store = new Store(join(nucleusData, "queue.sqlite"));
    store.setMeta("paused", false);
    const acp = new AcpSessions({ store } as unknown as Engine, {
      dataHome: nucleusData,
      socketPath: join(nucleusData, "callback.sock"),
    });
    rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 30_000 });
    await rpc.connect();
    host = new T3CodeHost({
      endpoint,
      bearer,
      statePath: join(root, "host.json"),
      acp: () => acp,
      reentryTimeoutMs: 2_000,
    });
    await host.connect();
    const hostId = host.hostId;
    assert.match(hostId, /^t3code:/);
    adapter = createAdapter(
      HostPolicies as unknown as HostPolicyConstructor,
      host,
      {
        socketPath: join(nucleusData, "callback.sock"),
        helperPath: join(nucleusData, "worker-report.mjs"),
      },
    );
    const projectId = `parent-archive-project-${Date.now()}`;
    await rpc.call("projects.mutate", {
      type: "project.create",
      commandId: identity("proof-project", projectId),
      projectId,
      title: "Synthetic parent archive",
      workspaceRoot: repository,
    });
    const workspace = await host.createWorkspace({
      title: "Parent archive proof",
      requestId: "parent-archive-workspace",
      directory: taskDir,
      project: { projectId },
    });
    const workspaceRecord = host.state.read().workspaces[workspace.id]!;

    /** One stored task on this host, with its checkout and a phase the proof sets. */
    const insertTask = (title: string, phase = "working") => {
      const task = store!.insert(
        submissionSchema.parse({
          submissionId: `parent-archive-${title}`,
          title,
          repoPath: repository,
          planningCommit: "a".repeat(40),
          brief: { text: `Synthetic ${title}` },
          originAgentId: "proof-origin",
        }),
        hostId,
        "brief",
        "a".repeat(40),
      );
      store!.update(task.id, {
        directory: taskDir,
        phase: phase as Task["phase"],
      });
      return store!.task(task.id);
    };
    const nesting = host.nesting as unknown as {
      launchParent(
        input: unknown,
        provider: unknown,
        acp: AcpSessions,
      ): Promise<{ threadId: string; sessionId: string } | null>;
    };
    /** The production parent launch: the durable binding, the thread and its held turn. */
    const launchParent = async (task: Task) => {
      const parent = await nesting.launchParent(
        {
          attempt: { labels: { "nucleus.task": task.id } },
          spec: {},
          title: task.title ?? "Parent archive proof",
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
        acp,
      );
      assert.ok(parent, "the parent thread is launched");
      return parent;
    };
    const type = (taskId: string) => taskId.replace(/^task-/, "");
    const bindingOf = (taskId: string) => host!.state.read().parents![taskId]!;
    const projection = (threadId: string) =>
      host!.readProjection(threadId, "observation");
    const archived = async (threadId: string) =>
      (await host!.threadArchiveState(threadId))?.archivedAt ?? null;
    const snoozedUntil = async (threadId: string) =>
      (await projection(threadId)).thread.snoozedUntil ?? null;
    const archiveId = (threadId: string) =>
      identity("parent-archive", canonical([hostId, threadId]));
    const snooze = async (threadId: string, horizon: string) =>
      await rpc!.call("orchestration.dispatchCommand", {
        type: "thread.snooze",
        commandId: identity("proof-snooze", canonical([threadId, horizon])),
        threadId,
        snoozedUntil: horizon,
      });
    const events = (taskId: string) => store!.events(taskId);
    /** The typed waits the ordinary pass wrote on one task (unknown delivery has its own kind). */
    const waitsOf = (taskId: string) =>
      events(taskId)
        .filter(
          (event) =>
            event.kind === "parent_archive_wait" ||
            event.kind === "parent_archive_uncertain",
        )
        .map((event) => `${event.kind}: ${event.detail}`);
    /**
     * Record every command the host under test sends, so a pass's sends are counted on
     * the wire the adapter really uses. The same seam injects the two faults the cases
     * need: one parent's projection read, and a lost reply to one archive command.
     */
    const sent: DispatchCommand[] = [];
    const faults: { threadId: string; remaining: number }[] = [];
    const loseArchiveReply = { threadId: "", armed: false };
    const observeHostWire = (current: T3CodeHost) => {
      const call = current.rpc.call.bind(current.rpc);
      current.rpc.call = async (method: string, payload: unknown) => {
        const command = payload as DispatchCommand;
        if (method === "orchestration.dispatchCommand") sent.push(command);
        const result = await call(method, payload);
        if (
          method === "orchestration.dispatchCommand" &&
          loseArchiveReply.armed &&
          command.type === "thread.archive" &&
          command.threadId === loseArchiveReply.threadId
        ) {
          loseArchiveReply.armed = false;
          // The nightly applied the command; this process lost the reply.
          throw new T3RpcError("timeout", "orchestration.dispatchCommand");
        }
        return result;
      };
      const readStream = current.rpc.readStream.bind(current.rpc);
      current.rpc.readStream = async (
        method: string,
        payload: unknown,
        accept: (value: unknown) => boolean,
      ) => {
        const requested = (payload as { threadId?: string }).threadId;
        const fault = faults.find(
          (candidate) =>
            candidate.threadId === requested && candidate.remaining > 0,
        );
        if (fault && method === "orchestration.subscribeThread") {
          fault.remaining -= 1;
          throw new Error("synthetic transient read fault");
        }
        return await readStream(method, payload, accept);
      };
    };
    observeHostWire(host);
    /** One ordinary host pass, and the sends it made. */
    const pass = async () => {
      const before = sent.length;
      await runOrdinaryHostPass(store!, adapter!, hostId);
      return sent.slice(before);
    };

    // Every task's parent is launched on the same checkout, before any workspace retire.
    const archivedTask = insertTask("archive");
    const siblingTask = insertTask("sibling-fault");
    const siblingTaskB = insertTask("sibling-fault-b");
    const rollTask = insertTask("roll");
    const twinTask = insertTask("twin");
    const liveTask = insertTask("live");
    const parents = new Map<string, { threadId: string; sessionId: string }>();
    for (const task of [
      archivedTask,
      siblingTask,
      siblingTaskB,
      rollTask,
      twinTask,
      liveTask,
    ])
      parents.set(task.id, (await launchParent(task))!);
    note("parents-launched", {
      tasks: parents.size,
      providers: "nucleus",
      workspace: workspace.id,
    });

    // One ordinary pass over live tasks, before anything is finished.
    const first = await pass();
    note("warm-pass", {
      sends: first.length,
      archiveCommands: first.filter(
        (command) => command.type === "thread.archive",
      ).length,
    });

    // 2. finish the archive case: the operator snoozed the parent, the workspace handle
    //    is retired, and the task is done.
    const archiveParent = parents.get(archivedTask.id)!;
    const horizon = new Date(Date.now() + 6 * 3_600_000).toISOString();
    await snooze(archiveParent.threadId, horizon);
    await host.workspaceRef(workspace.id).archive("parent-archive-retire");
    store.update(archivedTask.id, { phase: "done" });
    const passes: Array<{ sends: number; archived: string | null }> = [];
    for (let attempt = 0; attempt < PASS_ATTEMPTS; attempt++) {
      const sends = await pass();
      const fact = await archived(archiveParent.threadId);
      passes.push({ sends: sends.length, archived: fact });
      if (fact) break;
      await delay(500);
    }
    const archiveFact = passes.at(-1)!;
    assert.ok(
      archiveFact.archived,
      "the ordinary pass archives the finished parent that started this run snoozed",
    );
    const archiveSends = sent.filter(
      (command) =>
        command.type === "thread.archive" &&
        command.threadId === archiveParent.threadId,
    );
    if (host.state.read().workspaces[workspace.id]?.archivedAt === undefined) {
      // The handle was already retired by the production archive path this proof drove.
      note("workspace-handle", { retired: "the pass's own workspace archive" });
    }
    assert.ok(bindingOf(archivedTask.id).archivedAt, "the binding is settled");
    assert.equal(bindingOf(archivedTask.id).archive, undefined);
    assert.deepEqual(waitsOf(archivedTask.id), [], "no wait was ever recorded");
    note("archive", {
      threadId: archiveParent.threadId,
      snoozedBefore: horizon,
      workspaceHandleArchived: Boolean(
        host.state.read().workspaces[workspace.id]?.archivedAt,
      ),
      archivedAt: archiveFact.archived,
      ordinaryPasses: passes.length,
      archiveCommands: archiveSends.length,
      archiveCommandId: archiveSends[0]?.commandId ?? null,
      expectedCommandId: archiveId(archiveParent.threadId),
      bindingArchivedAt: bindingOf(archivedTask.id).archivedAt,
      releasedBy: bindingOf(archivedTask.id).releasedAt ?? null,
    });
    assert.equal(
      archiveSends.length,
      1,
      "one parent archive command, under the deterministic identity",
    );
    assert.equal(archiveSends[0]!.commandId, archiveId(archiveParent.threadId));
    // A later ordinary pass owes nothing for it: the observation settled the obligation.
    const settledSends = await pass();
    assert.equal(
      settledSends.filter(
        (command) =>
          command.type === "thread.archive" &&
          command.threadId === archiveParent.threadId,
      ).length,
      0,
      "a settled parent is never archived again",
    );

    // 2. a sibling parent's own read fault stays that parent's wait, in the same pass.
    const siblingA = parents.get(siblingTask.id)!;
    const siblingB = parents.get(siblingTaskB.id)!;
    store.update(siblingTask.id, { phase: "done" });
    store.update(siblingTaskB.id, { phase: "done" });
    faults.push({ threadId: siblingA.threadId, remaining: 1 });
    const beforeSibling = sent.length;
    await runOrdinaryHostPass(store, adapter, hostId);
    const siblingSends = sent.slice(beforeSibling);
    const waitA = waitsOf(siblingTask.id);
    const waitB = waitsOf(siblingTaskB.id);
    assert.equal(waitA.length, 1, "the faulted parent keeps one typed wait");
    assert.match(waitA[0]!, /\(read_failed\)/);
    assert.equal(
      await archived(siblingA.threadId),
      null,
      "the faulted parent is not archived",
    );
    assert.ok(
      await archived(siblingB.threadId),
      "its sibling archives in the same pass",
    );
    assert.deepEqual(waitB, [], "the sibling that archived records no wait");
    note("sibling-fault", {
      faultedThread: siblingA.threadId,
      faultedWait: waitA[0]!,
      faultedArchived: await archived(siblingA.threadId),
      siblingThread: siblingB.threadId,
      siblingArchived: await archived(siblingB.threadId),
      archiveCommands: siblingSends.filter(
        (command) => command.type === "thread.archive",
      ).length,
    });

    // The next ordinary pass settles the parent that waited.
    await pass();
    assert.ok(
      await archived(siblingA.threadId),
      "the next pass archives the parent that waited",
    );
    assert.ok(bindingOf(siblingTask.id).archivedAt);

    // 3. a service roll with a pending archive. The archive is sent, the nightly applies
    //    it, and this process loses the reply: the durable intent stays unknown.
    const rollParent = parents.get(rollTask.id)!;
    store.update(rollTask.id, { phase: "done" });
    loseArchiveReply.threadId = rollParent.threadId;
    loseArchiveReply.armed = true;
    await runOrdinaryHostPass(store, adapter, hostId);
    const rollIntent =
      host.state.read().intents[archiveId(rollParent.threadId)];
    assert.ok(
      await archived(rollParent.threadId),
      "the nightly applied the archive whose reply was lost",
    );
    assert.equal(
      bindingOf(rollTask.id).archivedAt,
      undefined,
      "the binding is still unsettled",
    );
    assert.match(
      waitsOf(rollTask.id).join("\n"),
      /\(unknown\)/,
      "the lost reply is a typed unknown wait on the task",
    );
    note("roll-before", {
      threadId: rollParent.threadId,
      intentStatus: rollIntent?.status ?? null,
      intentTimedOut: rollIntent?.timedOut ?? false,
      unknownWait: waitsOf(rollTask.id)[0] ?? null,
      archivedAt: await archived(rollParent.threadId),
      bindingArchivedAt: bindingOf(rollTask.id).archivedAt ?? null,
    });
    // The roll: the same durable state, a fresh host connection and a fresh adapter.
    host.close();
    host = new T3CodeHost({
      endpoint,
      bearer,
      statePath: join(root, "host.json"),
      acp: () => acp,
      reentryTimeoutMs: 2_000,
    });
    await host.connect();
    observeHostWire(host);
    const rolledId = host.hostId;
    assert.equal(
      rolledId,
      hostId,
      "the rolled host proves the same environment",
    );
    adapter = createAdapter(
      HostPolicies as unknown as HostPolicyConstructor,
      host,
      {
        socketPath: join(nucleusData, "callback.sock"),
        helperPath: join(nucleusData, "worker-report.mjs"),
      },
    );
    const bindingAfterRoll = () => host!.state.read().parents![rollTask.id]!;
    const beforeRollPass = sent.length;
    await runOrdinaryHostPass(store, adapter, rolledId);
    const rollSends = sent.slice(beforeRollPass);
    assert.equal(
      rollSends.filter(
        (command) =>
          command.type === "thread.archive" &&
          command.threadId === rollParent.threadId,
      ).length,
      0,
      "the rolled pass never resends the unknown archive",
    );
    assert.ok(
      bindingAfterRoll().archivedAt,
      "the rolled pass settles the binding by observation",
    );
    assert.equal(bindingAfterRoll().archive, undefined);
    note("roll-after", {
      threadId: rollParent.threadId,
      rollArchiveCommands: rollSends.filter(
        (command) => command.type === "thread.archive",
      ).length,
      bindingArchivedAt: bindingAfterRoll().archivedAt,
      archivedAt: await archived(rollParent.threadId),
    });

    // 4. mismatch: two task records claiming one parent thread are never archived, and a
    //    nonterminal task's operator snooze is untouched.
    const twinParent = parents.get(twinTask.id)!;
    const twinSibling = insertTask("twin-copy", "done");
    store.update(twinTask.id, { phase: "done" });
    host.state.update((state) => {
      state.parents![twinSibling.id] = {
        ...state.parents![twinTask.id]!,
        taskId: twinSibling.id,
      };
    });
    const liveParent = parents.get(liveTask.id)!;
    const liveHorizon = new Date(Date.now() + 3 * 3_600_000).toISOString();
    await snooze(liveParent.threadId, liveHorizon);
    const beforeMismatch = sent.length;
    await runOrdinaryHostPass(store, adapter, rolledId);
    const mismatchSends = sent.slice(beforeMismatch);
    assert.equal(
      await archived(twinParent.threadId),
      null,
      "a thread two records claim is never archived",
    );
    assert.match(waitsOf(twinTask.id).join("\n"), /\(mismatched\)/);
    assert.match(waitsOf(twinSibling.id).join("\n"), /\(mismatched\)/);
    assert.equal(
      await snoozedUntil(liveParent.threadId),
      liveHorizon,
      "the nonterminal parent keeps the operator's own snooze",
    );
    assert.deepEqual(
      waitsOf(liveTask.id),
      [],
      "a nonterminal parent is not this step's work",
    );
    assert.equal(
      mismatchSends.filter(
        (command) =>
          command.type === "thread.archive" &&
          [twinParent.threadId, liveParent.threadId].includes(command.threadId),
      ).length,
      0,
    );
    note("mismatch-and-nonterminal", {
      sharedThread: twinParent.threadId,
      twinWait: waitsOf(twinTask.id)[0]!,
      copyWait: waitsOf(twinSibling.id)[0]!,
      sharedArchived: await archived(twinParent.threadId),
      nonterminalThread: liveParent.threadId,
      nonterminalSnoozedUntil: await snoozedUntil(liveParent.threadId),
      nonterminalArchiveCommands: 0,
    });

    evidence.bounds = {
      archiveBatch: ARCHIVE_BOUND,
      passAttemptsUsed: passes.length,
    };
    evidence.result = "passed";
  } catch (error) {
    evidence.result = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    host?.close();
    rpc?.close();
    store?.close();
    if (server && server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await stopped.catch(() => undefined);
    }
    const rawLogs = [t3Log].filter((path) => existsSync(path));
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

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
