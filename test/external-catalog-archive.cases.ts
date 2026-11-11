import { fakeAdapter } from './support/fakes';
import { test } from "./support/sharded-test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { PaseoAdapter, externalWorkspaceArchivePlacement, type Adapter, type AgentObservation } from "../service/paseo-composition";
import { OPERATOR_BOARD_CALLER, reviewEntryRecordSchema, runSchema, submissionSchema, taskControlInputSchema } from "../shared/contracts";
import { operationInputHash } from "../core/store/store";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";

/**
 * Spec 017 catalog archive of a merged review-entry task's external workspace.
 *
 * Tom's 2026-10-25 amendment allows a *worktree* entry to be archived even when
 * Paseo's teardown removes the folder, but only after a fresh clean, published
 * source proof; a non-worktree external folder keeps the no-removal rule. Every
 * case drives the public lifecycle over a disposable store, a real isolated Git
 * worktree folder and the default adapter's own code with a fake Paseo daemon,
 * so the source-gated placement proof, the same-path registration inventory, the
 * complete inventory walk and the removal/folder answers are exercised where
 * they actually run.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const workspaceId = "workspace-external";
const secondWorkspaceId = "workspace-external-second";

interface ThreadSpec { id: string; status?: string; archived?: boolean; activeTurn?: { turnId: string } | null; permissions?: boolean; foreign?: boolean }

interface PlacementOverride { cwd: string; isPaseoOwnedWorktree: boolean; mainRepoRoot: string | null }

interface RegistrationSpec {
  id?: string; kind?: string; checkout?: PlacementOverride; threads?: ThreadSpec[];
  archivedThread?: ThreadSpec; terminals?: unknown[];
}

interface PlatformOptions {
  kind?: string;
  checkout?: PlacementOverride;
  threads?: ThreadSpec[];
  archivedThread?: ThreadSpec;
  omitPage?: boolean;
  terminals?: unknown[];
  archiveThrows?: string;
  archiveError?: string;
  /** What the native teardown does to the shared folder after an authorized call. */
  removeDirectory?: boolean;
  /** What else the native call does to the preserved checkout. */
  tamperOnArchive?: "head" | null;
  unobservable?: string;
  activeObservation?: string;
  catalogAbsent?: boolean;
  /** Additional catalog registrations listed at exactly the same folder. */
  extraRegistrations?: RegistrationSpec[];
  /** A concurrent edit during an awaited pre-call inventory (terminals). */
  tamperDuringInventory?: "tracked" | "untracked" | null;
}

async function fixture(t: { after(fn: () => void | Promise<void>): void }, phase: "done" | "working" = "done", merged = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-catalog-archive-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), repo = join(root, "repo"), workspace = join(root, "external-checkout");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, repo);
  git(repo, "config", "user.name", "Queue tests");
  git(repo, "config", "user.email", "queue@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", "-A"); git(repo, "commit", "-m", "base"); git(repo, "push", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-b", "feature/external", workspace, "main");
  await writeFile(join(workspace, "feature.txt"), "external change\n");
  git(workspace, "add", "-A"); git(workspace, "commit", "-m", "external work"); git(workspace, "push", "-u", "origin", "feature/external");
  const head = git(workspace, "rev-parse", "HEAD");
  git(repo, "merge", "--no-ff", "feature/external", "-m", "merge external work");
  const mergedCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "origin", "main");
  const store = new Store(join(root, "queue.sqlite"));
  store.setMeta("paused", false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "External review entry", repoPath: repo, planningCommit: base, handoffPath: "docs/handoff.md", originAgentId: "origin",
  }), "host", "handoff", base, {
    entrypoint: "review",
    reviewEntry: reviewEntryRecordSchema.parse({
      operationId: "c".repeat(64), prNumber: 41, repository: "example/repo", branch: "feature/external", workspaceId,
      verifiedHead: head, verifiedBase: base, planningCommit: base, authority: "Operator approved takeover",
      authorDeclaration: { models: ["openai/gpt-5"], githubAuthor: "external-author", authoringSystem: "external-agent", attestedBy: "operator", provenance: "Fixture attestation" },
      checkedAt: new Date().toISOString(), preserveWorkspace: true, directory: workspace,
    }),
  });
  const task = store.update(inserted.id, {
    workspaceId, directory: workspace, prHead: head, prUrl: "https://github.com/example/repo/pull/41", branch: "feature/external",
    phase,
    resolution: { ...inserted.resolution, ...(merged ? { mergedCommit, syncedCommit: mergedCommit } : {}) },
  });
  return { root, origin, repo, workspace, store, task, base, head, mergedCommit: merged ? mergedCommit : null, branch: "feature/external" };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The default adapter over a fake daemon: the placement proof and answers are the real ones. */
