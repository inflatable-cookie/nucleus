import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runtimeNodeArgs } from "../../../shared/runtime.mjs";
import { readServiceExecutorFault, readServiceInfo, readServiceRoll, sessionsDiffer, type ServiceInfo } from "../../../shared/service/discovery";
import { ServiceClient } from "../../../shared/service/client";
import { awaitForeignReplacement, awaitStandbyProgress, SPAWN_TOKEN_ENV, STANDBY_ENV, STANDBY_READY_BUDGET_MS, STANDBY_READY_CAP_MS, STANDBY_READY_STALL_MS } from "../../../shared/service/standby-wait";
import type { BridgeProcessActions } from "../../../shared/service/bridge-process";
import { SERVICE_PROTOCOL_VERSION } from "../../../shared/service/build";
import { CONNECT_ATTEMPT_TIMEOUT_MS, type BridgeOptions } from "./options";
import { BridgeSession, ServiceBridgeUnavailable, type StandbyReadiness } from "./session";
import { captureStartupChunk, newStartupCapture, safeSpawnErrorCode, sealStartupCapture, startupFailureRecord, startupFailureSummary, type StartupCapture } from "./startup-output";

export const SPAWN_CLAIM_FILE = "queue-service.claim.json";
const CLAIM_FRESH_MS = 45_000;
/** A warm standby starts the moment the old pid exits; poll tightly so the endpoint gap stays small. */
const STANDBY_POLL_MS = 25;
const UPGRADE_POLL_MS = 250;
const UPGRADE_TIMEOUT_MS = 60_000;
/** A roll handoff older than this is not waited on; it is treated as stale. */
const ROLL_HANDOFF_WINDOW_MS = UPGRADE_TIMEOUT_MS + 15_000;

export class StandbyStartupError extends Error {}

interface SpawnClaim { pid: number; at: string }
interface SpawnAttempt { claimPath: string; claimed: boolean; child: ChildProcess | null; startup: StartupCapture | null; token?: string }

/** Everything the spawner needs that it does not own: the process bindings and the bridge's own connect. */
export interface SpawnContext {
  options: BridgeOptions;
  dataDir: string;
  processActions: BridgeProcessActions;
  session: BridgeSession;
  /** The bridge's authenticated connect attempt; it owns the presence claim. */
  connect(info: ServiceInfo, options?: { claimPresence?: boolean }): Promise<ServiceClient | null>;
  paseoHome(): string;
  currentSession(): string;
}

/**
 * Establishes the service this bridge talks to.
 *
 * One owner for the whole handover: the single spawn claim that makes two racing
 * bridges impossible, the warm standby that loads its modules before the old
 * service is drained, the bounded drain and readiness waits, and the wait for a
 * handoff another bridge started. It never duplicates an owner it cannot prove
 * absent: a live pid that does not answer is reported, a fresh foreign claim is
 * waited on, and a standby that fails keeps the running service.
 */
export class ServiceSpawner {
  constructor(private readonly core: SpawnContext) {}

  private get session() { return this.core.session; }

  /** Establish a compatible service: reuse, wait for another bridge's handoff, replace or spawn. */
  async ensureOnce(): Promise<ServiceClient> {
    const buildId = this.session.buildId();
    if (!this.session.handoff) {
      const settled = await this.awaitForeignHandoff();
      if (settled) return settled;
    }
    const info = readServiceInfo(this.core.dataDir);
    if (!info) return this.spawnService("no service identity file");
    if (!this.core.processActions.pidAlive(info.pid)) return this.handleUnreachable(info);
    if (info.protocolVersion !== SERVICE_PROTOCOL_VERSION || info.buildId !== buildId || sessionsDiffer(info.sessionId, this.core.currentSession())) {
      if (info.protocolVersion === SERVICE_PROTOCOL_VERSION) return this.replaceIncompatible(info);
      this.session.markUnhealthy("Bridge is on standby until a compatible service can prove bridge presence");
      throw new ServiceBridgeUnavailable("unhealthy", "Bridge is on standby until a compatible service can prove bridge presence");
    }
    const client = await this.core.connect(info);
    if (client) return client;
    // Connect or health failed: a live pid is an owner we must not duplicate
    // (nucleus#972). A refused presence claim keeps the client inside tryConnect
    // and is retried from ensure until it is granted.
    return this.handleUnreachable(info);
  }

