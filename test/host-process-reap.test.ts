import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { submissionSchema, type Task } from "../shared/contracts";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { pidAlive } from "../service/transport/identity";
import { hostRunProcessStartIdentity, startIdentityMatches } from "../core/machine/start-identity";
import {
  HOST_PROCESS_SWEEP_KIND, HOST_PROCESS_SWEEP_SETTLED_KIND,
  HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND,
  formatHostProcessSweepEvent, hostProcessSweepIntent,
  listHostUidProcesses, ownedToolAgentProcessTreeVerdict, ownedToolProcessTreeVerdict, reapHostProcesses, selectHostProcessTargets, sweepTaskHostProcesses, terminateHostProcessTargets,
  type HostProcessFact, type HostProcessTarget,
} from "../core/machine/host-process-reap";
import type { Engine } from "../core/engine";

const GRACE_MS = 80;

test('owned tool process tree is settled only when the run helper is unique and has no other descendants', () => {
  const base = [
    { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'claude --mcp-config {"command":"node","args":["/p/mcp-report.mjs","/tickets/mcp-run-1.json"]}', cwd: null },
    { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-run-1.json', cwd: null },
  ] satisfies HostProcessFact[];
  assert.deepEqual(ownedToolProcessTreeVerdict('run-1', base), { state: 'empty', providerPid: 100, helperPid: 101 });
  assert.deepEqual(ownedToolProcessTreeVerdict('run-1', [...base,
    { pid: 102, ppid: 100, pgid: 100, uid: 501, startIdentity: '102@a', command: 'bash', cwd: null },
  ]), { state: 'live', providerPid: 100, helperPid: 101, pid: 102 });
  assert.equal(ownedToolProcessTreeVerdict('run-1', null).state, 'unknown');
  assert.equal(ownedToolProcessTreeVerdict('run-1', base.slice(0, 1)).state, 'unknown');
  assert.equal(ownedToolProcessTreeVerdict('run-1', [...base, { ...base[1]!, pid: 103 }]).state, 'unknown');
});

test('a finished-turn provider keeps only its own standing tool runtimes outside the proof', async () => {
  // The live shape (project-e#280, run 6fcf6a09): codex app-server 100 keeps
  // node_repl 102 warm, which keeps its kernel 103 warm, and none of them is
  // work once the agent's own observation proves no turn is live. 104 is a
  // command the kernel spawned, which is real work and still holds.
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-runtime-"));
  try {
    // A real install: `local/bin/codex` is a symlink to the provider's own
    // release directory, which also ships its code-mode tool host.
    const release = join(root, "release", "bin"), local = join(root, "local", "bin");
    await mkdir(release, { recursive: true }); await mkdir(local, { recursive: true });
    writeFileSync(join(release, "codex"), ""); writeFileSync(join(release, "codex-code-mode-host"), "");
    symlinkSync(join(release, "codex"), join(local, "codex"));
    const codex = join(local, "codex"), codeMode = join(release, "codex-code-mode-host");
    writeFileSync(join(release, "node"), "");
    const cua = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin";
    const nodeRepl = `${cua}/node_repl`;
    const scratch = join(root, ".tmpDXkgFc");
    const kernel = `${cua}/node --experimental-vm-modules ${join(scratch, "kernel.js")} --session-id 9066e962fb30417e9ac3099f52fbc16e --working-dir /work/task`;
    const tree: HostProcessFact[] = [
      { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: `${codex} app-server --enable goals`, cwd: null },
      { pid: 101, ppid: 100, pgid: 101, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-run-1.json report', cwd: null },
      { pid: 102, ppid: 100, pgid: 102, uid: 501, startIdentity: '102@a', command: nodeRepl, cwd: null },
      { pid: 103, ppid: 102, pgid: 102, uid: 501, startIdentity: '103@a', command: kernel, cwd: null },
      { pid: 105, ppid: 100, pgid: 105, uid: 501, startIdentity: '105@a', command: codeMode, cwd: null },
      // The host's other provider-written runtime script and its nested provider server.
      { pid: 107, ppid: 102, pgid: 102, uid: 501, startIdentity: '107@a', command: `${cua}/node ${join(scratch, "trusted-worker.js")} /work/task`, cwd: null },
      { pid: 108, ppid: 102, pgid: 102, uid: 501, startIdentity: '108@a', command: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://', cwd: null },
    ];
    // Without the turn proof, every descendant is still a possible command.
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', tree), { state: 'live', providerPid: 100, helperPid: 101, pid: 102 });
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', tree, { noTurnLive: true }), { state: 'empty', providerPid: 100, helperPid: 101 });
    // A command under the kernel is real work, whatever turn proof holds.
    const working = [...tree, { pid: 104, ppid: 103, pgid: 102, uid: 501, startIdentity: '104@a', command: "bash -lc 'effigy qa'", cwd: null }];
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', working, { noTurnLive: true }), { state: 'live', providerPid: 100, helperPid: 101, pid: 104 });
    // A program outside the provider's own installation is a command, and an
    // unreadable command is never infrastructure.
    const command = { pid: 106, ppid: 100, pgid: 106, uid: 501, startIdentity: '106@a', command: '/usr/bin/node /work/task/build.mjs', cwd: null };
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', [...tree, command], { noTurnLive: true }), { state: 'live', providerPid: 100, helperPid: 101, pid: 106 });
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', [...tree, { ...command, command: '' }], { noTurnLive: true }), { state: 'live', providerPid: 100, helperPid: 101, pid: 106 });
    // Shipping location alone is not enough: a host program from the provider's
    // own install directory, a bundled application, and a bundled interpreter
    // running a workspace script are all commands.
    for (const held of [
      { pid: 109, ppid: 100, pgid: 109, uid: 501, startIdentity: '109@a', command: `${release}/node /work/task/build.mjs`, cwd: null },
      { pid: 110, ppid: 100, pgid: 110, uid: 501, startIdentity: '110@a', command: '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --dump-dom http://127.0.0.1:3000', cwd: null },
      { pid: 111, ppid: 103, pgid: 102, uid: 501, startIdentity: '111@a', command: `${cua}/node /work/task/build.mjs`, cwd: null },
      { pid: 112, ppid: 100, pgid: 112, uid: 501, startIdentity: '112@a', command: `${release}/codex exec --json 'fix the failing test'`, cwd: null },
      // A script in the agent's own temporary directory is not provider scratch:
      // only a directory a provider-session-bound runtime claimed is.
      { pid: 113, ppid: 103, pgid: 102, uid: 501, startIdentity: '113@a', command: `${cua}/node ${join(root, ".tmpAgentWork", "build.js")}`, cwd: null },
      // A command's own arguments never make it a provider runtime: neither a
      // flag it passes on to its script, nor a session flag without an id.
      { pid: 116, ppid: 100, pgid: 116, uid: 501, startIdentity: '116@a', command: `${cua}/node /workspace/build.js --working-dir /workspace`, cwd: null },
      { pid: 117, ppid: 103, pgid: 102, uid: 501, startIdentity: '117@a', command: `${cua}/node /workspace/build.js --session-id build`, cwd: null },
      { pid: 118, ppid: 100, pgid: 118, uid: 501, startIdentity: '118@a', command: `${cua}/node /workspace/build.js --session-id=not-a-session`, cwd: null },
      // A whole session binding is still a command when no provider tool host
      // started it, and when a runtime did not start it.
      { pid: 119, ppid: 100, pgid: 119, uid: 501, startIdentity: '119@a', command: `${cua}/node /workspace/build.js --session-id 9066e962fb30417e9ac3099f52fbc16e --working-dir /workspace`, cwd: null },
      { pid: 120, ppid: 103, pgid: 102, uid: 501, startIdentity: '120@a', command: `${cua}/node /workspace/build.js --session-id 9066e962fb30417e9ac3099f52fbc16e --working-dir /workspace`, cwd: null },
    ]) assert.deepEqual(ownedToolProcessTreeVerdict('run-1', [...tree, held], { noTurnLive: true }),
      { state: 'live', providerPid: 100, helperPid: 101, pid: held.pid }, held.command);
    // A session-bound interpreter claims its scratch directory, so the provider's
    // own sibling runtime script there is the same family: the trusted worker at
    // pid 107 is exempt while the same interpreter outside that directory (113) holds.
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', [...tree, { pid: 115, ppid: 102, pgid: 102, uid: 501, startIdentity: '115@a',
      command: `${cua}/node ${join(scratch, "worker-runtime.js")}`, cwd: null }], { noTurnLive: true }),
      { state: 'empty', providerPid: 100, helperPid: 101 });
    // A script a runtime starts is a command even when it runs from the runtime's
    // own scratch directory: the kernel's own child keeps the fence.
    assert.deepEqual(ownedToolProcessTreeVerdict('run-1', [...tree, { pid: 121, ppid: 103, pgid: 102, uid: 501, startIdentity: '121@a',
      command: `${cua}/node ${join(scratch, "worker-runtime.js")}`, cwd: null }], { noTurnLive: true }),
      { state: 'live', providerPid: 100, helperPid: 101, pid: 121 });
    // An unreadable listing stays unreadable, and the agent-level proof follows the same rule.
    assert.equal(ownedToolProcessTreeVerdict('run-1', null, { noTurnLive: true }).state, 'unknown');
    assert.deepEqual(ownedToolAgentProcessTreeVerdict(['run-1'], tree, { noTurnLive: true }), { state: 'empty', runId: 'run-1', providerPid: 100, helperPid: 101 });
    assert.deepEqual(ownedToolAgentProcessTreeVerdict(['run-1'], working, { noTurnLive: true }), { state: 'live', runId: 'run-1', providerPid: 100, helperPid: 101, pid: 104 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owned tool process proof follows the newest helper among an agent runs', () => {
  const current = [
    { pid: 100, ppid: 1, pgid: 100, uid: 501, startIdentity: '100@a', command: 'claude', cwd: null },
    { pid: 101, ppid: 100, pgid: 100, uid: 501, startIdentity: '101@a', command: 'node /p/mcp-report.mjs /tickets/mcp-current-run.json', cwd: null },
  ];
  assert.deepEqual(ownedToolAgentProcessTreeVerdict(['current-run', 'superseded-run'], current), {
    state: 'empty', runId: 'current-run', providerPid: 100, helperPid: 101,
  });
  assert.deepEqual(ownedToolAgentProcessTreeVerdict(['current-run', 'superseded-run'], [
    ...current, { pid: 102, ppid: 100, pgid: 100, uid: 501, startIdentity: '102@a', command: 'editor-helper', cwd: null },
  ]), { state: 'live', runId: 'current-run', providerPid: 100, helperPid: 101, pid: 102 });
});

async function waitFor(probe: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function spawnSleeper(cwd: string, detached = false): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, stdio: "ignore", detached });
  if (detached) child.unref();
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  try { if (detachedGroup(child)) process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

function stopPid(pid: number | null): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** A pid that answers signals but is a zombie has already exited. */
function pidGone(pid: number): boolean {
  if (!pidAlive(pid)) return true;
  if (process.platform === "linux") {
    try { return /\([^)]*\)\s+Z\b/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
  }
  return false;
}

const START_IDENTITY_MODULE = new URL("../core/machine/start-identity.ts", import.meta.url).href;
/** Absolute tsx loader so a fixture launcher can import the contract module from a temp cwd. */
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

interface RecordedFixtureChild { pid: number; identity: string }

/**
 * Read a complete pid and start-identity record. Path existence is not this:
 * a truncated write parses as nothing, so callers wait for this return, never
 * `existsSync`.
 */
function recordedFixtureChild(path: string): RecordedFixtureChild | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; identity?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    return typeof parsed.identity === "string" && parsed.identity.length > 0
      ? { pid: parsed.pid, identity: parsed.identity } : null;
  } catch { return null; }
}