function platform(f: Fixture, options: PlatformOptions = {}) {
  const registrations = [{
    id: workspaceId,
    kind: options.kind ?? "directory",
    checkout: options.checkout ?? { cwd: f.workspace, isPaseoOwnedWorktree: false, mainRepoRoot: null as string | null },
    threads: options.threads ?? [{ id: "review-agent", status: "idle" } as ThreadSpec],
    archivedThread: options.archivedThread,
    terminals: options.terminals ?? [],
  }, ...(options.extraRegistrations ?? []).map(spec => ({
    id: spec.id ?? secondWorkspaceId,
    kind: spec.kind ?? options.kind ?? "directory",
    checkout: spec.checkout ?? options.checkout ?? { cwd: f.workspace, isPaseoOwnedWorktree: false, mainRepoRoot: null as string | null },
    threads: spec.threads ?? [],
    archivedThread: spec.archivedThread,
    terminals: spec.terminals ?? [],
  }))];
  const state = {
    catalogued: new Map<string, boolean>(registrations.map(registration => [registration.id, true])),
    // Mutable so a case can end the fault that made the native answer unknown.
    archiveThrows: options.archiveThrows ?? null as string | null,
  };
  if (options.catalogAbsent) state.catalogued.set(workspaceId, false);
  const calls = { archive: 0, requests: [] as string[], targets: [] as string[], pages: 0, terminalLists: 0, catalogs: 0 };
  const adapter = Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  const registrationOf = (agentId: string) => registrations.find(entry => [...entry.threads, ...(entry.archivedThread ? [entry.archivedThread] : [])].some(thread => thread.id === agentId));
  adapter.observe = async (agentId: string): Promise<AgentObservation> => {
    if (options.unobservable === agentId) throw Error("observation unavailable");
    const registration = registrationOf(agentId);
    const thread = [...(registration?.threads ?? []), ...(registration?.archivedThread ? [registration.archivedThread] : [])].find(item => item.id === agentId);
    // A thread Paseo already archived is not answerable by id; its inventory
    // archived fact is the proof, so the adapter must not need this call.
    if (thread?.archived) throw Error("archived agent is not observable");
    const active = options.activeObservation === agentId || Boolean(thread?.activeTurn);
    return { id: agentId, workspaceId: registration?.id ?? workspaceId, status: active ? "running" : thread?.status ?? "idle", active, permissions: Boolean(thread?.permissions), error: "" };
  };
  // A Queue-created thread carries the task label; `foreign` models anyone else's.
  const threadPayload = (agent: ThreadSpec, id: string) => ({ ...agent, workspaceId: id, archivedAt: agent.archived ? new Date(0).toISOString() : null,
    labels: agent.foreign ? {} : { 'northstar.task': f.task.id } });
  const current = (id: string) => {
    const registration = registrations.find(entry => entry.id === id);
    if (!registration || !state.catalogued.get(id)) return null;
    return { id, workspaceDirectory: f.workspace, workspaceKind: registration.kind, project: { checkout: registration.checkout },
      gitRuntime: { isPaseoOwnedWorktree: Boolean(registration.checkout?.isPaseoOwnedWorktree) } };
  };
  const workspaceHandle = (id: string) => ({
    id,
    directory: f.workspace,
    refresh: async () => {},
    current: () => current(id),
    archive: async (requestId: string) => {
      calls.archive++;
      calls.requests.push(requestId);
      calls.targets.push(id);
      // The durable intent must exist at the exact native effect boundary.
      const record = f.store.task(f.task.id).resolution.externalWorkspaceArchives.find(item => item.workspaceId === id);
      assert.equal(record?.state, "intent", "the catalog intent is durable before the native request");
      assert.equal(record?.requestId, requestId);
      if (state.archiveThrows) throw Error(state.archiveThrows);
      if (options.removeDirectory) await rm(f.workspace, { recursive: true, force: true });
      if (options.tamperOnArchive === "head" && existsSync(f.workspace)) git(f.workspace, "reset", "--hard", "HEAD^");
      state.catalogued.set(id, false);
      return { requestId, workspaceId: id, archivedAt: new Date().toISOString(), error: options.archiveError ?? null };
    },
  });
  const allThreads = () => registrations.flatMap(entry =>
    [...entry.threads, ...(entry.archivedThread ? [entry.archivedThread] : [])].map(agent => ({ agent: threadPayload(agent, entry.id) })));
  Object.defineProperty(adapter, "api", { value: {
    terminals: { list: async ({ workspaceId: id }: { workspaceId: string }) => {
      calls.terminalLists++;
      if (options.tamperDuringInventory === "tracked") await writeFile(join(f.workspace, "feature.txt"), "changed during proof\n");
      if (options.tamperDuringInventory === "untracked") await writeFile(join(f.workspace, "late.txt"), "untracked during proof\n");
      return { requestId: "terminals", entries: registrations.find(entry => entry.id === id)?.terminals ?? [] };
    } },
    workspaces: {
      ref: (id: string) => registrations.some(entry => entry.id === id) ? workspaceHandle(id) : { refresh: async () => {}, current: () => null, archive: async () => { throw Error("unexpected workspace"); } },
      list: async ({ page }: { page?: { limit: number; cursor?: string } }) => {
        calls.catalogs++;
        const entries = registrations.filter(entry => state.catalogued.get(entry.id)).map(entry => current(entry.id)!);
        return { requestId: "workspaces", entries, pageInfo: { hasMore: false } };
      },
    },
    agents: { list: async ({ page }: { page?: { limit: number; cursor?: string } }) => {
      calls.pages++;
      const all = allThreads();
      if (options.omitPage) return { entries: all.slice(0, 1), pageInfo: { hasMore: true } };
      const first = Math.max(1, Math.ceil(all.length / 2));
      if (!page?.cursor) return all.length > first
        ? { entries: all.slice(0, first), pageInfo: { hasMore: true, nextCursor: "page-2" } }
        : { entries: all, pageInfo: { hasMore: false } };
      if (page.cursor === "page-2") return { entries: all.slice(first), pageInfo: { hasMore: false } };
      return { entries: [], pageInfo: { hasMore: false } };
    } },
  } });
  const engineAdapter: Adapter = fakeAdapter({
    profiles: async () => [], validate: async () => "", createWorkspace: async () => { throw Error("unused by the catalog archive"); },
     verifyWorkspace: async task => task.branch,
    createAgent: async () => { throw Error("unused by the catalog archive"); },
    observe: agentId => adapter.observe(agentId),
    archiveTaskWorkspace: async () => { throw Error("a preserved external workspace must never use the Queue-owned teardown path"); },
    taskWorkspaceArchived: id => adapter.taskWorkspaceArchived(id),
    externalWorkspaceCatalog: directory => adapter.externalWorkspaceCatalog(directory),
    archiveExternalWorkspace: input => adapter.archiveExternalWorkspace(input),
    verifyPr: async () => ({ url: "", head: "" }),
  });
  return { adapter, engineAdapter, calls, registrations, state };
}

