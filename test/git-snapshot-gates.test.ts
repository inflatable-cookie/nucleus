import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTextEnv, repositoryIsCleanAt } from "../core/git/git-snapshot";
import { gitRun, gitText } from "../core/git/git-command";
import { verifyMergeCandidate } from "../core/hooks/git-gates";

test("Git cleanliness reports probe failures instead of treating them as dirty state", async t => {
  const root = await mkdtemp(join(tmpdir(), "nucleus-git-cleanliness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(repositoryIsCleanAt(root, "a".repeat(40)), /git status/);
});

test("merge-candidate proof refuses an absent pinned identity", async () => {
  await assert.rejects(verifyMergeCandidate("unused", null), /no pinned candidate identity/);
});

test("merge-candidate proof binds both parents and the tree", async t => {
  const root = await mkdtemp(join(tmpdir(), "nucleus-merge-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { GIT_AUTHOR_NAME: "Nucleus test", GIT_AUTHOR_EMAIL: "nucleus@example.invalid", GIT_COMMITTER_NAME: "Nucleus test", GIT_COMMITTER_EMAIL: "nucleus@example.invalid" };
  await gitRun(root, ["init", "-q"]);
  await writeFile(join(root, "file"), "content\n");
  await gitRun(root, ["add", "file"]);
  const tree = await gitText(root, "write-tree");
  const base = await gitTextEnv(root, env, "commit-tree", tree, "-m", "base");
  const reviewedHead = await gitTextEnv(root, env, "commit-tree", tree, "-m", "reviewed head");
  const commit = await gitTextEnv(root, env, "commit-tree", tree, "-p", base, "-p", reviewedHead, "-m", "candidate");
  await gitRun(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await gitRun(root, ["update-ref", "refs/heads/main", commit]);
  await gitRun(root, ["reset", "--hard", commit]);
  const candidate = { commit, integrationBase: base, reviewedHead, tree };
  await verifyMergeCandidate(root, candidate);
  await assert.rejects(verifyMergeCandidate(root, { ...candidate, integrationBase: reviewedHead }), /candidate parents changed/);
  await assert.rejects(verifyMergeCandidate(root, { ...candidate, reviewedHead: base }), /candidate parents changed/);
  await assert.rejects(verifyMergeCandidate(root, { ...candidate, tree: "f".repeat(40) }), /candidate tree changed/);
});
