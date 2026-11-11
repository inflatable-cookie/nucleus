import { observeIdle } from './support/fakes';
import { copyNodeRuntime } from "../scripts/copy-node-runtime.mjs";
/**
 * Spec 035 "Runtime identity": an admitted Effigy run is observed only by the
 * exact artifact bytes the workload itself ran.
 *
 * The failure this file pins down is the default runtime route, not an injected
 * observer: Queue's service used to run bare `effigy` from its own mutable PATH
 * to read a run's journal, while the worker's absolute Effigy CLI ran the
 * workload. Those are different builds unless something proves otherwise, so a
 * drifted or unrelated PATH binary could answer for a run it never executed.
 *
 * Every test here uses the production route: an admission declaration (path plus
 * exact-bytes SHA-256), an admission hook that attests its own ancestry by pid,
 * and the durable binding the endpoint and scheduler record. The last test runs
 * the actual qualified candidate against the actual RuntimeOwner with a lying
 * `effigy` in PATH, and shows the decoy can neither be bound nor observed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { EffigyRunControl } from "../core/qa/effigy-run-control";
import { admissionReservationId, defaultAdmissionHookCommand, queueOwnedAdmissionEnvironment } from "../core/qa/effigy-admission";
import { hostRunAdmissionSocketPath } from "../core/host-runs/host-run-paths";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { processExecutablePath } from "../core/machine/process-identity";
import { QueueRuntime } from "../service/runtime-owner";
import {
  bindEffigyRuntime,
  DIGEST_READ_ATTEMPTS,
  ExecutableDigestCache,
  effigyArtifactDigests,
  verifyEffigyRuntime,
  EffigyVersionProbe,
  effigyRuntimeSettingsSchema,
  meetsEffigyVersionFloor,
  parseEffigyVersion,
  type EffigyRuntimeAncestor,
  type EffigyRuntimeIdentity,
  type EffigyRuntimeSettings,
} from "../core/qa/effigy-runtime";
import { hostRunInternalRecordSchema, hostRunList, type HostRunInternalRecord } from "../shared/contracts";
import { frozenHostRunRecordSchema } from "./support/contract-010-frozen";
import type { Adapter } from "../core/host";

const QUALIFIED_EFFIGY = process.env.NUCLEUS_TEST_QUALIFIED_EFFIGY ?? "";
const QUALIFIED_SHA256 = "dc6a6e9e3829b553d61358db0875ee2fc5d107cd15194a257a6c4560edde8eae";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitUntil(probe: () => boolean, ms: number, label: string | (() => string)): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (probe()) return;
    await pause(40);
  }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

/** One executable fixture artifact, declared by the SHA-256 of its exact bytes. */
function fixtureArtifact(dir: string, name: string, body: string): { path: string; sha256: string } {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return { path, sha256: sha256(readFileSync(path)) };
}

/**
 * A declared artifact this test may replace atomically, plus a live process whose
 * own image is exactly those bytes. The artifact is a copy of the node binary
 * running the tests: a real executable image on every platform (a script's image
 * is its interpreter), and the workload runs it directly.
 */
function declaredWorkload(t: { after: (fn: () => void) => void }, root: string) {
  const path = join(root, "effigy");
  copyNodeRuntime(path);
  const bytes = readFileSync(path);
  chmodSync(path, 0o755);
  const child = spawn(path, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  // The workload only has to be a live image of the declared bytes at the reserve
  // boundary. Stopping it before the artifact is rewritten keeps the host from
  // killing a process whose executable file is being changed underneath it.
  const stop = async () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } await exited; };
  return { bytes, path, sha256: sha256(bytes), child, pid: child.pid!, stop };
}

/**
 * The attested ancestry of a just-spawned workload: its live start identity once
 * its own image is the declared artifact (not the parent's binary, which has the
 * same bytes and is briefly its image before exec).
 */
async function liveWorkloadAncestry(pid: number, declaredPath: string): Promise<EffigyRuntimeAncestor[]> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const identity = hostRunProcessStartIdentity(pid);
    const image = processExecutablePath(pid);
    if (!identity.endsWith("@unknown") && image && realpathSync(image) === realpathSync(declaredPath))
      return [{ pid, startIdentity: identity }];
    await pause(20);
  }
  throw new Error(`pid ${pid} never became a live image of ${declaredPath}`);
}

/** The run journal the bound observer reads: `node run status <id> --json` in the run's cwd. */
function runJournalFixture(project: string, statePath: string): void {
  writeFileSync(join(project, "run"), `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(statePath)}, "utf8"));\n`);
}

/**
 * A producer record that closes one reservation (Spec 035, "Producer closure"):
 * the shipped `RunView` fields plus `run_json`'s selector, for this request's
 * run id and task. A record without them is not closure, so these tests write
 * the same fields the qualified candidate reports.
 */
function closureState(runId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    evidence_source: "checkout-journal", run_id: runId, task: "qa:ci:fast", phase: "closed",
    state: "failed", exit_code: 7, cleanup: "complete",
    started_at_epoch_ms: 1_700_000_000_000, finished_at_epoch_ms: 1_700_000_002_500, duration_ms: 2_500,
    ...overrides,
  });
}

/**
 * Replace one declared artifact atomically: the replacement is staged beside it
 * and renamed over it, so an observation that is reading or spawning the
 * artifact can only ever see one whole version, never a partly written file.
 */
function replaceArtifact(path: string, bytes: Buffer): void {
  const staged = `${path}.next`;
  writeFileSync(staged, bytes);
  chmodSync(staged, 0o755);
  renameSync(staged, path);
}

/** The reasons recorded on a reservation's observation refusals, oldest first. */
function refusalReasons(scheduler: HostRunScheduler, id: string): string[] {
  return scheduler.store.hostRunJournal(id)
    .filter(row => row.event === "effigy_observation_refused")
    .map(row => (row.data as { reason?: string }).reason ?? "");
}

/** What the bound observer would read right now, as a failure message. */
function probeRunJournal(artifactPath: string, project: string): string {
  const result = spawnSync(artifactPath, ["run", "status", "probe", "--json"], { cwd: project, encoding: "utf8", timeout: 5_000 });
  return `${result.status}:${(result.stdout ?? "").trim()}${(result.stderr ?? "").trim()}`;
}

/** A bound executable identity: a path plus the bytes recorded at binding. */
function identity(path: string, hash: string): EffigyRuntimeIdentity {
  return { path, sha256: hash };
}

/**
 * The fixture executables are copies of node or shell scripts, so they do not
 * answer `--version` as Effigy; this probe stands in for that one question and
 * answers only for the named executable (by real path).
 */
