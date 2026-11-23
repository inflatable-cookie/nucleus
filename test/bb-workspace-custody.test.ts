import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { createBbWorkspaceAdapter } from "../service/bb-host";
import { workspaceHandleForPath, type HostOperationName, type HostOperationOutcome } from "../shared/host-operation";
import type { Task } from "../shared/contracts";
import { typedPreSendRefusal } from "../core/planning/operation-failure";
import { isTransportFailure } from "../shared/transport";

const hostId = "bb:0123456789abcdef0123456789abcdef";
const outcome = (operation: HostOperationName, value: unknown): HostOperationOutcome => ({ operation, at: "2026-11-16T00:00:00.000Z", calls: {}, value });
const task = (title: string, repoPath: string, directory: string) => ({ id: "task_synthetic", title, repoPath, directory }) as unknown as Task;

test("BB workspace creation records a canonical handle without creating a thread identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-workspace-"));
  const repositoryRoot = join(root, "repository"), directory = join(root, "task-worktree");
  mkdirSync(repositoryRoot); mkdirSync(directory);
  let store = new Store(join(root, "queue.sqlite"));
  const calls: Array<{ op: HostOperationName; input: unknown }> = [];
  const request = async (op: HostOperationName, input: unknown) => {
    calls.push({ op, input });
    if (op === "workspace.inspect") return outcome(op, { projectId: "proj_synthetic", projectFound: true, path: repositoryRoot });
    return outcome(op, { projectId: "proj_synthetic", projectCreated: true, projectCount: 1, handle: workspaceHandleForPath(directory), path: directory, spawned: 0 });
  };
  let adapter = createBbWorkspaceAdapter(hostId, () => true, "", store, request);
  try {
    const created = await adapter.createWorkspace!(task("Synthetic task", repositoryRoot, directory));
    assert.deepEqual(created, { id: workspaceHandleForPath(directory), directory });
    assert.equal(adapter.workspaceIdAccepted?.(created.id), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "workspace.create");
    assert.deepEqual(calls[0].input, { repositoryRoot, workspacePath: directory, name: "repository" });
    assert.deepEqual(await adapter.findWorkspaces!({ directory } as never), [{ id: created.id, directory }]);
    store.close();
    store = new Store(join(root, "queue.sqlite"));
    adapter = createBbWorkspaceAdapter(hostId, () => true, "", store, request);
    assert.deepEqual(await adapter.findWorkspaces!({ directory } as never), [{ id: created.id, directory }], "the handle survives a service/store restart");
    assert.equal(await adapter.workspaceAvailable!(created.id), true);
    assert.deepEqual(await adapter.createWorkspace!(task("Synthetic task", repositoryRoot, directory)), created);
    assert.equal(calls.filter(call => call.op === "workspace.create").length, 1, "a second create reuses the durable handle");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an offline BB host releases the reservation so a later create can retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-workspace-"));
  const repositoryRoot = join(root, "repository"), directory = join(root, "task-worktree");
  mkdirSync(repositoryRoot); mkdirSync(directory);
  const store = new Store(":memory:");
  let online = false;
  let writes = 0;
  const adapter = createBbWorkspaceAdapter(hostId, () => online, "", store, async (op, input) => {
    writes++;
    const path = (input as { workspacePath: string }).workspacePath;
    return outcome(op, { projectId: "proj_synthetic", projectCreated: true, projectCount: 1, handle: workspaceHandleForPath(path), path, spawned: 0 });
  });
  const request = task("Synthetic task", repositoryRoot, directory);
  try {
    const offline = await adapter.createWorkspace!(request).then(() => assert.fail("an offline host must refuse"), (error: unknown) => error);
    assert.match(String(offline), /operation was not sent: BB host executor is offline/);
    // The connection precondition is a proven pre-send refusal, and still a transport failure for the callers that wait on one.
    assert.equal(typedPreSendRefusal(offline), true);
    assert.equal(isTransportFailure(offline), true);
    assert.deepEqual(store.getMeta("bbWorkspaces"), {}, "an offline pre-send failure removes its reservation");
    assert.equal(writes, 0);
    online = true;
    const created = await adapter.createWorkspace!(request);
    assert.equal(created.id, workspaceHandleForPath(directory));
    assert.equal(writes, 1, "the later create reaches the host once");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a missing service identity releases the reservation before any host operation is sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-workspace-"));
  const repositoryRoot = join(root, "repository"), directory = join(root, "task-worktree"), dataDir = join(root, "service");
  mkdirSync(repositoryRoot); mkdirSync(directory); mkdirSync(dataDir);
  const store = new Store(":memory:");
  const adapter = createBbWorkspaceAdapter(hostId, () => true, dataDir, store);
  try {
    await assert.rejects(adapter.createWorkspace!(task("Synthetic task", repositoryRoot, directory)), /operation was not sent: Nucleus service identity is unavailable/);
    assert.deepEqual(store.getMeta("bbWorkspaces"), {}, "a missing service identity cannot leave a reserved handle");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BB archive marks one task handle and leaves the shared project and sibling workspace alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-workspace-"));
  const repositoryRoot = join(root, "repository"), first = join(root, "first"), second = join(root, "second");
  mkdirSync(repositoryRoot); mkdirSync(first); mkdirSync(second);
  const store = new Store(":memory:");
  let projectFound = true;
  const adapter = createBbWorkspaceAdapter(hostId, () => true, "", store, async (op, input) => {
    if (op === "workspace.create") {
      const path = (input as { workspacePath: string }).workspacePath;
      return outcome(op, { projectId: "proj_shared", projectCreated: false, projectCount: 1, handle: workspaceHandleForPath(path), path, spawned: 0 });
    }
    if (op === "workspace.inspect") return outcome(op, { projectId: projectFound ? "proj_shared" : null, projectFound, path: projectFound ? repositoryRoot : null });
    throw new Error(`Unexpected operation ${op}`);
  });
  try {
    const create = (directory: string, title: string) => adapter.createWorkspace!(task(title, repositoryRoot, directory));
    const firstWorkspace = await create(first, "first");
    const secondWorkspace = await create(second, "second");
    const workspaceRef = (adapter as unknown as { workspaceRef(id: string): { archive(requestId: string): Promise<{ archivedAt: string | null }> } }).workspaceRef;
    const archived = await workspaceRef(firstWorkspace.id).archive("archive-first");
    assert.ok(archived.archivedAt);
    assert.equal(await adapter.taskWorkspaceArchived!(firstWorkspace.id), true);
    assert.equal(await adapter.workspaceAvailable!(firstWorkspace.id), false);
    assert.equal(await adapter.workspaceAvailable!(secondWorkspace.id), true);
    assert.deepEqual(await adapter.findWorkspaces!({ directory: second } as never), [{ id: secondWorkspace.id, directory: second }]);
    const reopened = await create(first, "first again");
    assert.deepEqual(reopened, firstWorkspace, "re-creating an archived directory reuses its handle");
    assert.equal(await adapter.taskWorkspaceArchived!(firstWorkspace.id), false);
    assert.equal(await adapter.workspaceAvailable!(firstWorkspace.id), true);
    projectFound = false;
    assert.equal(await adapter.workspaceAvailable!(secondWorkspace.id), false, "an unregistered project is unavailable");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a lost project-create reply is adopted by exact-root inspection and never resent", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-workspace-"));
  const repositoryRoot = join(root, "repository"), directory = join(root, "task-worktree");
  mkdirSync(repositoryRoot); mkdirSync(directory);
  const store = new Store(":memory:");
  const calls: HostOperationName[] = [];
  let projectExists = false;
  const adapter = createBbWorkspaceAdapter(hostId, () => true, "", store, async op => {
    calls.push(op);
    if (op === "workspace.create") {
      projectExists = true;
      throw new Error("unknown delivery: reply lost after project registration");
    }
    if (op === "workspace.inspect") return outcome(op, { projectId: projectExists ? "proj_recovered" : null, projectFound: projectExists, path: projectExists ? repositoryRoot : null });
    throw new Error(`Unexpected operation ${op}`);
  });
  const recoveryTask = task("Synthetic task", repositoryRoot, directory);
  try {
    await assert.rejects(adapter.createWorkspace!(recoveryTask), /unknown delivery/);
    const recovered = await adapter.createWorkspace!(recoveryTask);
    assert.equal(recovered.id, workspaceHandleForPath(directory));
    assert.deepEqual(calls, ["workspace.create", "workspace.inspect"]);
    assert.deepEqual(await adapter.createWorkspace!(recoveryTask), recovered);
    assert.deepEqual(calls, ["workspace.create", "workspace.inspect"], "a completed second create reuses the handle without another host write");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("BB workspace unreadable project inspection stays an error, and a missing directory is not created", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-workspace-"));
  const repositoryRoot = join(root, "repository"), directory = join(root, "missing");
  mkdirSync(repositoryRoot);
  const store = new Store(":memory:");
  const adapter = createBbWorkspaceAdapter(hostId, () => true, "", store, async () => { throw new Error("recorded projects.list read failed"); });
  try {
    await assert.rejects(adapter.createWorkspace!(task("missing", repositoryRoot, directory)), /ENOENT/);
    const repositoryProject = (adapter as unknown as { repositoryProject(root: string): Promise<unknown> }).repositoryProject;
    await assert.rejects(repositoryProject(repositoryRoot), /recorded projects.list read failed/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
