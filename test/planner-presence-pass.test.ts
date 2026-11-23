import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import type { Adapter, AgentObservation, OriginAgent } from "../core/host";
import {
  PlannerPresencePass,
  type PlannerRoutes,
  type PlannerThreadRoute,
} from "../core/questions/planner-presence";
import { formatAgentId, parseAgentId } from "../shared/agent-identity";
import { fakeAdapter, tempStore } from "./support/fakes";

/**
 * Planner presence is read once per pass (perf pass 2026-11-23, brief C).
 *
 * The sweep's responsible-thread refresh asked the host for each shortlisted
 * thread of every project, and then again for each project's registered planner,
 * so one planner thread shared by several projects cost several host reads a
 * pass (about 1.1 `originAgent` calls a second in the live service). One pass now
 * reads each thread once and every question in the pass shares that read.
 */

function engineWithSharedPlanner(t: Parameters<typeof tempStore>[0]) {
  const { store } = tempStore(t);
  const agents = new Map<string, OriginAgent>([
    [
      "alpha",
      {
        id: "alpha",
        workspaceId: "project-a",
        title: "Planner",
        archived: false,
      },
    ],
  ]);
  const native = (id: string) => parseAgentId(id)?.nativeAgentId ?? id;
  const reads: string[] = [];
  const adapter = fakeAdapter({
    hostId: "host",
    profiles: async () => [],
    originAgent: async (id: string) => {
      reads.push(native(id));
      return agents.get(native(id)) ?? null;
    },
    listLiveAgents: async () =>
      [...agents.values()].map((agent) => ({
        id: agent.id,
        title: agent.title,
        workspaceId: agent.workspaceId,
      })),
    observe: async (id: string): Promise<AgentObservation> => ({
      id: native(id),
      workspaceId: "project-a",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
  } as unknown as Adapter);
  const engine = new Engine(store, adapter);
  engine.hostIds = () => ["host"];
  engine.identifyOriginHost = async () => "host";
  t.after(() => engine.stop());
  for (const key of ["app", "web", "docs"]) {
    store.upsertProject({
      key,
      name: key,
      repositories: [{ origin: null, path: `/repo/${key}` }],
    });
    store.setProjectPlanner({ key, agentId: "alpha", setBy: "test" });
  }
  return { store, engine, reads };
}

test("one sweep pass reads a planner shared by three projects once, and the next pass reads it again", async (t) => {
  const { store, engine, reads } = engineWithSharedPlanner(t);
  const projects = store.projects();
  assert.equal(projects.length, 3);

  const first = await engine.resolution.refreshResponsibleThreads(projects);
  assert.ok(
    first.every((read) =>
      read.shortlist.some((c) => c.agentId.includes("alpha")),
    ),
    "every project still routes to its planner",
  );
  assert.deepEqual(
    reads,
    ["alpha"],
    "the candidate probes and gone-planner checks of every project share one read",
  );

  await engine.resolution.refreshResponsibleThreads(store.projects());
  assert.deepEqual(reads, ["alpha", "alpha"], "a new pass reads afresh");
});

test("a pass shares one read per thread and host, and a question with no host borrows the pass's read", async () => {
  const asked: Array<[string, string | null | undefined]> = [];
  const owner: PlannerRoutes = {
    threadRoute: async (agentId, hostId) => {
      asked.push([agentId, hostId]);
      return { kind: "routable" } satisfies PlannerThreadRoute;
    },
  };
  const pass = new PlannerPresencePass(owner);
  const qualified = formatAgentId("host-a", "alpha");
  await Promise.all([
    pass.threadRoute("alpha", "host-a"),
    pass.threadRoute(qualified),
    pass.threadRoute(qualified, "host-a"),
    // The candidate the pass saw on one host answers the hostless question.
    pass.threadRoute("alpha"),
  ]);
  assert.deepEqual(asked, [["alpha", "host-a"]]);

  // The same native id on a second host is its own thread.
  await pass.threadRoute("alpha", "host-b");
  // Seen on two hosts now, a hostless question is asked on its own.
  await pass.threadRoute("alpha");
  // A recorded host that disagrees with the identity's own host never borrows.
  await pass.threadRoute(qualified, "host-b");
  assert.deepEqual(asked, [
    ["alpha", "host-a"],
    ["alpha", "host-b"],
    ["alpha", undefined],
    [qualified, "host-b"],
  ]);
});
