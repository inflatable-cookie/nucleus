import { dataHome } from "../../shared/data-home.mjs";
/**
 * Persistence executor worker entry (g01.027 — Spec 013 "Asynchronous
 * persistence").
 *
 * This worker thread is the single owner of `DatabaseSync` inside the
 * standalone Queue service. It builds the same QueueRuntime the legacy
 * in-process backend used, serves catalogue methods over its message port,
 * and publishes health plus the revisioned compact board projection to the
 * service request loop. It never serves socket traffic itself, and no SQLite
 * access ever happens on the request loop.
 *
 * Worker data carries the cloneable runtime options plus an optional named
 * fixture from the lazily loaded test module; fixtures exist only for tests and never
 * run in production.
 */
import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { createQueueRuntime, type QueueRuntime, type RuntimeOwnerOptions } from "../runtime-owner";
import { ZodError } from "zod";
import { formatSchemaRefusal } from "../../shared/schema-refusal";
import { callCatalogueMethod, CapacityWriteRefusalError, MethodNotServedError, SurfaceRefusalError } from "../transport/dispatch";
import type { CatalogueSurface } from "../../shared/web-surface";
import { clearStandbyReady, markStandbyReady } from "../install/standby";
import { waitForStandbyHandoffAsync } from "../install/standby-handoff";
import { RequestKeyConflictError } from "../../core/runtime/request-ledger";
import { hostRunSocketPath, hostRunStateDirForDataDir } from "../callbacks/host-run-endpoint";
import { HostRunFront } from "./host-run-front";
import { publicationBudget } from "../web/publication-budget";
import type { FixtureState } from "./executor-fixtures";

interface ExecutorData {
  owner: RuntimeOwnerOptions;
  fixture?: string;
  fixtureState: Record<string, unknown>;
  debug: boolean;
  standbyFor?: number;
}

type RequestMessage = (
  | { kind: "rpc"; id: number; method: string; input: unknown; via?: CatalogueSurface; key?: string }
  | { kind: "call"; id: number; handler: string; input: unknown }
  | { kind: "drain"; id: number }
  | { kind: "debug"; id: number; op: unknown }) & { sentAt: number };

interface SnapshotMessage {
  kind: "snapshot";
  revision: number;
  health: ReturnType<QueueRuntime["health"]>;
  board?: unknown;
}

const data = workerData as ExecutorData;
const port = parentPort ?? (() => {
  throw new Error("The persistence executor must run as a worker thread");
})();

const state: FixtureState = { ...data.fixtureState };
/**
 * A typed answer replayed from the request ledger, or a key the ledger cannot
 * serve again. It carries its own wire code so the replayed refusal reaches the
 * caller exactly as the lost response carried it.
 */
class LedgerReplayError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

void bootExecutor();

async function bootExecutor(): Promise<void> {
  let runtime: QueueRuntime | undefined;
  let standbyFront: HostRunFront | undefined;
  try {
    const options: RuntimeOwnerOptions = { ...data.owner };
    const fixtures = data.fixture || data.debug ? await import("./executor-fixtures") : undefined;
    const fixture = data.fixture ? fixtures?.FIXTURES[data.fixture] : undefined;
    if (data.fixture && !fixture) throw new Error(`Unknown persistence fixture ${data.fixture}`);
    if (fixture?.bootCrash) {
      setTimeout(() => { throw new Error("Fixture boot crash"); }, 10);
      return;
    }
    if (fixture?.adapter) options.adapterFactory = context => fixture.adapter!(state, context);
    if (fixture?.instrumentStore) options.instrumentStore = store => fixture.instrumentStore!(state, store);
    // Warm standby: start the host-run front worker on its own thread and let it
    // bind a staged socket and swap it onto the live path before the ready
    // marker, so the outgoing process can keep serving existing followers until
    // drain while new connects never see ENOENT/ECONNREFUSED. The writable
    // lease, callbacks and journal wait until the old pid exits; the front holds
    // clients paused until this runtime's private socket can take them.
    if (data.standbyFor) {
      const standbyDataDir = data.owner.dataDir ?? dataHome();
      let front: HostRunFront | undefined;
      if (options.hostRunEndpoint) {
        try {
          const stateDir = options.hostRunStateDir ?? hostRunStateDirForDataDir(standbyDataDir);
          front = await HostRunFront.start({ stateDir, socketPath: hostRunSocketPath(stateDir), takeLivePath: true });
          options.hostRunFront = front;
          standbyFront = front;
        } catch (error) {
          console.error("Host-run front handoff failed; falling back to bind after the old pid exits:", error instanceof Error ? error.message : String(error));
          try { await front?.stop(); } catch { /* the later start still binds */ }
          delete options.hostRunFront;
        }
      }
      markStandbyReady(standbyDataDir, process.pid);
      // Stay cooperative: the prewarm reads below share this thread with nothing
      // that accepts, but the store open still must wait for the old owner.
      try { await waitForStandbyHandoffAsync(data.standbyFor, join(standbyDataDir, "queue.sqlite")); }
      finally { clearStandbyReady(standbyDataDir, process.pid); }
    }
    runtime = createQueueRuntime(options);
  } catch (error) {
    // A boot that never reached the runtime leaves the standby's front holding
    // the live path: settle it so clients reach whichever owner comes next.
    try { await standbyFront?.stop(); } catch { /* already gone */ }
    port.postMessage({ kind: "boot", ok: false, error: serializeError(error) });
    return;
  }
  serveRuntime(runtime);
}

