import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoWorkspaceHost, type NativeThreadEntry, type NativeWorkspaceDaemon, type NativeWorkspaceEntry } from "../hosts/paseo/adapter/host-workspaces";
import { PaseoAdapter } from "../service/paseo-composition";
import type { Task } from "../shared/contracts";

/**
 * Step 3 row 3 of the Paseo host split (task 871): native workspace inventory,
 * project lookup, registration and title leave `server/paseo.ts` for the Paseo
 * host module, while inspection, the owned path and Git stay in core.
 *
 * These witnesses pin what that move could quietly break: the host reads the
 * adapter's daemon surface at call time (a test's replaced `api` must be the one
 * called), the inventory still pages to a positive end and refuses a partial
 * walk with the same messages, registration sends the existing request identity
 * and never invents a directory the daemon did not answer, the title write still
 * refreshes before it sends and keeps its refusals, and the project lookup keeps
 * its empty fallback.
 */

const adapter = () => new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
const withApi = (machine: PaseoAdapter, api: unknown) => { (machine as unknown as { api: unknown }).api = api; return machine; };

/** One page of the daemon inventory. */
const page = (entries: NativeWorkspaceEntry[], pageInfo: { hasMore: boolean; nextCursor?: string }) => ({ entries, pageInfo });

/** A daemon surface carrying only what the host reads; every call is recorded. */
function daemon(overrides: Partial<NativeWorkspaceDaemon["workspaces"]> = {},
  projects: { list(): Promise<{ projects: { projectRootPath: string; projectId: string }[] }> } = { list: async () => ({ projects: [] }) },
  surfaces: Pick<NativeWorkspaceDaemon, "agents" | "terminals"> = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, terminals: { list: async () => ({ entries: [] }) } }): NativeWorkspaceDaemon & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    ...surfaces,
    workspaces: {
      list: async () => { seen.push("list"); return page([], { hasMore: false }); },
      create: async () => { seen.push("create"); return { id: "w-new", directory: "/new" }; },
      ref: () => { seen.push("ref"); return { name: null, directory: null, refresh: async () => null, current: () => null, setTitle: async () => ({ title: null }), archive: async () => ({ requestId: "", workspaceId: "", archivedAt: null, error: null }) }; },
      ...overrides,
    },
    projects,
  };
}

test("the host reads the adapter's daemon surface at each call, so a replaced api is the one called", async () => {
  const directory = process.cwd();
  const reads: string[] = [];
  const surface = (mark: string) => daemon({ ref: () => {
    reads.push(mark);
    return { name: null, directory, refresh: async () => ({ id: mark }), current: () => null, setTitle: async () => ({ title: null }), archive: async () => ({ requestId: "", workspaceId: "", archivedAt: null, error: null }) };
  } });
  const machine = withApi(adapter(), surface("first"));

  assert.equal(await machine.workspaceAvailable("w1"), true);
  withApi(machine, surface("second"));
  assert.equal(await machine.workspaceAvailable("w2"), true);

  assert.deepEqual(reads, ["first", "second"], "the api read after construction is the one called");
});

test("the inventory pages to its positive end and keeps both refusals byte-identical", async () => {
  const pages = [page([{ id: "a", projectRootPath: "/repo" }], { hasMore: true, nextCursor: "c1" }), page([{ id: "b", projectRootPath: "/repo" }], { hasMore: false })];
  const cursors: unknown[] = [];
  const host = new PaseoWorkspaceHost({ api: daemon({ list: async (options: { page: { limit: number; cursor?: string } }) => {
    cursors.push(options.page);
    return pages[cursors.length - 1]!;
  } }) });
  assert.deepEqual((await host.workspaceInventory()).map(entry => entry.id), ["a", "b"]);
  assert.deepEqual(cursors, [{ limit: 100 }, { limit: 100, cursor: "c1" }]);

  await assert.rejects(new PaseoWorkspaceHost({ api: daemon({ list: async () => page([], { hasMore: true }) }) }).workspaceInventory(),
    { message: "Workspace lookup is incomplete" });
  await assert.rejects(new PaseoWorkspaceHost({ api: daemon({ list: async () => page([], { hasMore: true, nextCursor: "c" }) }) }).workspaceInventory(),
    { message: "Workspace lookup exceeded the bounded page limit" });
});