/** Publish a fixture pid record by writing beside the path then renaming over it. */
function publishFixtureChildRecord(path: string, record: RecordedFixtureChild): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
}

/** Wait until `path` holds a complete parseable pid and start-identity record. */
async function waitForRecordedFixtureChild(path: string, timeoutMs: number, label: string): Promise<RecordedFixtureChild> {
  let child: RecordedFixtureChild | null = null;
  await waitFor(() => {
    child = recordedFixtureChild(path);
    return child !== null;
  }, timeoutMs, label);
  if (!child) throw new Error(`timed out waiting for ${label}`);
  return child;
}

/**
 * Every detached fixture descendant this file observed, with the start identity
 * the launcher captured at spawn. The identity is written by the launcher once,
 * while the child is certainly alive, so cleanup never depends on when (or
 * whether) a test looked. Cleanup signals a pid only while `startIdentityMatches`
 * proves the live process; an unprovable or still-live pid is surfaced by the
 * file-level guard, never silently dropped.
 */
const observedFixtureChildren = new Map<number, string>();

function trackFixtureChild(child: RecordedFixtureChild | null): void {
  if (!child || observedFixtureChildren.has(child.pid)) return;
  observedFixtureChildren.set(child.pid, child.identity);
}

/** Identity proves ownership only when a captured basis still matches the live process. */
function fixtureChildIdentityProves(recorded: string | undefined, observed: string): boolean {
  return recorded !== undefined && startIdentityMatches(recorded, observed);
}

