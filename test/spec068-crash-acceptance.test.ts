import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { Store } from "../core/store/store";
import { git } from "../core/git/index";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { recordServiceAlive, recordServiceStart, serviceDowntimeIntervals } from "../core/scheduling/service-downtime";
import { budgetOutageIntervals } from "../core/scheduling/host-outage";
import { Reports, type ReportInput } from "../core/intake/report";
import { recordResultApplied } from "../core/intake/applied-result";
import { ORPHAN_PHASE_GRACE_MS } from "../core/recovery/orphan-phase";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import { submissionSchema, type Completion, type Profile, type Run, type Task } from "../shared/contracts";
import { taskBudget } from "../shared/task-budget";
import { wireLabels } from "../shared/wire-labels";
import { t3Fake, threadProjection } from "./support/t3code-fake";

/**
 * Spec 068 acceptance: after a crash every task recovers with no owner, planner,
 * coordinator-answer or operator command.
 *
 * One board, one Store and the real Engine run over the real T3 host client on
 * the fake Nightly transport (`test/support/t3code-fake.ts`). Every participant
 * thread is a delegated T3 child created through `T3CodeHost.createAgent` under
 * the run's own create command id, so the intent ledger, late replies, the
 * complete absent read and thread deletion are the host's own code. Each task
 * works in a real git worktree; forge answers are synthetic. The board is driven
 * into each lifecycle state through ordinary dispatch, reports and passes, then
 * crashes in one step: the service stops mid-pass, every thread vanishes or goes
 * stale, the host connection drops, and some creates have unknown delivery. A
 * new service owner (a new Store connection and Engine, stamping its start
 * through `recordServiceStart` as the runtime owner does) then runs ordinary
 * passes.
 *
 * The clock is a shifted `Date` with a matching monotonic reading: graces,
 * bounds and the hour down are crossed by moving it, so the file runs in the
 * parallel lane. A state that does not recover is a `todo` subtest naming the
 * gap, with its assertion intact.
 */

const MINUTE = 60_000;
const RealDate = Date;
let shiftMs = 0;
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + shiftMs);
    else super(...(args as [number]));
  }
  static now() {
    return RealDate.now() + shiftMs;
  }
}
/** Sets the clock to `minutes` relative to the real one. */
const clockAt = (minutes: number) => {
  shiftMs = minutes * MINUTE;
};

const profile = (id: string): Profile => ({
  id, name: id, provider: "synthetic-provider", model: `synthetic-${id}`,
  available: true, problem: "", notes: "", supportedThinking: [],
});
const childOf = (command: string) => `thread:delegated-task:${command}`;
const live = ["preparing", "starting", "running", "waiting"];

type Scenario =
  | "dispatch-late" | "dispatch-lost" | "working-gone" | "working-idle" | "working-reported"
  | "awaiting-review" | "reviewing-gone" | "reviewing-reported-live" | "revision-gone"
  | "uncertain-reviewer-lost" | "uncertain-reviewer-late" | "coordinator" | "budget-near"
  | "budget-second-spend" | "formal-comment-only" | "merging" | "revision-cap";

