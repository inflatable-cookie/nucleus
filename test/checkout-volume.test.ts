import { getWorkRoot } from "../core/workspaces/work-root.mjs";
import { after as restoreEnvironmentAfterTests } from "node:test";
const previousWorkRoot = process.env.NUCLEUS_WORK_ROOT;
const previousWorkVolumeId = process.env.NUCLEUS_WORK_VOLUME_ID;
process.env.NUCLEUS_WORK_ROOT = "/fixture/work";
process.env.NUCLEUS_WORK_VOLUME_ID = "";
restoreEnvironmentAfterTests(() => {
  if (previousWorkRoot === undefined) delete process.env.NUCLEUS_WORK_ROOT;
  else process.env.NUCLEUS_WORK_ROOT = previousWorkRoot;
  if (previousWorkVolumeId === undefined) delete process.env.NUCLEUS_WORK_VOLUME_ID;
  else process.env.NUCLEUS_WORK_VOLUME_ID = previousWorkVolumeId;
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCheckoutAvailable, CheckoutRefusalError, CheckoutUnavailableError, createCheckoutScratchDirectory, removeCheckoutRunScratchDirectory, type CheckoutVolumeInfo, cachedCheckoutVolume, CHECKOUT_VOLUME_READ_TTL_MS } from "../core/workspaces/checkout-volume";
import { checkoutRunScratchPlacement, repositoryScratchNamespace, runScratchRoot, runTemporaryDirectory, runTemporaryEnvironment, removeRecordedRunScratchDirectory, withRunTemporaryDirectory } from "../core/workspaces/run-scratch";
import { assertSocketPathWithinBound } from "./support/socket-fixture";

test("Run temp directories are created only on a proved checkout volume", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "queue-builds-scratch-")));
  const mount = join(root, "Stash");
  const valid: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true };
  const scratchRoot = runScratchRoot(mount);
  assert.equal(scratchRoot, join(mount, "scratch", "nucleus"));
  const target = join(scratchRoot, "run-1");
  const create = (info: CheckoutVolumeInfo = valid, candidate = target, base = scratchRoot) =>
    createCheckoutScratchDirectory({ mount, root: base, target: candidate, uuid: "fixture", observe: () => info });
  try {
    // An absent mount is refused before mkdir can recreate the mount point on the boot disk.
    assert.throws(() => create(), /Queue checkout storage unavailable/);
    assert.equal(existsSync(join(mount, "scratch")), false, "nothing was created on the absent mount path");
    mkdirSync(mount);
    create();
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.equal(lstatSync(target).mode & 0o077, 0, "the run temp directory is owner-only");
    for (const change of [{ VolumeUUID: "wrong" }, { Writable: false }, { MountPoint: root }])
      assert.throws(() => create({ ...valid, ...change }, join(scratchRoot, "run-2")), /storage unavailable/);
    // A redirected root is never a temp root a run may inherit.
    mkdirSync(scratchRoot, { recursive: true });
    symlinkSync(root, join(scratchRoot, "redirected"));
    assert.throws(() => create(valid, join(scratchRoot, "redirected", "run-3")), /redirected/);
    assert.throws(() => create(valid, join(root, "outside")), /outside the checkout scratch root/);
    assert.throws(() => create(valid, join(scratchRoot, "run-5"), join(mount, "redirected")), /outside the checkout scratch root/);
    // The production placement and the launch environment agree on one per-run path.
    const scratch = checkoutRunScratchPlacement({ mount, uuid: "fixture", observe: () => valid });
    const run4 = runTemporaryDirectory("run-4", scratchRoot);
    assert.deepEqual(runTemporaryEnvironment("run-4", scratch), { TMPDIR: run4, TMP: run4, TEMP: run4 });
    assert.deepEqual(withRunTemporaryDirectory({ PATH: "/bin", TMPDIR: "/internal" }, run4),
      { PATH: "/bin", TMPDIR: run4, TMP: run4, TEMP: run4 });
    assert.deepEqual(withRunTemporaryDirectory({ PATH: "/bin", TMPDIR: "/internal" }, undefined),
      { PATH: "/bin", TMPDIR: "/internal" }, "an already-launched run keeps the listed TMPDIR");
    const effigyScratch = scratch.withNamespace!("effigy");
    assert.equal(effigyScratch.root, runScratchRoot(mount, "effigy"));
    const effigyRun = runTemporaryDirectory("effigy-run", effigyScratch.root);
    assert.deepEqual(runTemporaryEnvironment("effigy-run", effigyScratch), { TMPDIR: effigyRun, TMP: effigyRun, TEMP: effigyRun });
    const retainedRun = runTemporaryDirectory("retained-run", scratchRoot);
    assert.deepEqual(runTemporaryEnvironment("retained-run", scratch, retainedRun), { TMPDIR: retainedRun, TMP: retainedRun, TEMP: retainedRun });
    assert.equal(lstatSync(retainedRun).isDirectory(), true, "a retained run's missing recorded leaf is recreated on the proved volume");
    // A socket fixture under the run's TMPDIR stays inside macOS's 104-byte Unix socket limit.
    assert.ok(join(runTemporaryDirectory("00000000-0000-0000-0000-000000000000", runScratchRoot(undefined, "paseo-northstar-queue")), "deadbeef", "callback.sock").length < 104);
    assert.throws(() => runTemporaryEnvironment("../escape", scratch), /cannot name a run temp directory/);
    const owned = join(scratchRoot, "owned-run");
    runTemporaryEnvironment("owned-run", scratch);
    assert.equal(removeCheckoutRunScratchDirectory({ mount, root: scratchRoot, target: owned, uuid: "fixture", observe: () => valid, log: () => {} }), true);
    assert.equal(existsSync(owned), false, "release removes the recorded root");
    assert.equal(scratch.remove(retainedRun), true, "release removes the retained run's created root");
    assert.equal(existsSync(retainedRun), false, "the continuation scratch root is gone at release");
    const foreign = join(root, "foreign"); mkdirSync(foreign);
    assert.equal(removeCheckoutRunScratchDirectory({ mount, root: scratchRoot, target: foreign, uuid: "fixture", observe: () => valid, log: () => {} }), false);
    assert.equal(existsSync(foreign), true, "a foreign path is left alone");
    const link = join(scratchRoot, "linked-run"); symlinkSync(root, link);
    assert.equal(removeCheckoutRunScratchDirectory({ mount, root: scratchRoot, target: link, uuid: "fixture", observe: () => valid, log: () => {} }), false);
    assert.equal(lstatSync(link).isSymbolicLink(), true, "a symlinked root is left alone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository scratch namespaces select repository roots and stay socket-sized", () => {
  assert.equal(repositoryScratchNamespace("owner/effigy"), "effigy");
  assert.equal(repositoryScratchNamespace("owner/consumer-b-v2"), "consumer-b-v2");
  assert.equal(repositoryScratchNamespace("owner/consumer-b-v2", "consumer-b"), "consumer-b");
  assert.equal(repositoryScratchNamespace("owner/queue", "effigy"), "effigy");
  assert.throws(() => repositoryScratchNamespace("owner/queue", "../tmp"), /invalid/);
  const longest = "a".repeat(31);
  assert.equal(runScratchRoot(undefined, "paseo-northstar-queue"), join(getWorkRoot(), "scratch", "paseo-northstar-queue"));
  assert.match(runTemporaryDirectory("run", runScratchRoot(undefined, "paseo-northstar-queue")), /[a-f0-9]{8}$/);
  const socket = join(runTemporaryDirectory("00000000-0000-0000-0000-000000000000", runScratchRoot(undefined, longest)), "deadbeef", "callback.sock");
  assert.ok(socket.length < 104, `socket path is ${socket.length} bytes`);
  assert.throws(() => assertSocketPathWithinBound("x".repeat(105)), /105 bytes.*fewer than 104/);
});

test("A symlinked ancestor above a missing scratch root refuses before recursive mkdir creates anything", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "queue-builds-ancestors-")));
  try {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    // Each case redirects one level between the mount and the still-missing scratch root, so only a
    // level-by-level proof can see it: recursive mkdir would have followed the link first.
    for (const level of [["scratch"], ["scratch", "nucleus"]] as const) {
      const mount = join(root, `Stash-${level.join("-")}`);
      mkdirSync(mount, { recursive: true });
      const parent = join(mount, ...level.slice(0, -1));
      mkdirSync(parent, { recursive: true });
      symlinkSync(elsewhere, join(mount, ...level));
      const valid: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true };
      const scratchRoot = runScratchRoot(mount);
      assert.throws(() => createCheckoutScratchDirectory({ mount, root: scratchRoot, target: join(scratchRoot, "run-1"), uuid: "fixture", observe: () => valid }),
        /redirected/, level.join("/"));
      assert.equal(existsSync(join(elsewhere, "nucleus")), false, `${level.join("/")}: nothing was created through the symlinked ancestor`);
      assert.equal(existsSync(join(mount, "scratch", "nucleus", "run-1")), false, `${level.join("/")}: no run directory was created`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checkout admission checks mounted identity, writeability and unredirected roots", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "queue-builds-")));
  const mount = join(root, "Stash");
  mkdirSync(mount);
  const valid: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true };
  const check = (info: CheckoutVolumeInfo = valid) => assertCheckoutAvailable({ mount, uuid: "fixture", observe: () => info });
  try {
    check();
    check({ ...valid, Internal: true }); // An explicit volume pin admits either device class.
    assert.throws(() => check({ ...valid, VolumeUUID: "different-volume" }), CheckoutRefusalError);
    assert.throws(() => check({ ...valid, VolumeUUID: undefined }), CheckoutUnavailableError);
    for (const change of [{ MountPoint: root }, { VolumeUUID: "wrong" }, { Writable: false }, { WritableVolume: false }])
      assert.throws(() => check({ ...valid, ...change }), /storage unavailable/);
    assert.throws(() => assertCheckoutAvailable({ mount, uuid: "fixture", observe: () => { throw Error("disappeared"); } }), /disappeared/);
    mkdirSync(join(mount, "queue"));
    symlinkSync(root, join(mount, "queue", "workspaces"));
    assert.throws(() => check(), CheckoutRefusalError);
    rmSync(join(mount, "queue", "workspaces"));
    mkdirSync(join(mount, "queue", "workspaces"));
    symlinkSync(root, join(mount, "queue", "workspaces", "repository"));
    assert.throws(() => assertCheckoutAvailable({ mount, uuid: "fixture", observe: () => valid,
      target: join(mount, "queue", "workspaces", "repository", "task") }), /redirected/);
    assert.throws(() => assertCheckoutAvailable({ mount, uuid: "fixture", observe: () => valid,
      target: join(root, "outside") }), CheckoutRefusalError);
    rmSync(mount, { recursive: true });
    assert.throws(() => check(), /storage unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the volume identity read is reused briefly and only for the same mount directory', () => {
  let reads = 0;
  const info = { MountPoint: '/Volumes/cache-volume', VolumeUUID: 'u', Internal: false, Writable: true, WritableVolume: true };
  const read = () => { reads++; return info; };
  const stat = { dev: 1, ino: 2, birthtimeMs: 3 };
  assert.equal(cachedCheckoutVolume('/Volumes/cache-volume', stat, read, 1000), info);
  cachedCheckoutVolume('/Volumes/cache-volume', stat, read, 1000 + CHECKOUT_VOLUME_READ_TTL_MS - 1);
  assert.equal(reads, 1, 'reused inside the window');
  cachedCheckoutVolume('/Volumes/cache-volume', stat, read, 1000 + CHECKOUT_VOLUME_READ_TTL_MS);
  assert.equal(reads, 2, 're-read after the window');
  cachedCheckoutVolume('/Volumes/cache-volume', { ...stat, dev: 9 }, read, 1000 + CHECKOUT_VOLUME_READ_TTL_MS + 1);
  assert.equal(reads, 3, 'a remount is a new read');
  assert.throws(() => cachedCheckoutVolume('/Volumes/cache-volume', { ...stat, ino: 7 }, () => { throw new Error('gone'); }, 5));
  cachedCheckoutVolume('/Volumes/cache-volume', { ...stat, ino: 7 }, read, 6);
  assert.equal(reads, 4, 'a failed read is not kept');
});


test("volume read cache retains alternating mounts independently", () => {
  const stat = { dev: 1, ino: 2, birthtimeMs: 3 };
  const reads = new Map<string, number>();
  const read = (mount: string): CheckoutVolumeInfo => {
    reads.set(mount, (reads.get(mount) ?? 0) + 1);
    return { MountPoint: mount };
  };
  for (const mount of ["/fixture/cache-a", "/fixture/cache-b", "/fixture/cache-a", "/fixture/cache-b"])
    cachedCheckoutVolume(mount, stat, read, 100);
  assert.deepEqual([...reads.values()], [1, 1]);
});


test("a run leaf recorded on the retired drive is absent history: never probed, nothing to remove", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retired-drive-")));
  const mount = join(root, "Stash");
  mkdirSync(mount);
  const observe = (): CheckoutVolumeInfo => { throw Error("the retired drive was probed"); };
  const retained = "/Volumes/retired-volume/scratch/northstar-queue/deadbeef";
  assert.equal(removeRecordedRunScratchDirectory(retained, { mount, uuid: "fixture", observe }), true);
  assert.equal(removeRecordedRunScratchDirectory(retained), true);
  const placement = checkoutRunScratchPlacement({ mount, uuid: "fixture", observe: () => ({ MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true }) });
  assert.throws(() => runTemporaryEnvironment("retained", placement, retained), /does not match its run identity/);
  assert.ok(runTemporaryEnvironment("fresh", placement).TMPDIR.startsWith(`${mount}/scratch/`));
});

