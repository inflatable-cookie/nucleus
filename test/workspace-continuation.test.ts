import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoAdapter } from "../service/paseo-composition";
import type { HostProcessFact } from "../core/host/types";
import type { Task } from "../shared/contracts";
import type { HostWorkspaceRecord } from "../shared/host";
import {
  WorkspaceContinuation, type HostWorktreeWorkspaceSpec, type WorkspaceContinuationHost,
} from "../core/workspaces/workspace-continuation";
import type { WorkspaceInventoryEntry, WorkspacePlacementFixture } from "../core/workspaces/workspace-lifecycle";

/**
 * Step 4 row 2 of the Paseo split (task 903): the continuation preflight, the
 * process proof and the closeout workspace policy move out of
 * `host/paseo/paseo.ts` into core.
 *
 * These witnesses pin what that move could quietly break. Every host fact the
 * policy reads — the registration handle and its refresh, the complete
 * inventory, the native worktree registration, the process table and the two
 * machine seams it re-enters — is read at the call that uses it, never captured,
 * and every refusal keeps its exact words. The adapter's delegates add no
 * microtask turn of their own.
 */

type Handle = { refresh: () => Promise<unknown>; record: () => HostWorkspaceRecord | null | undefined; directory: string | null };

const state = () => ({
  handle: null as Handle | null,
  inventory: [] as WorkspaceInventoryEntry[],
  spec: null as HostWorktreeWorkspaceSpec | null,
  created: { id: "w-closeout", directory: "/closeout" } as { id: string; directory: string | null },
});

type HostStub = WorkspaceContinuationHost & { calls: string[]; state: ReturnType<typeof state> };

/** A host surface carrying only what the policy reads; every call is recorded in order. */
function hostStub(overrides: Partial<WorkspaceContinuationHost> = {}, initial = state()): HostStub {
  const calls: string[] = [];
  const host: HostStub = {
    calls,
    state: initial,
    workspaceHost: {
      workspaceRef: id => {
        calls.push(`workspaceRef:${id}`);
        const handle = initial.handle!;
        return {
          get directory() { calls.push("directory"); return handle.directory; },
          refresh: () => { calls.push("refresh"); return handle.refresh(); },
          current: () => { calls.push("current"); return handle.record(); },
          archive: async () => ({ archivedAt: null, error: null }),
        };
      },
      workspaceInventory: async () => { calls.push("workspaceInventory"); return initial.inventory; },
      createCloseoutWorkspace: async spec => {
        calls.push(`createCloseoutWorkspace:${spec.requestId}`);
        initial.spec = spec;
        return initial.created;
      },
    },
    placement: () => { calls.push("placement"); return null; },
    ownedPathFor: async () => { calls.push("ownedPathFor"); return "/owned"; },
    hostProcessListing: async () => { calls.push("hostProcessListing"); return []; },
    ...overrides,
  };
  return host;
}

const task = (overrides: Partial<Task> = {}) => ({
  id: "task", title: "task", repoPath: "/repo", baseBranch: "main", branch: "ns-task",
  workspaceId: "workspace", directory: "/workspace",
  resolution: { closeoutWorkspaceHead: "a".repeat(40) },
  ...overrides,
}) as Task;

const fact = (pid: number, command: string, cwd: string | null, ppid = 1): HostProcessFact =>
  ({ pid, ppid, pgid: ppid, uid: 501, startIdentity: `${pid}@fixture`, command, cwd });