  /** Socket unreachable: distinguish starting, stale and unhealthy without duplicating a spawn. */
  private async handleUnreachable(info: ServiceInfo): Promise<ServiceClient> {
    if (this.core.processActions.pidAlive(info.pid)) {
      // A live process owns the socket path but is not answering; it may be
      // starting or stalled. Never spawn a second owner over an uncertain one.
      const ageMs = Date.now() - Date.parse(info.startedAt);
      const detail = `Service pid ${info.pid} is alive but not answering on ${info.socketPath}`;
      this.session.report(ageMs < 15_000 ? "starting" : "unhealthy", detail);
      // A persistence executor death leaves the process alive; the recorded cause names it.
      const fault = readServiceExecutorFault(this.core.dataDir);
      if (fault?.pid === info.pid) this.session.detail = `${detail}; executor ${fault.kind} at ${fault.at}${fault.exitCode === null ? "" : ` (exit code ${fault.exitCode})`}: ${fault.message}`;
      throw new Error(this.session.detail);
    }
    // Dead owner: stale files are reclaimable and the spawn is definitely safe.
    rmSync(info.socketPath, { force: true });
    return this.spawnService("recorded service pid is gone");
  }

  /**
   * A plugin reload during a roll leaves a *new* bridge watching a handoff it did
   * not start: `queue-service-roll.json` says `replacing` and the old bridge's
   * detached standby may still be taking the lease. Spawning here raced two
   * owners on 2026-10-04 (the second unlinked the live scheduler socket when it
   * stopped). Wait for the handoff to settle instead; if it does not settle
   * inside the bounded window the caller refuses with a clear message rather
   * than spawn over an uncertain owner. A stale `replacing` record is ignored.
   */
  private async awaitForeignHandoff(): Promise<ServiceClient | null> {
    const roll = readServiceRoll(this.core.dataDir);
    if (roll?.status !== "replacing" || Date.now() - Date.parse(roll.at) > ROLL_HANDOFF_WINDOW_MS) return null;
    this.session.report("starting", "a Queue service roll handoff is in progress; waiting for it to settle");
    const deadline = Date.now() + (this.core.options.handoffWaitMs ?? UPGRADE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (readServiceRoll(this.core.dataDir)?.status !== "replacing") return null;
      await sleep(UPGRADE_POLL_MS);
      const info = readServiceInfo(this.core.dataDir);
      if (!info) continue;
      const client = await this.core.connect(info);
      if (client) return client;
    }
    const detail = "a Queue service roll handoff did not settle; refusing to spawn a second owner";
    this.session.markUnhealthy(detail);
    throw new Error(detail);
  }

  private incompatibleDetail(info: ServiceInfo): string {
    if (info.protocolVersion !== SERVICE_PROTOCOL_VERSION || info.buildId !== this.session.buildId()) {
      return `Service build ${info.buildId} does not match the bridge build ${this.session.buildId()}`;
    }
    return `Service login session ${info.sessionId ?? "unrecorded"} does not match this bridge session ${this.core.currentSession()}`;
  }

  /** Incompatible build or login session: request bounded drain, observe release, then replace. */
  private async replaceIncompatible(info: ServiceInfo): Promise<ServiceClient> {
    // While this bridge owns the handoff, its own `ensure` must not wait on the
    // `replacing` record it just wrote.
    const previous = this.session.handoff;
    this.session.handoff = true;
    try { return await this.replaceIncompatibleInner(info); }
    finally { this.session.handoff = previous; }
  }

