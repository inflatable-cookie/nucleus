import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

test("the standalone board and its shared modules bundle for the browser", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nucleus-browser-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The browser build cannot resolve Node built-ins through any reached module.
  const builder = fileURLToPath(new URL("../scripts/build-web.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [builder, directory]);
  await Promise.all([
    access(join(directory, "app.js")),
    access(join(directory, "index.html")),
  ]);
});

test("engine stage keeps release writes on the supplied builds directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nucleus-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const bin = join(directory, "bin");
  const esbuildStub = join(source, "node_modules", "esbuild");
  const stage = fileURLToPath(new URL("../scripts/stage-engine-release.mjs", import.meta.url));
  const board = fileURLToPath(new URL("../scripts/build-web.mjs", import.meta.url));
  const skill = fileURLToPath(new URL("../skills/nucleus/SKILL.md", import.meta.url));
  const artifact = join(directory, "fixture-nucleus");
  const run = promisify(execFile);

  await Promise.all([
    mkdir(bin),
    mkdir(join(source, "scripts"), { recursive: true }),
    mkdir(join(source, "client", "web"), { recursive: true }),
    mkdir(join(source, "skills", "nucleus"), { recursive: true }),
    mkdir(esbuildStub, { recursive: true }),
  ]);
  const esbuildUrl = pathToFileURL(createRequire(import.meta.url).resolve("esbuild")).href;
  // Compile with real esbuild, optionally removing the mount name inside its build.
  await Promise.all([
    copyFile(stage, join(source, "scripts", "stage-engine-release.mjs")),
    copyFile(board, join(source, "scripts", "build-web.mjs")),
    copyFile(skill, join(source, "skills", "nucleus", "SKILL.md")),
    writeFile(join(source, "client", "web", "engine-index.tsx"), 'document.title = "Stage fixture";\n'),
    writeFile(join(source, ".gitignore"), "/node_modules/\n"),
    writeFile(join(esbuildStub, "package.json"), '{"type":"module","exports":"./index.mjs"}'),
    writeFile(join(esbuildStub, "index.mjs"), `
import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { build as compile } from ${JSON.stringify(esbuildUrl)};

export function build(options) {
  if (process.env.STAGE_MODE === "remove-during-board") {
    const mount = dirname(process.env.STAGE_BUILDS);
    options.plugins.push({
      name: "remove-mount",
      setup(api) {
        api.onStart(() => rename(mount, mount + "-moved"));
      },
    });
  }
  return compile(options);
}
`),
    writeFile(artifact, "fixture executable\n"),
    writeFile(join(bin, "oxide"), `#!/usr/bin/env node
const { mkdirSync, readdirSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { STAGE_ARTIFACT, STAGE_BUILDS, STAGE_MARKER, STAGE_MODE } = process.env;
writeFileSync(STAGE_MARKER, "oxide invoked");
if (STAGE_MODE === "fail") process.exit(43);
if (STAGE_MODE === "replace-during-compiler") {
  const moved = STAGE_BUILDS + "-moved";
  renameSync(STAGE_BUILDS, moved);
  const stage = readdirSync(join(moved, "releases")).find(name => name.startsWith(".stage-"));
  const foreign = join(STAGE_BUILDS, "releases", stage);
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "sentinel"), "foreign staging");
}
console.log(JSON.stringify({
  reason: "compiler-artifact", target: { name: "nucleus" }, executable: STAGE_ARTIFACT,
}));
`, { mode: 0o700 }),
  ]);
  const git = (...args: string[]) => run("git", args, { cwd: source });
  await git("init", "--quiet");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Stage fixture");
  const revision = (await git("rev-parse", "HEAD")).stdout.trim();
  const stageRelease = (builds: string, mode: string) =>
    run(process.execPath, ["scripts/stage-engine-release.mjs", builds], {
      cwd: source,
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
        STAGE_ARTIFACT: artifact,
        STAGE_BUILDS: builds,
        STAGE_MARKER: join(directory, mode),
        STAGE_MODE: mode,
      },
    });

  await t.test("rejects an absent builds root before starting Oxide", async () => {
    const mount = join(directory, "absent-volume");
    await assert.rejects(stageRelease(join(mount, "builds"), "missing"), /existing engine builds root/);
    await assert.rejects(access(mount), { code: "ENOENT" });
    await assert.rejects(access(join(directory, "missing")), { code: "ENOENT" });
  });

  await t.test("publishes one complete release under an existing root", async () => {
    const builds = join(directory, "valid-builds");
    await mkdir(builds);
    const { stdout } = await stageRelease(builds, "success");
    const releases = join(builds, "releases");
    const release = join(releases, revision);
    assert.equal(stdout.trim(), release);
    assert.deepEqual(await readdir(releases), [revision]);
    assert.equal(await readFile(join(release, "nucleus"), "utf8"), "fixture executable\n");
    assert.equal((await stat(join(release, "nucleus"))).mode & 0o777, 0o700);
    assert.match(await readFile(join(release, "board-assets", "app.js"), "utf8"), /Stage fixture/);
    await access(join(release, "board-assets", "index.html"));
    assert.deepEqual(await readFile(join(release, "skills", "nucleus", "SKILL.md")), await readFile(skill));
  });

  await t.test("leaves no published or partial release after a compiler failure", async () => {
    const builds = join(directory, "failed-builds");
    await mkdir(builds);
    await assert.rejects(stageRelease(builds, "fail"), /Oxide build failed \(43\)/);
    assert.deepEqual(await readdir(join(builds, "releases")), []);
  });

  await t.test("rejects replacement and preserves the foreign staging directory", async () => {
    const builds = join(directory, "replaced-builds");
    await mkdir(builds);
    await assert.rejects(stageRelease(builds, "replace-during-compiler"), /destination changed during staging/);
    const releases = join(builds, "releases");
    const entries = await readdir(releases);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, /^\.stage-/);
    assert.equal(await readFile(join(releases, entries[0]!, "sentinel"), "utf8"), "foreign staging");
    assert.deepEqual(await readdir(join(builds + "-moved", "releases")), []);
  });

  await t.test("does not recreate a destination removed during board compilation", async () => {
    const mount = join(directory, "removed-volume");
    const builds = join(mount, "builds");
    await mkdir(builds, { recursive: true });
    await assert.rejects(stageRelease(builds, "remove-during-board"), /destination changed during staging/);
    await assert.rejects(access(mount), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(mount + "-moved", "builds", "releases")), []);
  });
});
