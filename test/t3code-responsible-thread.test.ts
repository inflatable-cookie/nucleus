import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, createAdapter } from "../hosts/t3code";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { RuntimeRepositories } from "../core/runtime/repositories";
import { agentMessageSchema } from "../core/questions/agent-messages";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, type Run } from "../shared/contracts";
import { t3Fake, STAMP, threadProjection } from "./support/t3code-fake";

const Policy = HostPolicies as unknown as HostPolicyConstructor;
const BASE_SHA = "a".repeat(40);

function makeProjection(
  id: string,
  directory: string,
  threadOverrides: Record<string, unknown>,
) {
  const projection = threadProjection(id, directory);
  Object.assign(projection.thread, threadOverrides);
  if (typeof threadOverrides.updatedAt === "string") {
    projection.updatedAt = threadOverrides.updatedAt;
  }
  return projection;
}

async function t3Fixture(
  t: import("node:test").TestContext,
  setupThreads: (
    fake: Awaited<ReturnType<typeof t3Fake>>,
    dirs: { repoDir: string; deskDir: string },
  ) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "nucleus-t3-responsible-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repoDir = join(dir, "repo");
  const deskDir = join(dir, "planning-desk");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(deskDir, { recursive: true });

  const fake = await t3Fake(t, repoDir);
  fake.projects.push({
    id: "proj-desk",
    title: "Planning Desk",
    workspaceRoot: deskDir,
  });
  // Remove the default probe thread after setting up our own live threads so
  // the shortlist contains only the threads this test explicitly creates.
  fake.threads.clear();
  setupThreads(fake, { repoDir, deskDir });

  const host = createHost({
    endpoint: fake.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(dir, "t3code.json"),
  });
  await host.connect();
  t.after(() => host.close());

  const adapter = createAdapter(Policy, host);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new Engine(store, adapter, 0);
  engine.hostIds = () => [host.hostId];
  engine.resolveHostAdapter = (id) => (id === host.hostId ? adapter : undefined);
  engine.identifyOriginHost = async () => host.hostId;
  store.upsertProject({
    key: "example",
    name: "Example",
    repositories: [{ origin: "synthetic/example", path: repoDir }],
  });
  const repositories = new RuntimeRepositories({
    store,
    engine,
    markStoreAccess() {},
  } as never);

  // Create a live worker run that can issue `tell` to `{ project: "example" }`.
  const senderTask = store.insert(
    submissionSchema.parse({
      submissionId: "sender-task",
      title: "Sender",
      repoPath: repoDir,
      planningCommit: BASE_SHA,
      brief: { text: "Sender brief" },
      originAgentId: formatAgentId(host.hostId, "other-sender"),
    }),
    host.hostId,
    "brief",
    BASE_SHA,
  );
  store.update(senderTask.id, {
    phase: "working",
    runId: "sender-run",
    agentId: "sender-worker",
    workspaceId: "ws-sender",
  });
  store.putRun({
    id: "sender-run",
    taskId: senderTask.id,
    role: "revision",
    generation: 1,
    head: BASE_SHA,
    agentId: "sender-worker",
    hostId: host.hostId,
    workspaceId: "ws-sender",
    status: "running",
    createdAt: STAMP,
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  } as unknown as Run);
  store.update(senderTask.id, {
    resolution: { ...store.task(senderTask.id).resolution, currentRunId: "sender-run" },
  });
  store.setCredential("sender-run", "sender-token");

  const tellProject = (n: number) =>
    engine.resolution.agentMessage(
      agentMessageSchema.parse({
        eventId: n.toString(16).padStart(64, "0"),
        taskId: senderTask.id,
        runId: "sender-run",
        to: { project: "example" },
        text: `hello ${n}`,
      }),
      "sender-token",
    );

  return { dir, repoDir, deskDir, fake, host, adapter, store, engine, repositories, tellProject };
}

