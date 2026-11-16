import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runningPid, wait } from "./support/run-process-cleanup-fixture";
import { readHostUidProcesses } from "../core/machine/host-process-listing";
import { runProcessEnvironments } from "../core/machine/run-process-identity";
import { sweepSettledRunProcesses } from "../core/machine/run-process-cleanup";

test("an owned process with an unknown start identity retains scratch and intent until a fresh read", async () => {
  const f = fixture();
  try {
    const run = f.run(), child = await f.hostTool(run);
    await f.cleanup();
    f.release(run);
    const read = await readHostUidProcesses(); assert.equal(read.state, "listed");
    if (read.state !== "listed") return;
    const fact = read.processes.find(item => item.pid === child.tool)!;
    assert.ok(fact);
    await sweepSettledRunProcesses(f.store, "fixture-host", { graceMs: 100,
      readProcesses: async () => [{ ...fact, startIdentity: `${fact.pid}@unknown` }],
      readEnvironments: runProcessEnvironments });
    assert.ok(runningPid(child.tool)); assert.equal(existsSync(child.term), false);
    assert.ok(existsSync(run.temporaryDirectory!));
    assert.equal(f.store.getMeta<{pending:boolean}>(`runProcessCleanup:${run.id}`)?.pending, true);
    const event = f.store.events(f.task.id).find(item => item.kind === "run_process_cleanup_deferred")!;
    assert.ok(event);
    assert.match(event.detail, /start identity is unreadable/);
    assert.match(event.detail, new RegExp(`${child.tool}@unknown`));
    await f.cleanup();
    await wait(() => !runningPid(child.tool));
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally { await f.close(); }
});

for (const savedHost of [false, true]) test(`an unreadable live-run environment prevents signaling a command in settled scratch (saved host: ${savedHost})`, async () => {
  const f = fixture();
  try {
    const settled = f.run(), live = f.run();
    if (savedHost) { await f.hostTool(settled); await f.cleanup(); }
    const script = join(settled.temporaryDirectory!, "live-tool.cjs"), ready = join(f.root, "live.ready"), term = join(f.root, "live.term");
    writeFileSync(script, `const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(term)}, 'signaled')); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
    const env = { ...process.env, NUCLEUS_TICKET: join(f.root, "tickets", `${live.id}.json`), NUCLEUS_CONTINUATION_TICKET: "",
      TMPDIR: live.temporaryDirectory!, TMP: live.temporaryDirectory!, TEMP: live.temporaryDirectory! };
    const parent = spawnSync(process.execPath, ["-e", `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(script)}], {detached:true, stdio:'ignore', env:${JSON.stringify(env)}, cwd:${JSON.stringify(f.root)}}); console.log(child.pid); child.unref();`], { encoding: "utf8" });
    assert.equal(parent.status, 0, parent.stderr);
    const pid = Number(parent.stdout.trim()); assert.ok(pid > 0); f.track(pid);
    await wait(() => existsSync(ready));
    f.release(settled);
    const read = await readHostUidProcesses(); assert.equal(read.state, "listed");
    if (read.state !== "listed") return;
    const fact = read.processes.find(item => item.pid === pid)!;
    assert.ok(fact); assert.equal(fact.ppid, 1);
    assert.equal((await runProcessEnvironments([pid])).get(pid)?.NUCLEUS_TICKET, env.NUCLEUS_TICKET);
    await sweepSettledRunProcesses(f.store, "fixture-host", { graceMs: 100,
      readProcesses: async () => [fact], readEnvironments: async () => new Map([[pid, null]]) });
    assert.ok(runningPid(pid)); assert.equal(existsSync(term), false);
    assert.ok(existsSync(settled.temporaryDirectory!));
    assert.equal(f.store.getMeta<{pending:boolean}>(`runProcessCleanup:${settled.id}`)?.pending, true);
    assert.match(f.store.events(f.task.id).find(item => item.kind === "run_process_cleanup_deferred")!.detail, /environment ownership is unreadable/);
    await f.cleanup();
    assert.ok(runningPid(pid)); assert.equal(existsSync(term), false);
  } finally { await f.close(); }
});
