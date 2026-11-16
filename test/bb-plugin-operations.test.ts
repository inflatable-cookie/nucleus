import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostOperations,
  HostOperationError,
  type BbHostSdk,
  type ProjectRow,
  type TerminalSessionRow,
  type ThreadRow,
} from "../hosts/bb/plugin/operations";

/**
 * The executor's behaviour, against a fake `bb.sdk` that records the calls it got.
 *
 * These are the rules later phases inherit: a workspace step creates no thread, an
 * archive is preceded by its own cascade read and fails closed, a projection carries
 * only fields the service validates, and every SDK call is counted as evidence.
 */
interface FakeSdk extends BbHostSdk {
  calls: string[];
}

function fakeSdk(seed: { projects?: ProjectRow[]; threads?: ThreadRow[]; attachEnvironment?: boolean } = {}): FakeSdk {
  const attachEnvironment = seed.attachEnvironment ?? true;
  const projects = [...(seed.projects ?? [])];
  const threads = [...(seed.threads ?? [])];
  const calls: string[] = [];
  // Cascade rows by thread id: the executor must read these before any archive.
  const cascade: Record<string, string[]> = {};
  const sdk: FakeSdk = {
    calls,
    system: { version: async () => { calls.push("system.version"); return { currentVersion: "0.49.0" }; } },
    status: {
      get: async () => {
        calls.push("status.get");
        return { childThreads: null, pendingTodos: null, project: null, thread: null };
      },
    },
    hosts: { list: async () => { calls.push("hosts.list"); return [{ id: "host_fixture", status: "connected" }]; } },
    projects: {
      list: async () => { calls.push("projects.list"); return [...projects]; },
      create: async args => {
        calls.push("projects.create");
        const project: ProjectRow = { id: `proj_${projects.length + 1}`, sources: [{ type: "local_path", path: args.source.path }] };
        projects.push(project);
        return project;
      },
    },
    threads: {
      spawn: async args => {
        calls.push("threads.spawn");
        const created: ThreadRow = {
          id: "thr_fixture",
          // A fresh unmanaged path is provisioned after the row lands, so an attach
          // that never records one is the case this executor must not read as refused.
          environmentId: attachEnvironment ? `env_${args.environment.workspace.type}` : null,
          status: "starting",
          parentThreadId: args.parentThreadId ?? null,
          parentNotifications: args.parentNotifications ?? "auto",
          pluginMetadata: args.pluginMetadata ?? null,
          createdAt: 1,
        };
        threads.push(created);
        return created;
      },
      get: async args => {
        calls.push("threads.get");
        const found = threads.find(thread => thread.id === args.threadId);
        if (!found) throw new Error(`no thread ${args.threadId}`);
        return found;
      },
      stop: async () => { calls.push("threads.stop"); return { ok: true }; },
      archive: async args => {
        calls.push("threads.archive");
        const found = threads.find(thread => thread.id === args.threadId)!;
        found.archivedAt = 42;
        return { ok: true };
      },
      list: async args => {
        calls.push("threads.list");
        return threads.filter(thread => (args.originPluginId ? thread.originPluginId === args.originPluginId : true));
      },
      experimental_listPluginMetadata: async args => {
        calls.push("threads.experimental_listPluginMetadata");
        return {
          threads: args.threadIds.flatMap(threadId => {
            const found = threads.find(thread => thread.id === threadId);
            return found ? [{ threadId, metadata: found.pluginMetadata ?? null }] : [];
          }),
        };
      },
      experimental_listCascade: async args => {
        calls.push("threads.experimental_listCascade");
        return { threads: args.threadIds.map(threadId => ({ threadId, cascadeThreadIds: cascade[threadId] ?? [] })) };
      },
    },
    environments: {
      list: async () => {
        calls.push("environments.list");
        return [{ id: "env_fixture", path: "/tmp/worktree", isWorktree: true, status: "ready", managed: false }];
      },
    },
    terminals: {
      create: async args => {
        calls.push("terminals.create");
        return terminal({ id: "term_fixture", threadId: args.scope.kind === "thread" ? args.scope.threadId : null, environmentId: args.scope.kind === "environment" ? args.scope.environmentId : null, hostId: args.scope.kind === "host_path" ? args.scope.hostId : null, initialCwd: args.scope.kind === "host_path" ? (args.scope.cwd ?? null) : null });
      },
      list: async args => {
        calls.push("terminals.list");
        return { sessions: [terminal({ id: "term_fixture", threadId: args.scope.kind === "thread" ? args.scope.threadId : null, environmentId: args.scope.kind === "environment" ? args.scope.environmentId : null, hostId: args.scope.kind === "host_path" ? args.scope.hostId : null })] };
      },
      close: async args => { calls.push("terminals.close"); return terminal({ id: args.terminalId, closeReason: "user", status: "exited" }); },
    },
  };
  (sdk as unknown as { cascade: Record<string, string[]> }).cascade = cascade;
  return sdk;
}

