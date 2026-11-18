#!/usr/bin/env node
/**
 * Fixture-only Queue service side for the milestone QA supervision tests
 * (task 114). It runs the service's own `ProjectQaRunner` in a separate process,
 * so a test can kill that process mid-run and prove that a fresh process
 * re-attaches to the running detached supervisor and records the result.
 *
 * Invoked as `node --import tsx test/fixtures/qa-service.mjs <action> <json>`:
 * - `run` claims and starts a milestone run, waits for a named step to be in
 *   flight, then exits deliberately (the roll);
 * - `settle` acts as the restarted service: attach and wait for the row to settle.
 *
 * This is not a test file; `npm test` only picks up `test/*.test.ts`.
 */
const action = process.argv[2];
const input = JSON.parse(process.argv[3] ?? "{}");
const { join } = await import("node:path");
const { assertCheckoutAvailable } = await import("../../core/workspaces/checkout-volume.ts");
const { realpath } = await import("node:fs/promises");
const { Store, digest } = await import("../../core/store/store.ts");
const { ProjectQaRunner } = await import("../../core/qa/project-qa.ts");
const { qaSupervisionPaths, readQaSupervision, readQaSupervisionPlan } = await import("../../core/qa/project-qa-supervision-files.ts");

const { scopedQaFixture } = await import("../support/scoped-qa.ts");
const { hostRunProcessStartIdentity } = await import("../../core/machine/start-identity.ts");
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeRunner(input) {
  const runner = new ProjectQaRunner(new Store(input.storePath ?? join(input.dataDir, "queue.sqlite")), {
    dataDir: input.dataDir,
    supervisionPollMs: 100,
    ...(input.fixtureMount ? {
      testPlacement: { dataDir: join(input.fixtureMount, "queue"), admit: target => assertCheckoutAvailable({
        mount: input.fixtureMount, uuid: "fixture", target, observe: () => ({ MountPoint: input.fixtureMount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true }),
      }) },
      supervisorEntry: join(import.meta.dirname, "qa-private-supervisor.mjs"),
    } : {}),
  });
  const scope = scopedQaFixture({ after: () => {} }, [input.dataDir, ...(input.fixtureMount ? [input.fixtureMount] : [])]);
  scope(runner);
  runner.fixtureScope = scope;
  return runner;
}

async function waitForSettle(runner, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runner.store.qaRun(id);
    if (!run || run.state !== "running" && run.state !== "queued") return run;
    await sleep(50);
  }
  return runner.store.qaRun(id);
}

if (action === "run") {
  const runner = makeRunner(input);
  const started = await runner.run({ repository: input.repository });
  let inFlight = null;
  if (input.waitForInFlight) {
    const root = join(await realpath(input.dataDir), "project-qa", digest(started.key).slice(0, 24));
    const { statePath } = qaSupervisionPaths(root, started.id);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && readQaSupervision(statePath)?.inFlight !== input.waitForInFlight) await sleep(50);
    inFlight = readQaSupervision(statePath)?.inFlight ?? null;
  }
  out({ record: runner.store.qaRun(started.id) ?? started });
  if (input.waitForInFlight) out({ inFlight });
  // The roll: the service dies, the detached supervisor keeps running.
  process.exit(0);
}

if (action === "settle") {
  const runner = makeRunner(input);
  const record = runner.store.qaRun(input.id);
  if (record) {
    const root = join(await realpath(input.dataDir), "project-qa", digest(record.key).slice(0, 24));
    const paths = qaSupervisionPaths(root, record.id);
    const plan = readQaSupervisionPlan(paths.planPath);
    const state = readQaSupervision(paths.statePath);
    if (plan && state) runner.fixtureScope.adopt(plan.identityToken, state.pid,
      state.supervisorStartIdentity ?? hostRunProcessStartIdentity(state.pid), paths.planPath);
  }
  await runner.get({ id: input.id });
  out({ record: await waitForSettle(runner, input.id, input.timeoutMs ?? 60_000) });
  process.exit(0);
}

throw new Error(`Unknown QA harness action: ${action}`);