  private async replaceIncompatibleInner(info: ServiceInfo): Promise<ServiceClient> {
    this.session.report("incompatible", this.incompatibleDetail(info));
    const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential, requestTimeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS });
    let drainable = false;
    try {
      await client.connect();
      drainable = true;
    } catch {
      client.close();
      if (!this.core.processActions.pidAlive(info.pid)) return this.spawnService("incompatible service is gone");
      // Live owner, socket already gone (a roll drain released it): spawn as a
      // standby for that pid rather than fighting the processOwner lease.
      this.session.detail = `Incompatible service is alive but not answering; starting a standby for pid ${info.pid}`;
    }
    // Presence is not re-probed here: the bridge's own serving connection holds
    // the one claim, so a second-socket probe would collide with it (nucleus#971
    // removed the cutover-window gate). Which bridge owns this replacement is
    // arbitrated below by the spawn claim alone.
    // Warm standby: the replacement loads its modules and reports readiness while
    // the old service still serves, then waits for that pid to exit before it opens
    // the store. Wait for the readiness marker before the drain, so the host-run
    // endpoint gap is the store open and bind alone, not the standby's module load.
    const standby = this.startSpawn("incompatible service is draining", info.pid);
    this.session.lastStandbyReadiness = null;
    // Another live bridge holds the spawn claim, so it owns this replacement and its
    // warm standby. Draining here would stop the old service while that standby is
    // still loading (papercut a6c9a2ac: a 16 s endpoint gap), so only its owner
    // drains; this bridge waits for the owner's replacement instead.
    if (!standby.claimed) {
      client.close();
      this.session.detail = "Another bridge is replacing the incompatible service; waiting for its replacement";
      const replaced = await this.awaitForeignReplacement(standby, info.pid);
      if (replaced) return replaced;
      const detail = "Another bridge's replacement of the incompatible service did not become ready while its spawn claim was live";
      this.session.markUnhealthy(detail);
      throw new Error(detail);
    }
    if (standby.child) {
      this.session.detail = "Waiting for the warm standby to report loaded before draining the incompatible service";
      const readiness = await this.awaitStandbyWarm(standby, info.pid);
      this.session.lastStandbyReadiness = readiness;
      if (readiness && !readiness.warm && readiness.cause !== "exited") {
        // Bounded fallback: never block the roll forever on a standby that never reports.
        console.warn(`Queue standby did not report loaded inside ${readiness.waitedMs} ms (${readiness.cause}); draining the old service anyway and expecting a longer endpoint gap`);
      }
    }
    // Exit (including a spawn error) is a failed build, never a cold-start fallback.
    // Wait for pipe close so the durable error includes the child's final stderr.
    if (!standby.child || standby.child.exitCode !== null || standby.child.signalCode !== null || standby.startup?.spawnError) {
      if (standby.child && !standby.startup?.closed) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1000);
          standby.child!.once("close", () => { clearTimeout(timer); resolve(); });
        });
      }
      if (standby.startup) sealStartupCapture(standby.startup);
      const failure = startupFailureRecord(standby.startup, "standby exited before drain");
      if (failure) { try { this.core.processActions.writeServiceStartupFailure(this.core.dataDir, failure); } catch { /* advisory */ } }
      client.close();
      this.abandonStandby(standby);
      throw new StandbyStartupError(`Standby failed; kept the running service: ${failure ? startupFailureSummary(failure) : "child did not start"}`);
    }
    if (drainable) {
      try {
        // An old service that already exited (another bridge drained it during the
        // standby wait) needs no drain; the wait below sees its pid gone.
        // Presence is not re-probed: the serving connection holds the one claim
        // (nucleus#971). A connect that never succeeded has no drain to observe.
        if (!client.connected) throw new Error("bridge presence changed during replacement");
        if (this.core.processActions.pidAlive(info.pid)) await client.request("service.drain", this.session.rollNote ? { roll: this.session.rollNote } : {}, CONNECT_ATTEMPT_TIMEOUT_MS);
      } catch (error) {
        // A service that exited during the request is drained: the wait below finishes the spawn.
        if (this.core.processActions.pidAlive(info.pid)) {
          client.close();
          this.abandonStandby(standby);
          const detail = `Incompatible service did not accept a bounded drain: ${error instanceof Error ? error.message : String(error)}`;
          this.session.markUnhealthy(detail);
          throw new Error(detail);
        }
      }
    }
    this.session.report("upgrading", "Waiting for the incompatible service to drain and release its lease");
    const deadline = Date.now() + UPGRADE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(standby.child ? STANDBY_POLL_MS : UPGRADE_POLL_MS);
      if (!this.core.processActions.pidAlive(info.pid)) return this.finishSpawn("incompatible service exited and released its lease", standby);
      // Without a standby the old process may release identity and socket before it exits.
      if (!standby.child && !readServiceInfo(this.core.dataDir) && !existsSync(info.socketPath)) return this.finishSpawn("incompatible service drained and released its lease", standby);
    }
    const detail = "Incompatible service did not release its socket and lease inside the bounded upgrade window";
    this.session.markUnhealthy(detail);
    this.abandonStandby(standby);
    throw new Error(detail);
  }

  /**
   * Wait for a spawned standby to report that its modules are loaded and it is
   * parked on the old pid. Draining before then makes the endpoint gap include the
   * standby's remaining module load; waiting makes the gap the store open and bind.
   * Bounded by progress on the exact spawned child: a standby that exits, stops
   * using CPU or reaches the hard cap ends the wait; exited standbys abort the roll.
   */
  private async awaitStandbyWarm(attempt: SpawnAttempt, replaced: number): Promise<StandbyReadiness> {
    const child = attempt.child!, pid = child.pid!;
    const result = await awaitStandbyProgress({
      ready: () => this.core.processActions.standbyIsReady(this.core.dataDir, pid),
      alive: () => child.exitCode === null && child.signalCode === null,
      replacedExited: () => !this.core.processActions.pidAlive(replaced),
      cpuMs: () => this.core.processActions.processCpuMs(pid),
      now: () => performance.now(),
      sleep: async ms => { await sleep(ms); },
      // The wait may outlast CLAIM_FRESH_MS: keep the spawn claim fresh, as the
      // post-drain readiness wait does, so no other bridge spawns beside this standby.
      tick: () => { if (attempt.claimed) refreshClaim(attempt.claimPath, this.core.processActions.writeOwnedJson); },
    }, {
      stallMs: this.core.options.standbyReadyStallMs ?? STANDBY_READY_STALL_MS,
      capMs: this.core.options.standbyReadyCapMs ?? STANDBY_READY_CAP_MS,
      budgetMs: this.core.options.standbyReadyBudgetMs ?? STANDBY_READY_BUDGET_MS,
      pollMs: STANDBY_POLL_MS,
    });
    return { ...result, pid, at: new Date().toISOString() };
  }

  /** Spawn only from the exact installed checkout when the service is definitely absent. */
  spawnService(reason: string): Promise<ServiceClient> {
    if (this.session.closed) throw new ServiceBridgeUnavailable("unhealthy", "this bridge is closed and cannot start the service");
    const info = readServiceInfo(this.core.dataDir);
    const standbyFor = info && this.core.processActions.pidAlive(info.pid) ? info.pid : undefined;
    return this.finishSpawn(reason, this.startSpawn(reason, standbyFor));
  }

  /**
   * Take the spawn claim and start the process. A fresh claim from another live
   * bridge suppresses our own spawn: we wait for that bridge's service to become
   * ready instead of duplicating an uncertain spawn. `standbyFor` starts the
   * process as a warm standby that waits for that service pid to exit before it
   * touches the store, callbacks or the host-run endpoint.
   */
  private startSpawn(reason: string, standbyFor?: number): SpawnAttempt {
    if (this.session.closed) throw new ServiceBridgeUnavailable("unhealthy", "this bridge is closed and cannot start the service");
    this.session.report("absent", reason);
    const claimPath = join(this.core.dataDir, SPAWN_CLAIM_FILE);
    mkdirSync(this.core.dataDir, { recursive: true, mode: 0o700 });
    const attempt: SpawnAttempt = { claimPath, claimed: false, child: null, startup: null };
    // Atomic claim: only one bridge can create the file, so two racing bridges
    // never both spawn; the loser waits for the winner's service instead.
    for (let tries = 0; tries < 2 && !attempt.claimed; tries++) {
      try {
        const fd = openSync(claimPath, "wx", 0o600);
        try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } as SpawnClaim)); } finally { closeSync(fd); }
        attempt.claimed = true;
        this.session.report("starting", "Waiting for the spawned service to become ready");
        try {
          attempt.child = this.spawnProcess(attempt, standbyFor);
        } catch {
          rmSync(claimPath, { force: true });
          // A synchronous spawn/setup failure is returned through finishSpawn so
          // it follows the same durable, bounded diagnostic path as child exit.
        }
      } catch (error) {
        if (attempt.claimed) throw error;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          rmSync(claimPath, { force: true });
          throw error;
        }
        // A stale claim (dead writer, malformed, or older than the fresh window)
        // is provably not an owner: reclaim it instead of blocking forever.
        if (this.readClaim(claimPath)) {
          // Another live bridge owns the claim: it may be spawning already. Wait
          // for its service to publish readiness; never spawn a second owner.
          this.session.report("starting", "another bridge holds a fresh spawn claim; waiting for its service");
          break;
        }
        // readClaim found a stale/dead claim; remove it and retry the exclusive create once.
        rmSync(claimPath, { force: true });
      }
    }
    return attempt;
  }

  /** Wait for the spawned service to answer; our own claim is cleaned on every exit path. */
  private async finishSpawn(reason: string, attempt: SpawnAttempt): Promise<ServiceClient> {
    try {
      const client = await this.awaitReadiness(this.core.options.readinessBudgetMs ?? 20_000, attempt);
      if (client) {
        if (attempt.startup) sealStartupCapture(attempt.startup);
        if (attempt.claimed) rmSync(attempt.claimPath, { force: true });
        return client;
      }
      this.session.state = "unhealthy";
      if (attempt.startup) sealStartupCapture(attempt.startup);
      const failure = startupFailureRecord(attempt.startup, reason);
      if (failure) {
        try { this.core.processActions.writeServiceStartupFailure(this.core.dataDir, failure); } catch { /* the in-memory service state still reports the evidence */ }
        this.session.detail = `Spawned service did not become ready within the bounded window (${reason}); child startup: ${startupFailureSummary(failure)}`;
      } else {
        this.session.detail = `Spawned service did not become ready within the bounded window (${reason})`;
      }
      throw new Error(this.session.detail);
    } catch (error) {
      // Only our own claim is ours to release; a foreign claim stays with its owner.
      if (attempt.claimed) rmSync(attempt.claimPath, { force: true });
      throw error;
    }
  }

  /** A standby whose roll failed never took the lease; stop it and release the claim and its marker. */
  private abandonStandby(attempt: SpawnAttempt) {
    if (!attempt.claimed) return;
    if (attempt.child?.pid) {
      this.core.processActions.clearStandbyReady(this.core.dataDir, attempt.child.pid);
      try { process.kill(attempt.child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    rmSync(attempt.claimPath, { force: true });
  }

  /**
   * Poll for a publishable service identity and a compatible connection. Time the
   * spawned child reports spending on its own bounded start-up work — a store migration and
   * then the one-shot store-maintenance window, snapshot, rewrite and verification included —
   * does not count against the budget (each capped and each counted once), so a start the
   * service is allowed to take is waited for rather than retried beside. The bridge keeps its
   * spawn claim fresh while it waits, so no other bridge spawns over it.
   */
  private async awaitReadiness(budgetMs: number, attempt: SpawnAttempt): Promise<ServiceClient | null> {
    const now = this.core.options.readinessNow ?? Date.now;
    const startedAt = now();
    const pid = attempt.child?.pid;
    const deadline = () => startedAt + budgetMs + (pid ? this.core.processActions.startupExtensionMs(this.core.dataDir, pid, attempt.token, now()) : 0);
    try {
      while (now() < deadline()) {
        if (attempt.startup?.closed) return null;
        await sleep(this.core.options.readinessPollMs ?? 250);
        if (attempt.claimed) refreshClaim(attempt.claimPath, this.core.processActions.writeOwnedJson);
        const info = readServiceInfo(this.core.dataDir);
        if (!info) continue;
        const client = await this.core.connect(info);
        if (client) return client;
        if (attempt.startup?.closed) return null;
      }
      return null;
    } finally {
      if (pid) { this.core.processActions.clearMigration(this.core.dataDir, pid); this.core.processActions.clearMaintenance(this.core.dataDir, pid); }
    }
  }

  /**
   * Wait for another bridge's replacement under one hard cap fixed at entry: that
   * owner's own standby, upgrade and readiness windows. It never attaches to the
   * service being replaced, and never drains, kills or touches the owner's claim.
   */
  private async awaitForeignReplacement(attempt: SpawnAttempt, replacedPid: number): Promise<ServiceClient | null> {
    const result = await awaitForeignReplacement<ServiceClient>({
      // Only a replacement this bridge would accept on its own connect path: the
      // right protocol, build and login session, from a live process (review #601:
      // a waiter in another session must not adopt the owner's replacement).
      replacement: async () => {
        const info = readServiceInfo(this.core.dataDir);
        // Probe without claiming: the replacement belongs to the bridge whose
        // spawn claim is fresh, and it claims the new service itself when its
        // readiness wait connects. Adopting without the claim keeps the
        // waiter from starving that handoff.
        return info && info.pid !== replacedPid && this.serviceMatches(info) ? this.core.connect(info, { claimPresence: false }) : null;
      },
      claimFresh: () => claimIsFresh(attempt.claimPath, this.core.processActions.pidAlive),
      now: () => performance.now(),
      sleep: async ms => { await sleep(ms); },
    }, (this.core.options.standbyReadyCapMs ?? STANDBY_READY_CAP_MS) + UPGRADE_TIMEOUT_MS + (this.core.options.readinessBudgetMs ?? 20_000), UPGRADE_POLL_MS);
    return result.client;
  }

  /** The service is one this bridge may use as is: protocol, build and session match, and its process is alive. */
  private serviceMatches(info: ServiceInfo): boolean {
    return info.protocolVersion === SERVICE_PROTOCOL_VERSION && info.buildId === this.session.buildId()
      && !sessionsDiffer(info.sessionId, this.core.currentSession()) && this.core.processActions.pidAlive(info.pid);
  }

  /** A fresh claim from a live process means another bridge may be spawning already. */
  private readClaim(claimPath: string): boolean {
    try {
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as SpawnClaim;
      if (typeof claim.pid !== "number" || typeof claim.at !== "string") throw new Error("Malformed claim");
      return this.core.processActions.pidAlive(claim.pid) && Date.now() - Date.parse(claim.at) < CLAIM_FRESH_MS;
    } catch {
      rmSync(claimPath, { force: true });
      return false;
    }
  }

  private spawnProcess(attempt: SpawnAttempt, standbyFor?: number): ChildProcess {
    attempt.token = randomUUID();
    const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: this.core.paseoHome(), QUEUE_LOGIN_SESSION: this.core.currentSession(), [SPAWN_TOKEN_ENV]: attempt.token };
    if (standbyFor) env[STANDBY_ENV] = String(standbyFor); else delete env[STANDBY_ENV];
    const capture = newStartupCapture(env);
    attempt.startup = capture;
    let child: ChildProcess;
    try {
      // The child serves the store this bridge resolved: pin it, like the main
      // channel does, so the child never re-resolves against a different answer.
      const childDataDir = `--data-dir=${this.core.dataDir}`;
      if (this.core.options.serviceCommand) {
        const { command, args } = this.core.options.serviceCommand();
        child = this.core.processActions.spawn(command, [...args, childDataDir], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
      } else {
        const sourcePath = this.session.sourcePath;
        if (!sourcePath || !existsSync(join(sourcePath, "bin", "queue-service.mjs"))) {
          throw new Error("Installed plugin source is missing the standalone Queue service entry");
        }
        const installed = existsSync(join(sourcePath, "manifest.json"));
        child = this.core.processActions.spawn(installed ? join(sourcePath, "runtime", "node") : process.execPath, [...(installed ? [] : runtimeNodeArgs()), join(sourcePath, "bin", "queue-service.mjs"), childDataDir], { detached: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: sourcePath });
      }
    } catch (error) {
      capture.spawnError = safeSpawnErrorCode(error);
      capture.closed = true;
      sealStartupCapture(capture);
      throw error;
    }
    capture.pid = child.pid ?? null;
    if (child.pid) this.core.options.onSpawn?.(child.pid);
    child.stdout?.on("data", chunk => captureStartupChunk(capture, "stdout", chunk));
    child.stderr?.on("data", chunk => captureStartupChunk(capture, "stderr", chunk));
    child.on("error", error => { capture.spawnError = safeSpawnErrorCode(error); });
    child.on("exit", (code, signal) => { capture.exitCode = code; capture.signal = signal; });
    child.on("close", (code, signal) => {
      capture.exitCode = code;
      capture.signal = signal;
      capture.closed = true;
      sealStartupCapture(capture);
    });
    child.unref();
    return child;
  }
}

/**
 * Read-only freshness of another bridge's spawn claim: unreadable or malformed
 * counts as not fresh, and the file is never removed (a waiter does not touch
 * a claim it does not own).
 */
export function claimIsFresh(claimPath: string, pidAlive: BridgeProcessActions["pidAlive"]): boolean {
  try {
    const claim = JSON.parse(readFileSync(claimPath, "utf8")) as SpawnClaim;
    return typeof claim.pid === "number" && typeof claim.at === "string" && pidAlive(claim.pid) && Date.now() - Date.parse(claim.at) < CLAIM_FRESH_MS;
  } catch { return false; }
}

/** Rewrite our own spawn claim with a fresh time; atomic, so a reader never sees a partial claim. */
function refreshClaim(claimPath: string, writeOwnedJson: BridgeProcessActions["writeOwnedJson"]) {
  try {
    writeOwnedJson(claimPath, { pid: process.pid, at: new Date().toISOString() } as SpawnClaim);
  } catch {
  }
}

export function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
