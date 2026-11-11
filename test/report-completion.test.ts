import { formatAgentId } from '../shared/agent-identity';
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { briefDigest } from "../core/planning/brief";
import { runBuildOutputIntent } from "../core/hooks/build-output-records";
import { Engine } from "../core/engine";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import type { Adapter, AgentObservation } from "../core/host";
import { submissionSchema, taskControlInputSchema, type Completion, type Task } from "../shared/contracts";

const owner = "a62c23de-cc50-4265-9d9e-a2fd1637f7a4";
const worker = "c4959c43-681c-4f1c-94a2-09c998fd7ab0";
const reportText = [
  "## Findings", "Observed the current release surface and preserved timing caveats.",
  "", "## Caveats", "Knip coverage is partial because DNS was unavailable.",
].join("\n");
const briefText = [
  "## Outcome", "Deliver a report describing the current web health findings and caveats.",
  "", "## Not in scope", "- Any code change or repository edit.",
  "", "## Validation", "- Report only.",
].join("\n");
const reportOnlyBrief = `---\ntitle: Report only\nqueue_approval: test authorization\nqueue:\n  lanes: [web-health]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite the report to web-health.\n`;
const leadPromotedReportOnlyBrief = `---\ntitle: Report only\nqueue:\n  lanes: [web-health]\n  reportOnly: true\n  reportLane: web-health\n---\n\n## Outcome\nWrite the report to web-health.\n`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixture(options: { brief?: string; openPr?: boolean; draftPr?: boolean; escalated?: boolean; active?: boolean; permissions?: boolean; unknown?: boolean;
  onPrLookup?: (f: ReturnType<typeof fixture>) => void; missingReceipt?: boolean; stoppedRun?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nsq-report-completion-"));
  const repo = join(dir, "repo"), origin = join(dir, "origin.git"), worktree = join(dir, "task-worktree"), db = join(dir, "queue.sqlite");
  execFileSync("git", ["init", "-b", "main", repo], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { cwd: dir, stdio: "ignore" });
  git(repo, "config", "user.name", "Queue fixture");
  git(repo, "config", "user.email", "queue-fixture@example.test");
  writeFileSync(join(repo, "README.md"), "report fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "planning head");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "origin", "main");

  const store = new Store(db);
  store.setMeta("paused", false);
  store.upsertLane({ key: "web-health", title: "Web health", aim: "Report web health", repositories: [{ origin: "acme/report", path: repo }] });
  const artifact = store.editLaneDocument({ key: "web-health", version: 0, text: reportText, author: owner });
  const submission = submissionSchema.parse({ submissionId: randomUUID(), title: "Accepted report", repoPath: repo,
    planningCommit: base, originAgentId: owner, notifyOriginOnCloseout: true, lanes: ["web-health"],
    brief: { text: options.brief ?? briefText, mediaType: "text/markdown" } });
  const inserted = store.insert(submission, "fixture-host", submission.brief!.text, base, {}, undefined, null);
  execFileSync("git", ["worktree", "add", "-b", `ns-${inserted.id}`, worktree, base], { cwd: repo, stdio: "ignore" });
  const completion: Completion = { eventId: "worker-callback-1", taskId: inserted.id, runId: "worker-run-1", status: "blocked",
    summary: "Report delivered; original timings are unavailable and Knip coverage is partial." };
  if (!options.missingReceipt) store.db.prepare("INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)")
    .run(completion.eventId, inserted.id, completion.runId, "a".repeat(64), JSON.stringify({ accepted: true }));
  let task = store.update(inserted.id, { phase: "blocked", workspaceId: "task-workspace", directory: worktree,
    workspaceIntent: true, agentIntent: true, agentId: worker, runId: completion.runId, completion,
    agentActive: false, lastAgentStatus: "idle", idleSince: new Date().toISOString(),
    originWorkspaceId: "owner-workspace" });
  const project = store.projectFor(repo, "acme/report")!;
  store.setProjectPlanner({ key: project.key, agentId: owner, setBy: "test", note: "Current project planner" });
  const states = new Map<string, AgentObservation>([
    [owner, { id: owner, workspaceId: "owner-workspace", status: "idle", active: false, permissions: false, error: "" }],
    [worker, { id: worker, workspaceId: "task-workspace", status: "idle", active: false, permissions: false, error: "" }],
  ]);
  if (options.escalated) {
    const recoveryId = "report-only-recovery";
    const recoveryAgent = "report-only-coordinator";
    const recoveryEventId = "report-only-recovery-callback";
    const summary = "Owner must choose between accepting the delivered report and changing scope.";
    const recoveryCompletion: Completion = { eventId: recoveryEventId, taskId: inserted.id, runId: recoveryId, status: "escalate", summary };
    const profile = { id: "recovery", name: "Recovery", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };
    store.putRun({ id: recoveryId, taskId: inserted.id, role: "recovery", generation: 1, head: base, base,
      agentId: recoveryAgent, workspaceId: "task-workspace", profile, status: "finished", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: recoveryCompletion, released: true });
    store.db.prepare("INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)").run(recoveryEventId, inserted.id, recoveryId, "c".repeat(64), JSON.stringify({ accepted: true }));
    const incident = { id: "report-only-incident", fingerprint: "report-only-incident", role: "worker" as const,
      runId: completion.runId, attempt: 0, cause: "worker_blocked", detail: summary, action: "" as const,
      status: "escalated" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const recovery = { id: "report-only-episode", key: "report-only", generation: 1, runId: recoveryId,
      agentId: recoveryAgent, status: "escalated" as const, summary, idleSince: null, incidentId: incident.id,
      action: { eventId: recoveryEventId, runId: recoveryId, reportStatus: "escalate" as const,
        recoveryAction: null, summary, status: "pending" as const } };
    store.update(inserted.id, { resolution: { ...store.task(inserted.id).resolution, attention: true, incident, recovery } });
    states.set(recoveryAgent, { id: recoveryAgent, workspaceId: "task-workspace", status: "idle", active: false, permissions: false, error: "" });
    store.putNotice({ id: "report-only-attention", taskId: inserted.id, agentId: owner, recipientAgentId: owner,
      workspaceId: "owner-workspace", sources: [], originEntry: true, kind: "attention", status: "pending", error: "", text: "Owner decision required" });
  }
  const adapter = {
    notify: async (agentId: string, messageId: string, text: string) => { notices.push({ agentId, messageId, text }); },
    observe: async (id: string) => {
      if (options.unknown) throw new Error("Agent was not found");
      const state = states.get(id);
      if (!state) throw new Error("Agent identity unavailable");
      if (id === worker && options.active) return { ...state, active: true, status: "running" };
      if (id === worker && options.permissions) return { ...state, permissions: true };
      return state;
    },
    findAnyOpenBranchPr: async () => {
      options.onPrLookup?.(f());
      return options.openPr || options.draftPr ? [{ number: 9, url: "https://github.com/acme/report/pull/9" }] : [];
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const close = async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); };
  const notices: Array<{ agentId: string; messageId: string; text: string }> = [];
  function f() { return { dir, repo, worktree, base, store, engine, adapter, states, artifact, task, completion, notices, close }; }
  return f();
}

test("report_ready releases an opted-in worker into planner acceptance without blocker recovery", async () => {
  const f = fixture({ brief: reportOnlyBrief });
  try {
    const project = f.store.projectFor(f.repo, "acme/report")!;
    f.store.setProjectPlanner({ key: project.key, agentId: formatAgentId('fixture-host', owner), setBy: 'test' });
    const task = f.store.update(f.task.id, { phase: "working", completion: null, runId: "report-ready-run", reason: "Worker is writing the report" });
    f.store.setCredential("report-ready-run", "report-ready-token");
    const result: Completion = { eventId: "report-ready-event", taskId: task.id, runId: "report-ready-run", status: "report_ready",
      summary: "Report delivered", headline: "Report ready", artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest } };
    const accepted = await f.engine.complete(result, "report-ready-token");
    assert.equal(accepted.accepted, true);
    await f.engine.wakeTask(task.id);
    const waiting = f.store.task(task.id);
    assert.equal(waiting.phase, "report_ready");
    assert.equal(waiting.completion?.status, "report_ready");
    assert.deepEqual(waiting.completion?.artifact, result.artifact);
    assert.equal(waiting.resolution.incident, null);
    assert.equal(waiting.resolution.recovery, null);
    assert.deepEqual(f.store.runs(task.id), [], "report delivery creates no reviewer or coordinator run");
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0]?.agentId, owner);
    assert.match(f.notices[0]?.text ?? "", /Use the existing complete owner verb/);
  } finally { await f.close(); }
});

