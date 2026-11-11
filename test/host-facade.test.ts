import { test } from "node:test";
import assert from "node:assert/strict";
import { HostFacade, type HostFacadeMethod } from "../core/host/host-facade";
import type { Adapter } from "../core/host";

/**
 * Step 1 of the Paseo host split (task 871, row 1): the façade delegates the
 * Host contract to whatever adapter its owner holds at call time. These
 * witnesses pin late binding, plain-return delegation, argument and name
 * mapping, capability reads and absence refusals, so a later move cannot
 * capture the adapter, add a turn, or invent a value unobserved.
 */

type Calls = { method: string; args: unknown[] };

/** An adapter that records every call it receives; `withCatalog` and the others control optional presence. */
function fakeAdapter(calls: Calls[], label: string, options: { withCatalog?: boolean; withNotify?: boolean } = {}): Adapter {
  const record = (method: string, args: unknown[]) => calls.push({ method, args: [label, ...args] });
  const adapter: Record<string, unknown> = {
    findWorkspaces: (task: unknown) => { record("findWorkspaces", [task]); return Promise.resolve([{ id: "w1", directory: "/d" }]); },
    observe: (id: string) => { record("observe", [id]); return Promise.resolve({ id, workspaceId: null, status: "idle", active: false, permissions: false, error: "" }); },
    archiveAgent: (id: string) => { record("archiveAgent", [id]); return Promise.resolve(); },
  };
  if (options.withCatalog !== false) adapter.catalog = (opts?: unknown) => { record("catalog", [opts]); return Promise.resolve({ providers: [] }); };
  if (options.withNotify) adapter.notify = (...args: unknown[]) => { record("notify", args); return Promise.resolve(); };
  return adapter as unknown as Adapter;
}

/** The façade method names the class must carry, kept in step with `HostFacadeMethod` by the type check. */
const FACADE_METHODS: HostFacadeMethod[] = [
  "catalog", "profiles", "capabilities",
  "findWorkspaces", "workspaceAvailable", "workspaceCatalog", "workspaceArchived",
  "originAgent", "observe", "observationInventory", "listLiveAgents",
  "agentTimelinePage", "agentTimeline", "stopAgentTurn", "archiveAgent", "subscribeRunUsage",
  "sendMessage", "enqueueMessage", "interruptAndContinue",
  "pendingQuestions", "answeredQuestions", "answerNativeQuestion", "dismissNativeQuestion",
];

test("the façade reads the owner's adapter at each call, so a later swap or override is the one called", async () => {
  const calls: Calls[] = [];
  const owner = { adapter: fakeAdapter(calls, "first") };
  const host = new HostFacade(owner);

  await host.observe("a1");
  owner.adapter = fakeAdapter(calls, "second");
  await host.observe("a2");

  // An override placed on the instance after construction is seen too.
  const overridden = owner.adapter as unknown as Record<string, unknown>;
  overridden.archiveAgent = async (id: string) => { calls.push({ method: "archiveAgent", args: ["override", id] }); };
  await host.archiveAgent("a3");

  assert.deepEqual(calls, [
    { method: "observe", args: ["first", "a1"] },
    { method: "observe", args: ["second", "a2"] },
    { method: "archiveAgent", args: ["override", "a3"] },
  ]);
});

test("each delegate forwards its arguments and returns the adapter's own promise, with no added turn", async () => {
  const task = { id: "t1" } as never;
  const workspaces = Promise.resolve([{ id: "w1", directory: "/d" }]);
  const observation = Promise.resolve({ id: "a1", workspaceId: null, status: "idle", active: false, permissions: false, error: "" });
  const archived = Promise.resolve();
  const seen: unknown[][] = [];
  const adapter = {
    findWorkspaces: (...args: unknown[]) => { seen.push(["findWorkspaces", ...args]); return workspaces; },
    observe: (...args: unknown[]) => { seen.push(["observe", ...args]); return observation; },
    archiveAgent: (...args: unknown[]) => { seen.push(["archiveAgent", ...args]); return archived; },
  } as unknown as Adapter;
  const host = new HostFacade({ adapter });

  assert.equal(host.findWorkspaces(task), workspaces);
  assert.equal(host.observe("a1"), observation);
  assert.equal(host.archiveAgent("a1"), archived);
  assert.deepEqual(seen, [["findWorkspaces", task], ["observe", "a1"], ["archiveAgent", "a1"]]);

  // The adapter is entered before the façade returns: no await sits in front of the call.
  seen.length = 0;
  void host.observe("sync");
  assert.deepEqual(seen, [["observe", "sync"]]);
});

test("catalog forwards its options untouched, and omits them when the caller gives none", async () => {
  const calls: Calls[] = [];
  const host = new HostFacade({ adapter: fakeAdapter(calls, "c") });

  await host.catalog({ cwd: "/project" });
  await host.catalog();

  assert.deepEqual(calls, [
    { method: "catalog", args: ["c", { cwd: "/project" }] },
    { method: "catalog", args: ["c", undefined] },
  ]);
});

test("an adapter without a catalog refuses the read as a rejection, never an empty catalog", async () => {
  const host = new HostFacade({ adapter: fakeAdapter([], "bare", { withCatalog: false }) });

  const pending = host.catalog();
  assert.ok(pending instanceof Promise, "catalog returns a promise rather than throwing");
  await assert.rejects(pending, { message: "This host does not report a catalog" });
});