test("real T3 adapter resolves MCP-launched registered planner outside any repo checkout and delivers tell", async (t) => {
  const mcpId = "mcp:b619ccc9-a078-49f6-b80f-6bececcfa6ca";
  const f = await t3Fixture(t, (fake, { deskDir }) => {
    fake.threads.set(
      mcpId,
      makeProjection(mcpId, deskDir, {
        projectId: "proj-desk",
        title: "Barge Planner",
        worktreePath: null,
        creationSource: "mcp",
        updatedAt: "2026-11-21T20:00:00.000Z",
      }),
    );
  });
  const qualified = formatAgentId(f.host.hostId, mcpId);
  f.store.setProjectPlanner({
    key: "example",
    agentId: qualified,
    setBy: "operator",
  });

  const project = await f.repositories.getProject({ key: "example" });
  assert.equal(project?.responsibleThread?.thread?.agentId, qualified);
  assert.equal(project?.responsibleThread?.thread?.hostId, f.host.hostId);
  assert.deepEqual(project?.responsibleThread?.thread?.reasons, ["registered-planner"]);
  assert.equal(project?.responsibleThread?.shortlist[0]?.observation?.state, "routable");

  const receipt = await f.tellProject(1);
  assert.equal(receipt.status, "delivered");
  assert.ok(
    f.fake.commands.some(
      (cmd) => cmd.type === "message.dispatch" && cmd.threadId === mcpId,
    ),
    "expected message.dispatch to reach the MCP-launched T3 planner thread",
  );

  // Archiving the planner drops it from resolution and never revives it.
  const entry = f.fake.threads.get(mcpId)!;
  entry.thread.archivedAt = "2026-11-21T21:00:00.000Z";
  f.engine.resolution.responsibleThreads.cache.invalidate("example");
  const commandsBefore = f.fake.commands.length;

  const afterArchive = await f.repositories.getProject({ key: "example" });
  assert.equal(afterArchive?.responsibleThread?.thread, null);
  const expired = await f.tellProject(2);
  assert.equal(expired.status, "expired");
  assert.equal(f.fake.commands.length, commandsBefore);
});

test("real T3 adapter resolves a registered named agent and a task dispatcher outside any repo checkout", async (t) => {
  const namedId = "mcp:named-lead-1";
  const dispatcherId = "mcp:dispatcher-1";
  const f = await t3Fixture(t, (fake, { deskDir }) => {
    fake.threads.set(
      namedId,
      makeProjection(namedId, deskDir, {
        projectId: "proj-desk",
        title: "Named Lead",
        worktreePath: null,
        creationSource: "mcp",
        updatedAt: "2026-11-21T20:05:00.000Z",
      }),
    );
    fake.threads.set(
      dispatcherId,
      makeProjection(dispatcherId, deskDir, {
        projectId: "proj-desk",
        title: "Task Dispatcher",
        worktreePath: null,
        creationSource: "mcp",
        updatedAt: "2026-11-21T20:00:00.000Z",
      }),
    );
  });
  const namedQualified = formatAgentId(f.host.hostId, namedId);
  const dispatcherQualified = formatAgentId(f.host.hostId, dispatcherId);

  f.store.registerProjectAgent({
    key: "example",
    name: "lead",
    purpose: "Project lead",
    agentId: namedQualified,
    hostId: f.host.hostId,
    registeredBy: "operator",
  });

  // Named agent resolves when no planner or dispatcher is present.
  const withNamed = await f.repositories.getProject({ key: "example" });
  assert.equal(withNamed?.responsibleThread?.thread?.agentId, namedQualified);
  assert.deepEqual(withNamed?.responsibleThread?.thread?.reasons, ["registered-agent"]);

  // A live T3 thread that dispatched a project task qualifies as dispatcher and outranks a named agent.
  f.store.insert(
    submissionSchema.parse({
      submissionId: "dispatched-task",
      title: "Dispatched",
      repoPath: f.repoDir,
      planningCommit: BASE_SHA,
      brief: { text: "Dispatched brief" },
      originAgentId: dispatcherQualified,
    }),
    f.host.hostId,
    "brief",
    BASE_SHA,
  );
  const withDispatcher = await f.repositories.getProject({ key: "example" });
  assert.equal(withDispatcher?.responsibleThread?.thread?.agentId, dispatcherQualified);
  assert.deepEqual(withDispatcher?.responsibleThread?.thread?.reasons, ["dispatcher"]);
});