function fixtureChildAlive(pid: number): boolean {
  if (pidGone(pid)) return false;
  try { return fixtureChildIdentityProves(observedFixtureChildren.get(pid), hostRunProcessStartIdentity(pid)); } catch { return false; }
}

/**
 * Signal a recorded fixture descendant only while its captured start identity
 * still matches the live process. A pid with no recorded identity is a capture
 * gap: it is reported, never signalled, and the file-level guard fails while it
 * is still alive.
 */
function stopTrackedFixtureChild(pid: number | null): void {
  if (!pid) return;
  if (fixtureChildAlive(pid)) stopPid(pid);
  else if (!pidGone(pid) && !observedFixtureChildren.has(pid)) console.error(`host-process-reap fixture cleanup has no recorded start identity for pid ${pid}; leaving it alone`);
}

/**
 * Live children of one launcher that are fixture interval processes. Until the
 * launcher exits, the detached grandchild is still its own child, so ancestry is
 * direct evidence of ownership even while the launcher's identity read is slow
 * or failed.
 */
async function liveFixtureChildrenOf(pid: number): Promise<number[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  const facts = await listHostUidProcesses();
  if (!facts) return [];
  return facts.filter(fact => fact.ppid === pid && (fact.command ?? "").includes("setInterval(() => {}, 1000)")).map(fact => fact.pid);
}

