import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { exec, fixtureEnvironment, installerFixture } from "./support/nucleus-install-fixture";

test("install repairs owned skill links and refuses unsafe replacements without changing the active version", async () => {
  const { root, home, tarball, digest, installed, current, first } = await installerFixture();
  // A leftover link under the retired skill name that points into the Nucleus
  // install is the installer's own, so install or roll removes it. An entry of
  // that name pointing anywhere else belongs to the operator and is untouched.
  const checkoutSkill = join(root, "fixture-checkout", "skills", "northstar-queue");
  await mkdir(checkoutSkill, { recursive: true });
  await writeFile(join(checkoutSkill, "SKILL.md"), "checkout skill");
  await rm(join(home, ".agents/skills/nucleus"));
  await symlink(join(current, "skills/northstar-queue"), join(home, ".agents/skills/northstar-queue"));
  await symlink(checkoutSkill, join(home, ".codex/skills/northstar-queue"));
  await installed("install", tarball, "--sha256", await digest());
  assert.equal(await realpath(current), first);
  assert.equal(
    await readFile(join(home, ".agents/skills/nucleus/SKILL.md"), "utf8"),
    await readFile(join(first, "skills/nucleus/SKILL.md"), "utf8"),
  );
  await assert.rejects(readlink(join(home, ".agents/skills/northstar-queue")));
  assert.equal(await readlink(join(home, ".codex/skills/northstar-queue")), checkoutSkill);
  assert.equal(await readFile(join(checkoutSkill, "SKILL.md"), "utf8"), "checkout skill");
  // A failed install after a retired-alias repoint puts the old link back
  // instead of leaving a half-moved skills folder behind.
  const repointEnv = fixtureEnvironment(join(root, "repoint"));
  const repointAlias = join(repointEnv.HOME, ".local/share/nucleus/compat-skills/nucleus");
  await mkdir(repointAlias, { recursive: true });
  await writeFile(join(repointAlias, "SKILL.md"), "retired alias");
  await mkdir(join(repointEnv.HOME, ".agents/skills"), { recursive: true });
  await symlink(repointAlias, join(repointEnv.HOME, ".agents/skills/nucleus"));
  const repointSkills = repointEnv.NUCLEUS_SKILL_DIRS;
  await mkdir(dirname(repointSkills), { recursive: true });
  await writeFile(repointSkills, "not a directory");
  await assert.rejects(exec(process.execPath, ["bin/nucleus.mjs", "install", tarball], { env: repointEnv }), /EEXIST|already exists/i);
  assert.equal(await readlink(join(repointEnv.HOME, ".agents/skills/nucleus")), repointAlias);
  await assert.rejects(readlink(join(repointEnv.HOME, ".agents/skills/northstar-queue")));
  await assert.rejects(readlink(join(repointEnv.HOME, ".local/share/nucleus/current")));

  const corrupt = join(root, "corrupt.tar.gz");
  await writeFile(corrupt, "not an archive");
  await assert.rejects(installed("install", corrupt));
  assert.equal(await realpath(current), first);
  await assert.rejects(installed("install", tarball, "--sha256", "0".repeat(64)));
  assert.equal(await realpath(current), first);

  // A `nucleus` collision is still refused, and the prior install stays active.
  const collisionEnv = fixtureEnvironment(join(root, "collision"));
  const foreign = join(collisionEnv.HOME, ".codex/skills/nucleus");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "SKILL.md"), "foreign skill");
  await assert.rejects(exec(process.execPath, ["bin/nucleus.mjs", "install", tarball], { env: collisionEnv }), /skill|collision|own/i);
  assert.equal(await readFile(join(foreign, "SKILL.md"), "utf8"), "foreign skill");
  await assert.rejects(readlink(join(collisionEnv.HOME, ".local/share/nucleus/current")));

  // Unsafe paths are rejected before extraction, even with a valid tar header.
  const unsafe = gunzipSync(await readFile(tarball));
  unsafe.fill(0, 0, 100);
  unsafe.write("../escaped", 0);
  unsafe.fill(32, 148, 156);
  const checksum = [...unsafe.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0);
  unsafe.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  const unsafeTarball = join(root, "unsafe.tar.gz");
  await writeFile(unsafeTarball, gzipSync(unsafe));
  await assert.rejects(installed("install", unsafeTarball), /unsafe|path/i);
  assert.equal(await realpath(current), first);


});