function recordFor(f: Fixture, id = workspaceId) {
  return f.store.task(f.task.id).resolution.externalWorkspaceArchives.find(item => item.workspaceId === id) ?? null;
}

function expireRetry(f: Fixture) {
  const task = f.store.task(f.task.id);
  f.store.update(task.id, {
    resolution: { ...task.resolution, externalWorkspaceArchives: task.resolution.externalWorkspaceArchives.map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) },
  });
}

async function run(t: { after(fn: () => void | Promise<void>): void }, f: Fixture, options: PlatformOptions, retry?: string) {
  const p = platform(f, options);
  const engine = new Engine(f.store, p.engineAdapter, 0);
  t.after(() => engine.stop());
  await new Lifecycle(engine).archive(f.store.task(f.task.id), retry);
  return { ...p, engine, task: f.store.task(f.task.id) };
}

/** A real isolated worktree placement, which Paseo's archive may tear down. */
const worktreePlatform = (f: Fixture): PlatformOptions => ({
  kind: "worktree",
  checkout: { cwd: f.workspace, isPaseoOwnedWorktree: true, mainRepoRoot: f.repo },
});

test("a merged review-entry task archives its external sidebar entry and keeps the folder", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const before = {
    file: await readFile(join(f.workspace, "feature.txt"), "utf8"),
    head: git(f.workspace, "rev-parse", "HEAD"),
    branch: git(f.workspace, "branch", "--show-current"),
    common: git(f.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    worktrees: git(f.repo, "worktree", "list", "--porcelain"),
  };
  const run1 = await run(t, f, { threads: [{ id: "review-agent", status: "idle" }], archivedThread: { id: "closed-review-agent", status: "closed", archived: true } });
  assert.equal(run1.calls.archive, 1, "exactly one native catalog archive");
  assert.ok(run1.calls.terminalLists >= 1, "the workspace terminal inventory is observed before the request");
  assert.equal(run1.calls.targets[0], workspaceId);
  const record = recordFor(f)!;
  assert.equal(record.state, "archived");
  assert.equal(record.requestId, `ns-catalog-archive-${f.task.id}-${workspaceId}`, "the native identity is stable");
  assert.deepEqual(record.observed, { kind: "directory", isPaseoOwnedWorktree: false, mainRepoRoot: null });
  assert.deepEqual(record.participants, ["review-agent", "closed-review-agent"]);
  assert.equal(record.folderPresent, true);
  assert.equal(record.folderRemovalAuthorized, false, "a catalog-only placement authorizes no removal");
  assert.deepEqual(record.samePathRegistrations, [workspaceId]);
  assert.ok(record.native?.archivedAt, "the platform's own answer is recorded");
  assert.equal(record.source, null, "no worktree source proof is claimed for a catalog-only placement");
  assert.deepEqual(run1.task.resolution.archivedWorkspaceIds, [], "this is never a Queue-owned workspace archive");
  assert.equal(run1.task.resolution.workspaceRetirement, null, "later owner retirement authority is untouched");
  const events = f.store.events(f.task.id).map(event => event.kind);
  assert.ok(events.includes("external_workspace_archive_intent"));
  assert.ok(events.includes("external_workspace_archive_archived"));
  assert.ok(!events.includes("workspace_archived"));
  // The folder, its file, the git worktree registration and the branch are intact.
  assert.equal(existsSync(f.workspace), true);
  assert.equal(await readFile(join(f.workspace, "feature.txt"), "utf8"), before.file);
  assert.equal(git(f.workspace, "rev-parse", "HEAD"), before.head);
  assert.equal(git(f.workspace, "branch", "--show-current"), before.branch);
  assert.equal(git(f.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"), before.common);
  assert.equal(git(f.repo, "worktree", "list", "--porcelain"), before.worktrees);
  // A settled entry is never requested again.
  await new Lifecycle(run1.engine).archive(f.store.task(f.task.id));
  assert.equal(run1.calls.archive, 1);
  assert.equal(f.store.lifecycleTasks().some(item => item.id === f.task.id), false, "the task leaves the lifecycle scan once settled");
});

test("a clean, merged, published worktree entry is archived and its folder is kept", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const head = git(f.workspace, "rev-parse", "HEAD");
  const run1 = await run(t, f, worktreePlatform(f));
  assert.equal(run1.calls.archive, 1, "the clean, published worktree entry is archived");
  const record = recordFor(f)!;
  assert.equal(record.state, "archived");
  assert.equal(record.observed?.kind, "worktree");
  assert.equal(record.folderPresent, true);
  assert.equal(record.folderRemovalAuthorized, true, "the proved worktree source authorized a possible removal");
  assert.equal(record.folderRemovedBy, null, "no removal is claimed when the folder survived");
  assert.equal(record.source?.head, head);
  assert.equal(record.source?.branch, "feature/external");
  assert.equal(record.source?.directory, f.workspace);
  assert.equal(record.source?.publication, "origin/feature/external", "publication names the advertised branch that contains HEAD");
  assert.match(record.detail, /worktree registration and the branch are preserved/);
  assert.equal(existsSync(f.workspace), true);
  assert.equal(git(f.workspace, "rev-parse", "HEAD"), head);
});

test("dirty tracked, staged, untracked and unexpected ignored work holds a worktree entry with no call", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const variants: Array<{ label: string; dirty: (f: Fixture) => Promise<void> }> = [
    { label: "tracked", dirty: async f => { await writeFile(join(f.workspace, "feature.txt"), "dirty\n"); } },
    { label: "staged", dirty: async f => { await writeFile(join(f.workspace, "feature.txt"), "staged\n"); git(f.workspace, "add", "feature.txt"); } },
    { label: "untracked", dirty: async f => { await writeFile(join(f.workspace, "new-file.txt"), "untracked\n"); } },
    { label: "ignored", dirty: async f => {
      await writeFile(join(f.repo, ".git", "info", "exclude"), "secret.env\n");
      await writeFile(join(f.workspace, "secret.env"), "operator secret\n");
    } },
  ];
  for (const variant of variants) {
    const f = await fixture(t);
    await variant.dirty(f);
    const p = await run(t, f, worktreePlatform(f));
    assert.equal(p.calls.archive, 0, `${variant.label}: nothing is sent`);
    const record = recordFor(f)!;
    assert.equal(record.state, "held", variant.label);
    assert.match(record.detail, /Worktree source could not be proved clean and owned|tracked, index or untracked|ignored content/, variant.label);
    assert.equal(record.folderRemovalAuthorized, false, variant.label);
    assert.equal(existsSync(f.workspace), true, variant.label);
    await p.engine.stop(); f.store.close();
  }
});