test("the process proof reads the refresh, then the record, then the host process table, and keeps its refusals", async () => {
  const retained: HostWorkspaceRecord = { projectRootPath: "/repo", workspaceDirectory: "/workspace" };

  // No recorded run identity asks the host nothing at all.
  const bare = hostStub();
  assert.equal(await new WorkspaceContinuation(bare).noLiveWorkspaceProcesses("workspace", []),
    "the participant has no recorded run identity for process proof");
  assert.deepEqual(bare.calls, []);

  // A falsy refresh answer is unreadable, and neither the record nor the process table is read after it.
  const unreadable = hostStub({}, { ...state(), handle: { refresh: async () => null, record: () => retained, directory: "/workspace" } });
  assert.equal(await new WorkspaceContinuation(unreadable).noLiveWorkspaceProcesses("workspace", ["run-1"]),
    "the participant workspace is unreadable for process proof");
  assert.deepEqual(unreadable.calls, ["workspaceRef:workspace", "refresh"]);

  // The record's own directory is the one scanned, and the order is refresh, record, listing.
  const scanned = hostStub({}, { ...state(), handle: { refresh: async () => true, record: () => retained, directory: "/handle" } });
  const continuation = new WorkspaceContinuation(scanned);
  assert.equal(await continuation.noLiveWorkspaceProcesses("workspace", ["run-1"]), null,
    "a process inside the handle's folder is not the record's tree");
  assert.deepEqual(scanned.calls, ["workspaceRef:workspace", "refresh", "current", "hostProcessListing"]);

  // An unreadable host process table is never an idle participant.
  const blind = hostStub({ hostProcessListing: async () => null }, { ...state(), handle: { refresh: async () => true, record: () => retained, directory: "/workspace" } });
  assert.equal(await new WorkspaceContinuation(blind).noLiveWorkspaceProcesses("workspace", ["run-1"]),
    "the host process listing is unreadable");

  // A replaced process table and a live process in the record's tree keep their refusals.
  const live = hostStub({ hostProcessListing: async () => [fact(7, "bash build", "/workspace")] },
    { ...state(), handle: { refresh: async () => true, record: () => retained, directory: "/workspace" } });
  assert.match((await new WorkspaceContinuation(live).noLiveWorkspaceProcesses("workspace", ["run-1"])) ?? "",
    /task workspace process tree/);
  const ticket = hostStub({ hostProcessListing: async () => [fact(8, "node /plugin/mcp-report.mjs /tickets/mcp-run-1.json", "/other")] },
    { ...state(), handle: { refresh: async () => true, record: () => retained, directory: "/workspace" } });
  assert.match((await new WorkspaceContinuation(ticket).noLiveWorkspaceProcesses("workspace", ["run-1"])) ?? "",
    /still carries the run MCP ticket/);

  // The host's process table is read at the call: replacing it changes the next answer.
  const late = { ...state(), handle: { refresh: async () => true, record: () => retained, directory: "/workspace" } };
  const replaced = hostStub({}, late);
  const lateContinuation = new WorkspaceContinuation(replaced);
  assert.equal(await lateContinuation.noLiveWorkspaceProcesses("workspace", ["run-1"]), null);
  replaced.hostProcessListing = async () => [fact(9, "bash test", "/workspace")];
  assert.match((await lateContinuation.noLiveWorkspaceProcesses("workspace", ["run-1"])) ?? "", /task workspace process tree/);
});

test("the continuation preflight proves the owned path through the host before it refreshes identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-continuation-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "workspace");
  mkdirSync(directory);
  const admitted: string[] = [];
  const placement: WorkspacePlacementFixture = { dataDir: "/queue", admit: path => admitted.push(path) };
  const host = hostStub({
    placement: () => { host.calls.push("placement"); return placement; },
    ownedPathFor: async () => { host.calls.push("ownedPathFor"); return directory; },
  }, { ...state(), handle: { refresh: async () => true, record: () => ({ projectRootPath: "/repo" }), directory } });
  const continuation = new WorkspaceContinuation(host);

  assert.deepEqual(await continuation.preflightWorkerContinuation(task({ directory })), { available: true });
  assert.deepEqual(host.calls.filter(call => call !== "directory"), ["placement", "ownedPathFor", "workspaceRef:workspace", "refresh", "current"]);
  assert.equal(host.calls.at(-1), "directory", "the registration's own directory is read after its record");
  assert.deepEqual(admitted, [directory], "only the task's own recorded path is admitted");

  // A recorded path that is not the owned one is not admitted, and the identity proof still runs.
  admitted.length = 0;
  host.calls.length = 0;
  host.ownedPathFor = async () => { host.calls.push("ownedPathFor"); return "/elsewhere"; };
  assert.deepEqual(await continuation.preflightWorkerContinuation(task({ directory })), { available: true });
  assert.deepEqual(admitted, []);
  assert.deepEqual(host.calls.filter(call => call !== "directory"), ["placement", "ownedPathFor", "workspaceRef:workspace", "refresh", "current"]);

  // A refused admission is the refusal text, and nothing is refreshed after it.
  host.calls.length = 0;
  host.placement = () => { host.calls.push("placement"); return { dataDir: "/queue", admit: () => { throw Error("storage unavailable"); } }; };
  host.ownedPathFor = async () => { host.calls.push("ownedPathFor"); return directory; };
  assert.deepEqual(await continuation.preflightWorkerContinuation(task({ directory })),
    { available: false, reason: "storage unavailable" });
  assert.deepEqual(host.calls, ["placement", "ownedPathFor"], "no registration is read after a refused admission");
});