test("report_ready accepts a lead-promoted brief that has no queue_approval", async () => {
  const f = fixture({ brief: leadPromotedReportOnlyBrief });
  try {
    const task = f.store.update(f.task.id, { phase: "working", completion: null, runId: "lead-report-run", reason: "Worker is writing the report" });
    f.store.setCredential("lead-report-run", "lead-report-token");
    const result: Completion = { eventId: "lead-report-event", taskId: task.id, runId: "lead-report-run", status: "report_ready",
      summary: "Report delivered", headline: "Report ready", artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest } };
    const accepted = await f.engine.complete(result, "lead-report-token");
    assert.equal(accepted.accepted, true);
    await f.engine.wakeTask(task.id);
    assert.equal(f.store.task(task.id).phase, "report_ready");
    assert.deepEqual(f.store.task(task.id).completion?.artifact, result.artifact);
  } finally { await f.close(); }
});

test("report_ready releases a report-only revision into planner acceptance", async () => {
  const f = fixture({ brief: reportOnlyBrief });
  try {
    const runId = "report-ready-revision";
    const task = f.store.task(f.task.id);
    f.store.update(task.id, { phase: "changes_requested", completion: null, resolution: { ...task.resolution, currentRunId: runId } });
    f.store.putRun({ id: runId, taskId: task.id, role: "revision", generation: 1, head: f.base, base: f.base,
      agentId: worker, workspaceId: "task-workspace", profile: null, status: "finished", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: new Date().toISOString(), completion: null, released: false });
    f.store.setCredential(runId, "report-ready-revision-token");
    const artifact = { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest };
    const accepted = await f.engine.complete({ eventId: "report-ready-revision-event", taskId: task.id, runId,
      status: "report_ready", summary: "Revised report delivered", artifact }, "report-ready-revision-token");
    assert.equal(accepted.accepted, true);
    await f.engine.wakeTask(task.id);
    const waiting = f.store.task(task.id);
    assert.equal(waiting.phase, "report_ready");
    assert.equal(waiting.completion?.status, "report_ready");
    assert.deepEqual(waiting.completion?.artifact, artifact);
    assert.equal(f.store.run(runId)?.released, true);
  } finally { await f.close(); }
});

