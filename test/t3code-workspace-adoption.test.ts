import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { git } from "../core/git/index";
import type { HostPolicyConstructor } from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import { settleWorkspaceCreation } from "../core/recovery/workspace-lookup";
import { Store } from "../core/store/store";
import {
  repoCommonDir,
  workspacePathInRoot,
} from "../core/workspaces/workspace-allocation";
import { createAdapter, createHost } from "../hosts/t3code";
import { t3WorkspaceId } from "../hosts/t3code/state";
import { submissionSchema } from "../shared/contracts";

async function fixture(
  t: TestContext,
  path: "owned" | "foreign" | "aliased" = "owned",
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "t3-workspace-adoption-")),
  );
  const store = new Store(join(root, "queue.sqlite"));
  const repo = join(root, "repo"),
    workspaceRoot = join(root, "workspaces");
  const statePath = join(root, "t3.json"),
    hostId = "t3code:fixture";
  const host = createHost({
    endpoint: "ws://127.0.0.1:1",
    bearer: "synthetic",
    statePath,
  });
  host.hostId = hostId;
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
    {
      socketPath: join(root, "callback.sock"),
      helperPath: join(root, "report.mjs"),
      testPlacement: { dataDir: root, workspaceRoot, admit: () => {} },
    },
  );
  const engine = new Engine(store, adapter, 0);
  t.after(async () => {
    await engine.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "tracked.txt"), "fixture\n");
  await git(repo, "add", "tracked.txt");
  await git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  const head = await git(repo, "rev-parse", "HEAD");
  const insert = () =>
    store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Synthetic worktree",
        repoPath: repo,
        planningCommit: head,
        brief: { text: "Synthetic brief" },
        originAgentId: "origin",
      }),
      hostId,
      "Synthetic brief",
      head,
    );
  const inserted = insert();
  const task = store.update(inserted.id, {
    phase: "needs_attention",
    workspaceIntent: true,
    branch: `ns-${inserted.id}`,
  });
  const directory =
    path === "foreign"
      ? join(root, "foreign", `ns-${task.id}`)
      : workspacePathInRoot(workspaceRoot, await repoCommonDir(repo), task.id);
  const caseAlias = join(root, "WORKSPACES");
  mkdirSync(workspaceRoot);
  const registeredDirectory =
    path !== "aliased"
      ? directory
      : existsSync(caseAlias)
        ? directory.replace(workspaceRoot, caseAlias)
        : `${root}/./${directory.slice(root.length + 1)}`;
  const projectId = "synthetic-project",
    id = t3WorkspaceId(projectId, registeredDirectory);
  const registration = {
    id,
    directory: registeredDirectory,
    projectId,
    title: task.title,
  };
  // The registration was persisted by a previous process, whose task binding never landed.
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      hostId,
      lastPassedVersion: "",
      workspaces: { [id]: registration },
      agents: {},
      intents: {},
    }),
    { mode: 0o600 },
  );
  const checkout = (...options: string[]) =>
    git(
      repo,
      "worktree",
      "add",
      ...options,
      "-b",
      task.branch,
      directory,
      head,
    );
  const retry = (discard?: boolean) =>
    engine.performTaskControl({
      taskId: task.id,
      version: store.task(task.id).version,
      action: "retry_effect",
      effect: "workspace_creation",
      reason: "Reconcile the interrupted workspace registration",
      discard,
    });
  const adoptionEvents = () =>
    store
      .eventsAll(task.id)
      .filter((event) => event.kind === "workspace_registration_adopted");
  const assertAdopted = async () => {
    assert.equal(store.task(task.id).workspaceId, id);
    assert.equal(store.task(task.id).directory, directory);
    assert.deepEqual(
      adoptionEvents().map((event) => event.detail),
      [id],
    );
    assert.deepEqual(host.state.read().workspaces, { [id]: registration });
    assert.equal(await repoCommonDir(directory), await repoCommonDir(repo));
    assert.equal(await git(directory, "branch", "--show-current"), task.branch);
    assert.equal(await git(directory, "status", "--porcelain"), "");
  };
  return {
    store,
    statePath,
    adapter,
    engine,
    task,
    root,
    insert,
    directory,
    id,
    checkout,
    retry,
    assertAdopted,
    adoptionEvents,
  };
}

test("workspace_creation retry adopts a task's own registered checkout once", async (t) => {
  const f = await fixture(t);
  await f.checkout();
  assert.equal((await f.retry()).phase, "queued");
  await f.retry();
  await f.assertAdopted();
});

