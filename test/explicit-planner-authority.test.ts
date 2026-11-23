import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import type { Adapter } from "../core/host";
import {
  ParticipantTickets,
  plannerTicketKey,
  resolveTicketCaller,
  taskPlannerTicketKey,
} from "../core/dispatch/participant-tickets";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, type Run, type Task } from "../shared/contracts";
import { explicitResolutionSchema } from "../shared/schema/task-control";
import {
  livePlannerMatches,
  resolveExplicitly,
} from "../core/verbs/explicit-resolution";

// Spec 067 authority: any confirmed responsible planner of the task's project
// may run an explicit command, not only the thread project messages route to
// (Tom, 2026-11-19: no singleton planners). The real responsible-thread
// resolver, observation and explicit-command path run here; only the host's
// inventory and thread reads are synthetic.

const repo = "/synthetic/example";
const base = "c".repeat(40);
const host = "t3code:synthetic";
const caller = (native: string) => formatAgentId(host, native);

type Thread = {
  id: string;
  title: string;
  workspaceId: null;
  directory: string;
  updatedAt: string;
};

function fixture(threads: Thread[]) {
  const directory = mkdtempSync(join(tmpdir(), "explicit-authority-"));
  const store = new Store(":memory:");
  const unroutable = new Set<string>();
  /** Runs inside each inventory and each thread read, so a test can invalidate mid-read. */
  const during = {
    inventory: () => {},
    observation: (_id: string) => {},
  };
  const adapter = {
    hostId: host,
    listLiveAgents: async () => {
      // After the cache has registered this inventory as its pending read.
      await new Promise((resolve) => setImmediate(resolve));
      during.inventory();
      return threads;
    },
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: false,
    }),
    observe: async (id: string) => ({
      id,
      workspaceId: null,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      archived: false,
    }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.identifyOriginHost = async () => host;
  engine.hostAvailable = () => true;
  engine.resolution.plannerPresence.threadRoute = async (id) => {
    during.observation(id);
    return unroutable.has(id)
      ? { kind: "unroutable", detail: "the host named a different thread" }
      : { kind: "routable" };
  };
  store.upsertProject({
    key: "example",
    name: "Example",
    repositories: [{ origin: null, path: repo }],
  });
  let submissions = 0;
  const insert = (fields: { originAgentId: string } & Partial<Task>) => {
    const { originAgentId, ...patch } = fields;
    const inserted = store.insert(
      submissionSchema.parse({
        submissionId: `authority-${++submissions}`,
        title: `Authority ${submissions}`,
        repoPath: repo,
        planningCommit: base,
        brief: { text: "Authority brief" },
        originAgentId,
      }),
      host,
      "brief",
      base,
      { originHostId: host },
    );
    store.update(inserted.id, { phase: "awaiting_review", ...patch });
    return inserted.id;
  };
  const command = (taskId: string, by: string | undefined) =>
    resolveExplicitly(
      engine,
      explicitResolutionSchema.parse({
        action: "phase.set",
        taskId,
        version: store.task(taskId).version,
        to: "reviewing",
        reason: "Authority check",
        ...(by ? { caller: by } : {}),
      }),
      () => "next",
    );
  const close = () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return {
    directory,
    store,
    engine,
    adapter,
    unroutable,
    during,
    insert,
    command,
    close,
  };
}

const thread = (id: string, updatedAt: string): Thread => ({
  id,
  title: id,
  workspaceId: null,
  directory: repo,
  updatedAt,
});

test("a responsible planner that is not the routing pick may run an explicit command", async () => {
  const f = fixture([
    thread("alpha", "2099-02-01T00:00:00Z"),
    thread("beta", "2099-01-01T00:00:00Z"),
  ]);
  try {
    const alphaTask = f.insert({ originAgentId: "alpha" });
    const betaTask = f.insert({ originAgentId: "beta" });
    const read = await f.engine.resolution.responsibleThread(
      f.store.projectByKey("example")!,
    );
    assert.equal(read.incomplete, false);
    assert.equal(read.thread?.agentId, caller("alpha"), "alpha is the pick");
    assert.deepEqual(
      read.shortlist.map((candidate) => [candidate.agentId, candidate.reasons]),
      [
        [caller("alpha"), ["dispatcher", "repository-worker"]],
        [caller("beta"), ["dispatcher", "repository-worker"]],
      ],
    );

    const applied = await f.command(betaTask, caller("beta"));
    assert.equal(applied.explicitResolution?.status, "applied");
    assert.equal(f.store.task(betaTask).phase, "reviewing");
    // A planner of the project acts on its other tasks too, and force agrees.
    assert.equal(
      await livePlannerMatches(f.engine, f.store.task(alphaTask), caller("beta")),
      true,
    );
    assert.equal(
      await f.engine.forceCallerAuthorized(
        f.store.task(alphaTask),
        caller("beta"),
      ),
      true,
    );
  } finally {
    f.close();
  }
});

