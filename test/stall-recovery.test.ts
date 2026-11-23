import { fakeAdapter, createTaskAgent } from "./support/fakes";
import {
  toolTimelinePage,
  toolTimelineTail,
  longToolHistory,
} from "./support/tool-timeline";
/**
 * Mid-turn stall detection and recovery (Queue reliability lane).
 *
 * Opaque tools use the stall deadline. Output and permissions renew activity,
 * and the turn and its lease are still owned by the recorded participant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readProcessSubset } from "../core/machine/host-process-listing";
import { command, git } from "../core/git/index";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { phaseLatency } from "../core/scheduling/phase-latency";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { syntheticRun, t3Fake, threadProjection } from "./support/t3code-fake";
import type { Adapter, AgentObservation } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import {
  readToolTimeline,
  liveToolIssue,
  TOOL_TIMELINE_READ_BUDGET,
  TOOL_TIMELINE_READ_TIMEOUT_MS,
  runningShellCommand,
  type TimelineEntry,
  type TimelinePage,
} from "../core/recovery/stall";
import {
  dispositionSchema,
  hostRunSettlementSchema,
  profileSchema,
  submissionSchema,
  taskControlInputSchema,
  type Profile,
  type Task,
} from "../shared/contracts";

const profile = (id: string): Profile =>
  profileSchema.parse({
    id,
    name: id,
    provider: "test",
    model: id,
    notes: "",
    available: true,
    problem: "",
    supportedThinking: [],
  });

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** A busy mid-turn observation; overrides layer on top of a healthy running agent. */
const running = (
  overrides: Partial<AgentObservation> = {},
): AgentObservation => ({
  id: "worker",
  workspaceId: "task-ws",
  status: "running",
  active: true,
  permissions: false,
  error: "",
  updatedAt: minutesAgo(1),
  turnStartedAt: minutesAgo(2),
  activeTurnId: "worker-turn-1",
  ...overrides,
});

interface Fixture {
  root: string;
  repo: string;
  directory: string;
  base: string;
  head: string;
  store: Store;
  task: Task;
  engine: Engine;
  adapter: Adapter & Partial<ResolutionAdapter>;
  notices: string[];
  stopRequests: string[];
  createdRuns: string[];
  inspectedHeads: string[];
  setObservation: (state: AgentObservation) => void;
  setAgentObservation: (id: string, state: AgentObservation) => void;
  setStopFailure: (message: string | null) => void;
  hostRuns: HostRunScheduler;
  setTimelines: (pages: TimelineEntry[][]) => void;
}

