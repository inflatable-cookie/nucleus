import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { sweepSettledRunProcesses, processBelongsToRun } from "../core/machine/run-process-cleanup";
import { processParentPid } from "../core/machine/process-identity";
import { pidAlive } from "../core/machine/pid";
import { readHostUidProcesses } from "../core/machine/host-process-listing";
import { runProcessEnvironments } from "../core/machine/run-process-identity";
import { protectedRunInfrastructure } from "../core/machine/run-process-hosts";
import { runInfrastructurePids } from "../core/machine/owned-tool-process-proof";
import { checkoutRunScratchPlacement, removeRecordedRunScratchDirectory, runTemporaryEnvironment } from "../core/workspaces/run-scratch";
import { submissionSchema, type Run } from "../shared/contracts";

const base = "b".repeat(40);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "run-process-")));
  const mount = join(root, "volume"); mkdirSync(mount);
  const observe = () => ({ MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true });
  const placement = checkoutRunScratchPlacement({ mount, uuid: "fixture", observe });
  const store = new Store(join(root, "queue.sqlite"));
  (store as unknown as { runScratchRemover: (directory: string) => boolean }).runScratchRemover = directory => removeRecordedRunScratchDirectory(directory, { mount, uuid: "fixture", observe });
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Run process fixture", repoPath: join(root, "repo"), planningCommit: base, handoffPath: "docs/handoff.md", originAgentId: "origin" }), "fixture-host", "handoff", base);
  const pids: number[] = [];
  function run(role: Run["role"] = "reviewer") {
    const id = randomUUID();
    const temporaryDirectory = runTemporaryEnvironment(id, placement).TMPDIR;
    const record: Run = { id, taskId: task.id, role, generation: 1, head: base, base, agentId: `agent-${id}`, workspaceId: "workspace",
      profile: { id: "fixture", name: "Fixture", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] },
      status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, temporaryDirectory };
    store.putRun(record);
    return record;
  }
  function anchor(record: Run) {
    const helper = join(root, "mcp-report.mjs");
    writeFileSync(helper, "setInterval(() => {}, 1000);");
    const child = spawn(process.execPath, [helper, join(root, "tickets", `mcp-${record.id}.json`)], { stdio: "ignore" });
    assert.ok(child.pid); pids.push(child.pid);
  }
  async function hostTool(record: Run, ignoreTerm = false) {
    const helper = join(root, "mcp-report.mjs"), script = join(root, "host-tool.cjs"), hostScript = join(root, "host.cjs");
    const infoFile = join(root, "host-processes.json"), ready = join(root, "host-tool.ready"), term = join(root, "host-tool.term");
    writeFileSync(helper, "setInterval(() => {}, 1000);");
    writeFileSync(script, `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(term)}, String(fs.existsSync(${JSON.stringify(record.temporaryDirectory)}))); ${ignoreTerm ? "" : "process.exit(0);"} }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
    writeFileSync(hostScript, `const fs = require('node:fs'); const spawn = require('node:child_process').spawn;
      const helper = spawn(process.execPath, [${JSON.stringify(helper)}, ${JSON.stringify(join(root, "tickets", `mcp-${record.id}.json`))}], {stdio:'ignore'});
      const tool = spawn(process.execPath, [${JSON.stringify(script)}], {stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(infoFile)}, JSON.stringify({helper:helper.pid, tool:tool.pid})); setInterval(() => {}, 1000);`);
    const host = spawn(process.execPath, [hostScript], { detached: true, stdio: "ignore", cwd: root,
      env: { ...process.env, NUCLEUS_TICKET: join(root, "tickets", `${record.id}.json`), NUCLEUS_CONTINUATION_TICKET: "", TMPDIR: root, TMP: root, TEMP: root } });
    assert.ok(host.pid); pids.push(host.pid);
    await wait(() => existsSync(infoFile));
    const info = JSON.parse(readFileSync(infoFile, "utf8")) as { helper: number; tool: number };
    pids.push(info.helper, info.tool);
    await wait(() => existsSync(ready));
    return { host: host.pid, ...info, ready, term };
  }
  function orphan(record: Run, identity: "ticket" | "scratch" | "command" | "none", ignoreTerm = false) {
    const script = join(identity === "command" ? record.temporaryDirectory! : root, `${randomUUID()}.cjs`);
    const ready = join(root, `${randomUUID()}.ready`), term = join(root, `${randomUUID()}.term`);
    writeFileSync(script, `const fs = require('node:fs');\nprocess.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(term)}, String(fs.existsSync(${JSON.stringify(record.temporaryDirectory)}))); ${ignoreTerm ? "" : "process.exit(0);"} });\nfs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
    const env = { ...process.env };
    for (const name of ["NUCLEUS_TICKET", "NUCLEUS_CONTINUATION_TICKET", "TMPDIR", "TMP", "TEMP"]) delete env[name];
    if (identity === "ticket") env.NUCLEUS_TICKET = join(root, "tickets", `${record.id}.json`);
    if (identity === "scratch") env.TMPDIR = record.temporaryDirectory;
    const parent = spawnSync(process.execPath, ["-e", `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: 'ignore', env: ${JSON.stringify(env)}, cwd: ${JSON.stringify(root)} }); console.log(c.pid); c.unref();`], { encoding: "utf8" });
    assert.equal(parent.status, 0, parent.stderr);
    const pid = Number(parent.stdout.trim()); assert.ok(pid > 0); pids.push(pid);
    return { pid, ready, term };
  }
  const release = (record: Run) => store.putRun({ ...record, released: true, status: "finished", active: false });
  const cleanup = () => sweepSettledRunProcesses(store, "fixture-host", { graceMs: 100 });
  async function close() {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Our fixture child already exited. */ } }
    await wait(() => pids.every(pid => !runningPid(pid)));
    store.close(); rmSync(root, { recursive: true, force: true });
  }
  return { root, store, task, run, anchor, hostTool, orphan, release, cleanup, close, track: (pid: number) => pids.push(pid) };
}
function runningPid(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch { return false; }
  }
  return true;
}
async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), "fixture process reached the expected state");
}