function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof ZodError) return { code: "invalid_input", message: formatSchemaRefusal(error) };
  if (error instanceof MethodNotServedError) return { code: "method_unknown", message: error.message };
  if (error instanceof LedgerReplayError) return { code: error.code, message: error.message };
  if (error instanceof RequestKeyConflictError) return { code: error.code, message: error.message };
  // A policy refusal is a definite answer from a healthy service, carried as its
  // own code so the bridge and the client never mistake it for a transport fault.
  if (error instanceof CapacityWriteRefusalError || error instanceof SurfaceRefusalError) return { code: "refused", message: error.message };
  // The caller gets the reason; the stack belongs in the service log. Appending it to the
  // message turned ordinary refusals ("Task changed; refresh before retrying") into
  // multi-line internal errors that planners read as opaque stream failures.
  if (error instanceof Error && error.stack) console.error(error.stack);
  return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}

function serveRuntime(runtime: QueueRuntime): void {
  let pushedBoardRevision = -1;
  let pushTimer: NodeJS.Timeout | null = null;
  // Only the first failure of a streak logs; the main thread holds the bounded repeat count.
  let projectionFaulted = false;
  const budget = publicationBudget();
  const pushSnapshot = () => {
    if (state.projectionDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.projectionDelayMs);
    if (state.projectionFault === true) throw new Error("Fixture projection publication fault");
    const board = runtime.uiSnapshot({ revision: pushedBoardRevision });
    const health = state.projectionFault === "clone"
      ? { ...runtime.health(), unclonable: () => undefined } as unknown as ReturnType<QueueRuntime["health"]>
      : runtime.health();
    const message: SnapshotMessage = { kind: "snapshot", revision: board.revision, health, board };
    // The cursor advances only after the parent has the board. A failed post leaves it
    // behind, so the next publication resends the full board instead of an unchanged marker.
    port.postMessage(message);
    pushedBoardRevision = board.revision;
  };
  /**
   * Publish without letting a projection fault end the worker: a throw here is
   * reported as a `projection` frame and the worker keeps serving. Returns the
   * failure, or null once a fresh snapshot has been posted.
   */
  const publishSnapshot = (withBoard: boolean): { message: string } | null => {
    if (!withBoard && !budget.due()) return null;
    const start = performance.now();
    try {
      pushSnapshot();
      budget.spent(performance.now() - start);
      projectionFaulted = false;
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack ?? "" : "";
      if (!projectionFaulted) console.error(`Queue projection publication failed; the executor keeps running: ${message}`);
      projectionFaulted = true;
      port.postMessage({ kind: "projection", at: new Date().toISOString(), message, stack });
      return { message };
    }
  };

  port.on("message", (message: RequestMessage) => {
    const { kind, id } = message;
    let revisionBefore = -1;
    const receivedAt = performance.now();
    const queueMs = Math.max(0, performance.timeOrigin + receivedAt - message.sentAt);
    let handlerMs = 0, publicationMs = 0, publishing = false;
    const fail = (error: unknown) => port.postMessage({ kind: "reply", id, ok: false, error: serializeError(error), timing: { queueMs, handlerMs: publishing ? handlerMs : performance.now() - receivedAt, publicationMs } });
    /** A mapped typed answer that bypasses serializeError (a replayed ledger outcome). */
    const failTyped = (error: { code: string; message: string }) => port.postMessage({ kind: "reply", id, ok: false, error, timing: { queueMs, handlerMs: publishing ? handlerMs : performance.now() - receivedAt, publicationMs } });
    const succeed = (result: unknown) => port.postMessage({ kind: "reply", id, ok: true, result, timing: { queueMs, handlerMs, publicationMs } });
    // The handler has already settled. A failed publication here means the change may
    // already be committed: the caller gets an uncertain outcome, never a replay hint.
    const settle = (result: unknown) => {
      publishing = true;
      handlerMs = performance.now() - receivedAt;
      const start = performance.now();
      // A completed mutation must be visible before its reply. The publication
      // budget only delays unchanged requests and periodic refreshes.
      const failure = publishSnapshot(runtime.store.boardRevision() !== revisionBefore);
      publicationMs = performance.now() - start;
      if (failure) {
        fail(new Error(`The board projection did not publish after this request settled (${failure.message}). Its outcome is uncertain: read current state before acting, and do not resubmit it blindly.`));
        return;
      }
      succeed(result);
    };
    try {
      revisionBefore = runtime.store.boardRevision();
      if (kind === "rpc") {
        // A keyed mutating call is journaled around its handler (request ledger):
        // `received` lands before the handler, the definite outcome after, both
        // durable before the reply frame is written. An already-settled key
        // replays its recorded outcome and never runs the handler again.
        const key = typeof message.key === "string" && runtime.requestLedger.watches(message.method) ? message.key : undefined;
        const run = async (): Promise<unknown> => {
          if (key === undefined) return callCatalogueMethod(runtime, message.method, message.input, { via: message.via ?? null });
          const opened = runtime.requestLedger.open(key, message.method, message.input);
          if ("fresh" in opened) return await callCatalogueMethod(runtime, message.method, message.input, { via: message.via ?? null });
          const replay = opened.replay;
          if (replay.status === "refused") throw new LedgerReplayError(replay.code, replay.message);
          if (replay.status === "applied") return replay.result;
          throw new LedgerReplayError("internal", `Request key ${key} has no replayable recorded outcome (${replay.status})`);
        };
        const settleKeyed = (result: unknown) => {
          if (key !== undefined) { try { runtime.requestLedger.settle(key, result); } catch { /* the reply still carries the result */ } }
          settle(result);
        };
        const failKeyed = (error: unknown) => {
          if (key !== undefined && !(error instanceof LedgerReplayError)) {
            const mapped = serializeError(error);
            try { runtime.requestLedger.settleRefused(key, mapped.code, mapped.message); } catch { /* the reply still carries the answer */ }
          }
          fail(error);
        };
        void run().then(settleKeyed).catch(error => {
          if (error instanceof LedgerReplayError) failTyped({ code: error.code, message: error.message });
          else failKeyed(error);
        });
      } else if (kind === "call") {
        const handler = (runtime as unknown as Record<string, unknown>)[message.handler];
        if (typeof handler !== "function") throw new Error(`Executor has no handler ${message.handler}`);
        void Promise.resolve((handler as (value: unknown) => unknown).call(runtime, message.input)).then(settle).catch(fail);
      } else if (kind === "drain") {
        if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
        void runtime.drain().then(() => {
          succeed({ ok: true, drained: true });
        }).catch(fail);
      } else if (kind === "debug") {
        if (!data.debug) throw new Error("The debug channel is disabled");
        void import("./executor-fixtures").then(fixtures => fixtures.handleDebug(runtime, message.op, state)).then(settle).catch(fail);
      } else {
        fail(new Error(`Unknown executor request kind ${JSON.stringify(kind)}`));
      }
    } catch (error) {
      fail(error);
    }
  });

  // The first board projection parses every task blob. That is what the
  // host-run endpoint does not need, so bind first and only then snapshot.
  void runtime.hostRunReady.then(() => {
    const failure = publishSnapshot(true);
    if (failure) {
      port.postMessage({ kind: "boot", ok: false, error: { code: "internal", message: `Initial board projection did not publish: ${failure.message}` } });
      return;
    }
    port.postMessage({ kind: "boot", ok: true });
    // A failing tick reports itself and waits for the next one; it never ends the worker.
    pushTimer = setInterval(() => { publishSnapshot(false); }, 1_000);
    if (typeof pushTimer.unref === "function") pushTimer.unref();
  }, error => {
    port.postMessage({ kind: "boot", ok: false, error: serializeError(error) });
  });
}
