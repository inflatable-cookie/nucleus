/**
 * The Nucleus service channel (Spec 062, decision 1).
 *
 * The plugin backend is the host-operation executor: it connects out to the Nucleus
 * service on the owner-only socket, authenticates with the credential the service
 * wrote beside it, declares the `host-executor` role, and then answers bounded
 * `host.op` requests from `bb.sdk` for as long as the connection lives.
 *
 * Two fault shapes matter and both are the ordinary host-outage shape: a plugin
 * reload and a BB server restart. The plugin does not try to hide either. It drops
 * its connection, reconnects with backoff, re-reads the service identity (the
 * service may have rolled underneath it) and declares again; the service derives the
 * same host id from the same data directory, so a reconnection is re-proved rather
 * than assumed. An operation the old connection was carrying is settled by the
 * service as unknown delivery, never replayed here.
 *
 * This file owns no Nucleus state: no task, no run, no review, no database.
 */
import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  asServiceRequest,
  createFrameReader,
  writeFrame,
  type ProtocolError,
  type ServiceResponse,
} from "./protocol";
import type { HostOperationError, HostOperations } from "./operations";

export interface HostChannelLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HostChannelOptions {
  /** The Nucleus data home whose `queue-service.json` names the socket and credential. */
  serviceDataDir: string;
  operations: HostOperations;
  /** What the plugin announces. Read lazily so a server that has not bound yet is not fatal. */
  declaration: () => { dataDir: string; bbVersion: string; sdkVersion: string };
  log: HostChannelLogger;
  signal: AbortSignal;
  /** Reconnect window; a plugin reload or a server restart is a reconnect, not a refusal. */
  backoff?: { minMs: number; maxMs: number };
}

interface ServiceIdentity {
  socketPath: string;
  credential: string;
}

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 5_000;

/** Read the service identity beside its socket; a missing or partial file is an ordinary "not up yet". */
export function readServiceIdentity(serviceDataDir: string): ServiceIdentity | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(serviceDataDir, "queue-service.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.protocolVersion !== PROTOCOL_VERSION) return null;
  if (typeof record.socketPath !== "string" || record.socketPath.length === 0) return null;
  if (typeof record.credential !== "string" || !/^[a-f0-9]{64}$/.test(record.credential)) return null;
  return { socketPath: record.socketPath, credential: record.credential };
}

/**
 * Run the executor channel until the signal aborts. Resolves only on abort; every
 * other outcome is a reconnect, because a host that is briefly unreachable is the
 * ordinary case, not a reason to stop being the host's executor.
 */
export async function runHostChannel(options: HostChannelOptions): Promise<void> {
  const backoff = options.backoff ?? { minMs: BACKOFF_MIN_MS, maxMs: BACKOFF_MAX_MS };
  let delayMs = backoff.minMs;
  while (!options.signal.aborted) {
    const identity = readServiceIdentity(options.serviceDataDir);
    if (!identity) {
      options.log.info(`Nucleus service identity is not readable under ${options.serviceDataDir}; retrying`);
      await sleep(delayMs, options.signal);
      delayMs = Math.min(Math.max(delayMs * 2, backoff.minMs), backoff.maxMs);
      continue;
    }
    const outcome = await runOnce(options, identity, () => { delayMs = backoff.minMs; });
    if (options.signal.aborted) return;
    options.log.info(`Nucleus service channel ended (${outcome}); reconnecting in ${delayMs} ms`);
    await sleep(delayMs, options.signal);
    delayMs = Math.min(Math.max(delayMs * 2, backoff.minMs), backoff.maxMs);
  }
}