test("the continuation preflight keeps its incomplete, archived, removed and changed-identity refusals", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-continuation-refusals-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "workspace"), other = join(root, "other");
  mkdirSync(directory);
  mkdirSync(other);
  const handle = (overrides: Partial<Handle> = {}): Handle => ({
    refresh: async () => true, record: () => ({ projectRootPath: "/repo" }), directory, ...overrides,
  });
  const preflight = (handleValue: Handle, overrides: Partial<WorkspaceContinuationHost> = {}) =>
    new WorkspaceContinuation(hostStub(overrides, { ...state(), handle: handleValue })).preflightWorkerContinuation(task({ directory }));

  assert.deepEqual(await new WorkspaceContinuation(hostStub()).preflightWorkerContinuation(task({ directory: undefined })),
    { available: false, reason: "Retained worker workspace identity is incomplete; no continuation was sent" });

  const archived = await preflight(handle({ record: () => null }));
  assert.equal(archived.available, false);
  if (!archived.available) assert.equal(archived.reason,
    "Retained worker workspace workspace was archived or removed before continuation dispatch; no continuation was sent");

  const moved = await preflight(handle({ directory: other }));
  assert.equal(moved.available, false);
  if (!moved.available) assert.equal(moved.reason,
    "Retained worker workspace workspace changed identity before continuation dispatch; no continuation was sent");

  const elsewhere = await preflight(handle({ record: () => ({ projectRootPath: "/elsewhere" }) }));
  assert.equal(elsewhere.available, false);
  if (!elsewhere.available) assert.match(elsewhere.reason, /changed identity before continuation dispatch/);

  // The task's own directory is a legitimate project root beside its repository.
  assert.deepEqual(await preflight(handle({ record: () => ({ projectRootPath: directory }) })), { available: true });
});

test("the closeout registration keeps its title, request identity and branch-off source", async () => {
  const host = hostStub();
  const continuation = new WorkspaceContinuation(host);
  const head = "b".repeat(40);
  const longTitle = `Task ${"word ".repeat(70)}`;

  assert.deepEqual(await continuation.createCloseoutWorkspace(task({ title: longTitle, resolution: { closeoutWorkspaceHead: head } as Task["resolution"] })),
    { id: "w-closeout", directory: "/closeout" });
  const spec = host.state.spec!;
  assert.equal(spec.requestId, "ns-closeout-workspace-task");
  assert.ok(spec.title.length <= 200 && spec.title.endsWith("…"), `${spec.title.length}`);
  assert.deepEqual(spec.source, { kind: "worktree", cwd: "/repo", action: "branch-off",
    baseBranch: head, branchName: "ns-closeout-task", worktreeSlug: "ns-closeout-task" });

  // A registration without a directory is not a workspace, and core names the refusal.
  host.state.created = { id: "w-closeout", directory: null };
  await assert.rejects(continuation.createCloseoutWorkspace(task({ resolution: { closeoutWorkspaceHead: head } as Task["resolution"] })),
    { message: "Closeout workspace returned no directory" });
});

test("the closeout lookup keeps only this task's branch-off registration at the repository", async () => {
  const host = hostStub({}, { ...state(), inventory: [
    { id: "own", projectRootPath: "/repo", worktreeSlug: "ns-closeout-task", workspaceDirectory: "/closeout" },
    { id: "no-directory", projectRootPath: "/repo", worktreeSlug: "ns-closeout-task", workspaceDirectory: null },
    { id: "another-task", projectRootPath: "/repo", worktreeSlug: "ns-closeout-other", workspaceDirectory: "/other" },
    { id: "another-repo", projectRootPath: "/elsewhere", worktreeSlug: "ns-closeout-task", workspaceDirectory: "/wrong" },
  ] });
  assert.deepEqual(await new WorkspaceContinuation(host).findCloseoutWorkspaces(task()), [
    { id: "own", directory: "/closeout" },
    { id: "no-directory", directory: "" },
  ], "a registration the host reports without a directory keeps its empty directory, as before");
});

