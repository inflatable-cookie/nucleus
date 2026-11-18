import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixture,
  runningPid,
  wait,
} from "./support/run-process-cleanup-fixture";
import {
  CLEANUP_RESPAWN_WINDOW_MS,
  initRootedProcess,
} from "../core/machine/run-process-cleanup";
import { processParentPid } from "../core/machine/process-identity";
import type { HostProcessFact } from "../core/host/types";

/**
 * nucleus#1306: after #1280 rolled, run process cleanup stopped a finished
 * run's freshly started helper every few minutes because that helper was a
 * child of the retained agent host. A live non-init ancestor is an owner:
 * cleanup never signals below one, whatever run identity the process carries,
 * and a process it did stop that comes straight back is recorded once and left
 * alone instead of being chased.
 */

type Run = ReturnType<ReturnType<typeof fixture>["run"]>;

/** A retained agent host: its MCP report helper and tool as its own children. */
function retainedHost(f: ReturnType<typeof fixture>, run: Run) {
  const helper = join(f.root, "mcp-report.mjs"),
    tool = join(f.root, "host-tool.cjs"),
    host = join(f.root, "host.cjs");
  const infoFile = join(f.root, "retained-host.json"),
    ready = join(f.root, "retained-host.ready");
  writeFileSync(helper, "setInterval(() => {}, 1000);");
  writeFileSync(tool, "setInterval(() => {}, 1000);");
  writeFileSync(
    host,
    `
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    const report = spawn(process.execPath, [${JSON.stringify(helper)}, ${JSON.stringify(join(f.root, "tickets", `mcp-${run.id}.json`))}], { stdio: 'ignore' });
    const tool = spawn(process.execPath, [${JSON.stringify(tool)}], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(infoFile)} + '.tmp', JSON.stringify({ helper: report.pid, tool: tool.pid }));
    fs.renameSync(${JSON.stringify(infoFile)} + '.tmp', ${JSON.stringify(infoFile)});
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `,
  );
  return launched(f, run, host, { infoFile, ready } as {
    infoFile: string;
    ready: string;
  });
}

/**
 * A retained agent host that respawns a run-identified tool through an exiting
 * launcher, so each new tool is reparented to init exactly like the daemon's
 * respawned helpers in the live evidence.
 */
function respawningHost(f: ReturnType<typeof fixture>, run: Run) {
  const helper = join(f.root, "mcp-report.mjs"),
    tool = join(f.root, "respawned-tool.cjs");
  const launcher = join(f.root, "launcher.cjs"),
    host = join(f.root, "host.cjs");
  const pidFile = join(f.root, "respawned-tool.pid"),
    ready = join(f.root, "retained-host.ready");
  const helperPidFile = join(f.root, "retained-helper.pid");
  writeFileSync(helper, "setInterval(() => {}, 1000);");
  writeFileSync(tool, "setInterval(() => {}, 1000);");
  writeFileSync(
    launcher,
    `
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[2]], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(process.argv[3] + '.tmp', String(child.pid));
    fs.renameSync(process.argv[3] + '.tmp', process.argv[3]);
    child.unref();
    process.exit(0);
  `,
  );
  writeFileSync(
    host,
    `
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    const report = spawn(process.execPath, [${JSON.stringify(helper)}, ${JSON.stringify(join(f.root, "tickets", `mcp-${run.id}.json`))}], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(helperPidFile)}, String(report.pid));
    const launch = () => spawn(process.execPath, [${JSON.stringify(launcher)}, ${JSON.stringify(tool)}, ${JSON.stringify(pidFile)}],
      { detached: true, stdio: 'ignore' }).unref();
    launch();
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {
      let pid = 0;
      try { pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8')); } catch { return; }
      if (!pid) return;
      try { process.kill(pid, 0); } catch { fs.unlinkSync(${JSON.stringify(pidFile)}); launch(); }
    }, 25);
    setInterval(() => {}, 1000);
  `,
  );
  return launched(f, run, host, { pidFile, ready, helperPidFile });
}

function launched<T extends { infoFile: string } | { pidFile: string }>(
  f: ReturnType<typeof fixture>,
  run: Run,
  script: string,
  files: T & { ready: string },
): T & { ready: string; host: number } {
  const host = spawn(process.execPath, [script], {
    detached: true,
    stdio: "ignore",
    cwd: f.root,
    env: {
      ...process.env,
      NUCLEUS_CONTINUATION_TICKET: "",
      NUCLEUS_TICKET: join(f.root, "tickets", `${run.id}.json`),
      TMPDIR: run.temporaryDirectory!,
      TMP: run.temporaryDirectory!,
      TEMP: run.temporaryDirectory!,
    },
  });
  assert.ok(host.pid);
  f.track(host.pid);
  return { ...files, host: host.pid };
}

const toolPid = (file: string) => Number(readFileSync(file, "utf8"));