function effigyAt(path: string, version = "effigy v0.14.1+local.test") {
  const real = realpathSync(path);
  return (image: string) => { try { return realpathSync(image) === real ? parseEffigyVersion(version) : null; } catch { return null; } };
}

function isolatedScheduler(t: { after: (fn: () => void) => void }): HostRunScheduler {
  const store = new Store(":memory:");
  return new HostRunScheduler(store, {
    capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }),
  });
}

async function isolatedEndpoint(
  t: { after: (fn: () => void | Promise<void>) => void },
  scheduler: HostRunScheduler,
  effigyPath: string | null,
  settings: EffigyRuntimeSettings | null = null,
  watchMs = 20,
): Promise<EffigyAdmissionEndpoint> {
  const root = mkdtempSync(join(tmpdir(), "qri-run-"));
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(root, "host-run"), watchMs, effigyRuntime: settings,
    ...(effigyPath ? { effigyVersion: effigyAt(effigyPath) } : {}),
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  t.after(() => scheduler.store.close());
  return endpoint;
}

const admissionRequest = (runId: string, cwd: string) => ({
  schema: "effigy.admission-request.v1" as const,
  run_id: runId,
  task: "qa:ci:fast",
  class: "heavy" as const,
  cwd,
  root: cwd,
});

/** A pid this process started and reaped: alive to nobody, so "hook died" is observed. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  return pid;
}

const startIdentityFor = (pid: number) => `${pid}@1999-01-01T00:00:00Z`;

test("Effigy runtime settings: the retired exact-bytes pin still parses and is ignored; minVersion is major.minor.patch", () => {
  assert.deepEqual(effigyRuntimeSettingsSchema.parse({ path: "/old/effigy", sha256: "a".repeat(64) }), { path: "/old/effigy", sha256: "a".repeat(64) });
  assert.deepEqual(effigyRuntimeSettingsSchema.parse({ minVersion: "0.14.0" }), { minVersion: "0.14.0" });
  assert.deepEqual(effigyRuntimeSettingsSchema.parse({}), {});
  assert.equal(effigyRuntimeSettingsSchema.safeParse({ minVersion: "0.14" }).success, false);
  assert.equal(effigyRuntimeSettingsSchema.safeParse({ minVersion: "0.14.1+local.x" }).success, false);
  assert.equal(effigyRuntimeSettingsSchema.safeParse({ unknown: true }).success, false, "anything else stays strict");
  const version = parseEffigyVersion("effigy v0.14.1+local.9adacdd\n")!;
  assert.deepEqual([version.major, version.minor, version.patch, version.text], [0, 14, 1, "0.14.1+local.9adacdd"]);
  assert.equal(parseEffigyVersion("GNU bash, version 5.2.37"), null);
  assert.equal(parseEffigyVersion("v22.23.2"), null);
  assert.equal(meetsEffigyVersionFloor(version, "0.14.1"), true);
  assert.equal(meetsEffigyVersionFloor(version, "0.14.2"), false);
  assert.equal(meetsEffigyVersionFloor(version, "0.9.9"), true);
});

test("the version probe is asynchronous, asked once per image identity, coalesced, and asked again after a rebuild", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, "calls");
  const count = () => existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
  const image = fixtureArtifact(root, "effigy", `#!/bin/sh\nprintf '1\\n' >> '${calls}'\necho "effigy v0.14.1+local.test"\n`);
  const probe = new EffigyVersionProbe();
  const ancestor: EffigyRuntimeAncestor = { pid: 4242, startIdentity: startIdentityFor(4242) };
  const admit = () => bindEffigyRuntime({
    settings: null, ancestry: [ancestor], liveStartIdentity: () => startIdentityFor(4242),
    executablePath: () => image.path, probeVersion: path => probe.version(path),
  });

  // Two admissions on the same image ask it once.
  for (const _ of [1, 2]) {
    const bound = await admit();
    assert.equal(bound.kind, "bound");
    if (bound.kind === "bound") assert.equal(bound.version, "0.14.1+local.test");
  }
  assert.equal(count(), 1, "the image really ran --version once");
  assert.equal(probe.calls, 1);

  // Concurrent questions about one identity share one call.
  const fresh = new EffigyVersionProbe();
  const answers = await Promise.all([fresh.version(image.path), fresh.version(image.path), fresh.version(image.path)]);
  assert.deepEqual(answers.map(answer => answer?.text), ["0.14.1+local.test", "0.14.1+local.test", "0.14.1+local.test"]);
  assert.equal(fresh.calls, 1, "three concurrent questions, one call");

  // A rebuild (new mtime) is a new identity and is asked again.
  const later = new Date(Date.now() + 60_000);
  utimesSync(image.path, later, later);
  assert.equal((await admit()).kind, "bound");
  assert.equal(probe.calls, 2, "a changed image identity probes again");
  assert.equal(count(), 3, "one call for the first probe, one for the concurrent probe, one after the rebuild");

  // An image that does not answer as Effigy is remembered as such; a failed call is not.
  const shell = fixtureArtifact(root, "bash-like", "#!/bin/sh\necho 'GNU bash, version 5'\n");
  assert.equal(await probe.version(shell.path), null);
  assert.equal(await probe.version(shell.path), null);
  assert.equal(probe.calls, 3, "a non-Effigy answer is cached");
  const failing = new EffigyVersionProbe({ ask: async () => ({ answered: false }) });
  assert.equal(await failing.version(image.path), null);
  assert.equal(await failing.version(image.path), null);
  assert.equal(failing.calls, 2, "a failed or timed-out call is asked again next time");

  // The cache is bounded and evicts the least recently used identity.
  const bounded = new EffigyVersionProbe({ limit: 1, ask: async () => ({ answered: true, stdout: "effigy v1.0.0" }) });
  await bounded.version(image.path);
  await bounded.version(shell.path);
  await bounded.version(image.path);
  assert.equal(bounded.calls, 3, "with room for one, alternating images re-ask");
});

test("verification reports missing, drifted, re-pointed and non-executable executables", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-art-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = fixtureArtifact(root, "effigy", "#!/bin/sh\necho original\n");

  assert.deepEqual(await verifyEffigyRuntime(identity(artifact.path, artifact.sha256)),
    { kind: "verified", identity: { path: realpathSync(artifact.path), sha256: artifact.sha256 } });

  // Rewritten in place: the path still resolves, the bytes are not the declared bytes.
  writeFileSync(artifact.path, "#!/bin/sh\necho replaced\n");
  const drifted = await verifyEffigyRuntime(identity(artifact.path, artifact.sha256));
  assert.equal(drifted.kind, "drift");
  if (drifted.kind === "drift") {
    assert.match(drifted.reason, new RegExp(artifact.sha256), "the drift names the bound bytes");
    assert.match(drifted.reason, new RegExp(sha256("#!/bin/sh\necho replaced\n")), "and the observed bytes");
  }

  // Re-pointed symlink: same declared path, different artifact behind it.
  const declaredLink = join(root, "effigy-link");
  const original = fixtureArtifact(root, "original", "#!/bin/sh\necho original\n");
  const other = fixtureArtifact(root, "other", "#!/bin/sh\necho other\n");
  symlinkSync(original.path, declaredLink);
  assert.equal((await verifyEffigyRuntime(identity(declaredLink, original.sha256))).kind, "verified");
  rmSync(declaredLink);
  symlinkSync(other.path, declaredLink);
  const rePointed = await verifyEffigyRuntime(identity(declaredLink, original.sha256));
  assert.equal(rePointed.kind, "drift");
  if (rePointed.kind === "drift") assert.equal(rePointed.reason.includes(other.sha256), true);

  // A dangling declared path is unavailable, never "close enough".
  assert.equal((await verifyEffigyRuntime(identity(join(root, "absent"), original.sha256))).kind, "unavailable");
  // A directory or a file with no execute bit cannot be the runtime either.
  assert.equal((await verifyEffigyRuntime(identity(root, original.sha256))).kind, "unavailable");
  const plain = join(root, "plain.txt");
  writeFileSync(plain, "#!/bin/sh\necho plain\n");
  assert.equal((await verifyEffigyRuntime(identity(plain, sha256(readFileSync(plain))))).kind, "unavailable");
});

/** One promise a fixture resolves at a known point inside a read. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("one unchanged artifact is read once across repeated verifications, and each declaration is compared separately", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-cost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = "#!/bin/sh\necho once\n";
  const artifact = fixtureArtifact(root, "effigy", body);

  // The default reader, through the default verifier: one read for one identity.
  effigyArtifactDigests.resetCosts();
  for (let check = 0; check < 5; check++)
    assert.deepEqual(await verifyEffigyRuntime(identity(artifact.path, artifact.sha256)),
      { kind: "verified", identity: { path: realpathSync(artifact.path), sha256: artifact.sha256 } });
  const remembered = effigyArtifactDigests.costs();
  assert.equal(remembered.hashed, 1, "the unchanged artifact's bytes are read once");
  assert.equal(remembered.reused, 4, "every later before/after check is answered from that identity");
  assert.equal(remembered.bytesRead, Buffer.byteLength(body));

  // A second expectation is not blessed by the first one's success: it is
  // compared with the digest Queue read, and it costs no new read.
  const other = await verifyEffigyRuntime(identity(artifact.path, sha256("#!/bin/sh\necho other\n")));
  assert.equal(other.kind, "drift");
  assert.equal(effigyArtifactDigests.costs().hashed, 1, "a mismatched expectation reuses the bytes it compares against");

  // The parent's shape: a check that remembers nothing reads the whole artifact
  // every time. Same hashing route, no reuse.
  let readEveryTime = 0;
  for (let check = 0; check < 3; check++) {
    const fresh = new ExecutableDigestCache();
    await verifyEffigyRuntime(identity(artifact.path, artifact.sha256), path => fresh.digest(path));
    readEveryTime += fresh.costs().hashed;
  }
  assert.equal(readEveryTime, 3, "without a remembered identity each verification reads the file again");
});

test("a rewritten, replaced or de-executed artifact is re-read rather than reused", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-move-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new ExecutableDigestCache();
  const body = "#!/bin/sh\necho original\n";
  const artifact = fixtureArtifact(root, "effigy", body);
  assert.deepEqual(await cache.digest(artifact.path),
    { kind: "ok", path: realpathSync(artifact.path), sha256: artifact.sha256 });

  // Same size, restored mtime: only ctime can tell, and ctime is in the identity.
  const { atime, mtime } = statSync(artifact.path);
  const sameSize = "#!/bin/sh\necho replaced\n";
  assert.equal(Buffer.byteLength(sameSize), Buffer.byteLength(body), "the rewrite keeps the size");
  writeFileSync(artifact.path, sameSize);
  utimesSync(artifact.path, atime, mtime);
  const rewritten = await cache.digest(artifact.path);
  assert.equal(rewritten.kind, "ok");
  if (rewritten.kind === "ok")
    assert.equal(rewritten.sha256, sha256(sameSize), "a same-size rewrite with the declared mtime back is read again");

  // An atomic replacement is a new inode, even when the bytes are identical.
  replaceArtifact(artifact.path, Buffer.from(sameSize));
  const replaced = await cache.digest(artifact.path);
  assert.equal(replaced.kind, "ok");
  if (replaced.kind === "ok") assert.equal(replaced.sha256, sha256(sameSize));

  // Losing the execute bit is refused, and no refusal is remembered.
  chmodSync(artifact.path, 0o644);
  assert.equal((await cache.digest(artifact.path)).kind, "not-executable");
  assert.equal(cache.costs().hashed, 3, "an unreadable-as-executable artifact is refused before its bytes are read");
  chmodSync(artifact.path, 0o755);
  assert.equal((await cache.digest(artifact.path)).kind, "ok");
  // A mode change moves ctime, so the restored file is a new identity and is
  // read as itself rather than answered from the earlier bytes.
  assert.equal(cache.costs().hashed, 4, "the recovery read belongs to the file's current identity");
});

test("a symlink retarget is answered by the bytes it names now", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new ExecutableDigestCache();
  const first = fixtureArtifact(root, "a", "#!/bin/sh\necho a\n");
  const second = fixtureArtifact(root, "b", "#!/bin/sh\necho b\n");
  const link = join(root, "effigy");
  symlinkSync(first.path, link);
  const before = await cache.digest(link);
  assert.equal(before.kind, "ok");
  if (before.kind === "ok") {
    assert.equal(before.sha256, first.sha256);
    assert.equal(before.path, realpathSync(first.path), "the identity names the file the link resolves to");
  }
  rmSync(link);
  symlinkSync(second.path, link);
  const retargeted = await cache.digest(link);
  assert.equal(retargeted.kind, "ok");
  if (retargeted.kind === "ok") assert.equal(retargeted.sha256, second.sha256, "the retargeted link is read as its new target");
  assert.equal(cache.costs().hashed, 2);
  // A link that names nothing is missing, never "close enough".
  rmSync(link);
  assert.equal((await cache.digest(link)).kind, "missing");
});

test("missing and unreadable artifacts are refusals, never remembered answers", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new ExecutableDigestCache();
  const absent = join(root, "effigy");
  assert.equal((await cache.digest(absent)).kind, "missing");
  // Once it exists it is read on its own evidence, not on the earlier refusal.
  writeFileSync(absent, "#!/bin/sh\necho later\n");
  chmodSync(absent, 0o755);
  assert.equal((await cache.digest(absent)).kind, "ok");
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    // A file this process cannot read is refused now and observed again after.
    chmodSync(absent, 0o000);
    assert.equal((await cache.digest(absent)).kind, "unreadable");
    chmodSync(absent, 0o755);
    assert.equal((await cache.digest(absent)).kind, "ok");
  }
  assert.equal((await cache.digest(root)).kind, "not-executable", "a directory can never be the runtime");
});

test("the digest cache is bounded and evicts the least recently used identity", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-bound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new ExecutableDigestCache({ limit: 2 });
  const artifacts = ["one", "two", "three"].map(name => fixtureArtifact(root, name, `#!/bin/sh\necho ${name}\n`));
  await cache.digest(artifacts[0].path);
  await cache.digest(artifacts[1].path);
  await cache.digest(artifacts[0].path); // the second identity is now the least recently used
  await cache.digest(artifacts[2].path);
  assert.equal(cache.size(), 2, "the cache keeps only its configured entries");
  assert.deepEqual({ hashed: cache.costs().hashed, reused: cache.costs().reused }, { hashed: 3, reused: 1 });
  await cache.digest(artifacts[0].path);
  assert.equal(cache.costs().hashed, 3, "the most recently used identity is still remembered");
  await cache.digest(artifacts[1].path);
  assert.equal(cache.costs().hashed, 4, "the evicted identity is read again rather than guessed");
});

test("a read that keeps losing its file to a rewrite, a swap or a retarget refuses instead of publishing a mixed digest", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = "#!/bin/sh\necho stable\n";
  const artifact = fixtureArtifact(root, "effigy", body);

  // Same-size rewrites while the bytes are being read, on every read of the call
  // (then none: the recovery read below is an ordinary read of the file there).
  let racing = true, rewrites = 0;
  const rewritten = new ExecutableDigestCache({
    beforeRead: () => {
      if (!racing) return;
      rewrites += 1;
      writeFileSync(artifact.path, "#!/bin/sh\necho tamper\n");
    },
  });
  const refused = await rewritten.digest(artifact.path);
  assert.equal(refused.kind, "unreadable");
  if (refused.kind === "unreadable") assert.match(refused.reason, /changed while its bytes were read/);
  assert.equal(rewrites, DIGEST_READ_ATTEMPTS, "the read restarts a bounded number of times");
  assert.equal(rewritten.size(), 0, "a refused read remembers nothing");
  racing = false;
  const recovered = await rewritten.digest(artifact.path);
  assert.equal(recovered.kind, "ok");
  if (recovered.kind === "ok")
    assert.equal(recovered.sha256, sha256("#!/bin/sh\necho tamper\n"), "the bytes there now are read as themselves");
  assert.equal(rewritten.costs().hashed, DIGEST_READ_ATTEMPTS + 1);

  // Atomic replacements while the bytes are being read: the descriptor still
  // names the old file, so its digest may not be published as the path's.
  const swapped = new ExecutableDigestCache({
    beforeRead: () => { replaceArtifact(artifact.path, Buffer.from("#!/bin/sh\necho other\n")); },
  });
  const moved = await swapped.digest(artifact.path);
  assert.equal(moved.kind, "unreadable");
  if (moved.kind === "unreadable") assert.match(moved.reason, /changed while its bytes were read/);
  assert.equal(swapped.size(), 0);

  // A symlink re-pointed on every read of the call, always to a file not yet read.
  const other = fixtureArtifact(root, "other", "#!/bin/sh\necho other\n");
  const targets = [fixtureArtifact(root, "third", "#!/bin/sh\necho third\n"), fixtureArtifact(root, "fourth", "#!/bin/sh\necho fourth\n"), artifact];
  const link = join(root, "effigy-link");
  symlinkSync(other.path, link);
  const retargeted = new ExecutableDigestCache({
    beforeRead: () => { rmSync(link); symlinkSync(targets.shift()!.path, link); },
  });
  const rePointed = await retargeted.digest(link);
  assert.equal(rePointed.kind, "unreadable");
  if (rePointed.kind === "unreadable") assert.match(rePointed.reason, /now resolves to/);
});

test("one rebuild during a read answers with the bytes there now, and never with the earlier file's", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-race-once-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = fixtureArtifact(root, "effigy", "#!/bin/sh\necho before\n");
  const rebuilt = "#!/bin/sh\necho rebuilt\n";
  let raced = false;
  const cache = new ExecutableDigestCache({
    beforeRead: () => {
      if (raced) return;
      raced = true;
      replaceArtifact(artifact.path, Buffer.from(rebuilt));
    },
  });
  const answer = await cache.digest(artifact.path);
  assert.equal(answer.kind, "ok", JSON.stringify(answer));
  if (answer.kind === "ok") assert.equal(answer.sha256, sha256(rebuilt));
  assert.equal(cache.costs().hashed, 2, "the lost read and the read of the new file");
  assert.equal(cache.size(), 1, "the lost read is not remembered under the new file");
});

test("concurrent checks of one unchanged identity share one read and each compare their own expectation", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-share-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = "#!/bin/sh\necho shared\n";
  const artifact = fixtureArtifact(root, "effigy", body);
  const gate = deferred();
  const cache = new ExecutableDigestCache({ beforeRead: () => gate.promise });
  const correct = identity(artifact.path, artifact.sha256);
  const wrong = identity(artifact.path, sha256("#!/bin/sh\necho wrong\n"));
  const checks = [
    ...Array.from({ length: 4 }, () => verifyEffigyRuntime(correct, path => cache.digest(path))),
    verifyEffigyRuntime(wrong, path => cache.digest(path)),
  ];
  await pause(100); // every check is now waiting on the one read
  gate.resolve();
  const answers = await Promise.all(checks);
  assert.deepEqual(answers.slice(0, 4).map(answer => answer.kind), ["verified", "verified", "verified", "verified"]);
  assert.equal(answers[4].kind, "drift",
    "the mismatched declaration is compared with the bytes, not with another caller's verdict");
  const costs = cache.costs();
  assert.equal(costs.hashed, 1, "one read serves every concurrent check");
  assert.equal(costs.reused, 4);
  assert.equal(costs.bytesRead, Buffer.byteLength(body));
});

test("binding takes the workload's own Effigy from its attested ancestry, never a declared path", async () => {
  const ancestor: EffigyRuntimeAncestor = { pid: 4242, startIdentity: startIdentityFor(4242) };
  const launcher: EffigyRuntimeAncestor = { pid: 4241, startIdentity: startIdentityFor(4241) };
  const images: Record<number, string> = { 4241: "/bin/bash", 4242: "/workspace/user/effigy/.local-install/bin/effigy" };
  const digest = async (path: string) => ({ kind: "ok" as const, path, sha256: path === images[4242] ? "a".repeat(64) : "b".repeat(64) });
  const live = (pid: number) => startIdentityFor(pid);
  const probe = (path: string) => path === images[4242] ? parseEffigyVersion("effigy v0.14.1+local.9adacdd") : null;
  const base = { digest, liveStartIdentity: live, executablePath: (pid: number) => images[pid] ?? null, probeVersion: probe };

  assert.equal((await bindEffigyRuntime({ settings: null, ancestry: [] })).kind, "unbound");

  // No settings at all is the normal state: the hook's Effigy ancestor binds,
  // past a launcher-shaped bash ancestor that does not answer as Effigy.
  const bound = await bindEffigyRuntime({ ...base, settings: null, ancestry: [launcher, ancestor] });
  assert.equal(bound.kind, "bound");
  if (bound.kind === "bound") {
    assert.deepEqual(bound.identity, { path: images[4242], sha256: "a".repeat(64) });
    assert.equal(bound.version, "0.14.1+local.9adacdd");
    assert.equal(bound.workloadPath, images[4242]);
    assert.equal(bound.workloadPid, 4242);
  }

  // A retired exact-bytes pin is ignored: different declared bytes bind anyway.
  const legacy = await bindEffigyRuntime({ ...base, settings: { path: "/artifacts/qualified/effigy", sha256: "c".repeat(64) }, ancestry: [ancestor] });
  assert.equal(legacy.kind, "bound");

  // No ancestor answers as Effigy: nothing is bound, and the reason says why.
  const none = await bindEffigyRuntime({ ...base, settings: null, ancestry: [launcher] });
  assert.equal(none.kind, "unbound");
  if (none.kind === "unbound") {
    assert.match(none.reason, /no identifiable Effigy ancestor/);
    assert.match(none.reason, /\/bin\/bash, which does not answer as Effigy/);
  }

  // A recycled or vanished ancestor pid is never trusted, even if its image would answer.
  const stale = await bindEffigyRuntime({ ...base, settings: null, ancestry: [ancestor], liveStartIdentity: () => `${4242}@2001-02-03T04:05:06Z` });
  assert.equal(stale.kind, "unbound");
  if (stale.kind === "unbound") assert.match(stale.reason, /gone or reused/);

  // minVersion compares major.minor.patch and ignores build metadata.
  for (const [floor, kind] of [["0.14.1", "bound"], ["0.14.0", "bound"], ["0.13.9", "bound"], ["0.14.2", "unbound"], ["1.0.0", "unbound"]] as const) {
    const answer = await bindEffigyRuntime({ ...base, settings: { minVersion: floor }, ancestry: [ancestor] });
    assert.equal(answer.kind, kind, `floor ${floor}`);
    if (answer.kind === "unbound") assert.match(answer.reason, new RegExp(`Effigy 0\\.14\\.1\\+local\\.9adacdd .*below the configured minimum ${floor.replaceAll(".", "\\.")}`));
  }
});

test("an observation client keeps running its bound path after a rebuild, recording drift, and refuses only an unusable executable", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-ctl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = fixtureArtifact(root, "effigy", `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  echo "effigy run --run-id <key>"
  echo "  logs --follow --stdout-offset --stderr-offset"
  exit 0
fi
if [ "$2" = "status" ]; then
  echo '{"schema":"effigy.command.v1","ok":true,"result":{"schema":"effigy.run.v1","run":{"evidence_source":"checkout-journal","run_id":"run-1","task":"qa:stage:rust","state":"succeeded","phase":"closed","exit_code":0,"cleanup":"complete"}}}'
  exit 0
fi
echo "log-body"
exit 0
`);
  const client = new EffigyRunControl({
    runtime: { path: artifact.path, sha256: artifact.sha256 }, cwd: root, timeoutMs: 5_000,
  });
  assert.equal(await client.probeCapability(), "v015-run-control");
  assert.equal((await client.status("run-1")).kind, "closed");

  assert.equal(client.drift, null, "unchanged bytes record no drift");

  // Effigy rebuilt in place: the same path is still the workload's Effigy, so the
  // client runs it and keeps the change as provenance (Spec 035, Tom 2026-10-26).
  writeFileSync(artifact.path, `#!/bin/sh
if [ "$2" = "status" ]; then
  echo '{"schema":"effigy.command.v1","ok":true,"result":{"schema":"effigy.run.v1","run":{"evidence_source":"checkout-journal","run_id":"run-1","task":"qa:stage:rust","state":"failed","phase":"closed","exit_code":3,"cleanup":"complete"}}}'
  exit 0
fi
echo "rebuilt"
exit 0
`);
  const rebuilt = await client.status("run-1");
  assert.equal(rebuilt.kind, "closed", "a rebuilt Effigy still observes");
  assert.match(client.drift ?? "", new RegExp(`bound ${artifact.sha256}`), "the drift is recorded as provenance");

  // An executable that cannot run is still a refusal, and nothing is spawned.
  rmSync(artifact.path);
  const refused = await client.status("run-1");
  assert.equal(refused.kind, "unknown");
  if (refused.kind === "unknown") assert.match(refused.reason, /is unavailable/);
  const follow = await client.followLogs("run-1", { stdout: 0, stderr: 0 });
  assert.equal(follow.identityRefusal === null, false);
  assert.equal(follow.stdout, "", "a refused follow spawns nothing");
  assert.equal(follow.exitCode, null);
});

test("an Effigy rebuilt in place during the lifecycle still observes, records the drift once, and retires accounting on the real result", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify({ state: "running" }));
  const artifact = declaredWorkload(t, root);
  runJournalFixture(project, statePath);
  const scheduler = isolatedScheduler(t);
  const endpoint = await isolatedEndpoint(t, scheduler, artifact.path);

  const ancestry = await liveWorkloadAncestry(artifact.pid, artifact.path);
  const dead = await deadPid();
  const reserved = await endpoint.reserve(admissionRequest("drift-run", project), ancestry);
  const id = reserved.reservationId!;
  endpoint.bindHook(id, dead, startIdentityFor(dead));
  assert.equal(scheduler.get(id)?.effigyRuntime?.sha256, artifact.sha256,
    "the reserve bound the workload's own image before it reserved");
  assert.equal(scheduler.get(id)?.effigyRuntime?.path, realpathSync(artifact.path));
  assert.equal(scheduler.get(id)?.effigyRuntime?.version, "0.14.1+local.test");

  await waitUntil(() => scheduler.get(id)?.state === "running", 2_000, "reservation running");
  await pause(150);
  assert.equal(scheduler.get(id)?.capacityReleasedAt, null, "a live run keeps its slot");

  // Rebuilt in place under a live reservation, then the run finishes: the same
  // path observes the producer's closure and retires the accounting.
  await endpoint.stop();
  await artifact.stop();
  replaceArtifact(artifact.path, Buffer.concat([artifact.bytes, Buffer.from("\n# rebuilt\n")]));
  // A watch started before stop() may still be reading the producer journal.
  // Publish one complete record, as with the executable replacement above;
  // truncating the live file can manufacture an unrelated observation refusal.
  const nextState = `${statePath}.next`;
  writeFileSync(nextState, closureState("drift-run"));
  renameSync(nextState, statePath);
  await endpoint.start();
  await waitUntil(() => scheduler.get(id)?.state === "settled", 8_000, () => `the real terminal result settles the reservation (${JSON.stringify({
    state: scheduler.get(id)?.state,
    journal: scheduler.store.hostRunJournal(id).map(row => row.event),
    probe: probeRunJournal(artifact.path, project),
  })})`);
  const observed = scheduler.get(id)!;
  assert.equal(observed.settlement?.outcome, "lost", "an admission's settlement claims nothing about the workload");
  assert.equal(observed.settlement?.result, null, "no result is written for an admission");
  assert.equal(observed.effigyRuntime?.sha256, artifact.sha256, "the binding keeps the bytes the workload ran");
  const retirement = scheduler.accountingStatus(id)!.disposition as Record<string, any>;
  assert.equal(retirement.producer.exitCode, 7, "the producer's own exit code is the evidence");
  const drifts = scheduler.store.hostRunJournal(id).filter(row => row.event === "effigy_runtime_drift");
  assert.equal(drifts.length, 1, "the rebuild is recorded once, as provenance");
  assert.match(JSON.stringify(drifts[0].data), new RegExp(`bound ${artifact.sha256}`));
  const rebuildRefusals = scheduler.store.hostRunJournal(id)
    .filter(row => row.event === "effigy_observation_refused")
    .filter(row => (row.data as { kind?: string }).kind !== "hook-liveness-unknown");
  assert.equal(rebuildRefusals.length, 0, `a rebuild is never an observation refusal: ${JSON.stringify(rebuildRefusals)}`);
  assert.equal(scheduler.store.hostRunJournal(id).filter(row => row.event === "accounting_retirement").length, 1);
});

test("a restarted endpoint reattaches to the recorded binding and retires the accounting once", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-again-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify({ state: "running" }));
  const artifact = declaredWorkload(t, root);
  runJournalFixture(project, statePath);
  const scheduler = isolatedScheduler(t);
  t.after(() => scheduler.store.close());
  const stateDir = join(root, "host-run");
  const first = new EffigyAdmissionEndpoint(scheduler, {
    stateDir, watchMs: 20, effigyVersion: effigyAt(artifact.path),
  });
  await first.start();

  const request = admissionRequest("recovery-run", project);
  const ancestry = await liveWorkloadAncestry(artifact.pid, artifact.path);
  const reserved = await first.reserve(request, ancestry);
  const id = reserved.reservationId!;
  assert.equal(scheduler.get(id)?.effigyRuntime?.sha256, artifact.sha256);
  const dead = await deadPid();
  first.bindHook(id, dead, startIdentityFor(dead));
  assert.equal((await first.reserve(request, ancestry)).reservationId, id, "a repeated reserve is the same durable reservation");
  assert.equal(scheduler.list().length, 1, "the run id keys one reservation");
  await first.stop();

  // Effigy is rebuilt while no endpoint serves; a fresh endpoint on the same
  // state directory reattaches through the recorded binding path with no
  // settings of its own, and the run then really finishes.
  await artifact.stop();
  replaceArtifact(artifact.path, Buffer.concat([artifact.bytes, Buffer.from("\n# rebuilt\n")]));
  const second = new EffigyAdmissionEndpoint(scheduler, { stateDir, watchMs: 20 });
  await second.start();
  t.after(async () => { await second.stop(); });
  await pause(150);
  assert.equal(scheduler.get(id)?.state, "running", "a reattached endpoint invents no result");
  assert.equal(scheduler.get(id)?.capacityReleasedAt, null);
  writeFileSync(statePath, closureState("recovery-run", { exit_code: 3 }));
  await waitUntil(() => scheduler.accountingStatus(id)?.accounting === "retired", 8_000, () => `the reattached endpoint retires the accounting (${JSON.stringify({
    state: scheduler.get(id)?.state,
    journal: scheduler.store.hostRunJournal(id).map(row => row.event),
    refusal: (scheduler.store.hostRunJournal(id).filter(row => row.event === "effigy_observation_refused").at(-1)?.data as { reason?: string } | undefined)?.reason ?? null,
    probe: probeRunJournal(artifact.path, project),
  })})`);
  const retirement = scheduler.accountingStatus(id)!.disposition as Record<string, any>;
  assert.equal(retirement.producer.exitCode, 3, "the reattached observation is the run's own verdict");
  // The producer's closure and the gone hook settle the reservation through the
  // ordinary path; no result is written and the charge stops once.
  await waitUntil(() => scheduler.get(id)?.state === "settled", 8_000,
    () => `the reattached reservation settles (${JSON.stringify(scheduler.store.hostRunJournal(id).map(row => row.event))})`);
  assert.equal(scheduler.get(id)?.settlement?.outcome, "lost");
  assert.equal(scheduler.get(id)?.settlement?.result, null, "no result is written");
  assert.equal(scheduler.store.hostRunJournal(id).filter(row => row.event === "settlement").length, 1);
  assert.equal(scheduler.store.hostRunJournal(id).filter(row => row.event === "accounting_retirement").length, 1);
  assert.equal(scheduler.store.hostRunJournal(id).filter(row => row.event === "effigy_observation").length, 1);
  assert.equal(scheduler.list().length, 1, "no second reservation or duplicate launch authority");
});

test("records written before the binding existed stay readable and keep custody", async t => {
  const root = mkdtempSync(join(tmpdir(), "qri-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const artifact = fixtureArtifact(root, "effigy", "#!/bin/sh\necho '{\"state\":\"succeeded\",\"exit_code\":0}'\n");
  const scheduler = isolatedScheduler(t);
  const endpoint = await isolatedEndpoint(t, scheduler, artifact.path);

  // An admission row persisted by the previous Queue build: schema-valid, and no
  // `effigyRuntime`/`effigyRuntimeRefusal` at all. No qualification is synthesized.
  const legacy = hostRunInternalRecordSchema.parse({
    id: admissionReservationId("legacy-run"), epoch: 1, submissionSource: "admission", effigyRunId: "legacy-run",
    caller: "queue:effigy-admission", clientRequestId: "legacy-client-request",
    repository: { origin: null, path: project }, selector: "qa:ci:fast",
    runClass: "heavy", classSource: "manifest", priority: "interactive", state: "running",
    submittedAt: new Date(Date.now() - 60_000).toISOString(),
    capacityDeadlineAt: new Date(Date.now() + 1_800_000).toISOString(),
    runTimeoutMs: 86_400_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000_000 },
    budget: { cpu: 1, memoryBytes: 1_000_000, wallMs: null, source: "fallback" },
    position: null, admittedAt: new Date(Date.now() - 59_000).toISOString(),
    launchedAt: new Date(Date.now() - 58_000).toISOString(), settledAt: null,
    capacitySample: null, pid: null, processGroupId: null, startIdentity: null,
    settlement: null, wallMs: null, cpuMs: null, containers: [],
    capacityReleasedAt: null, capacityReleaseReason: null,
  });
  assert.equal("effigyRuntime" in legacy, false);
  // Persisted exactly as the build that carried these fields in the record
  // wrote it: Queue reads that row, and an older strict reader cannot (see the
  // wire-contract test), which is the rollback limitation, not a rewrite.
  scheduler.store.db.prepare("INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)")
    .run(legacy.id, project, legacy.state, JSON.stringify(legacy));
  const read = scheduler.get(legacy.id)!;
  assert.equal(read.id, legacy.id, "an old row still parses");
  assert.equal(read.submissionSource, "admission", "its internal source comes from the row itself");
  assert.equal(read.effigyRunId, "legacy-run");

  const dead = await deadPid();
  endpoint.bindHook(legacy.id, dead, startIdentityFor(dead));
  await waitUntil(() => scheduler.store.hostRunJournal(legacy.id).some(row => row.event === "effigy_observation_refused"),
    3_000, "an unbound legacy reservation refuses observation");
  const after = scheduler.get(legacy.id)!;
  // A row with no verified runtime can never be observed, so its exit is
  // unobservable: it settles `lost` with the refusal named, and invents no result.
  assert.equal(after.state, "settled", "an unobservable exit settles");
  assert.equal(after.settlement?.outcome, "lost");
  assert.equal(after.settlement?.result, null, "and no result is invented for it");
  assert.equal(after.capacityReleasedAt, after.settledAt, "the settlement records its own release");
  assert.equal(after.effigyRuntime, undefined);
  const note = scheduler.store.hostRunJournal(legacy.id).find(row => row.event === "effigy_observation_refused");
  assert.match(JSON.stringify(note?.data), /no verified Effigy runtime identity/);
});

function fakeAdapter(dir: string): Adapter {
  return {
    client: { isConnected: true },
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "worker-helper.mjs"),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [],
    observe: observeIdle("ws", "worker"),
  } as unknown as Adapter;
}

function privateEnv(home: string, decoyDir: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { HOME: home, TMPDIR: home, LANG: "C", PATH: `${decoyDir}:/usr/bin:/bin`, ...extra };
}

interface Tracked {
  child: ChildProcess;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  output: () => string;
}

function spawnTracked(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  t: { after: (fn: () => void) => void }): Tracked {
  const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, options.timeoutMs);
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", error => { clearTimeout(timer); resolve({ code: null, stdout: `${stdout}${String(error)}`, stderr }); });
  });
  return { child, done, output: () => `${stdout}${stderr}` };
}

interface LiveQueue {
  runtime: QueueRuntime;
  socketPath: string;
  dataDir: string;
  hostRunStateDir: string;
}

/** The one admission reservation this Queue accepted, whatever Effigy keyed it by. */
function admissionReservation(runtime: QueueRuntime): HostRunInternalRecord | undefined {
  return runtime.hostRuns.list().filter(run => run.submissionSource === "admission").at(-1);
}

