import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Copy the real backup worker, replacing only the volume adapter. */
async function stageBackupWorker(root: string): Promise<void> {
  for (const dir of ['shared', 'core/store', 'core/workspaces', 'core/machine']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const path of ['core/store/backup-worker.mjs', 'core/machine/owned-file.mjs']) {
    await cp(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  for (const name of ["runtime.mjs", "data-home.mjs"]) {
    await cp(
      new URL(`../shared/${name}`, import.meta.url),
      join(root, "shared", name),
    );
  }
  await writeFile(
    join(root, "core/workspaces/work-root.mjs"),
    `export const getWorkStorage = () => ({ root: ${JSON.stringify(join(root, "live-volume"))} });
export const readWorkVolume = () => { throw Error("Fixture volume is not mounted"); };`,
  );
}

const privateBackupProof = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataHome } from './shared/data-home.mjs';
import { backupDirForDataDir, createBackup, isLiveStoreDir, liveBackupDir, liveStorePath } from './core/store/backup-worker.mjs';
assert.equal(homedir(), userInfo().homedir, 'the account HOME must remain normal');
const privateDir = dataHome();
const liveDirectory = liveBackupDir();
// Path comparison to the account's ~/.nucleus, not an adopt check.
const canonicalDir = join(userInfo().homedir, '.nucleus');
assert.notEqual(privateDir, canonicalDir);
assert.equal(liveStorePath(), join(canonicalDir, 'queue.sqlite'));
assert.equal(isLiveStoreDir(canonicalDir), true);
assert.equal(backupDirForDataDir(canonicalDir), liveDirectory);
assert.equal(isLiveStoreDir(privateDir), false);
assert.equal(backupDirForDataDir(privateDir), join(privateDir, 'backups'));
mkdirSync(privateDir, { recursive: true });
for (const dir of [liveDirectory]) {
  mkdirSync(dir, { recursive: true });
  // More than the hourly retention limit, plus an interrupted file that a
  // wrongly admitted backup would remove before opening the source database.
  for (let i = 0; i < 25; i++) writeFileSync(join(dir, '2026-01-01T00-00-00-000Z-' + i.toString(16) + '.hourly.sqlite.gz'), 'keep-' + i);
  writeFileSync(join(dir, '.2026-01-01T00-00-00-000Z-interrupted.sqlite'), 'keep-interrupted');
}
const snapshot = dir => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]);
const before = [liveDirectory].map(snapshot);
const dbPath = join(privateDir, 'queue.sqlite');
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('private')");
db.close();
await assert.rejects(createBackup(dbPath, liveDirectory), /Refusing to back up/);
const fd = openSync(dbPath, 'r');
try {
  await assert.rejects(createBackup(dbPath, liveDirectory, undefined, { admittedSource: { path: dbPath, fd } }), /Refusing to back up/);
} finally { closeSync(fd); }
const result = await createBackup(dbPath, undefined, undefined, { volumeRoot: null });
assert.ok(result.snapshots.length > 0);
assert.deepEqual([liveDirectory].map(snapshot), before);
console.log(JSON.stringify({ privateDir, target: backupDirForDataDir(privateDir), snapshots: result.snapshots.length }));
`;

test("a private data home with the account HOME cannot write or rotate live backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "backup-isolation-"));
  await stageBackupWorker(root);
  await writeFile(join(root, "proof.mjs"), privateBackupProof);
  const result = await exec(process.execPath, [join(root, "proof.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      HOME: userInfo().homedir,
      // The explicit data-home override. PASEO_HOME is the Paseo app home and does
      // not select the Nucleus store.
      NUCLEUS_DATA_HOME: join(root, "private-paseo", "northstar-queue"),
      PASEO_HOME: undefined,
    },
    timeout: 30_000,
  });
  const proof = JSON.parse(result.stdout);
  assert.equal(
    proof.target,
    join(root, "private-paseo", "northstar-queue", "backups"),
  );
  assert.ok(proof.snapshots > 0);
  assert.equal(
    (await readdir(join(root, "private-paseo", "northstar-queue", "backups")))
      .length,
    proof.snapshots,
  );
});

test("an occupied default ~/.nucleus does not stop a private NUCLEUS_DATA_HOME instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "backup-occupied-"));
  await stageBackupWorker(root);
  const workerPath = join(root, "core/store/backup-worker.mjs");
  const src = await readFile(workerPath, "utf8");
  const needle = "import { homedir, userInfo } from 'node:os';";
  assert.equal(src.includes(needle), true, "backup-worker still imports homedir and userInfo from node:os");
  await writeFile(
    workerPath,
    src.replace(
      needle,
      `import { homedir, userInfo as realUserInfo } from 'node:os';
