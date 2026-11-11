/**
 * The front worker thread (Spec 035, "Accepts off the runtime loop"). It owns
 * the public contract-010 listener: it binds `run/scheduler.sock.staged`, renames
 * it onto the live path, keeps accepting while the runtime is busy, and pipes
 * every accepted client's bytes to the runtime's private inner socket.
 *
 * Why a separate thread: the store, the engine and contract-010's request
 * validation all run on the runtime executor's event loop, and one large
 * `validateWSOutboundMessage` or database transaction there is 200-900 ms of
 * synchronous work. When that thread also owned the listener, the kernel accept
 * queue filled and clients got `ECONNREFUSED` for the length of the stall —
 * including stalls outside a roll. Here a blocked runtime only delays a client's
 * reply: the connect completes, the client is paused, and its bytes move once the
 * private connection succeeds.
 *
 * The security model is unchanged. This thread is the same uid, the public socket
 * stays owner-only, and the private socket is a 0600 socket inside the 0700 run
 * directory; the runtime still authenticates every request (epoch, token, framing
 * and size limits) and no protocol meaning is added here. Bytes are copied, never
 * parsed.
 *
 * It never touches SQLite or the scheduler: bind instants and accept evidence go
 * to the parent over the port, which journals them and publishes authority.
 */
import { chmodSync, lstatSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { parentPort, workerData } from "node:worker_threads";
import {
  assertHostRunRunDirectory,
  bindStagedHostRunSocket,
  ensureHostRunRunDirectory,
  hostRunProcessStartIdentity,
  hostRunSocketAnswers,
  hostRunSocketIsOwnerOnly,
  readHostRunAuthority,
  removeStaleHostRunSocket,
  type HostRunSocketHandoff,
} from "../../core/host-runs/host-run-files";
import { hostRunInnerSocketPath, hostRunSocketPath } from "../../core/host-runs/host-run-paths";
import { pidAlive } from "../../core/machine/process-identity";
import { startIdentityMatches } from "../../core/machine/start-identity";

interface FrontWorkerData {
  stateDir: string;
  /** The contract path this worker must own; it is derived from `stateDir`. */
  socketPath: string;
  /** Suffix of this process's private runtime socket (`inner-<token>.sock`). */
  innerToken: string;
  /**
   * True for the warm standby's make-before-break bind: the outgoing process is
   * still holding the live path on purpose, and the staged inode is renamed over
   * it. A fresh bind instead refuses a live holder and clears a stale socket.
   */
  takeLivePath?: boolean;
  /** Retry cadence for the private connection while the runtime is not listening. */
  innerRetryMs?: number;
  /** Bound on holding a client whose private connection never succeeds. */
  innerWaitMs?: number;
  /** Test seam: chmod the live path after the swap and before the chain check. */
  testAfterBindChmod?: number;
}

type FrontRequest = { kind: "ensure"; id: number } | { kind: "stop" };

const data = workerData as FrontWorkerData;
const port = parentPort ?? (() => { throw new Error("The host-run front must run as a worker thread"); })();
const contractPath = hostRunSocketPath(data.stateDir);
const innerPath = hostRunInnerSocketPath(data.stateDir, data.innerToken);
if (data.socketPath !== contractPath) {
  throw new Error(`Host-run front only owns the contract socket ${contractPath} (got ${data.socketPath})`);
}
if (!/^\d+-[0-9a-f]+$/.test(data.innerToken)) {
  throw new Error(`Host-run front needs a process-private inner socket token (got ${data.innerToken})`);
}

const innerRetryMs = Math.max(1, data.innerRetryMs ?? 10);
const innerWaitMs = Math.max(innerRetryMs, data.innerWaitMs ?? 120_000);

let handoff: HostRunSocketHandoff | null = null;
let stopping = false;
let serveError: string | null = null;
let boundAt: string | null = null;
let answeredAt: string | null = null;
let swappedAt: string | null = null;
/** A client has been accepted since the last bind; reset on every (re)bind. */
let answeredSinceBind = false;
/** Clients the front gave up on because the private socket never answered. */
let abandoned = 0;
/** False until the first bind is reported, so the staged-socket answer probe is not a client. */
let boundReported = false;
const live = new Set<{ client: Socket; inner: Socket | null }>();

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function post(frame: Record<string, unknown>): void {
  try { port.postMessage(frame); } catch { /* the parent is gone; nothing left to report */ }
}

function serving(): boolean {
  if (!handoff) return false;
  try { return lstatSync(handoff.livePath).ino === handoff.boundIno; } catch { return false; }
}

function state(rebound: boolean): Record<string, unknown> {
  return {
    serving: serving(), error: serveError, ino: handoff?.boundIno ?? null, rebound,
    boundAt, answeredAt, swappedAt, abandoned, held: live.size,
  };
}

/**
 * Pipe one accepted client to the private runtime socket. The client is paused
 * from the accept, so nothing it wrote is lost while the private connection is
 * retried; its bytes then move with ordinary socket backpressure, which is the
 * client's own flow control rather than a refusal. A private failure the front
 * cannot retry closes the client instead of answering for the runtime.
 */
function pipeClient(client: Socket): void {
  if (stopping) { client.destroy(); return; }
  const entry: { client: Socket; inner: Socket | null } = { client, inner: null };
  live.add(entry);
  // A socket handed over during the bind is either the bind's own answer probe or
  // a client that arrived in that window; only clients accepted after the bind is
  // reported are counted as ones the runtime never answered.
  const counted = boundReported;
  const deadline = Date.now() + innerWaitMs;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    live.delete(entry);
    try { entry.inner?.destroy(); } catch { /* already gone */ }
    try { client.destroy(); } catch { /* already gone */ }
  };
  client.on("error", close);
  // The client went away: its private connection has no one left to serve.
  client.on("close", () => { live.delete(entry); try { entry.inner?.destroy(); } catch { /* already gone */ } });
  const attempt = () => {
    if (closed) return;
    if (stopping) { close(); return; }
    const inner = connect(innerPath);
    inner.once("connect", () => {
      if (closed) { inner.destroy(); return; }
      entry.inner = inner;
      inner.on("error", close);
      // The runtime closed its side. The pipe has already ended the client, so let
      // queued bytes flush to the kernel (destroy here truncates a large final
      // chunk) and only then release the socket.
      inner.on("close", () => {
        if (client.destroyed) { live.delete(entry); return; }
        client.end();
        client.once("finish", () => { try { client.destroy(); } catch { /* already gone */ } });
      });
      client.pipe(inner);
      inner.pipe(client);
    });
    inner.once("error", (error: NodeJS.ErrnoException) => {
      inner.destroy();
      if (closed) return;
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        if (Date.now() >= deadline) {
          if (counted) {
            abandoned++;
            post({ kind: "abandoned", count: abandoned });
          }
          close();
          return;
        }
        setTimeout(attempt, innerRetryMs);
        return;
      }
      close();
    });
  };
  attempt();
}

