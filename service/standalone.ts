import { dataHome } from "../shared/data-home.mjs";
/**
 * Standalone service entry. Owns the runtime for its whole lifetime and
 * drains to a durable safe point on SIGTERM/SIGINT before exiting. It must
 * never run twice against the same store: construction proves the prior owner
 * is gone and fails closed otherwise.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { QueueService } from "./transport/server";
import { pidAlive } from "./transport/identity";
import { standbyForPid, clearStandbyReady } from "./install/standby";

export async function runStandaloneService(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // The bridge captures startup diagnostics over pipes, but it can exit after
  // readiness while this detached service continues. A later console write
  // then sees EPIPE; that closed diagnostic channel must not stop Queue.
  ignoreDetachedOutputEpipe(process.stdout);
  ignoreDetachedOutputEpipe(process.stderr);
  const dataDirOverride = argv.find(value => value.startsWith("--data-dir="))?.slice("--data-dir=".length);
  const paseoHome = process.env.PASEO_HOME || joinHome();
  const ownerOptions = {
    dataDir: dataDirOverride ?? dataHome(env),
    ...(env.PASEO_HOME || argv.some(value => value.startsWith("--data-dir=")) ? { paseoHome } : {}),
    // Contract 010's client-protocol v1 endpoint is a live-service surface; the
    // fixture and in-process test runtimes never enable it.
    hostRunEndpoint: true,
  };
  const standbyFor = standbyForPid(env);
  // Keep the marker path in step with the service's own data directory so an
  // abandoned standby (SIGTERM before the old pid exits) never leaves it behind.
  const standbyDataDir = dataDirOverride ?? dataHome(env);
  if (standbyFor !== undefined) process.on("exit", () => clearStandbyReady(standbyDataDir, process.pid));
  // A dead executor can't recover in place, and every request would refuse until someone
  // noticed. Exiting lets the bridge start a replacement, which reconciles from the store.
  let started = false;
  const service = new QueueService({ owner: ownerOptions, idleTimeoutMs: 300_000, ...(standbyFor ? { standbyFor } : {}), onExecutorDeath: () => { if (started) drain("executor death"); } });
  // A standby owns nothing until the old service exits, so a stop signal before
  // then (the bridge abandoned the roll) just ends the process; the executor
  // worker is blocked waiting and could not run a drain anyway.
  const waiting = () => standbyFor !== undefined && pidAlive(standbyFor);
  const drain = (signal: string) => {
    if (waiting()) process.exit(0);
    console.log(`Nucleus service draining (${signal})`);
    // Hard exit guard: even if an external effect will not settle, the process
    // releases its lease and exits so replacement and rollback stay possible.
    const guard = setTimeout(() => process.exit(1), 45_000);
    if (typeof guard.unref === "function") guard.unref();
    void service.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
  process.on("uncaughtException", error => {
    console.error("Nucleus service uncaught exception:", error);
    void service.stop().then(() => process.exit(1));
  });
  try {
    await service.start();
    started = true;
  } catch (error) {
    console.error("Nucleus service failed to start:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(`Nucleus service ready on ${service["socketPath"]} pid ${process.pid} build ${service.buildId}`);
  await service.drainedPromise();
}

function joinHome(): string { return join(homedir(), ".paseo"); }

function ignoreDetachedOutputEpipe(stream: NodeJS.WriteStream) {
  stream.on("error", error => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
  });
}