async function fixture(
  t: {
    after: (cb: () => Promise<void> | void) => void;
  },
  graceMs = 0,
): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-stall-")));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  await command(
    "git",
    ["init", "--bare", "--initial-branch=main", join(root, "origin.git")],
    root,
  );
  await command(
    "git",
    ["clone", join(root, "origin.git"), join(root, "repo")],
    root,
  );
  const repo = join(root, "repo");
  await git(repo, "config", "user.name", "Queue test");
  await git(repo, "config", "user.email", "queue@example.invalid");
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs/plan.json"), "{}\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "push", "origin", "main");
  const base = await git(repo, "rev-parse", "HEAD");
  const directory = join(root, "task-worktree");
  await git(repo, "worktree", "add", "-b", "ns-task", directory, base);
  await writeFile(join(directory, "lane.txt"), "lane change\n");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "lane change");
  await git(directory, "push", "origin", "ns-task");
  const head = await git(directory, "rev-parse", "HEAD");
  const storeDir = await mkdtemp(join(tmpdir(), "nsq-stall-store-"));
  t.after(() =>
    rm(storeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const store = new Store(join(storeDir, "queue.sqlite"));
  store.setMeta("paused", false);
  const worker = profile("worker");
  const coordinator = profile("coordinator");
  const reviewer = profile("reviewer");
  store.setMeta("pool", [
    {
      profileId: worker.id,
      enabled: true,
      group: worker.id,
      roles: ["worker"],
      weight: "default",
      scopes: ["general"],
    },
    {
      profileId: coordinator.id,
      enabled: true,
      group: coordinator.id,
      roles: ["coordinator"],
      weight: "default",
      scopes: ["general"],
    },
    {
      profileId: reviewer.id,
      enabled: true,
      group: reviewer.id,
      roles: ["reviewer"],
      weight: "default",
      scopes: ["general"],
    },
  ]);
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Stall recovery",
      repoPath: repo,
      baseBranch: "main",
      planningCommit: base,
      handoffPath: "docs/plan.json",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  const task = store.update(submitted.id, {
    phase: "working",
    directory,
    branch: "ns-task",
    workspaceId: "task-ws",
    agentId: "worker",
    runId: "initial",
    profile: worker,
    workerModel: worker.model,
    agentActive: true,
    lastAgentStatus: "running",
    lastObservedAt: new Date().toISOString(),
  });
  const notices: string[] = [];
  const stopRequests: string[] = [];
  const createdRuns: string[] = [];
  const inspectedHeads: string[] = [];
  let stopFailure: string | null = null;
  const observations = new Map<string, AgentObservation>([
    ["worker", running()],
  ]);
  let timelinePages: TimelineEntry[][] = [];
  const adapter: Adapter & Partial<ResolutionAdapter> = fakeAdapter({
    supportsCoordinatorRecovery: true,
    profiles: async () => [worker, coordinator, reviewer],
    validate: async (candidate: Task) => candidate.planningCommit,
    createWorkspace: async (candidate: Task) => ({
      id: `ws-${candidate.id}`,
      directory,
    }),
    verifyWorkspace: async (candidate: Task) => candidate.branch,
    createAgent: createTaskAgent,
    createRun: async (_candidate, run) => {
      createdRuns.push(run.role);
      return { id: `agent-${run.id}`, workspaceId: run.workspaceId };
    },
    observe: async (id: string) => ({
      ...(observations.get(id) ?? observations.get("worker")!),
      id,
    }),
    stopAgentTurn: async (id: string) => {
      stopRequests.push(id);
      if (stopFailure) throw new Error(stopFailure);
    },
    agentTimeline: async () => timelinePages.shift() ?? [],
    agentTimelinePage: async (id: string) =>
      id === "worker"
        ? toolTimelinePage([])
        : toolTimelinePage(timelinePages.shift() ?? []),
    verifyPr: async () => ({
      url: "https://github.com/example/repo/pull/11",
      head,
    }),
    verifyPrIdentity: async () => ({
      url: "https://github.com/example/repo/pull/11",
      head,
    }),
    verifyInspectedRevisionHead: async (_candidate, _number, expected) => {
      inspectedHeads.push(expected);
    },
    findOpenBranchPr: async () => [],
    notify: async (_agentId: string, messageId: string) => {
      notices.push(messageId);
    },
  });
  const hostRuns = new HostRunScheduler(store, {
    capacity: () => ({
      cpuCapacity: 1,
      memoryCapacityBytes: 1_000_000_000,
      freeMemoryBytes: 1_000_000_000,
      loadAverage: [],
    }),
  });
  const engine = new Engine(store, adapter, graceMs);
  engine.profiles.push(worker, coordinator, reviewer);
  engine.hooks.options.hostRuns = hostRuns;
  // A coordinator admission leaves lane and host-run work behind it. Stop the
  // engine and drain it before a test closes the store, so a late continuation
  // reads no finalized statement.
  t.after(async () => {
    await engine.stop();
  });
  return {
    root,
    repo,
    directory,
    base,
    head,
    store,
    task,
    engine,
    adapter,
    notices,
    stopRequests,
    createdRuns,
    inspectedHeads,
    hostRuns,
    setObservation: (state) => {
      observations.set("worker", { ...state, id: "worker" });
    },
    setAgentObservation: (id, state) => {
      observations.set(id, { ...state, id });
    },
    setStopFailure: (message) => {
      stopFailure = message;
    },
    setTimelines: (pages) => {
      timelinePages = [...pages];
    },
  };
}

const shellEntry = (minutes: number, command = "effigy qa"): TimelineEntry => ({
  timestamp: minutesAgo(minutes),
  item: {
    type: "tool_call",
    status: "running",
    name: "Bash",
    detail: { type: "shell", command },
  },
});

const opaqueTool = (): TimelineEntry => ({
  ...shellEntry(35),
  turnId: "worker-turn-1",
  item: { ...shellEntry(35).item, callId: "opaque-call" },
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate() && performance.now() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(predicate(), "the scoped recovery wake did not settle");
}

test("first worker launch arms an exact T3 turn-end read and the late-callback deadline", async (t) => {
  const graceMs = 500;
  const f = await fixture(t, graceMs);
  t.after(() => f.store.close());
  const server = await t3Fake(t, f.root);
  const agentId = "thread:worker";
  const thread = threadProjection(agentId, f.directory);
  thread.runs = [
    syntheticRun(agentId, 1, {
      status: "running",
      startedAt: minutesAgo(1),
      completedAt: null,
    }),
  ];
  server.threads.set(agentId, thread);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(f.root, "recovery-host.json"),
    probeThreadId: agentId,
  });
  t.after(() => host.close());
  await host.connect();
  const state = await host.observe(agentId);
  const observationReads: string[] = [];
  Object.assign(f.adapter, {
    createAgent: async () => ({ id: agentId, workspaceId: state.workspaceId }),
    observe: async (id: string) => {
      observationReads.push(id);
      return host.observe(id);
    },
  });
  const dispatching = f.store.update(f.task.id, {
    phase: "dispatching",
    agentId: null,
    runId: null,
    agentIntent: false,
    workspaceId: state.workspaceId,
  });
  const unrelated = f.store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Unrelated task",
      repoPath: f.repo,
      planningCommit: f.base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    f.task.hostId!,
    "handoff",
    f.base,
  );
  f.store.update(unrelated.id, {
    phase: "working",
    agentId: "unrelated-worker",
    workspaceId: "other",
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  await f.engine.launchAgent(dispatching);
  const launched = f.store.task(f.task.id);
  assert.equal(launched.phase, "working");
  assert.equal(launched.agentId, agentId);
  assert.equal(launched.idleSince, null);

  const endedAt = new Date().toISOString();
  thread.runs[0].status = "completed";
  thread.runs[0].completedAt = endedAt;
  thread.updatedAt = endedAt;
  thread.thread.updatedAt = endedAt;
  t.mock.timers.tick(25_000);
  await until(() => Boolean(f.store.task(f.task.id).idleSince));
  const confirmedAt = Date.parse(f.store.task(f.task.id).idleSince!);
  const sent = () =>
    f.store
      .eventsAll(f.task.id)
      .find((event) =>
        ["worker_push_continuation", "callback_reminder"].includes(event.kind),
      );
  await f.engine.quiesce();
  assert.equal(sent(), undefined);
  t.mock.timers.tick(graceMs);
  await until(() => Boolean(sent()));

  assert.ok(Date.parse(sent()!.at) >= confirmedAt + graceMs);
  assert.ok(
    f.store.eventsAll(f.task.id).some(
      (event) =>
        event.kind === "recovery_evidence" &&
        event.detail ===
          JSON.stringify({
            source: "host_turn_end",
            runId: launched.runId,
            at: new Date(confirmedAt).toISOString(),
          }),
    ),
  );
  assert.ok(!observationReads.includes("unrelated-worker"));
});

test("an authenticated worker callback wakes its own task between sweeps", async (t) => {
  const f = await fixture(t, 60_000);
  t.after(() => f.store.close());
  f.setObservation(
    running({ status: "idle", active: false, activeTurnId: null }),
  );
  f.store.setCredential("initial", "synthetic-callback-token");
  const input = {
    taskId: f.task.id,
    runId: "initial",
    eventId: randomUUID(),
    status: "blocked" as const,
    summary: "A required test fixture has no input",
    impediment: "The synthetic input is missing.",
  };
  await assert.rejects(f.engine.complete(input, "invalid-token"));
  assert.equal(f.store.task(f.task.id).completion, null);
  assert.equal(
    (await f.engine.complete(input, "synthetic-callback-token")).accepted,
    true,
  );
  await f.engine.quiesce();
  assert.equal(f.store.task(f.task.id).completion?.eventId, input.eventId);
  const { pending, samples } = phaseLatency(f.store, f.task.id);
  assert.ok(
    [...pending, ...samples].some(
      (sample) =>
        sample.key === `callback:${input.eventId}` &&
        sample.cause.startsWith("Authenticated callback"),
    ),
  );
});

test("an opaque running tool past the stall deadline goes to coordinator attention", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  f.setTimelines([[opaqueTool()], [opaqueTool()]]);
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.equal(
    current.phase,
    "needs_attention",
    "the stalled pre-PR worker enters coordinator recovery",
  );
  assert.equal(current.resolution.attention, true);
  assert.equal(current.resolution.incident?.cause, "stalled_turn");
  assert.equal(current.resolution.incident?.action, "");
  assert.match(current.reason, /looks stalled/);
  assert.equal(current.resolution.incident?.status, "reconciling");
  assert.equal(current.resolution.incident?.turnId, "worker-turn-1");
  // Spec 068 §3 (nucleus#1552): the stalled participant is the subject of the
  // stop, not an idleness barrier. The coordinator is admitted while Paseo
  // still displays that worker as running.
  assert.equal(
    current.resolution.recovery?.status,
    "running",
    "the coordinator is admitted without the live worker's idle lease",
  );
  assert.equal(
    f.store.run(current.resolution.recovery!.runId!)?.role,
    "recovery",
  );
  // Repeated observations retain the same incident and do not retry the worker.
  const incidentId = current.resolution.incident?.id;
  f.setObservation(
    running({ updatedAt: minutesAgo(36), turnStartedAt: minutesAgo(37) }),
  );
  await f.engine.wake();
  assert.equal(f.store.task(f.task.id).resolution.incident?.id, incidentId);
  assert.equal(f.store.task(f.task.id).resolution.attention, true);
  assert.equal(
    f.store.task(f.task.id).resolution.recovery?.runId,
    current.resolution.recovery?.runId,
    "the same episode keeps its one coordinator run",
  );
  // A resumed worker ends the episode instead of needing an owner verb.
  f.setObservation(running());
  await f.engine.resolution.recovery.pass(f.task.id);
  const resumed = f.store.task(f.task.id);
  assert.equal(
    resumed.resolution.incident?.id,
    incidentId,
    "the coordinator run still owns the one episode",
  );
});

