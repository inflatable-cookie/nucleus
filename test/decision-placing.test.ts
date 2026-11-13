import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Decisions } from "../core/planning/decisions";
import { formatAgentId } from "../shared/agent-identity";
import { projectSchema, submissionSchema, type Run } from "../shared/contracts";

const commit = "a".repeat(40);

/**
 * Task 1183: every board decision is tied to a project and names who asked.
 * Nucleus derives the project and task from the authenticated caller, never
 * only from a typed field. Real store, run and project shapes throughout: no
 * fixture bypasses the derivation the service runs.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ns-decision-placing-"));
  const store = new Store(join(dir, "queue.sqlite"));
  return {
    dir, store, decisions: new Decisions(store),
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function addTask(f: ReturnType<typeof setup>, origin: string, repoPath: string, title = "Swallowtail work") {
  return f.store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title, repoPath, planningCommit: commit,
    handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "brief", commit, {}, undefined, origin);
}

function runRow(id: string, taskId: string, role: Run["role"], agentId: string): Run {
  return {
    id, taskId, role, generation: 1, head: commit, base: commit, agentId,
    workspaceId: `ws-${id}`, profile: null, status: "running",
    createdAt: new Date().toISOString(), lastObservedAt: null, active: true,
    idleSince: null, completion: null, released: false,
  } as unknown as Run;
}

test("1183 a T3 worker and a Paseo worker each add a decision without a project, and both get the task's project and a task link", () => {
  const f = setup(); try {
    const repo = { origin: "owner/swallowtail", path: join(f.dir, "swallowtail") };
    const t3Caller = formatAgentId("t3code:alpha", "nucleus-thread-f2d0");
    const paseoCaller = formatAgentId("paseo:beta", "worker-paseo");
    const t3Task = addTask(f, repo.origin, repo.path, "T3 work");
    const paseoTask = addTask(f, repo.origin, repo.path, "Paseo work");
    f.store.update(t3Task.id, { phase: "working", runId: "run-t3", agentId: t3Caller, workspaceId: "ws-t3" });
    f.store.putRun(runRow("run-t3", t3Task.id, "revision", t3Caller));
    f.store.update(paseoTask.id, { phase: "working", runId: "run-p", agentId: paseoCaller, workspaceId: "ws-p" });
    f.store.putRun(runRow("run-p", paseoTask.id, "revision", paseoCaller));
    const project = f.store.projectFor(repo.path, repo.origin)!;
    assert.ok(project, "the task repository has a Queue project");

    const t3 = f.decisions.add({ question: "The T3 build needs a ruling; which branch?", askedBy: t3Caller });
    assert.deepEqual(t3.askedBy.project, { origin: repo.origin, path: repo.path });
    assert.equal(t3.projectKey, project.key);
    assert.deepEqual(t3.links.tasks, [t3Task.id], "the caller's task links automatically");
    assert.equal(t3.askerLabel, `${f.store.task(t3Task.id).reference} worker`);

    const paseo = f.decisions.add({ question: "The Paseo build needs a ruling; which branch?", askedBy: paseoCaller });
    assert.deepEqual(paseo.askedBy.project, { origin: repo.origin, path: repo.path });
    assert.equal(paseo.projectKey, project.key);
    assert.deepEqual(paseo.links.tasks, [paseoTask.id]);
    assert.equal(paseo.askerLabel, `${f.store.task(paseoTask.id).reference} worker`);
  } finally { f.close(); }
});

test("1183 a caller with no resolvable identity and no project or task is refused with a message naming what to pass", () => {
  const f = setup(); try {
    addTask(f, "owner/swallowtail", join(f.dir, "swallowtail"));
    assert.throws(() => f.decisions.add({
      question: "Which branch?", askedBy: formatAgentId("t3code:ghost", "ghost-thread"),
    }), /could not place this decision.*`project`.*`tasks`/);
    assert.throws(() => f.decisions.add({ question: "Which branch?", askedBy: "stranger" }),
      /could not place this decision.*`project`.*`tasks`/);
    assert.throws(() => f.decisions.add({
      question: "Which branch?", askedBy: formatAgentId("t3code:ghost", "ghost-thread"), tasks: ["missing-task"],
    }), /could not place this decision/);
  } finally { f.close(); }
});

test("1183 the board view shows project, task reference and role for a run-ticket asker", () => {
  const f = setup(); try {
    const repo = { origin: "owner/swallowtail", path: join(f.dir, "swallowtail") };
    const task = addTask(f, repo.origin, repo.path);
    const reference = f.store.task(task.id).reference!;
    assert.ok(reference);
    const reviewer = formatAgentId("paseo:beta", "reviewer-1");
    const executor = formatAgentId("t3code:alpha", "executor-1");
    const coordinator = formatAgentId("paseo:beta", "coordinator-1");
    f.store.putRun(runRow("run-reviewer", task.id, "reviewer", reviewer));
    f.store.putRun(runRow("run-executor", task.id, "executor", executor));
    f.store.update(task.id, { coordinatorAgentId: coordinator });
    const project = f.store.projectFor(repo.path, repo.origin)!;

    const reviewAsk = f.decisions.add({ question: "Approve this review?", askedBy: reviewer });
    assert.equal(reviewAsk.projectKey, project.key);
    assert.deepEqual(reviewAsk.links.tasks, [task.id]);
    assert.equal(reviewAsk.askerLabel, `${reference} reviewer`);

    const executeAsk = f.decisions.add({ question: "Run the proof?", askedBy: executor });
    assert.equal(executeAsk.askerLabel, `${reference} executor`);

    const coordinateAsk = f.decisions.add({ question: "Route this task?", askedBy: coordinator });
    assert.equal(coordinateAsk.askerLabel, `${reference} coordinator`);
    assert.deepEqual(coordinateAsk.links.tasks, [task.id]);
  } finally { f.close(); }
});

test("1183 a planner and a named agent place their project, and the operator names the project", () => {
  const f = setup(); try {
    const repo = { origin: "owner/acowtancy", path: join(f.dir, "acowtancy") };
    addTask(f, repo.origin, repo.path);
    const project = f.store.projectFor(repo.path, repo.origin)!;
    const planner = formatAgentId("paseo:beta", "acowtancy-planner");
    f.store.setProjectPlanner({ key: project.key, agentId: planner, setBy: "operator" });

    const planned = f.decisions.add({ question: "Which milestone next?", askedBy: planner });
    assert.equal(planned.projectKey, project.key);
    assert.deepEqual(planned.links.tasks, [], "a planner asks for no task link");
    assert.equal(planned.askerLabel, `${project.name} planner`);

    const supervisor = formatAgentId("paseo:beta", "supervisor-thread");
    const withAgent = projectSchema.parse({ ...f.store.projectByKey(project.key)!,
      agents: [{ name: "supervisor", purpose: "Supervise the project", agentId: supervisor,
        hostId: "paseo:beta", registeredBy: "operator", registeredAt: new Date().toISOString() }] });
    f.store.db.prepare("UPDATE projects SET data=? WHERE key=?").run(JSON.stringify(withAgent), project.key);
    const supervised = f.decisions.add({ question: "Is the queue healthy?", askedBy: supervisor });
    assert.equal(supervised.projectKey, project.key);
    assert.equal(supervised.askerLabel, "supervisor");

    const board = f.decisions.add({ question: "Board ruling?", askedBy: "operator (board)", project: { origin: repo.origin, path: repo.path } });
    assert.equal(board.projectKey, project.key);
    assert.equal(board.askerLabel, "operator");
    assert.throws(() => f.decisions.add({ question: "Board ruling?", askedBy: "operator (board)" }),
      /could not place this decision/);
  } finally { f.close(); }
});

test("1183 an explicit project that contradicts the caller's identity is refused", () => {
  const f = setup(); try {
    const repo = { origin: "owner/swallowtail", path: join(f.dir, "swallowtail") };
    const other = { origin: "owner/other", path: join(f.dir, "other") };
    const task = addTask(f, repo.origin, repo.path);
    addTask(f, other.origin, other.path, "Other work");
    const caller = formatAgentId("paseo:beta", "worker-1");
    f.store.update(task.id, { phase: "working", runId: "run-1", agentId: caller, workspaceId: "ws" });
    assert.throws(() => f.decisions.add({
      question: "Which branch?", askedBy: caller, project: { origin: other.origin, path: other.path },
    }), /contradicts the asking thread/);
    const fine = f.decisions.add({
      question: "Which branch?", askedBy: caller, project: { origin: repo.origin, path: repo.path },
    });
    assert.deepEqual(fine.links.tasks, [task.id]);
  } finally { f.close(); }
});

test("1183 linked tasks place a decision when the caller has no scope, and a split stays unplaceable", () => {
  const f = setup(); try {
    const repo = { origin: "owner/swallowtail", path: join(f.dir, "swallowtail") };
    const other = { origin: "owner/other", path: join(f.dir, "other") };
    const task = addTask(f, repo.origin, repo.path);
    const otherTask = addTask(f, other.origin, other.path, "Other work");
    const viaLinks = f.decisions.add({ question: "Which milestone?", askedBy: "nucleus", tasks: [task.id] });
    assert.equal(viaLinks.projectKey, f.store.projectFor(repo.path, repo.origin)!.key);
    assert.deepEqual(viaLinks.links.tasks, [task.id]);
    assert.throws(() => f.decisions.add({ question: "Which milestone?", askedBy: "nucleus", tasks: [task.id, otherTask.id] }),
      /could not place this decision/);
  } finally { f.close(); }
});

test("1183 the backfill retargets project-less decisions where the asker resolves, and leaves the rest", () => {
  const f = setup(); try {
    const repo = { origin: "owner/swallowtail", path: join(f.dir, "swallowtail") };
    const task = addTask(f, repo.origin, repo.path);
    const thread = "nucleus-thread-f2d0";
    f.store.update(task.id, { phase: "working", runId: "run-1", agentId: thread, workspaceId: "ws" });
    const legacy = (id: string, askedBy: string, links: string[]) => f.store.addDecision({
      id, version: 1, question: "Legacy question?", askedBy: { agentId: askedBy, project: null },
      links: { tasks: links, leads: [], papercuts: [] }, status: "open",
      createdAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z", versions: [],
    });
    legacy("dec-thread", thread, []);
    legacy("dec-links", "gone-thread", [task.id]);
    legacy("dec-lost", "gone-thread", ["missing-task"]);
    legacy("dec-uuid", "28920e17-8a75-416b-a24a-67f556d313cf", []);
    assert.equal(f.decisions.get({ id: "dec-uuid" }).askerLabel, "an earlier thread",
      "a bare machine ID is never the board label");
    const dry = f.decisions.backfillDecisionProjects(true);
    assert.deepEqual(dry, { total: 4, resolved: 2, ambiguous: 0, unresolvable: 2, updated: 0 });
    assert.equal(f.store.decision("dec-thread").askedBy.project, null, "a dry run writes nothing");
    const real = f.decisions.backfillDecisionProjects(false);
    assert.deepEqual(real, { total: 4, resolved: 2, ambiguous: 0, unresolvable: 2, updated: 2 });
    const placed = f.decisions.get({ id: "dec-thread" });
    assert.equal(placed.projectKey, f.store.projectFor(repo.path, repo.origin)!.key);
    assert.equal(placed.askerLabel, `${f.store.task(task.id).reference} worker`);
    assert.equal(f.decisions.get({ id: "dec-lost" }).projectKey, null, "the unresolvable decision is left as is");
  } finally { f.close(); }
});