test("automatic reconciliation populates an empty registered folder before launching", async (t) => {
  const f = await fixture(t);
  mkdirSync(f.directory, { recursive: true });
  f.store.setMeta("paused", false);
  const task = f.store.update(f.task.id, { phase: "dispatching" });
  let launched = false;
  const result = await settleWorkspaceCreation(
    {
      store: f.store,
      adapter: f.adapter,
      resolution: f.engine.resolution,
      hostHealth: f.engine.hostHealth,
      note: f.engine.note.bind(f.engine),
      stopped: false,
      launchAgent: async () => {
        await f.assertAdopted();
        launched = true;
      },
    },
    task,
  );
  assert.equal(result, "bound");
  assert.equal(launched, true);
  assert.equal(
    readFileSync(join(f.directory, "tracked.txt"), "utf8"),
    "fixture\n",
  );
});

test("workspace_creation retry fills missing files in a partial registered checkout", async (t) => {
  const f = await fixture(t);
  await f.checkout();
  rmSync(join(f.directory, "tracked.txt"));
  await f.retry();
  await f.assertAdopted();
  assert.equal(
    readFileSync(join(f.directory, "tracked.txt"), "utf8"),
    "fixture\n",
  );
});

test("an interrupted checkout with no index is populated from HEAD", async (t) => {
  const f = await fixture(t);
  await f.checkout("--no-checkout");
  const index = await git(
    f.directory,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  );
  assert.equal(existsSync(index), false);
  assert.equal(
    await git(f.directory, "status", "--porcelain"),
    "D  tracked.txt",
  );
  await f.retry();
  await f.assertAdopted();
  assert.equal(existsSync(index), true);
  assert.equal(
    readFileSync(join(f.directory, "tracked.txt"), "utf8"),
    "fixture\n",
  );
});

test("an edited checkout is preserved even when it looks interrupted", async (t) => {
  const f = await fixture(t);
  await f.checkout("--no-checkout");
  const edited = join(f.directory, "tracked.txt");
  writeFileSync(edited, "user edit\n");
  const status = await git(f.directory, "status", "--porcelain");
  await assert.rejects(
    f.retry(true),
    /checkout changes that cannot be safely repaired/,
  );
  assert.equal(readFileSync(edited, "utf8"), "user edit\n");
  assert.equal(await git(f.directory, "status", "--porcelain"), status);
  assert.equal(f.store.task(f.task.id).workspaceId, null);
});

test("an intentional staged deletion is not a missing index", async (t) => {
  const f = await fixture(t);
  await f.checkout();
  await git(f.directory, "rm", "tracked.txt");
  await assert.rejects(
    f.retry(),
    /checkout changes that cannot be safely repaired/,
  );
  assert.equal(
    await git(f.directory, "status", "--porcelain"),
    "D  tracked.txt",
  );
  assert.equal(f.store.task(f.task.id).workspaceId, null);
});

test("the checkout's branch wins over a stale worktree inventory entry", async (t) => {
  const f = await fixture(t);
  await f.checkout();
  const foreign = join(f.root, "foreign-branch");
  await git(
    f.task.repoPath,
    "worktree",
    "add",
    "-b",
    "foreign",
    foreign,
    "main",
  );
  writeFileSync(join(f.directory, ".git"), readFileSync(join(foreign, ".git")));
  assert.ok(
    (await git(f.task.repoPath, "worktree", "list", "--porcelain")).includes(
      `worktree ${f.directory}\nHEAD ${f.task.planningCommit}\nbranch refs/heads/${f.task.branch}`,
    ),
  );
  await assert.rejects(
    f.retry(),
    /refs\/heads\/foreign.*does not match the task checkout/,
  );
  assert.equal(await git(f.directory, "branch", "--show-current"), "foreign");
  assert.equal(f.store.task(f.task.id).workspaceId, null);
});

test("catalogue aliases of the owned directory resolve to one registration", async (t) => {
  const f = await fixture(t, "aliased");
  await f.checkout();
  await f.retry();
  await f.retry();
  await f.assertAdopted();
});

test("another task's active or historical binding prevents adoption", async (t) => {
  for (const phase of ["working", "cancelled"] as const) {
    await t.test(phase, async (subtest) => {
      const f = await fixture(subtest);
      mkdirSync(f.directory, { recursive: true });
      f.store.update(f.insert().id, {
        phase,
        workspaceId: f.id,
        directory: f.directory,
        ...(phase === "cancelled"
          ? { removedAt: new Date().toISOString() }
          : {}),
      });
      await assert.rejects(
        f.retry(),
        /never reparents another owner's workspace/,
      );
      assert.equal(f.store.task(f.task.id).workspaceId, null);
      assert.deepEqual(f.adoptionEvents(), []);
    });
  }
});

test("the task branch and folder name do not authorize a registration outside the configured root", async (t) => {
  const f = await fixture(t, "foreign");
  await f.checkout();
  await assert.rejects(f.retry(), /never reparents another owner's workspace/);
  assert.equal(f.store.task(f.task.id).workspaceId, null);
});

test("an unreadable T3 registry waits without populating or binding", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.statePath, "invalid state");
  await assert.rejects(
    f.adapter.populateTaskWorktree!(f.task),
    /registration inventory could not be read/,
  );
  assert.deepEqual(f.adoptionEvents(), []);
});