test("release stops an inherited-ticket orphan after its observed host and helper exit, then removes scratch", async () => {
  const f = fixture();
  try {
    const run = f.run("recovery"), child = await f.hostTool(run, true);
    await f.cleanup();
    assert.ok(f.store.getMeta(`runProcessHost:${run.id}`), "live observation retained the host's OS identity");
    process.kill(child.helper, "SIGKILL"); process.kill(child.host, "SIGKILL");
    await wait(() => !runningPid(child.host) && !runningPid(child.helper) && processParentPid(child.tool) === 1);
    f.release(run);
    assert.ok(existsSync(run.temporaryDirectory!), "settlement commits before any destructive cleanup");
    // A new store owner has only the durable host proof; neither host nor helper remains.
    const reopened = new Store(f.store.path);
    (reopened as unknown as { runScratchRemover: unknown }).runScratchRemover = (f.store as unknown as { runScratchRemover: unknown }).runScratchRemover;
    try { await sweepSettledRunProcesses(reopened, "fixture-host", { graceMs: 100 }); }
    finally { reopened.close(); }
    await wait(() => !runningPid(child.tool));
    assert.equal(readFileSync(child.term, "utf8"), "true", "TERM handler still has its scratch");
    assert.equal(existsSync(run.temporaryDirectory!), false);
    assert.match(f.store.events(f.task.id).find(event => event.kind === "run_process_cleanup")!.detail, new RegExp(`"pid":${child.tool}`));
  } finally { await f.close(); }
});

test("settling stops scratch-owned work and leaves unmarked and different-run processes alive", async () => {
  const f = fixture();
  try {
    const run = f.run(), other = f.run(); f.anchor(run);
    const own = f.orphan(run, "scratch"), foreign = f.orphan(run, "none"), live = f.orphan(other, "ticket");
    await wait(() => [own, foreign, live].every(child => existsSync(child.ready)));
    f.release(run); await f.cleanup();
    await wait(() => !runningPid(own.pid));
    assert.ok(runningPid(foreign.pid)); assert.ok(runningPid(live.pid));
    assert.ok(existsSync(other.temporaryDirectory!));
  } finally { await f.close(); }
});

test("periodic sweep catches pre-upgrade settled runs by scratch argv and leaves a live run alone", async () => {
  const f = fixture();
  try {
    const old = f.run("executor"), live = f.run("revision");
    const leftover = f.orphan(old, "command"), active = f.orphan(live, "scratch");
    await wait(() => [leftover, active].every(child => existsSync(child.ready)));
    // No cleanup intent: the durable released row predates this implementation.
    f.store.db.prepare("UPDATE runs SET data=json_set(data,'$.released',json('true')) WHERE id=?").run(old.id);
    await f.cleanup();
    await wait(() => !runningPid(leftover.pid));
    assert.ok(runningPid(active.pid)); assert.equal(existsSync(old.temporaryDirectory!), false);
    assert.ok(existsSync(live.temporaryDirectory!));
  } finally { await f.close(); }
});