function terminal(seed: Partial<TerminalSessionRow>): TerminalSessionRow {
  return { id: "term_fixture", threadId: null, environmentId: null, hostId: null, initialCwd: null, status: "running", closeReason: null, ...seed };
}

function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "bb-ops-"));
}

test("a workspace step registers the project and mints a handle without spawning", async () => {
  const root = fixtureDirectory();
  try {
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    mkdirSync(repository);
    mkdirSync(worktree);
    const sdk = fakeSdk();
    const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data" });

    const created = await operations.execute("workspace.create", { repositoryRoot: repository, name: "Synthetic" });
    assert.equal(created.operation, "workspace.create");
    const value = created.value as { projectId: string; projectCreated: boolean; projectCount: number; handle: string; spawned: number };
    assert.equal(value.projectCreated, true);
    assert.equal(value.projectCount, 1);
    assert.equal(value.spawned, 0);
    assert.match(value.handle, /^bb-worktree-[a-f0-9]{40}$/);
    assert.equal(sdk.calls.includes("threads.spawn"), false);
    assert.equal(sdk.calls.includes("projects.delete"), false);
    // The handle is the worktree's own identity, not the repository's.
    const worktreeHandle = await operations.execute("workspace.create", { repositoryRoot: worktree, name: "Synthetic worktree" });
    assert.notEqual((worktreeHandle.value as { handle: string }).handle, value.handle);

    // A second create for the same directory reuses the project and the handle.
    const again = await operations.execute("workspace.create", { repositoryRoot: repository, name: "Synthetic" });
    const againValue = again.value as { projectId: string; projectCreated: boolean; handle: string; spawned: number };
    assert.equal(againValue.projectId, value.projectId);
    assert.equal(againValue.projectCreated, false);
    assert.equal(againValue.handle, value.handle);
    assert.equal(againValue.spawned, 0);
    assert.equal(sdk.calls.filter(call => call === "projects.create").length, 2);
    assert.equal(sdk.calls.includes("threads.spawn"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace inspection reads the recorded BB project shape and distinguishes an unregistered root", async () => {
  const root = fixtureDirectory();
  try {
    const repository = join(root, "repository");
    mkdirSync(repository);
    const sdk = fakeSdk();
    const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/synthetic/bb-data" });
    const created = await operations.execute("workspace.create", { repositoryRoot: repository, workspacePath: join(root, "task-worktree"), name: "Synthetic" });
    const projectId = (created.value as { projectId: string }).projectId;
    const found = await operations.execute("workspace.inspect", { repositoryRoot: repository, projectId });
    assert.deepEqual(found.value, { projectId, projectFound: true, path: repository });
    assert.deepEqual(sdk.calls.slice(-1), ["projects.list"]);
    const absent = await operations.execute("workspace.inspect", { repositoryRoot: join(root, "other"), projectId });
    assert.deepEqual(absent.value, { projectId: null, projectFound: false, path: null });
    assert.equal(sdk.calls.includes("threads.spawn"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attaching a run spawns in the recorded worktree under the planner with notifications off", async () => {
  const sdk = fakeSdk();
  const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data" });
  const attached = await operations.execute("run.attach", {
    projectId: "proj_1",
    title: "Synthetic worker",
    environmentPath: "/tmp/worktree",
    parentThreadId: "thr_planner",
    parentNotifications: "off",
    prompt: "Do nothing.",
    providerId: "pi",
    pluginMetadata: { task: "1262", run: "spike" },
  });
  const value = attached.value as { threadId: string; environmentId: string; status: string; parentThreadId: string; parentNotifications: string; pluginMetadata: Record<string, unknown>; spawned: number };
  assert.equal(value.threadId, "thr_fixture");
  assert.equal(value.environmentId, "env_unmanaged");
  assert.equal(value.status, "starting");
  assert.equal(value.parentThreadId, "thr_planner");
  assert.equal(value.parentNotifications, "off");
  assert.deepEqual(value.pluginMetadata, { task: "1262", run: "spike" });
  assert.equal(value.spawned, 1);
  assert.deepEqual(sdk.calls.filter(call => call === "threads.spawn").length, 1);
});

test("an attach whose environment id never arrives is unknown delivery, never a refused retry", async () => {
  const sdk = fakeSdk({ attachEnvironment: false });
  const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data", attachWaitMs: 30 });
  await assert.rejects(
    operations.execute("run.attach", {
      projectId: "proj_1",
      title: "Synthetic worker",
      environmentPath: "/tmp/worktree",
      prompt: "Do nothing.",
    }),
    (error: unknown) => {
      // The spawn committed, so this can never be the code a caller may retry.
      assert.ok(error instanceof HostOperationError);
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /committed thread thr_fixture/);
      assert.match(error.message, /not retryable/);
      return true;
    },
  );
  assert.equal(sdk.calls.filter(call => call === "threads.spawn").length, 1);
});

test("an archive is preceded by its own cascade read, and refuses one it does not own", async () => {
  const sdk = fakeSdk({ threads: [{ id: "thr_worker", status: "idle", archivedAt: null }] });
  const cascade = (sdk as unknown as { cascade: Record<string, string[]> }).cascade;
  cascade.thr_worker = ["thr_foreign"];
  const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data" });

  const read = await operations.execute("thread.cascade", { threadId: "thr_worker", action: "archive" });
  assert.deepEqual((read.value as { cascadeThreadIds: string[] }).cascadeThreadIds, ["thr_foreign"]);

  await assert.rejects(
    operations.execute("thread.archive", { threadId: "thr_worker", expectedCascadeThreadIds: [] }),
    (error: unknown) => error instanceof HostOperationError && error.code === "refused" && /thr_foreign/.test(error.message),
  );
  assert.equal(sdk.calls.includes("threads.archive"), false);

  cascade.thr_worker = [];
  const archived = await operations.execute("thread.archive", { threadId: "thr_worker", expectedCascadeThreadIds: ["thr_worker"] });
  assert.deepEqual((archived.value as { cascadeThreadIds: string[] }).cascadeThreadIds, []);
  assert.equal((archived.value as { archivedAt: number }).archivedAt, 42);
  // The refused archive read the cascade and stopped; the accepted one read it
  // again and archived. No archive ever runs without its own read.
  const order = sdk.calls.filter(call => call === "threads.experimental_listCascade" || call === "threads.archive");
  assert.deepEqual(order, ["threads.experimental_listCascade", "threads.experimental_listCascade", "threads.experimental_listCascade", "threads.archive"]);
});

test("terminal operations carry exactly one scope and never invent a cwd", async () => {
  const sdk = fakeSdk();
  const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data" });
  const thread = await operations.execute("terminal.create", { scope: { kind: "thread", threadId: "thr_1" }, title: "planner" });
  assert.deepEqual((thread.value as { session: { threadId: string; environmentId: string | null } }).session.threadId, "thr_1");
  const hostPath = await operations.execute("terminal.create", { scope: { kind: "host_path", hostId: "host_1", cwd: "/tmp/worktree" }, title: "task" });
  assert.equal((hostPath.value as { session: { initialCwd: string } }).session.initialCwd, "/tmp/worktree");
  const listed = await operations.execute("terminal.list", { scope: { kind: "host_path", hostId: "host_1" } });
  assert.equal((listed.value as { sessions: unknown[] }).sessions.length, 1);
  await assert.rejects(
    operations.execute("terminal.list", { scope: { kind: "thread" } }),
    (error: unknown) => error instanceof HostOperationError && error.code === "invalid_input",
  );
});

test("an unknown operation and a malformed input are refused by name before any SDK call", async () => {
  const sdk = fakeSdk();
  const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data" });
  await assert.rejects(
    operations.execute("workspace.create" as never, { name: "Synthetic" }),
    (error: unknown) => error instanceof HostOperationError && /repositoryRoot/.test(error.message),
  );
  await assert.rejects(
    operations.execute("thread.observe", { threadId: "" }),
    (error: unknown) => error instanceof HostOperationError && error.code === "invalid_input",
  );
  await assert.rejects(
    operations.execute("not.an.operation" as never, {}),
    (error: unknown) => error instanceof HostOperationError,
  );
  assert.deepEqual(sdk.calls, []);
});

test("every answer carries the call counters, so a step can prove what it did not call", async () => {
  const sdk = fakeSdk();
  const operations = createHostOperations({ sdk, pluginId: "nucleus", sdkVersion: "0.6.132", dataDir: () => "/tmp/bb-data", now: () => 1_700_000_000_000 });
  const probe = await operations.execute("identity.probe", {});
  assert.equal((probe.value as { sdkVersion: string }).sdkVersion, "0.6.132");
  assert.equal((probe.value as { bbVersion: string }).bbVersion, "0.49.0");
  // Spec 062's identity probe reads the server's own status, its version and one
  // bounded thread list (plus the host list the projection reports), and writes nothing.
  assert.deepEqual(probe.calls, { "status.get": 1, "system.version": 1, "threads.list": 1, "hosts.list": 1 });
  const snapshot = await operations.execute("call.counters", {});
  assert.deepEqual((snapshot.value as { counters: Record<string, number> }).counters, { "status.get": 1, "system.version": 1, "threads.list": 1, "hosts.list": 1 });
  assert.equal((snapshot.value as { loadedAt: number }).loadedAt, 1_700_000_000_000);
});