const userInfo = () => ({ ...realUserInfo(), homedir: process.env.HOME });`,
    ),
  );
  const accountHome = join(root, "account-home");
  const occupied = join(accountHome, ".nucleus");
  await mkdir(join(occupied, "config"), { recursive: true });
  await mkdir(join(occupied, "state"), { recursive: true });
  await writeFile(join(occupied, "config", "ui.json"), "{}");
  await writeFile(join(occupied, "state", "nucleus.sqlite"), "");
  const privateDir = join(root, "private-store");
  await writeFile(
    join(root, "proof.mjs"),
    `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataHome, isDataHomeError, resolveDataHome } from './shared/data-home.mjs';
import { backupDirForDataDir, createBackup, isLiveStoreDir, liveBackupDir, liveStorePath } from './core/store/backup-worker.mjs';
const privateDir = dataHome();
const liveDirectory = liveBackupDir();
const canonicalDir = join(homedir(), '.nucleus');
assert.equal(privateDir, ${JSON.stringify(privateDir)});
assert.notEqual(privateDir, canonicalDir);
try {
  resolveDataHome({ HOME: homedir() });
  assert.fail('the unselected default home must stay occupied');
} catch (error) {
  assert.equal(isDataHomeError(error), true);
  assert.equal(error.code, 'data-home:occupied');
}
assert.equal(liveStorePath(), join(canonicalDir, 'queue.sqlite'));
assert.equal(isLiveStoreDir(canonicalDir), true);
assert.equal(backupDirForDataDir(canonicalDir), liveDirectory);
assert.equal(isLiveStoreDir(privateDir), false);
assert.equal(backupDirForDataDir(privateDir), join(privateDir, 'backups'));
mkdirSync(privateDir, { recursive: true });
mkdirSync(liveDirectory, { recursive: true });
writeFileSync(join(liveDirectory, '2026-01-01T00-00-00-000Z-keep.hourly.sqlite.gz'), 'keep');
const snapshot = dir => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]);
const before = snapshot(liveDirectory);
const dbPath = join(privateDir, 'queue.sqlite');
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('private')");
db.close();
await assert.rejects(createBackup(dbPath, liveDirectory), /Refusing to back up/);
const fd = openSync(dbPath, 'r');
try {
  await assert.rejects(createBackup(dbPath, liveDirectory, undefined, { admittedSource: { path: dbPath, fd } }), /Refusing to back up/);
} finally { closeSync(fd); }
const result = await createBackup(dbPath, undefined, undefined, { volumeRoot: null });
assert.ok(result.snapshots.length > 0);
assert.deepEqual(snapshot(liveDirectory), before);
console.log(JSON.stringify({ privateDir, target: backupDirForDataDir(privateDir), snapshots: result.snapshots.length, liveStorePath: liveStorePath() }));
`,
  );
  const result = await exec(process.execPath, [join(root, "proof.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      HOME: accountHome,
      NUCLEUS_DATA_HOME: privateDir,
      PASEO_HOME: undefined,
    },
    timeout: 30_000,
  });
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.target, join(privateDir, "backups"));
  assert.equal(proof.liveStorePath, join(occupied, "queue.sqlite"));
  assert.ok(proof.snapshots > 0);
  assert.equal((await readdir(join(privateDir, "backups"))).length, proof.snapshots);
});