test("the project planner's project ticket and task-planner ticket both act on a reparented task", async () => {
  const f = fixture([
    thread("mcp:previous-planner", "2099-03-01T00:00:00Z"),
    thread("mcp:project-planner", "2099-01-01T00:00:00Z"),
  ]);
  try {
    const paths = {
      socketPath: join(f.directory, "callback.sock"),
      helperPath: join(f.directory, "helper.mjs"),
    };
    const tickets = new ParticipantTickets(f.engine, paths);
    const planner = caller("mcp:project-planner");
    // Reparented: no recorded planner, the origin is the previous planner thread.
    const reparented = f.insert({
      originAgentId: "mcp:previous-planner",
      plannerAgentId: null,
    });
    // The project planner still plans another live task, so it holds a
    // task-planner ticket as well as its project ticket.
    f.insert({ originAgentId: "mcp:previous-planner", plannerAgentId: planner });
    await tickets.forCaller(planner);
    f.store.setProjectPlanner({
      key: "example",
      agentId: planner,
      setBy: planner,
    });
    await tickets.assigned("example");
    const ticketCaller = (key: string) => {
      const record = f.store.getMeta<{ path: string }>(key)!;
      const ticket = JSON.parse(readFileSync(record.path, "utf8")) as {
        participantId: string;
        token: string;
      };
      return resolveTicketCaller(
        f.store,
        { participantId: ticket.participantId },
        ticket.token,
      ).caller;
    };
    const fromProject = ticketCaller(plannerTicketKey("example"));
    const fromTask = ticketCaller(
      taskPlannerTicketKey(host, "mcp:project-planner"),
    );
    assert.equal(fromProject, planner);
    assert.equal(fromTask, fromProject, "both tickets name the same caller");

    assert.equal(f.store.task(reparented).plannerAgentId ?? null, null);
    assert.equal(
      await livePlannerMatches(f.engine, f.store.task(reparented), fromTask),
      true,
    );
    const applied = await f.command(reparented, fromProject);
    assert.equal(applied.explicitResolution?.status, "applied");
    assert.equal(f.store.task(reparented).phase, "reviewing");
    // The previous planner, still a live dispatcher of the task, keeps authority.
    assert.equal(
      await livePlannerMatches(
        f.engine,
        f.store.task(reparented),
        caller("mcp:previous-planner"),
      ),
      true,
    );
  } finally {
    f.close();
  }
});

test("a worker, a checkout-only thread that is not the pick, an unroutable planner and a stranger are refused", async () => {
  const f = fixture([
    thread("planner", "2099-01-01T00:00:00Z"),
    thread("design", "2099-06-01T00:00:00Z"),
    thread("worker", "2099-07-01T00:00:00Z"),
    thread("rival", "2098-01-01T00:00:00Z"),
  ]);
  try {
    const taskId = f.insert({ originAgentId: "planner" });
    f.insert({ originAgentId: "rival" });
    f.store.update(taskId, {
      runId: "run",
      agentId: "worker",
      hostId: host,
      workspaceId: "ws",
    });
    f.store.putRun({
      id: "run",
      taskId,
      role: "revision",
      generation: 1,
      head: base,
      agentId: "worker",
      hostId: host,
      workspaceId: "ws",
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    } as unknown as Run);
    f.unroutable.add(caller("rival"));
    const read = await f.engine.resolution.responsibleThread(
      f.store.projectByKey("example")!,
    );
    assert.equal(read.thread?.agentId, caller("planner"));
    assert.ok(
      !read.shortlist.some((c) => c.agentId === caller("worker")),
      "a task-role thread is never a candidate",
    );
    assert.deepEqual(
      read.shortlist.find((c) => c.agentId === caller("design"))?.reasons,
      ["repository-worker"],
    );
    for (const refused of [
      caller("worker"),
      caller("design"),
      caller("rival"),
      caller("stranger"),
      formatAgentId("t3code:elsewhere", "planner"),
    ]) {
      assert.equal(
        await livePlannerMatches(f.engine, f.store.task(taskId), refused),
        false,
        refused,
      );
      await assert.rejects(
        f.command(taskId, refused),
        /Explicit resolution requires this task's coordinator, its live responsible planner or the operator board; this caller is not one of them/,
      );
    }
    assert.equal(f.store.task(taskId).phase, "awaiting_review");
  } finally {
    f.close();
  }
});