test("ignored runtime material the cleanup policy owns does not block a worktree entry", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, ".git", "info", "exclude"), "node_modules/\n");
  await mkdir(join(f.workspace, "node_modules", "dep"), { recursive: true });
  await writeFile(join(f.workspace, "node_modules", "dep", "index.js"), "");
  const p = await run(t, f, worktreePlatform(f));
  assert.equal(p.calls.archive, 1, "disposable ignored runtime material is expected");
  const record = recordFor(f)!;
  assert.equal(record.state, "archived");
  assert.deepEqual(record.source?.ignored, ["node_modules"]);
});

test("a clean but unpublished worktree head holds the entry", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "local-only.txt"), "unpublished\n");
  git(f.workspace, "add", "-A"); git(f.workspace, "commit", "-m", "local only");
  const p = await run(t, f, worktreePlatform(f));
  assert.equal(p.calls.archive, 0, "nothing is sent for an unpublished head");
  const record = recordFor(f)!;
  assert.equal(record.state, "held");
  assert.match(record.detail, /on no branch the canonical remote advertises/);
  assert.equal(git(f.workspace, "rev-parse", "HEAD"), git(f.workspace, "rev-parse", "HEAD"), "the local commit is preserved");
  assert.equal(existsSync(join(f.workspace, "local-only.txt")), true, "the unpublished work is never discarded");
});

test("a wrong or unknown remote holds a worktree entry", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  git(f.workspace, "remote", "set-url", "origin", join(f.root, "somewhere-else.git"));
  const p = await run(t, f, worktreePlatform(f));
  assert.equal(p.calls.archive, 0);
  assert.equal(recordFor(f)!.state, "held");
  assert.match(recordFor(f)!.detail, /canonical remote|canonical repository|advertises/);
});

test("a source change during an awaited inventory holds the entry instead of reusing a stale proof", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { ...worktreePlatform(f), tamperDuringInventory: "tracked" });
  assert.equal(p.calls.archive, 0, "the changed worktree is not archived on the earlier observation");
  assert.equal(recordFor(f)!.state, "held");
  assert.match(recordFor(f)!.detail, /tracked, index or untracked|changed/);
  assert.equal(existsSync(f.workspace), true);
});

test("a native archive that changes the preserved Git identity is a visible failure on both placements", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const placement of ["worktree", "catalog-only"] as const) {
    const f = await fixture(t);
    const p = await run(t, f, { ...(placement === "worktree" ? worktreePlatform(f) : {}), tamperOnArchive: "head" });
    assert.equal(p.calls.archive, 1, placement);
    const record = recordFor(f)!;
    assert.equal(record.state, "failed", placement);
    assert.match(record.detail, /changed the preserved Git identity/, placement);
    assert.equal(record.folderPresent, true, `${placement}: the folder survived with a changed identity`);
    assert.equal(existsSync(f.workspace), true, placement);
    // A hard failure is terminal: no automatic replay and no owner replay.
    await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
    assert.equal(p.calls.archive, 1, placement);
    await p.engine.stop(); f.store.close();
  }
});

test("a foreign thread keeps the entry with a visible cause", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { threads: [{ id: "review-agent", status: "idle" }, { id: "tom-1-1-session", status: "idle", foreign: true }] });
  assert.equal(p.calls.archive, 0, "nothing is sent");
  const record = recordFor(f)!;
  assert.equal(record.state, "held");
  assert.match(record.detail, /tom-1-1-session/);
  assert.equal(record.native, null);
  assert.equal(existsSync(f.workspace), true);
  assert.match(f.store.task(f.task.id).resolution.cleanupReason, /External workspace catalog entry held/);
  assert.ok(f.store.events(f.task.id).some(event => event.kind === "external_workspace_archive_held"));
});

test("a pending permission or an incomplete inventory keeps the entry", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const kind of ["permission", "incomplete"] as const) {
    const f = await fixture(t);
    const p = await run(t, f, kind === "permission"
      ? { ...worktreePlatform(f), threads: [{ id: "review-agent", status: "idle", permissions: true }] }
      : { ...worktreePlatform(f), threads: [{ id: "review-agent", status: "idle" }, { id: "second-agent", status: "idle" }], omitPage: true });
    assert.equal(p.calls.archive, 0, kind);
    assert.equal(recordFor(f)!.state, "held");
    assert.match(recordFor(f)!.detail, kind === "permission" ? /become idle/ : /inventory is incomplete/);
    await p.engine.stop(); f.store.close();
  }
});

test("an unreadable or active participant keeps the entry", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const options of [{ unobservable: "review-agent" }, { activeObservation: "review-agent" }, { threads: [{ id: "review-agent", status: "running" }] }] as PlatformOptions[]) {
    const f = await fixture(t);
    const p = await run(t, f, { ...worktreePlatform(f), ...options });
    assert.equal(p.calls.archive, 0, JSON.stringify(options));
    assert.equal(recordFor(f)!.state, "held");
    await p.engine.stop();
    f.store.close();
  }
});