test("registration sends the existing request identity and returns the daemon's answer unchanged", async () => {
  const requests: unknown[] = [];
  const host = new PaseoWorkspaceHost({ api: daemon({
    create: async (options: unknown) => { requests.push(options); return { id: "w-new", directory: "/worktree" }; },
  }) });
  assert.deepEqual(await host.createWorkspace({ title: "Working: 012 Title", requestId: "ns-workspace-t1", directory: "/worktree", project: { projectId: "p1" } }),
    { id: "w-new", directory: "/worktree" });
  assert.deepEqual(requests, [{ title: "Working: 012 Title", requestId: "ns-workspace-t1",
    source: { kind: "directory", path: "/worktree", projectId: "p1" } }]);

  // No project rooted there keeps today's request shape: the key is absent, not empty.
  await host.createWorkspace({ title: "T", requestId: "ns-workspace-t2", directory: "/worktree", project: {} });
  const source = (requests[1] as { source: Record<string, unknown> }).source;
  assert.equal("projectId" in source, false);

  // A registration the daemon answered without a directory is not invented into one:
  // each caller keeps its own refusal for it.
  const empty = new PaseoWorkspaceHost({ api: daemon({ create: async () => ({ id: "w-empty", directory: null }) }) });
  assert.deepEqual(await empty.createWorkspace({ title: "T", requestId: "r", directory: "/d", project: {} }), { id: "w-empty", directory: null });
});

test("the title write refreshes first, confirms a held title without a second send, and keeps its refusals", async () => {
  const sent: unknown[][] = [];
  const ref = (name: string | null, refresh: unknown, title: string | null = null) => ({
    name, directory: "/worktree", refresh: async () => refresh, current: () => null, setTitle: async (...args: unknown[]) => { sent.push(args); return { title }; }, archive: async () => ({ requestId: "", workspaceId: "", archivedAt: null, error: null }),
  });
  const write = async (workspace: ReturnType<typeof ref>, title = "Next: 012 Title") => {
    sent.length = 0;
    await new PaseoWorkspaceHost({ api: daemon({ ref: () => workspace }) }).setWorkspaceTitle("w1", title, "ns-title-t1-v2", true);
    return sent.slice();
  };

  assert.deepEqual(await write(ref("Next: 012 Title", { id: "w1" })), [], "a title the host already holds is confirmed by the refresh alone");
  assert.deepEqual(await write(ref("Working: 012 Title", { id: "w1" }, "Next: 012 Title")), [["Next: 012 Title", "ns-title-t1-v2"]]);
  await assert.rejects(write(ref("Working: 012 Title", null)), { message: "Task workspace is no longer available" });
  await assert.rejects(write(ref("Working: 012 Title", { id: "w1" }, "something else")), { message: "Workspace title update was not confirmed" });

  // The adapter's own member keeps the identity refusal before any native read.
  let reads = 0;
  const machine = withApi(adapter(), daemon({ ref: () => { reads++; return ref(null, { id: "w" }); } }));
  await assert.rejects(machine.setTaskWorkspaceTitle({ id: "t", repoPath: "/repo", title: "T" } as Task, "Next: 012 Title", "r", false),
    { message: "Task workspace is missing" });
  assert.equal(reads, 0, "a task with no workspace identity reads nothing");
});

test("the project lookup matches the repository root and keeps the empty fallback", async () => {
  const projects = (list: () => Promise<{ projects: { projectRootPath: string; projectId: string }[] }>) => new PaseoWorkspaceHost({ api: daemon({}, { list }) });
  assert.deepEqual(await projects(async () => ({ projects: [{ projectRootPath: "/repo", projectId: "p1" }, { projectRootPath: "/other", projectId: "p2" }] })).repositoryProject("/repo"),
    { projectId: "p1" });
  assert.deepEqual(await projects(async () => ({ projects: [{ projectRootPath: "/other", projectId: "p2" }] })).repositoryProject("/repo"), {});
  assert.deepEqual(await projects(async () => { throw new Error("unreadable"); }).repositoryProject("/repo"), {},
    "a failed project read is the existing empty fallback, never a new refusal");
});

test("availability needs a refreshed directory that exists on disk", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-host-workspaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const readable = (directory: string | null, refresh: unknown) => new PaseoWorkspaceHost({ api: daemon({ ref: () => ({
    name: null, directory, refresh: async () => refresh, current: () => null, setTitle: async () => ({ title: null }), archive: async () => ({ requestId: "", workspaceId: "", archivedAt: null, error: null }) }) }) });

  assert.equal(await readable(root, { id: "w" }).workspaceAvailable("w"), true);
  assert.equal(await readable(null, { id: "w" }).workspaceAvailable("w"), false, "an unreadable handle is not available");
  assert.equal(await readable(join(root, "gone"), { id: "w" }).workspaceAvailable("w"), false, "a registered folder that is gone is not available");
});

