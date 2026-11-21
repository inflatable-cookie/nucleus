import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostProcessFact } from "../core/host/types";
import { reapHostProcesses } from "../core/machine/host-process-reap";
import { selectHostProcessTargets } from "../core/machine/host-process-select";
import {
  markPaseoRuntime,
  paseoRuntimeListing,
  readPaseoDaemonPid,
} from "../hosts/paseo/adapter/protected-runtime";

// Every process here is synthetic. Pids are far above any live pid, and no
// test spawns or signals a process: a protected or task-owned target is only
// shown by the pure selector or by a sweep that never reaches a signal.

const UID = typeof process.getuid === "function" ? process.getuid() : 0;
const GRACE_MS = 80;

function proc(
  pid: number,
  overrides: Partial<HostProcessFact> & Pick<HostProcessFact, "cwd">,
): HostProcessFact {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    uid: UID,
    startIdentity: `${pid}@2026-01-01T00:00:00Z`,
    command: "sleep 60",
    ...overrides,
  };
}

async function fixtureRoot(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "nsq-runtime-protection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "task");
  await mkdir(worktree);
  return { root, worktree };
}

test("the adapter marks the daemon, its descendants and its process group, and nothing else", () => {
  const daemon = proc(4100001, {
    cwd: "/",
    command: "paseod --port 6767",
  });
  const agent = proc(4100002, {
    cwd: "/task/worktree",
    command: "node provider.mjs",
    ppid: 4100001,
  });
  const groupMate = proc(4100003, {
    cwd: "/",
    command: "sh -c supervise",
    pgid: 4100001,
  });
  const unrelated = proc(4100004, {
    cwd: "/task/worktree",
    command: "sleep 60",
  });
  const input = [daemon, agent, groupMate, unrelated];
  const marked = markPaseoRuntime(input, 4100001);

  const flagged = marked
    .filter((fact) => fact.protectedRuntime)
    .map((fact) => fact.pid)
    .sort((a, b) => a - b);
  assert.deepEqual(flagged, [4100001, 4100002, 4100003]);
  assert.equal(
    marked.find((fact) => fact.pid === 4100004)?.protectedRuntime,
    undefined,
  );
  // The adapter returns new facts; the table it was given is not mutated.
  assert.equal(daemon.protectedRuntime, undefined);
});

test("a pid the daemon file names is protected whatever process now holds it", async (t) => {
  const { worktree } = await fixtureRoot(t);
  // The pid file's pid has been reused by a task command in the worktree. The
  // table cannot prove it is the daemon, so the reading stays conservative: it
  // is protected, reported as skipped, and never signalled.
  const reused = proc(4100010, {
    cwd: worktree,
    command: "sleep 60",
  });
  const processes = markPaseoRuntime([reused], 4100010);
  const probed: number[] = [];
  const result = await reapHostProcesses({
    directory: worktree,
    graceMs: GRACE_MS,
    processes,
    identityLiveness: (pid) => {
      probed.push(pid);
      return "alive";
    },
  });
  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.unavailable, null);
  assert.deepEqual(
    result.skippedProtected.map((target) => target.pid),
    [4100010],
  );
  assert.equal(probed.includes(4100010), false);
});

test("an unmarked task process in the worktree is selected, and core never recognises Paseo by name", () => {
  const worktree = "/synthetic/task-worktree";
  const taskOwned = proc(4100020, {
    cwd: worktree,
    command: "node build.mjs",
  });
  // Core sees a Paseo-named process and no adapter mark, so it is task-owned
  // like any other process in the worktree.
  const namedButUnmarked = proc(4100021, {
    cwd: worktree,
    command: "/Applications/Paseo.app/Contents/MacOS/Paseo",
  });
  const marked = proc(4100022, {
    cwd: worktree,
    command: "node provider.mjs",
    protectedRuntime: true,
  });
  const selected = selectHostProcessTargets({
    processes: [taskOwned, namedButUnmarked, marked],
    worktree,
    recordedGroups: [],
    protectedPids: new Set(),
    queuePgid: -1,
  })
    .map((target) => target.pid)
    .sort((a, b) => a - b);
  assert.deepEqual(selected, [4100020, 4100021]);
});

test("a member of the daemon's process group is protected even inside the worktree", () => {
  const worktree = "/synthetic/task-worktree";
  const daemon = proc(4100030, {
    cwd: "/",
    command: "paseod",
  });
  const sharedGroup = proc(4100031, {
    cwd: worktree,
    command: "node helper.mjs",
    pgid: 4100030,
  });
  const processes = markPaseoRuntime([daemon, sharedGroup], 4100030);
  const selected = selectHostProcessTargets({
    processes,
    worktree,
    recordedGroups: [{ pgid: 4100030, startIdentity: null }],
    protectedPids: new Set(),
    queuePgid: -1,
  });
  assert.deepEqual(selected, []);
});

test("the pid file is read as present, absent or ambiguous", async (t) => {
  const { root } = await fixtureRoot(t);
  const present = join(root, "paseo.pid");
  await writeFile(present, "4100040\n");
  assert.deepEqual(readPaseoDaemonPid(present), { state: "pid", pid: 4100040 });

  // Missing: no daemon was recorded, which is not ambiguous.
  assert.deepEqual(readPaseoDaemonPid(join(root, "absent.pid")), {
    state: "absent",
  });

  // Present but not one pid, or unreadable: ambiguous, never an empty answer.
  const garbled = join(root, "garbled.pid");
  await writeFile(garbled, "not-a-pid\n");
  assert.equal(readPaseoDaemonPid(garbled).state, "unreadable");
  const directory = join(root, "pid-is-a-directory");
  await mkdir(directory);
  assert.equal(readPaseoDaemonPid(directory).state, "unreadable");
});

test("an ambiguous pid file fences the listing, so nothing is stopped", async (t) => {
  const { root, worktree } = await fixtureRoot(t);
  const garbled = join(root, "garbled.pid");
  await writeFile(garbled, "4100050 4100051\n");
  const processes = [
    proc(4100050, { cwd: worktree, command: "node agent.mjs" }),
  ];
  const listing = paseoRuntimeListing(
    processes,
    readPaseoDaemonPid(garbled),
  );
  assert.equal(listing, null);

  const probed: number[] = [];
  const result = await reapHostProcesses({
    directory: worktree,
    graceMs: GRACE_MS,
    processes: listing,
    identityLiveness: (pid) => {
      probed.push(pid);
      return "alive";
    },
  });
  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.unavailable?.read, "process-listing");
  assert.deepEqual(probed, []);
});

test("an absent pid file still protects a Paseo-named process by its command", () => {
  const worktree = "/synthetic/task-worktree";
  const processes = [
    proc(4100060, { cwd: worktree, command: "paseo-supervisor" }),
    proc(4100061, { cwd: worktree, command: "node build.mjs" }),
  ];
  const listing = paseoRuntimeListing(processes, { state: "absent" });
  assert.ok(listing);
  assert.equal(
    listing.find((fact) => fact.pid === 4100060)?.protectedRuntime,
    true,
  );
  assert.equal(
    listing.find((fact) => fact.pid === 4100061)?.protectedRuntime,
    undefined,
  );
});

test("a sweep without an adapter listing proves nothing and never reads the table itself", async (t) => {
  const { worktree } = await fixtureRoot(t);
  const result = await reapHostProcesses({
    directory: worktree,
    graceMs: GRACE_MS,
  });
  assert.deepEqual(result.terminated, []);
  assert.deepEqual(result.skippedProtected, []);
  assert.equal(result.unavailable?.read, "process-listing");
  assert.match(result.unavailable?.reason ?? "", /adapter/);
});