test("a workspace terminal keeps the entry", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { terminals: [{ id: "terminal-1", workspaceId, cwd: f.workspace, name: "shell" }] });
  assert.equal(p.calls.archive, 0, "Paseo's archive would kill the workspace's terminal");
  assert.match(recordFor(f)!.detail, /terminal session/);
});

test("a Paseo-owned or inconsistent non-worktree placement is refused before any request", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const options of [
    { kind: "local_checkout", checkout: { cwd: "", isPaseoOwnedWorktree: true, mainRepoRoot: "/repo" }, removeDirectory: true },
    { kind: "directory", checkout: { cwd: "", isPaseoOwnedWorktree: false, mainRepoRoot: "/repo" }, removeDirectory: true },
    { kind: "directory", checkout: { cwd: "", isPaseoOwnedWorktree: true, mainRepoRoot: null }, removeDirectory: true },
  ] satisfies PlatformOptions[]) {
    const f = await fixture(t);
    const p = await run(t, f, { ...options, checkout: { ...options.checkout!, cwd: options.checkout!.cwd || f.workspace } });
    assert.equal(p.calls.archive, 0, `no request for ${JSON.stringify(options)}: a removing archive is never called`);
    const record = recordFor(f)!;
    assert.equal(record.state, "held");
    assert.match(record.detail, /placement/);
    assert.equal(existsSync(f.workspace), true, "the folder is untouched because nothing was called");
    await p.engine.stop();
    f.store.close();
  }
});

test("the pre-amendment placement proof still refuses a worktree placement", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const view = {
    workspaceDirectory: f.workspace, workspaceKind: "worktree",
    project: { checkout: { cwd: f.workspace, isPaseoOwnedWorktree: true, mainRepoRoot: f.repo } },
    gitRuntime: { isPaseoOwnedWorktree: true },
  };
  const parentProof = externalWorkspaceArchivePlacement(view, workspaceId, f.workspace);
  assert.equal(parentProof.ok, false, "the old rule refuses a worktree placement outright");
  assert.match((parentProof as { reason: string }).reason, /worktree placement/);
  const amended = externalWorkspaceArchivePlacement(view, workspaceId, f.workspace, true);
  assert.equal(amended.ok, true, "only the caller that will demand the source proof may accept it");
});

test("a platform that removes a non-worktree folder is a visible failure with no success claim and no replay", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { removeDirectory: true });
  assert.equal(p.calls.archive, 1);
  const record = recordFor(f)!;
  assert.equal(record.state, "failed");
  assert.equal(record.folderPresent, false, "the removal is recorded as observed, never claimed as preserved");
  assert.match(record.detail, /removed the preserved folder/);
  assert.deepEqual(p.task.resolution.archivedWorkspaceIds, []);
  const events = f.store.events(f.task.id).map(event => event.kind);
  assert.ok(events.includes("external_workspace_archive_failed"));
  assert.ok(!events.includes("external_workspace_archive_archived"));
  assert.match(f.store.task(f.task.id).resolution.cleanupReason, /failed/);
  // A hard failure is terminal: no automatic replay and no owner replay.
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id), workspaceId);
  assert.equal(p.calls.archive, 1, "no second call");
});

test("a worktree teardown removal is accepted and recorded as a removal", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const head = git(f.workspace, "rev-parse", "HEAD");
  const p = await run(t, f, { ...worktreePlatform(f), removeDirectory: true });
  assert.equal(p.calls.archive, 1);
  const record = recordFor(f)!;
  assert.equal(record.state, "archived", "a removal under the proved worktree permission is a success");
  assert.equal(record.folderPresent, false, "the removal is observed, never claimed as preserved");
  assert.equal(record.folderRemovalAuthorized, true);
  assert.equal(record.folderRemovedBy, workspaceId, "the durable removal chain names its own entry");
  assert.equal(record.source?.head, head);
  assert.match(record.detail, /teardown removed the folder under the freshly proved clean, published worktree permission/);
  assert.doesNotMatch(record.detail, /are preserved/);
  assert.equal(existsSync(f.workspace), false);
  const events = f.store.events(f.task.id).map(event => event.kind);
  assert.ok(events.includes("external_workspace_archive_archived"));
  assert.ok(!events.includes("external_workspace_archive_failed"));
  assert.equal(f.store.lifecycleTasks().some(item => item.id === f.task.id), false);
});

test("a second same-path registration is archived after the first and never reuses its success", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  // An empty registration and one holding another of this task's own idle
  // threads are both allowed: only foreign or active threads protect the folder.
  const p = await run(t, f, { ...worktreePlatform(f), extraRegistrations: [{ id: secondWorkspaceId, threads: [{ id: "second-agent", status: "idle" }] }] });
  assert.equal(p.calls.archive, 2, "both registrations are archived");
  assert.deepEqual(p.calls.targets, [workspaceId, secondWorkspaceId]);
  for (const id of [workspaceId, secondWorkspaceId]) {
    const record = recordFor(f, id)!;
    assert.equal(record.state, "archived", id);
    assert.deepEqual(record.samePathRegistrations, [workspaceId, secondWorkspaceId], id);
    assert.equal(record.folderPresent, true, id);
  }
  assert.notEqual(recordFor(f, workspaceId)!.settledAt, null);
  assert.equal(existsSync(f.workspace), true);
  // A restart finds everything settled and sends nothing.
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.equal(p.calls.archive, 2);
  assert.equal(f.store.lifecycleTasks().some(item => item.id === f.task.id), false);
});