test("revision report_ready remains refused without the report-only opt-in", async () => {
  const f = fixture();
  try {
    const runId = "ordinary-revision";
    const task = f.store.task(f.task.id);
    f.store.update(task.id, { phase: "changes_requested", completion: null, resolution: { ...task.resolution, currentRunId: runId } });
    f.store.putRun({ id: runId, taskId: task.id, role: "revision", generation: 1, head: f.base, base: f.base,
      agentId: worker, workspaceId: "task-workspace", profile: null, status: "running", createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
    f.store.setCredential(runId, "ordinary-revision-token");
    await assert.rejects(f.engine.complete({ eventId: "ordinary-revision-event", taskId: task.id, runId,
      status: "report_ready", summary: "Report delivered", artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest } }, "ordinary-revision-token"), /queue\.reportOnly: true/);
    assert.equal(f.store.run(runId)?.completion, null);
  } finally { await f.close(); }
});

test("report_ready is refused for a task without the brief opt-in", async () => {
  const f = fixture();
  try {
    const task = f.store.update(f.task.id, { phase: "working", completion: null, runId: "ordinary-run", reason: "Worker is working" });
    f.store.setCredential("ordinary-run", "ordinary-token");
    const result: Completion = { eventId: "ordinary-report-event", taskId: task.id, runId: "ordinary-run", status: "report_ready",
      summary: "Report delivered", artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest } };
    await assert.rejects(f.engine.complete(result, "ordinary-token"), /queue\.reportOnly: true/);
    assert.equal(f.store.task(task.id).completion, null);
    assert.equal(f.notices.length, 0);
  } finally { await f.close(); }
});