test("the closeout verification proves refreshed identity before the exact-head and cleanliness proof", async t => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-continuation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const gitRun = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
  gitRun("init", "-q", "-b", "main");
  gitRun("commit", "-q", "--allow-empty", "-m", "integration");
  const head = gitRun("rev-parse", "HEAD");

  const record = (overrides: Partial<HostWorkspaceRecord> = {}): HostWorkspaceRecord =>
    ({ projectRootPath: repo, worktreeSlug: "ns-closeout-task", workspaceDirectory: repo, ...overrides });
  const verify = (handleValue: Handle, taskOverrides: Partial<Task> = {}) => {
    const host = hostStub({}, { ...state(), handle: handleValue });
    return { host, result: new WorkspaceContinuation(host).verifyCloseoutWorkspace(
      task({ repoPath: repo, resolution: { closeoutWorkspaceHead: head } as Task["resolution"], ...taskOverrides }), "closeout", repo) };
  };

  const passing = verify({ refresh: async () => true, record: () => record(), directory: repo });
  await passing.result;
  assert.deepEqual(passing.host.calls.filter(call => call !== "directory"), ["workspaceRef:closeout", "refresh", "current"]);

  // A changed identity is refused before any Git read: the folder need not even exist.
  const identity = verify({ refresh: async () => true, record: () => record({ worktreeSlug: "ns-closeout-other" }), directory: repo });
  await assert.rejects(identity.result, { message: "Closeout workspace identity changed" });

  // An unexpected integration commit and a dirty checkout keep the one existing refusal.
  const movedHead = verify({ refresh: async () => true, record: () => record(), directory: repo },
    { resolution: { closeoutWorkspaceHead: "c".repeat(40) } as Task["resolution"] });
  await assert.rejects(movedHead.result, { message: "Closeout workspace must be clean at its recorded integration commit" });

  writeFileSync(join(repo, "uncommitted.txt"), "work in progress\n");
  const dirty = verify({ refresh: async () => true, record: () => record(), directory: repo });
  await assert.rejects(dirty.result, { message: "Closeout workspace must be clean at its recorded integration commit" });
});

test("the adapter keeps the machine seams late-bound, so an override still governs the moved preflight", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-continuation-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "worker");
  mkdirSync(directory);

  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(root, "callback.sock"), join(root, "worker-report.mjs"));
  (adapter as any).api = { workspaces: { ref: () => ({ get directory() { return directory; }, refresh: async () => true,
    current: () => ({ projectRootPath: "/repo" }) }) } };
  const admitted: string[] = [];
  const placement = { dataDir: "/queue", admit: (path: string) => admitted.push(path) };
  (adapter as any).placement = () => placement;
  (adapter as any).ownedPathFor = async () => directory;

  assert.deepEqual(await adapter.preflightWorkerContinuation(task({ directory })), { available: true });
  assert.deepEqual(admitted, [directory], "the adapter's replaced placement is the one that admits");

  // A replaced owned-path proof is read by the same preflight, not a captured copy.
  (adapter as any).ownedPathFor = async () => "/elsewhere";
  admitted.length = 0;
  assert.deepEqual(await adapter.preflightWorkerContinuation(task({ directory })), { available: true });
  assert.deepEqual(admitted, []);
});

test("the adapter's moved delegates are plain returns of the policy's own promises", () => {
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
  const continuation = (adapter as any).workspaceContinuation as WorkspaceContinuation;
  const sentinel = Promise.resolve("policy");
  const sentinels = new Map<string, Promise<unknown>>();
  for (const name of ["noLiveWorkspaceProcesses", "preflightWorkerContinuation", "createCloseoutWorkspace",
    "findCloseoutWorkspaces", "verifyCloseoutWorkspace"]) {
    const answer = sentinel.then(() => name);
    sentinels.set(name, answer);
    (continuation as any)[name] = () => answer;
  }

  assert.equal(adapter.noLiveWorkspaceProcesses("workspace", ["run-1"]), sentinels.get("noLiveWorkspaceProcesses"),
    "a plain return hands back the policy's own promise");
  assert.equal(adapter.preflightWorkerContinuation(task()), sentinels.get("preflightWorkerContinuation"));
  assert.equal(adapter.createCloseoutWorkspace(task()), sentinels.get("createCloseoutWorkspace"));
  assert.equal(adapter.findCloseoutWorkspaces(task()), sentinels.get("findCloseoutWorkspaces"));
  assert.equal(adapter.verifyCloseoutWorkspace(task(), "closeout", "/closeout"), sentinels.get("verifyCloseoutWorkspace"));
});

test("the host's worktree registration is the daemon call the adapter makes, unmapped", async () => {
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
  const sent: Array<Record<string, unknown>> = [];
  (adapter as any).api = { workspaces: { create: async (input: Record<string, unknown>) => { sent.push(input); return { id: "w", directory: "/w" }; } } };
  const head = "d".repeat(40);
  assert.deepEqual(await adapter.createCloseoutWorkspace(task({ resolution: { closeoutWorkspaceHead: head } as Task["resolution"] })),
    { id: "w", directory: "/w" });
  assert.deepEqual(sent, [{ title: "Closeout: task", requestId: "ns-closeout-workspace-task",
    source: { kind: "worktree", cwd: "/repo", action: "branch-off", baseBranch: head,
      branchName: "ns-closeout-task", worktreeSlug: "ns-closeout-task" } }]);
});
