/**
 * Shared detached-daemon launch for host integrations (T3Code and BB).
 *
 * Neither host keeps a service alive itself: each ensures one detached
 * `queue-service` process exists for the target data home when no live service,
 * no active roll and no sibling launch claim already owns it, using an
 * exclusive claim file (`wx`) so concurrent starts converge on one daemon.
 */
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeNodeArgs } from "../runtime.mjs";
import {
  currentLoginSession,
  readServiceInfo,
  readServiceRoll,
} from "./discovery";
import { rollInProgress } from "./roll-recovery";

export const BRIDGE_SPAWN_CLAIM_FILE = "queue-service.claim.json";
export const T3_LAUNCH_CLAIM_FILE = "queue-service.t3-launch.json";
export const T3_LAUNCH_LOG_FILE = "queue-service.t3-launch.log";
export const BB_LAUNCH_CLAIM_FILE = "queue-service.bb-launch.json";
export const BB_LAUNCH_LOG_FILE = "queue-service.bb-launch.log";

/** A claim whose process is alive is honoured this long; a daemon still booting is covered by it. */
const CLAIM_FRESH_MS = 120_000;

export type DetachedDaemonLaunch =
  | { status: "running"; pid: number }
  | { status: "rolling"; roll: string }
  | { status: "claimed"; pid: number | null }
  | { status: "started"; pid: number };

export type BbDaemonLaunch =
  | { status: "no-package-root"; reason: string }
  | DetachedDaemonLaunch;

export interface DetachedDaemonLaunchOptions {
  /** The data home the daemon will serve. */
  dataDir: string;
  /** The installed package root (or checkout) whose `bin/queue-service.mjs` the daemon runs. */
  root: string;
  /** Claim file owned by this launcher inside `dataDir`. */
  claimFile: string;
  /** Log file owned by this launcher inside `dataDir`. */
  logFile: string;
  /** Other host launchers' claim files to honour before taking our own claim. */
  siblingClaimFiles?: readonly string[];
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

export interface BbDaemonLaunchOptions {
  dataDir: string;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: DetachedDaemonLaunchOptions["spawnProcess"];
  pidAlive?: DetachedDaemonLaunchOptions["pidAlive"];
  now?: DetachedDaemonLaunchOptions["now"];
}

interface Claim {
  pid: number;
  at: string;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readClaim(path: string): Claim | null {
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as Claim;
    if (typeof claim.pid !== "number" || typeof claim.at !== "string")
      return null;
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
  const body = JSON.stringify({
    pid,
    at: new Date(now).toISOString(),
  } satisfies Claim);
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

/**
 * Ensure one detached `queue-service` process exists for `dataDir`, without
 * waiting for it to answer.
 */
export function ensureDetachedDaemon(
  options: DetachedDaemonLaunchOptions,
): DetachedDaemonLaunch {
  const alive = options.pidAlive ?? defaultPidAlive;
  const now = (options.now ?? Date.now)();
  const env = options.env ?? process.env;

  const info = readServiceInfo(options.dataDir);
  if (info && alive(info.pid)) return { status: "running", pid: info.pid };

  const roll = readServiceRoll(options.dataDir);
  if (rollInProgress(roll)) return { status: "rolling", roll: roll.status };

  for (const sibling of options.siblingClaimFiles ?? []) {
    const siblingClaim = readClaim(join(options.dataDir, sibling));
    if (claimIsFresh(siblingClaim, alive, now))
      return { status: "claimed", pid: siblingClaim!.pid };
  }

  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const claimPath = join(options.dataDir, options.claimFile);
  if (!claimExclusively(claimPath, process.pid, now, alive)) {
    const held = readClaim(claimPath);
    return { status: "claimed", pid: held?.pid ?? null };
  }

  let child: ChildProcess;
  let logFd: number | null = null;
  try {
    const installed = existsSync(join(options.root, "manifest.json"));
    const command = installed
      ? join(options.root, "runtime", "node")
      : process.execPath;
    const args = [
      ...(installed ? [] : runtimeNodeArgs()),
      join(options.root, "bin", "queue-service.mjs"),
      `--data-dir=${options.dataDir}`,
    ];
    logFd = openSync(join(options.dataDir, options.logFile), "a", 0o600);
    const spawnProcess = options.spawnProcess ?? spawn;
    // The daemon outlives rolls: its cwd must be the stable data home, never
    // the version folder retention prunes (nucleus#1566).
    child = spawnProcess(command, args, {
      cwd: options.dataDir,
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
  writeFileSync(
    claimPath,
    JSON.stringify({
      pid: child.pid,
      at: new Date(now).toISOString(),
    } satisfies Claim),
    { mode: 0o600 },
  );
  return { status: "started", pid: child.pid };
}

/** Resolve the installed Nucleus package root for BB's host-channel launcher. */
export function resolveBbPackageRoot(
  options: { packageRoot?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = options.env ?? process.env;
  const home = resolve(env.HOME || homedir());
  const candidates = [
    options.packageRoot,
    env.NUCLEUS_PACKAGE_ROOT?.trim(),
    join(home, ".local", "share", "nucleus", "current"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (existsSync(join(real, "bin", "queue-service.mjs"))) return real;
    } catch {
      /* absent or unreadable candidate */
    }
  }
  return null;
}

/**
 * Ensure one Nucleus daemon for this data home when the BB plugin starts, so a
 * BB-only machine starts the daemon without Paseo or T3Code present.
 */
export function ensureDaemonForBb(
  options: BbDaemonLaunchOptions,
): BbDaemonLaunch {
  const env = options.env ?? process.env;
  const root = resolveBbPackageRoot({ packageRoot: options.packageRoot, env });
  if (!root) {
    return {
      status: "no-package-root",
      reason: "no installed Nucleus package root was found",
    };
  }
  return ensureDetachedDaemon({
    dataDir: options.dataDir,
    root,
    claimFile: BB_LAUNCH_CLAIM_FILE,
    logFile: BB_LAUNCH_LOG_FILE,
    siblingClaimFiles: [BRIDGE_SPAWN_CLAIM_FILE, T3_LAUNCH_CLAIM_FILE],
    env,
    spawnProcess: options.spawnProcess,
    pidAlive: options.pidAlive,
    now: options.now,
  });
}