test("planner can return a report-ready task to work without re-parking the old delivery", async () => {
  const f = fixture({ brief: reportOnlyBrief });
  try {
    const profile = { id: "worker-profile", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };
    let task = f.store.update(f.task.id, { phase: "working", completion: null, runId: "return-report-run", profile, reason: "Worker is writing the report" });
    f.store.setCredential("return-report-run", "return-report-token");
    const artifact = { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest };
    await f.engine.complete({ eventId: "return-report-event", taskId: task.id, runId: "return-report-run", status: "report_ready", summary: "Draft delivered", artifact }, "return-report-token");
    await f.engine.wakeTask(task.id);
    task = f.store.task(task.id);
    const returned = await f.engine.moveToWork({ taskId: task.id, version: task.version, caller: owner, reason: "The report needs more evidence", instruction: "Add the missing evidence to the report." });
    assert.equal(returned.phase, "changes_requested");
    assert.equal(returned.completion, null);
    const record = f.store.events(task.id).find(event => event.kind === "report_returned_to_work");
    assert.deepEqual(JSON.parse(record!.detail), { eventId: "return-report-event", summary: "Draft delivered", artifact, instruction: "Add the missing evidence to the report." });
  } finally { await f.close(); }
});






const projectDBrief = "## Outcome\nDeliver the web health export as a report with its recorded caveats.\n";
const completeReason = "The owner accepts this report export and its recorded caveats.";
const completeInput = (f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) => taskControlInputSchema.parse({
  taskId: f.task.id, version: f.store.task(f.task.id).version, action: "complete", caller: owner, reason: completeReason,
  artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest }, ...overrides,
});
const deliverReport = (f: ReturnType<typeof fixture>) => {
  const completion: Completion = { ...f.completion, eventId: "delivered-report-event", status: "report_ready",
    artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest } };
  f.store.db.prepare("INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)")
    .run(completion.eventId, f.task.id, completion.runId, "d".repeat(64), JSON.stringify({ accepted: true }));
  f.store.update(f.task.id, { phase: "report_ready", completion, reason: completion.summary });
};
const observable = (f: ReturnType<typeof fixture>) => ({ version: f.store.task(f.task.id).version, phase: f.store.task(f.task.id).phase,
  events: f.store.events(f.task.id).length, notices: f.store.notices(f.task.id).length, runs: f.store.runs(f.task.id) });

test("complete accepts the task's delivered report after later lane documents advance the lane", async () => {
  const f = fixture({ brief: reportOnlyBrief });
  try {
    deliverReport(f);
    f.store.editLaneDocument({ key: f.artifact.key, version: f.artifact.version, text: "Later report v2", author: owner });
    f.store.editLaneDocument({ key: f.artifact.key, version: f.artifact.version + 1, text: "Later report v3", author: owner });
    const accepted = await f.engine.performTaskControl(completeInput(f));
    assert.equal(accepted.phase, "done");
    assert.deepEqual(accepted.reportAcceptance?.artifact, { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest });
  } finally { await f.close(); }
});

