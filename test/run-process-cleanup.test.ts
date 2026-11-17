import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, runningPid, wait } from "./support/run-process-cleanup-fixture";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { sweepSettledRunProcesses } from "../core/machine/run-process-cleanup";
import { processParentPid } from "../core/machine/process-identity";

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
    try { await sweepSettledRunProcesses(reopened, "fixture-host"); }
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
