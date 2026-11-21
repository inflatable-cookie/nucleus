import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, PROFILE_CATALOG_LOADING_REFUSAL } from "../core/engine";
import { Store } from "../core/store/store";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { hostCatalogSchema } from "../shared/host";
import {
  poolSchema,
  submissionSchema,
  taskControlInputSchema,
  taskNextSchema,
  type Profile,
  type Run,
  type Task,
} from "../shared/contracts";
import { fakeAdapter, profile, submission } from "./support/fakes";

/**
 * nucleus#1500: an owner profile control reads the host catalogs its own
 * decision reads, never the legacy primary's snapshot alone. A T3-owned task
 * whose legacy Paseo primary is offline and unread stays routable while the T3
 * host answers for profiles; the preview (`next`) and the control read the same
 * per-host evidence, and an unread catalog still waits with the host named.
 */

const base = "b".repeat(40);
const head = "a".repeat(40);
const branch = "ns-task-1500";
const T3 = "t3code:one";
const PRIMARY = "paseo:legacy";

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));

/** The T3 host's own catalog: Codex Terra (the alternative) and Sol (the retained one). */
const t3Catalog = () =>
  hostCatalogSchema.parse({
    providers: [
      {
        key: "codex",
        label: "Codex",
        available: true,
        problem: "",
        models: ["gpt-6.1-terra", "gpt-6.1-sol"].map((id) => ({
          id,
          label: id,
          aliases: [],
          thinkingOptions: levels("low", "medium", "high", "xhigh", "max"),
          defaultThinkingOptionId: null,
          modes: [
            "approval-required",
            "auto-accept-edits",
            "auto",
            "full-access",
          ].map((mode) => ({ id: mode, label: mode })),
          features: [],
        })),
      },
    ],
  });

function routingRecord({
  available,
  problem,
  supportedThinking,
  ...rest
}: Profile) {
  return rest;
}