/** True when a recorded child's identity still proves its live process. */
function fixtureChildProves(child: RecordedFixtureChild | null): boolean {
  if (!child) return false;
  try { return fixtureChildIdentityProves(child.identity, hostRunProcessStartIdentity(child.pid)); } catch { return false; }
}

/**
 * Stop the detached descendant a launcher recorded, then the launcher. The
 * pid file must be read before the test's `rm(root)` hook runs: test-level
 * `after` hooks run in registration order, so `rm(root)` is registered after
 * this cleanup and after every other hook that needs the fixture files.
 *
 * The launcher spawns the child before it can write the record, and the identity
 * read it needs can be slow. So while the launcher is alive this also finds a
 * still-unrecorded child by ancestry and captures its identity then, with the
 * pid recorded so the file-level guard accounts for it either way.
 */
async function stopLaunchedFixture(childPidPath: string, launcher: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let child = recordedFixtureChild(childPidPath);
  trackFixtureChild(child);
  let nextLineageScan = 0;
  while (launcher.exitCode === null && !launcher.killed && Date.now() < deadline) {
    if (child && (pidGone(child.pid) || fixtureChildProves(child))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
    const recorded = recordedFixtureChild(childPidPath);
    trackFixtureChild(recorded);
    if (fixtureChildProves(recorded)) { child = recorded; break; }
    if (!launcher.pid || Date.now() < nextLineageScan) continue;
    nextLineageScan = Date.now() + 250;
    const pid = (await liveFixtureChildrenOf(launcher.pid))[0];
    if (pid === undefined) continue;
    try {
      child = { pid, identity: hostRunProcessStartIdentity(pid) };
      trackFixtureChild(child);
    } catch { /* already gone */ }
  }
  for (const pid of [...observedFixtureChildren.keys()]) stopTrackedFixtureChild(pid);
  await stopChild(launcher);
}

after(async () => {
  for (const pid of observedFixtureChildren.keys()) stopTrackedFixtureChild(pid);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && [...observedFixtureChildren.keys()].some(pid => !pidGone(pid))) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const survivors = [...observedFixtureChildren.keys()].filter(pid => !pidGone(pid));
  assert.equal(survivors.length, 0,
    `host-process-reap fixture descendants survived or could not be proven dead: ${survivors.map(pid => `${pid} (${fixtureChildAlive(pid) ? "matches" : "unproven"})`).join(", ")}`);
});

test("a launcher records a child start identity that proves the live process", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-recorded-"));
  const worktree = join(root, "task");
  await mkdir(worktree);
  const childPidPath = join(root, "recorded.pid");
  const launcher = spawnOrphanSleeper(worktree, childPidPath);
  t.after(async () => { await stopLaunchedFixture(childPidPath, launcher); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const child = await waitForRecordedFixtureChild(childPidPath, 10_000, "recorded fixture start");
  assert.ok(child, "the launcher recorded the child pid and start identity");
  trackFixtureChild(child);
  assert.equal(pidAlive(child.pid), true, "the recorded child is alive");
  assert.equal(fixtureChildIdentityProves(child.identity, hostRunProcessStartIdentity(child.pid)), true, "the recorded identity proves the live process");
});

test("teardown stops a child it can only prove by ancestry", async t => {
  // The launcher spawns the child before the identity read that lets it write a
  // record, and that read can outlast a short teardown wait. Cleanup must still
  // account for the child, which is its own process until the launcher exits.
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-lineage-"));
  const worktree = join(root, "task");
  await mkdir(worktree);
  const realPidPath = join(root, "real.pid");
  const missingPidPath = join(root, "missing.pid");
  const daemon = spawnFakePaseoDaemonWithDetachedAgent(worktree, realPidPath);
  t.after(async () => { await stopLaunchedFixture(realPidPath, daemon); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const child = await waitForRecordedFixtureChild(realPidPath, 10_000, "lineage fixture start");
  assert.ok(child);
  // The child must be absent from the registry when cleanup begins, so only the
  // live launcher's ancestry can discover it; cleanup is handed a pid file that
  // does not exist.
  observedFixtureChildren.delete(child.pid);
  assert.equal(observedFixtureChildren.has(child.pid), false, "the child is not pre-registered");
  await stopLaunchedFixture(missingPidPath, daemon);
  const recordedIdentity = observedFixtureChildren.get(child.pid);
  assert.ok(recordedIdentity, "cleanup recorded the ancestry-discovered child");
  assert.equal(fixtureChildIdentityProves(recordedIdentity, child.identity), true, "the recorded identity proves the live child");
  await waitFor(() => pidGone(child.pid), 5_000, "lineage child exit");
  assert.equal(pidGone(child.pid), true, "teardown stopped the child it could only prove by ancestry");
});

test("a fixture child is signalled only while its captured start identity still matches", () => {
  // Review 5434142186: teardown must not overwrite the observed identity or
  // signal a pid it cannot prove, or a recycled number could kill an unrelated
  // process.
  assert.equal(fixtureChildIdentityProves("123@2026-01-01T00:00:00Z", "123@2026-01-01T00:00:00Z"), true);
  assert.equal(fixtureChildIdentityProves("123@2026-01-01T00:00:00Z", "123@2026-01-01T00:00:05Z"), false, "a recycled pid never matches");
  assert.equal(fixtureChildIdentityProves("123@unknown", "123@unknown"), false, "an unknown basis proves nothing");
  assert.equal(fixtureChildIdentityProves(undefined, "123@2026-01-01T00:00:00Z"), false, "an unobserved pid is a capture gap");
});

test("a pid-record path existing is not a complete start-identity record", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "recorded.pid");
  writeFileSync(path, '{"pid":4242,"identity":');
  assert.equal(existsSync(path), true, "the truncated file is already visible");
  assert.equal(recordedFixtureChild(path), null, "existsSync is not a parseable pid and start identity");
  writeFileSync(path, JSON.stringify({ pid: 4242 }));
  assert.equal(recordedFixtureChild(path), null, "a pid without a start identity is not ownership");
  writeFileSync(path, JSON.stringify({ pid: 0, identity: "0@2026-01-01T00:00:00Z" }));
  assert.equal(recordedFixtureChild(path), null, "a non-positive pid is not ownership");
});

test("readiness waits for an atomic complete pid and start-identity publication", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-late-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "recorded.pid");
  writeFileSync(path, '{"pid":');
  assert.equal(recordedFixtureChild(path), null);
  const pending = waitForRecordedFixtureChild(path, 2_000, "late complete publication");
  publishFixtureChildRecord(path, { pid: 4242, identity: "4242@2026-01-01T00:00:00Z" });
  const child = await pending;
  assert.equal(child.pid, 4242);
  assert.equal(child.identity, "4242@2026-01-01T00:00:00Z");
  assert.equal(recordedFixtureChild(path)?.pid, 4242);
});

