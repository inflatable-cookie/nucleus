/**
 * Spec 068 Decision 4 on T3's real wire: a task run's pending permission, read
 * from T3's own observation, is declined through `runtime-request.respond` with
 * the stable intent, the agent is told to carry on, and nothing is sent twice.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, createAdapter } from "../hosts/t3code";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";
import { Store } from "../core/store/store";
import { submissionSchema } from "../shared/contracts";
import { denyPendingPermission, PERMISSION_DENIED } from "../core/recovery/permission-policy";
import { t3Fake } from "./support/t3code-fake";
import { acpStub, serveNucleusProvider } from "./support/t3code-acp";

async function t3Fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "t3deny-")));
  const server = await t3Fake(t, directory);
  const acp = acpStub(server.threads);
  const host = createHost({ endpoint: server.endpoint, bearer: "synthetic-bearer", probeThreadId: "synthetic-probe",
    statePath: join(directory, "hosts", "t3code.json"), timeoutMs: 2_000, acp: () => acp.surface, reentryTimeoutMs: 200 });
  t.after(() => host.close());
  await host.connect();
  await serveNucleusProvider(host, server);
  const workspace = await host.createWorkspace({ title: "Synthetic worktree", requestId: "workspace", directory, project: { projectId: "synthetic-project" } });
  const agent = await host.createAgent({ workspaceId: workspace.id, title: "Synthetic worker", mcpBindingPath: null,
    profile: { id: "profile", name: "Synthetic", provider: "synthetic-provider", model: "synthetic-model", notes: "", available: true, problem: "", supportedThinking: [] },
    attempt: () => ({ requestId: "create-thread", prompt: "Synthetic prompt", labels: { "nucleus.task": "synthetic" }, environment: {} }),
  });
  const store = new Store(join(directory, "queue.sqlite"));
  t.after(() => store.close());
  const base = "a".repeat(40);
  const task = store.insert(submissionSchema.parse({ submissionId: "deny", title: "Synthetic task run", repoPath: "/fixture",
    planningCommit: base, handoffPath: "synthetic-handoff", originAgentId: "synthetic-origin" }),
  host.hostId, "Synthetic handoff", base, { phase: "working", agentId: agent.id, workspaceId: workspace.id, runId: "initial" });
  const adapter = createAdapter(HostPolicies as unknown as HostPolicyConstructor, host);
  return { server, agent, workspace, store, task, adapter, projection: server.threads.get(agent.id)! };
}

test("a T3 task run's pending permission is declined on T3's wire once, with a message", async (t) => {
  const f = await t3Fixture(t);
  f.projection.runtimeRequests.push({ id: "synthetic-permission", kind: "command", status: "pending",
    responseCapability: { type: "live", providerSessionId: "synthetic-session" } });
  const state = await f.adapter.observe(f.agent.id);
  assert.equal(state.permissions, true);
  assert.equal(state.pendingRequest?.id, "synthetic-permission");
  const context = { adapter: f.adapter, store: f.store, onTaskHost: <T>(_task: unknown, work: () => Promise<T>) => work() };
  assert.equal(await denyPendingPermission(context as never, f.task, null, state), true);
  const responses = f.server.commands.filter((command) => command.type === "runtime-request.respond");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.decision, "decline");
  assert.equal(responses[0]!.requestId, "synthetic-permission");
  assert.equal(responses[0]!.commandId, "ns-permission-deny-initial-synthetic-permission");
  const denied = f.store.eventsAll(f.task.id).filter((event) => event.kind === PERMISSION_DENIED);
  assert.equal(denied.length, 1);
  assert.match(denied[0]!.detail, /"requestId":"synthetic-permission"/);
  assert.match(denied[0]!.detail, /"message":"delivered"/, denied[0]!.detail);
  // The same observation again: nothing is answered or sent twice.
  assert.equal(await denyPendingPermission(context as never, f.task, null, state), true);
  assert.equal(f.server.commands.filter((command) => command.type === "runtime-request.respond").length, 1);
});
