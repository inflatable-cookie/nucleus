import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Engine } from "../core/engine";
import type { HostPolicyConstructor } from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import { registerTask } from "../core/host/registration";
import { prepareReviewEntryWorkspace } from "../core/review/review-entry";
import { Store } from "../core/store/store";
import { createAdapter, createHost } from "../hosts/t3code";
import { createBbHostAdapter } from "../service/bb-host";
import { formatAgentId } from "../shared/agent-identity";
import type { Profile } from "../shared/contracts";
import { bbFake } from "./support/bb-fake";
import { exactProofFixture, FIXTURE_LEAD, runGit, seedFixtureLead } from "./support/review-entry-fixture";
import { syntheticRun, t3Fake, threadProjection } from "./support/t3code-fake";

const bbHostId = "bb:0123456789abcdef0123456789abcdef";
const model = "synthetic-model";
const reviewer: Profile = {
  id: "reviewer", name: "Reviewer", provider: "codex", model,
  notes: "", available: true, problem: "", supportedThinking: [],
};

async function fixture(t: TestContext, kind: "T3Code" | "BB") {
  const f = exactProofFixture();
  const dataDir = join(f.root, "data");
  mkdirSync(dataDir);
  const store = new Store(join(dataDir, "queue.sqlite"));
  t.after(() => {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  store.patchRepository({ origin: "https://github.com/example/repo", path: f.repo }, {});
  store.setMeta("paused", false);
  store.setMeta("pool", [{ profileId: reviewer.id, enabled: true, group: "review", roles: ["reviewer"], weight: "default", scopes: ["general"] }]);
  seedFixtureLead(store, f.repo, f.planningCommit);

  async function t3() {
    const wire = await t3Fake(t, f.repo);
    const host = createHost({
      endpoint: wire.endpoint, bearer: "synthetic-bearer", statePath: join(dataDir, "t3.json"),
      probeThreadId: "synthetic-probe",
      acp: () => ({
        bind: ({ taskId }) => ({ taskId, sessionId: `session:${taskId}`, bindingPath: join(dataDir, "acp.json") }),
        turn: async () => { throw Error("Test drives the native child, not the ACP parent"); },
        message: async () => { throw Error("No ACP messages are needed"); },
        release: () => {},
      }),
    });
    t.after(() => host.close());
    await host.connect();
    const config = await host.catalog();
    assert.equal(config.providers[0]?.key, "synthetic-provider");
    wire.controls.providers = [
      { instanceId: "codex", displayName: "Codex", driver: "codex", enabled: true, status: "ready", models: [{ slug: model, name: model }] },
      { instanceId: "nucleus", displayName: "Nucleus", driver: "acpRegistry", enabled: true, status: "ready", models: [{ slug: "nucleus", name: "Nucleus" }] },
    ];
    const adapter = createAdapter(HostPolicies as unknown as HostPolicyConstructor, host, {
      socketPath: join(dataDir, "callback.sock"), helperPath: join(dataDir, "worker-report.mjs"),
    });
    let count = 0;
    return {
      adapter,
      async thread(directory: string | null) {
        const id = `author-${++count}`;
        const row = threadProjection(id, f.repo);
        row.thread.worktreePath = directory;
        wire.threads.set(id, row);
        return { id, active(value: boolean) { row.runs = value ? [syntheticRun(id, 1, { status: "running" })] : []; } };
      },
      reviewerSpawns: () => wire.commands.filter((call) => call.type === "delegated_task.request").length,
    };
  }

  async function bb() {
    const wire = bbFake();
    const project = await wire.sdk.projects.create({ name: "Fixture", source: { type: "local_path", hostId: "host_synthetic", path: f.repo } });
    const adapter = createBbHostAdapter(bbHostId, () => true, dataDir, store, wire.operations.execute);
    return {
      adapter,
      async thread(directory: string | null) {
        const { id } = await wire.sdk.threads.spawn({
          projectId: project.id, providerId: "codex", model: "author-model", title: "Author", parentNotifications: "off",
          environment: { type: "host", hostId: "host_synthetic", workspace: { type: "unmanaged", path: directory ?? f.repo } },
        });
        const row = wire.rows.get(id);
        return { id, active(value: boolean) { row.status = value ? "active" : "idle"; } };
      },
      reviewerSpawns: () => wire.calls.filter((call) => call.method === "threads.spawn" && call.args.pluginMetadata?.nucleus?.role === "reviewer").length,
    };
  }

  const native = await (kind === "T3Code" ? t3() : bb());
  const verifyPr = async () => ({ url: "https://github.com/example/repo/pull/41", head: f.expectedHead, repository: "example/repo", headRepository: "example/repo" });
  const adapter = Object.assign(native.adapter, {
    reviewEntryGithubCommand: f.adapter.reviewEntryGithubCommand,
    verifyPr,
    verifyPrIdentity: verifyPr,
    externalMerge: async () => null,
    hostProcessListing: async () => [],
    worktreeValidation: () => ({ state: "absent" as const }),
  });
  store.setMeta("hostId", adapter.hostId);
  return { ...f, ...native, adapter, store };
}

for (const kind of ["T3Code", "BB"] as const) {
  test(`${kind} registers the native worktree of the calling thread`, async (t) => {
    const f = await fixture(t, kind);
    const rootThread = await f.thread(null);
    const author = await f.thread(f.workspace);
    const register = (id: string) => registerTask(f.store, f.adapter, [], {
      caller: formatAgentId(f.adapter.hostId, id), title: "Registered work", description: "Work in my own checkout", complexity: "medium",
    });

    await assert.rejects(register(rootThread.id), new RegExp(`no available worktree on ${kind}`));
    assert.equal(f.store.tasks().length, 0);
    const origin = await f.adapter.originAgent?.(author.id);
    const observed = await f.adapter.observe(author.id);
    assert.ok(observed.workspaceId);
    assert.equal(origin?.workspaceId, observed.workspaceId);
    const result = await register(author.id);
    assert.equal(result.workspaceId, observed.workspaceId);
    assert.equal(result.task.agentId, author.id);
    assert.equal(result.task.directory, f.workspace);
    assert.equal(result.task.branch, f.reviewInput.expectedBranch);
    assert.equal(result.task.workspaceOwnership, "external");
    assert.ok(result.binding?.ticketPath);
  });

  test(`${kind} prepares and binds review entry, then launches one reviewer after the workspace writer yields`, async (t) => {
    const f = await fixture(t, kind);
    const engine = new Engine(f.store, f.adapter, 0);
    engine.profiles = [reviewer];
    const prepare = () => prepareReviewEntryWorkspace(f.adapter, {
      leadId: FIXTURE_LEAD, leadVersion: 1, prNumber: f.reviewInput.prNumber, title: "External review", repoPath: f.repo,
    });
    try {
      await assert.rejects(prepare, /already (checked out|used by worktree)/);
      assert.equal(runGit(f.workspace, "rev-parse", "HEAD"), f.expectedHead);
      runGit(f.repo, "worktree", "remove", f.workspace);
      runGit(f.repo, "branch", "-f", f.reviewInput.expectedBranch, f.planningCommit);
      await assert.rejects(prepare, /Local PR branch has a different head/);
      runGit(f.repo, "branch", "-D", f.reviewInput.expectedBranch);

      const { id: workspaceId } = await prepare();
      assert.deepEqual(await prepare(), { id: workspaceId });
      const author = await f.thread(null);
      const input = {
        ...f.reviewInput, workspaceId, workspaceOwnership: "intake" as const,
        submission: { ...f.reviewInput.submission, originAgentId: formatAgentId(f.adapter.hostId, author.id) },
      };
      f.store.updateLead({ ...f.store.lead(FIXTURE_LEAD), originAgentId: input.submission.originAgentId });
      assert.ok(f.adapter.inspectReviewEntry);
      const placement = await f.adapter.inspectReviewEntry({ ...input, submission: { ...input.submission, originAgentId: author.id } });
      const writer = await f.thread(placement.directory);
      writer.active(true);

      const accepted = await engine.startOperation({ key: "native-review-entry", kind: "review_entry", payload: { type: "review_entry", input } });
      assert.ok("accepted" in accepted);
      const settled = await engine.awaitOperation(accepted.operation.id, 10_000);
      assert.equal(settled.state, "succeeded", settled.diagnostic);
      assert.ok(settled.taskId);
      const task = f.store.task(settled.taskId);
      assert.equal(task.reviewEntry?.verifiedHead, f.expectedHead);
      assert.equal(task.reviewEntry?.preserveWorkspace, false);
      assert.equal(task.resumePrNumber, input.prNumber);
      assert.equal(task.hostId, f.adapter.hostId);
      assert.equal(task.originHostId, f.adapter.hostId);
      assert.match(task.reason, /Workspace has an active turn/);
      await engine.sweepOnce();
      await engine.quiesce();
      assert.equal(f.reviewerSpawns(), 0);

      writer.active(false);
      const deadline = Date.now() + 15_000;
      while (!f.store.runs(task.id).some((run) => run.agentId) && Date.now() < deadline) {
        await engine.sweepOnce();
        await engine.quiesce();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const runs = f.store.runs(task.id);
      assert.equal(runs.length, 1, f.store.task(task.id).reason);
      assert.ok(runs[0].agentId, f.store.task(task.id).reason);
      assert.equal(runs[0].role, "reviewer", f.store.events(task.id).map((event) => `${event.kind} ${event.detail}`).join("\n"));
      assert.equal(runs[0].head, f.expectedHead);
      assert.equal(runs[0].workspaceId, workspaceId);
      assert.equal(f.reviewerSpawns(), 1);
    } finally {
      await engine.stop();
    }
  });
}