test("the delegates hand back the caller's own promise, so the move adds no microtask turn", async () => {
  // Rule 9 of the lane contract: a delegate is a plain return method, never an
  // async wrapper, and a moved call must not gain an await of its own.
  const registration = Promise.resolve({ id: "w-new", directory: "/worktree" });
  const host = new PaseoWorkspaceHost({ api: daemon({ create: () => registration }) });
  assert.equal(host.createWorkspace({ title: "T", requestId: "r", directory: "/d", project: {} }), registration,
    "the registration is the daemon's own promise, awaited and mapped by core as before");

  const available = Promise.resolve(true);
  const titled = Promise.resolve();
  const project = Promise.resolve({ projectId: "p1" });
  const seen: string[] = [];
  const machine = adapter();
  (machine as unknown as { workspaceHostCache: unknown }).workspaceHostCache = {
    workspaceAvailable: (id: string) => { seen.push(`available:${id}`); return available; },
    setWorkspaceTitle: (id: string) => { seen.push(`title:${id}`); return titled; },
    repositoryProject: (root: string) => { seen.push(`project:${root}`); return project; },
  };
  assert.equal(machine.workspaceAvailable("w1"), available);
  assert.equal(machine.setTaskWorkspaceTitle({ id: "t", repoPath: "/repo", workspaceId: "w1" } as Task, "Next: 012 T", "r", false), titled);
  assert.deepEqual(seen, ["available:w1", "title:w1"]);

  // The cap runs before the host call, and a task with no identity rejects rather
  // than throwing out of a delegate that used to reject.
  await machine.setTaskWorkspaceTitle({ id: "t", repoPath: "/repo", workspaceId: "w2" } as Task, "word ".repeat(60), "r", false);
  assert.equal(seen[2], "title:w2");
  await assert.rejects(machine.setTaskWorkspaceTitle({ id: "t", repoPath: "/repo" } as Task, "T", "r", false),
    { message: "Task workspace is missing" });
});

test("the registration handle hands back the daemon's own refresh, record and directory, read at call time", async () => {
  // Step 3 row 4 (task 871): the continuation preflight and the process proof keep
  // their refresh and record reads in core. The host supplies a handle whose refresh
  // is the daemon's own promise, so the caller's await is the first after the call.
  const pending = Promise.resolve({ id: "w1" });
  const record = { projectRootPath: "/repo", workspaceDirectory: "/worktree" };
  const native = { directory: "/worktree", refresh: () => pending, current: () => record, setTitle: async () => ({ title: null }) };
  const seen: string[] = [];
  const machine = withApi(adapter(), daemon({ ref: (id: string) => { seen.push(id); return native as never; } }));
  const host = new PaseoWorkspaceHost(machine as never);

  const handle = host.workspaceRef("w1");
  assert.equal(handle.refresh(), pending, "refresh is the daemon's own promise, not a wrapper");
  assert.equal(handle.current(), record, "the record is the daemon's own object");
  assert.equal(typeof (handle as { then?: unknown }).then, "undefined", "the handle is not a promise");
  assert.deepEqual(seen, ["w1"]);

  // The directory is read when the caller reads it, so a later refresh is seen.
  native.directory = "/moved";
  assert.equal(handle.directory, "/moved");

  // The surface read is the one live at the call, as for every other host method.
  withApi(machine, daemon({ ref: (id: string) => { seen.push(id); return { ...native, directory: "/other" } as never; } }));
  assert.equal(host.workspaceRef("w2").directory, "/other");
  assert.deepEqual(seen, ["w1", "w2"]);
});

test("the archive runs through the registration handle at once, and only an absent record reads as archived", async () => {
  // Step 3 row 5 (task 871): the native archive and the archived-state read leave
  // `server/paseo.ts`. Core keeps the proofs around them. The archive is one call
  // with the request ID core names, made before the handle returns, and a rejection
  // is the daemon's own error object, so an unknown delivery stays unknown.
  const record = { projectRootPath: "/repo", workspaceDirectory: "/worktree" };
  const calls: string[] = [];
  const failure = new Error("socket closed");
  let catalogued = true;
  const native = {
    directory: "/worktree",
    refresh: async () => { calls.push("refresh"); return { id: "w1" }; },
    current: () => (catalogued ? record : undefined),
    setTitle: async () => ({ title: null }),
    archive: async (requestId: string) => {
      calls.push(`archive:${requestId}`);
      if (requestId === "lost") throw failure;
      catalogued = false;
      return { requestId, workspaceId: "w1", archivedAt: "2026-11-08T00:00:00.000Z", error: null };
    },
  };
  const machine = withApi(adapter(), daemon({ ref: () => native as never }));
  const host = new PaseoWorkspaceHost(machine as never);

  assert.equal(await host.workspaceArchived("w1"), false, "a listed registration is not archived");
  assert.deepEqual(calls, ["refresh"], "the archived read refreshes before it reads the record");

  const pending = host.workspaceRef("w1").archive("ns-archive-t1-w1");
  assert.deepEqual(calls, ["refresh", "archive:ns-archive-t1-w1"], "the native archive is called before the handle returns");
  assert.deepEqual(await pending, { requestId: "ns-archive-t1-w1", workspaceId: "w1", archivedAt: "2026-11-08T00:00:00.000Z", error: null },
    "the daemon's own result comes back unchanged");

  assert.equal(await host.workspaceArchived("w1"), true, "an absent record is the only archived answer");
  assert.equal(await machine.taskWorkspaceArchived("w1"), true, "the adapter reads the same host answer");
  assert.equal(await host.workspaceRef("w1").archive("lost").catch(error => error), failure, "a rejected archive is the daemon's own error");
});