test("Spec 068 acceptance: after a crash every task recovers with no owner or planner command", async (t: TestContext) => {
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
  t.after(() => {
    globalThis.Date = RealDate;
    shiftMs = 0;
  });
  const root = await realpath(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ns-crash-acceptance-")));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  // ---- Real repositories: each task works in its own worktree on its own branch ----
  const makeRepo = async (name: string) => {
    const origin = join(root, `${name}.git`), repo = join(root, name);
    await git(root, "init", "--bare", "--initial-branch=main", origin);
    await git(root, "clone", origin, repo);
    await git(repo, "config", "user.name", "Queue test");
    await git(repo, "config", "user.email", "queue@example.invalid");
    writeFileSync(join(repo, "README.md"), "synthetic\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "initial");
    await git(repo, "push", "origin", "main");
    return repo;
  };
  const mainRepo = await makeRepo("repo");
  const formalRepo = await makeRepo("formal-repo");
  const base = await git(mainRepo, "rev-parse", "HEAD");
  const formalBase = await git(formalRepo, "rev-parse", "HEAD");
  /** The task's worktree on its own branch, created at dispatch. */
  const checkouts = new Map<string, string>();
  const checkout = async (task: Task) => {
    const directory = join(root, `wt-${prs.get(task.id)!.number}`);
    if (!checkouts.has(task.id)) await git(task.repoPath, "worktree", "add", "-b", task.branch, directory, task.planningCommit);
    checkouts.set(task.id, directory);
    return directory;
  };
  /** The worker pushes a commit to its PR; returns the new head. */
  const commit = async (taskId: string) => {
    const directory = checkouts.get(taskId)!;
    const pr = prs.get(taskId)!;
    pr.round++;
    writeFileSync(join(directory, "lane.txt"), `round ${pr.round}\n`);
    await git(directory, "add", "-A");
    await git(directory, "commit", "-m", `round ${pr.round}`);
    pr.head = await git(directory, "rev-parse", "HEAD");
    await git(directory, "push", "origin", `HEAD:refs/heads/${await git(directory, "branch", "--show-current")}`);
    return pr.head;
  };

  // ---- The host: the fake Nightly and the real T3 client ----
  const server = await t3Fake(t, root);
  server.controls.providers = [
    { instanceId: PARENT_PROVIDER, displayName: "Nucleus", driver: "acpRegistry", enabled: true, status: "ready",
      models: [{ slug: PARENT_MODEL, name: "Nucleus" }] },
    { instanceId: "synthetic-provider", displayName: "Synthetic provider", driver: "codex", enabled: true, status: "ready",
      models: ["worker", "reviewer", "coordinator"].map((role) => ({ slug: `synthetic-${role}`, name: `Synthetic ${role}` })) },
  ];
  server.controls.runOnLaunch = true;
  server.controls.parentHeldTurn = true;
  const acp: AcpSessionSurface = {
    bind: (input) => ({ sessionId: `session:${input.taskId}`, taskId: input.taskId, bindingPath: `/synthetic/acp/${input.taskId}.json` }),
    async turn() { throw new Error("the task thread is not driven in this test"); },
    async message() { throw new Error("the task thread is not driven in this test"); },
    release() {},
  };
  const statePath = join(root, "t3-state.json");
  const hosts: T3CodeHost[] = [];
  const newHost = () => {
    const created = new T3CodeHost({ endpoint: server.endpoint, bearer: "synthetic-bearer", statePath, timeoutMs: 1_000,
      probeThreadId: "synthetic-probe", acp: () => acp, reentryTimeoutMs: 300 });
    hosts.push(created);
    return created;
  };
  t.after(() => { for (const each of hosts) each.close(); });
  let host = newHost();
  await host.connect();
  let hostUp = true;
  const workspace = await host.createWorkspace({ title: "Synthetic worktree", requestId: "workspace-intent", directory: root,
    project: { projectId: "synthetic-project" } });
  const HOST_ID = host.hostId;
  // The planner thread every task came from: a real thread on the host.
  const ORIGIN = "thread:synthetic-origin";
  server.threads.set(ORIGIN, threadProjection(ORIGIN, root));

  /** Threads the test treats as a working participant: heartbeated before each pass. */
  const stale = new Set<string>();
  const heartbeat = () => {
    const now = new Date().toISOString();
    for (const [id, projection] of server.threads) {
      if (stale.has(id) || projection.thread.deletedAt) continue;
      if (!(projection.runs ?? []).some((run: { status: string }) => live.includes(run.status))) continue;
      projection.updatedAt = now;
      projection.thread.updatedAt = now;
    }
  };
  /** A new turn starts now on this thread (a create or a message). */
  const freshen = (id: string) => {
    const projection = server.threads.get(id);
    if (!projection) return;
    const now = new Date().toISOString();
    projection.updatedAt = now;
    projection.thread.updatedAt = now;
    for (const run of projection.runs ?? []) if (live.includes(run.status)) run.startedAt = now;
  };
  /** The participant's turn ends: its thread is present and idle. */
  const idleThread = (id: string) => {
    for (const run of server.threads.get(id)?.runs ?? []) if (live.includes(run.status)) {
      run.status = "completed";
      run.completedAt = new Date().toISOString();
    }
  };
  /** Every delegated create T3 received, by command id. */
  const received = (command: string) =>
    server.commands.filter((entry) => entry.type === "delegated_task.request" && entry.commandId === command).length;

  // ---- The adapter: thread lifecycle on the T3 client, forge and git synthetic ----
  const worker = profile("worker"), reviewer = profile("reviewer"), coordinator = profile("coordinator");
  const profiles = [worker, reviewer, coordinator];
  const tokens = new Map<string, string>();
  const createPlan = new Map<string, "late" | "lost">();
  const prs = new Map<string, { number: number; head: string; gate: string; merged: boolean; round: number }>();
  const violations: string[] = [];
  const merges: { taskId: string; head: string }[] = [];
  let storeRef: Store | null = null;
  const prOf = (task: Task) => {
    const pr = prs.get(task.id)!;
    return { url: `https://github.com/example/repo/pull/${pr.number}`, head: pr.head, prNumber: pr.number,
      repository: "example/repo", headRepository: "example/repo" };
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
  /** Every create after the restart, by task and role. */
  const postCrash: { taskId: string; role: string }[] = [];
  let crashed = false;
  const create = (task: Task, runId: string, command: string, role: string | null) => serial(async () => {
    if (crashed) postCrash.push({ taskId: task.id, role: role ?? "worker" });
    // Nothing is re-sent where delivery was unknown without a complete absent read:
    // a create whose child T3 already made must never reach T3 again.
    const made = server.threads.has(childOf(command));
    const sent = received(command) + received(`${command}-socket`);
    const key = `${task.id}:${role ?? "worker"}`;
    const plan = createPlan.get(key);
    createPlan.delete(key);
    if (plan === "late") server.controls.holdDelegatedLaunch = true;
    if (plan === "lost") server.controls.timeoutDelegatedLaunch = true;
    try {
      const created = await host.createAgent({
        workspaceId: workspace.id, profile: task.profile ?? worker, title: task.title, taskNumber: task.number, mcpBindingPath: null,
        attempt: () => ({ requestId: command, prompt: `Synthetic ${role ?? "worker"} prompt`,
          labels: wireLabels({ task: task.id, run: runId, ...(role ? { role } : {}) }), environment: {} }),
      });
      freshen(created.id);
      return created;
    } finally {
      if (made && received(command) + received(`${command}-socket`) > sent)
        violations.push(`create ${command} re-sent after T3 made its child`);
      server.controls.holdDelegatedLaunch = false;
      server.controls.timeoutDelegatedLaunch = false;
    }
  });
  const adapter = {
    get hostId() { return HOST_ID; },
    isConnected: () => hostUp && host.connected,
    supportsCoordinatorRecovery: true,
    profiles: async () => profiles,
    validate: async (task: Task) => task.planningCommit,
    createWorkspace: async (task: Task) => ({ id: workspace.id, directory: await checkout(task) }),
    verifyWorkspace: async (task: Task) => task.branch,
    findWorkspaces: async () => [],
    findAgents: (task: Task) => host.findAgents(wireLabels({ task: task.id })),
    findRunAgents: (run: Run) => host.findRunAgents(wireLabels({ task: run.taskId, run: run.id })),
    createAgent: async (task: Task, token: string) => {
      tokens.set(task.runId!, token);
      return await create(task, task.runId!, `ns-agent-${task.runId}`, null);
    },
    createRun: async (task: Task, run: Run, token: string) => {
      tokens.set(run.id, token);
      return await create(task, run.id, `ns-run-${run.id}`, run.role);
    },
    sendRun: async (_task: Task, run: Run, token: string) => {
      tokens.set(run.id, token);
      if (crashed) postCrash.push({ taskId: run.taskId, role: run.role });
      await host.sendMessage(run.agentId!, { messageId: `ns-run-${run.id}`, text: "Synthetic revision prompt" });
      freshen(run.agentId!);
    },
    // The host's process table reads empty: no recorded participant process survives.
    hostProcessListing: async () => [],
    runTemporaryDirectory: (runId: string) => join(root, "scratch", runId),
    noLiveWorkspaceProcesses: async () => null,
    observe: (id: string) => host.observe(id),
    originAgent: (id: string) => host.originAgent(id),
    stopAgentTurn: async (id: string, turn?: string) => {
      await host.stopAgentTurn(id, turn);
      idleThread(id);
    },
    archiveAgent: (id: string) => host.archiveAgent(id),
    agentTimelinePage: (id: string, limit?: number) => host.agentTimelinePage(id, limit),
    listLiveAgents: () => host.listLiveAgents(),
    beginHostPass: (tasks: readonly Task[]) => host.beginHostPass(tasks),
    endHostPass: () => host.endHostPass(),
    // A message starts a turn on a present thread, as T3 does: a reminded worker resumes.
    notify: async (agentId: string, messageId: string, text: string) => {
      if (!server.threads.has(agentId) || agentId === ORIGIN) return;
      await host.sendMessage(agentId, { messageId, text });
      freshen(agentId);
    },
    steerOrNotify: async (agentId: string, messageId: string, text: string) => {
      if (server.threads.has(agentId) && agentId !== ORIGIN) {
        await host.sendMessage(agentId, { messageId, text });
        freshen(agentId);
      }
      return "delivered" as const;
    },
    verifyPr: async (task: Task) => prOf(task),
    verifyPrIdentity: async (task: Task) => prOf(task),
    verifyResume: async () => {},
    verifyInspectedRevisionHead: async () => {},
    verifyContinuedProgress: async () => {},
    verifyCleanQueueWorktree: async () => {},
    verifyReview: async (_task: Task, _run: Run, result: Completion) => result.reviewId ?? result.reviewCommentId ?? 4242,
    publishReview: async () => 4242,
    coveringEvidence: async (task: Task) => ({ head: prOf(task).head, base: task.planningCommit, wait: "" }),
    authorCommentEvidence: async () => "",
    mergeGate: async (task: Task) => {
      const wait = prs.get(task.id)!.gate;
      return { head: prOf(task).head, base: task.planningCommit, wait, ...(wait ? { pendingCheck: true } : {}) };
    },
    merge: async (task: Task) => {
      // Nothing merges without a valid exact-head review.
      const store = storeRef!;
      const current = store.task(task.id);
      const pr = prs.get(task.id)!;
      const approved = store.runs(task.id).some((run) => run.role === "reviewer" && run.head === pr.head &&
        run.completion?.status === "ready_to_merge" &&
        store.eventsAll(task.id).some((event) => event.kind === "review_result_applied" && event.detail.includes(run.id)));
      if (!approved || current.prHead !== pr.head) violations.push(`merge of ${current.title} without an applied exact-head review`);
      merges.push({ taskId: task.id, head: pr.head });
      pr.merged = true;
    },
    merged: async (task: Task) => {
      const pr = prs.get(task.id)!;
      return { merged: pr.merged, commit: pr.merged ? pr.head : null, head: pr.head, base: "main" };
    },
    syncMain: async (task: Task) => prs.get(task.id)!.head,
    verifyCloseout: async () => {},
  } as unknown as Adapter;

  // ---- The service: one Store and Engine per service owner ----
  const storePath = join(root, "queue.sqlite");
  let store = new Store(storePath);
  storeRef = store;
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 50);
  store.setMeta("projectLimit", 30);
  store.setMeta("pool", profiles.map((p) => ({ profileId: p.id, enabled: true, group: p.id, roles: [p.id],
    weight: "default", scopes: ["general"] })));
  /** The monotonic clock moves with the shifted one: the machine never sleeps here. */
  const monotonic = () => process.hrtime.bigint() + BigInt(shiftMs) * 1_000_000n;
  const startEngine = (owner: string) => {
    recordServiceStart(store, owner, new Date().toISOString(), monotonic());
    const engine = new Engine(store, adapter, 60_000);
    engine.profiles = profiles;
    engine.hostIds = () => [HOST_ID];
    engine.hostAvailable = () => hostUp && host.connected;
    return engine;
  };
  clockAt(-500);
  let owner = "service-owner-1";
  let engine = startEngine(owner);
  t.after(async () => { await engine.stop(); store.close(); });

  const tasks = new Map<Scenario, string>();
  const id = (scenario: Scenario) => tasks.get(scenario)!;
  const task = (scenario: Scenario) => store.task(id(scenario));
  const events = (scenario: Scenario, kind?: string) =>
    store.eventsAll(id(scenario)).filter((event) => !kind || event.kind === kind);
  let number = 0;
  const insert = (scenario: Scenario, repo = mainRepo) => {
    number++;
    const planning = repo === formalRepo ? formalBase : base;
    const inserted = store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: scenario, repoPath: repo, planningCommit: planning, responsible: true,
      brief: { text: `Synthetic brief for ${scenario}\n` }, originAgentId: ORIGIN,
    }), HOST_ID, "brief", planning);
    prs.set(inserted.id, { number, head: planning, gate: "", merged: false, round: 0 });
    tasks.set(scenario, inserted.id);
    return inserted;
  };

  // ---- Invariants, checked after every pass ----
  const appliedVerdicts = new Set<string>();
  const checkInvariants = (label: string) => {
    for (const [scenario, taskId] of tasks) {
      const current = store.task(taskId);
      const runs = store.runs(taskId);
      // No role has two live runs at one head.
      const liveRuns = runs.filter((run) => !run.released);
      const byRoleHead = new Map<string, number>();
      for (const run of liveRuns) {
        const role = run.role === "revision" || run.role === "executor" ? "worker" : run.role;
        const key = `${role}@${run.head}`;
        byRoleHead.set(key, (byRoleHead.get(key) ?? 0) + 1);
      }
      for (const [key, count] of byRoleHead)
        if (count > 1) violations.push(`${label}: ${scenario} has ${count} live runs for ${key}`);
      // No run ever has two threads.
      for (const run of runs) {
        const threads = [`ns-run-${run.id}`, `ns-run-${run.id}-socket`].filter((command) => server.threads.has(childOf(command)));
        if (threads.length > 1) violations.push(`${label}: ${scenario} run ${run.id} has two threads`);
      }
      const workerThreads = [...server.threads.values()].filter((projection) =>
        projection.thread.id.startsWith(childOf(`ns-agent-${current.runId}`)));
      if (current.runId && workerThreads.length > 1) violations.push(`${label}: ${scenario} worker run has two threads`);
      // No verdict is applied at a non-current head.
      for (const event of store.eventsAll(taskId).filter((entry) => entry.kind === "review_result_applied")) {
        const key = `${taskId}:${event.id}`;
        if (appliedVerdicts.has(key)) continue;
        appliedVerdicts.add(key);
        const run = runs.find((candidate) => event.detail.includes(candidate.id));
        if (run && run.head !== current.prHead && run.head !== prs.get(taskId)!.head)
          violations.push(`${label}: ${scenario} applied a verdict at ${run.head}, not the current head ${current.prHead}`);
      }
    }
  };
  /** Since when each task has read with no live run, no stop and no hold. */
  const ownerless = new Map<string, number>();
  let worstOwnerless = { scenario: "", ms: 0 };
  const checkOwnerless = () => {
    for (const [scenario, taskId] of tasks) {
      const current = store.task(taskId);
      const next = ownerTaskNext(collectOwnerVerbFacts(store, current));
      const orphan = next.activity?.state === "unclassified" && next.activity.role === null;
      if (!orphan) {
        ownerless.delete(taskId);
        continue;
      }
      const since = ownerless.get(taskId) ?? Date.now();
      ownerless.set(taskId, since);
      if (Date.now() - since > worstOwnerless.ms) worstOwnerless = { scenario, ms: Date.now() - since };
    }
  };

  const timing: Record<string, number> = {};
  const pass = async (label: string) => {
    const began = performance.now();
    heartbeat();
    await engine.wake();
    await engine.quiesce();
    if (hostUp) recordServiceAlive(store, owner, new Date().toISOString(), monotonic());
    checkInvariants(label);
    const key = label.split(" ")[0]!;
    timing[key] = (timing[key] ?? 0) + performance.now() - began;
  };
  /** Ordinary passes until the board reaches a state the drive needs. */
  const passUntil = async (what: string, done: () => boolean, passes = 8) => {
    for (let index = 0; index < passes && !done(); index++) await pass("pre");
    if (!done()) {
      debug(`stuck: ${what}`);
      assert.fail(`the board did not reach the state before the crash: ${what}`);
    }
  };
  /** A participant's report through the callback path the helper CLI uses. */
  const report = async (taskId: string, runId: string, status: Completion["status"], extra: Partial<Completion> = {},
    turn: "ends" | "keeps running" = "ends") => {
    const current = store.task(taskId);
    const run = store.run(runId);
    // A participant reports at the end of its turn, unless the case keeps it running.
    const agentId = run ? run.agentId : current.agentId;
    if (agentId && turn === "ends") idleThread(agentId);
    const completion: Completion = {
      taskId, runId, eventId: randomUUID(), status, summary: `${run?.role ?? "worker"} reported ${status}`,
      head: run?.role === "reviewer" ? run.head : prs.get(taskId)!.head,
      ...(run?.role === "reviewer"
        ? { reviewText: `Synthetic findings for ${status}.`, ...(status === "changes_required" ? { reviewResponsibility: "author" as const } : {}) }
        : { prNumber: prs.get(taskId)!.number }),
      ...extra,
    } as Completion;
    const result = await new Reports(engine).report(completion as ReportInput, tokens.get(runId)!) as { accepted?: boolean };
    assert.equal(result.accepted, true, `${current.title}: ${runId} report accepted: ${JSON.stringify(result)}`);
  };
  const currentRun = (scenario: Scenario) => store.run(task(scenario).resolution.currentRunId ?? "") ?? null;
  const debug = (label: string) => {
    if (!process.env.CRASH_ACCEPTANCE_DEBUG) return;
    for (const [scenario, taskId] of tasks) {
      const current = store.task(taskId);
      const next = ownerTaskNext(collectOwnerVerbFacts(store, current));
      console.log(`${label} ${scenario}: ${current.phase} run=${current.resolution.currentRunId} agent=${current.agentId} ` +
        `stop=${current.resolution.stop?.reason ?? "-"} activity=${next.activity?.state}/${next.activity?.detail} | ${current.reason.slice(0, 160)} | ` +
        store.eventsAll(taskId).slice(-5).map((event) => event.kind).join(","));
    }
  };

  // ---- Before the crash: drive the board through the ordinary lifecycle ----
  // The second-spend task started long ago and was extended once already.
  insert("budget-second-spend");
  await pass("pre");
  store.update(id("budget-second-spend"), { resolution: { ...task("budget-second-spend").resolution, budgetExtensions: 1 } });
  // The near-limit task dispatches 150 minutes before the crash at -50.
  clockAt(-200);
  insert("budget-near");
  insert("coordinator");
  await pass("pre");
  await pass("pre");
  // The coordinator task's worker stops showing activity: by -65 it has stalled
  // and the sweep admits a coordinator for it.
  stale.add(task("coordinator").agentId!);

  clockAt(-65);
  for (const scenario of ["dispatch-late", "dispatch-lost", "working-gone", "working-idle", "working-reported",
    "awaiting-review", "reviewing-gone", "reviewing-reported-live", "revision-gone", "uncertain-reviewer-lost",
    "uncertain-reviewer-late", "merging", "revision-cap"] as Scenario[]) insert(scenario);
  insert("formal-comment-only", formalRepo);
  store.patchRepository({ path: formalRepo, origin: null }, { reviewer: { login: "review-bot" } });
  // The dispatch creates: T3 answers one late and never receives the other.
  createPlan.set(`${id("dispatch-late")}:worker`, "late");
  createPlan.set(`${id("dispatch-lost")}:worker`, "lost");
  await passUntil("every worker started", () => [...tasks.values()].every((taskId) => store.task(taskId).phase !== "queued" && store.task(taskId).phase !== "dispatching"));
  // The workers that finished push and report their PR. Two reviewer creates
  // then have unknown delivery: T3 answers one late and never receives the other.
  createPlan.set(`${id("uncertain-reviewer-lost")}:reviewer`, "lost");
  createPlan.set(`${id("uncertain-reviewer-late")}:reviewer`, "late");
  for (const scenario of ["reviewing-gone", "reviewing-reported-live", "revision-gone", "uncertain-reviewer-lost",
    "uncertain-reviewer-late", "merging", "revision-cap", "formal-comment-only"] as Scenario[]) {
    if (!checkouts.has(id(scenario))) { debug("no-checkout"); assert.fail(`${scenario} has no checkout: ${task(scenario).phase} ${task(scenario).reason}`); }
    await commit(id(scenario));
    await report(id(scenario), task(scenario).runId!, "ready_for_review");
  }
  await passUntil("every reviewer started", () => (["reviewing-gone", "reviewing-reported-live", "revision-gone", "merging",
    "revision-cap", "formal-comment-only"] as Scenario[]).every((scenario) => currentRun(scenario)?.role === "reviewer" && currentRun(scenario)?.agentId));
  debug("pre-review");

  // A revision in flight on the retained worker.
  await report(id("revision-gone"), currentRun("revision-gone")!.id, "changes_required");
  // The approved head waits for its checks.
  prs.get(id("merging"))!.gate = "PR checks are pending";
  await report(id("merging"), currentRun("merging")!.id, "ready_to_merge");
  await pass("pre");
  await pass("pre");
  // Seven non-converging review rounds reach the revision cap.
  for (let round = 1; round <= 7; round++) {
    const reviewing = currentRun("revision-cap");
    assert.equal(reviewing?.role, "reviewer", `round ${round}: ${task("revision-cap").phase} ${task("revision-cap").reason}`);
    await report(id("revision-cap"), reviewing!.id, "changes_required");
    await pass("pre");
    if (round === 7) break;
    const revision = currentRun("revision-cap");
    assert.equal(revision?.role, "revision", `round ${round}: ${task("revision-cap").phase} ${task("revision-cap").reason}`);
    await commit(id("revision-cap"));
    await report(id("revision-cap"), revision!.id, "ready_for_review");
    await pass("pre");
  }
  await pass("pre");
  // An applied worker result whose reviewer is not yet admitted: the stored
  // shape result application leaves (the responsible-lifecycle fixture's start).
  {
    const current = task("awaiting-review");
    const head = await commit(current.id);
    idleThread(current.agentId!);
    const pr = prOf(current);
    store.update(current.id, {
      phase: "awaiting_review", prHead: head, prUrl: pr.url, resumePrNumber: pr.prNumber, agentActive: false,
      completion: { taskId: current.id, runId: current.runId!, eventId: randomUUID(), status: "ready_for_review",
        summary: "Ready", prNumber: pr.prNumber, head },
    }, "work_done");
    recordResultApplied(store, current.id, current.runId!);
  }
  debug("pre-crash");

  // ---- The crash, in one step ----
  clockAt(-50);
  heartbeat();
  recordServiceAlive(store, owner, new Date().toISOString(), monotonic());
  // Three reports land just as the service dies: a worker's PR, a verdict whose
  // reviewer's turn is still running, and, in a formal-review repository, a
  // reviewer's PR comment where a formal review was required.
  const midPass = engine.wake();
  const lateReports = Promise.allSettled([
    (async () => {
      await commit(id("working-reported"));
      await report(id("working-reported"), task("working-reported").runId!, "ready_for_review");
    })(),
    report(id("reviewing-reported-live"), currentRun("reviewing-reported-live")!.id, "changes_required", {}, "keeps running"),
    (async () => {
      const run = currentRun("formal-comment-only")!;
      store.putRun({ ...run, formalReview: undefined });
      idleThread(run.agentId!);
      const result = engine.resolution.complete({
        taskId: id("formal-comment-only"), runId: run.id, eventId: randomUUID(), status: "ready_to_merge",
        summary: "Reviewed the exact head", head: run.head, reviewCommentId: 7001,
      } as Completion, tokens.get(run.id)!);
      assert.equal(result.accepted, true, JSON.stringify(result));
    })(),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  // The service process stops mid-pass, and the host connection drops with it.
  hostUp = false;
  server.dropSockets();
  host.close();
  const [, reported] = await Promise.allSettled([midPass, lateReports]);
  if (reported.status === "fulfilled") for (const each of reported.value) if (each.status === "rejected") throw each.reason;
  await engine.stop();
  /** What each task held at the crash. */
  const before = new Map([...tasks].map(([scenario, taskId]) => {
    const current = store.task(taskId);
    const run = store.run(current.resolution.currentRunId ?? "");
    const coordinatorRun = store.runs(taskId).find((candidate) => candidate.role === "recovery" && !candidate.released);
    const reading = ownerTaskNext(collectOwnerVerbFacts(store, current)).activity;
    return [scenario, { phase: current.phase, runId: current.runId, agentId: current.agentId, run,
      coordinator: coordinatorRun?.agentId ?? null, prHead: current.prHead, activity: `${reading?.state}: ${reading?.detail}` }] as const;
  }));
  const at = (scenario: Scenario) => before.get(scenario)!;
  // The board held every state the crash is meant to hit.
  for (const scenario of ["dispatch-late", "dispatch-lost"] as Scenario[]) assert.equal(at(scenario).agentId, null, `${scenario}: no worker bound`);
  for (const scenario of ["working-gone", "working-idle", "working-reported", "budget-near", "budget-second-spend"] as Scenario[])
    assert.equal(at(scenario).phase, "working", scenario);
  assert.equal(at("reviewing-gone").run?.role, "reviewer");
  assert.equal(at("reviewing-reported-live").run?.role, "reviewer");
  assert.equal(at("revision-gone").run?.role, "revision");
  for (const scenario of ["uncertain-reviewer-lost", "uncertain-reviewer-late"] as Scenario[])
    assert.equal(at(scenario).run?.role === "reviewer" && at(scenario).run?.agentId, null, `${scenario}: the reviewer create is unsettled`);
  assert.ok(at("coordinator").coordinator, "a coordinator is running");
  assert.ok(["verifying", "merging"].includes(at("merging").phase), at("merging").phase);
  assert.match(at("revision-cap").activity, /^needs_person/);
  store.close();
  // Every agent thread vanishes or goes stale on the host.
  const removed = [at("working-gone").agentId, at("revision-gone").agentId, at("coordinator").coordinator, at("budget-second-spend").agentId];
  const tombstoned = [at("reviewing-gone").run?.agentId];
  const idled = [at("working-idle").agentId, at("budget-near").agentId, at("awaiting-review").agentId, at("working-reported").agentId];
  const staleRunning = [at("reviewing-reported-live").run?.agentId, at("coordinator").agentId];
  for (const thread of [...removed, ...tombstoned, ...idled, ...staleRunning]) assert.ok(thread && server.threads.has(thread), `thread ${thread} exists at the crash`);
  for (const thread of removed) server.threads.delete(thread!);
  for (const thread of tombstoned) server.threads.get(thread!)!.thread.deletedAt = new Date().toISOString();
  for (const thread of idled) idleThread(thread!);
  for (const thread of staleRunning) stale.add(thread!);
  // T3 processes the creates it held: each child exists, its reply went nowhere.
  server.releaseHeldLaunches();

  // ---- Restart: a new service owner an hour later ----
  clockAt(10);
  store = new Store(storePath);
  storeRef = store;
  owner = "service-owner-2";
  engine = startEngine(owner);
  const restartedAt = Date.now();
  host = newHost();
  postCrash.length = 0;
  crashed = true;
  // The host is still away for the first pass, then comes back.
  await pass("restart");
  await host.connect();
  hostUp = true;
  // Ordinary passes a minute apart: past the orphan grace, the creation lookup
  // grace and every late-reply bound. Nothing but the clock and the passes moves.
  const PASS_MS = MINUTE;
  for (let minute = 1; minute <= 12; minute++) {
    clockAt(10 + minute);
    // The approved head's checks finish while the service is back.
    if (minute === 2) prs.get(id("merging"))!.gate = "";
    await pass(`after +${minute} min`);
    checkOwnerless();
  }
  debug("final");
  if (process.env.CRASH_ACCEPTANCE_DEBUG) console.log("TIMING", JSON.stringify(timing));
  if (process.env.CRASH_ACCEPTANCE_DEBUG?.includes(","))
    for (const scenario of process.env.CRASH_ACCEPTANCE_DEBUG.split(",") as Scenario[])
      if (tasks.has(scenario)) for (const event of events(scenario)) console.log("EV", scenario, event.at, event.kind, event.detail.slice(0, 400));

  // ---- Outcomes ----
  const next = (scenario: Scenario) => ownerTaskNext(collectOwnerVerbFacts(store, task(scenario)));
  /** The thread is on the host, not deleted, with a turn in progress. */
  const threadLive = (agentId: string | null | undefined) => {
    const projection = agentId ? server.threads.get(agentId) : undefined;
    return Boolean(projection && !projection.thread.deletedAt &&
      (projection.runs ?? []).some((run: { status: string }) => live.includes(run.status)));
  };
  /** The task progressed to a live run: the activity reads active and its participant's thread is working. */
  const progressedToLiveRun = (scenario: Scenario, role: "worker" | "reviewer") => {
    const current = task(scenario);
    const reading = next(scenario).activity;
    assert.equal(reading?.state, "active", `${scenario}: ${current.phase} · ${reading?.state}/${reading?.detail} · ${current.reason}`);
    assert.equal(reading?.role, role, `${scenario}: the ${role} is the active participant`);
    const run = store.run(current.resolution.currentRunId ?? "");
    const agentId = run && !run.released ? run.agentId : current.agentId;
    assert.ok(threadLive(agentId), `${scenario}: its participant's thread ${agentId} is live on the host`);
    return { current, run: run && !run.released ? run : null, agentId: agentId! };
  };
  /** A typed stop that needs a person: a reason, and the explicit command that answers it. */
  const typedPersonStop = (scenario: Scenario) => {
    const reading = next(scenario);
    assert.equal(reading.activity?.state, "needs_person", `${scenario}: ${reading.activity?.state}/${reading.activity?.detail}`);
    assert.ok(reading.stop?.reason, `${scenario}: the stop has a reason`);
    assert.ok((reading.explicitCommands ?? []).length > 0, `${scenario}: the stop carries its explicit command`);
    return reading;
  };
  const createdSince = (scenario: Scenario, role?: string) =>
    postCrash.filter((entry) => entry.taskId === id(scenario) && (!role || entry.role === role));

  await t.test("invariants: one thread per run, one live run per role and head", () => {
    assert.deepEqual(violations.filter((entry) => /two threads|live runs for/.test(entry)), []);
  });
  await t.test("invariants: verdicts apply only at the current head, and nothing merges without an exact-head review", () => {
    assert.deepEqual(violations.filter((entry) => /applied a verdict|merge of/.test(entry)), []);
    assert.deepEqual(merges.map((merge) => merge.taskId), [id("merging")], "only the approved task merged");
    assert.equal(merges[0]!.head, at("merging").prHead, "at its reviewed head");
  });
  await t.test("invariants: nothing is re-sent where delivery was unknown without a complete absent read", () => {
    assert.deepEqual(violations.filter((entry) => /re-sent/.test(entry)), []);
    for (const scenario of ["dispatch-late", "uncertain-reviewer-late"] as Scenario[]) {
      const command = scenario === "dispatch-late" ? `ns-agent-${at(scenario).runId}` : `ns-run-${at(scenario).run!.id}`;
      assert.equal(received(command), 1, `${scenario}: the late create reached T3 once and was never re-sent`);
    }
    for (const scenario of ["dispatch-lost", "uncertain-reviewer-lost"] as Scenario[]) {
      const command = scenario === "dispatch-lost" ? `ns-agent-${at(scenario).runId}` : `ns-run-${at(scenario).run!.id}`;
      assert.equal(received(command), 2, `${scenario}: the lost create and one resend under the same command id`);
      assert.ok(server.threads.has(childOf(command)), `${scenario}: the resend made the one child`);
      assert.equal(server.threads.has(childOf(`${command}-socket`)), false, `${scenario}: no second child`);
    }
  });
  await t.test("invariants: no task sits with no live run, stop or hold past the orphan grace and one pass", () => {
    assert.ok(worstOwnerless.ms <= ORPHAN_PHASE_GRACE_MS + PASS_MS,
      `${worstOwnerless.scenario} read ownerless for ${worstOwnerless.ms / MINUTE} minutes`);
  });
  await t.test("invariants: budgets do not count the downtime", () => {
    const downtime = serviceDowntimeIntervals(store).at(-1);
    assert.ok(downtime && Date.parse(downtime.until!) - Date.parse(downtime.since) >= 59 * MINUTE,
      `the new owner closed the hour down into the history: ${JSON.stringify(downtime)}`);
    const current = task("budget-near");
    const runs = store.runs(current.id), history = store.eventsAll(current.id);
    const counted = taskBudget(current, runs, Date.now(), history, null, []);
    const measured = taskBudget(current, runs, Date.now(), history, null, budgetOutageIntervals(store, current.hostId));
    assert.equal(counted.exhausted, "wall_time", "with the downtime counted the budget would be spent");
    assert.equal(measured.exhausted, null, `measured: ${measured.wallMs.used / MINUTE} of ${measured.wallMs.limit / MINUTE} minutes`);
    assert.equal(history.filter((event) => event.kind === "budget_extended").length, 0, "nothing was extended for the downtime");
    assert.notEqual(current.resolution.stop?.reason, "budget");
  });

  await t.test("dispatching, create answered late: the lookup binds the one child", () => {
    const { current } = progressedToLiveRun("dispatch-late", "worker");
    assert.equal(current.agentId, childOf(`ns-agent-${at("dispatch-late").runId}`));
    assert.equal(events("dispatch-late", "creation_bound_by_lookup").length, 1);
  });
  await t.test("dispatching, an unknown create reads as Nucleus waiting on the host, not a person's stop",
    { todo: "an unknown first-dispatch create records an operator_needed stop (core/dispatch/worker-launcher.ts:569 rethrows it to the generic step failure)" }, () => {
      for (const scenario of ["dispatch-late", "dispatch-lost"] as Scenario[])
        assert.doesNotMatch(at(scenario).activity, /^needs_person/, `${scenario} at the crash`);
    });
  await t.test("dispatching, create lost: a complete absent read relaunches it under the same command id", () => {
    const { current } = progressedToLiveRun("dispatch-lost", "worker");
    assert.equal(current.agentId, childOf(`ns-agent-${at("dispatch-lost").runId}`));
  });
  await t.test("working, worker thread deleted: the worker is released and dispatched fresh", () => {
    const { current } = progressedToLiveRun("working-gone", "worker");
    assert.notEqual(current.agentId, at("working-gone").agentId);
    assert.equal(events("working-gone", "participant_gone").length, 1);
  });
  await t.test("working, worker thread idle with no report: the worker continues", () => {
    progressedToLiveRun("working-idle", "worker");
  });
  await t.test("working, worker reported but not applied: the result applies and review starts", () => {
    const { run } = progressedToLiveRun("working-reported", "reviewer");
    assert.equal(run?.head, task("working-reported").prHead);
  });
  await t.test("awaiting_review: a reviewer starts at the head", () => {
    const { run } = progressedToLiveRun("awaiting-review", "reviewer");
    assert.equal(run?.head, task("awaiting-review").prHead);
  });
  await t.test("reviewing, reviewer thread deleted: a fresh reviewer at the same head", () => {
    const { run } = progressedToLiveRun("reviewing-gone", "reviewer");
    assert.notEqual(run?.id, at("reviewing-gone").run?.id);
    assert.equal(run?.head, at("reviewing-gone").run?.head);
  });
  await t.test("reviewing, verdict reported while the reviewer's turn runs: the verdict applies and the revision starts", () => {
    const { run } = progressedToLiveRun("reviewing-reported-live", "worker");
    assert.equal(run?.role, "revision");
    assert.ok(events("reviewing-reported-live", "review_result_applied").some((event) => event.detail.includes(at("reviewing-reported-live").run!.id)));
  });
  await t.test("changes_requested, retained worker thread deleted: the revision continues on a fresh worker", () => {
    const { run } = progressedToLiveRun("revision-gone", "worker");
    assert.equal(run?.role, "revision");
    assert.notEqual(run?.agentId, at("revision-gone").agentId);
  });
  await t.test("uncertain reviewer creation, create lost: relaunched once under the same run", () => {
    const { run } = progressedToLiveRun("uncertain-reviewer-lost", "reviewer");
    assert.equal(run?.id, at("uncertain-reviewer-lost").run?.id);
    assert.equal(run?.agentId, childOf(`ns-run-${run?.id}`));
  });
  await t.test("uncertain reviewer creation, create answered late: the lookup binds the one child", () => {
    const { run } = progressedToLiveRun("uncertain-reviewer-late", "reviewer");
    assert.equal(run?.id, at("uncertain-reviewer-late").run?.id);
    assert.equal(events("uncertain-reviewer-late", "creation_bound_by_lookup").length, 1);
  });
  await t.test("a coordinator episode running at the crash: the repair continues with no planner",
    { todo: "a recovery episode whose coordinator thread is gone escalates to the planner (core/recovery/coordinator-pass.ts:616 rethrows the unobservable read; :880 escalates it)" }, () => {
      const reading = next("coordinator");
      assert.notEqual(reading.activity?.state, "needs_person", `${reading.activity?.detail}: ${task("coordinator").reason}`);
      assert.equal(events("coordinator", "recovery_escalated").length, 0);
    });
  await t.test("a task near its budget keeps working: the downtime spent none of it", () => {
    progressedToLiveRun("budget-near", "worker");
  });
  await t.test("a second budget spend stops for a person with its command, and starts no run",
    { todo: "a dead initial worker's redispatch starts a fresh worker past a spent budget (core/recovery/dead-participant.ts:375 returns it to first dispatch, which has no budget gate; the gate is core/dispatch/launch.ts:223, run launches only)" }, () => {
      const reading = typedPersonStop("budget-second-spend");
      assert.equal(reading.stop?.reason, "budget");
      assert.ok(reading.explicitCommands?.some((command) => command.action === "run.start" &&
        ((command.args as { accept?: string[] }).accept ?? []).includes("budget")));
      assert.deepEqual(createdSince("budget-second-spend"), [], "no worker started past the spent budget");
    });
  await t.test("formal-review repository, comment-only verdict: superseded, and a fresh formal reviewer starts", () => {
    const { run } = progressedToLiveRun("formal-comment-only", "reviewer");
    assert.equal(run?.formalReview, true);
    assert.equal(task("formal-comment-only").resolution.review, null, "the comment verdict is never accepted");
    assert.equal(events("formal-comment-only", "reported_verdict_superseded").length, 1);
  });
  await t.test("verifying and merging: the reviewed head merges once its checks pass", () => {
    const current = task("merging");
    assert.ok(["syncing", "closing", "done"].includes(current.phase), `${current.phase}: ${current.reason}`);
    assert.equal(current.resolution.mergedCommit, at("merging").prHead);
  });
  await t.test("no coordinator is admitted for a wait that only the downtime aged",
    { todo: "the mechanical stall window measures stop age in wall time, downtime included (core/recovery/coordinator-route.ts:284 stopAgeMs)" }, () => {
      const launched = events("merging", "telemetry_recovery").filter((event) => Date.parse(event.at) >= restartedAt);
      assert.deepEqual(launched.map((event) => event.detail.slice(0, 160)), [], "a checks-pending wait an hour old by the wall clock");
    });
  await t.test("revision cap: a typed stop for a person with its command, and no revision starts", () => {
    const reading = typedPersonStop("revision-cap");
    assert.ok(reading.explicitCommands?.some((command) => command.action === "run.start" &&
      (command.args as { role?: string }).role === "worker" && ((command.args as { accept?: string[] }).accept ?? []).includes("budget")),
    JSON.stringify(reading.explicitCommands));
    assert.deepEqual(createdSince("revision-cap"), [], "no revision run past the cap");
  });
});