/**
 * A launcher records the grandchild's pid and the start identity the contract
 * module derives for it, at spawn, so cleanup can prove the same process on
 * every path — including a test that failed or was cancelled before it looked.
 */
function writeLauncherScript(path: string, keepAlive: boolean): void {
  const source = [
    'import { spawn } from "node:child_process";',
    'import { renameSync, writeFileSync } from "node:fs";',
    `import { hostRunProcessStartIdentity, startIdentityMatches } from ${JSON.stringify(START_IDENTITY_MODULE)};`,
    'const pidPath = process.argv[2];',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });',
    'child.unref();',
    'const startedAt = Date.now();',
    'let identity = hostRunProcessStartIdentity(child.pid);',
    'while (!startIdentityMatches(identity, identity) && Date.now() - startedAt < 4_000) {',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    '  identity = hostRunProcessStartIdentity(child.pid);',
    '}',
    'const tmp = `${pidPath}.${process.pid}.tmp`;',
    'writeFileSync(tmp, JSON.stringify({ pid: child.pid, identity }));',
    'renameSync(tmp, pidPath);',
    ...(keepAlive ? ['setInterval(() => {}, 1000);'] : []),
  ].join("\n");
  writeFileSync(path, source, { mode: 0o600 });
}

function spawnFixtureLauncher(cwd: string, childPidPath: string, keepAlive: boolean, detached: boolean): ChildProcess {
  const launcherPath = join(dirname(childPidPath), keepAlive ? "fake-paseo-daemon.mjs" : "orphan-sleeper.mjs");
  writeLauncherScript(launcherPath, keepAlive);
  return spawn(process.execPath, ["--import", TSX_LOADER, launcherPath, childPidPath], { cwd, stdio: "ignore", detached });
}

function spawnFakePaseoDaemonWithDetachedAgent(cwd: string, childPidPath: string): ChildProcess {
  return spawnFixtureLauncher(cwd, childPidPath, true, true);
}

function spawnOrphanSleeper(cwd: string, childPidPath: string): ChildProcess {
  return spawnFixtureLauncher(cwd, childPidPath, false, false);
}

async function waitForProcessFact(pid: number, predicate: (fact: HostProcessFact) => boolean, timeoutMs: number, label: string): Promise<void> {
  await waitFor(async () => {
    const fact = (await listHostUidProcesses())?.find(entry => entry.pid === pid);
    return Boolean(fact && predicate(fact));
  }, timeoutMs, label);
}

function detachedGroup(child: ChildProcess): boolean {
  return Boolean((child as ChildProcess & { pid?: number }).pid);
}