/** The real RuntimeOwner, serving its own admission socket with the given Effigy runtime settings. */
async function liveQueue(
  t: { after: (fn: () => void | Promise<void>) => void },
  effigyRuntime: EffigyRuntimeSettings | null,
  home: string,
): Promise<LiveQueue> {
  // Keep the socket path below macOS's Unix-domain path limit when TMPDIR is
  // the queue-owned scratch root.
  const root = mkdtempSync(join(tmpdir(), "ql-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const hostRunStateDir = join(root, "host-run");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const runtime = new QueueRuntime({
    dataDir, hostRunStateDir, hostRunEndpoint: true, timers: false,
    adapterFactory: () => fakeAdapter(dataDir),
    settings: { daemonUrl: "ws://127.0.0.1:6767/ws", ...(effigyRuntime ? { effigyRuntime } : {}) },
    // The observer reads the run journal from the workload's own host environment.
    effigyEnvironment: { ...process.env, HOME: home, TMPDIR: home },
  });
  t.after(() => runtime.drain());
  await runtime.hostRunReady;
  return { runtime, socketPath: hostRunAdmissionSocketPath(hostRunStateDir), dataDir, hostRunStateDir };
}

test("the live default route binds the workload's own Effigy, never a declared or PATH substitute, and enforces minVersion", async t => {
  if (!existsSync(QUALIFIED_EFFIGY)) {
    t.skip(`qualified Effigy candidate missing at ${QUALIFIED_EFFIGY}`);
    return;
  }
  assert.equal(sha256(readFileSync(QUALIFIED_EFFIGY)), QUALIFIED_SHA256,
    "qualified candidate bytes must match the owner packet before use");

  const root = mkdtempSync(join(tmpdir(), "qri-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const decoyDir = join(root, "decoy-bin");
  mkdirSync(decoyDir, { recursive: true });
  // The unqualified bytes a mutable PATH would have handed the old default
  // observer: they answer every `run status` with an unearned success.
  const decoy = fixtureArtifact(decoyDir, "effigy", `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "--status-does-not-exist" ]; then exit 2; fi
if [ "$2" = "status" ]; then
  echo '{"schema":"effigy.command.v1","ok":true,"result":{"schema":"effigy.run.v1","run":{"state":"succeeded","exit_code":0}}}'
  exit 0
fi
exit 2
`);
  const decoySays = spawnSyncPath(decoy.path, ["run", "status", "whoever", "--json"]);
  assert.match(decoySays, /"state":"succeeded"/, "the substitute really does claim success for any run");

  // 1. A minVersion above the workload's Effigy refuses the admission before it
  //    reserves: no reservation, no capacity, and the workload never starts.
  const substitutedHome = join(root, "home-a");
  mkdirSync(substitutedHome, { recursive: true });
  const substituted = await liveQueue(t, { minVersion: "99.0.0" }, substitutedHome);
  const substitutedProject = join(root, "project-substituted");
  mkdirSync(substitutedProject, { recursive: true });
  writeFileSync(join(substitutedProject, "effigy.toml"), `[tasks.hold]
admission = "heavy"
run = "sh -c 'echo started > STARTED; sleep 30'"
`);
  const substitutedRun = spawnTracked(QUALIFIED_EFFIGY, ["--run-id", "decoy-run-1", "hold"], {
    cwd: substitutedProject, timeoutMs: 30_000,
    env: privateEnv(substitutedHome, decoyDir, queueOwnedAdmissionEnvironment({
      hookCommand: defaultAdmissionHookCommand(), socketPath: substituted.socketPath,
    })),
  }, t);
  const substitutedResult = await substitutedRun.done;
  assert.notEqual(substitutedResult.code, 0, "the hook denied the admission");
  assert.match(substitutedRun.output(), /admission refused: the workload runs Effigy 0\.14\.1\+local\.efc1478 .*below the configured minimum 99\.0\.0/i,
    "the refusal names the version and the floor");
  assert.equal(existsSync(join(substitutedProject, "STARTED")), false, "the refused workload never starts");
  assert.equal(admissionReservation(substituted.runtime), undefined, "the refused admission wrote no reservation");
  assert.equal(substituted.runtime.store.hostRuns(10).length, 0, "no capacity is held for an unobservable run");
  // The public RuntimeOwner route, not an injected projection: every listed
  // record is the pinned contract 010 shape.
  const listed = substituted.runtime.listHostRuns();
  assert.equal(hostRunList.output.safeParse(listed).success, true);
  assert.deepEqual(listed, []);

  // 2. Settings still carry a retired exact-bytes pin naming the decoy, and the
  //    decoy is first on PATH. Neither matters: the workload's own Effigy is
  //    bound, observes the run, and the run settles on its own real result.
  const qualifiedHome = join(root, "home-b");
  mkdirSync(qualifiedHome, { recursive: true });
  const qualified = await liveQueue(t, { path: decoy.path, sha256: decoy.sha256 }, qualifiedHome);
  const qualifiedProject = join(root, "project-qualified");
  mkdirSync(qualifiedProject, { recursive: true });
  writeFileSync(join(qualifiedProject, "effigy.toml"), `[tasks.crash]
admission = "heavy"
run = "sh -c 'exit 17'"
`);
  const qualifiedRun = spawnTracked(QUALIFIED_EFFIGY, ["--run-id", "qualified-run-1", "crash"], {
    cwd: qualifiedProject, timeoutMs: 30_000,
    env: privateEnv(qualifiedHome, decoyDir, queueOwnedAdmissionEnvironment({
      hookCommand: defaultAdmissionHookCommand(), socketPath: qualified.socketPath,
    })),
  }, t);
  await waitUntil(() => Boolean(admissionReservation(qualified.runtime)?.effigyRuntime), 20_000,
    `the admitted workload binds the declared artifact (${JSON.stringify({
      state: qualified.runtime.hostRuns.list().map(run => [run.state, run.effigyRunId ?? null, run.effigyRuntimeRefusal ?? null]),
      run: qualifiedRun.child.exitCode,
    })})`);
  const bound = admissionReservation(qualified.runtime)!;
  const qualifiedId = bound.id;
  assert.equal(bound.effigyRuntime?.sha256, QUALIFIED_SHA256, "the binding records the workload Effigy's own bytes");
  assert.equal(bound.effigyRuntime?.version, "0.14.1+local.efc1478");
  assert.equal(bound.effigyRuntime?.path, realpathSync(QUALIFIED_EFFIGY));
  assert.equal(bound.effigyRuntime?.workloadPath, realpathSync(QUALIFIED_EFFIGY), "the workload ran that same image");
  assert.equal(bound.effigyRuntimeRefusal, undefined);
  await qualifiedRun.done;
  // The real producer's own closure retires the reservation's accounting. It is
  // not a Contract 010 settlement: Queue supervised no admitted command.
  await waitUntil(() => qualified.runtime.hostRuns.get(qualifiedId)?.state === "settled", 20_000,
    `the real terminal result settles the reservation (state=${qualified.runtime.hostRuns.get(qualifiedId)?.state})`);
  const settledBound = qualified.runtime.hostRuns.get(qualifiedId)!;
  assert.equal(settledBound.settlement?.outcome, "lost", "the settlement claims nothing about the workload");
  assert.equal(settledBound.settlement?.result, null, "no result is written for an admission");
  const retirement = qualified.runtime.hostRuns.accountingStatus(qualifiedId)!.disposition as Record<string, any>;
  assert.equal(retirement.format, "queue.host-run.accounting-retirement");
  assert.equal(retirement.producer.state, "failed");
  assert.equal(retirement.producer.exitCode, 17,
    "the verdict is the run's real exit, not the substitute's claimed success");
  assert.equal(retirement.producer.runtimeSha256, QUALIFIED_SHA256);
  assert.equal(retirement.acceptance, null, "no operator acceptance is invented");
  const observation = qualified.runtime.store.hostRunJournal(qualifiedId).filter(row => row.event === "effigy_observation");
  assert.equal(observation.length, 1, "one authoritative observation");
  assert.equal((observation[0].data as { runtimeSha256: string }).runtimeSha256, QUALIFIED_SHA256);
  assert.equal(qualified.runtime.store.hostRunJournal(qualifiedId).filter(row => row.event === "settlement").length, 1,
    "the gone hook settles the reservation once, with the producer's verdict as its evidence");
  const gone = qualified.runtime.store.hostRunJournal(qualifiedId).filter(row => row.event === "hook_gone");
  assert.equal((gone[0].data as { producer: { exitCode: number } }).producer.exitCode, 17,
    "the settlement carries the producer's own exit, not the substitute's claimed success");
});

/** The substitute's own answer, read synchronously: it claims success for any run id. */
function spawnSyncPath(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 5_000 });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
