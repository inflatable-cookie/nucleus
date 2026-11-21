import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { command, git } from "../core/git/index";
import { ownedBbWorkspacePath, ownedWorkspaceRoot, repoCommonDir } from "../core/workspaces/workspace-allocation";
import { siblingPathFor } from "../core/workspaces/siblings";
import {
  bbWorktreeLinksWait,
  provisionWorktreeLinks,
  type ConfiguredCheckout,
} from "../core/workspaces/worktree-links";
import { HOOK_TEST_TIMEOUT_MS } from "./support/budgets";

async function repo(path: string, files: Record<string, string>) {
  await mkdir(path, { recursive: true });
  await command("git", ["init", "--initial-branch=main", path], dirname(path));
  await git(path, "config", "user.name", "Queue test");
  await git(path, "config", "user.email", "queue@example.invalid");
  await git(path, "config", "commit.gpgsign", "false");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  await git(path, "add", "-A");
  await git(path, "commit", "--allow-empty", "-m", "init");
}

async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nsq-bbsib-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const primary = join(base, "repos", "primary");
  const poodle = join(base, "repos", "poodle");
  const data = join(base, "data");
  await repo(poodle, { "README.md": "poodle\n" });
  await repo(primary, {
    "paseo.json": JSON.stringify({ worktree: { setup: "nucleus worktree prepare ../poodle" } }),
  });
  await mkdir(data);
  const commonDir = await repoCommonDir(primary);
  return { base, primary, poodle, data, commonDir };
}

test(
  "BB publishes a declared sibling whose project entry is reached through a symlinked path",
  { timeout: HOOK_TEST_TIMEOUT_MS },
  async (t) => {
    const f = await fixture(t);
    // The project records poodle under a symlinked alias; the checkout is the real path.
    const alias = join(f.base, "aliases", "poodle");
    await mkdir(dirname(alias), { recursive: true });
    await symlink(f.poodle, alias);
    const configured: ConfiguredCheckout[] = [
      { origin: null, path: f.primary },
      { origin: null, path: alias },
    ];
    const taskId = randomUUID();
    const directory = ownedBbWorkspacePath(f.data, f.commonDir, taskId);
    await mkdir(dirname(directory), { recursive: true });
    await git(f.primary, "worktree", "add", "-b", `ns-${taskId}`, directory, "HEAD");
    const pinPath = siblingPathFor(f.data, taskId, "poodle");
    await mkdir(dirname(pinPath), { recursive: true });
    await git(f.poodle, "worktree", "add", "--detach", pinPath, "HEAD");
    const pin = {
      repository: alias,
      path: pinPath,
      commit: await git(f.poodle, "rev-parse", "HEAD"),
    };
    const placed = await provisionWorktreeLinks({
      dataDir: f.data,
      task: { repoPath: f.primary, directory, workspaceId: "ws-1" },
      configured,
      pinned: { taskId, pins: [pin], required: [configured[1]!] },
    });
    assert.deepEqual(
      placed.links.map((link) => [link.name, link.outcome, link.reason]),
      [["poodle", "created", undefined]],
      `findings: ${JSON.stringify(placed.findings)}`,
    );
    const view = {
      id: taskId,
      hostId: `bb:${"b".repeat(32)}`,
      repoPath: f.primary,
      directory,
      workspaceId: "ws-1",
      siblingPins: [pin],
      worktreeLinks: { ...placed, at: new Date().toISOString() },
    };
    assert.equal(
      await bbWorktreeLinksWait(view, configured, { dataDir: f.data, required: [configured[1]!] }),
      null,
    );
  },
);