test("real T3 adapter excludes task parents, inbox, and subagent threads from the responsible shortlist", async (t) => {
  const plannerId = "mcp:live-planner";
  const parentId = "nucleus-thread-parent-1";
  const inboxId = "nucleus-thread-inbox-1";
  const subagentId = "thread:subagent:abc123";
  const delegatedId = "thread:delegated-task:def456";
  const f = await t3Fixture(t, (fake, { repoDir, deskDir }) => {
    fake.threads.set(
      plannerId,
      makeProjection(plannerId, deskDir, {
        projectId: "proj-desk",
        title: "Live Planner",
        worktreePath: null,
        creationSource: "mcp",
        updatedAt: "2026-11-21T19:00:00.000Z",
      }),
    );
    fake.threads.set(
      parentId,
      makeProjection(parentId, repoDir, {
        projectId: "synthetic-project",
        title: "Task Parent",
        providerInstanceId: "nucleus",
        worktreePath: null,
        updatedAt: "2026-11-21T21:00:00.000Z",
      }),
    );
    fake.threads.set(
      inboxId,
      makeProjection(inboxId, repoDir, {
        projectId: "synthetic-project",
        title: "Nucleus",
        providerInstanceId: "nucleus",
        worktreePath: null,
        updatedAt: "2026-11-21T21:00:00.000Z",
      }),
    );
    fake.threads.set(
      subagentId,
      makeProjection(subagentId, repoDir, {
        projectId: "synthetic-project",
        title: "Subagent",
        worktreePath: null,
        lineage: {
          parentThreadId: plannerId,
          relationshipToParent: "subagent",
          rootThreadId: plannerId,
        },
        updatedAt: "2026-11-21T21:00:00.000Z",
      }),
    );
    fake.threads.set(
      delegatedId,
      makeProjection(delegatedId, repoDir, {
        projectId: "synthetic-project",
        title: "Delegated Child",
        worktreePath: null,
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "delegated_task",
          rootThreadId: parentId,
        },
        updatedAt: "2026-11-21T21:00:00.000Z",
      }),
    );
  });
  const plannerQualified = formatAgentId(f.host.hostId, plannerId);
  f.store.setProjectPlanner({
    key: "example",
    agentId: plannerQualified,
    setBy: "operator",
  });

  const project = await f.repositories.getProject({ key: "example" });
  assert.deepEqual(
    project?.responsibleThread?.shortlist.map((candidate) => candidate.agentId),
    [plannerQualified],
  );
  assert.equal(project?.responsibleThread?.thread?.agentId, plannerQualified);
});

test("real T3 adapter keeps an unverifiable planner as unverified rather than gone", async (t) => {
  const mcpId = "mcp:unverifiable-planner";
  const f = await t3Fixture(t, (fake, { deskDir }) => {
    fake.threads.set(
      mcpId,
      makeProjection(mcpId, deskDir, {
        projectId: "proj-desk",
        title: "Busy Planner",
        worktreePath: null,
        creationSource: "mcp",
        updatedAt: "2026-11-21T20:00:00.000Z",
      }),
    );
  });
  const qualified = formatAgentId(f.host.hostId, mcpId);
  f.store.setProjectPlanner({
    key: "example",
    agentId: qualified,
    setBy: "operator",
  });
  // Fail the per-thread projection read after listLiveAgents succeeds.
  const originalOrigin = f.host.originAgent.bind(f.host);
  f.host.originAgent = async (id: string) => {
    if (id === mcpId) throw new Error("transient projection read failure");
    return originalOrigin(id);
  };

  const project = await f.repositories.getProject({ key: "example" });
  assert.equal(project?.responsibleThread?.thread?.agentId, qualified);
  assert.equal(project?.responsibleThread?.shortlist[0]?.observation?.state, "unverified");
});
