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

type Run = ReturnType<ReturnType<typeof fixture>["run"]>;

/**
 * nucleus#1372's live shape: run 89564e8c's reviewer released, and the only
 * process still carrying its identity was pid 63488, `…/codex app-server --enable
 * goals`, a direct child of the Paseo daemon started for that thread. It is the
 * provider host the daemon keeps, not a process the run owns, so cleanup must not
 * treat it as the released run's live ancestor — and a repeated pass must add no
 * events at all.
 *
 * The fixture keeps that exact shape with node as the program: the command line is
 * `<program> app-server --enable goals`, the process is its daemon's child, and it
 * inherits the launching thread's ticket and scratch in its environment, as the
 * shared app-server does.
 */

/** A host daemon with one provider host child that carries the released run's environment. */
async function daemonStartedProviderHost(
  f: ReturnType<typeof fixture>,
  run: Run,
): Promise<{ daemon: number; appServer: number }> {
  const hostScript = join(f.root, "provider-host.cjs");
  const appServer = join(f.root, "app-server");
  const daemonScript = join(f.root, "daemon.cjs");
  const infoFile = join(f.root, "daemon-provider.json");
  writeFileSync(appServer, "");
  writeFileSync(hostScript, "setInterval(() => {}, 1000);");
  const inherited = {
    NUCLEUS_TICKET: join(f.root, "tickets", `${run.id}.json`),
    NUCLEUS_CONTINUATION_TICKET: "",
    TMPDIR: run.temporaryDirectory,
    TMP: run.temporaryDirectory,
    TEMP: run.temporaryDirectory,
  };
  writeFileSync(
    daemonScript,
    `
    const fs = require('node:fs'), { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(hostScript)}, ${JSON.stringify(appServer)}, '--enable', 'goals'],
      { stdio: 'ignore', env: { ...process.env, ...${JSON.stringify(inherited)} } });
    fs.writeFileSync(${JSON.stringify(infoFile)} + '.tmp', JSON.stringify({ appServer: child.pid }));
    fs.renameSync(${JSON.stringify(infoFile)} + '.tmp', ${JSON.stringify(infoFile)});
    setInterval(() => {}, 1000);
  `,
  );
  const env = { ...process.env };
  for (const name of [
    "NUCLEUS_TICKET",
    "NUCLEUS_CONTINUATION_TICKET",
    "TMPDIR",
    "TMP",
    "TEMP",
  ])
    delete env[name];
  const daemon = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
    cwd: f.root,
    env,
  });
  assert.ok(daemon.pid);
  f.track(daemon.pid);
  await wait(() => existsSync(infoFile));
  return {
    daemon: daemon.pid,
    appServer: (
      JSON.parse(readFileSync(infoFile, "utf8")) as { appServer: number }
    ).appServer,
  };
}

const cleanupEvents = (f: ReturnType<typeof fixture>) =>
  f.store
    .events(f.task.id)
    .filter((event) => event.kind.startsWith("run_process_cleanup"));

test("a provider host the daemon keeps never holds a released run's cleanup, and repeats add nothing", async () => {
  const f = fixture();
  try {
    const run = f.run("reviewer");
    const started = await daemonStartedProviderHost(f, run);
    f.track(started.appServer);
    f.release(run);
    await f.cleanup();
    assert.ok(
      runningPid(started.appServer),
      "the provider host is never signalled",
    );
    assert.equal(
      cleanupEvents(f).length,
      0,
      JSON.stringify(cleanupEvents(f).map((event) => event.detail)),
    );
    assert.equal(
      f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
        ?.pending,
      false,
      "the run's cleanup settled instead of holding its scratch for an inherited identity",
    );
    const after = f.store.eventsAll(f.task.id).length;
    await f.cleanup();
    await f.cleanup();
    assert.equal(
      f.store.eventsAll(f.task.id).length,
      after,
      "a repeated pass over the same decision records nothing new",
    );
  } finally {
    await f.close();
  }
});

test("a genuinely owned live process still holds the scratch and is recorded once", async () => {
  const f = fixture();
  try {
    const run = f.run("reviewer");
    const held = await f.hostTool(run);
    await wait(() => existsSync(held.ready));
    f.track(held.host);
    f.release(run);
    // Every pass below also re-writes the run row, as an idle observation of a
    // released run does. That obligation write must not erase the recorded
    // decision, or the same left-alone record would be written again each pass
    // (nucleus#1358 wrote 770 identical records this way).
    const observeAgain = () =>
      f.store.putRun({ ...f.store.run(run.id)!, released: true });
    await f.cleanup();
    const leftAlone = f.store
      .events(f.task.id)
      .filter((event) => event.kind === "run_process_cleanup_left_alone");
    assert.equal(
      leftAlone.length,
      1,
      JSON.stringify(leftAlone.map((event) => event.detail)),
    );
    assert.match(leftAlone[0]!.detail, /live-ancestor/);
    assert.ok(
      existsSync(run.temporaryDirectory!),
      "the owner keeps its scratch",
    );
    observeAgain();
    await f.cleanup();
    observeAgain();
    await f.cleanup();
    assert.equal(
      f.store
        .events(f.task.id)
        .filter((event) => event.kind === "run_process_cleanup_left_alone")
        .length,
      1,
      "the same decision over the same processes is written once",
    );
    assert.match(
      JSON.stringify(
        f.store.getMeta<{ leftAlone?: { processes?: unknown[] } }>(
          `runProcessCleanup:${run.id}`,
        )?.leftAlone,
      ),
      /"reason":"live-ancestor"/,
      "the re-queued obligation keeps the recorded decision",
    );
  } finally {
    await f.close();
  }
});
