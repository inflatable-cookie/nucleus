import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDataDir } from "../shared/service/default-data-dir";
import {
  getWorkPlacement,
  initializeWorkRoot,
  previewWorkPlacement,
} from "../core/workspaces/work-root.mjs";
import { saveWorkStorage } from "../core/workspaces/work-storage";
import { assertLegacyQaSettled } from "../service/install/legacy-qa-custody";
import { legacyQaRoots } from "../core/qa/qa-evidence-roots";
import {
  assertLiveBackupComponents,
  listLiveBackups,
  liveBackupReadDirs,
  newestLiveScheduledSnapshotAt,
  snapshotFileName,
} from "../core/store/backup-worker.mjs";

/**
 * Settings → Storage (nucleus#1526). Every work-volume location is one setting with
 * a portable default derived from `workRoot`; an existing `<workRoot>/queue/...`
 * install keeps being read until its files are migrated. These cases run on real
 * paths in a temporary work root with a fake volume pin, so no machine or drive
 * layout is assumed and nothing outside the fixtures is touched.
 */

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-storage-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = defaultDataDir();
  const mount = join(root, "volume");
  mkdirSync(mount, { recursive: true });
  const writeSettings = (extra: Record<string, unknown> = {}) => {
    mkdirSync(data, { recursive: true });
    rmSync(join(data, "queue.sqlite"), { force: true });
    writeFileSync(join(data, "settings.json"), JSON.stringify({
      workRoot: mount, workVolumeId: "fake-volume", ...extra,
    }));
    t.after(() => rmSync(join(data, "settings.json"), { force: true }));
  };
  const volume = () => ({ MountPoint: mount, VolumeUUID: "fake-volume", Internal: false, Writable: true, WritableVolume: true });
  return { root, data, mount, writeSettings, volume };
}

const snapshot = (dir: string, stem: string, kind: "hourly" | "daily" | "weekly") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, snapshotFileName(stem, kind)), "snapshot");
};
const STEM_A = "2026-11-20T01-00-00-000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEM_B = "2026-11-21T01-00-00-000Z-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("a fresh install derives every class from the work root, outside any queue folder", (t) => {
  const { data, mount, writeSettings } = fixture(t);
  writeSettings();
  const placement = getWorkPlacement(data, {});
  assert.equal(placement.workRoot, mount);
  assert.equal(placement.worktreesRoot, join(mount, "worktrees", "nucleus"));
  assert.equal(placement.backupRoot, join(mount, "archives", "nucleus-backups"));
  assert.equal(placement.projectQaRoot, join(mount, "archives", "nucleus-project-qa"));
  assert.equal(placement.scratchRoot, join(mount, "scratch", "nucleus"));
  // Custodian handshake files are live lease state, so they belong to the scratch class.
  assert.equal(placement.custodianRoot, join(mount, "scratch", "nucleus", "barge-custodians"));
  for (const field of ["worktreesRoot", "backupRoot", "projectQaRoot", "scratchRoot", "custodianRoot"] as const)
    assert.ok(!placement[field].slice(mount.length).includes("/queue/"), `${field} is outside queue/`);
  // An existing install's locations stay named, and the retired worktree root stays supported.
  assert.deepEqual(placement.retired, {
    worktreesRoot: join(mount, "queue", "workspaces"),
    backupRoot: join(mount, "queue", "backups"),
    projectQaRoot: join(mount, "queue", "project-qa"),
  });
  assert.deepEqual(placement.retainedRoots, [join(mount, "queue", "workspaces")]);
  assert.deepEqual(placement.overrides, {});
});

test("an existing queue/ install keeps its locations and adopts the new classes only as defaults", (t) => {
  const { data, mount, writeSettings } = fixture(t);
  writeSettings({ localWorkspaceRoot: join(mount, "queue", "workspaces") });
  const placement = getWorkPlacement(data, {});
  assert.equal(placement.worktreesRoot, join(mount, "queue", "workspaces"));
  assert.deepEqual(placement.retainedRoots, []);
  assert.equal(placement.backupRoot, join(mount, "archives", "nucleus-backups"));
  // Nothing writes into the retired locations again, and the settings file is untouched by a read.
  assert.equal(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).backupRoot, undefined);
});

