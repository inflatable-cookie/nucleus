import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execFile);

// Run all mutating subprocesses only under a new fixture, never the login home.
export function fixtureEnvironment(root: string) {
  const home = join(root, "home");
  assert.notEqual(resolve(home), resolve(userInfo().homedir));
  assert.ok(root.startsWith(`${resolve(tmpdir())}/`));
  return {
    ...process.env,
    HOME: home,
    NUCLEUS_DATA_HOME: join(home, ".nucleus"),
    NUCLEUS_WORK_ROOT: join(root, "work"),
    TMPDIR: root, TMP: root, TEMP: root,
    NUCLEUS_SCRATCH_ROOT: root,
    PASEO_HOME: join(root, "p"),
    NUCLEUS_RUN_TOKEN: "", NORTHSTAR_RUN_TOKEN: "", NUCLEUS_TICKET: "",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    PATH: "/usr/bin:/bin",
    NUCLEUS_SKILL_DIRS: join(root, "extra-skills"),
  };
}

/** Each physical installer scenario owns a fresh package, HOME and service/data paths. */
export async function installerFixture() {
  const root = await mkdtemp(join(tmpdir(), "ni-"));
  const env = fixtureEnvironment(root);
  const build = join(root, "package");
  const receipt = JSON.parse((await exec(process.execPath,
    ["scripts/build-runtime.mjs", build],
    { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  )).stdout);
  const home = env.HOME;
  for (const app of [".agents", ".codex", ".claude", ".paseo"]) {
    await mkdir(join(home, app), { recursive: true });
  }
  await mkdir(env.PASEO_HOME, { recursive: true });
  await writeFile(join(env.PASEO_HOME, "config.json"), JSON.stringify({ fixture: true, plugins: { other: { path: "/fixture/other" } } }));
  await mkdir(join(home, ".paseo", "northstar-queue"), { recursive: true });
  await writeFile(join(home, ".paseo", "northstar-queue", ".nucleus-redirect.json"), JSON.stringify({ to: join(home, ".nucleus") }));
  await writeFile(join(home, ".nucleus-stage-journal.json"), JSON.stringify({ version: 1, cutover: true, phase: "published" }));
  const tarball = join(root, "nucleus.tar.gz");
  const pack = () => exec("/usr/bin/tar", ["--format=ustar", "-czf", tarball, "-C", build, "."], { env });
  await pack();
  const digest = () => readFile(tarball).then(bytes => createHash("sha256").update(bytes).digest("hex"));
  const bootstrap = (...args: string[]) => exec(process.execPath, ["bin/nucleus.mjs", ...args], { env, timeout: 30_000 });
  await bootstrap("install", tarball, "--sha256", await digest());
  const command = join(home, ".local/bin/nucleus");
  const installed = (...args: string[]) => exec(command, args, { env, cwd: root, timeout: 30_000 });
  const current = join(home, ".local/share/nucleus/current");
  const first = await realpath(current);
  return { root, env, build, receipt, home, tarball, pack, digest, bootstrap, command, installed, current, first };
}