test("a real run-owned child in the task workspace prevents a stale turn from stalling", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  await writeFile(
    join(f.root, "mcp-report.mjs"),
    "setInterval(() => {}, 1000);\n",
  );
  await writeFile(
    join(f.root, "provider.mjs"),
    `import { spawn } from 'node:child_process';
const helper = spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: process.cwd() });
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd() });
process.on('SIGTERM', () => { helper.kill(); child.kill(); process.exit(); });
console.log(JSON.stringify([process.pid, helper.pid, child.pid])); setInterval(() => {}, 1000);`,
  );
  const provider = spawn(
    process.execPath,
    [
      join(f.root, "provider.mjs"),
      join(f.root, "mcp-report.mjs"),
      join(f.root, "mcp-initial.json"),
    ],
    { cwd: f.directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (provider.exitCode === null) {
      provider.kill();
      await once(provider, "exit");
    }
  });
  const [ready] = await once(provider.stdout!, "data");
  const fixturePids = JSON.parse(String(ready)) as number[];
  f.adapter.hostProcessListing = async () => {
    const listing = await readProcessSubset(fixturePids);
    return listing.state === "listed" ? listing.processes : null;
  };
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.equal(current.resolution.incident, null);
  assert.equal(current.resolution.recovery, null);
  assert.equal(current.resolution.stop?.reason === "run_stalled", false);
  assert.equal(
    f.store
      .events(f.task.id)
      .some((event) => event.kind === "planner_escalation"),
    false,
  );
});

test("fresh tool output renews a long test run with a stale host turn stamp", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  const entry: TimelineEntry = {
    timestamp: minutesAgo(35),
    turnId: "worker-turn-1",
    item: {
      type: "tool_call",
      callId: "call-1",
      status: "running",
      name: "Bash",
      detail: {
        type: "shell",
        command: "effigy test unit",
        startedAt: minutesAgo(35),
        lastOutputAt: minutesAgo(2),
      },
    },
  };
  f.setTimelines([[entry], [entry]]);
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.equal(current.resolution.incident, null);
  assert.equal(current.resolution.recovery, null);
  assert.equal(current.resolution.stop?.reason === "run_stalled", false);
  assert.equal(current.lastActivityAt, entry.item.detail?.lastOutputAt);
});

test("a live queued or running validation process does not mask a stale worker turn", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const submittedAt = new Date().toISOString();
  f.hostRuns.adoptRunning({
    id: "stall-blocker",
    epoch: 1,
    caller: "queue:test:blocker",
    repository: { origin: null, path: f.repo },
    selector: "qa",
    runClass: "heavy",
    classSource: "default",
    priority: "milestone",
    runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1000 },
    launchedAt: submittedAt,
    pid: process.pid,
    submittedAt,
  });
  const queued = f.hostRuns.submit(
    {
      id: "worktree-client-run",
      epoch: 1,
      submissionSource: "client",
      caller: "effigy:worker",
      repository: { origin: null, path: f.directory },
      selector: "qa",
      runClass: "heavy",
      classSource: "default",
      priority: "interactive",
      runTimeoutMs: 60_000,
      budgetFallback: { cpu: 1, memoryBytes: 1000 },
      submittedAt,
    },
    {
      launch: (run) => {
        f.hostRuns.markLaunched(run.id);
      },
    },
  );
  assert.equal(queued.state, "queued");
  f.setTimelines([[opaqueTool()], [opaqueTool()]]);
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  await f.engine.wake();
  assert.equal(
    f.store.task(f.task.id).phase,
    "needs_attention",
    "a queued validation cannot keep a silent active turn healthy",
  );
  assert.equal(
    f.hostRuns.liveClientRunAt(f.repo),
    null,
    "a Queue-owned run is not client liveness evidence",
  );
  f.hostRuns.settle(
    "stall-blocker",
    hostRunSettlementSchema.parse({
      format: "host.run.settlement",
      version: 1,
      runId: "stall-blocker",
      outcome: "lost",
      launched: true,
      settledAt: new Date().toISOString(),
      result: null,
      containers: [],
    }),
  );
  assert.equal(f.hostRuns.get(queued.id)?.state, "running");
  f.setTimelines([[opaqueTool()], [opaqueTool()]]);
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.equal(current.resolution.attention, true);
  assert.equal(current.resolution.incident?.cause, "stalled_turn");
});

