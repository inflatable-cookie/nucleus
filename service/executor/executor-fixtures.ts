/** Test fixtures are loaded only for an explicitly configured executor fixture or debug channel. */
import type { Profile, Task } from "../../shared/contracts";
import type { Adapter } from "../../core/host/adapter";
import type { Store } from "../../core/store/store";
import type { QueueRuntime } from "../runtime-owner";
import { ordinaryReviewSource } from "../../core/review/ordinary-review";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export interface FixtureState {
  stalled?: boolean;
  slowDbMs?: number;
  projectionFault?: boolean | "clone";
  projectionDelayMs?: number;
  /** The fixture host connection is down: the runtime sees a host that left. */
  hostOffline?: boolean;
}

const fixtureProfile: Profile = { id: "worker", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };
// The store keeps the profile's stored fields; availability is routed from the catalog on refresh.
const { available: _available, problem: _problem, supportedThinking: _supportedThinking, ...storedFixtureProfile } = fixtureProfile;

function fakeAdapter(state: FixtureState, context: { dataDir: string }): Adapter {
  // The client reads the fixture state at each call, so a test can make the host
  // leave and watch the runtime's own connection observation react.
  const client = { get isConnected() { return state.hostOffline !== true; } };
  return {
    client,
    hostId: "fixture-host",
    socketPath: `${context.dataDir}/callback.sock`,
    helperPath: `${context.dataDir}/worker-helper.mjs`,
    connect: async () => { if (state.hostOffline) throw new Error("the fixture host is offline"); },
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    observe: async () => ({ id: "worker", workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" }),
  } as unknown as Adapter;
}

/** Fixture adapter matching the incremental-reconciliation service fixtures. */
function richAdapter(context: { dataDir: string }): Adapter {
  return {
    client: { isConnected: true },
    hostId: "fixture-host",
    socketPath: `${context.dataDir}/callback.sock`,
    helperPath: `${context.dataDir}/worker-helper.mjs`,
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [{ key: "test", label: "test", available: true, problem: "", models: [{ id: "test", label: "test", aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] }] }),
    validate: async () => "b".repeat(40),
    verifyWorkspace: async () => "ns-branch",
    createWorkspace: async () => ({ id: "ws", directory: "/tmp/ws" }),
    findWorkspaces: async () => [],
    createAgent: async () => ({ id: "agent", workspaceId: "ws" }),
    findAgents: async () => [],
    archiveAgent: async () => {},
    verifyPr: async () => ({ url: "https://example/pull/1", head: "a".repeat(40) }),
    observe: async (id: string) => ({ id, workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" }),
  } as unknown as Adapter;
}

/**
 * Named fixtures used by tests. The stalled adapter holds a genuine
 * five-second observation while unrelated work continues; the slow-database
 * fixture holds a genuine five-second transaction inside the executor so the
 * responsiveness oracle can prove the request loop stays free.
 */
export const FIXTURES: Record<string, {
  adapter?: (state: FixtureState, context: { dataDir: string }) => Adapter;
  instrumentStore?: (state: FixtureState, store: Store) => void;
  bootCrash?: boolean;
}> = {
  fake: { adapter: fakeAdapter },
  // Profiles come from the Queue store; the host catalog only says whether they route.
  rich: { adapter: (_state, context) => richAdapter(context), instrumentStore: (_state, store) => store.setProfiles([storedFixtureProfile]) },
  stall: {
    adapter: (state, context) => {
      const adapter = richAdapter(context);
      return { ...adapter, observe: async (id: string): Promise<unknown> => {
        if (state.stalled) await sleep(5_000);
        return { id, workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" };
      } } as unknown as Adapter;
    },
    instrumentStore: (_state, store) => store.setProfiles([storedFixtureProfile]),
  },
  // Boot dies on a worker-thread exception before the first snapshot, the way an
  // unhandled fault in the executor would.
  "boot-crash": {
    adapter: fakeAdapter,
    bootCrash: true,
  },
  "slow-db": {
    adapter: fakeAdapter,
    instrumentStore: (state, store) => {
      const original = store.transaction;
      store.transaction = function <T>(fn: () => T): T {
        if (state.slowDbMs && state.slowDbMs > 0) {
          // Block this worker thread only; the service request loop stays free.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.slowDbMs);
        }
        return (original as (fn: () => T) => T).call(store, fn);
      };
    },
  },
};

/** Bounded fixture-only debug surface: store methods plus runtime wake/bootstrap. */
export async function handleDebug(runtime: QueueRuntime, op: unknown, state: FixtureState): Promise<unknown> {
  const request = op as { target: "store" | "runtime" | "engine" | "fixture"; method?: string; args?: unknown[]; action?: string; value?: unknown };
  if (request.target === "fixture") {
    if (request.action === "set-stall") { state.stalled = Boolean(request.value); return { ok: true }; }
    if (request.action === "set-host-offline") { state.hostOffline = Boolean(request.value); return { ok: true }; }
    if (request.action === "set-slow-db") { state.slowDbMs = Number(request.value) || 0; return { ok: true }; }
    if (request.action === "ordinary-review-source") {
      const value = request.value as { task: Task; head: string; detached?: boolean };
      await ordinaryReviewSource(value.task, value.head, Boolean(value.detached));
      return { ok: true };
    }
    // "clone" makes every publication fail at postMessage (a non-cloneable member), not before it.
    if (request.action === "set-projection-fault") { state.projectionFault = request.value === "clone" ? "clone" : Boolean(request.value); return { ok: true }; }
    if (request.action === "crash") {
      // The reply never settles: the crash lands while this request is pending.
      const crash = String(request.value);
      setTimeout(() => {
        if (crash === "error") throw new Error("Fixture executor fault");
        process.exit(crash === "exit-zero" ? 0 : 3);
      }, 50);
      return new Promise(() => {});
    }
    throw new Error(`Unknown fixture action ${JSON.stringify(request.action)}`);
  }
  if (request.target === "store") {
    const store = runtime.store as unknown as Record<string, (...args: unknown[]) => unknown>;
    const method = store[request.method!];
    if (typeof method !== "function") throw new Error(`Store has no method ${request.method}`);
    return method.apply(runtime.store, request.args ?? []);
  }
  if (request.target === "runtime") {
    const method = (runtime as unknown as Record<string, unknown>)[request.method!];
    if (typeof method !== "function") throw new Error(`Runtime has no method ${request.method}`);
    return (method as () => unknown).apply(runtime);
  }
  if (request.target === "engine") {
    const engine = (runtime as unknown as Record<string, unknown>).engine as Record<string, unknown> | undefined;
    const method = engine?.[request.method!];
    if (typeof method !== "function") throw new Error(`Engine has no method ${request.method}`);
    return (method as () => unknown).call(engine);
  }
  throw new Error(`Unknown debug target ${JSON.stringify(request.target)}`);
}