test("every class is a setting, with its own environment override", (t) => {
  const { data, mount, writeSettings } = fixture(t);
  writeSettings({
    backupRoot: join(mount, "custom", "snapshots"),
    projectQaRoot: join(mount, "custom", "qa"),
    scratchRoot: join(mount, "custom", "runs"),
    custodianRoot: join(mount, "custom", "custodians"),
  });
  const placement = getWorkPlacement(data, {});
  assert.equal(placement.backupRoot, join(mount, "custom", "snapshots"));
  assert.equal(placement.projectQaRoot, join(mount, "custom", "qa"));
  assert.equal(placement.scratchRoot, join(mount, "custom", "runs"));
  assert.equal(placement.custodianRoot, join(mount, "custom", "custodians"));
  assert.deepEqual(placement.overrides, {
    backupRoot: join(mount, "custom", "snapshots"),
    projectQaRoot: join(mount, "custom", "qa"),
    scratchRoot: join(mount, "custom", "runs"),
    custodianRoot: join(mount, "custom", "custodians"),
  });
  const overridden = getWorkPlacement(data, {
    NUCLEUS_BACKUP_ROOT: join(mount, "env", "snapshots"),
    NUCLEUS_PROJECT_QA_ROOT: join(mount, "env", "qa"),
    NUCLEUS_SCRATCH_ROOT: join(mount, "env", "runs"),
    NUCLEUS_CUSTODIAN_ROOT: join(mount, "env", "custodians"),
  });
  assert.equal(overridden.backupRoot, join(mount, "env", "snapshots"));
  assert.equal(overridden.projectQaRoot, join(mount, "env", "qa"));
  assert.equal(overridden.scratchRoot, join(mount, "env", "runs"));
  assert.equal(overridden.custodianRoot, join(mount, "env", "custodians"));
  // A blank override is unset, so the saved settings still apply.
  assert.equal(getWorkPlacement(data, { NUCLEUS_BACKUP_ROOT: "" }).backupRoot, join(mount, "custom", "snapshots"));
});

test("each guard refuses relative, redirected, outside-root, wrong-volume and absent paths", (t) => {
  const { root, data, mount, writeSettings, volume } = fixture(t);
  writeSettings();
  // Relative and non-canonical paths.
  for (const bad of ["relative/path", `${mount}/a/../b`, "/"]) {
    assert.throws(() => previewWorkPlacement({ backupRoot: bad }, data, {}), /canonical absolute/);
  }
  // The work root itself and anything outside it.
  assert.throws(() => previewWorkPlacement({ backupRoot: mount }, data, {}), /inside workRoot/);
  assert.throws(() => previewWorkPlacement({ backupRoot: join(root, "outside") }, data, {}), /inside workRoot/);
  assert.throws(() => previewWorkPlacement({ scratchRoot: join(data, "elsewhere") }, data, {}), /inside workRoot/);
  // A redirected component inside the work root.
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(mount, "archives"));
  assert.throws(
    () => saveWorkStorage({ backupRoot: join(mount, "archives", "nucleus-backups") },
      { dataDir: data, env: {}, observe: volume }),
    /redirected/,
  );
  // An absent or mismatched pinned volume refuses instead of falling back.
  assert.throws(
    () => saveWorkStorage({ backupRoot: join(mount, "archives", "nucleus-backups") },
      { dataDir: data, env: {}, read: () => { throw new Error("volume absent"); } }),
    /storage unavailable/,
  );
  assert.throws(
    () => saveWorkStorage({ backupRoot: join(mount, "archives", "nucleus-backups") },
      { dataDir: data, env: {}, read: () => ({ ...volume(), VolumeUUID: "other-volume" }) }),
    /identity/,
  );
  // Nothing was written by a refused save.
  assert.equal(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).backupRoot, undefined);
});