/**
 * A persisted pending stall episode, as an earlier pass leaves it when no
 * coordinator has started: the recorded stop, its stalled-turn incident and the
 * pending episode bound to it. Spec 068 §3 (nucleus#1552) admits the coordinator
 * directly for a live run_stalled stop, so the pending-escalation rules below
 * are exercised on this stored shape.
 */
function storePendingStallEpisode(
  f: Fixture,
  participant: {
    role: "worker" | "reviewer";
    runId: string;
    agentId: string;
    turnId: string;
    phase: Task["phase"];
  } = {
    role: "worker",
    runId: f.store.task(f.task.id).runId!,
    agentId: "worker",
    turnId: "worker-turn-1",
    phase: "needs_attention",
  },
  since = minutesAgo(35),
): void {
  const current = f.store.task(f.task.id);
  const incidentId = "stall-incident";
  f.store.update(
    f.task.id,
    {
      phase: participant.phase,
      reason:
        "The run looks stalled: no agent activity while Paseo still reports it running",
      resolution: {
        ...current.resolution,
        attention: true,
        stop: {
          reason: "run_stalled",
          detail:
            "The run looks stalled: no agent activity while Paseo still reports it running",
          since,
          suggestedVerbs: ["restart"],
        },
        incident: {
          id: incidentId,
          role: participant.role,
          runId: participant.runId,
          turnId: participant.turnId,
          fingerprint: "",
          attempt: 0,
          cause: "stalled_turn",
          detail: "",
          action: "",
          status: "reconciling",
          createdAt: since,
          updatedAt: since,
        },
        recovery: {
          id: "stall-episode",
          key: "stalled-episode",
          generation: current.coordinatorGeneration,
          runId: null,
          agentId: null,
          status: "pending",
          summary: "",
          idleSince: null,
          incidentId,
          progress: null,
        },
      },
    },
    "recovery_pending",
    "stalled turn recorded a pending recovery episode",
  );
}

test("a stall escalation closes when the original run resumes before recovery acts", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  storePendingStallEpisode(f);
  // Still stalled while the bound runs out, so the episode escalates.
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  (
    f.engine.resolution.recovery as unknown as { pendingBoundMs: number }
  ).pendingBoundMs = 0;
  await f.engine.resolution.recovery.pass(f.task.id);
  assert.equal(
    f.store.task(f.task.id).resolution.recovery?.status,
    "escalated",
  );
  f.setObservation(running());
  await f.engine.resolution.recovery.pass(f.task.id);
  const current = f.store.task(f.task.id);
  assert.equal(current.resolution.recovery?.status, "resolved");
  assert.equal(current.resolution.incident?.status, "resolved");
  assert.equal(current.resolution.attention, false);
  assert.ok(
    f.store
      .events(f.task.id)
      .some((event) => event.kind === "planner_escalation_resolved"),
  );
  const version = current.version;
  await f.engine.resolution.recovery.pass(f.task.id);
  await f.engine.resolution.recovery.pass(f.task.id);
  assert.equal(f.store.task(f.task.id).version, version);
  assert.equal(
    f.store.events(f.task.id).filter((event) => event.kind === "stall_ended")
      .length,
    1,
  );
});

test("a pending stall that ends is settled only once before escalation", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  storePendingStallEpisode(f);
  assert.equal(f.store.task(f.task.id).resolution.recovery?.status, "pending");
  f.setObservation(running());
  await f.engine.resolution.recovery.pass(f.task.id);
  const settled = f.store.task(f.task.id);
  assert.equal(settled.resolution.recovery?.status, "resolved");
  await f.engine.resolution.recovery.pass(f.task.id);
  await f.engine.resolution.recovery.pass(f.task.id);
  assert.equal(f.store.task(f.task.id).version, settled.version);
  assert.equal(
    f.store.events(f.task.id).filter((event) => event.kind === "stall_ended")
      .length,
    1,
  );
});

test("two runs in one store retain their own activity stamps during the same observation", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const firstStamp = minutesAgo(2),
    secondStamp = minutesAgo(3);
  for (const [id, agentId, stamp] of [
    ["revision-one", "agent-one", firstStamp],
    ["revision-two", "agent-two", secondStamp],
  ]) {
    f.store.putRun({
      id,
      taskId: f.task.id,
      role: "revision",
      generation: 1,
      head: f.head,
      base: f.base,
      agentId,
      workspaceId: "task-ws",
      profile: profile("worker"),
      status: "running",
      createdAt: minutesAgo(30),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.setAgentObservation(
      agentId,
      running({ id: agentId, updatedAt: stamp, turnStartedAt: minutesAgo(4) }),
    );
  }
  f.store.update(f.task.id, {
    phase: "changes_requested",
    resolution: {
      ...f.store.task(f.task.id).resolution,
      currentRunId: "revision-two",
    },
  });
  await f.engine.resolution.observe();
  assert.equal(f.store.run("revision-one")?.lastActivityAt, firstStamp);
  assert.equal(f.store.run("revision-two")?.lastActivityAt, secondStamp);
  assert.notEqual(
    f.store.run("revision-one")?.lastActivityAt,
    f.store.run("revision-two")?.lastActivityAt,
  );
});

test("an agent with fresh activity is never flagged", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  f.setObservation(
    running({ updatedAt: minutesAgo(2), turnStartedAt: minutesAgo(30) }),
  );
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.equal(current.resolution.incident, null);
  assert.equal(current.resolution.attention, false);
  assert.equal(current.phase, "working");
});

test("a shell command running over 15 minutes shows a notice on the task", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  f.setObservation(
    running({ updatedAt: minutesAgo(1), turnStartedAt: minutesAgo(20) }),
  );
  f.setTimelines([[shellEntry(16)]]);
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.match(
    current.reason,
    /shell command that has run for over 15 minutes/,
  );
  assert.match(current.reason, /effigy qa/);
  assert.equal(
    current.resolution.attention,
    false,
    "a fresh turn with a long shell command is not a stall",
  );
  // The worker path composes its reason every pass and self-heals, so it writes no ledger entry.
  assert.ok(
    !f.store
      .events(f.task.id)
      .some((event) => event.kind === "shell_notice_shown"),
  );
  // When the command ends, the composed reason goes back to healthy work.
  f.setTimelines([[shellEntry(1)]]);
  f.engine.resolution.stalls.peekTtlMs = 0;
  await f.engine.wake();
  assert.equal(f.store.task(f.task.id).reason, "Worker running");
});