test("complete refuses lane artifacts this task did not deliver and altered digests", async () => {
  for (const variant of ["other-version", "changed-digest"] as const) {
    const f = fixture({ brief: reportOnlyBrief });
    try {
      deliverReport(f);
      const later = f.store.editLaneDocument({ key: f.artifact.key, version: f.artifact.version, text: "Another task's report", author: owner });
      const artifact = variant === "other-version"
        ? { key: later.key, version: later.version, digest: later.digest }
        : { key: f.artifact.key, version: f.artifact.version, digest: `sha256:${"f".repeat(64)}` };
      await assert.rejects(f.engine.performTaskControl(completeInput(f, { artifact })), /exact report delivered by this task/);
    } finally { await f.close(); }
  }
});

test("Project-D#113 shape: complete finishes a report-only brief with no scope headings in one call", async () => {
  const f = fixture({ escalated: true, brief: projectDBrief });
  try {
    deliverReport(f);
    assert.doesNotMatch(f.store.task(f.task.id).briefVersions[0]!.text, /Not in scope|Validation/);
    const version = f.store.task(f.task.id).version;
    const result = await f.engine.performTaskControl(completeInput(f));
    assert.equal(result.phase, "done");
    assert.equal(result.resolution.attention, false);
    assert.equal(result.resolution.incident?.status, "resolved");
    assert.equal(result.resolution.recovery?.status, "resolved");
    assert.equal(result.resolution.recovery?.action?.status, "refused", "the escalated recovery's pending action is recorded as not applied");
    assert.equal(f.store.notices(result.id).find(item => item.id === "report-only-attention")?.status, "superseded");
    assert.deepEqual(result.reportAcceptance, { artifact: { key: f.artifact.key, version: f.artifact.version, digest: f.artifact.digest },
      acceptedBy: owner, reason: completeReason, acceptedAt: result.reportAcceptance!.acceptedAt, taskVersion: version, kind: "owner_completed" });
    const outcome = f.store.outcome(result.id)!;
    assert.equal(outcome.outcome, "done"); assert.equal(outcome.pr, null);
    assert.deepEqual(outcome.reportAcceptance, result.reportAcceptance);
    const controls = f.store.events(result.id).filter(event => event.kind === "owner_control");
    assert.equal(controls.length, 1);
    const detail = JSON.parse(controls[0]!.detail);
    assert.equal(detail.verb, "complete"); assert.equal(detail.caller, owner); assert.equal(detail.reason, completeReason);
    assert.equal(detail.phaseAfter, "done");
    assert.equal(f.store.run("report-only-recovery")?.active, false);
  } finally { await f.close(); }
});

test("complete without an artifact records a plain owner-completed outcome", async () => {
  const f = fixture({ brief: projectDBrief });
  try {
    const version = f.store.task(f.task.id).version;
    const result = await f.engine.performTaskControl(completeInput(f, { artifact: undefined }));
    assert.equal(result.phase, "done");
    assert.deepEqual(result.reportAcceptance, { acceptedBy: owner, reason: completeReason, acceptedAt: result.reportAcceptance!.acceptedAt,
      taskVersion: version, kind: "owner_completed" });
    assert.equal(f.store.outcome(result.id)!.outcome, "done");
    assert.match(f.store.notices(result.id).find(item => item.kind === "completion")!.text, /Owner completed this task with no PR/);
  } finally { await f.close(); }
});

test("complete refuses a live run, an open PR, merge intent and a terminal task without mutating anything", async () => {
  const cases: Array<{ name: string; options?: Parameters<typeof fixture>[0]; prepare?: (f: ReturnType<typeof fixture>) => void; refusal: RegExp }> = [
    { name: "active worker", options: { active: true }, refusal: /is a live run/ },
    { name: "pending permission", options: { permissions: true }, refusal: /is a live run/ },
    { name: "open forge PR", options: { openPr: true }, refusal: /open forge PR/ },
    { name: "recorded PR", prepare: f => f.store.update(f.task.id, { prUrl: "https://github.com/acme/report/pull/9" }), refusal: /has a PR/ },
    { name: "merge intent", prepare: f => { const task = f.store.task(f.task.id);
      f.store.update(task.id, { resolution: { ...task.resolution, mergeIntent: true } }); }, refusal: /merging or merged/ },
    { name: "terminal task", prepare: f => f.store.update(f.task.id, { phase: "cancelled" }), refusal: /is cancelled/ },
  ];
  for (const item of cases) {
    const f = fixture(item.options);
    try {
      item.prepare?.(f);
      const before = observable(f);
      await assert.rejects(f.engine.performTaskControl(completeInput(f, { artifact: undefined })), item.refusal, item.name);
      assert.deepEqual(observable(f), before, `${item.name} refusal changes nothing`);
    } finally { await f.close(); }
  }
});