function fact(overrides: Partial<HostProcessFact> & Pick<HostProcessFact, "pid" | "cwd">): HostProcessFact {
  return {
    pgid: overrides.pgid ?? overrides.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    startIdentity: overrides.startIdentity ?? `${overrides.pid}@2026-01-01T00:00:00Z`,
    command: overrides.command ?? "sleep 60",
    ...overrides,
  };
}

test("selectHostProcessTargets keeps worktree cwd and recorded pgids, and skips Queue, Paseo and outsiders", () => {
  const worktree = "/tmp/ns-reap-worktree";
  const queue = fact({ pid: process.pid, cwd: worktree, command: "node bin/queue-service.mjs" });
  const inside = fact({ pid: 71001, cwd: worktree, command: "sh -c while true" });
  const nested = fact({ pid: 71002, cwd: `${worktree}/src`, command: "node test/service.test.ts" });
  const outsider = fact({ pid: 71003, cwd: "/tmp/other-task", command: "sleep 60" });
  const sibling = fact({ pid: 71004, cwd: `${worktree}-other`, command: "sleep 60" });
  const grouped = fact({ pid: 71005, pgid: 88001, cwd: "/tmp/unrelated", command: "node leftover.mjs" });
  const paseo = fact({ pid: 71006, cwd: worktree, command: "/Applications/Paseo.app/Contents/MacOS/Paseo" });
  const staleGroup = fact({ pid: 71007, pgid: 88002, cwd: "/tmp/other-run", command: "node other-task.mjs" });
  const selected = selectHostProcessTargets({
    processes: [queue, inside, nested, outsider, sibling, grouped, paseo, staleGroup],
    worktree,
    recordedGroups: [
      { pgid: 88001, startIdentity: grouped.startIdentity },
      { pgid: 88002, startIdentity: "stale-identity-token-0001" },
    ],
    protectedPids: new Set([process.pid]),
    queuePgid: process.pid,
  });
  assert.deepEqual(selected.map(target => target.pid).sort((a, b) => a - b), [71001, 71002, 71005]);
  assert.equal(selected.find(target => target.pid === 71005)?.via, "pgid");
  assert.equal(selected.find(target => target.pid === 71001)?.via, "cwd");
  assert.equal(selected.find(target => target.pid === 71007), undefined);
});

test("a recycled pid is never signalled", async () => {
  const target: HostProcessTarget = {
    pid: 2_000_000_001, pgid: 2_000_000_001, startIdentity: "2000000001@2020-01-01T00:00:00Z",
    startTime: "2020-01-01T00:00:00Z", cwd: "/tmp/ns-reap", command: "sleep 60", via: "cwd",
  };
  const result = await terminateHostProcessTargets([target], {
    graceMs: GRACE_MS,
    identityLiveness: () => "dead",
  });
  assert.equal(result.terminated.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!.reason, /start identity changed/);
});