test("a fresh permission wait is not a stall", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  f.setObservation(
    running({
      updatedAt: minutesAgo(2),
      turnStartedAt: minutesAgo(3),
      permissions: true,
      pendingRequest: { id: "perm-1", kind: "shell", firstLine: "git push" },
    }),
  );
  await f.engine.wake();
  assert.equal(f.store.task(f.task.id).resolution.incident, null);
  assert.equal(f.store.task(f.task.id).resolution.attention, false);
  assert.match(f.store.task(f.task.id).reason, /permission response/);
});

test("a pending permission is activity even if the provider stamp is old", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  f.setObservation(
    running({
      active: false,
      permissions: true,
      updatedAt: minutesAgo(35),
      turnStartedAt: minutesAgo(36),
      pendingRequest: { id: "perm-1", kind: "shell", firstLine: "git push" },
    }),
  );
  f.setTimelines([[opaqueTool()], [opaqueTool()]]);
  await f.engine.wake();
  const current = f.store.task(f.task.id);
  assert.equal(current.phase, "working");
  assert.equal(current.resolution.attention, false);
  assert.equal(
    current.lastActivityAt,
    current.participantActivity?.permission?.since,
  );
});

test("a missing activity stamp is never judged stale", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const { updatedAt, turnStartedAt, ...withoutStamp } = running({
    updatedAt: minutesAgo(35),
    turnStartedAt: minutesAgo(36),
  });
  f.setObservation(withoutStamp);
  await f.engine.wake();
  assert.equal(f.store.task(f.task.id).resolution.incident, null);
  assert.equal(f.store.task(f.task.id).resolution.attention, false);
});

test("the stall threshold is a setting and the default is 30 minutes", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  // Twenty-five minutes of quiet: below the 30-minute default, past a one-minute setting.
  f.setObservation(
    running({ updatedAt: minutesAgo(25), turnStartedAt: minutesAgo(26) }),
  );
  await f.engine.wake();
  assert.equal(
    f.store.task(f.task.id).resolution.attention,
    false,
    "the default threshold stays at 30 minutes",
  );
  f.store.setMeta("stallThresholdMinutes", 1);
  f.setTimelines([[opaqueTool()], [opaqueTool()]]);
  f.setObservation(
    running({ updatedAt: minutesAgo(25), turnStartedAt: minutesAgo(26) }),
  );
  await f.engine.wake();
  assert.equal(
    f.store.task(f.task.id).resolution.attention,
    true,
    "the operator setting moves the stall window",
  );
  assert.equal(f.store.getMeta<number>("stallThresholdMinutes"), 1);
});