test("names map to the adapter's own methods: workspace archive state and the workspace catalog", async () => {
  const calls: Calls[] = [];
  const adapter = fakeAdapter(calls, "n") as unknown as Record<string, unknown>;
  adapter.taskWorkspaceArchived = async (id: string) => { calls.push({ method: "taskWorkspaceArchived", args: ["n", id] }); return true; };
  adapter.externalWorkspaceCatalog = async (directory: string) => { calls.push({ method: "externalWorkspaceCatalog", args: ["n", directory] }); return { ok: false, reason: "walk incomplete" }; };
  const host = new HostFacade({ adapter: adapter as unknown as Adapter });

  assert.equal(await host.workspaceArchived("w9"), true);
  assert.deepEqual(await host.workspaceCatalog("/folder"), { ok: false, reason: "walk incomplete" });
  assert.deepEqual(calls, [
    { method: "taskWorkspaceArchived", args: ["n", "w9"] },
    { method: "externalWorkspaceCatalog", args: ["n", "/folder"] },
  ]);
});

test("sendMessage carries the exact text, the stable message ID and the optional source agent to notify", async () => {
  const calls: Calls[] = [];
  const host = new HostFacade({ adapter: fakeAdapter(calls, "m", { withNotify: true }) });

  await host.sendMessage("a1", { messageId: "msg-1", text: "exact\ntext", sourceAgentId: "planner" });
  await host.sendMessage("a2", { messageId: "msg-2", text: "plain" });

  assert.deepEqual(calls, [
    { method: "notify", args: ["m", "a1", "msg-1", "exact\ntext", "planner"] },
    { method: "notify", args: ["m", "a2", "msg-2", "plain", undefined] },
  ]);
});

test("capabilities reads the adapter's flags synchronously, and an unreported flag stays false", () => {
  const reporting = { reportingViaMcp: true, supportsCoordinatorRecovery: true } as unknown as Adapter;
  const silent = {} as unknown as Adapter;
  const owner = { adapter: reporting };
  const host = new HostFacade(owner);

  assert.deepEqual(host.capabilities(), { reportingViaMcp: true, supportsCoordinatorRecovery: true });
  owner.adapter = silent;
  assert.deepEqual(host.capabilities(), { reportingViaMcp: false, supportsCoordinatorRecovery: false });
});

test("an optional adapter method that is absent refuses by rejection with the named capability, and never invents a value", async () => {
  const host = new HostFacade({ adapter: {} as unknown as Adapter });

  const pending = host.pendingQuestions("a1");
  assert.ok(pending instanceof Promise, "absence returns a rejected promise rather than throwing");
  await assert.rejects(pending, { message: "This host cannot read native questions" });
  await assert.rejects(host.answerNativeQuestion("a1", "w1", "r1", {}), { message: "This host cannot answer native questions" });
  await assert.rejects(host.dismissNativeQuestion("a1", "w1", "r1"), { message: "This host cannot dismiss native questions" });
  await assert.rejects(host.sendMessage("a1", { messageId: "m", text: "t" }), { message: "This host cannot send messages" });
  await assert.rejects(host.enqueueMessage("a1", { messageId: "m", text: "t" }), { message: "This host cannot queue a message behind the current step" });
});

test("a presence-checked method is read once per call, as the adapter's own call reads it", async () => {
  const reads: string[] = [];
  const adapter = {} as Record<string, unknown>;
  Object.defineProperty(adapter, "originAgent", { configurable: true, get() { reads.push("originAgent"); return (id: string) => Promise.resolve({ id, workspaceId: null, title: "t", archived: false }); } });
  const host = new HostFacade({ adapter: adapter as unknown as Adapter });

  await host.originAgent("a1");
  assert.deepEqual(reads, ["originAgent"]);
});

test("the usage stream is present exactly when the adapter has one, and reads the adapter at each call", async () => {
  const calls: Calls[] = [];
  const owner = { adapter: {} as unknown as Adapter };
  const host = new HostFacade(owner);
  assert.equal(host.subscribeRunUsage, undefined, "an adapter without a stream presents no stream, so the caller's presence check still reads false");

  const streamed = fakeAdapter(calls, "u") as unknown as Record<string, unknown>;
  streamed.subscribeRunUsage = (id: string, handler: unknown) => { calls.push({ method: "subscribeRunUsage", args: ["u", id, handler] }); return Promise.resolve(() => undefined); };
  owner.adapter = streamed as unknown as Adapter;

  const handler = () => undefined;
  const subscribe = host.subscribeRunUsage!;
  const pending = subscribe("a1", handler);
  assert.ok(pending instanceof Promise, "the delegate returns the adapter's own promise");
  await pending;
  assert.deepEqual(calls, [{ method: "subscribeRunUsage", args: ["u", "a1", handler] }]);
});

test("the class carries exactly the façade's declared method set", () => {
  const carried = Object.getOwnPropertyNames(HostFacade.prototype).filter(name => name !== "constructor").sort();
  assert.deepEqual(carried, [...FACADE_METHODS].sort());
});
