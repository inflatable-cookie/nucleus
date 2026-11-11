import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateVersion } from "../service/install/install.mjs";

function packageAt(root: string) {
  mkdirSync(root, { recursive: true });
  const bytes = JSON.stringify({ revision: "a".repeat(40), buildId: "b".repeat(64) });
  writeFileSync(join(root, "build.json"), bytes);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ files: { "build.json": createHash("sha256").update(bytes).digest("hex") } }));
  mkdirSync(join(root, "skills/nucleus"), { recursive: true });
  writeFileSync(join(root, "skills/nucleus/SKILL.md"), "name: nucleus\n");
}

function withHome(home: string, fn: () => Promise<void>) {
  const previous = { HOME: process.env.HOME, NUCLEUS_SKILL_DIRS: process.env.NUCLEUS_SKILL_DIRS };
  process.env.HOME = home;
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("activateVersion converges installer entrypoints so roll and recover-previous match install", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-"));
  await withHome(home, async () => {
    const base = join(home, ".local/share/nucleus");
    const versions = join(base, "versions");
    const first = join(versions, "first"), second = join(versions, "second");
    packageAt(first);
    packageAt(second);
    await activateVersion(first);
    const current = join(base, "current");
    assert.equal(realpathSync(current), realpathSync(first));
    const command = join(home, ".local/bin/nucleus");
    assert.match(readFileSync(command, "utf8"), /nucleus-owned-command-v1/);
    const skill = join(home, ".agents/skills/nucleus");
    assert.equal(readlinkSync(skill), join(current, "skills/nucleus"));
    assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), "name: nucleus\n");
    assert.throws(() => readlinkSync(join(home, ".agents/skills/northstar-queue")));
    // A leftover link under the retired skill name that points into the install
    // goes on a roll; an unrelated entry of that name is the operator's.
    symlinkSync(join(current, "skills/northstar-queue"), join(home, ".agents/skills/northstar-queue"));
    mkdirSync(join(home, ".codex/skills/northstar-queue"), { recursive: true });
    writeFileSync(join(home, ".codex/skills/northstar-queue/SKILL.md"), "foreign skill\n");
    await activateVersion(second);
    assert.equal(realpathSync(current), realpathSync(second));
    assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"), "name: nucleus\n");
    assert.throws(() => readlinkSync(join(home, ".agents/skills/northstar-queue")));
    assert.equal(readFileSync(join(home, ".codex/skills/northstar-queue/SKILL.md"), "utf8"), "foreign skill\n");
    assert.equal(realpathSync(join(base, "previous")), realpathSync(first));
  });
});

test("activateVersion restores prior entrypoints when a later skill folder collides", async () => {
  const home = mkdtempSync(join(tmpdir(), "ia-fail-"));
  await withHome(home, async () => {
    const base = join(home, ".local/share/nucleus");
    const first = join(base, "versions/first"), second = join(base, "versions/second");
    packageAt(first);
    packageAt(second);
    await activateVersion(first);
    const extra = join(home, "extra-skills");
    writeFileSync(extra, "not a directory");
    process.env.NUCLEUS_SKILL_DIRS = extra;
    await assert.rejects(activateVersion(second), /EEXIST|not a directory|ENOTDIR/i);
    assert.equal(realpathSync(join(base, "current")), realpathSync(first));
    assert.equal(readlinkSync(join(home, ".agents/skills/nucleus")), join(base, "current/skills/nucleus"));
  });
});