test("alternating complete volume proofs cache one identity read per mount", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dual-proofs-")));
  const mounts = [join(root, "Stash"), join(root, "Other")];
  mounts.forEach(mount => mkdirSync(mount));
  const reads = new Map<string, number>();
  const read = (mount: string): CheckoutVolumeInfo => {
    reads.set(mount, (reads.get(mount) ?? 0) + 1);
    return { MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true };
  };
  for (const mount of [...mounts, ...mounts])
    assertCheckoutAvailable({ mount, uuid: "fixture", target: join(mount, "queue", "workspaces", "task"), read });
  assert.deepEqual([...reads.values()], [1, 1]);
});

test("a Builds path is never admitted or created on, and its cleanup never probes the drive", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "builds-path-")));
  const mount = join(root, "Stash");
  mkdirSync(mount);
  const observe = (): CheckoutVolumeInfo => ({ MountPoint: mount, VolumeUUID: "fixture", Internal: false, Writable: true, WritableVolume: true });
  const probe = () => { throw Error("the retired drive was probed"); };
  const scratchRoot = "/Volumes/retired-volume/scratch/paseo-northstar-queue";
  const target = join(scratchRoot, "recorded-run");
  assert.throws(() => assertCheckoutAvailable({ mount, target: "/Volumes/retired-volume/queue/workspaces/old", uuid: "fixture", observe }), /outside Nucleus checkout roots/);
  assert.throws(() => createCheckoutScratchDirectory({ mount, root: scratchRoot, target, uuid: "fixture", observe }), /outside the checkout scratch root/);
  assert.equal(removeCheckoutRunScratchDirectory({ mount, root: scratchRoot, target, uuid: "fixture", observe: probe, log: () => { throw Error("unexpected warning"); } }), true);
});