test("the thread and terminal inventories page to their positive end, filter by registration and keep their refusals", async () => {
  // Step 3 row 6 (task 871): the complete thread and terminal inventories leave
  // `server/paseo.ts`. The host walks each daemon list to its end and reports an
  // incomplete or unreadable read as a refusal; ownership, idleness and the
  // count-based refusal stay in core.
  const agent = (id: string, workspaceId: string | null, extra: Record<string, unknown> = {}) => ({ agent: { id, workspaceId, ...extra } });
  const first = [agent("t1", "w1", { labels: { "northstar.task": "task-1" }, status: "idle", archivedAt: "2026-11-07T00:00:00.000Z" }), agent("elsewhere", "w9")];
  const second = [agent("t2", "w2", { status: null, activeTurn: { turnId: "turn" }, pendingPermissions: [{ kind: "question" }, null] }), agent("t3", null)];
  const calls: unknown[] = [];
  const pages: Record<string, { entries: NativeThreadEntry[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }> = {
    "": { entries: first, pageInfo: { hasMore: true, nextCursor: "c2" } },
    c2: { entries: second, pageInfo: { hasMore: false } },
  };
  const walk = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async (options) => { calls.push(options); return pages[options.page.cursor ?? ""]!; } }, terminals: { list: async () => ({ entries: [] }) } }) });
  const threads = await walk.workspaceThreads(["w1", "w2"]);
  assert.deepEqual(calls, [
    { filter: { includeArchived: true }, page: { limit: 200, cursor: undefined } },
    { filter: { includeArchived: true }, page: { limit: 200, cursor: "c2" } },
  ], "the walk includes archived threads and follows the cursor");
  assert.deepEqual(threads, { ok: true, threads: [
    { id: "t1", workspaceId: "w1", labels: { "northstar.task": "task-1" }, status: "idle", archived: true, activeTurn: false, pendingPermissionKinds: [] },
    { id: "t2", workspaceId: "w2", labels: {}, status: "", archived: false, activeTurn: true, pendingPermissionKinds: ["question", null] },
  ] }, "only the listed registrations, as Nucleus facts with absent values read as empty");

  const missingCursor = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true } }) }, terminals: { list: async () => ({ entries: [] }) } }) });
  assert.deepEqual(await missingCursor.workspaceThreads(["w1"]), { ok: false, reason: "Workspace thread inventory is incomplete" });
  const repeated = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } }) }, terminals: { list: async () => ({ entries: [] }) } }) });
  assert.deepEqual(await repeated.workspaceThreads(["w1"]), { ok: false, reason: "Workspace thread inventory is incomplete" }, "a repeated cursor is incomplete, never a smaller list");
  const broken = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async () => { throw new Error("socket closed"); } }, terminals: { list: async () => ({ entries: [] }) } }) });
  assert.deepEqual(await broken.workspaceThreads(["w1"]), { ok: false, reason: "Workspace thread inventory could not be read: socket closed" });

  const active: unknown[] = [];
  const live = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async (options) => { active.push(options); return { entries: [agent("a1", "w1")], pageInfo: { hasMore: false } }; } }, terminals: { list: async () => ({ entries: [] }) } }) });
  assert.deepEqual(await live.activeThreads(), [{ id: "a1", workspaceId: "w1", labels: {}, status: "", archived: false, activeTurn: false, pendingPermissionKinds: [] }]);
  assert.deepEqual(active, [{ filter: { includeArchived: false }, page: { limit: 100 } }], "the active walk excludes archived threads and sends no cursor first");
  const openEnded = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true } }) }, terminals: { list: async () => ({ entries: [] }) } }) });
  await assert.rejects(openEnded.activeThreads(), { message: "Workspace thread inventory is incomplete" }, "an unfinished active walk rejects, never reads as idle");

  const terminals = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, terminals: { list: async ({ workspaceId }) => ({ entries: [{ id: `${workspaceId}-shell`, name: "shell", extra: true } as { id: string; name: string }] }) } }) });
  assert.deepEqual(await terminals.workspaceTerminals("w1"), { ok: true, terminals: [{ id: "w1-shell", name: "shell" }] });
  const unreadable = new PaseoWorkspaceHost({ api: daemon({}, undefined, { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, terminals: { list: async () => { throw new Error("daemon gone"); } } }) });
  assert.deepEqual(await unreadable.workspaceTerminals("w1"), { ok: false, reason: "Workspace w1 terminal inventory could not be read: daemon gone" });
});
