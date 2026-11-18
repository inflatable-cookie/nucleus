import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runningPid, wait } from "./support/run-process-cleanup-fixture";
import { processParentPid } from "../core/machine/process-identity";

/**
 * nucleus#1329: a finished run's `mcp-report.mjs` bridge must not outlive its
 * session. On 2026-11-18, 31 such bridges (ppid 1) from finished runs were still
 * listed hours after their runs ended.
 *
 * Two owners are proved here. The bridge itself ends with the session that
 * started it, and the sweep's cleanup reaps one a crash left behind by the
 * identity the run recorded for it — never by a command pattern, and never one
 * belonging to a session that is still live.
 */

test("a finished run's orphaned report bridge is reaped by its recorded identity, and a live run's bridge is untouched", async () => {
  const f = fixture();
  try {
    const finished = f.run(), live = f.run();
    const settled = await f.hostTool(finished, false, false, "settled"), running = await f.hostTool(live, false, false, "live");
    // One observation while both sessions are live records each host's identity.
    await f.cleanup();
    assert.ok(f.store.getMeta(`runProcessHost:${finished.id}`), "the bridge and its host identity are recorded");
    // The finished session's host exits: its bridge is reparented to init with
    // the run's own ticket in its environment.
    process.kill(settled.host, "SIGKILL");
    await wait(() => !runningPid(settled.host) && processParentPid(settled.helper) === 1);
    assert.ok(runningPid(settled.helper), "the orphaned bridge is still there for cleanup to find");
    f.release(finished);
    await f.cleanup();
    await wait(() => !runningPid(settled.helper));
    const stops = f.store.events(f.task.id).filter(event => event.kind === "run_process_cleanup");
    assert.match(stops.map(event => event.detail).join("\n"), new RegExp(`"pid":${settled.helper}`),
      "the orphaned bridge is stopped under the pid and start identity the run recorded");
    await wait(() => !runningPid(settled.tool));
    assert.equal(existsSync(finished.temporaryDirectory!), false, "the settled run's scratch is released once nothing owns it");
    assert.ok(runningPid(running.host), "the live run's host is untouched");
    assert.ok(runningPid(running.helper), "the live run's bridge is untouched");
    assert.ok(runningPid(running.tool), "the live run's tool is untouched");
    assert.ok(existsSync(live.temporaryDirectory!), "the live run keeps the scratch its tools use");
  } finally { await f.close(); }
});

test("the report bridge exits with the session that started it", async () => {
  const f = fixture();
  try {
    const binding = join(f.root, "tickets", `mcp-${randomUUID()}.json`);
    const helper = new URL("../mcp-report.mjs", import.meta.url).pathname;
    const wrapper = join(f.root, "session-wrapper.cjs"), pidFile = join(f.root, "bridge.pid");
    // The session is the wrapper: it owns the bridge's stdin pipe, so neither a
    // reparent nor an EOF happens while it lives.
    writeFileSync(wrapper, `
      const fs = require('node:fs'), { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: ['pipe', 'ignore', 'ignore'] });
      fs.writeFileSync(process.argv[4], String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const session = spawn(process.execPath, [wrapper, helper, binding, pidFile], {
      stdio: "ignore", cwd: f.root, env: { ...process.env, NUCLEUS_DATA_HOME: f.root },
    });
    assert.ok(session.pid); f.track(session.pid);
    await wait(() => existsSync(pidFile));
    const bridge = Number(readFileSync(pidFile, "utf8")); f.track(bridge);
    await wait(() => processParentPid(bridge) === session.pid);
    // A live session keeps its bridge: the helper's own watch must not end it.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    assert.ok(runningPid(bridge), "the bridge stays while its session is live");
    process.kill(session.pid!, "SIGKILL");
    await wait(() => !runningPid(bridge));
  } finally { await f.close(); }
});