/** How long a connection may take to authenticate and declare before it is retried. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** One connection's life: authenticate, declare, answer, until it fails or closes. */
function runOnce(options: HostChannelOptions, identity: ServiceIdentity, onDeclared: () => void): Promise<string> {
  return new Promise<string>(resolve => {
    let settled = false;
    let hostId: string | null = null;
    // A reload aborts this service; the open connection must end with it, or the
    // plugin host reports "service did not stop" and the reload fails.
    const onAbort = () => finish("the plugin is stopping");
    options.signal.addEventListener("abort", onAbort, { once: true });
    let handshake: NodeJS.Timeout | null = setTimeout(() => finish(`the handshake did not finish within ${HANDSHAKE_TIMEOUT_MS} ms`), HANDSHAKE_TIMEOUT_MS);
    handshake.unref?.();
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      if (handshake) { clearTimeout(handshake); handshake = null; }
      options.signal.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(reason);
    };
    const socket: Socket = connect(identity.socketPath);
    socket.setNoDelay(true);
    socket.setTimeout(5_000, () => finish("connect timed out"));
    socket.on("error", error => finish(`socket error: ${error.message}`));
    socket.on("close", () => finish(hostId ? `connection to ${hostId} closed` : "connection closed before the handshake"));
    socket.on("connect", () => {
      socket.setTimeout(0);
      let declared = false;
      let awaiting: "auth" | "declare" | null = "auth";
      const reader = createFrameReader(
        frame => handleFrame(frame),
        (error: ProtocolError) => finish(`protocol fault: ${error.message}`),
      );
      socket.on("data", chunk => reader.feed(chunk));

      function handleFrame(frame: unknown): void {
        if (awaiting !== null) {
          const answer = frame as { result?: unknown; error?: { message?: unknown } };
          if (answer.error) { finish(`${awaiting} refused: ${String(answer.error.message ?? "no reason given")}`); return; }
          if (awaiting === "auth") {
            let host: { dataDir: string; bbVersion: string; sdkVersion: string };
            try {
              host = options.declaration();
            } catch (error) {
              finish(`this plugin cannot name its BB server yet: ${error instanceof Error ? error.message : String(error)}`);
              return;
            }
            awaiting = "declare";
            send({ v: PROTOCOL_VERSION, id: "bb-plugin-executor", method: "service.host-executor", input: { role: "host-executor", host } });
            return;
          }
          const acceptance = answer.result as { hostId?: unknown } | undefined;
          if (typeof acceptance?.hostId !== "string") { finish("the service accepted the declaration without a host id"); return; }
          hostId = acceptance.hostId;
          declared = true;
          awaiting = null;
          if (handshake) { clearTimeout(handshake); handshake = null; }
          onDeclared();
          options.log.info(`Nucleus service accepted this plugin as host executor for ${hostId}`);
          return;
        }
        const request = asServiceRequest(frame);
        if (!request) { finish("the service wrote a frame this channel cannot read"); return; }
        if (!declared) { finish("the service wrote an operation before the role was declared"); return; }
        void answer(request.id, request.method, request.input);
      }

      async function answer(id: string, method: string, input: unknown): Promise<void> {
        if (method !== "host.op") {
          respond({ v: PROTOCOL_VERSION, id, error: { code: "method_unknown", message: `This executor does not serve ${method}` } });
          return;
        }
        const envelope = (typeof input === "object" && input !== null ? input : {}) as { op?: unknown; input?: unknown };
        if (typeof envelope.op !== "string") {
          respond({ v: PROTOCOL_VERSION, id, error: { code: "invalid_input", message: "host.op requires an operation name" } });
          return;
        }
        try {
          const outcome = await options.operations.execute(envelope.op as never, envelope.input);
          respond({ v: PROTOCOL_VERSION, id, result: outcome });
        } catch (error) {
          const failure = error as HostOperationError;
          respond({
            v: PROTOCOL_VERSION,
            id,
            error: {
              code: typeof failure.code === "string" ? failure.code : "internal",
              message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
            },
          });
        }
      }

      function respond(response: ServiceResponse): void { send(response); }
      function send(frame: unknown): void {
        try {
          writeFrame(socket, frame);
        } catch (error) {
          finish(`write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // The plugin writes the credential handshake first; the service's answer and
      // its acceptance of the declaration are both required before anything else.
      // Nothing on this connection is trusted before them.
      send({ v: PROTOCOL_VERSION, id: "bb-plugin-auth", method: "service.auth", input: { credential: identity.credential } });
    });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); resolve(); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
