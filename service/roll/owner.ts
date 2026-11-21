/**
 * The host-independent main-channel roll owner (nucleus#1454).
 *
 * One process owns the configured main channel: it watches the channel, builds
 * and proves the staged version, replaces the running service, converges
 * activation and records each step. It is not a host. A local T3Code start
 * (`bin/nucleus-acp.mjs`), a Paseo bridge, or both, start it through
 * `ensureRollOwner`, and every starter sees the same owner claim, so there is one
 * fetch/build/activation loop per data home.
 *
 * The owner outlives the service it replaces because it is a separate detached
 * process, so a handoff it began is completed by it, and a pending record a
 * restart interrupted is resumed by the next owner. It rolls only while a service
 * is serving or a roll is still unfinished. With no service and nothing pending
 * it exits, and the service's own host idle grace is unchanged.
 *
 * The state machine is the existing `RollScheduler` and `ServiceSpawner`: this
 * module supplies the host-neutral session, the non-presence connect, and the
 * timers. A landed roll moves the owner to the new `current` by starting that
 * version's owner and exiting.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { join, sep } from "node:path";
import { pidAlive as defaultPidAlive } from "../../core/machine/pid";
import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
import { runtimeNodeArgs } from "../../shared/runtime.mjs";
import { dataHome } from "../../shared/data-home.mjs";
import {
  backendSourceDigest,
  serviceBuildIdentity,
  sourcePathFromModule,
  SERVICE_PROTOCOL_VERSION,
} from "../../shared/service/build";
import {
  currentLoginSession,
  readServiceInfo,
  readServiceRoll,
  type ServiceInfo,
} from "../../shared/service/discovery";
import { rollInProgress } from "../../shared/service/roll-recovery";
import { ServiceClient } from "../../shared/service/client";
import { bridgeProcessActions } from "../install/bridge-process-actions";
import { installBase } from "../install/install.mjs";
import {
  CONNECT_ATTEMPT_TIMEOUT_MS,
  type BridgeOptions,
} from "../../shared/service/roll/options";
import { BridgeSession } from "../../shared/service/roll/session";
import { ServiceSpawner } from "../../shared/service/roll/spawn";
import { RollScheduler, ROLL_CHECK_MS } from "./roll";
import { bbPluginRoll } from "./bb-plugin-roll";
import type { BridgeProcessActions } from "../../shared/service/bridge-process";
import type { ServiceRoll } from "../../shared/service-roll";

/** The owner's heartbeat claim: the one live owner for this data home. */
export const ROLL_OWNER_FILE = "queue-roll-owner.json";
/** The launcher's short spawn claim, so concurrent starters start one owner. */
export const ROLL_OWNER_LAUNCH_FILE = "queue-roll-owner.launch.json";
/** Short-lived guard serialising stale heartbeat reclamation between racing owners. */
const ROLL_OWNER_RECLAIM_FILE = "queue-roll-owner.reclaim.json";
/** Owner output, owner-only, beside the service's own files. */
export const ROLL_OWNER_LOG_FILE = "queue-roll-owner.log";
/** A heartbeat older than this, from a live pid, still counts as the owner. */
const OWNER_FRESH_MS = 60_000;
/** A launch claim is honoured this long while the owner boots. */
const LAUNCH_FRESH_MS = 120_000;
/** A stale-heartbeat reclaim guard is honoured this long while one owner swaps it. */
const RECLAIM_FRESH_MS = 10_000;
const HEARTBEAT_MS = 10_000;
const TICK_MS = 1_000;
/** With no service and nothing pending, the owner waits this long for one before it exits. */
export const ROLL_OWNER_IDLE_EXIT_MS = 120_000;

interface OwnerClaim {
  pid: number;
  at: string;
  root?: string;
  token?: string;
}

export type RollOwnerLaunch =
  /** Main channel is not installed here: there is nothing to own. */
  | { status: "no-main-channel"; reason: string }
  /** A live owner already holds the data home. */
  | { status: "running"; pid: number }
  /** Another starter is launching the owner right now. */
  | { status: "claimed"; pid: number | null }
  /** This call spawned the owner and did not wait for it. */
  | { status: "started"; pid: number };

