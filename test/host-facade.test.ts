import { formatAgentId } from '../shared/agent-identity';
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
  "pendingQuestions", "answeredQuestions", "answerNativeQuestion", "answerNativePermission", "dismissNativeQuestion",
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
  const explicit = { reportingViaMcp: false, supportsCoordinatorRecovery: false, nativeDecisions: false, uiContributions: false, lifecycleDispatch: false };
  owner.adapter = { capabilities: () => explicit } as Adapter;
  assert.equal(host.capabilities(), explicit);
});

test("an optional adapter method that is absent refuses by rejection with the named capability, and never invents a value", async () => {
  const host = new HostFacade({ adapter: {} as unknown as Adapter });

  const pending = host.pendingQuestions("a1");
  assert.ok(pending instanceof Promise, "absence returns a rejected promise rather than throwing");
  await assert.rejects(pending, { message: "This host cannot read native questions" });
  await assert.rejects(host.answerNativeQuestion("a1", "w1", "r1", {}), { message: "This host cannot answer native questions" });
  await assert.rejects(host.answerNativePermission('a1', 'w1', 'r1', 'accept', 'intent'), { message: 'This host cannot answer native permissions' });
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


test('qualified callers reach only their recorded host and host APIs receive native IDs', async () => {
  const calls: Calls[] = [];
  const adapter = fakeAdapter(calls, 'selected', { withNotify: true }) as unknown as Record<string, unknown>;
  adapter.originAgent = async (id: string) => { calls.push({ method: 'originAgent', args: ['selected', id] }); return { id, workspaceId: 'workspace', title: 'planner', archived: false }; };
  adapter.pendingQuestions = async (id: string) => { calls.push({ method: 'pendingQuestions', args: ['selected', id] }); return []; };
  const owner = { adapter: adapter as unknown as Adapter, activeHostId: 't3code:one' };
  const host = new HostFacade(owner);
  const qualified = formatAgentId('t3code:one', 'planner');
  await host.originAgent(qualified);
  await host.observe(qualified);
  await host.sendMessage(qualified, { messageId: 'message', text: 'Hello', sourceAgentId: qualified });
  await host.pendingQuestions(qualified);
  await host.archiveAgent(qualified);
  assert.deepEqual(calls, [
    { method: 'originAgent', args: ['selected', 'planner'] },
    { method: 'observe', args: ['selected', 'planner'] },
    { method: 'notify', args: ['selected', 'planner', 'message', 'Hello', 'planner'] },
    { method: 'pendingQuestions', args: ['selected', 'planner'] },
    { method: 'archiveAgent', args: ['selected', 'planner'] },
  ]);
  assert.throws(() => host.observe(formatAgentId('t3code:other', 'planner')), /belongs to host t3code:other.*unknown or offline/);
  assert.throws(() => host.originAgent(formatAgentId('t3code:other', 'planner')), /belongs to host t3code:other.*unknown or offline/);
  assert.throws(() => host.sendMessage(formatAgentId('t3code:other', 'planner'), { messageId: 'wrong-host', text: 'No send' }), /belongs to host t3code:other.*unknown or offline/);
  assert.equal(calls.length, 5, 'a mismatched host receives no call');
});

test('a qualified identity for another registered host is routed to that host, never unwrapped against the bound one', async () => {
  const calls: Calls[] = [];
  const bound = fakeAdapter(calls, 'bound') as unknown as Record<string, unknown>;
  bound.observe = async (id: string) => { calls.push({ method: 'observe', args: ['bound', id] }); return { id, workspaceId: 'bound-ws', status: 'idle', active: false, permissions: false, error: '' }; };
  bound.notify = async (...args: unknown[]) => { calls.push({ method: 'notify', args: ['bound', ...args] }); return Promise.resolve(); };
  const foreign = fakeAdapter(calls, 'foreign') as unknown as Record<string, unknown>;
  foreign.observe = async (id: string) => { calls.push({ method: 'observe', args: ['foreign', id] }); return { id, workspaceId: 'foreign-ws', status: 'idle', active: false, permissions: false, error: '' }; };
  foreign.notify = async (...args: unknown[]) => { calls.push({ method: 'notify', args: ['foreign', ...args] }); return Promise.resolve(); };
  const adapters: Record<string, Adapter> = { 'paseo:one': bound as unknown as Adapter, 't3code:two': foreign as unknown as Adapter };
  let boundHostId: string | undefined = 'paseo:one';
  const host = new HostFacade({
    get adapter() { return adapters[boundHostId!]!; },
    get activeHostId() { return boundHostId; },
    withHost: (id, fn) => { const previous = boundHostId; boundHostId = id; try { return fn(); } finally { boundHostId = previous; } },
    hostOnline: id => id in adapters,
  });

  // A T3 identity read from inside Paseo context is served by the T3 adapter, unwrapped for it.
  const observed = await host.observe(formatAgentId('t3code:two', 'planner'));
  assert.equal(observed.workspaceId, 'foreign-ws');
  assert.deepEqual(calls, [{ method: 'observe', args: ['foreign', 'planner'] }]);

  // A routed send drops a source from yet another host instead of failing the send.
  await host.sendMessage(formatAgentId('t3code:two', 'planner'), { messageId: 'm', text: 'Hello', sourceAgentId: formatAgentId('paseo:one', 'worker') });
  assert.deepEqual(calls.at(-1), { method: 'notify', args: ['foreign', 'planner', 'm', 'Hello', undefined] });

  // A source on the routed host is unwrapped for it.
  await host.sendMessage(formatAgentId('t3code:two', 'planner'), { messageId: 'm2', text: 'Hello', sourceAgentId: formatAgentId('t3code:two', 'worker') });
  assert.deepEqual(calls.at(-1), { method: 'notify', args: ['foreign', 'planner', 'm2', 'Hello', 'worker'] });

  // An unregistered host refuses, named.
  assert.throws(() => host.observe(formatAgentId('t3code:gone', 'planner')), /belongs to host t3code:gone.*unknown or offline/);
  assert.equal(calls.filter(call => call.method === 'observe').length, 1, 'the unknown host received no call');
});