test("stopping an orphaned group root also stops its newly reparented child before scratch removal", async () => {
  const f = fixture();
  try {
    const run = f.run("executor"); f.anchor(run);
    const childFile = join(f.root, "group-child.pid");
    const rootScript = join(run.temporaryDirectory!, "group-root.cjs");
    writeFileSync(rootScript, `const fs = require('node:fs'); const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(childFile)}, String(c.pid)); setInterval(() => {}, 1000);`);
    const launched = spawnSync(process.execPath, ["-e", `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(rootScript)}], { detached: true, stdio: 'ignore', env: { ...process.env, NUCLEUS_TICKET: ${JSON.stringify(join(f.root, "tickets", `${run.id}.json`))} } }); console.log(c.pid); c.unref();`], { encoding: "utf8" });
    assert.equal(launched.status, 0, launched.stderr);
    const rootPid = Number(launched.stdout.trim()); f.track(rootPid);
    await wait(() => existsSync(childFile) && processParentPid(rootPid) === 1);
    const childPid = Number(readFileSync(childFile, "utf8")); f.track(childPid);
    f.release(run); await f.cleanup();
    await wait(() => !runningPid(rootPid) && !runningPid(childPid));
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally { await f.close(); }
});

test("unavailable scans retain intent and scratch; a surviving identity is recorded and retried", async () => {
  const f = fixture();
  try {
    const run = f.run(); f.release(run);
    await sweepSettledRunProcesses(f.store, "fixture-host", { readProcesses: async () => null });
    assert.ok(f.store.getMeta(`runProcessCleanup:${run.id}`)); assert.ok(existsSync(run.temporaryDirectory!));
    const read = await readHostUidProcesses(); assert.equal(read.state, "listed");
    if (read.state !== "listed") return;
    const fact = { ...read.processes.find(item => item.pid === process.pid)!, pid: 999999, ppid: 1, command: `node ${run.temporaryDirectory}/tool.cjs` };
    await sweepSettledRunProcesses(f.store, "fixture-host", { readProcesses: async () => [fact], readEnvironments: async () => new Map([[fact.pid, {}]]),
      terminate: async targets => ({ terminated: [], failed: targets.map(target => ({ ...target, reason: "still running after SIGKILL" })), skippedPaseo: [] }) });
    assert.match(f.store.events(f.task.id).find(event => event.kind === "run_process_cleanup")!.detail, /still running after SIGKILL/);
    assert.ok(existsSync(run.temporaryDirectory!));
    await f.cleanup(); assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally { await f.close(); }
});

test("ownership has path boundaries and protects a provider, helper, ancestors and standing runtime", () => {
  const fact = (pid: number, ppid: number, command: string) => ({ pid, ppid, command, pgid: pid, uid: 1, startIdentity: `${pid}@identity`, cwd: null });
  const run = { id: "run", taskId: "task", temporaryDirectory: "/scratch/run" };
  assert.equal(processBelongsToRun(fact(1, 0, "node /scratch/run-other/tool"), {}, run, "/data"), false);
  assert.equal(processBelongsToRun(fact(1, 0, "node '/scratch/run/tool'"), {}, run, "/data"), true);
  assert.equal(processBelongsToRun(fact(1, 0, "node tool"), { NUCLEUS_TICKET: "/elsewhere/tickets/run.json" }, run, "/data"), false);
  const facts = [fact(10, 1, "/provider/codex"), fact(11, 10, "node /nucleus/mcp-report.mjs /data/tickets/mcp-run.json"),
    fact(12, 10, "/provider/codex-code-mode-host"), fact(13, 12, "sh -c tool"), fact(14, 13, "node tool")];
  assert.deepEqual([...runInfrastructurePids(facts)].sort((a, b) => a - b), [10, 11, 12]);
});

test("a reused retained thread and its attached tool keep the old environment without being stopped", async () => {
  const f = fixture();
  try {
    const old = f.run(), next = f.run();
    f.store.putRun({ ...next, agentId: old.agentId });
    const ready = join(f.root, "attached.ready");
    const parent = spawn(process.execPath, ["-e", `const fs = require('node:fs'); const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(ready)}, String(c.pid)); setInterval(() => {}, 1000);`],
      { stdio: "ignore", env: { ...process.env, TMPDIR: old.temporaryDirectory!, NUCLEUS_TICKET: join(f.root, "tickets", `${old.id}.json`) } });
    assert.ok(parent.pid); f.track(parent.pid);
    await wait(() => existsSync(ready));
    const childPid = Number(readFileSync(ready, "utf8")); f.track(childPid);
    f.release(old);
    await f.cleanup();
    assert.ok(runningPid(parent.pid)); assert.ok(runningPid(childPid));
    assert.ok(existsSync(old.temporaryDirectory!));
    parent.kill("SIGKILL"); process.kill(childPid, "SIGKILL");
    await wait(() => !runningPid(parent.pid!) && !runningPid(childPid));
  } finally { await f.close(); }
});

test("an unobserved ambiguous host identity retains scratch and records visible uncertainty", async () => {
  const f = fixture();
  try {
    const run = f.run(), possibleHost = f.orphan(run, "ticket");
    await wait(() => existsSync(possibleHost.ready));
    f.release(run); await f.cleanup();
    assert.ok(runningPid(possibleHost.pid));
    assert.ok(existsSync(run.temporaryDirectory!));
    assert.equal(f.store.getMeta<{pending:boolean}>(`runProcessCleanup:${run.id}`)?.pending, true);
    assert.match(f.store.events(f.task.id).find(event => event.kind === "run_process_cleanup_deferred")!.detail, /host identity has not been observed/);
  } finally { await f.close(); }
});

test("initial worker report and displaced-worker identity persist cleanup independently of the task's next run", async () => {
  const f = fixture();
  try {
    const run = f.run("revision");
    f.store.update(f.task.id, { runId: run.id, agentId: run.agentId, temporaryDirectory: run.temporaryDirectory }, "fixture_launch");
    f.store.update(f.task.id, { completion: { taskId: f.task.id, runId: run.id, eventId: "report", status: "progress_checkpoint", summary: "fixture" } }, "fixture_report");
    assert.ok(f.store.getMeta(`runProcessCleanup:${run.id}`));
    f.store.update(f.task.id, { runId: randomUUID(), agentId: "next-worker", completion: null, temporaryDirectory: undefined }, "fixture_next");
    f.release(run); await f.cleanup();
    assert.equal(existsSync(run.temporaryDirectory!), false);
    assert.equal(f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)?.pending, false);
  } finally { await f.close(); }
});

test("rollback preserves scratch and does not publish a cleanup intent", async () => {
  const f = fixture();
  try {
    const run = f.run();
    assert.throws(() => f.store.transaction(() => { f.release(run); throw Error("rollback fixture"); }), /rollback fixture/);
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(f.store.getMeta(`runProcessCleanup:${run.id}`), undefined);
    await f.cleanup();
    assert.ok(existsSync(run.temporaryDirectory!));
  } finally { await f.close(); }
});

test("settled attached tools stop after helper exit while their observed provider stays alive", async () => {
  const f = fixture();
  try {
    const run = f.run(), child = await f.hostTool(run);
    await f.cleanup();
    assert.equal(processParentPid(child.tool), child.host, "the tool has a live non-init parent");
    process.kill(child.helper, "SIGKILL");
    await wait(() => !runningPid(child.helper));
    f.release(run); await f.cleanup();
    await wait(() => !runningPid(child.tool));
    assert.ok(runningPid(child.host)); assert.equal(runningPid(child.helper), false);
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally { await f.close(); }
});

for (const failure of ["one process", "Darwin chunk"] as const) test(`an unreadable ${failure} retains scratch and intent until ownership can be read`, async () => {
  const f = fixture();
  try {
    const run = f.run(), child = await f.hostTool(run), foreign = f.orphan(run, "none");
    await wait(() => existsSync(foreign.ready));
    await f.cleanup();
    f.release(run);
    const read = await readHostUidProcesses(); assert.equal(read.state, "listed");
    if (read.state !== "listed") return;
    const facts = read.processes.filter(fact => [child.tool, foreign.pid].includes(fact.pid));
    assert.equal(facts.length, 2);
    await sweepSettledRunProcesses(f.store, "fixture-host", { graceMs: 100, readProcesses: async () => facts,
      readEnvironments: async pids => {
        if (failure === "Darwin chunk") return runProcessEnvironments(pids, { platform: "darwin", darwinRead: async () => { throw Error("fixture ps chunk failed"); } });
        const environments = await runProcessEnvironments(pids);
        environments.set(child.tool, null);
        return environments;
      } });
    assert.ok(runningPid(child.tool)); assert.ok(runningPid(foreign.pid));
    assert.ok(existsSync(run.temporaryDirectory!));
    assert.equal(f.store.getMeta<{pending:boolean}>(`runProcessCleanup:${run.id}`)?.pending, true);
    assert.match(f.store.events(f.task.id).find(event => event.kind === "run_process_cleanup_deferred")!.detail, /environment ownership is unreadable/);
    await f.cleanup();
    await wait(() => !runningPid(child.tool));
    assert.ok(runningPid(foreign.pid)); assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally { await f.close(); }
});

test("saved infrastructure protection compares start identities rather than recycled PIDs", async () => {
  const f = fixture();
  try {
    const run = f.run(), child = await f.hostTool(run);
    await f.cleanup();
    const read = await readHostUidProcesses(); assert.equal(read.state, "listed");
    if (read.state !== "listed") return;
    const provider = read.processes.find(fact => fact.pid === child.host)!;
    assert.ok(provider);
    assert.ok(protectedRunInfrastructure(f.store, [run], [provider]).has(child.host));
    assert.equal(protectedRunInfrastructure(f.store, [run], [{ ...provider, startIdentity: `${provider.pid}@different-start` }]).has(child.host), false);
  } finally { await f.close(); }
});