test("a stalled revision run enters coordinator attention through the run observer", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const runId = "revision-1";
  f.store.update(f.task.id, {
    phase: "changes_requested",
    completion: null,
    prHead: null,
    prUrl: null,
    resolution: { ...f.store.task(f.task.id).resolution, currentRunId: runId },
  });
  f.store.putRun({
    id: runId,
    taskId: f.task.id,
    role: "revision",
    generation: 1,
    head: f.head,
    base: f.base,
    agentId: "revision-worker",
    workspaceId: "task-ws",
    profile: profile("worker"),
    status: "running",
    createdAt: minutesAgo(30),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.setObservation(
    running({
      id: "revision-worker",
      workspaceId: "task-ws",
      updatedAt: minutesAgo(35),
      turnStartedAt: minutesAgo(40),
    }),
  );
  f.setTimelines([[opaqueTool()], [opaqueTool()]]);
  await f.engine.resolution.observe();
  const current = f.store.task(f.task.id);
  assert.equal(
    current.resolution.incident?.role,
    "worker",
    "revision work is worker work",
  );
  assert.equal(
    current.resolution.incident?.runId,
    runId,
    "the stall incident deduplicates per run",
  );
  assert.equal(
    current.resolution.attention,
    true,
    "the stalled revision is routed to coordinator recovery",
  );
});

test("a revision stall escalation closes when that revision resumes", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const runId = "revision-1";
  f.store.update(f.task.id, {
    phase: "changes_requested",
    completion: null,
    prHead: null,
    prUrl: null,
    resolution: { ...f.store.task(f.task.id).resolution, currentRunId: runId },
  });
  f.store.putRun({
    id: runId,
    taskId: f.task.id,
    role: "revision",
    generation: 1,
    head: f.head,
    base: f.base,
    agentId: "revision-worker",
    workspaceId: "task-ws",
    profile: profile("worker"),
    status: "running",
    createdAt: minutesAgo(40),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.setAgentObservation(
    "revision-worker",
    running({
      id: "revision-worker",
      updatedAt: minutesAgo(35),
      turnStartedAt: minutesAgo(40),
    }),
  );
  // A revision's stalled turn is worker work with the revision's own run identity.
  storePendingStallEpisode(f, {
    role: "worker",
    runId,
    agentId: "revision-worker",
    turnId: "revision-turn-1",
    phase: "changes_requested",
  });
  (
    f.engine.resolution.recovery as unknown as { pendingBoundMs: number }
  ).pendingBoundMs = 0;
  await f.engine.resolution.recovery.pass(f.task.id);
  assert.equal(
    f.store.task(f.task.id).resolution.recovery?.status,
    "escalated",
  );
  f.setAgentObservation("revision-worker", running({ id: "revision-worker" }));
  await f.engine.resolution.recovery.pass(f.task.id);
  const current = f.store.task(f.task.id);
  assert.equal(current.phase, "changes_requested");
  assert.equal(current.resolution.currentRunId, runId);
  assert.equal(current.resolution.attention, false);
  assert.equal(current.resolution.incident?.status, "resolved");
  assert.equal(current.resolution.recovery?.status, "resolved");
  assert.ok(
    f.store
      .events(f.task.id)
      .some((event) => event.kind === "planner_escalation_resolved"),
  );
});

const revisionRunFixture = async (f: Fixture, runId: string) => {
  f.store.update(f.task.id, {
    phase: "changes_requested",
    completion: null,
    prHead: null,
    prUrl: null,
    reason: "Revision requested: fix the flake",
    resolution: { ...f.store.task(f.task.id).resolution, currentRunId: runId },
  });
  f.store.putRun({
    id: runId,
    taskId: f.task.id,
    role: "revision",
    generation: 1,
    head: f.head,
    base: f.base,
    agentId: "revision-worker",
    workspaceId: "task-ws",
    profile: profile("worker"),
    status: "running",
    createdAt: minutesAgo(30),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.setObservation(
    running({
      id: "revision-worker",
      workspaceId: "task-ws",
      updatedAt: minutesAgo(1),
      turnStartedAt: minutesAgo(20),
    }),
  );
};

test("a closeout coordinator mid-turn is never stall-checked", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const runId = "verify-1";
  f.store.update(f.task.id, {
    phase: "verifying",
    completion: null,
    prHead: null,
    prUrl: null,
    reason: "Closeout pending",
    resolution: { ...f.store.task(f.task.id).resolution, currentRunId: runId },
  });
  f.store.putRun({
    id: runId,
    taskId: f.task.id,
    role: "closeout",
    generation: 1,
    head: f.head,
    base: f.base,
    agentId: "verify-agent",
    workspaceId: "task-ws",
    profile: profile("coordinator"),
    status: "running",
    createdAt: minutesAgo(30),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.setObservation(
    running({
      id: "verify-agent",
      workspaceId: "task-ws",
      updatedAt: minutesAgo(40),
      turnStartedAt: minutesAgo(41),
    }),
  );
  await f.engine.resolution.observe();
  const current = f.store.task(f.task.id);
  assert.equal(
    current.resolution.incident,
    null,
    "no stall incident outside brief scope",
  );
  assert.ok(
    !f.store
      .events(f.task.id)
      .some((event) => event.kind === "stall_continuation"),
  );
  assert.equal(current.reason, "Closeout pending");
});

test("a shell notice on a resolution run clears and restores the previous reason when the command ends", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  await revisionRunFixture(f, "revision-shell");
  const observe = () => f.engine.resolution.observe();
  const runningCommand = shellEntry(16);
  f.setTimelines([[runningCommand]]);
  await observe();
  const notice = f.store.task(f.task.id).reason;
  assert.match(notice, /shell command that has run for over 15 minutes/);
  assert.ok(
    notice.includes(`(started at ${runningCommand.timestamp}):`),
    "the durable notice retains the command start time for the board summary",
  );
  const shown = f.store
    .events(f.task.id)
    .find((event) => event.kind === "shell_notice_shown");
  assert.ok(shown, "the shown notice and its replaced reason are durable");
  assert.deepEqual(JSON.parse(shown.detail), {
    runId: "revision-shell",
    notice,
    previous: "Revision requested: fix the flake",
  });
  // The command ends; the next peek shows no running shell and the reason it
  // replaced comes back.
  f.setTimelines([[]]);
  f.engine.resolution.stalls.peekTtlMs = 0;
  await observe();
  assert.equal(
    f.store.task(f.task.id).reason,
    "Revision requested: fix the flake",
  );
  assert.ok(
    f.store
      .events(f.task.id)
      .some(
        (event) =>
          event.kind === "shell_notice_cleared" && event.detail === notice,
      ),
  );
  // A second long command writes a new notice whose clear still restores the
  // original reason, and a reason another fault wrote in between is never clobbered.
  f.setTimelines([[shellEntry(17, "npm test")]]);
  await observe();
  assert.match(f.store.task(f.task.id).reason, /npm test/);
  f.store.update(f.task.id, { reason: "Another fault owns the reason now" });
  f.setTimelines([[]]);
  await observe();
  assert.equal(
    f.store.task(f.task.id).reason,
    "Another fault owns the reason now",
    "clearing never overwrites a foreign reason",
  );
});

test("a persisted shell notice clears after a service restart, from the durable ledger", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  await revisionRunFixture(f, "revision-restart");
  f.setTimelines([[shellEntry(16)]]);
  await f.engine.resolution.observe();
  assert.match(
    f.store.task(f.task.id).reason,
    /shell command that has run for over 15 minutes/,
  );
  // The command ends while Queue is down; a fresh engine on the same store has
  // no process state and must still clear the persisted notice.
  await f.engine.stop();
  const restarted = new Engine(f.store, f.adapter, 0);
  f.setTimelines([[]]);
  await restarted.resolution.observe();
  assert.equal(
    f.store.task(f.task.id).reason,
    "Revision requested: fix the flake",
    "the restart clears the persisted notice from the ledger",
  );
  assert.ok(
    f.store
      .events(f.task.id)
      .some((event) => event.kind === "shell_notice_cleared"),
  );
  await restarted.stop();
});

test("a crash between the ledger write and the reason write commits neither", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  await revisionRunFixture(f, "revision-crash");
  const stalls = f.engine.resolution.stalls;
  const task = f.store.task(f.task.id);
  // Simulate the crash window: the reason write fails after the ledger insert.
  const resolution = f.engine.resolution as unknown as {
    waiting: (t: Task, reason: string) => void;
  };
  const failing = () => {
    throw new Error("crashed between ledger and reason");
  };
  const original = resolution.waiting;
  resolution.waiting = failing;
  try {
    assert.throws(
      () =>
        stalls.settleNotice(
          task,
          "Worker is executing a shell command that has run for over 15 minutes: npm test",
        ),
      /crashed between ledger and reason/,
    );
  } finally {
    resolution.waiting = original;
  }
  // Both writes rolled back: no shown marker over a reason that was never updated.
  assert.equal(
    f.store.task(f.task.id).reason,
    "Revision requested: fix the flake",
  );
  assert.ok(
    !f.store
      .events(f.task.id)
      .some(
        (event) =>
          event.kind === "shell_notice_shown" ||
          event.kind === "shell_notice_cleared",
      ),
  );
  // A later settle shows the notice normally.
  stalls.settleNotice(
    f.store.task(f.task.id),
    "Worker is executing a shell command that has run for over 15 minutes: npm test",
  );
  assert.match(
    f.store.task(f.task.id).reason,
    /shell command that has run for over 15 minutes/,
  );
  assert.ok(
    f.store
      .events(f.task.id)
      .some((event) => event.kind === "shell_notice_shown"),
  );
});

test("the timeline peek reads the oldest running shell command on the page", async () => {
  // One clock read per timestamp: the expectation reuses the fixture entry's
  // own stamp, so a millisecond boundary crossed between two minutesAgo calls
  // can never make the two disagree.
  const npmTest = shellEntry(17, "npm test");
  const entries: TimelineEntry[] = [
    {
      timestamp: minutesAgo(20),
      item: { type: "assistant_message", text: "running checks" },
    },
    {
      timestamp: minutesAgo(18),
      item: {
        type: "tool_call",
        status: "completed",
        name: "Bash",
        detail: { type: "shell", command: "ls" },
      },
    },
    npmTest,
    shellEntry(16, "effigy qa"),
    {
      timestamp: minutesAgo(10),
      item: {
        type: "tool_call",
        status: "running",
        name: "Read",
        detail: { type: "read", filePath: "a.ts" },
      },
    },
  ];
  assert.deepEqual(runningShellCommand(entries), {
    startedAt: npmTest.timestamp,
    command: "npm test",
  });
  assert.equal(runningShellCommand(null), null);
  assert.equal(
    runningShellCommand([
      {
        timestamp: minutesAgo(1),
        item: {
          type: "tool_call",
          status: "running",
          name: "Bash",
          detail: { type: "read", filePath: "a.ts" },
        },
      },
    ]),
    null,
  );
});

test("owned-tool retrieval covers projected histories and latest turns longer than a tail", async () => {
  for (const ids of ["absent", "one-turn", "boundary"] as const) {
    const history = longToolHistory();
    if (ids !== "absent")
      history.forEach((entry, i) => {
        entry.turnId = ids === "boundary" && i < 100 ? "earlier" : "latest";
      });
    // One tool's running identity is outside the first tail; completion is inside it.
    history[100].item = {
      type: "tool_call",
      callId: "call",
      name: "exec",
      status: "running",
    };
    history[300].item = {
      type: "tool_call",
      callId: "call",
      name: "exec",
      status: "completed",
    };
    const limits: number[] = [];
    const result = await readToolTimeline(
      {
        agentTimelinePage: async (_id, limit = 0) => {
          limits.push(limit);
          return toolTimelineTail(history, limit);
        },
      },
      "worker",
    );
    assert.ok("entries" in result, JSON.stringify(result));
    assert.deepEqual(
      result.entries,
      ids === "boundary" ? history.slice(-400) : history,
    );
    assert.deepEqual(limits, ids === "boundary" ? [200, 400] : [200, 400, 800]);
    assert.equal(liveToolIssue(result.entries), null);
    assert.ok(
      result.entries.includes(history[100]),
      "earlier running identity remains in the proof",
    );
  }
});

test("expanded tool evidence retains live, unknown and conflicting earlier identities", async () => {
  for (const status of [
    "running",
    "unknown",
    undefined,
    "conflicting",
  ] as const) {
    const history = longToolHistory();
    history[100].item = {
      type: "tool_call",
      callId: "older",
      name: "exec",
      status: status === "conflicting" ? "running" : status,
    };
    history[300].item = {
      type: "tool_call",
      callId: status === "conflicting" ? "older" : "different",
      name: "read",
      status: "completed",
    };
    const result = await readToolTimeline(
      {
        agentTimelinePage: async (_id, limit = 0) =>
          toolTimelineTail(history, limit),
      },
      "worker",
    );
    assert.ok("entries" in result);
    assert.match(
      liveToolIssue(result.entries)!,
      status === "conflicting"
        ? /conflicting/
        : /running|unknown|without a terminal/,
    );
  }
});

test("owned-tool tails refuse missing or unsafe coverage facts", async () => {
  const base = toolTimelineTail(longToolHistory(), 200);
  const cases: Array<[Partial<TimelinePage>, RegExp]> = [
    [{ gap: true }, /gap/],
    [{ staleCursor: true }, /stale/],
    [{ reset: true }, /reset/],
    [{ hasNewer: true }, /newer/],
    ...(
      [
        "hasOlder",
        "gap",
        "staleCursor",
        "reset",
        "hasNewer",
        "epoch",
        "projection",
      ] as const
    ).map(
      (key) =>
        [{ [key]: undefined }, /metadata/] as [Partial<TimelinePage>, RegExp],
    ),
    [{ startCursor: null }, /cursors/],
    [{ endCursor: undefined }, /cursors/],
    [{ startCursor: { epoch: "other", seq: 1 } }, /cursors/],
    [{ endCursor: { epoch: "history", seq: 0 } }, /cursors/],
    [{ entries: [] }, /empty/],
  ];
  for (const [patch, issue] of cases) {
    const result = await readToolTimeline(
      { agentTimelinePage: async () => ({ ...base, ...patch }) },
      "worker",
    );
    assert.equal(result.kind, "hold", JSON.stringify(patch));
    if (result.kind === "hold") assert.match(result.reason, issue);
  }
  const empty = await readToolTimeline(
    { agentTimelinePage: async () => toolTimelinePage([]) },
    "worker",
  );
  assert.deepEqual(empty, { kind: "ok", entries: [] });
});

test("owned-tool expansion refuses changed, duplicated, skipped or unadvanced segments", async () => {
  for (const kind of [
    "epoch",
    "projection",
    "newest",
    "oldest",
    "same-page",
    "changed",
    "mutated",
    "missing",
    "duplicate",
    "reset",
    "gap",
    "stale",
    "newer",
  ] as const) {
    const history = longToolHistory();
    let reads = 0;
    const result = await readToolTimeline(
      {
        agentTimelinePage: async (_id, limit = 0) => {
          const page = toolTimelineTail(history, limit);
          if (++reads === 1) return page;
          if (kind === "epoch") {
            page.epoch = "new";
            page.startCursor!.epoch = page.endCursor!.epoch = "new";
          }
          if (kind === "projection") page.projection = "canonical";
          if (kind === "newest") page.endCursor!.seq++;
          if (kind === "oldest") page.startCursor!.seq = 251;
          if (kind === "same-page") return toolTimelineTail(history, 200);
          if (kind === "changed")
            page.entries[250] = {
              ...page.entries[250],
              item: { type: "tool_call", callId: "changed", status: "running" },
            };
          if (kind === "mutated") page.entries[250].item.status = "running";
          if (kind === "missing") page.entries.splice(250, 1);
          if (kind === "duplicate") page.entries[250] = page.entries[251];
          if (kind === "reset") page.reset = true;
          if (kind === "gap") page.gap = true;
          if (kind === "stale") page.staleCursor = true;
          if (kind === "newer") page.hasNewer = true;
          return page;
        },
      },
      "worker",
    );
    assert.equal(result.kind, "hold", kind);
    assert.equal(reads, 2, kind);
  }
});

test("owned-tool retrieval has a finite budget and fails closed on read failures", async () => {
  const history = longToolHistory(13_000);
  let reads = 0;
  const exhausted = await readToolTimeline(
    {
      agentTimelinePage: async (_id, limit = 0) => {
        reads++;
        return toolTimelineTail(history, limit);
      },
    },
    "worker",
  );
  assert.equal(exhausted.kind, "hold");
  if (exhausted.kind === "hold")
    assert.match(exhausted.reason, /partial after 6 reads/);
  assert.equal(reads, TOOL_TIMELINE_READ_BUDGET);
  for (const failure of ["throw", "null"] as const) {
    reads = 0;
    const result = await readToolTimeline(
      {
        agentTimelinePage: async (_id, limit = 0) => {
          if (++reads === 1) return toolTimelineTail(history, limit);
          if (failure === "throw") throw Error("transport failed");
          return null;
        },
      },
      "worker",
    );
    assert.equal(result.kind, "hold");
    if (result.kind === "hold")
      assert.match(result.reason, /read 2.*failed|read 2.*unavailable/);
    assert.equal(reads, 2);
  }
});

test("owned-tool reads time out without accepting a late response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (page: TimelinePage) => void;
  const pending = readToolTimeline(
    {
      agentTimelinePage: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    "worker",
  );
  t.mock.timers.tick(TOOL_TIMELINE_READ_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.kind, "deferred");
  if (result.kind === "deferred")
    assert.match(result.reason, /read 1 failed: read timed out/);
  finish(toolTimelinePage([]));
  assert.equal(
    result.kind,
    "deferred",
    "a late empty response cannot turn the refusal into proof",
  );
});

// #1148 acceptance 2: during a T3 observation outage, stall detection never starts
// recovery, even though the thread's own projection shows recent activity. The
// outage throws before any stall judgement; it is deferred, not read as an idle or
// stalled worker, and the next successful read with fresh activity stays healthy.
test("an observation outage on a thread with recent projection activity never starts stall recovery", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  // The projection's own stamp is fresh, so a successful read would not be stale.
  f.setObservation(
    running({ updatedAt: minutesAgo(1), turnStartedAt: minutesAgo(2) }),
  );
  const outage = new Error("T3Code transport: orchestration.subscribeThread");
  f.adapter.observe = async () => {
    throw outage;
  };
  await f.engine.wake();
  await f.engine.wake();
  const during = f.store.task(f.task.id);
  assert.equal(
    during.phase,
    "working",
    "an outage keeps the worker in its phase",
  );
  assert.equal(during.resolution.attention, false);
  assert.equal(
    during.resolution.incident ?? null,
    null,
    "no stalled-turn incident is opened",
  );
  assert.equal(f.stopRequests.length, 0, "the live turn is never interrupted");
  assert.deepEqual(f.createdRuns, [], "no recovery run is launched");
  assert.doesNotMatch(during.reason, /looks stalled/);
  // The outage clears: the same thread, with recent activity, stays healthy.
  f.adapter.observe = async (id: string) => ({
    ...running({ updatedAt: minutesAgo(1), turnStartedAt: minutesAgo(2) }),
    id,
  });
  await f.engine.wake();
  const after = f.store.task(f.task.id);
  assert.equal(after.phase, "working");
  assert.equal(after.resolution.incident ?? null, null);
  assert.equal(f.stopRequests.length, 0);
  assert.deepEqual(f.createdRuns, []);
});

test("a host without thread removal keeps today's coordinator binding rule: a closed coordinator waits, it is never replaced (#1155 review)", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  // A retained coordinator from an earlier attempt, archived on the host.
  f.store.update(f.task.id, { coordinatorAgentId: "agent-coord" });
  f.setAgentObservation("agent-coord", {
    ...running({}),
    workspaceId: `ws-${f.task.id}`,
    status: "closed",
    active: false,
  });
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  await f.engine.wake();
  await f.engine.resolution.recovery.route(f.store.task(f.task.id));
  assert.equal(
    f.store.task(f.task.id).resolution.recovery?.runId ?? null,
    null,
    "Paseo still waits for an assigned coordinator that is not idle",
  );
  assert.equal(
    f.createdRuns.includes("recovery"),
    false,
    "no fresh coordinator is launched on a host without removal",
  );
});