test("one authorized removal plus a second registration settles through the durable removal chain", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const head = git(f.workspace, "rev-parse", "HEAD");
  const p = await run(t, f, { ...worktreePlatform(f), removeDirectory: true, extraRegistrations: [{ id: secondWorkspaceId }] });
  assert.equal(p.calls.archive, 2, "the second entry is still archived, using the recorded removal");
  const first = recordFor(f, workspaceId)!;
  assert.equal(first.folderPresent, false);
  assert.equal(first.folderRemovedBy, workspaceId);
  const second = recordFor(f, secondWorkspaceId)!;
  assert.equal(second.state, "archived");
  assert.equal(second.folderPresent, false);
  assert.equal(second.folderRemovalAuthorized, true, "the chain is the removal permission, not a new clean inference");
  assert.equal(second.folderRemovedBy, workspaceId, "the chain names the entry that removed the shared folder");
  assert.equal(second.source, null, "no source is re-proved for an absent folder");
  assert.match(second.detail, new RegExp(`recorded by ${workspaceId}`));
  assert.equal(existsSync(f.workspace), false);
  // A restart never replays either entry.
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id), secondWorkspaceId);
  assert.equal(p.calls.archive, 2);
});

test("a foreign or active thread in another registration protects the shared folder", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const foreign of [true, false] as const) {
    const f = await fixture(t);
    const p = await run(t, f, {
      ...worktreePlatform(f),
      extraRegistrations: [{ id: secondWorkspaceId, threads: [foreign
        ? { id: "tom-1-1", status: "idle", foreign: true }
        : { id: "other-live", status: "running" }] }],
    });
    assert.equal(p.calls.archive, 0, `no call while another registration holds a ${foreign ? "foreign" : "active"} thread`);
    assert.equal(recordFor(f)!.state, "held");
    assert.match(recordFor(f)!.detail, foreign ? /tom-1-1/ : /other-live/);
    assert.equal(existsSync(f.workspace), true);
    await p.engine.stop(); f.store.close();
  }
});

test("a terminal in another registration also protects the shared folder", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { ...worktreePlatform(f), extraRegistrations: [{ id: secondWorkspaceId, terminals: [{ id: "terminal-2", workspaceId: secondWorkspaceId }] }] });
  assert.equal(p.calls.archive, 0);
  assert.match(recordFor(f)!.detail, /terminal session/);
  assert.equal(existsSync(f.workspace), true);
});

test("a mixed-placement path keeps the no-removal rule and sends nothing", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, {
    ...worktreePlatform(f),
    extraRegistrations: [{ id: secondWorkspaceId, kind: "directory", checkout: { cwd: f.workspace, isPaseoOwnedWorktree: false, mainRepoRoot: null } }],
  });
  assert.equal(p.calls.archive, 0, "a non-worktree registration keeps the folder");
  const record = recordFor(f)!;
  assert.equal(record.state, "held");
  assert.match(record.detail, /disagree on placement/);
  assert.equal(existsSync(f.workspace), true);
});

test("a lost native reply is reconciled by observing the same catalog entry, never by a second call", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { archiveThrows: "timeout waiting for archive_workspace_response" });
  assert.equal(p.calls.archive, 1);
  assert.equal(recordFor(f)!.state, "uncertain");
  assert.match(recordFor(f)!.detail, /timeout/);
  // The same catalog operation is observed before anything else: the request
  // did land, so the entry is gone and no replay is needed.
  p.state.catalogued.set(workspaceId, false);
  expireRetry(f);
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f)!.state, "archived");
  assert.equal(p.calls.archive, 1, "the unknown delivery is never re-sent");
  assert.equal(recordFor(f)!.native?.archivedAt ?? null, null, "an observed reconciliation records no invented native answer");
});

test("a present entry after an unknown answer stays uncertain until an owner retry replays it once", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { archiveThrows: "connection reset" });
  assert.equal(recordFor(f)!.state, "uncertain");
  expireRetry(f);
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f)!.state, "uncertain", "an automatic pass never replays an unknown delivery");
  assert.equal(p.calls.archive, 1);
  // The owner names the effect through the existing verb; the retry re-proves
  // everything, sends the same stable identity and records the answer.
  p.state.archiveThrows = null;
  const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(f.task.id)));
  const effect = next.verbs.find(verb => verb.verb === "retry_effect" && JSON.stringify(verb.args).includes(`external_workspace_archive.${workspaceId}`));
  assert.ok(effect, "the pending catalog archive is offered to the owner");
  await p.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: "retry_effect", effect: `external_workspace_archive.${workspaceId}`, reason: "Owner retries the catalog archive", caller: OPERATOR_BOARD_CALLER });
  assert.equal(p.calls.archive, 2);
  assert.deepEqual(p.calls.requests, [`ns-catalog-archive-${f.task.id}-${workspaceId}`, `ns-catalog-archive-${f.task.id}-${workspaceId}`]);
  assert.equal(recordFor(f)!.state, "archived");
  assert.equal(existsSync(f.workspace), true);
});

test("an owner retry names one registration's own held record", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { archiveThrows: "connection reset", extraRegistrations: [{ id: secondWorkspaceId }] });
  // The first entry's unknown answer stops the pass, so the second registration
  // still owes an attempt and its own record.
  assert.equal(p.calls.archive, 1);
  assert.equal(recordFor(f)!.state, "uncertain");
  assert.equal(recordFor(f, secondWorkspaceId), null, "the unknown delivery stopped the pass before the sibling call");
  p.state.archiveThrows = null;
  const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(f.task.id)));
  const effect = next.verbs.find(verb => verb.verb === "retry_effect" && JSON.stringify(verb.args).includes(`external_workspace_archive.${workspaceId}`));
  assert.ok(effect, "the uncertain entry is offered");
  await p.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: "retry_effect", effect: `external_workspace_archive.${workspaceId}`, reason: "Owner retries the catalog archive", caller: OPERATOR_BOARD_CALLER });
  assert.equal(recordFor(f)!.state, "archived");
  // The lifecycle pass settles the remaining registration on its own.
  expireRetry(f);
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f, secondWorkspaceId)!.state, "archived");
  assert.equal(p.calls.archive, 3);
});

