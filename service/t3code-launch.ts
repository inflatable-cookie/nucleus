/**
 * Start the Nucleus daemon when a configured local T3Code host starts (nucleus#1394).
 *
 * T3Code probes its registered `nucleus` ACP provider as soon as the server is
 * ready, in an unbound directory, with no thread, workspace or model picker. The
 * registered launcher (`nucleus-acp`) therefore runs on a cold T3 start even when
 * nothing else has started the daemon. This module is the launcher's best-effort
 * step: it ensures one daemon exists for that T3 environment, and it never waits
 * for the daemon to be ready, so the probe answers at once.
 *
 * It starts a daemon only when every condition holds:
 * - this data home has a stored T3Code connection whose endpoint is loopback (a
 *   remote or unconfigured T3 starts nothing);
 * - no service identity names a live process (a running daemon, a Paseo bridge's
 *   daemon or one still in its ten-minute grace is left alone);
 * - no service roll is in progress (the roll owns the replacement);
 * - no Paseo bridge spawn claim is fresh (another bridge is already starting one).
 *
 * Concurrent and repeated probes converge: the first probe takes an exclusive
 * claim file (`wx`); a probe that finds a fresh claim from a live process reports
 * `claimed` and starts nothing. A stale claim is reclaimed. The daemon itself
 * still fails closed on a second owner of the store, so the claim only prevents a
 * wasted spawn. Lifecycle is unchanged: the daemon's own host registry, ten-minute
 * grace and active-run fence decide when it exits.
 */
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  BB_LAUNCH_CLAIM_FILE,
  BRIDGE_SPAWN_CLAIM_FILE,
  T3_LAUNCH_CLAIM_FILE,
  T3_LAUNCH_LOG_FILE,
  ensureDetachedDaemon,
  type DetachedDaemonLaunch,
} from "../shared/service/daemon-launch";
import { readT3Connection } from "../shared/t3/settings";

export { T3_LAUNCH_CLAIM_FILE, T3_LAUNCH_LOG_FILE };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type T3DaemonLaunch =
  /** No stored T3Code connection, or its endpoint is not loopback: nothing to start for. */
  | { status: "no-t3-host"; reason: string }
  | DetachedDaemonLaunch;

export interface T3DaemonLaunchOptions {
  /** The data home the daemon will serve. */
  dataDir: string;
  /** The installed package root (or the checkout) whose `bin/queue-service.mjs` the daemon runs. */
  root: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the process spawner. */
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Test seam: the liveness probe. */
  pidAlive?: (pid: number) => boolean;
  /** Test seam: the clock. */
  now?: () => number;
}

/** Loopback only: a remote T3Code is a host this launcher must not start a daemon for. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/**
 * Ensure one Nucleus daemon for this data home when a local T3Code host is
 * configured and nothing else owns the daemon. Synchronous and quick: it spawns
 * the detached daemon and returns without waiting for it to answer.
 */
export function ensureDaemonForT3(
  options: T3DaemonLaunchOptions,
): T3DaemonLaunch {
  const connection = readT3Connection(options.dataDir);
  if (!connection)
    return { status: "no-t3-host", reason: "no T3Code connection is stored" };
  if (!isLoopbackEndpoint(connection.endpoint))
    return {
      status: "no-t3-host",
      reason: "the stored T3Code endpoint is not local",
    };

  return ensureDetachedDaemon({
    dataDir: options.dataDir,
    root: options.root,
    claimFile: T3_LAUNCH_CLAIM_FILE,
    logFile: T3_LAUNCH_LOG_FILE,
    siblingClaimFiles: [BRIDGE_SPAWN_CLAIM_FILE, BB_LAUNCH_CLAIM_FILE],
    env: options.env,
    spawnProcess: options.spawnProcess,
    pidAlive: options.pidAlive,
    now: options.now,
  });
}