test("a host without thread removal never displaces a retained coordinator for a recorded route (#1155 review)", async (t) => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  // An idle retained coordinator and a recorded route naming that same profile:
  // the host cannot remove threads, so the binding is kept as it is today.
  f.store.update(f.task.id, {
    coordinatorAgentId: "agent-coord",
    profileRequests: {
      ...f.store.task(f.task.id).profileRequests,
      coordinator: {
        profileId: "coordinator",
        reason: "Route the coordinator",
        required: true,
        ownerRoute: true,
      },
    },
  });
  f.setAgentObservation("agent-coord", {
    ...running({}),
    workspaceId: `ws-${f.task.id}`,
    status: "idle",
    active: false,
  });
  f.setObservation(
    running({ updatedAt: minutesAgo(35), turnStartedAt: minutesAgo(36) }),
  );
  await f.engine.wake();
  await f.engine.resolution.recovery.route(f.store.task(f.task.id));
  assert.equal(
    f.store.task(f.task.id).coordinatorAgentId,
    "agent-coord",
    "the retained coordinator binding is kept",
  );
  assert.equal(
    f.createdRuns.includes("recovery"),
    false,
    "a recorded route never opens a new coordinator thread on Paseo",
  );
  const attempt = f.store.task(f.task.id).resolution.recovery;
  if (attempt?.runId)
    assert.equal(
      f.store.run(attempt.runId)?.agentId,
      "agent-coord",
      "any attempt on this host continues the retained coordinator",
    );
});
