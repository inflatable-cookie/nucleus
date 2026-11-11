/**
 * Shared lifetime rule for isolated host-run private-server fixtures
 * (Spec 035, private `bin/host-run-private-server.mjs` acceptance).
 *
 * An admitted run deliberately survives server restarts and may still own
 * state after the server exits, so a fixture must settle before it disposes:
 *
 * 1. request the owned run's normal exit (the fixture's own release path);
 * 2. observe the exact original run/epoch/identity terminal settlement while
 *    the private endpoint can still answer;
 * 3. stop the owned supervisor through its own SIGTERM path;
 * 4. only then remove the temporary root, once, with no retry loop.
 *
 * A timeout, an `unknown_run`/`stale_epoch` answer or an identity mismatch is
 * a failed fixture with evidence, never a settlement and never a silent
 * delete. Callers with no admitted run (authority never arrived, submit never
 * happened) skip the settle wait but still stop and dispose without hanging:
 * an already-exited supervisor returns immediately.
 */
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

export interface OwnedPrivateRun {
  endpoint: string;
  epoch: number;
  runId: string;
  pid?: number | null;
  startIdentity?: string | null;
}

interface WireResponse {
  ok: boolean;
  body?: Record<string, any>;
  error?: { code?: string; message?: string };
}

function requestOnce(endpoint: string, method: string, epoch: number, body: unknown, timeoutMs: number): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(JSON.parse(buffer.slice(0, index)) as WireResponse);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ v: 1, id: randomUUID(), method, epoch, body })}\n`);
    });
  });
}

/**
 * Poll `status` until the exact owned run reports `settled` with a settlement
 * envelope. Every observation must name the same run, epoch, pid and start
 * identity; anything else refuses with evidence instead of settling.
 */
export async function awaitOwnedPrivateSettlement(
  owned: OwnedPrivateRun,
  options: { timeoutMs?: number; pollMs?: number; requestTimeoutMs?: number } = {},
): Promise<Record<string, any>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "no status answer yet";
  for (;;) {
    let response: WireResponse;
    try {
      response = await requestOnce(owned.endpoint, "status", owned.epoch, { runId: owned.runId }, requestTimeoutMs);
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
      if (Date.now() >= deadline) {
        throw new Error(
          `owned private run ${owned.runId} never settled within ${timeoutMs} ms; last status attempt: ${lastObservation}`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    if (!response.ok) {
      const code = response.error?.code ?? "unknown";
      const message = response.error?.message ?? "no message";
      throw new Error(
        `owned private run ${owned.runId} refused settlement as ${code}: ${message}; ` +
          `not settled and not disposed as success`,
      );
    }
    const body = response.body ?? {};
    lastObservation = `state=${body.state ?? "missing"} runId=${body.runId ?? "missing"} epoch=${body.epoch ?? "missing"}`;
    if (body.runId !== owned.runId) {
      throw new Error(
        `owned private run identity changed: status names ${body.runId ?? "missing"} but the fixture owns ${owned.runId}; not settled`,
      );
    }
    if (body.epoch !== owned.epoch) {
      throw new Error(
        `owned private run epoch changed: status names epoch ${body.epoch ?? "missing"} but the fixture owns epoch ${owned.epoch}; not settled`,
      );
    }
    if (owned.pid !== undefined && owned.pid !== null && body.pid !== owned.pid) {
      throw new Error(
        `owned private run process changed: status pid ${body.pid ?? "missing"} but the fixture owns pid ${owned.pid}; not settled`,
      );
    }
    if (
      owned.startIdentity !== undefined &&
      owned.startIdentity !== null &&
      body.startIdentity !== owned.startIdentity
    ) {
      throw new Error(
        `owned private run start identity changed: status names ${body.startIdentity ?? "missing"} but the fixture owns ${owned.startIdentity}; not settled`,
      );
    }
    if (body.state === "settled") {
      if (!body.settlement) {
        throw new Error(
          `owned private run ${owned.runId} reports settled with no settlement envelope; refusing unknown settlement`,
        );
      }
      return body;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `owned private run ${owned.runId} never settled within ${timeoutMs} ms; last observation: ${lastObservation}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/** Stop the owned supervisor through its own SIGTERM path, bounded so a gone child never hangs. */
export async function stopPrivateSupervisor(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  const bounded = await Promise.race([
    exited.then(() => true as const),
    new Promise(resolve => setTimeout(() => resolve(false as const), timeoutMs)),
  ]);
  if (bounded) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`owned private supervisor pid ${child.pid ?? "unknown"} did not exit after SIGTERM/SIGKILL within ${timeoutMs} ms`);
  }
}

/** Remove the fixture root once, with no retry loop: a busy directory surfaces as evidence. */
export function disposePrivateRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export interface SettleStopDisposeOptions {
  /** The owned run, or null when authority never arrived or no run was admitted. */
  owned: OwnedPrivateRun | null;
  settlementTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/**
 * The one shared teardown order: settle the exact owned run while the endpoint
 * answers, stop the owned supervisor, then dispose the root. A settle failure
 * still stops and disposes for hygiene but rethrows, so it is never reported
 * as settled or deleted as success.
 */
export async function settleStopDisposePrivateFixture(
  child: ChildProcess,
  root: string,
  options: SettleStopDisposeOptions,
): Promise<Record<string, any> | null> {
  let settled: Record<string, any> | null = null;
  let settleError: unknown = null;
  if (options.owned) {
    try {
      settled = await awaitOwnedPrivateSettlement(options.owned, { timeoutMs: options.settlementTimeoutMs ?? 30_000 });
    } catch (error) {
      settleError = error;
    }
  }
  let stopError: unknown = null;
  try {
    await stopPrivateSupervisor(child, options.stopTimeoutMs ?? 15_000);
  } catch (error) {
    stopError = error;
  }
  let disposeError: unknown = null;
  try {
    disposePrivateRoot(root);
  } catch (error) {
    disposeError = error;
  }
  if (settleError !== null || stopError !== null || disposeError !== null) {
    const parts: string[] = [];
    if (settleError !== null) parts.push(`settle: ${settleError instanceof Error ? settleError.message : String(settleError)}`);
    if (stopError !== null) parts.push(`stop: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
    if (disposeError !== null) parts.push(`dispose: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`);
    throw new Error(`private fixture teardown failed (${parts.join("; ")})`);
  }
  return settled;
}
