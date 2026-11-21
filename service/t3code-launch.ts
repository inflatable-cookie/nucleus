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
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pidAlive } from "../core/machine/pid";
import { runtimeNodeArgs } from "../shared/runtime.mjs";
import {
  currentLoginSession,
  readServiceInfo,
  readServiceRoll,
} from "../shared/service/discovery";
import { rollInProgress } from "../shared/service/roll-recovery";
import { readT3Connection } from "../shared/t3/settings";

/** The claim file this launcher takes; the Paseo bridge's own claim is `queue-service.claim.json`. */
export const T3_LAUNCH_CLAIM_FILE = "queue-service.t3-launch.json";
/** The Paseo bridge's spawn claim (`service/roll/spawn.ts`), read only. */
const BRIDGE_SPAWN_CLAIM_FILE = "queue-service.claim.json";
/** Output of a daemon this launcher starts, owner-only, beside the service's own files. */
export const T3_LAUNCH_LOG_FILE = "queue-service.t3-launch.log";
/** A claim whose process is alive is honoured this long; a daemon still booting is covered by it. */
const CLAIM_FRESH_MS = 120_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export type T3DaemonLaunch =
  /** No stored T3Code connection, or its endpoint is not loopback: nothing to start for. */
  | { status: "no-t3-host"; reason: string }
  /** A live service process already owns this data home. */
  | { status: "running"; pid: number }
  /** A service roll is replacing the daemon; the roll owns the next start. */
  | { status: "rolling"; roll: string }
  /** Another launch or a Paseo bridge is starting the daemon right now. */
  | { status: "claimed"; pid: number | null }
  /** This probe spawned the daemon and did not wait for it. */
  | { status: "started"; pid: number };

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

interface Claim {
  pid: number;
  at: string;
}

function readClaim(path: string): Claim | null {
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as Claim;
    if (typeof claim.pid !== "number" || typeof claim.at !== "string") return null;
    return claim;
  } catch {
    return null;
  }
}

function claimIsFresh(
  claim: Claim | null,
  alive: (pid: number) => boolean,
  now: number,
): boolean {
  return Boolean(
    claim && alive(claim.pid) && now - Date.parse(claim.at) < CLAIM_FRESH_MS,
  );
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
  const alive = options.pidAlive ?? pidAlive;
  const now = (options.now ?? Date.now)();
  const env = options.env ?? process.env;

  const connection = readT3Connection(options.dataDir);
  if (!connection) return { status: "no-t3-host", reason: "no T3Code connection is stored" };
  if (!isLoopbackEndpoint(connection.endpoint))
    return { status: "no-t3-host", reason: "the stored T3Code endpoint is not local" };

  const info = readServiceInfo(options.dataDir);
  if (info && alive(info.pid)) return { status: "running", pid: info.pid };

  const roll = readServiceRoll(options.dataDir);
  if (rollInProgress(roll)) return { status: "rolling", roll: roll.status };

  const bridgeClaim = readClaim(join(options.dataDir, BRIDGE_SPAWN_CLAIM_FILE));
  if (claimIsFresh(bridgeClaim, alive, now))
    return { status: "claimed", pid: bridgeClaim!.pid };

  const claimPath = join(options.dataDir, T3_LAUNCH_CLAIM_FILE);
  if (!claimExclusively(claimPath, process.pid, now, alive)) {
    const held = readClaim(claimPath);
    return { status: "claimed", pid: held?.pid ?? null };
  }

  let child: ChildProcess;
  let logFd: number | null = null;
  try {
    const installed = existsSync(join(options.root, "manifest.json"));
    const command = installed ? join(options.root, "runtime", "node") : process.execPath;
    const args = [
      ...(installed ? [] : runtimeNodeArgs()),
      join(options.root, "bin", "queue-service.mjs"),
      `--data-dir=${options.dataDir}`,
    ];
    logFd = openSync(join(options.dataDir, T3_LAUNCH_LOG_FILE), "a", 0o600);
    const spawnProcess = options.spawnProcess ?? spawn;
    child = spawnProcess(command, args, {
      cwd: options.root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, QUEUE_LOGIN_SESSION: currentLoginSession(env) },
    });
  } catch (error) {
    rmSync(claimPath, { force: true });
    throw error;
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
  if (!child.pid) {
    rmSync(claimPath, { force: true });
    throw new Error("the Nucleus daemon did not start (no process id)");
  }
  child.on("error", () => rmSync(claimPath, { force: true }));
  child.unref();
  // The claim now names the daemon, so a probe that arrives during its boot waits on it.
  writeFileSync(claimPath, JSON.stringify({ pid: child.pid, at: new Date(now).toISOString() } satisfies Claim), { mode: 0o600 });
  return { status: "started", pid: child.pid };
}

/**
 * Take the launch claim with an exclusive create. A fresh claim from a live
 * process means another launch is already at work; a stale one is reclaimed once.
 */
function claimExclusively(
  path: string,
  pid: number,
  now: number,
  alive: (pid: number) => boolean,
): boolean {
  const body = JSON.stringify({ pid, at: new Date(now).toISOString() } satisfies Claim);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { mode: 0o600, flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (claimIsFresh(readClaim(path), alive, now)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}