test("a finished run's retained agent host and the children it owns are never stopped", async () => {
  const f = fixture();
  try {
    const run = f.run("reviewer"),
      held = retainedHost(f, run);
    await wait(() => existsSync(held.infoFile) && existsSync(held.ready));
    const children = JSON.parse(readFileSync(held.infoFile, "utf8")) as {
      helper: number;
      tool: number;
    };
    f.track(children.helper);
    f.track(children.tool);
    f.release(run);
    // Three sweeps: the settled run keeps finding its own identity on live
    // processes and must stop none of them, and must not repeat the record.
    await f.cleanup();
    await f.cleanup();
    await f.cleanup();
    assert.ok(runningPid(held.host), "the retained agent host is untouched");
    assert.ok(
      runningPid(children.helper),
      "the host's own MCP report helper is untouched",
    );
    assert.ok(runningPid(children.tool), "the host's own tool is untouched");
    assert.ok(
      existsSync(run.temporaryDirectory!),
      "a live owner keeps the scratch its tools use",
    );
    assert.equal(
      f.store
        .events(f.task.id)
        .filter((event) => event.kind === "run_process_cleanup").length,
      0,
      "no process was stopped",
    );
    const leftAlone = f.store
      .events(f.task.id)
      .filter((event) => event.kind === "run_process_cleanup_left_alone");
    assert.equal(
      leftAlone.length,
      1,
      JSON.stringify(leftAlone.map((event) => event.detail)),
    );
    assert.match(leftAlone[0]!.detail, /live-ancestor/);
    assert.equal(
      f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
        ?.pending,
      true,
      "the scratch is retained for the next observation, not destroyed under a live owner",
    );
  } finally {
    await f.close();
  }
});

test("a process this run lost to a stop, respawned at once, is recorded once and left alone", async () => {
  const f = fixture();
  try {
    const run = f.run("reviewer"),
      held = respawningHost(f, run);
    await wait(() => existsSync(held.pidFile) && existsSync(held.ready));
    const first = toolPid(held.pidFile);
    f.track(first);
    f.track(toolPid(held.helperPidFile));
    await wait(() => processParentPid(first) === 1);
    // One observation while the run is live records the provider's identity.
    await f.cleanup();
    f.release(run);
    await f.cleanup();
    await wait(() => !runningPid(first));
    const stopEvents = f.store
      .events(f.task.id)
      .filter((event) => event.kind === "run_process_cleanup");
    assert.equal(
      stopEvents.length,
      1,
      JSON.stringify(stopEvents.map((event) => event.detail)),
    );
    assert.match(stopEvents[0]!.detail, new RegExp(`"pid":${first}`));
    // The host respawned its tool at once. The same sweep must not chase it, and
    // later sweeps record the respawn once and leave it alone.
    await wait(() => {
      if (!existsSync(held.pidFile)) return false;
      const next = toolPid(held.pidFile);
      return next !== first && runningPid(next) && processParentPid(next) === 1;
    });
    const respawned = toolPid(held.pidFile);
    f.track(respawned);
    const before = f.store
      .events(f.task.id)
      .filter((event) => event.kind === "run_process_cleanup").length;
    await f.cleanup();
    await f.cleanup();
    assert.ok(runningPid(respawned), "the respawned process is left alone");
    assert.equal(
      f.store
        .events(f.task.id)
        .filter((event) => event.kind === "run_process_cleanup").length,
      before,
      "no second stop for the same run inside the respawn window",
    );
    const leftAlone = f.store
      .events(f.task.id)
      .filter((event) => event.kind === "run_process_cleanup_left_alone");
    // The respawn is recorded once and never chased. A sweep round that lands in
    // the moment between the host losing its tool and starting the next one has
    // no owned target, so it records the host's own live-ancestor reason instead:
    // a distinct fact, recorded once while the host stands, never a repeat.
    const respawnRecords = leftAlone.filter((event) =>
      event.detail.includes("respawned-after-stop"),
    );
    assert.equal(
      respawnRecords.length,
      1,
      JSON.stringify(leftAlone.map((event) => event.detail)),
    );
    assert.match(respawnRecords[0]!.detail, /respawned-after-stop/);
    assert.ok(
      leftAlone.every((event) =>
        /respawned-after-stop|live-ancestor/.test(event.detail),
      ),
      JSON.stringify(leftAlone.map((event) => event.detail)),
    );
    assert.ok(
      leftAlone.length <= 2,
      JSON.stringify(leftAlone.map((event) => event.detail)),
    );
    assert.ok(existsSync(run.temporaryDirectory!));
  } finally {
    await f.close();
  }
});

test("a live ancestor anywhere above a process protects it, and only a gone ancestry is init's", () => {
  const fact = (
    pid: number,
    ppid: number,
    state: string | null = "S",
  ): HostProcessFact => ({
    pid,
    ppid,
    pgid: pid,
    uid: 1,
    state,
    startIdentity: `${pid}@2026-11-01T00:00:00Z`,
    command: "fixture",
    cwd: null,
  });
  const table = [
    fact(1, 0, null),
    fact(200, 1),
    fact(201, 200),
    fact(202, 201),
    fact(300, 299),
    fact(400, 1, "Z"),
  ];
  const byPid = new Map(table.map((item) => [item.pid, item]));
  const alive = (pid: number) => pid === 299;
  assert.equal(
    initRootedProcess(fact(200, 1), byPid, alive),
    true,
    "a direct child of init is an orphan",
  );
  assert.equal(
    initRootedProcess(fact(202, 201), byPid, alive),
    false,
    "a live host owns its helper and tools",
  );
  assert.equal(
    initRootedProcess(fact(300, 299), byPid, alive),
    false,
    "an unlisted live parent is still a live ancestor",
  );
  assert.equal(
    initRootedProcess(fact(201, 400), byPid, alive),
    true,
    "a zombie is no live ancestor; its own parent is init",
  );
  assert.equal(CLEANUP_RESPAWN_WINDOW_MS, 10 * 60_000);
});