function onClient(socket: Socket): void {
  socket.pause();
  if (boundReported && !answeredSinceBind) {
    answeredSinceBind = true;
    post({ kind: "accepted" });
  }
  pipeClient(socket);
}

/**
 * Bind the live path. A fresh bind refuses a live holder (contract 010's rule) and
 * clears only a stale owned socket; the warm standby's handoff takes the path
 * from the outgoing process deliberately, so it keeps its staged inode's rename
 * as the only transition.
 */
async function bind(): Promise<void> {
  // The owned root and its `run` directory exist (and are verified) before any
  // check touches a name inside them.
  ensureHostRunRunDirectory(data.stateDir);
  if (data.takeLivePath) {
    assertHostRunRunDirectory(data.stateDir);
  } else {
    if (await hostRunSocketAnswers(data.socketPath)) {
      throw new Error(`Host-run socket is served by a live holder: ${data.socketPath}`);
    }
    const holder = readHostRunAuthority(data.stateDir);
    if (holder && holder.pid !== process.pid && pidAlive(holder.pid)
      && startIdentityMatches(hostRunProcessStartIdentity(holder.pid), holder.startIdentity)) {
      throw new Error(`Host-run authority names a live holder (pid ${holder.pid}); not binding ${data.socketPath}`);
    }
    removeStaleHostRunSocket(data.stateDir);
  }
  const bound = await bindStagedHostRunSocket(data.stateDir, { onConnection: onClient });
  try {
    bound.swap();
    if (typeof data.testAfterBindChmod === "number") chmodSync(bound.livePath, data.testAfterBindChmod);
    if (!hostRunSocketIsOwnerOnly(data.stateDir)) throw new Error("Host-run socket failed the verified chain check after swap");
  } catch (error) {
    try { await bound.close(); } catch { /* the caller reports the original refusal */ }
    throw error;
  }
  handoff = bound;
  boundAt = bound.boundAt;
  answeredAt = bound.answeredAt;
  swappedAt = bound.swappedAt;
  answeredSinceBind = false;
  serveError = null;
}

/** Bind, or re-assert the live path when our inode was lost. Returns true when it rebound. */
async function ensure(): Promise<boolean> {
  if (stopping) return false;
  try {
    if (!handoff) {
      await bind();
      boundReported = true;
      post({ kind: "bound", ...state(true) });
      return true;
    }
    const rebound = await handoff.reassert();
    if (rebound) {
      boundAt = handoff.boundAt;
      answeredAt = handoff.answeredAt;
      swappedAt = handoff.swappedAt;
      if (!hostRunSocketIsOwnerOnly(data.stateDir)) {
        throw new Error("Host-run socket failed the verified chain check after reassert");
      }
    }
    serveError = null;
    return rebound;
  } catch (error) {
    serveError = describe(error);
    return false;
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const entry of [...live]) {
    try { entry.inner?.destroy(); } catch { /* already gone */ }
    try { entry.client.destroy(); } catch { /* already gone */ }
  }
  live.clear();
  const current = handoff;
  handoff = null;
  if (current) { try { await current.close(); } catch { /* best effort */ } }
  post({ kind: "stopped" });
  port.close();
}

port.on("message", (request: FrontRequest) => {
  if (request.kind === "ensure") {
    void ensure().then(rebound => post({ kind: "state", request: request.id, ...state(rebound) }));
    return;
  }
  if (request.kind === "stop") void stop();
});

process.on("uncaughtException", error => {
  post({ kind: "fault", message: describe(error) });
  void stop().then(() => process.exit(1), () => process.exit(1));
});

void ensure().then(rebound => {
  if (rebound) return;
  post({ kind: "fault", message: serveError ?? "Host-run front did not bind the contract socket" });
});