async function fixture(
  options: { readCatalog?: boolean; providerFailure?: boolean } = {},
) {
  const providerFailure = options.providerFailure !== false;
  const dir = mkdtempSync(join(tmpdir(), "ns-route-catalog-"));
  const worktree = join(dir, "worktree");
  mkdirSync(worktree, { recursive: true });
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("usageLevel", "normal");
  store.setMeta("globalLimit", 12);

  const terra = profile("terra", "gpt-6.1-terra", { provider: "codex" });
  const sol = profile("sol", "gpt-6.1-sol", { provider: "codex" });
  const oracle = profile("t3-oracle", "gpt-6.1-sol", { provider: "codex" });
  // A Claude profile no T3 catalog reports: genuinely incompatible there, not
  // merely unread.
  const elsewhere = profile("paseo-only", "claude-opus-5-5", {
    provider: "claude",
  });
  const all = [terra, sol, oracle, elsewhere];
  store.setProfiles(all.map(routingRecord));
  store.setMeta(
    "pool",
    all.map((candidate) =>
      poolSchema.parse({
        profileId: candidate.id,
        enabled: true,
        group: candidate.id,
        roles: ["worker"],
        weight: "default",
        scopes: ["general"],
        capability: candidate.id === oracle.id ? "frontier" : "worker",
      }),
    ),
  );

  const observations = new Map<
    string,
    {
      id: string;
      workspaceId: string | null;
      status: string;
      active: boolean;
      permissions: boolean;
      error: string;
      activeTurnId?: string;
    }
  >();
  const launches: Array<{
    agentId: string;
    hostId: string | null;
    profileId: string;
    workspaceId: string | null;
    branch: string;
  }> = [];
  const stoppedAgents: string[] = [];

  const t3 = fakeAdapter({
    hostId: T3,
    isConnected: () => true,
    catalog: async () => t3Catalog(),
    vocabulary: t3codeVocabulary,
    validate: async () => base,
    verifyWorkspace: async () => branch,
    verifyResume: async () => {},
    createWorkspace: async () => {
      throw new Error("this fixture keeps the retained worktree");
    },
    createAgent: async (task: Task) => {
      const id = `agent-${task.runId}`;
      launches.push({
        agentId: id,
        hostId: task.hostId,
        profileId: task.profile?.id ?? "",
        workspaceId: task.workspaceId,
        branch: task.branch,
      });
      observations.set(id, {
        id,
        workspaceId: task.workspaceId ?? null,
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      });
      return { id, workspaceId: task.workspaceId };
    },
    createRun: async (task: Task, run: Run) => {
      const id = `agent-${run.id}`;
      launches.push({
        agentId: id,
        hostId: run.hostId ?? task.hostId,
        profileId: run.profile?.id ?? "",
        workspaceId: task.workspaceId,
        branch: task.branch,
      });
      observations.set(id, {
        id,
        workspaceId: task.workspaceId ?? null,
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      });
      return { id, workspaceId: task.workspaceId };
    },
    observe: async (agentId: string) =>
      observations.get(agentId) ?? {
        id: agentId,
        workspaceId: null,
        status: "closed",
        active: false,
        permissions: false,
        error: "",
      },
    stopAgentTurn: async (agentId: string) => {
      stoppedAgents.push(agentId);
      const state = observations.get(agentId);
      if (state) {
        state.active = false;
        state.status = "idle";
        state.activeTurnId = undefined;
      }
    },
    verifyPr: async () => ({
      number: 7,
      url: "https://github.com/example/repo/pull/7",
      head,
      base: "main",
      mergeable: "CLEAN",
      behind: 0,
    }),
  } as unknown as Partial<Adapter & ResolutionAdapter>);

  // The legacy primary positively reports itself offline, so no catalog read is
  // even attempted for it: exactly the service start this task records.
  const primary = fakeAdapter({
    hostId: PRIMARY,
    isConnected: () => false,
    catalog: async () => {
      throw new Error("the legacy primary is offline");
    },
    observe: async () => {
      throw new Error("the legacy primary is offline");
    },
    validate: async () => base,
    verifyWorkspace: async () => branch,
    verifyResume: async () => {},
    createWorkspace: async () => {
      throw new Error("the legacy primary is offline");
    },
    createAgent: async () => {
      throw new Error("the legacy primary is offline");
    },
    verifyPr: async () => {
      throw new Error("the legacy primary is offline");
    },
  } as unknown as Partial<Adapter & ResolutionAdapter>);

  const engine = new Engine(store, primary, 0);
  engine.hostIds = () => [PRIMARY, T3];
  engine.resolveHostAdapter = (id) =>
    id === T3 ? t3 : id === PRIMARY ? primary : undefined;
  engine.hostAvailable = (id) => id !== PRIMARY;
  if (options.readCatalog !== false) await engine.refresh();

  const task = store.insert(
    submission({
      complexity: "medium",
      repoPath: join(dir, "repo"),
      planningCommit: base,
    }),
    T3,
    "handoff",
    base,
  );
  store.update(task.id, {
    phase: "working",
    workspaceId: "ws-t3-one",
    directory: worktree,
    agentId: "ag-retained",
    runId: "run-retained",
    profile: sol,
    profileGroup: sol.id,
    workerModel: sol.model,
    branch,
    prUrl: "https://github.com/example/repo/pull/7",
    prHead: head,
    resumePrNumber: 7,
    ...(providerFailure
      ? {
          failoverReason: "Provider quota exhausted",
          workerExclusions: [
            {
              agentId: null,
              profileId: sol.id,
              reason: "Provider quota exhausted",
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : {}),
  });
  observations.set("ag-retained", {
    id: "ag-retained",
    workspaceId: "ws-t3-one",
    status: providerFailure ? "error" : "idle",
    active: false,
    permissions: false,
    error: providerFailure ? "429 quota exhausted" : "",
  });
  if (providerFailure)
    // The retained provider's own subscription group is exhausted, which is the
    // positive failure the replacement rule reads.
    store.setAvailability(
      sol.id,
      JSON.stringify({
        group: sol.id,
        unavailable: true,
        reason: "Provider quota exhausted",
        retryAt: null,
      }),
    );

  const current = () => store.task(task.id);
  const next = () =>
    taskNextSchema.parse(
      ownerTaskNext({
        ...collectOwnerVerbFacts(store, current()),
        hostProfiles: engine.workerRoutingProfiles(current()),
        hostViews: engine.routingHostViews(current()),
      }),
    );
  const control = (args: Record<string, unknown>) =>
    engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: current().version,
        action: "route",
        role: "worker",
        reason: "Owner route",
        caller: "owner-thread",
        ...args,
      }),
    );

  return {
    dir,
    store,
    engine,
    taskId: task.id,
    profiles: { terra, sol, oracle, elsewhere },
    observations,
    launches,
    stoppedAgents,
    current,
    next,
    control,
    events: (kind: string) =>
      store.events(task.id).filter((event) => event.kind === kind),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("nucleus#1500: a T3-owned task routes its worker while the legacy primary is offline and unread", async () => {
  const f = await fixture();
  try {
    // The primary-only guard this replaces could not pass here: the daemon's
    // primary profile set was never read.
    assert.equal(f.engine.profileCatalogKnown(), false);
    assert.equal(f.engine.profileCatalogKnownFor(T3), true);

    const view = f.next();
    const routeView = view.verbs.find(
      (verb) => verb.verb === "route" && verb.args?.role === "worker",
    )!;
    assert.equal(routeView.available, true);
    assert.equal(routeView.args?.profileId, f.profiles.sol.id);
    // The preview reads the same per-host evidence: T3 online and read, the
    // legacy primary offline, and the retained profile still eligible on T3.
    const hosts = view.routingPolicy!.hosts!;
    const t3View = hosts.find((host) => host.hostId === T3)!;
    const primaryView = hosts.find((host) => host.hostId === PRIMARY)!;
    assert.equal(t3View.online, true);
    assert.equal(primaryView.online, false);
    assert.deepEqual(
      t3View.profiles.find((entry) => entry.profileId === f.profiles.sol.id),
      {
        profileId: f.profiles.sol.id,
        eligible: true,
        reason: "Available on host",
      },
    );
    assert.equal(
      f.engine.profileCatalogRefusal(f.current(), ["worker"]),
      null,
      "the control's own evidence is the preview's: the T3 catalog answers it",
    );

    const routed = await f.control({
      profileId: f.profiles.terra.id,
      reason: "Provider quota exhausted; continue on Terra",
      now: true,
    });
    assert.equal(routed.hostId, T3, "the task stays on its bound host");
    assert.equal(
      routed.profileRequests?.worker?.profileId,
      f.profiles.terra.id,
    );
    assert.equal(routed.replacementProfile?.profileId, f.profiles.terra.id);
    assert.equal(
      routed.workspaceId,
      "ws-t3-one",
      "the route now displaces the run, not the worktree",
    );
    assert.equal(routed.directory, f.current().directory);
    assert.equal(routed.branch, branch);
    // The retained turn was already inactive, so the stop is settled from the
    // observation instead of sending a cancel; the worktree and branch are the
    // same either way.
    assert.deepEqual(f.stoppedAgents, []);
    assert.equal(f.events("route_stop_settled").length, 1);

    // The armed replacement is the one the failover pass performs: one
    // retirement, one launch, the same worktree and branch, on Terra's model.
    await f.engine.recoverExhaustedWorkers();
    const replaced = f.current();
    assert.equal(replaced.retiredWorkers.length, 1);
    assert.equal(replaced.retiredWorkers[0]!.agentId, "ag-retained");
    assert.equal(replaced.profile?.id, f.profiles.terra.id);
    assert.equal(replaced.workspaceId, "ws-t3-one");
    assert.equal(replaced.directory, worktreeOf(f));
    assert.equal(replaced.branch, branch);
    assert.deepEqual(
      f.launches.map(({ profileId, hostId, workspaceId, branch: at }) => ({
        profileId,
        hostId,
        workspaceId,
        branch: at,
      })),
      [
        {
          profileId: f.profiles.terra.id,
          hostId: T3,
          workspaceId: "ws-t3-one",
          branch,
        },
      ],
      "one replacement, on Terra, in the same worktree and branch",
    );

    // The preview now offers the recorded route, and a second pass authorizes
    // no further replacement.
    const after = f.next();
    const routeAfter = after.verbs.find(
      (verb) => verb.verb === "route" && verb.args?.role === "worker",
    )!;
    assert.equal(routeAfter.args?.profileId, f.profiles.terra.id);
    await f.engine.recoverExhaustedWorkers();
    assert.equal(f.launches.length, 1, "one replacement, not a loop");
    assert.equal(f.current().retiredWorkers.length, 1);
  } finally {
    await f.close();
  }
});

function worktreeOf(f: Awaited<ReturnType<typeof fixture>>) {
  return join(f.dir, "worktree");
}

test("nucleus#1500: an unread host catalog waits with that host named, then the same route applies", async () => {
  const f = await fixture({ readCatalog: false });
  try {
    const view = f.next();
    const t3View = view.routingPolicy!.hosts!.find(
      (host) => host.hostId === T3,
    )!;
    assert.equal(t3View.online, true);
    assert.deepEqual(
      t3View.profiles.find((entry) => entry.profileId === f.profiles.sol.id),
      {
        profileId: f.profiles.sol.id,
        eligible: false,
        reason: "Host catalog not yet read",
      },
    );

    const before = f.current();
    await assert.rejects(
      f.control({
        profileId: f.profiles.terra.id,
        reason: "Retry on Terra",
        now: true,
      }),
      (error: Error) => {
        assert.match(error.message, /T3Code host one/);
        assert.doesNotMatch(
          error.message,
          new RegExp(PROFILE_CATALOG_LOADING_REFUSAL.slice(0, 40)),
        );
        return true;
      },
    );
    assert.equal(
      f.current().version,
      before.version,
      "the refusal writes nothing",
    );

    // The same evidence the preview names is what the control waited for.
    await f.engine.refresh();
    const routed = await f.control({
      profileId: f.profiles.terra.id,
      reason: "Retry on Terra",
      now: true,
    });
    assert.equal(
      routed.profileRequests?.worker?.profileId,
      f.profiles.terra.id,
    );
    assert.equal(routed.workspaceId, "ws-t3-one");
    assert.equal(routed.branch, branch);
  } finally {
    await f.close();
  }
});

test("nucleus#1500: a genuinely incompatible profile still refuses on the task's own host catalog", async () => {
  const f = await fixture();
  try {
    const before = f.current();
    await assert.rejects(
      f.control({
        profileId: f.profiles.elsewhere.id,
        reason: "Route to the Paseo-only profile",
        now: true,
      }),
      /cannot run on task host t3code:one/,
    );
    assert.equal(f.current().version, before.version);
    assert.equal(f.current().agentId, "ag-retained");
  } finally {
    await f.close();
  }
});

test("nucleus#1500: the sign-off fence still holds a route the level withholds", async () => {
  const f = await fixture({ providerFailure: false });
  try {
    await assert.rejects(
      f.control({
        profileId: f.profiles.oracle.id,
        reason: "Frontier review of the failed provider",
        now: true,
      }),
      /needs the operator's board sign-off/,
    );
    const held = f.current();
    assert.equal(
      held.profileRequests?.worker?.profileId,
      f.profiles.oracle.id,
      "the request is recorded for the operator",
    );
    assert.equal(held.profileRequests?.worker?.signoff, undefined);
    assert.equal(held.agentId, "ag-retained", "the retained run is untouched");
    assert.equal(held.replacementProfile ?? null, null);
    assert.equal(held.phase, "working");
    assert.deepEqual(f.stoppedAgents, []);
    assert.equal(f.events("route_stop_settled").length, 0);
  } finally {
    await f.close();
  }
});
