import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { gitAncestry, gitRun, requireGitAncestry } from "../core/git/git-command";
import { githubRepositoryFromRemote } from "../core/git/git-remote";
import { command } from "../core/git/index";

function fakeGit(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "git-command-"));
  writeFileSync(join(directory, "git"), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  return { directory, env: { PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` } };
}

test("the shared Git runner keeps byte stdout and the text wrapper controls trimming", async () => {
  const { directory, env } = fakeGit("process.stdout.write(Buffer.from([0,255,32,10]));");
  const raw = await gitRun(directory, ["fixture"], undefined, env);
  assert.equal(raw.code, 0);
  assert.deepEqual(raw.stdout, Buffer.from([0, 255, 32, 10]));
  assert.equal(await command("git", ["fixture"], directory, env, { trim: false }), "\0\ufffd \n");
  assert.equal(await command("git", ["fixture"], directory, env), "\0\ufffd");
});

test("Git timeout kills the child and an explicitly longer command timeout completes", async () => {
  const { directory, env } = fakeGit("setTimeout(() => process.stdout.write('complete\\n'), 250);");
  await assert.rejects(gitRun(directory, ["fixture"], undefined, env, 25), error => {
    assert.equal((error as { killed?: boolean }).killed, true);
    assert.equal((error as { signal?: string }).signal, "SIGKILL");
    return true;
  });
  assert.equal(await command("git", ["fixture"], directory, env, { timeout: 5_000 }), "complete");
});

test("the default shared Git timeout is bounded", async () => {
  const { directory, env } = fakeGit("setTimeout(() => {}, 60000);");
  await assert.rejects(gitRun(directory, ["fixture"], undefined, env), error => {
    assert.equal((error as { killed?: boolean }).killed, true);
    assert.equal((error as { signal?: string }).signal, "SIGKILL");
    return true;
  });
});

test("a child output limit names the Git command", async () => {
  const { directory, env } = fakeGit("process.stdout.write('x'.repeat(4096));");
  await assert.rejects(command("git", ["overflow"], directory, env, { maxBuffer: 1024 }), error => {
    assert.match((error as Error).message, /git overflow exceeded its stdout output limit/);
    assert.equal(((error as Error).message.match(/git overflow/g) ?? []).length, 1);
    return true;
  });
});

test("ancestry is tri-state: only a proven exit 1 is divergence", async () => {
  // The helper decides on the child's own exit code, never on the text it prints.
  const answers: Array<[number, string]> = [[0, "ancestor"], [1, "diverged"], [128, "unknown"], [2, "unknown"]];
  for (const [code, expected] of answers) {
    const { directory, env } = fakeGit(`process.stderr.write('fatal: not a git repository\\n'); process.exit(${code});`);
    const previous = process.env.PATH;
    process.env.PATH = env.PATH;
    try { assert.equal(await gitAncestry(directory, "a".repeat(40), "b".repeat(40)), expected, `exit ${code}`); }
    finally { process.env.PATH = previous; }
  }
});

test("a remote names a GitHub repository only in its own forms", () => {
  for (const remote of ["https://github.com/owner/repo", "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo"])
    assert.equal(githubRepositoryFromRemote(remote), "owner/repo", remote);
  // Another forge, a nested path and a bare word are not GitHub repositories.
  for (const remote of ["https://gitlab.com/owner/repo", "https://github.com/owner/repo/tree/main", "repo", ""])
    assert.equal(githubRepositoryFromRemote(remote), null, remote);
});

test("a refused ancestry names an unreadable read apart from a proven no", async () => {
  const refusal = "Replacement source does not descend from the base";
  const cases: Array<[number, RegExp | null]> = [[0, null], [1, /Replacement source does not descend from the base$/], [128, /unreadable/]];
  for (const [code, expected] of cases) {
    const { directory, env } = fakeGit(`process.exit(${code});`);
    const previous = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      if (!expected) { await requireGitAncestry(directory, "a".repeat(40), "b".repeat(40), refusal); continue; }
      await assert.rejects(requireGitAncestry(directory, "a".repeat(40), "b".repeat(40), refusal), expected, `exit ${code}`);
    } finally { process.env.PATH = previous; }
  }
});