test("next lists complete when it applies and names the refusal when a PR blocks it", async () => {
  const f = fixture({ brief: projectDBrief });
  try {
    const verbOf = (store: typeof f.store, taskId: string) => ownerTaskNext(collectOwnerVerbFacts(store, store.task(taskId)))
      .verbs.find(verb => verb.verb === "complete")!;
    const open = verbOf(f.store, f.task.id);
    assert.equal(open.available, true);
    assert.deepEqual(open.fill, ["reason"]);
    assert.equal(open.action, "complete");
    f.store.update(f.task.id, { prUrl: "https://github.com/acme/report/pull/9" });
    const withPr = verbOf(f.store, f.task.id);
    assert.equal(withPr.available, false);
    assert.match(withPr.refusal ?? "", /has a PR/);
  } finally { await f.close(); }
});


test("a blocked initial worker settles its reported output without a sweep", async () => {
  const f = fixture();
  try {
    const task = f.store.task(f.task.id);
    f.store.update(task.id, { phase: "working", agentActive: true, resolution: { ...task.resolution,
      buildOutputCleanups: runBuildOutputIntent([], { id: f.completion.runId, workspaceId: "task-workspace", agentId: worker }, f.worktree, new Date().toISOString()) } });
    await f.engine.wakeTask(task.id);
    await f.engine.quiesce();
    assert.equal(f.store.task(task.id).phase, "blocked");
    assert.equal(f.store.task(task.id).resolution.buildOutputCleanups[0]?.state, "complete");
  } finally { await f.close(); }
});

test('overlapping worker result applications preserve a newer run', async () => {
 for (const secondRefused of [false, true]) {
  const f = fixture();
  try {
    const c = { ...f.completion, status: 'ready_for_review' as const, prNumber: 9, head: f.base };
    const before = f.store.update(f.task.id, { phase: 'working', completion: c });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    f.adapter.verifyPr = async () => { const call = ++calls; if (call === 1) await gate;
      if (call === 1 || secondRefused) throw Error('Worker must leave a clean worktree before review');
      return { head: f.base, url: 'https://github.com/acme/report/pull/9' }; };
    const first = f.engine.acceptWorkerResult(before, before);
    await f.engine.acceptWorkerResult(before, before);
    f.store.update(f.task.id, { runId: 'new-worker-run', phase: 'working' });
    release(); await first;
    const current = f.store.task(f.task.id);
    assert.equal(current.runId, 'new-worker-run');
    assert.equal(current.phase, 'working');
    assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'run_result_applied' && event.detail === c.runId).length, 1);
  } finally { await f.close(); }
 }
});

test('a stopped task whose externally merged PR was never bound offers complete', async () => {
  const f = fixture();
  try {
    const before = f.store.task(f.task.id);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: before.id, version: before.version,
      action: 'stop', caller: owner, reason: 'PR 6432 was merged externally; keep the work' }));
    const stopped = f.store.task(f.task.id);
    const complete = ownerTaskNext(collectOwnerVerbFacts(f.store, stopped)).verbs.find(verb => verb.verb === 'complete');
    assert.equal(complete?.available, true, complete?.refusal);
    const done = await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: stopped.id, version: stopped.version,
      action: 'complete', caller: owner, reason: 'PR 6432 was merged externally' }));
    assert.equal(done.phase, 'done');
    assert.match(done.reason, /PR 6432 was merged externally/);
  } finally { await f.close(); }
});