export interface RollOwnerLaunchOptions {
  dataDir: string;
  /** The installed package root whose `bin/queue-roll-owner.mjs` the owner runs. */
  root: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      detached: boolean;
      stdio: unknown;
      env: NodeJS.ProcessEnv;
    },
  ) => ChildProcess;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
}

function readClaim(path: string): OwnerClaim | null {
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as OwnerClaim;
    if (typeof claim.pid !== "number" || typeof claim.at !== "string")
      return null;
    return claim;
  } catch {
    return null;
  }
}

function claimFresh(
  claim: OwnerClaim | null,
  freshMs: number,
  alive: (pid: number) => boolean,
  now: number,
): boolean {
  return Boolean(
    claim && alive(claim.pid) && now - Date.parse(claim.at) < freshMs,
  );
}

/** Whether this install has its main channel configured (an opt-in local install). */
export function mainChannelInstalled(): boolean {
  try {
    return (
      JSON.parse(readFileSync(join(installBase(), "channel.json"), "utf8"))
        ?.channel === "main"
    );
  } catch {
    return false;
  }
}

/**
 * Ensure one main-channel roll owner for this data home. Synchronous and quick:
 * it spawns the detached owner and returns without waiting for it to answer.
 */
export function ensureRollOwner(
  options: RollOwnerLaunchOptions,
): RollOwnerLaunch {
  if (!mainChannelInstalled())
    return {
      status: "no-main-channel",
      reason: "the local main channel is not configured",
    };
  const alive = options.pidAlive ?? defaultPidAlive;
  const now = (options.now ?? Date.now)();
  const env = options.env ?? process.env;
  const heartbeat = readClaim(join(options.dataDir, ROLL_OWNER_FILE));
  if (claimFresh(heartbeat, OWNER_FRESH_MS, alive, now))
    return { status: "running", pid: heartbeat!.pid };
  const launchPath = join(options.dataDir, ROLL_OWNER_LAUNCH_FILE);
  const launch = readClaim(launchPath);
  if (claimFresh(launch, LAUNCH_FRESH_MS, alive, now))
    return { status: "claimed", pid: launch!.pid };
  if (!existsSync(join(options.root, "bin", "queue-roll-owner.mjs"))) {
    throw new Error(
      "installed source is missing the roll owner entry bin/queue-roll-owner.mjs",
    );
  }
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  if (!claimExclusively(launchPath, process.pid, now, alive)) {
    const held = readClaim(launchPath);
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
      join(options.root, "bin", "queue-roll-owner.mjs"),
      `--data-dir=${options.dataDir}`,
    ];
    logFd = openSync(join(options.dataDir, ROLL_OWNER_LOG_FILE), "a", 0o600);
    const spawnProcess = options.spawnProcess ?? spawn;
    child = spawnProcess(command, args, {
      cwd: options.root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, QUEUE_LOGIN_SESSION: currentLoginSession(env) },
    });
  } catch (error) {
    rmSync(launchPath, { force: true });
    throw error;
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
  if (!child.pid) {
    rmSync(launchPath, { force: true });
    throw new Error("the Nucleus roll owner did not start (no process id)");
  }
  child.on("error", () => rmSync(launchPath, { force: true }));
  child.unref();
  // The claim now names the owner, so a starter that arrives during its boot waits on it.
  // Even if this starter dies before this write lands and another starter spawns a second
  // owner, RollOwner.claimHeartbeat acquires ROLL_OWNER_FILE exclusively before rolling.
  writeOwnedJson(launchPath, {
    pid: child.pid,
    at: new Date(now).toISOString(),
  } satisfies OwnerClaim);
  return { status: "started", pid: child.pid };
}