test("the Storage save writes the resolved paths on disk, keeps unrelated settings, and applies on the next start", (t) => {
  const { data, mount, writeSettings, volume } = fixture(t);
  writeSettings({ daemonUrl: "ws://127.0.0.1:6767/ws", unrelated: { keep: true } });
  const saved = saveWorkStorage({
    worktreesRoot: join(mount, "worktrees", "nucleus"),
    backupRoot: join(mount, "custom", "snapshots"),
    projectQaRoot: null,
    scratchRoot: join(mount, "scratch", "nucleus"),
    custodianRoot: null,
  }, { dataDir: data, env: {}, observe: volume });
  assert.equal(saved.backupRoot, join(mount, "custom", "snapshots"));
  assert.equal(saved.projectQaRoot, join(mount, "archives", "nucleus-project-qa"));
  assert.equal(saved.custodianRoot, join(mount, "scratch", "nucleus", "barge-custodians"));
  assert.equal(saved.appliesOnRestart, true);
  // Only a path that differs from its portable default reads as an override; the
  // settings file still keeps the explicit values that were saved.
  assert.deepEqual(saved.overrides, {
    worktreesRoot: null,
    backupRoot: join(mount, "custom", "snapshots"),
    projectQaRoot: null,
    scratchRoot: null,
    custodianRoot: null,
  });
  const written = JSON.parse(readFileSync(join(data, "settings.json"), "utf8"));
  assert.equal(written.workRoot, mount);
  assert.equal(written.workVolumeId, "fake-volume");
  assert.equal(written.daemonUrl, "ws://127.0.0.1:6767/ws", "an unrelated setting survives");
  assert.deepEqual(written.unrelated, { keep: true });
  assert.equal(written.backupRoot, join(mount, "custom", "snapshots"));
  assert.equal(written.projectQaRoot, undefined, "null restores the portable default");
  assert.equal(statSync(join(data, "settings.json")).mode & 0o777, 0o600);
  // A later read resolves the same placement, and startup validates it.
  assert.equal(getWorkPlacement(data, {}).backupRoot, join(mount, "custom", "snapshots"));
  initializeWorkRoot(data, {});
});

test("the backup listing reads the retired queue/backups location until it is empty", (t) => {
  const { root } = fixture(t);
  const live = join(root, "archives", "nucleus-backups");
  const retired = join(root, "queue", "backups");
  snapshot(live, STEM_B, "hourly");
  snapshot(retired, STEM_A, "hourly");
  snapshot(retired, STEM_A, "daily");
  const placement = { backupRoot: live, retired: { backupRoot: retired } };
  assert.deepEqual(liveBackupReadDirs(placement), [live, retired]);
  const listed = listLiveBackups(root, liveBackupReadDirs(placement));
  assert.deepEqual(listed.snapshots.map(entry => entry.at), [
    "2026-11-21T01:00:00.000Z",
    "2026-11-20T01:00:00.000Z",
    "2026-11-20T01:00:00.000Z",
  ]);
  assert.equal(listed.dir, live, "the listing names the location new snapshots go to");
  assert.equal(newestLiveScheduledSnapshotAt(liveBackupReadDirs(placement)), Date.parse("2026-11-21T01:00:00.000Z"));
  // Once the retired location holds nothing, only the configured one is read.
  rmSync(retired, { recursive: true, force: true });
  assert.deepEqual(liveBackupReadDirs(placement), [live]);
  assert.equal(listLiveBackups(root, liveBackupReadDirs(placement)).snapshots.length, 1);
  assert.equal(newestLiveScheduledSnapshotAt(liveBackupReadDirs(placement)), Date.parse("2026-11-21T01:00:00.000Z"));
});

