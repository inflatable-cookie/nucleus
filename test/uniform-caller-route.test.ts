/**
 * nucleus#1317: one caller-resolution order and one tell route for every host
 * and thread kind. Each papercut is a real shape, not a mock of the symptom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_SLOW_RETRY, resolveHostCallerIdentity } from "../core/dispatch/caller-resolution";
import { runTicketPath } from "../core/dispatch/agent-creation";
import { taskPlannerTicketKey } from "../core/dispatch/participant-tickets";
import { Engine } from "../core/engine";
import { HostUnknownDeliveryError } from "../core/host/errors";
import { qaSettlementHostMessageId, qaSettlementNoticeId } from "../core/qa/project-qa-notice";
import { projectQaSettlement } from "../core/qa/project-qa-settle";
import { Store } from "../core/store/store";
import { projectEndpointId } from "../core/questions/agent-messages";
import { wireEngineHosts } from "../service/host-connections";
import { formatAgentId } from "../shared/agent-identity";
import { projectQaRunSchema, submissionSchema, type Run } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { projectAgentsFixture } from "./support/project-agents-fixture";

const ticketOf = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { participantId: string; token: string };

function qaRun(store: Store, extra: Record<string, unknown> = {}) {
  return store.putQaRun(projectQaRunSchema.parse({
    id: "qa-settled-1", key: "owner/repo",
    repository: { origin: "owner/repo", path: "/repo" },
    state: "passed", baseBranch: "main", base: "a".repeat(40), argv: ["effigy", "qa"],
    digest: "b".repeat(64), capacityWait: null, capacityUnavailable: false,
    exitCode: 0, durationMs: 1, outputTail: "passed",
    startedAt: "2026-11-17T00:00:00.000Z", submittedAt: "2026-11-17T00:00:00.000Z",
    finishedAt: "2026-11-17T00:00:01.000Z", pid: null, submitterAgentId: "planner-agent",
    ...extra,
  }));
}

test("a retained thread with a stale environment resolves its current run (d8158bc3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retained-stale-env-"));
  const helperPath = join(dir, "helper.mjs");
  const runId = "run-retained";
  mkdirSync(join(dir, "tickets"), { recursive: true });
  const ticketPath = runTicketPath({ helperPath }, runId);
  writeFileSync(ticketPath, JSON.stringify({ socketPath: join(dir, "c"), taskId: "task", runId, token: "t" }));
  const caller = formatAgentId("paseo-primary", "retained-thread");
  const identity = await resolveHostCallerIdentity({
    onlineIds: () => ["paseo-primary"],
    observe: async () => ({ id: "retained-thread", status: "idle" }),
    unreleasedRuns: () => [{ id: runId, agentId: caller, hostId: "paseo-primary", released: false } as Run],
    helperPath,
  }, { hostKind: "paseo", nativeAgentId: "retained-thread" });
  assert.equal(identity.caller, caller);
  assert.equal(identity.runTicket, ticketPath);
  assert.equal(identity.source, "host");
});

test("a slow host observe answers The host is slow; retry instead of hanging (d38b1d28)", async () => {
  await assert.rejects(
    () => resolveHostCallerIdentity({
      onlineIds: () => ["paseo-primary"],
      observe: async () => { throw new Error("Agent observation timed out"); },
    }, { hostKind: "paseo", nativeAgentId: "plain-thread" }),
    error => error instanceof Error && error.message === HOST_SLOW_RETRY,
  );
});

test("a task-planner ticket tells another project's planner (6109e3d3)", async () => {
  const host = "t3code:synthetic";
  const f = projectAgentsFixture({ hostId: host });
  f.live("task-planner");
  f.live("other-planner");
  try {
    f.store.setMeta("hostId", host);
    f.store.upsertProject({ key: "other", name: "Other", repositories: [{ origin: "synthetic/other", path: "/synthetic/other" }] });
    f.store.setProjectPlanner({ key: "other", agentId: formatAgentId(host, "other-planner"), setBy: "operator" });
    f.store.insert(submissionSchema.parse({
      submissionId: "cross-project-tell", title: "Scoped task",
      repoPath: "/synthetic/example", planningCommit: "a".repeat(40), handoffPath: "handoff.md",
      originAgentId: formatAgentId(host, "task-planner"),
    }), host, "handoff", "a".repeat(40));
    await f.tickets.ensureFor(formatAgentId(host, "task-planner"), host);
    const record = f.store.getMeta<{ path: string }>(taskPlannerTicketKey(host, "task-planner"));
    assert.ok(record, "the thread that plans a live task holds its ticket");
    const planner = ticketOf(record.path);
    const receipt = await f.engine.resolution.agentMessage({
      eventId: "a".repeat(64), participantId: planner.participantId,
      to: { project: "other" }, text: "Cross-project note from the task planner.",
    }, planner.token);
    assert.ok(receipt.status === "delivered" || receipt.status === "queued", receipt.status);
    const message = f.store.messages(projectEndpointId("other"))[0]!;
    assert.equal(message.fromRole, "planner");
    assert.equal(message.fromReference, "the task planner");
    assert.equal(message.toProjectKey, "other");
    assert.match(message.fromTaskId, /^task-planner:/);
  } finally { f.store.close(); }
});

test("a plain Paseo thread tells a project planner without a ticket (d38b1d28)", async () => {
  const host = "paseo-synthetic";
  const f = projectAgentsFixture({ hostId: host });
  f.live("plain-thread");
  f.live("planner");
  try {
    f.store.setMeta("hostId", host);
    f.store.setProjectPlanner({ key: "example", agentId: formatAgentId(host, "planner"), setBy: "operator" });
    const caller = formatAgentId(host, "plain-thread");
    const receipt = await f.engine.resolution.hostAgentMessage(
      { caller, hostId: host },
      { eventId: "c".repeat(64), to: { project: "example" }, text: "From a host thread." },
    );
    assert.ok(receipt.status === "delivered" || receipt.status === "queued", receipt.status);
    const message = f.store.messages(projectEndpointId("example"))[0]!;
    assert.equal(message.fromAgentId, caller);
    assert.equal(message.fromReference, caller);
    assert.equal(message.fromRole, "agent");
    assert.equal(message.toProjectKey, "example");
  } finally { f.store.close(); }
});

test("an omitted host defaults to the sole online host of the kind (78c18e51)", () => {
  const store = new Store(":memory:");
  try {
    const engine = {} as Engine;
    wireEngineHosts(engine, {
      adapter: {} as Adapter,
      hostRegistry: {
        known: () => [{ id: "t3code:env" }],
        onlineIds: () => ["t3code:env"],
      } as never,
      hostSession: null,
      connected: () => true,
      store,
    });
    assert.deepEqual(engine.selectIngressSelection(undefined, "/unconfigured"), {
      hostId: "t3code:env", basis: "sole_online_host",
    });
    assert.equal(engine.selectIngressHost(undefined, "/unconfigured"), "t3code:env");
  } finally { store.close(); }
});

test("a QA settlement notice whose host is unavailable is redelivered once the host answers (f749011c)", async () => {
  const store = new Store(":memory:");
  const delivered: Array<{ agentId: string; messageId: string; text: string }> = [];
  try {
    const saved = qaRun(store);
    await projectQaSettlement.notifySettled.call({
      store, options: {
        notify: async () => { throw new Error("QA notification host is unavailable"); },
      },
    }, saved);
    const pending = store.notices(`qa:${saved.id}`).find(notice => notice.id === qaSettlementNoticeId(saved.id, "planner-agent"));
    assert.ok(pending);
    assert.equal(pending.status, "pending");
    assert.match(pending.error, /QA notification host is unavailable/);

    store.setMeta("paused", false);
    store.setMeta("hostId", "host");
    const adapter = {
      hostId: "host",
      observe: async (id: string) => ({ id, status: "idle", active: false, permissions: false, error: "", updatedAt: "2026-11-17T00:00:00.000Z" }),
      notify: async (agentId: string, messageId: string, text: string) => { delivered.push({ agentId, messageId, text }); },
      profiles: async () => [],
    } as unknown as Adapter;
    const engine = new Engine(store, adapter, 0);
    engine.identifyOriginHost = async () => "host";
    engine.hostAvailable = () => true;
    try {
      await engine.resolution.deliverDrainNotices();
    } finally { await engine.stop(); }
    const after = store.notices(`qa:${saved.id}`)[0]!;
    assert.equal(delivered.length, 1, `${after.status}: ${after.error}`);
    assert.equal(delivered[0]!.agentId, "planner-agent");
    assert.equal(delivered[0]!.messageId, qaSettlementHostMessageId(saved.id, "planner-agent"));
    assert.equal(after.status, "delivered");
  } finally { store.close(); }
});

test("a QA settlement notice with typed unknown delivery stays uncertain and is never resent", async () => {
  const store = new Store(":memory:");
  try {
    const saved = qaRun(store, { id: "qa-unknown-1" });
    await projectQaSettlement.notifySettled.call({
      store, options: {
        notify: async () => { throw new HostUnknownDeliveryError({ reason: "host_call_past_deadline" }); },
      },
    }, saved);
    const notice = store.notices(`qa:${saved.id}`)[0]!;
    assert.equal(notice.status, "uncertain");
    store.setMeta("paused", false);
    store.setMeta("hostId", "host");
    const adapter = {
      observe: async (id: string) => ({ id, status: "idle", active: false, permissions: false, error: "" }),
      notify: async () => { throw new Error("must not resend"); },
      profiles: async () => [],
    } as unknown as Adapter;
    const engine = new Engine(store, adapter, 0);
    try {
      await engine.resolution.deliverDrainNotices();
    } finally { await engine.stop(); }
    assert.equal(store.notices(`qa:${saved.id}`)[0]!.status, "uncertain");
  } finally { store.close(); }
});