function claimExclusively(
  path: string,
  pid: number,
  now: number,
  alive: (pid: number) => boolean,
  freshMs = LAUNCH_FRESH_MS,
): boolean {
  const body = JSON.stringify({
    pid,
    at: new Date(now).toISOString(),
  } satisfies OwnerClaim);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, body, { mode: 0o600, flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (claimFresh(readClaim(path), freshMs, alive, now)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

/** The build an installed root (or a checkout) describes; shared with the Paseo bridge. */
export function resolveExpectedBuild(sourcePath: string | null): {
  expected: string | Error;
  digest: string | null;
  pluginBuild: string | null;
} {
  try {
    const root = sourcePath ?? sourcePathFromModule();
    const installed = existsSync(join(root, "manifest.json"))
      ? JSON.parse(readFileSync(join(root, "build.json"), "utf8"))
      : null;
    const digest: string | null =
      installed?.revision ?? backendSourceDigest(root);
    const expected: string | Error =
      installed?.buildId ?? serviceBuildIdentity(root, undefined, digest!);
    return {
      expected,
      digest,
      pluginBuild: typeof expected === "string" ? expected : null,
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return { expected: failure, digest: null, pluginBuild: null };
  }
}

/**
 * The owner itself. `run()` resolves when the owner has exited: after an idle
 * window with no service and no pending roll, after a handover to a newer
 * installed version, or when another live owner holds the data home.
 */
export class RollOwner {
  readonly dataDir: string;
  private readonly processActions: BridgeProcessActions;
  readonly options: BridgeOptions;
  readonly session: BridgeSession;
  readonly spawner: ServiceSpawner;
  readonly roll: RollScheduler;
  private readonly sourcePath: string;
  private readonly idleExitMs: number;
  private readonly ownerToken = randomUUID();
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private nextRollCheckAt = 0;
  private idleSince = Date.now();
  private finish: (() => void) | null = null;
  private exitReason: string | null = null;
  private closed = false;

  /**
   * The options are the roll's own (the same shape the roll has always read):
   * `dataDir` and `sourcePath` default to this install, `processActions` to the
   * production bindings. The production entry adds only the BB plugin step.
   */
  constructor(options: Partial<BridgeOptions> = {}) {
    this.dataDir = options.dataDir ?? dataHome();
    this.processActions = options.processActions ?? bridgeProcessActions;
    this.options = {
      ...options,
      processActions: this.processActions,
    } as BridgeOptions;
    this.sourcePath = options.sourcePath ?? sourcePathFromModule();
    const { expected, digest, pluginBuild } = resolveExpectedBuild(
      this.sourcePath,
    );
    this.session = new BridgeSession(
      expected,
      pluginBuild,
      this.sourcePath,
      digest,
    );
    if (expected instanceof Error)
      this.session.report("unhealthy", expected.message);
    this.spawner = new ServiceSpawner({
      options: this.options,
      dataDir: this.dataDir,
      processActions: this.processActions,
      session: this.session,
      connect: (info, connectOptions) => this.connect(info, connectOptions),
      // The spawned service reads the same host home this owner's composition
      // supplies; the shared roll itself names no host variable.
      hostEnvironment: () =>
        this.processActions.hostEnvironment(this.options.hostHome),
      currentSession: () => currentLoginSession(),
    });
    this.roll = new RollScheduler({
      options: this.options,
      dataDir: this.dataDir,
      session: this.session,
      processActions: this.processActions,
      ensure: () => this.ensure(),
    });
    this.idleExitMs = options.ownerIdleExitMs ?? ROLL_OWNER_IDLE_EXIT_MS;
  }

  /** Keep one service connection; reconnect through the spawner's compatibility rules. */
  async ensure(): Promise<ServiceClient> {
    if (this.session.client?.connected) return this.session.client;
    return this.spawner.ensureOnce();
  }

  /**
   * Connect without a presence claim: the owner is not a host, so it never holds
   * the one bridge presence (that would keep a host-less service from idling out).
   */
  private async connect(
    info: ServiceInfo,
    _options?: { claimPresence?: boolean },
  ): Promise<ServiceClient | null> {
    const buildId = this.session.buildId();
    const client = new ServiceClient({
      socketPath: info.socketPath,
      credential: info.credential,
      requestTimeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      const health = (await client.request(
        "service.health",
        {},
        CONNECT_ATTEMPT_TIMEOUT_MS,
      )) as Record<string, unknown>;
      if (
        health["protocolVersion"] !== SERVICE_PROTOCOL_VERSION ||
        health["buildId"] !== buildId
      ) {
        await client.close();
        this.session.report(
          "incompatible",
          `Service reports build ${String(health["buildId"] ?? "unknown")}; owner expects ${buildId}`,
        );
        return null;
      }
      this.session.attach(client, health, false);
      try {
        this.processActions.removeServiceStartupFailure(this.dataDir);
      } catch {
        /* readiness is authoritative */
      }
      await this.roll.settleLandedRoll(buildId);
      return client;
    } catch {
      client.close();
      return null;
    }
  }

  /** The service this owner serves is alive: its identity names a live process. */
  serviceAlive(): boolean {
    const info = readServiceInfo(this.dataDir);
    return Boolean(info && this.processActions.pidAlive(info.pid));
  }

  /** An unfinished roll: a record still in flight, or an activation waiting to converge. */
  pending(): boolean {
    return (
      this.roll.hasPendingActivation() ||
      rollInProgress(readServiceRoll(this.dataDir))
    );
  }

  /** One roll check, as the owner's own loop runs it; see ./roll.ts for the rule. */
  checkSource(force = false): Promise<ServiceRoll | null> {
    return this.roll.checkSource(force);
  }

  /** Stop the owner's timers without a handover; used by fixtures that drive it directly. */
  close(): void {
    this.exit("closed");
  }

  /** Run the owner until it exits; resolves with the reason. */
  async run(): Promise<string> {
    if (this.session.expected instanceof Error)
      return `not started: ${this.session.expected.message}`;
    const claimed = this.claimHeartbeat();
    if (claimed) return claimed;
    try {
      await this.roll.resumeInstalled(this.sourcePath);
    } catch (error) {
      this.writeNote(
        `resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return await new Promise<string>((resolve) => {
      this.finish = () => resolve(this.exitReason ?? "closed");
      this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
      void this.tick();
    });
  }

  /**
   * One owner per data home: acquire `ROLL_OWNER_FILE` exclusively (`linkSync`)
   * before resuming or rolling. If a starter died before updating its launch
   * claim and two owners raced to start, exactly one wins this file and the
   * loser exits immediately without touching the winner's claim.
   */
  private claimHeartbeat(): string | null {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, ROLL_OWNER_FILE);
    const claim = (): OwnerClaim => ({
      pid: process.pid,
      at: new Date().toISOString(),
      root: this.sourcePath,
      token: this.ownerToken,
    });
    const ownedByOther = (held: OwnerClaim | null, now: number): boolean =>
      Boolean(
        held &&
          held.token !== this.ownerToken &&
          claimFresh(held, OWNER_FRESH_MS, this.processActions.pidAlive, now),
      );
    try {
      writeOwnedJson(path, claim(), { exclusive: true });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const now = Date.now();
    const held = readClaim(path);
    if (ownedByOther(held, now)) {
      return `another roll owner (pid ${held!.pid}) holds this data home`;
    }
    // Stale or corrupt heartbeat: serialize reclamation through a short-lived
    // exclusive guard so two concurrent reclaimers cannot unlink each other's
    // newly linked claim.
    const reclaimPath = join(this.dataDir, ROLL_OWNER_RECLAIM_FILE);
    if (
      !claimExclusively(
        reclaimPath,
        process.pid,
        now,
        this.processActions.pidAlive,
        RECLAIM_FRESH_MS,
      )
    ) {
      const winner = readClaim(path) ?? readClaim(reclaimPath);
      return `another roll owner (pid ${winner?.pid ?? "unknown"}) holds this data home`;
    }
    try {
      const current = readClaim(path);
      if (ownedByOther(current, Date.now())) {
        return `another roll owner (pid ${current!.pid}) holds this data home`;
      }
      rmSync(path, { force: true });
      writeOwnedJson(path, claim(), { exclusive: true });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const winner = readClaim(path);
        return `another roll owner (pid ${winner?.pid ?? "unknown"}) holds this data home`;
      }
      throw error;
    } finally {
      rmSync(reclaimPath, { force: true });
    }
  }

  private ownsHeartbeat(held: OwnerClaim | null): boolean {
    return Boolean(
      held &&
        held.pid === process.pid &&
        (!held.token || held.token === this.ownerToken),
    );
  }

  private heartbeat() {
    if (this.closed) return;
    const path = join(this.dataDir, ROLL_OWNER_FILE);
    const held = readClaim(path);
    if (
      held &&
      !this.ownsHeartbeat(held) &&
      claimFresh(held, OWNER_FRESH_MS, this.processActions.pidAlive, Date.now())
    ) {
      this.exit(`roll owner claim lost to pid ${held.pid}`);
      return;
    }
    try {
      writeOwnedJson(path, {
        pid: process.pid,
        at: new Date().toISOString(),
        root: this.sourcePath,
        token: this.ownerToken,
      } satisfies OwnerClaim);
    } catch {
      /* the heartbeat is advisory to starters; the owner keeps working */
    }
  }

  private writeNote(note: string) {
    try {
      process.stderr.write(`roll owner: ${note}\n`);
    } catch {
      /* the log is advisory */
    }
  }

  /** Each tick: the service's roll request, the roll check on its interval, and the exit rules. */
  private async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const alive = this.serviceAlive();
      const pending = this.pending();
      if (!alive && !pending) {
        if (Date.now() - this.idleSince >= this.idleExitMs)
          return this.exit("no service and no pending roll; idle exit");
        return;
      }
      this.idleSince = Date.now();
      if (alive) {
        const request = this.processActions.consumeServiceRollRequest(
          this.dataDir,
        );
        if (request) {
          await this.roll.checkSource(request.force);
          return;
        }
      }
      // An unfinished replacement is retried on each tick, not left for a request:
      // connecting settles a landed replacement and finishes an interrupted one.
      const roll = readServiceRoll(this.dataDir);
      if (
        rollInProgress(roll) &&
        (roll.status === "replacing" || roll.status === "retrying")
      )
        await this.ensure().catch(() => {});
      if (Date.now() >= this.nextRollCheckAt) {
        this.nextRollCheckAt =
          Date.now() + (this.options.rollCheckMs ?? ROLL_CHECK_MS);
        await this.roll.checkSource();
      }
      if (this.handedOver())
        return this.exit(
          "a newer installed version is current; handing the owner over",
        );
    } catch (error) {
      this.writeNote(error instanceof Error ? error.message : String(error));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * After a roll activates a newer version, this owner's code is older than
   * `current`. Hand over to that version's owner once nothing is pending. Only an
   * installed owner (under the install base's versions) hands over; a checkout or
   * fixture never does.
   */
  private handedOver(): boolean {
    if (this.pending()) return false;
    try {
      const versions = realpathSync(join(installBase(), "versions"));
      const root = realpathSync(this.sourcePath);
      if (!root.startsWith(versions + sep)) return false;
      const current = realpathSync(join(installBase(), "current"));
      return current !== root;
    } catch {
      return false;
    }
  }

  /** Stop the timers, release the heartbeat and resolve `run()`. */
  exit(reason: string): void {
    if (this.closed) return;
    this.exitReason = reason;
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = this.heartbeatTimer = null;
    this.session.dropClient();
    if (this.handedOver()) {
      // Clear our heartbeat and any launch claim naming this process: this process is
      // still alive while it hands over, so its own claim would read as a fresh launch.
      if (this.ownsHeartbeat(readClaim(join(this.dataDir, ROLL_OWNER_FILE)))) {
        rmSync(join(this.dataDir, ROLL_OWNER_FILE), { force: true });
      }
      if (
        readClaim(join(this.dataDir, ROLL_OWNER_LAUNCH_FILE))?.pid ===
        process.pid
      )
        rmSync(join(this.dataDir, ROLL_OWNER_LAUNCH_FILE), { force: true });
      try {
        ensureRollOwner({
          dataDir: this.dataDir,
          root: join(installBase(), "current"),
        });
      } catch (error) {
        this.writeNote(
          `handover could not start the current owner: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      const held = readClaim(join(this.dataDir, ROLL_OWNER_FILE));
      if (this.ownsHeartbeat(held))
        rmSync(join(this.dataDir, ROLL_OWNER_FILE), { force: true });
    }
    this.finish?.();
  }
}

/**
 * Entry for `bin/queue-roll-owner.mjs`: run the owner for this install's data
 * home. Resolves with the exit reason; the process exits after it.
 */
export async function runRollOwnerEntry(
  argv: string[],
  root: string,
): Promise<string> {
  const dataDirArg = argv
    .find((value) => value.startsWith("--data-dir="))
    ?.slice("--data-dir=".length);
  const owner = new RollOwner({
    dataDir: dataDirArg ?? dataHome(),
    sourcePath: root,
    processActions: bridgeProcessActions,
    bbPluginRoll: (input) => bbPluginRoll(input),
  });
  const reason = await owner.run();
  return reason;
}