test("legacy QA history is found at the configured root and the retired one, and its custody still defers a roll", (t) => {
  const { data, mount, writeSettings } = fixture(t);
  writeSettings();
  const roots = legacyQaRoots(data);
  assert.equal(roots.live, true);
  assert.deepEqual(roots.roots, [
    join(data, "project-qa"),
    join(mount, "archives", "nucleus-project-qa"),
    join(mount, "queue", "project-qa"),
  ]);
  const key = "0123456789abcdef01234567";
  const runId = "12345678-1234-4123-8123-123456789abc";
  // A checkout left under the moved history is still custody that defers a roll.
  const moved = join(mount, "archives", "nucleus-project-qa", key, runId);
  mkdirSync(moved, { recursive: true });
  assert.throws(() => assertLegacyQaSettled(data), /still present/);
  rmSync(join(mount, "archives", "nucleus-project-qa"), { recursive: true, force: true });
  // The same evidence under the retired root is found too, so nothing is lost by not migrating.
  const retired = join(mount, "queue", "project-qa", key, runId);
  mkdirSync(retired, { recursive: true });
  assert.throws(() => assertLegacyQaSettled(data), /still present/);
  rmSync(join(mount, "queue"), { recursive: true, force: true });
  assert.doesNotThrow(() => assertLegacyQaSettled(data));
});

test("the live backup class proves its own levels, and an absent unpinned work root is not a fault", (t) => {
  const { root } = fixture(t);
  // Nothing creates the portable work root at startup, so a live snapshot may run
  // first: the proof reports there was nothing to prove and creates nothing itself.
  const absentRoot = join(root, "fresh", "work");
  assert.equal(assertLiveBackupComponents(absentRoot, join(absentRoot, "archives", "nucleus-backups")), false);
  assert.equal(existsSync(absentRoot), false, "the proof creates nothing; the backup directory's mkdir does");
  // A real tree proves every existing level, and a missing leaf is created after it.
  const workRoot = join(root, "work");
  const backupRoot = join(workRoot, "archives", "nucleus-backups");
  mkdirSync(backupRoot, { recursive: true });
  assert.equal(assertLiveBackupComponents(workRoot, backupRoot), true);
  assert.equal(assertLiveBackupComponents(workRoot, join(workRoot, "archives", "second")), true);
  // A redirected level inside the work root refuses before anything is written there.
  const redirected = join(root, "redirected");
  const otherRoot = join(root, "other-work");
  mkdirSync(redirected, { recursive: true });
  mkdirSync(otherRoot, { recursive: true });
  symlinkSync(redirected, join(otherRoot, "archives"));
  assert.throws(
    () => assertLiveBackupComponents(otherRoot, join(otherRoot, "archives", "nucleus-backups")),
    /redirected/,
  );
  // So does a work root that is itself a symlink.
  const linkedRoot = join(root, "linked-work");
  symlinkSync(otherRoot, linkedRoot);
  assert.throws(() => assertLiveBackupComponents(linkedRoot, join(linkedRoot, "archives")), /redirected/);
});

test("a save validates the stored values themselves, so an environment override cannot mask an invalid path", (t) => {
  const { root, data, mount, writeSettings, volume } = fixture(t);
  writeSettings();
  // A valid environment override must not make an invalid saved value acceptable.
  assert.throws(
    () => saveWorkStorage({ backupRoot: join(root, "outside") }, {
      dataDir: data, env: { NUCLEUS_BACKUP_ROOT: join(mount, "env", "snapshots") }, observe: volume,
    }),
    /inside workRoot/,
  );
  // Nor may an overridden work root make a value valid that the file does not place.
  assert.throws(
    () => saveWorkStorage({ backupRoot: join(root, "env-work", "snapshots") }, {
      dataDir: data, env: { NUCLEUS_WORK_ROOT: join(root, "env-work") }, observe: volume,
    }),
    /inside workRoot/,
  );
  // Without any override the same value is refused too, so the two answers agree.
  assert.throws(
    () => saveWorkStorage({ backupRoot: join(root, "outside") }, { dataDir: data, env: {}, observe: volume }),
    /inside workRoot/,
  );
  assert.equal(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).backupRoot, undefined);
});