test("an unknown answer blocks a second same-path registration until an observation settles it", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { archiveThrows: "connection reset", extraRegistrations: [{ id: secondWorkspaceId }] });
  assert.deepEqual(p.calls.targets, [workspaceId], "the unknown answer stopped the pass before the sibling call");
  assert.equal(recordFor(f)!.state, "uncertain");
  assert.equal(recordFor(f, secondWorkspaceId), null, "the sibling has no record and was not called");
  // A later automatic pass observes the unknown entry but never calls the
  // sibling while the shared folder's state is unknown.
  expireRetry(f);
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f)!.state, "uncertain");
  assert.equal(recordFor(f, secondWorkspaceId), null, "the sibling stays untouched while the answer is unknown");
  assert.deepEqual(p.calls.targets, [workspaceId], "no sibling call on a later automatic pass");
  // Inside the recorded backoff the same pass does not even observe.
  const reads = { catalogs: p.calls.catalogs, pages: p.calls.pages, terminals: p.calls.terminalLists };
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.deepEqual({ catalogs: p.calls.catalogs, pages: p.calls.pages, terminals: p.calls.terminalLists }, reads,
    "the bounded backoff owes no catalog, inventory or terminal read");
  // An observation that the earlier request did land settles the unknown entry;
  // only then is the sibling's own attempt made, in its own pass.
  p.state.archiveThrows = null;
  p.state.catalogued.set(workspaceId, false);
  expireRetry(f);
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f)!.state, "archived");
  assert.equal(recordFor(f, secondWorkspaceId)!.state, "archived");
  assert.deepEqual(p.calls.targets, [workspaceId, secondWorkspaceId], "exactly one sibling call after the observation settled the unknown");
  assert.equal(p.calls.archive, 2);
});

test("an unknown answer in one registration blocks an owner retry of another", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { archiveThrows: "connection reset", extraRegistrations: [{ id: secondWorkspaceId }] });
  assert.equal(recordFor(f)!.state, "uncertain");
  // The sibling has no pending effect of its own yet, so the owner can only name
  // the unknown entry; retrying that one is allowed and observes first.
  const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(f.task.id)));
  const offered = next.verbs.filter(verb => verb.verb === "retry_effect" && JSON.stringify(verb.args).includes("external_workspace_archive."));
  assert.deepEqual(offered.map(verb => verb.args?.effect), [`external_workspace_archive.${workspaceId}`],
    "only the unknown entry is offered while the sibling has no record");
  p.state.archiveThrows = null;
  await p.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: "retry_effect", effect: `external_workspace_archive.${workspaceId}`, reason: "Owner retries the catalog archive", caller: OPERATOR_BOARD_CALLER });
  assert.equal(recordFor(f)!.state, "archived", "the retry observed the entry present and re-proved it before the one replay");
  assert.deepEqual(p.calls.targets, [workspaceId, workspaceId], "the retry never touched the sibling in the same pass");
  assert.equal(recordFor(f, secondWorkspaceId), null);
});

test("a sibling registration's hold is recorded on that entry, never over the bound entry's history", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  // The task's own entry is already gone from the catalog, and a second
  // registration at the same folder is referenced by another task's live run.
  const other = f.store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Another task", repoPath: f.repo, planningCommit: f.base, handoffPath: "docs/handoff.md", originAgentId: "origin",
  }), "host", "handoff", f.base);
  f.store.putRun(runSchema.parse({
    id: "other-run", taskId: other.id, role: "reviewer", generation: 1, head: f.base, base: f.base,
    agentId: "other-worker", workspaceId: secondWorkspaceId, profile: null, status: "running",
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: false,
    completion: null,
  }));
  const p = await run(t, f, { catalogAbsent: true, extraRegistrations: [{ id: secondWorkspaceId }] });
  assert.equal(p.calls.archive, 0, "nothing is sent while another task references the shared folder");
  assert.equal(recordFor(f)!.state, "archived", "the bound entry's observed-absent history is not rewritten");
  assert.match(recordFor(f)!.detail, /already absent/);
  const held = recordFor(f, secondWorkspaceId)!;
  assert.equal(held.state, "held", "the sibling carries its own visible cause");
  assert.match(held.detail, /referenced by another task/);
  assert.equal(existsSync(f.workspace), true);
  // The recorded backoff means the next pass owes no read or call.
  const reads = { catalogs: p.calls.catalogs, pages: p.calls.pages, terminals: p.calls.terminalLists };
  await new Lifecycle(p.engine).archive(f.store.task(f.task.id));
  assert.deepEqual({ catalogs: p.calls.catalogs, pages: p.calls.pages, terminals: p.calls.terminalLists }, reads);
  assert.deepEqual(p.calls.targets, []);
});

test("the complete same-path inventory is required before any call", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = platform(f, {});
  // An adapter that cannot enumerate registrations makes the same-path proof
  // impossible: the entry is held with nothing sent.
  const catalogLess: Adapter = { ...p.engineAdapter, externalWorkspaceCatalog: undefined };
  const engine = new Engine(f.store, catalogLess, 0);
  t.after(() => engine.stop());
  // Without the optional capability Queue falls back to the bound entry alone,
  // which is the pre-amendment shape and still archives only after its proofs.
  await new Lifecycle(engine).archive(f.store.task(f.task.id));
  assert.equal(p.calls.archive, 1, "without the inventory capability only the bound entry is archived");
  assert.equal(recordFor(f)!.state, "archived");
  // An unreadable inventory is a visible hold instead.
  const g = await fixture(t);
  const unreadable = platform(g, {});
  const broken: Adapter = { ...unreadable.engineAdapter, externalWorkspaceCatalog: async () => ({ ok: false, reason: "catalog read timed out" }) };
  const brokenEngine = new Engine(g.store, broken, 0);
  t.after(() => brokenEngine.stop());
  await new Lifecycle(brokenEngine).archive(g.store.task(g.task.id));
  assert.equal(unreadable.calls.archive, 0);
  assert.equal(recordFor(g)!.state, "held");
  assert.match(recordFor(g)!.detail, /complete same-path catalog inventory could not be established: catalog read timed out/);
});