test("a fixture whose cwd is the temp worktree is terminated and recorded", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-cwd-"));
  const worktree = join(root, "task");
  await mkdir(worktree);
  const childPidPath = join(root, "leftover.pid");
  const launcher = spawnOrphanSleeper(worktree, childPidPath);
  t.after(async () => { await stopLaunchedFixture(childPidPath, launcher); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const child = await waitForRecordedFixtureChild(childPidPath, 10_000, "cwd fixture start");
  trackFixtureChild(child);
  assert.ok(child);
  const childPid = child.pid;
  await waitFor(() => pidAlive(childPid), 2_000, "cwd fixture alive");
  const storeDir = await mkdtemp(join(tmpdir(), "nsq-reap-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, "queue.sqlite"));
  t.after(() => store.close());
  const task = insertTerminal(store, worktree, "done");
  const result = await sweepTaskHostProcesses(store, task, { graceMs: GRACE_MS });
  await waitFor(() => !pidAlive(childPid), 2_000, "cwd fixture exit");
  assert.ok(result.terminated.some(target => target.pid === childPid), formatHostProcessSweepEvent(result));
  const event = store.events(task.id).find(row => row.kind === HOST_PROCESS_SWEEP_KIND);
  assert.ok(event);
  assert.match(event.detail, new RegExp(`pid=${childPid}`));
  assert.match(event.detail, /command=/);
  assert.equal(store.task(task.id).resolution.hostProcessSweep, null);
});

test("a resumed agent child of the Paseo daemon survives and is logged once", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-paseo-agent-"));
  const worktree = join(root, "task");
  await mkdir(worktree);
  const childPidPath = join(root, "agent.pid");
  const daemon = spawnFakePaseoDaemonWithDetachedAgent(worktree, childPidPath);
  t.after(async () => { await stopLaunchedFixture(childPidPath, daemon); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.ok(daemon.pid);
  const agent = await waitForRecordedFixtureChild(childPidPath, 10_000, "fake Paseo agent child start");
  trackFixtureChild(agent);
  assert.ok(agent);
  const agentPid = agent.pid;
  await waitFor(() => pidAlive(agentPid), 2_000, "fake Paseo agent alive");
  await waitForProcessFact(agentPid, fact => fact.ppid === daemon.pid, 10_000, "agent ancestry discovery");

  const storeDir = await mkdtemp(join(tmpdir(), "nsq-reap-paseo-agent-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, "queue.sqlite"));
  t.after(() => store.close());
  const task = insertTerminal(store, worktree, "done");
  const options = { graceMs: GRACE_MS, paseoDaemonPid: daemon.pid };
  const result = await sweepTaskHostProcesses(store, task, options);
  assert.equal(pidAlive(agentPid), true);
  assert.ok(result.skippedPaseo.some(target => target.pid === agentPid));
  assert.equal(result.failed.length, 0);
  await sweepTaskHostProcesses(store, task, options);
  const skippedEvents = store.eventsAll(task.id).filter(event => event.kind === HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND);
  assert.equal(skippedEvents.length, 1);
  assert.match(skippedEvents[0]!.detail, new RegExp(`pid=${agentPid}`));
  assert.equal(skippedEvents[0]!.kind, HOST_PROCESS_SWEEP_PASEO_SKIPPED_KIND);
});

test("an orphaned worktree keepalive is terminated", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-orphan-"));
  const worktree = join(root, "task");
  await mkdir(worktree);
  const childPidPath = join(root, "orphan.pid");
  const launcher = spawnOrphanSleeper(worktree, childPidPath);
  t.after(async () => { await stopLaunchedFixture(childPidPath, launcher); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const orphan = await waitForRecordedFixtureChild(childPidPath, 10_000, "orphan keepalive start");
  trackFixtureChild(orphan);
  assert.ok(orphan);
  const orphanPid = orphan.pid;
  await waitFor(() => pidAlive(orphanPid), 2_000, "orphan keepalive alive");
  await waitForProcessFact(orphanPid, fact => fact.ppid === 1, 10_000, "keepalive reparenting");

  const result = await reapHostProcesses({ directory: worktree, graceMs: GRACE_MS, paseoDaemonPid: null });
  await waitFor(() => !pidAlive(orphanPid), 2_000, "orphan keepalive exit");
  assert.ok(result.terminated.some(target => target.pid === orphanPid));
});

test("a recorded hook group equal to the Paseo daemon group is never group-signalled", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-paseo-group-"));
  const daemon = spawnSleeper(root, true);
  t.after(() => stopChild(daemon));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.ok(daemon.pid);
  await waitFor(() => pidAlive(daemon.pid!), 2_000, "fake Paseo daemon start");
  const result = await reapHostProcesses({
    directory: null,
    graceMs: GRACE_MS,
    paseoDaemonPid: daemon.pid,
    recordedGroups: [{ pgid: daemon.pid!, startIdentity: hostRunProcessStartIdentity(daemon.pid!) }],
  });
  assert.equal(pidAlive(daemon.pid!), true);
  assert.equal(result.terminated.some(target => target.pid === daemon.pid), false);
});

test("a detached child in a recorded pgid is terminated even outside the worktree", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-pgid-"));
  const worktree = join(root, "task");
  const outside = join(root, "outside");
  await mkdir(worktree);
  await mkdir(outside);
  const childPidPath = join(root, "leftover.pid");
  const launcher = spawnOrphanSleeper(outside, childPidPath);
  t.after(async () => { await stopLaunchedFixture(childPidPath, launcher); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const child = await waitForRecordedFixtureChild(childPidPath, 10_000, "detached fixture start");
  trackFixtureChild(child);
  assert.ok(child);
  const childPid = child.pid;
  await waitFor(() => pidAlive(childPid), 2_000, "detached fixture alive");
  await waitForProcessFact(childPid, fact => fact.ppid === 1, 10_000, "detached fixture reparenting");
  const storeDir = await mkdtemp(join(tmpdir(), "nsq-reap-pgid-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, "queue.sqlite"));
  t.after(() => store.close());
  const task = insertTerminal(store, worktree, "cancelled");
  const result = await sweepTaskHostProcesses(store, task, {
    graceMs: GRACE_MS,
    recordedGroups: [{ pgid: childPid, startIdentity: hostRunProcessStartIdentity(childPid) }],
  });
  await waitFor(() => !pidAlive(childPid), 2_000, "detached fixture exit");
  assert.ok(result.terminated.some(target => target.pid === childPid), formatHostProcessSweepEvent(result));
  assert.ok(store.events(task.id).some(event => event.kind === HOST_PROCESS_SWEEP_KIND && event.detail.includes(`pid=${childPid}`)));
});

test("a process outside the worktree is left running", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-out-"));
  const worktree = join(root, "task");
  const outside = join(root, "outside");
  await mkdir(worktree);
  await mkdir(outside);
  const child = spawnSleeper(outside);
  t.after(() => stopChild(child));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.ok(child.pid);
  await waitFor(() => pidAlive(child.pid!), 2_000, "outsider start");
  const storeDir = await mkdtemp(join(tmpdir(), "nsq-reap-out-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, "queue.sqlite"));
  t.after(() => store.close());
  const task = insertTerminal(store, worktree, "done");
  const result = await sweepTaskHostProcesses(store, task, { graceMs: GRACE_MS });
  assert.equal(pidAlive(child.pid!), true);
  assert.equal(result.terminated.some(target => target.pid === child.pid), false);
});

test("the Queue service pid is never selected even when its cwd is the worktree", () => {
  const worktree = "/tmp/ns-reap-queue";
  const selected = selectHostProcessTargets({
    processes: [fact({ pid: process.pid, pgid: process.pid, cwd: worktree, command: "node bin/queue-service.mjs" })],
    worktree,
    recordedGroups: [{ pgid: process.pid, startIdentity: `${process.pid}@2026-01-01T00:00:00Z` }],
    protectedPids: new Set([process.pid]),
    queuePgid: process.pid,
  });
  assert.equal(selected.length, 0);
});

test("a recycled recorded pgid is never signalled", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-stale-pgid-"));
  const outside = join(root, "outside");
  await mkdir(outside);
  const child = spawnSleeper(outside, true);
  t.after(() => stopChild(child));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.ok(child.pid);
  await waitFor(() => pidAlive(child.pid!), 2_000, "stale-pgid fixture start");
  const result = await reapHostProcesses({
    directory: null,
    graceMs: GRACE_MS,
    recordedGroups: [{ pgid: child.pid!, startIdentity: "stale-identity-token-0001" }],
  });
  assert.equal(pidAlive(child.pid!), true);
  assert.equal(result.terminated.some(target => target.pid === child.pid), false);
  assert.equal(result.failed.some(target => target.pid === child.pid), false);
});



test("a durable intent recovers a cancelled sweep a crash left unrun", async t => {
  const root = await mkdtemp(join(tmpdir(), "nsq-reap-recover-"));
  const worktree = join(root, "task");
  await mkdir(worktree);
  const childPidPath = join(root, "leftover.pid");
  const launcher = spawnOrphanSleeper(worktree, childPidPath);
  t.after(async () => { await stopLaunchedFixture(childPidPath, launcher); });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const child = await waitForRecordedFixtureChild(childPidPath, 10_000, "recovery fixture start");
  trackFixtureChild(child);
  assert.ok(child);
  const childPid = child.pid;
  await waitFor(() => pidAlive(childPid), 2_000, "recovery fixture alive");
  const storeDir = await mkdtemp(join(tmpdir(), "nsq-reap-recover-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const store = new Store(join(storeDir, "queue.sqlite"));
  t.after(() => store.close());
  const task = insertTerminal(store, worktree, "cancelled");
  const engine = {
    store, stopped: false, paused: () => false,
    // #912: lifecycle runs each host-scoped effect through the engine host context.
    withHost: (_id: string, fn: () => unknown) => fn(), taskHostAvailable: () => true,
    hooks: { finished: async () => ({ hold: false, attention: false, records: [] }) },
    adapter: {},
    retirement: { capture: async () => null, markArchived: (current: Task) => current.resolution.runtimeRetirements, archived: async () => {}, hasScope: () => false, flagArchiveFailure: () => {} },
    resolution: { update: (current: Task, changes: Record<string, unknown>, _patch: Record<string, unknown>, kind: string, detail: string) => store.update(current.id, { resolution: { ...store.task(current.id).resolution, ...changes } as Task["resolution"] }, kind, detail) },
    removeSiblings: async () => {},
  };
  await new Lifecycle(engine as unknown as Engine).enqueuePass();
  await waitFor(() => !pidAlive(childPid), 2_000, "recovery fixture exit");
  assert.ok(store.events(task.id).some(event => event.kind === HOST_PROCESS_SWEEP_KIND && event.detail.includes(`pid=${childPid}`)));
  assert.equal(store.task(task.id).resolution.hostProcessSweep, null);
  assert.ok(store.events(task.id).some(event => event.kind === HOST_PROCESS_SWEEP_SETTLED_KIND));
});

function insertTerminal(store: Store, directory: string, phase: "done" | "cancelled"): Task {
  store.setMeta("paused", false);
  const base = "a".repeat(40);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Host process sweep", repoPath: directory,
    planningCommit: base, handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", base);
  return store.update(inserted.id, {
    phase, directory, workspaceId: `ws-${inserted.id}`,
    resolution: { ...store.task(inserted.id).resolution, hostProcessSweep: hostProcessSweepIntent(phase) },
  });
}


test("macOS host discovery keeps the event loop responsive while ps/lsof run", { skip: process.platform !== "darwin" }, async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  try {
    const facts = await listHostUidProcesses();
    assert.equal(ticked, true, "OS discovery must not block a queued timer");
    assert.ok(facts?.some(fact => fact.pid === process.pid), "current process is retained in discovery");
  } finally { clearTimeout(timer); }
});
