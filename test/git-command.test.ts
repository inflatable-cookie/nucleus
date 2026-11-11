import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { gitRaw } from "../core/git/git-command";
import { command } from "../core/git/index";

function fakeGit(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "git-command-"));
  writeFileSync(join(directory, "git"), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  return { directory, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` } };
}

test("the shared Git runner keeps byte stdout and the text wrapper controls trimming", async () => {
  const { directory, env } = fakeGit("process.stdout.write(Buffer.from([0,255,32,10]));");
  const raw = await gitRaw(directory, ["fixture"], undefined, env);
  assert.equal(raw.code, 0);
  assert.deepEqual(raw.stdout, Buffer.from([0, 255, 32, 10]));
  assert.equal(await command("git", ["fixture"], directory, env, { trim: false }), "\0\ufffd \n");
  assert.equal(await command("git", ["fixture"], directory, env), "\0\ufffd");
});

test("Git timeout kills the child and an explicitly longer command timeout completes", async () => {
  const { directory, env } = fakeGit("setTimeout(() => process.stdout.write('complete\\n'), 250);");
  await assert.rejects(gitRaw(directory, ["fixture"], undefined, env, 25), error => {
    assert.equal((error as { killed?: boolean }).killed, true);
    assert.equal((error as { signal?: string }).signal, "SIGKILL");
    return true;
  });
  assert.equal(await command("git", ["fixture"], directory, env, { timeout: 5_000 }), "complete");
});

test("the default shared Git timeout is bounded", async () => {
  const { directory, env } = fakeGit("setTimeout(() => {}, 60000);");
  await assert.rejects(gitRaw(directory, ["fixture"], undefined, env), error => {
    assert.equal((error as { killed?: boolean }).killed, true);
    assert.equal((error as { signal?: string }).signal, "SIGKILL");
    return true;
  });
});