test("an already absent catalog entry is recorded honestly without a request", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = await run(t, f, { catalogAbsent: true });
  assert.equal(p.calls.archive, 0, "no request is sent to an entry Paseo no longer lists");
  const record = recordFor(f)!;
  assert.equal(record.state, "archived");
  assert.equal(record.native, null);
  assert.equal(record.attempts, 0);
  assert.match(record.detail, /already absent/);
  assert.match(record.detail, /folder is preserved/);
  assert.doesNotMatch(record.detail, /also absent/);
  assert.equal(record.folderPresent, true);
  assert.equal(existsSync(f.workspace), true);
});

test("an already absent catalog entry with an absent folder reports the absence honestly", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  // The manual-worktree owner already removed the folder: Queue observes that
  // fact, sends nothing, and must not claim preservation.
  await rm(f.workspace, { recursive: true, force: true });
  const p = await run(t, f, { catalogAbsent: true });
  assert.equal(p.calls.archive, 0, "no request is sent to an entry Paseo no longer lists");
  const record = recordFor(f)!;
  assert.equal(record.state, "archived");
  assert.equal(record.native, null);
  assert.equal(record.attempts, 0);
  assert.match(record.detail, /already absent/);
  assert.match(record.detail, /folder is also absent/);
  assert.doesNotMatch(record.detail, /preserved/);
  assert.equal(record.folderPresent, false);
  assert.equal(existsSync(f.workspace), false);
});

test("an absent folder under a present entry is a failure with no call", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  await rm(f.workspace, { recursive: true, force: true });
  const p = await run(t, f, worktreePlatform(f));
  assert.equal(p.calls.archive, 0, "an unexpected removal is never treated as clean absent files");
  const record = recordFor(f)!;
  assert.equal(record.state, "failed");
  assert.match(record.detail, /absent without an authorized removal/);
});

test("an unmerged or unfinished review-entry task never requests the catalog archive", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const [phase, merged] of [["working", true], ["done", false]] as const) {
    const f = await fixture(t, phase, merged);
    const p = await run(t, f, {});
    assert.equal(p.calls.archive, 0, `${phase}/${merged}`);
    assert.equal(recordFor(f), null);
    await p.engine.stop();
    f.store.close();
  }
});

test("a paused task keeps the entry and sends nothing", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  f.store.setMeta("paused", true);
  const paused = await run(t, f, {});
  assert.equal(paused.calls.archive, 0, "Queue's pause holds the catalog archive too");
  assert.equal(recordFor(f), null);
  assert.equal(f.store.task(f.task.id).resolution.mergedCommit, f.mergedCommit, "the recorded merge is untouched");
  // Once the pause clears the same task is settled normally.
  f.store.setMeta("paused", false);
  await new Lifecycle(paused.engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f)?.state, "archived");
});

test("a replayed catalog archive retry settles from its own recorded answer and never re-sends", { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const p = platform(f, {});
  const engine = new Engine(f.store, p.engineAdapter, 0);
  t.after(() => engine.stop());
  const control = { taskId: f.task.id, version: f.store.task(f.task.id).version, action: "retry_effect" as const,
    effect: `external_workspace_archive.${workspaceId}`, caller: OPERATOR_BOARD_CALLER, reason: "Owner retries the catalog archive" };
  const payload = { type: "task_control" as const, control };
  const acceptance = f.store.acceptOperation({ key: "replay-catalog-archive", kind: "task_control", inputHash: operationInputHash(payload),
    taskId: control.taskId, expectedVersion: control.version, payload });
  assert.ok("accepted" in acceptance);
  const operationId = acceptance.operation.id;
  f.store.putOperation({ ...acceptance.operation, state: "running", startedAt: new Date().toISOString(), attempts: 1 });
  // The first run archives the entry, then the process stops before the operation settles.
  await new Lifecycle(engine).archive(f.store.task(f.task.id));
  assert.equal(recordFor(f)!.state, "archived");
  assert.equal(p.calls.archive, 1);
  assert.notEqual(f.store.task(f.task.id).version, control.version, "the task moved on, so the replayed version is stale");
  // Without its operation the stale version refuses, as before.
  await assert.rejects(engine.performTaskControl(taskControlInputSchema.parse(control)), /Task changed/);
  // Its own operation replays to the recorded outcome, with nothing re-sent.
  const replayed = await engine.performTaskControl(taskControlInputSchema.parse(control), operationId);
  assert.equal(replayed.resolution.externalWorkspaceArchives.find(record => record.workspaceId === workspaceId)?.state, "archived");
  assert.equal(p.calls.archive, 1, "no native replay");
  // An operation accepted after the effect has no such proof: it refuses as stale.
  const later = { ...control, reason: "A later retry" };
  const laterPayload = { type: "task_control" as const, control: later };
  const laterAcceptance = f.store.acceptOperation({ key: "replay-catalog-archive-later", kind: "task_control", inputHash: operationInputHash(laterPayload),
    taskId: later.taskId, expectedVersion: later.version, payload: laterPayload });
  assert.ok("accepted" in laterAcceptance);
  f.store.putOperation({ ...laterAcceptance.operation, state: "running", startedAt: new Date().toISOString(), attempts: 1 });
  await assert.rejects(engine.performTaskControl(taskControlInputSchema.parse(later), laterAcceptance.operation.id), /Task changed|pending/);
});
