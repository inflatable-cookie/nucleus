import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store/store";
import { sweepSettledRunProcesses } from "../../core/machine/run-process-cleanup";
import { pidAlive } from "../../core/machine/pid";
import { checkoutRunScratchPlacement, removeRecordedRunScratchDirectory, runTemporaryEnvironment } from "../../core/workspaces/run-scratch";
import { submissionSchema, type Run } from "../../shared/contracts";

const base = "b".repeat(40);
export function fixture() {
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
  async function hostTool(record: Run, ignoreTerm = false, orphanHost = false, tag = "") {
    // A tag keeps two hosts' fixture files apart in one test; the helper's own
    // file name stays `mcp-report.mjs`, which is the identity every reader matches.
    const directory = tag ? join(root, tag) : root;
    if (tag) mkdirSync(directory, { recursive: true });
    const helper = join(directory, "mcp-report.mjs"), script = join(directory, "host-tool.cjs"), hostScript = join(directory, "host.cjs");
    const infoFile = join(directory, "host-processes.json"), ready = join(directory, "host-tool.ready"), term = join(directory, "host-tool.term");
    writeFileSync(helper, "setInterval(() => {}, 1000);");
    writeFileSync(script, `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(term)}, String(fs.existsSync(${JSON.stringify(record.temporaryDirectory)}))); ${ignoreTerm ? "" : "process.exit(0);"} }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
    writeFileSync(hostScript, `const fs = require('node:fs'); const spawn = require('node:child_process').spawn;
      const helper = spawn(process.execPath, [${JSON.stringify(helper)}, ${JSON.stringify(join(root, "tickets", `mcp-${record.id}.json`))}], {stdio:'ignore'});
      const tool = spawn(process.execPath, [${JSON.stringify(script)}], {stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(infoFile)}, JSON.stringify({helper:helper.pid, tool:tool.pid})); setInterval(() => {}, 1000);`);
    const hostArgs = [hostScript, "--working-dir", record.temporaryDirectory!];
    const hostEnv = { ...process.env, NUCLEUS_TICKET: join(root, "tickets", `${record.id}.json`), NUCLEUS_CONTINUATION_TICKET: "", TMPDIR: root, TMP: root, TEMP: root };
    let hostPid: number;
    if (orphanHost) {
      const launch = spawnSync(process.execPath, ["-e", `const c = require('node:child_process').spawn(process.execPath, ${JSON.stringify(hostArgs)}, { detached:true, stdio:'ignore', cwd:${JSON.stringify(root)}, env:${JSON.stringify(hostEnv)} }); console.log(c.pid); c.unref();`], { encoding: "utf8" });
      assert.equal(launch.status, 0, launch.stderr);
      hostPid = Number(launch.stdout.trim()); assert.ok(hostPid > 0);
    } else {
      const host = spawn(process.execPath, hostArgs, { detached: true, stdio: "ignore", cwd: root, env: hostEnv });
      assert.ok(host.pid); hostPid = host.pid;
    }
    pids.push(hostPid);
    await wait(() => existsSync(infoFile));
    const info = JSON.parse(readFileSync(infoFile, "utf8")) as { helper: number; tool: number };
    pids.push(info.helper, info.tool);
    await wait(() => existsSync(ready));
    return { host: hostPid, ...info, ready, term };
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
export function runningPid(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch { return false; }
  }
  return true;
}
export async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), "fixture process reached the expected state");
}

