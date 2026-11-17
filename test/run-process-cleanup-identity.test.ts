import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, runningPid, wait } from "./support/run-process-cleanup-fixture";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processBelongsToRun, orphanExecutesRunScratch } from "../core/machine/run-process-cleanup";
import { protectedRunInfrastructure, rememberRunProcessHosts } from "../core/machine/run-process-hosts";
import { runInfrastructurePids } from "../core/machine/owned-tool-process-proof";
import { readHostUidProcesses } from "../core/machine/host-process-listing";
import { processParentPid } from "../core/machine/process-identity";
import type { HostProcessFact } from "../core/host/types";

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

test("an unobserved orphan provider mentioning scratch as a flag remains protected", async () => {
  const f = fixture();
  try {
    const run = f.run(), child = await f.hostTool(run, false, true);
    process.kill(child.helper, "SIGKILL");
    await wait(() => !runningPid(child.helper) && processParentPid(child.host) === 1);
    f.release(run); await f.cleanup();
    assert.ok(runningPid(child.host), "scratch in a host flag is not proof of a scratch program");
    assert.ok(runningPid(child.tool)); assert.ok(existsSync(run.temporaryDirectory!));
    assert.match(f.store.events(f.task.id).find(event => event.kind === "run_process_cleanup_deferred")!.detail, /host identity/);
  } finally { await f.close(); }
});

test("legacy execution proof excludes flags, prompts, runtime bindings and paths escaping scratch", () => {
  const proof = (command: string, ppid = 1) => orphanExecutesRunScratch({ command, ppid }, "/scratch/run");
  assert.equal(proof("bun /scratch/run/probe.ts"), true);
  assert.equal(proof("node '/scratch/run/probe.js'"), true);
  assert.equal(proof("/scratch/run/bin/tool"), true);
  assert.equal(proof("bun run /scratch/run/probe.ts"), true);
  assert.equal(proof("node /installed/host.js --working-dir /scratch/run"), false);
  assert.equal(proof("node --require /scratch/run/config.js /installed/host.js"), false);
  assert.equal(proof("node -e 'console.log(\"/scratch/run/probe.js\")'"), false);
  assert.equal(proof("node /scratch/run/../outside.js"), false);
  assert.equal(proof("node /scratch/run/kernel.js --session-id bound"), false);
  assert.equal(proof("/Provider.app/Contents/node /scratch/run/kernel.js"), false);
  assert.equal(proof("node /scratch/run/probe.js", 42), false);
});

test("a runtime identified after helper exit stays protected after its provider exits", async () => {
  const f = fixture();
  try {
    const run = f.run();
    const fact = (pid: number, ppid: number, command: string): HostProcessFact => ({ pid, ppid, command,
      pgid: pid, uid: 1, startIdentity: `${pid}@2026-11-01T00:00:00Z`, cwd: null });
    const provider = fact(812345, 1, "/fixture/provider");
    const helper = fact(812346, provider.pid, `node /fixture/mcp-report.mjs ${f.root}/tickets/mcp-${run.id}.json`);
    const runtime = fact(812347, provider.pid, "/fixture/provider-code-mode-host");
    rememberRunProcessHosts(f.store, [run], [provider, helper]);
    rememberRunProcessHosts(f.store, [run], [provider, runtime]);
    assert.ok(protectedRunInfrastructure(f.store, [run], [runtime]).has(runtime.pid));
    assert.equal(protectedRunInfrastructure(f.store, [run], [{ ...runtime, startIdentity: `${runtime.pid}@2026-11-02T00:00:00Z` }]).has(runtime.pid), false);
  } finally { await f.close(); }
});