test("an incomplete shortlist keeps the routing pick and the registered planner, and names the unread host otherwise", async () => {
  const f = fixture([
    thread("alpha", "2099-02-01T00:00:00Z"),
    thread("beta", "2099-01-01T00:00:00Z"),
  ]);
  try {
    const taskId = f.insert({ originAgentId: "alpha" });
    f.insert({ originAgentId: "beta" });
    // A second online host whose inventory fails: absence is not proved.
    const broken = {
      hostId: "t3code:unreadable",
      listLiveAgents: async () => {
        throw Error("inventory unreadable");
      },
    } as unknown as Adapter;
    const healthy = f.adapter;
    f.engine.hostIds = () => [host, "t3code:unreadable"];
    f.engine.resolveHostAdapter = (id) =>
      id === host ? healthy : id === "t3code:unreadable" ? broken : undefined;
    const project = () => f.store.projectByKey("example")!;
    const read = await f.engine.resolution.responsibleThread(project());
    assert.equal(read.confirmed, true);
    assert.equal(read.incomplete, true);
    assert.deepEqual(read.unreadHosts, ["t3code:unreadable"]);
    assert.equal(read.thread?.agentId, caller("alpha"));
    const unread =
      /the responsible-planner read for project Example is incomplete \(host t3code:unreadable unread\)/;

    // The routing pick keeps authority, as before.
    assert.equal(
      await livePlannerMatches(f.engine, f.store.task(taskId), caller("alpha")),
      true,
    );
    // Another dispatcher, a stranger and an unroutable thread are refused,
    // and the refusal names the unread host.
    for (const refused of [caller("beta"), caller("stranger")]) {
      await assert.rejects(f.command(taskId, refused), unread);
    }

    // A registered planner keeps authority on an incomplete read too.
    f.store.setProjectPlanner({
      key: "example",
      agentId: caller("beta"),
      setBy: "operator",
    });
    const registered = await f.engine.resolution.responsibleThread(project());
    assert.equal(registered.incomplete, true);
    assert.equal(registered.thread?.agentId, caller("beta"));
    f.unroutable.add(caller("beta"));
    f.engine.resolution.responsibleThreads.cache.invalidate("example");
    await assert.rejects(f.command(taskId, caller("beta")), unread);
    f.unroutable.delete(caller("beta"));
    f.engine.resolution.responsibleThreads.cache.invalidate("example");
    const applied = await f.command(taskId, caller("beta"));
    assert.equal(applied.explicitResolution?.status, "applied");
    // Alpha is now a dispatcher that is not the pick on an incomplete read.
    assert.equal(
      await livePlannerMatches(f.engine, f.store.task(taskId), caller("alpha")),
      false,
    );
  } finally {
    f.close();
  }
});

test("the planner's own activity invalidating its shortlist mid-read does not refuse it", async () => {
  const f = fixture([
    thread("planner", "2099-01-01T00:00:00Z"),
    thread("design", "2099-06-01T00:00:00Z"),
  ]);
  try {
    const planner = caller("planner");
    const taskId = f.insert({ originAgentId: "planner" });
    f.store.setProjectPlanner({
      key: "example",
      agentId: planner,
      setBy: "operator",
    });
    // Every thread read lands alongside one of the planner's own calls, which
    // invalidates the shortlist naming it, so routing discards both attempts.
    f.during.observation = () =>
      f.engine.resolution.responsibleThreads.recordActivity(planner);
    const read = await f.engine.resolution.responsibleThread(
      f.store.projectByKey("example")!,
    );
    assert.equal(read.thread, null, "routing has no verified recipient");

    const applied = await f.command(taskId, planner);
    assert.equal(applied.explicitResolution?.status, "applied");
    assert.equal(read.confirmed, false);
    assert.equal(f.store.task(taskId).phase, "reviewing");
    assert.equal(
      await f.engine.forceCallerAuthorized(f.store.task(taskId), planner),
      true,
    );
    // The fallback serves only a registered planner or a dispatcher.
    assert.equal(
      await livePlannerMatches(f.engine, f.store.task(taskId), caller("design")),
      false,
    );
    await assert.rejects(
      f.command(taskId, caller("design")),
      /this caller is not one of them: it is not a responsible planner for project Example/,
    );
  } finally {
    f.close();
  }
});

test("a fallback read older than the bound refuses, and the refusal says the read is unconfirmed", async () => {
  const f = fixture([thread("planner", "2099-01-01T00:00:00Z")]);
  try {
    const planner = caller("planner");
    const taskId = f.insert({ originAgentId: "planner" });
    // One confirmed read, then every inventory is invalidated before it lands,
    // so no later read finishes.
    await f.engine.resolution.responsibleThread(f.store.projectByKey("example")!);
    f.engine.resolution.responsibleThreads.cache.invalidate("example");
    f.during.inventory = () =>
      f.engine.resolution.responsibleThreads.cache.invalidate("example");
    const unconfirmed = await f.engine.resolution.responsibleThread(
      f.store.projectByKey("example")!,
    );
    assert.equal(unconfirmed.thread, null, "routing has no verified recipient");
    assert.equal(
      await livePlannerMatches(f.engine, f.store.task(taskId), planner),
      true,
      "within the bound the finished read stands in",
    );
    assert.equal(unconfirmed.confirmed, false);

    f.engine.resolution.plannerAuthorityMaxAgeMs = 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(
      f.command(taskId, planner),
      /Explicit resolution requires this task's coordinator, its live responsible planner or the operator board; the responsible-planner read for project Example is unconfirmed, and no confirmed read finished in the last 0 minutes/,
    );
    assert.equal(f.store.task(taskId).phase, "awaiting_review");
  } finally {
    f.close();
  }
});
