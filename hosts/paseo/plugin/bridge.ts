import { runtimeNodeArgs } from "../../../shared/runtime.mjs";
import { dataHome } from "../../../shared/data-home.mjs";
/**
 * Thin authenticated bridge between the Paseo backend and the standalone
 * Queue service (Contract 007 / Spec 013).
 *
 * The bridge owns no Queue state: it never opens SQLite, Git or hook runtime
 * modules, performs no repository or lifecycle work, and awaits no lifecycle
 * effect on the request path. It validates both ends with the shared
 * contracts, forwards catalogue methods to the local service and reports a
 * typed state when the service is absent, starting, incompatible, being
 * upgraded or unhealthy. It never starts an in-plugin fallback runtime.
 */
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { RPC_METHOD_NAMES, type RpcCatalogueEntry } from "../../../shared/rpc-catalogue";
import { SERVICE_PROTOCOL_VERSION, backendSourceDigest, sourcePathFromModule, serviceBuildIdentity } from "../../../shared/service/build";
import { pluginRegistration } from "../../../shared/plugin-discovery.mjs";
import { currentLoginSession, readServiceExecutorFault, readServiceInfo, readServiceRoll, readServiceStartupFailure, sessionsDiffer, type ServiceInfo, type ServiceStartupFailure, SERVICE_ROLL_REQUEST_FILE } from "../../../shared/service/discovery";
import type { ServiceRoll, ServiceRollDeferral } from "../../../shared/service-roll";
import { ServiceClient, ServiceRequestError } from "../../../shared/service/client";
import { CallNotSentError, callWithRollRecovery, confirmationRead, parseRequestOutcome, rollWaitWorthy } from "../../../shared/service/roll-recovery";
import { lifecycleSignalSchema } from "../../../shared/lifecycle-signal";
import { awaitForeignReplacement, awaitStandbyProgress, SPAWN_TOKEN_ENV, STANDBY_ENV, STANDBY_READY_BUDGET_MS, STANDBY_READY_CAP_MS, STANDBY_READY_STALL_MS, type StandbyWaitCause } from "../../../shared/service/standby-wait";

export type BridgeState = "absent" | "starting" | "running" | "incompatible" | "upgrading" | "unhealthy";

export const SPAWN_CLAIM_FILE = "queue-service.claim.json";
const CLAIM_FRESH_MS = 45_000;
const CONNECT_ATTEMPT_TIMEOUT_MS = 2_500;
/** Forwarded RPC window: covers the legacy compatibility waits (submit/task 15 s, handoff 60 s) with latency headroom. */
const FORWARDED_REQUEST_TIMEOUT_MS = 90_000;
/** Bounded projections stay short so a wedged service surfaces a typed state quickly. */
const PROJECTION_REQUEST_TIMEOUT_MS = 15_000;
const PROJECTION_METHODS = new Set(["queue.snapshot", "queue.ui-snapshot", "queue.detail", "queue.outcome", "queue.outcome-search", "queue.telemetry", "lanes"]);
const UPGRADE_POLL_MS = 250;
/** A warm standby starts the moment the old pid exits; poll tightly so the endpoint gap stays small. */
const STANDBY_POLL_MS = 25;
const UPGRADE_TIMEOUT_MS = 60_000;
/**
 * Bounded wait for a call that arrived mid-roll (reads re-answer, mutations
 * recover their recorded outcome): the roll's own readiness budget — warm
 * standby cap, upgrade window and spawn readiness — plus slack.
 */
const ROLL_CALL_WAIT_MS = 210_000;
/** A roll handoff older than this is not waited on; it is treated as stale. */
const ROLL_HANDOFF_WINDOW_MS = UPGRADE_TIMEOUT_MS + 15_000;
const ROLL_CHECK_MS = 30_000;
/** Wait this long after the last main revision change before rolling (Spec 035). */
export const ROLL_SETTLE_MS = 60_000;
/** Defer a due roll while a heavy run has an attached follower, up to this cap. */
export const ROLL_HEAVY_FOLLOWER_CAP_MS = 15 * 60_000;
const OUTPUT_TAIL_BYTES = 2_000;

class StandbyStartupError extends Error {}

type Command = { command: string; args: string[] };

import type { BridgeMainChannel, BridgeProcessActions } from "../../../shared/service/bridge-process";
export type { BridgeProcessActions } from "../../../shared/service/bridge-process";

export interface BridgeOptions {
  /** Process operations may be supplied by the host composition or fixtures. */
  processActions: BridgeProcessActions;
  /** Queue data directory; defaults to the one data-home resolver (`shared/data-home.mjs`). */
  dataDir?: string;
  paseoHome?: string;
  /** Installed plugin source path override (the exact checkout the service may be spawned from). */
  sourcePath?: string;
  /** Spawn command override for fixtures; defaults to `node --import tsx bin/queue-service.mjs` from the installed checkout. */
  serviceCommand?: () => { command: string; args: string[] };
  /** Readiness budget after a spawn; defaults to 20 s. */
  readinessBudgetMs?: number;
  /** Readiness and claim refresh polling interval (default 250 ms). */
  readinessPollMs?: number;
  /** Clock for the readiness budget; defaults to Date.now. */
  readinessNow?: () => number;
  /**
   * Standby readiness wait (see `awaitStandbyProgress`). While the standby's CPU
   * time can be measured, the bridge drains past it after `standbyReadyStallMs`
   * without CPU progress (default 5 s) or at `standbyReadyCapMs` (default 120 s,
   * never re-armed). `standbyReadyBudgetMs` is the wall-clock bound used only
   * when CPU time is never measurable (default 20 s, the pre-2026-10-22 bound).
   */
  standbyReadyStallMs?: number;
  standbyReadyCapMs?: number;
  standbyReadyBudgetMs?: number;
  /** Login-session identity override for fixtures; defaults to `currentLoginSession()`. */
  sessionId?: string;
  /** Main channel check interval for `watch()`; defaults to 30 s. */
  rollCheckMs?: number;
  /** Bounded wait for a foreign roll handoff a reload left behind; defaults to 60 s. */
  handoffWaitMs?: number;
  /** Quiet window after the last main revision change before a roll; defaults to 60 s. */
  rollSettleMs?: number;
  /** Cap on deferring a due roll while a heavy run has an attached follower; defaults to 15 min. */
  rollHeavyFollowerCapMs?: number;
  /** Bounded wait for a forwarded call to wait out a roll and answer from the replacement; defaults to the roll's own readiness budget. */
  rollCallWaitMs?: number;
  /** Test seam: whether a heavy run currently has an attached follower. */
  heavyFollowers?: () => boolean;
  /**
   * Command that reloads this plugin once a roll lands, so the bridge and UI load
   * the new contracts (release contract, step 5). Unset means no reload: only the
   * plugin entry opts in, so fixtures never reload the live plugin.
   */
  reloadPluginCommand?: () => Command;
  /**
   * Fixture ownership hook: called with the spawned child's pid the moment it
   * exists, before any identity file is published, so a test file's guard can
   * track and settle a service even when its startup never got that far.
   * Unset in production, where the service owns its own durable lifetime.
   */
  onSpawn?: (pid: number) => void;
}

interface SpawnClaim { pid: number; at: string }
interface SpawnAttempt { claimPath: string; claimed: boolean; child: ChildProcess | null; startup: StartupCapture | null; token?: string }
type CapturedStream = { pending: string; tail: Buffer };
type StartupCapture = {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  stdout: CapturedStream;
  stderr: CapturedStream;
  redactions: string[];
  closed: boolean;
  sealed: boolean;
};

/**
 * What the bridge observed about a standby before it drained the old service.
 * `warm` means the standby reported its modules loaded before the drain; a cold
 * observation records why the bridge drained anyway (`cause`).
 */
export interface StandbyReadiness {
  warm: boolean;
  cause: StandbyWaitCause;
  /** The standby's last measured cumulative CPU, or null when never measurable. */
  cpuMs: number | null;
  pid: number;
  waitedMs: number;
  at: string;
}

export class ServiceBridgeUnavailable extends Error {
  constructor(readonly state: BridgeState, detail: string) {
    super(`Queue service ${state}: ${detail}`);
  }
}

export class ServiceBridge {
  private client: ServiceClient | null = null;
  private readonly processActions: BridgeProcessActions;
  private state: BridgeState = "absent";
  private detail = "";
  private lastHealth: Record<string, unknown> | null = null;
  private ensurePromise: Promise<ServiceClient> | null = null;
  private readonly dataDir: string;
  private sourcePath: string | null;
  private expectedBuild: string | Error;
  /** Build the plugin loaded with; the UI bundle is this old until a plugin reload. */
  private readonly pluginBuild: string | null;
  private reloadedFor: string | null = null;
  /** Source revision the expected build describes, and the last revision whose main build failed. */
  private sourceDigest: string | null = null;
  private failedDigest: string | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private rollRequestTimer: NodeJS.Timeout | null = null;
  private rolling: Promise<ServiceRoll | null> | null = null;
  private rollAgain = false;
  private rollForced = false;
  private pendingDigest: string | null = null;
  private lastDigestChangeAt = 0;
  private heavyDeferSince = 0;
  private deferrals: ServiceRollDeferral[] = [];
  /**
   * Set while this bridge owns a roll handoff (spawn, drain, replacement wait).
   * A bridge that did not start the handoff waits for it instead of spawning a
   * second owner over an uncertain one (2026-10-04, a reload during a roll).
   */
  private handoff = false;
  private mainChannel: BridgeMainChannel | null | undefined;
  private installedReady: Promise<void> = Promise.resolve();
  private activateInstalled: (() => Promise<void>) | null = null;
  /** Set while a roll replaces the service, so the drain can record it on affected tasks. */
  private rollNote: { fromBuild: string; toBuild: string } | null = null;
  /** Latest standby readiness observation; a cold one explains a longer endpoint gap. */
  private lastStandbyReadiness: StandbyReadiness | null = null;
  /** A closed bridge is a released fixture or plugin owner: it never spawns again. */
  private closed = false;
  /** True only after this connection's `service.nucleus-bridge-presence` was granted. */
  private presenceClaimed = false;

  constructor(private readonly options: BridgeOptions) {
    this.processActions = options.processActions;
    this.dataDir = options.dataDir ?? dataHome();
    // The host's registry entry is the anchor that survives every loading format,
    // because it is a file the host wrote rather than a module URL: the bridge side
    // is loaded as a CJS bundle, where `import.meta` is empty. Fall back to the
    // module location for fixtures and direct runs.
    this.sourcePath = options.sourcePath ?? readInstalledSourcePath(this.paseoHome());
    try {
      const root = this.sourcePath ?? sourcePathFromModule();
      const installed = existsSync(join(root, "manifest.json")) ? JSON.parse(readFileSync(join(root, "build.json"), "utf8")) : null;
      this.sourceDigest = installed?.revision ?? backendSourceDigest(root);
      this.expectedBuild = installed?.buildId ?? serviceBuildIdentity(root, undefined, this.sourceDigest!);
    } catch (error) {
      this.expectedBuild = error instanceof Error ? error : new Error(String(error));
      this.state = "unhealthy";
      this.detail = this.expectedBuild.message;
    }
    this.pluginBuild = typeof this.expectedBuild === "string" ? this.expectedBuild : null;
    if (this.sourcePath && existsSync(join(this.sourcePath, "manifest.json"))) {
      this.installedReady = this.resumeInstalledRoll();
      // Preserve a readable service-state error rather than an unhandled rejection.
      void this.installedReady.catch(() => {});
    }
  }

  private async resumeInstalledRoll(): Promise<void> {
    const channel = this.mainChannel = await this.processActions.openMainChannel(this.sourcePath!);
    const pending = await channel?.pending();
    if (!channel || !pending) return;
    const staged = await this.processActions.verifyVersion(pending.root);
    await channel.proveStartup(staged);
    this.sourcePath = staged.root;
    this.expectedBuild = staged.buildId;
    this.sourceDigest = pending.target.key;
    this.activateInstalled = async () => {
      await this.processActions.activateVersion(staged.root);
      await channel.activated(pending.target);
    };
  }

  private expectedBuildId(): string {
    if (this.expectedBuild instanceof Error) throw new ServiceBridgeUnavailable("unhealthy", this.expectedBuild.message);
    return this.expectedBuild;
  }

  private currentSession(): string {
    return this.options.sessionId ?? currentLoginSession();
  }

  current(): { state: BridgeState; detail: string } { return { state: this.state, detail: this.detail }; }

  /** The last replacement's standby readiness, or null when this bridge spawned none. */
  standbyReadiness(): StandbyReadiness | null { return this.lastStandbyReadiness; }

  /** Typed state surface for operators; no fallback runtime, no SQLite inspection. */
  async serviceState(): Promise<{
    state: BridgeState; detail: string; buildId: string | null; pid: number | null; startedAt: string | null;
    ready: boolean | null; paused: boolean | null; hostId: string | null; error: string;
    bootstrap: { pending: boolean; startedAt: string | null };
    pluginBuildId: string | null; roll: ServiceRoll | null;
  }> {
    // State is a bounded authenticated observation, not the bridge instance's
    // initial cache. It also uses the same single-flight bootstrap as forwarding.
    try {
      const client = await this.ensure();
      this.lastHealth = await client.request("service.health", {}, CONNECT_ATTEMPT_TIMEOUT_MS) as Record<string, unknown>;
      this.state = "running";
      this.detail = "";
    } catch (error) {
      this.dropCachedClient();
      this.lastHealth = null;
      if (this.state === "running" || this.state === "absent") this.state = "unhealthy";
      this.detail = error instanceof Error ? error.message : String(error);
      const previousFailure = readServiceStartupFailure(this.dataDir);
      if (previousFailure && !this.detail.includes("child startup")) {
        this.detail = `${this.detail}; previous child startup: ${startupFailureSummary(previousFailure)}`;
      }
    }
    const health = this.lastHealth;
    const error = this.state === "running" ? String(health?.["startError"] ?? "") : this.detail;
    return {
      state: this.state, detail: this.detail,
      buildId: typeof health?.["buildId"] === "string" ? health["buildId"] as string : null,
      pid: typeof health?.["pid"] === "number" ? health["pid"] as number : null,
      startedAt: typeof health?.["startedAt"] === "string" ? health["startedAt"] as string : null,
      ready: typeof health?.["ready"] === "boolean" ? health["ready"] as boolean : null,
      paused: typeof health?.["paused"] === "boolean" ? health["paused"] as boolean : null,
      hostId: typeof health?.["hostId"] === "string" ? health["hostId"] as string : null,
      error,
      // A hung bootstrap is otherwise invisible: this is how the runtime wedged while
      // every surface reported ready.
      bootstrap: {
        pending: Boolean((health?.["bootstrap"] as { pending?: boolean } | undefined)?.pending),
        startedAt: (health?.["bootstrap"] as { startedAt?: string | null } | undefined)?.startedAt ?? null,
      },
      pluginBuildId: this.pluginBuild,
      roll: readServiceRoll(this.dataDir),
    };
  }

  /** Validate, forward, validate. Transport failures surface a typed state, never a guessed result.
   *
   * A call whose transport fails while a roll is underway does not fail the
   * caller: a read waits, bounded, for the replacement and answers from it; a
   * mutation carries a request key and returns the replacement's recorded
   * outcome for it (applied, refused, or proven not received, which alone may
   * resend). The CLI client recovers the same way (roll-recovery contract).
   */
  async forward(entry: RpcCatalogueEntry, input: unknown): Promise<unknown> {
    const validated = await (entry.contract.input as { parseAsync: (value: unknown) => Promise<unknown> }).parseAsync(input);
    const raw = await callWithRollRecovery({
      method: entry.name,
      mutating: entry.mutating,
      input: validated,
      waitMs: this.options.rollCallWaitMs ?? ROLL_CALL_WAIT_MS,
      attempt: async key => {
        let client: ServiceClient;
        try {
          client = await this.ensure();
        } catch (error) {
          throw new CallNotSentError(new ServiceBridgeUnavailable(this.state, error instanceof Error ? error.message : String(error)));
        }
        try {
          // Forwarded catalogue calls get a bounded window: short for projections,
          // wide enough for the legacy compatibility waits (submit/task 15 s, handoff 60 s).
          // Every forwarded request names this surface: the Paseo plugin bridge is how
          // the operator's Settings screen reaches the service, and the Settings-only
          // capacity rule allows `queue.capacity` from no other surface.
          return await client.request(entry.name, validated, PROJECTION_METHODS.has(entry.name) ? PROJECTION_REQUEST_TIMEOUT_MS : FORWARDED_REQUEST_TIMEOUT_MS, "paseo", key);
        } catch (error) {
          // The connection is no longer trustworthy: close and release it, then
          // surface the typed state. A timed-out client must not linger as an orphan.
          if (!(error instanceof ServiceRequestError) || ["timeout", "unavailable", "internal", "busy", "draining"].includes(error.code)) {
            this.dropCachedClient();
            this.state = "unhealthy";
            this.detail = error instanceof Error ? error.message : String(error);
          }
          throw error;
        }
      },
      awaitService: async remaining => {
        // A failed owned handover restores the old build before recovery reconnects.
        if (this.handoff && this.rolling) await this.rolling;
        if (!rollWaitWorthy(this.dataDir) && readServiceRoll(this.dataDir)?.status !== "failed") return null;
        // ensure() waits out the roll handoff or replacement itself; its refusal
        // names the roll, which is the recovery's bound. Its own windows are the
        // roll's readiness budget, so the recovery's remaining time only tightens it.
        void remaining;
        return await this.ensure();
      },
      askOutcome: async (waited, key) => parseRequestOutcome(await (waited as ServiceClient).request("service.request-outcome", { key }, CONNECT_ATTEMPT_TIMEOUT_MS)),
      confirmingRead: input2 => confirmationRead(entry.name, input2),
    });
    this.state = "running";
    this.detail = "";
    return await (entry.contract.output as { parseAsync: (value: unknown) => Promise<unknown> }).parseAsync(raw);
  }

  /**
   * Forward one bounded Paseo lifecycle hint to an already compatible running
   * service (Contract 007). Hints are best-effort scheduling signals: this never
   * spawns a service, never reports an error, never awaits a lifecycle effect
   * and returns whether a running service accepted the hint. An absent or
   * incompatible service simply sees no hint, and durable Queue facts plus the
   * bounded safety sweep remain authoritative.
   */
  async signal(input: unknown, timeoutMs = 5_000): Promise<boolean> {
    const parsed = lifecycleSignalSchema.safeParse(input);
    if (!parsed.success) return false;
    if (this.expectedBuild instanceof Error) return false;
    const info = readServiceInfo(this.dataDir);
    if (!info || info.protocolVersion !== SERVICE_PROTOCOL_VERSION || info.buildId !== this.expectedBuild || sessionsDiffer(info.sessionId, this.currentSession()) || !this.processActions.pidAlive(info.pid)) return false;
    const client = this.client?.connected ? this.client : await this.tryConnect(info);
    if (!client) return false;
    try {
      await client.request("service.lifecycle-signal", parsed.data, timeoutMs);
      return true;
    } catch {
      // A dropped hint is harmless: the next observation, callback or sweep
      // converges the same durable state without repeating any effect.
      return false;
    }
  }

  /** Ensure a compatible running service; concurrent callers share one attempt. */
  private async ensure(): Promise<ServiceClient> {
    if (this.closed) throw new ServiceBridgeUnavailable("unhealthy", "this bridge is closed and cannot start the service");
    await this.installedReady;
    this.expectedBuildId();
    if (this.client?.connected) {
      // A refused claim is retried on the retained connection until it is granted
      // (nucleus#972 / 971): otherwise hostPresenceClosed arms the plugin-lost
      // fault and this bridge never clears it.
      if (!this.presenceClaimed) await this.refreshPresenceClaim();
      if (this.client?.connected) return this.client;
    }
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureOnce().finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  private async ensureOnce(): Promise<ServiceClient> {
    const buildId = this.expectedBuildId();
    if (!this.handoff) {
      const settled = await this.awaitForeignHandoff();
      if (settled) return settled;
    }
    const info = readServiceInfo(this.dataDir);
    if (!info) return this.spawnService("no service identity file");
    if (!this.processActions.pidAlive(info.pid)) return this.handleUnreachable(info);
    if (info.protocolVersion !== SERVICE_PROTOCOL_VERSION || info.buildId !== buildId || sessionsDiffer(info.sessionId, this.currentSession())) {
      if (info.protocolVersion === SERVICE_PROTOCOL_VERSION) return this.replaceIncompatible(info);
      this.state = "unhealthy";
      throw new ServiceBridgeUnavailable("unhealthy", "Bridge is on standby until a compatible service can prove bridge presence");
    }
    const client = await this.tryConnect(info);
    if (client) return client;
    // Connect or health failed: a live pid is an owner we must not duplicate
    // (nucleus#972). A refused presence claim keeps the client inside tryConnect
    // and is retried from ensure until it is granted.
    return this.handleUnreachable(info);
  }

  private dropCachedClient() {
    const stale = this.client;
    this.client = null;
    this.presenceClaimed = false;
    stale?.close();
  }

  /** Re-request the one presence claim on the retained connection. */
  private async refreshPresenceClaim(): Promise<void> {
    const client = this.client;
    if (!client?.connected || this.presenceClaimed) return;
    try {
      const presence = await client.request("service.nucleus-bridge-presence", {}, CONNECT_ATTEMPT_TIMEOUT_MS) as { active?: unknown };
      this.presenceClaimed = presence?.active === true;
    } catch {
      if (!client.connected) this.dropCachedClient();
    }
  }

  private async tryConnect(info: ServiceInfo, { claimPresence = true }: { claimPresence?: boolean } = {}): Promise<ServiceClient | null> {
    const buildId = this.expectedBuildId();
    const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential, requestTimeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS });
    try {
      await client.connect();
      const health = await client.request("service.health", {}, CONNECT_ATTEMPT_TIMEOUT_MS) as Record<string, unknown>;
      if (health["protocolVersion"] !== SERVICE_PROTOCOL_VERSION || health["buildId"] !== buildId) {
        await client.close();
        this.state = "incompatible";
        this.detail = `Service reports build ${String(health["buildId"] ?? "unknown")}; bridge expects ${buildId}`;
        return null;
      }
      // The one presence claim (nucleus#971): a probe never takes it. A refused
      // claim still keeps this health-matching service for RPC (nucleus#972)
      // and is retried on the retained connection until granted, so the idle
      // clock and plugin-lost fault follow presence again.
      this.presenceClaimed = false;
      if (claimPresence) {
        const presence = await client.request("service.nucleus-bridge-presence", {}, CONNECT_ATTEMPT_TIMEOUT_MS) as { active?: unknown };
        this.presenceClaimed = presence?.active === true;
      }
      this.client = client;
      this.lastHealth = health;
      this.state = "running";
      this.detail = "";
      try { this.processActions.removeServiceStartupFailure(this.dataDir); } catch { /* readiness is authoritative even if cleanup fails */ }
      this.settleLandedRoll(buildId);
      return client;
    } catch {
      client.close();
      return null;
    }
  }

  /**
   * An unfinished roll has landed once its target build answers. A retried or
   * interrupted replacement names that build; a roll still deferred or
   * typechecking names only its source digest, and lands when a fresh bridge
   * loaded from that source replaced the service first (papercut 2f9f0b06: a
   * plugin reload inside the settle window left the record deferred for good).
   */
  private settleLandedRoll(buildId: string) {
    // Activation is a roll step: a service that answers is not landed while
    // `current` and the installer entrypoints are still pending.
    if (this.activateInstalled) return;
    const roll = readServiceRoll(this.dataDir);
    if (!roll) return;
    const named = (roll.status === "retrying" || roll.status === "replacing") && roll.toBuild === buildId;
    const overtaken = (roll.status === "deferred" || roll.status === "typechecking")
      && roll.toBuild === null && this.sourceDigest !== null && roll.digest === this.sourceDigest;
    let abandoned = roll.status === "retrying" && roll.toBuild !== buildId && !this.handoff;
    if (abandoned) {
      // A healthy old bridge is not evidence that another bridge's current
      // target was abandoned. Keep main-channel and claimed attempts visible.
      abandoned = !this.mainChannel && !claimIsFresh(join(this.dataDir, SPAWN_CLAIM_FILE), this.processActions.pidAlive);
      const root = this.sourcePath ?? sourcePathFromModule();
      try {
        const selected = existsSync(join(root, "manifest.json")) ? this.sourceDigest : backendSourceDigest(root);
        abandoned = abandoned && selected !== roll.digest;
      } catch { abandoned = false; }
    }
    if (!named && !overtaken && !abandoned) return;
    // `rolled` says the target build answered; only a roll's own `rolled` write
    // follows a passing roll typecheck, so these details name what is unproven.
    const detail = abandoned ? "The previous replacement attempt was superseded; the selected service is healthy"
      : roll.status === "retrying" ? "Service replaced after a retried replacement"
      : roll.status === "replacing" ? "Service replaced after the interrupted replacement"
      : roll.status === "deferred" ? "A fresh bridge loaded this source and replaced the service while the roll was deferred, bypassing the roll; no roll typecheck ran for it"
      : "A fresh bridge loaded this source and replaced the service while the roll was typechecking; that check's completion was not observed and no passing roll typecheck is recorded";
    try { this.processActions.writeServiceRoll(this.dataDir, { ...roll, status: "rolled", toBuild: buildId, at: new Date().toISOString(), detail }); } catch { /* advisory */ }
    this.reloadPlugin(buildId);
  }

  /**
   * After a roll lands, the bridge and UI still hold the contracts they loaded with.
   * Both validate every reply strictly, so a reply field the new build adds fails
   * every call until the plugin reloads (observed live 2026-09-27 after #080). The
   * reload is detached so it outlives this bridge, and runs once per landed build.
   */
  private reloadPlugin(buildId: string) {
    const command = this.options.reloadPluginCommand?.();
    if (!command || this.reloadedFor === buildId || buildId === this.pluginBuild) return;
    this.reloadedFor = buildId;
    try {
      const child = this.processActions.spawn(command.command, command.args, { detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => { /* the header notice still asks for a manual reload */ });
      child.unref();
    } catch { /* the header notice still asks for a manual reload */ }
  }

  /** Socket unreachable: distinguish starting, stale and unhealthy without duplicating a spawn. */
  private async handleUnreachable(info: ServiceInfo): Promise<ServiceClient> {
    if (this.processActions.pidAlive(info.pid)) {
      // A live process owns the socket path but is not answering; it may be
      // starting or stalled. Never spawn a second owner over an uncertain one.
      const ageMs = Date.now() - Date.parse(info.startedAt);
      this.state = ageMs < 15_000 ? "starting" : "unhealthy";
      this.detail = `Service pid ${info.pid} is alive but not answering on ${info.socketPath}`;
      // A persistence executor death leaves the process alive; the recorded cause names it.
      const fault = readServiceExecutorFault(this.dataDir);
      if (fault?.pid === info.pid) this.detail = `${this.detail}; executor ${fault.kind} at ${fault.at}${fault.exitCode === null ? "" : ` (exit code ${fault.exitCode})`}: ${fault.message}`;
      throw new Error(this.detail);
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
    const roll = readServiceRoll(this.dataDir);
    if (roll?.status !== "replacing" || Date.now() - Date.parse(roll.at) > ROLL_HANDOFF_WINDOW_MS) return null;
    this.state = "starting";
    this.detail = "a Queue service roll handoff is in progress; waiting for it to settle";
    const deadline = Date.now() + (this.options.handoffWaitMs ?? UPGRADE_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (readServiceRoll(this.dataDir)?.status !== "replacing") return null;
      await sleep(UPGRADE_POLL_MS);
      const info = readServiceInfo(this.dataDir);
      if (!info) continue;
      const client = await this.tryConnect(info);
      if (client) return client;
    }
    this.state = "unhealthy";
    this.detail = "a Queue service roll handoff did not settle; refusing to spawn a second owner";
    throw new Error(this.detail);
  }

  private incompatibleDetail(info: ServiceInfo): string {
    if (info.protocolVersion !== SERVICE_PROTOCOL_VERSION || info.buildId !== this.expectedBuildId()) {
      return `Service build ${info.buildId} does not match the bridge build ${this.expectedBuildId()}`;
    }
    return `Service login session ${info.sessionId ?? "unrecorded"} does not match this bridge session ${this.currentSession()}`;
  }

  /** Incompatible build or login session: request bounded drain, observe release, then replace. */
  private async replaceIncompatible(info: ServiceInfo): Promise<ServiceClient> {
    // While this bridge owns the handoff, its own `ensure` must not wait on the
    // `replacing` record it just wrote.
    const previous = this.handoff;
    this.handoff = true;
    try { return await this.replaceIncompatibleInner(info); }
    finally { this.handoff = previous; }
  }

  private async replaceIncompatibleInner(info: ServiceInfo): Promise<ServiceClient> {
    this.state = "incompatible";
    this.detail = this.incompatibleDetail(info);
    const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential, requestTimeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS });
    let drainable = false;
    try {
      await client.connect();
      drainable = true;
    } catch {
      client.close();
      if (!this.processActions.pidAlive(info.pid)) return this.spawnService("incompatible service is gone");
      // Live owner, socket already gone (a roll drain released it): spawn as a
      // standby for that pid rather than fighting the processOwner lease.
      this.detail = `Incompatible service is alive but not answering; starting a standby for pid ${info.pid}`;
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
    this.lastStandbyReadiness = null;
    // Another live bridge holds the spawn claim, so it owns this replacement and its
    // warm standby. Draining here would stop the old service while that standby is
    // still loading (papercut a6c9a2ac: a 16 s endpoint gap), so only its owner
    // drains; this bridge waits for the owner's replacement instead.
    if (!standby.claimed) {
      client.close();
      this.detail = "Another bridge is replacing the incompatible service; waiting for its replacement";
      const replaced = await this.awaitForeignReplacement(standby, info.pid);
      if (replaced) return replaced;
      this.state = "unhealthy";
      this.detail = "Another bridge's replacement of the incompatible service did not become ready while its spawn claim was live";
      throw new Error(this.detail);
    }
    if (standby.child) {
      this.detail = "Waiting for the warm standby to report loaded before draining the incompatible service";
      const readiness = await this.awaitStandbyWarm(standby, info.pid);
      this.lastStandbyReadiness = readiness;
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
      const failure = startupFailureRecord(standby, "standby exited before drain");
      if (failure) { try { this.processActions.writeServiceStartupFailure(this.dataDir, failure); } catch { /* advisory */ } }
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
        if (this.processActions.pidAlive(info.pid)) await client.request("service.drain", this.rollNote ? { roll: this.rollNote } : {}, CONNECT_ATTEMPT_TIMEOUT_MS);
      } catch (error) {
        // A service that exited during the request is drained: the wait below finishes the spawn.
        if (this.processActions.pidAlive(info.pid)) {
          client.close();
          this.abandonStandby(standby);
          this.state = "unhealthy";
          this.detail = `Incompatible service did not accept a bounded drain: ${error instanceof Error ? error.message : String(error)}`;
          throw new Error(this.detail);
        }
      }
    }
    this.state = "upgrading";
    this.detail = "Waiting for the incompatible service to drain and release its lease";
    const deadline = Date.now() + UPGRADE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(standby.child ? STANDBY_POLL_MS : UPGRADE_POLL_MS);
      if (!this.processActions.pidAlive(info.pid)) return this.finishSpawn("incompatible service exited and released its lease", standby);
      // Without a standby the old process may release identity and socket before it exits.
      if (!standby.child && !readServiceInfo(this.dataDir) && !existsSync(info.socketPath)) return this.finishSpawn("incompatible service drained and released its lease", standby);
    }
    this.state = "unhealthy";
    this.detail = "Incompatible service did not release its socket and lease inside the bounded upgrade window";
    this.abandonStandby(standby);
    throw new Error(this.detail);
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
      ready: () => this.processActions.standbyIsReady(this.dataDir, pid),
      alive: () => child.exitCode === null && child.signalCode === null,
      replacedExited: () => !this.processActions.pidAlive(replaced),
      cpuMs: () => this.processActions.processCpuMs(pid),
      now: () => performance.now(),
      sleep: async ms => { await sleep(ms); },
      // The wait may outlast CLAIM_FRESH_MS: keep the spawn claim fresh, as the
      // post-drain readiness wait does, so no other bridge spawns beside this standby.
      tick: () => { if (attempt.claimed) refreshClaim(attempt.claimPath, this.processActions.writeOwnedJson); },
    }, {
      stallMs: this.options.standbyReadyStallMs ?? STANDBY_READY_STALL_MS,
      capMs: this.options.standbyReadyCapMs ?? STANDBY_READY_CAP_MS,
      budgetMs: this.options.standbyReadyBudgetMs ?? STANDBY_READY_BUDGET_MS,
      pollMs: STANDBY_POLL_MS,
    });
    return { ...result, pid, at: new Date().toISOString() };
  }

  /** Note appended to a landed roll when the bridge drained past a standby that never reported loaded. */
  private standbyRollNote(): string {
    const readiness = this.lastStandbyReadiness;
    if (!readiness || readiness.warm) return "";
    return `; the warm standby had not reported loaded after ${readiness.waitedMs} ms (${readiness.cause}), so the old service was drained anyway`;
  }

  /** Spawn only from the exact installed checkout when the service is definitely absent. */
  private spawnService(reason: string): Promise<ServiceClient> {
    if (this.closed) throw new ServiceBridgeUnavailable("unhealthy", "this bridge is closed and cannot start the service");
    const info = readServiceInfo(this.dataDir);
    const standbyFor = info && this.processActions.pidAlive(info.pid) ? info.pid : undefined;
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
    if (this.closed) throw new ServiceBridgeUnavailable("unhealthy", "this bridge is closed and cannot start the service");
    this.state = "absent";
    this.detail = reason;
    const claimPath = join(this.dataDir, SPAWN_CLAIM_FILE);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const attempt: SpawnAttempt = { claimPath, claimed: false, child: null, startup: null };
    // Atomic claim: only one bridge can create the file, so two racing bridges
    // never both spawn; the loser waits for the winner's service instead.
    for (let tries = 0; tries < 2 && !attempt.claimed; tries++) {
      try {
        const fd = openSync(claimPath, "wx", 0o600);
        try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } as SpawnClaim)); } finally { closeSync(fd); }
        attempt.claimed = true;
        this.state = "starting";
        this.detail = "Waiting for the spawned service to become ready";
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
          this.state = "starting";
          this.detail = "another bridge holds a fresh spawn claim; waiting for its service";
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
      const client = await this.awaitReadiness(this.options.readinessBudgetMs ?? 20_000, attempt);
      if (client) {
        if (attempt.startup) sealStartupCapture(attempt.startup);
        if (attempt.claimed) rmSync(attempt.claimPath, { force: true });
        return client;
      }
      this.state = "unhealthy";
      if (attempt.startup) sealStartupCapture(attempt.startup);
      const failure = startupFailureRecord(attempt, reason);
      if (failure) {
        try { this.processActions.writeServiceStartupFailure(this.dataDir, failure); } catch { /* the in-memory service state still reports the evidence */ }
        this.detail = `Spawned service did not become ready within the bounded window (${reason}); child startup: ${startupFailureSummary(failure)}`;
      } else {
        this.detail = `Spawned service did not become ready within the bounded window (${reason})`;
      }
      throw new Error(this.detail);
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
      this.processActions.clearStandbyReady(this.dataDir, attempt.child.pid);
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
    const now = this.options.readinessNow ?? Date.now;
    const startedAt = now();
    const pid = attempt.child?.pid;
    const deadline = () => startedAt + budgetMs + (pid ? this.processActions.startupExtensionMs(this.dataDir, pid, attempt.token, now()) : 0);
    try {
      while (now() < deadline()) {
        if (attempt.startup?.closed) return null;
        await sleep(this.options.readinessPollMs ?? 250);
        if (attempt.claimed) refreshClaim(attempt.claimPath, this.processActions.writeOwnedJson);
        const info = readServiceInfo(this.dataDir);
        if (!info) continue;
        const client = await this.tryConnect(info);
        if (client) return client;
        if (attempt.startup?.closed) return null;
      }
      return null;
    } finally {
      if (pid) { this.processActions.clearMigration(this.dataDir, pid); this.processActions.clearMaintenance(this.dataDir, pid); }
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
        const info = readServiceInfo(this.dataDir);
        // Probe without claiming: the replacement belongs to the bridge whose
        // spawn claim is fresh, and it claims the new service itself when its
        // readiness wait connects. Adopting without the claim keeps the
        // waiter from starving that handoff.
        return info && info.pid !== replacedPid && this.serviceMatches(info) ? this.tryConnect(info, { claimPresence: false }) : null;
      },
      claimFresh: () => claimIsFresh(attempt.claimPath, this.processActions.pidAlive),
      now: () => performance.now(),
      sleep: async ms => { await sleep(ms); },
    }, (this.options.standbyReadyCapMs ?? STANDBY_READY_CAP_MS) + UPGRADE_TIMEOUT_MS + (this.options.readinessBudgetMs ?? 20_000), UPGRADE_POLL_MS);
    return result.client;
  }

  /** The service is one this bridge may use as is: protocol, build and session match, and its process is alive. */
  private serviceMatches(info: ServiceInfo): boolean {
    return info.protocolVersion === SERVICE_PROTOCOL_VERSION && info.buildId === this.expectedBuildId()
      && !sessionsDiffer(info.sessionId, this.currentSession()) && this.processActions.pidAlive(info.pid);
  }

  /** A fresh claim from a live process means another bridge may be spawning already. */
  private readClaim(claimPath: string): boolean {
    try {
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as SpawnClaim;
      if (typeof claim.pid !== "number" || typeof claim.at !== "string") throw new Error("Malformed claim");
      return this.processActions.pidAlive(claim.pid) && Date.now() - Date.parse(claim.at) < CLAIM_FRESH_MS;
    } catch {
      rmSync(claimPath, { force: true });
      return false;
    }
  }

  private paseoHome(): string {
    return this.options.paseoHome ?? process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  }

  private spawnProcess(attempt: SpawnAttempt, standbyFor?: number): ChildProcess {
    attempt.token = randomUUID();
    const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: this.paseoHome(), QUEUE_LOGIN_SESSION: this.currentSession(), [SPAWN_TOKEN_ENV]: attempt.token };
    if (standbyFor) env[STANDBY_ENV] = String(standbyFor); else delete env[STANDBY_ENV];
    const capture = newStartupCapture(env);
    attempt.startup = capture;
    let child: ChildProcess;
    try {
      // The child serves the store this bridge resolved: pin it, like the main
      // channel does, so the child never re-resolves against a different answer.
      const childDataDir = `--data-dir=${this.dataDir}`;
      if (this.options.serviceCommand) {
        const { command, args } = this.options.serviceCommand();
        child = this.processActions.spawn(command, [...args, childDataDir], { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
      } else {
        const sourcePath = this.sourcePath;
        if (!sourcePath || !existsSync(join(sourcePath, "bin", "queue-service.mjs"))) {
          throw new Error("Installed plugin source is missing the standalone Queue service entry");
        }
        const installed = existsSync(join(sourcePath, "manifest.json"));
        child = this.processActions.spawn(installed ? join(sourcePath, "runtime", "node") : process.execPath, [...(installed ? [] : runtimeNodeArgs()), join(sourcePath, "bin", "queue-service.mjs"), childDataDir], { detached: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: sourcePath });
      }
    } catch (error) {
      capture.spawnError = safeSpawnErrorCode(error);
      capture.closed = true;
      sealStartupCapture(capture);
      throw error;
    }
    capture.pid = child.pid ?? null;
    if (child.pid) this.options.onSpawn?.(child.pid);
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

  /**
   * Watch the configured main channel and roll the service when it changes.
   */
  watch() {
    const every = this.options.rollCheckMs ?? ROLL_CHECK_MS;
    if (this.watchTimer || this.rollRequestTimer || this.expectedBuild instanceof Error) return;
    // Presence is a hint only; identity is observed by the service itself.
    void this.ensure().catch(() => {});
    this.presenceTimer = setInterval(() => { void this.ensure().catch(() => {}); }, 2000);
    this.presenceTimer.unref?.();
    if (every > 0) {
      this.watchTimer = setInterval(() => { void this.ensure().catch(() => {}); void this.checkSource(); }, every);
      this.watchTimer.unref?.();
    }
    // The service writes this hint only after syncing Queue's registered
    // checkout. Polling the hint keeps the backend digest check on its relaxed
    // interval while starting an authorized self-roll promptly.
    this.rollRequestTimer = setInterval(() => {
      if (!existsSync(join(this.dataDir, SERVICE_ROLL_REQUEST_FILE))) return;
      void this.ensure().then(() => {
        if (this.closed || !this.client?.connected) return;
        const request = this.processActions.consumeServiceRollRequest(this.dataDir);
        if (request) void this.checkSource(request.force);
      }).catch(() => {});
    }, 250);
    this.rollRequestTimer.unref?.();
  }

  /** One roll at a time; a change noticed during a roll is coalesced and rolled after the settle window. */
  checkSource(force = false): Promise<ServiceRoll | null> {
    // Activation is a roll step, retried on each check, not gated on a successful
    // connect (nucleus#972). A standby that cannot claim presence still fails
    // `ensure` on the replacement path inside `rollOnce`; this entry does not
    // spawn just to learn that.
    if (force) this.rollForced = true;
    if (this.rolling) { this.rollAgain = true; return this.rolling; }
    this.rolling = (async () => {
      let last: ServiceRoll | null = null;
      do {
        this.rollAgain = false;
        const forced = this.rollForced;
        this.rollForced = false;
        last = await this.rollOnce(forced) ?? last;
      } while (this.rollAgain);
      return last;
    })().finally(() => { this.rolling = null; });
    return this.rolling;
  }

  private rememberDeferral(reason: ServiceRollDeferral["reason"], until: string): void {
    const at = new Date().toISOString();
    const last = this.deferrals[this.deferrals.length - 1];
    if (last && last.reason === reason && last.until === until) { last.at = at; return; }
    this.deferrals.push({ at, reason, until });
    if (this.deferrals.length > 64) this.deferrals.splice(0, this.deferrals.length - 64);
  }

  private async heavyFollowersAttached(): Promise<boolean> {
    if (this.options.heavyFollowers) return this.options.heavyFollowers();
    const count = (health: Record<string, unknown> | null | undefined) => {
      const endpoint = health?.hostRunEndpoint as { heavyFollowers?: unknown } | null | undefined;
      return Number(endpoint?.heavyFollowers ?? 0);
    };
    try {
      if (!this.client) return false;
      const health = await this.client.request("service.health", {}, CONNECT_ATTEMPT_TIMEOUT_MS) as Record<string, unknown>;
      this.lastHealth = health;
      return count(health) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Point `current` and the installer entrypoints at the staged version. This is
   * a roll step, retried on each check, and does not wait for a successful
   * connect: a reload that answers late must not leave `current` behind. A
   * failure stays pending, is recorded as `retrying` with the error in detail,
   * and is retried on the next check.
   */
  private async convergeActivation(): Promise<string | null> {
    if (!this.activateInstalled) return null;
    try {
      await this.activateInstalled();
      this.activateInstalled = null;
      return null;
    } catch (error) {
      const detail = `activation did not complete and is retried: ${error instanceof Error ? error.message : String(error)}`;
      this.recordRetrying(detail);
      return detail;
    }
  }

  private recordRetrying(detail: string): void {
    const existing = readServiceRoll(this.dataDir);
    const buildId = typeof this.expectedBuild === "string" ? this.expectedBuild : "";
    const roll: ServiceRoll = {
      status: "retrying",
      fromBuild: existing?.fromBuild || buildId,
      toBuild: existing?.toBuild ?? (buildId || null),
      digest: existing?.digest || this.sourceDigest || "",
      at: new Date().toISOString(),
      detail: detail.slice(-4000),
      deferrals: existing?.deferrals ?? [],
    };
    try { mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); this.processActions.writeServiceRoll(this.dataDir, roll); } catch { /* the record is advisory */ }
  }

  /** Build and roll only the configured main channel, after settle and follower deferrals. */
  private async rollOnce(force = false): Promise<ServiceRoll | null> {
    await this.installedReady;
    if (typeof this.expectedBuild !== "string") return null;
    const root = this.sourcePath ?? sourcePathFromModule();
    if (this.mainChannel === undefined) this.mainChannel = await this.processActions.openMainChannel(root);
    const channel = this.mainChannel;
    if (!channel) return null;
    let target: Awaited<ReturnType<BridgeMainChannel["target"]>> = null;
    let staged: Awaited<ReturnType<BridgeMainChannel["build"]>> | null = null;
    let digest: string;
    try {
      target = await channel.target();
      if (!target) return null;
      digest = target.key;
    } catch (error) {
      const roll: ServiceRoll = { status: "failed", fromBuild: this.expectedBuild, toBuild: null, digest: this.sourceDigest ?? "", at: new Date().toISOString(), detail: `main build source unavailable: ${error instanceof Error ? error.message : String(error)}`, deferrals: [] };
      try { mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); this.processActions.writeServiceRoll(this.dataDir, roll); } catch { /* the record is advisory */ }
      return roll;
    }
    if (digest === this.sourceDigest || digest === this.failedDigest) {
      // An unfinished replacement (or a handoff a reload interrupted) is retried on
      // each check, not left waiting for a request.
      const status = readServiceRoll(this.dataDir)?.status;
      let ensureError: unknown = null;
      if (status === "retrying" || status === "replacing") {
        try { await this.ensure(); } catch (error) { ensureError = error; }
      }
      const activationError = await this.convergeActivation();
      if (activationError) return readServiceRoll(this.dataDir);
      if (ensureError) {
        this.recordRetrying(`the replacement did not complete and is retried: ${ensureError instanceof Error ? ensureError.message : String(ensureError)}`);
        return readServiceRoll(this.dataDir);
      }
      const buildId = this.lastHealth?.["buildId"];
      if (typeof buildId === "string") this.settleLandedRoll(buildId);
      return null;
    }
    if (digest !== this.pendingDigest) {
      this.pendingDigest = digest;
      this.lastDigestChangeAt = Date.now();
    }
    const fromBuild = this.expectedBuild;
    const record = (status: ServiceRoll["status"], toBuild: string | null, detail: string): ServiceRoll => {
      const roll: ServiceRoll = {
        status, fromBuild, toBuild, digest, at: new Date().toISOString(),
        detail: detail.slice(-4000), deferrals: [...this.deferrals],
      };
      try { mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); this.processActions.writeServiceRoll(this.dataDir, roll); } catch { /* the record is advisory */ }
      return roll;
    };
    record("typechecking", null, "Building main locally while the settle window runs");
    try {
      staged = target.staged ?? await channel.build(target.revision!);
      const latest = await channel.target();
      if (latest?.key !== target.key) { this.rollAgain = true; return null; }
    } catch (error) {
      this.failedDigest = digest;
      return record("failed", null, `the main build failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const settleMs = this.options.rollSettleMs ?? ROLL_SETTLE_MS;
    const capMs = this.options.rollHeavyFollowerCapMs ?? ROLL_HEAVY_FOLLOWER_CAP_MS;
    if (!force && settleMs > 0) {
      const waitMs = this.lastDigestChangeAt + settleMs - Date.now();
      if (waitMs > 0) {
        this.rememberDeferral("settle_window", new Date(this.lastDigestChangeAt + settleMs).toISOString());
        return record("deferred", null, `waiting ${Math.ceil(waitMs / 1000)}s after the last backend change before rolling`);
      }
    }
    if (!force && capMs > 0 && await this.heavyFollowersAttached()) {
      if (!this.heavyDeferSince) this.heavyDeferSince = Date.now();
      const waitMs = this.heavyDeferSince + capMs - Date.now();
      if (waitMs > 0) {
        this.rememberDeferral("heavy_follower", new Date(this.heavyDeferSince + capMs).toISOString());
        return record("deferred", null, `a heavy run has an attached follower; rolling after it settles or ${Math.ceil(waitMs / 1000)}s`);
      }
    }
    this.heavyDeferSince = 0;
    const identity = { digest, buildId: staged.buildId };
    const previousSourcePath = this.sourcePath, previousDigest = this.sourceDigest;
    const previousActivation = this.activateInstalled;
    try { await channel.prepare(staged, target); }
    catch (error) {
      this.failedDigest = digest;
      return record("failed", identity.buildId, `the staged main build failed startup proof: ${error instanceof Error ? error.message : String(error)}`);
    }
    record("replacing", identity.buildId, "Main build and startup proof verified; replacing the service");
    this.sourcePath = staged.root;
    const activationRoot = staged.root;
    this.activateInstalled = async () => {
      await this.processActions.activateVersion(activationRoot);
      await channel.activated(target!);
    };
    this.expectedBuild = identity.buildId;
    this.sourceDigest = digest;
    this.failedDigest = null;
    this.dropCachedClient();
    this.rollNote = { fromBuild, toBuild: identity.buildId };
    this.lastStandbyReadiness = null;
    // This bridge owns the handoff the `replacing` record describes, so its own
    // `ensure` must spawn the replacement rather than wait on that record.
    const wasHandoff = this.handoff;
    this.handoff = true;
    try {
      await this.ensure();
      const activationError = await this.convergeActivation();
      if (activationError) return record("retrying", identity.buildId, activationError);
      const rolled = record("rolled", identity.buildId, `Service replaced after a verified main build${this.standbyRollNote()}`);
      this.deferrals = [];
      this.pendingDigest = null;
      this.reloadPlugin(identity.buildId);
      return rolled;
    } catch (error) {
      if (error instanceof StandbyStartupError) {
        this.expectedBuild = fromBuild;
        this.sourceDigest = previousDigest;
        this.sourcePath = previousSourcePath;
        this.activateInstalled = previousActivation;
        this.failedDigest = digest;
        await channel.abandon(staged);
        this.state = "running";
        this.detail = "";
        return record("failed", identity.buildId, error.message);
      }
      // The new build is now the expected one; the next request or check retries the replace.
      const activationError = await this.convergeActivation();
      const replacement = `the replacement did not complete and is retried: ${error instanceof Error ? error.message : String(error)}`;
      return record("retrying", identity.buildId, activationError ? `${replacement}; ${activationError}` : replacement);
    } finally {
      this.handoff = wasHandoff;
      this.rollNote = null;
    }
  }

  close() {
    this.closed = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.rollRequestTimer) clearInterval(this.rollRequestTimer);
    this.watchTimer = null;
    this.presenceTimer = null;
    this.rollRequestTimer = null;
    this.dropCachedClient();
    this.state = "absent";
  }
}

const STARTUP_SENSITIVE_ENV_KEY = /(credential|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|bearer)/i;
const STARTUP_TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];
const STARTUP_SENSITIVE_NAME = /credential|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|bearer/i;
const STARTUP_SENSITIVE_ASSIGNMENT = /((?:["']?[\w.-]{0,64}(?:credential|token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie|bearer)[\w.-]{0,64}["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const STARTUP_CAPTURE_CARRY_CHARS = 1_024;

function newStartupCapture(env: NodeJS.ProcessEnv): StartupCapture {
  const redactions = Object.entries(env)
    .filter(([key, value]) => STARTUP_SENSITIVE_ENV_KEY.test(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value!);
  return {
    pid: null, exitCode: null, signal: null, spawnError: null,
    stdout: { pending: "", tail: Buffer.alloc(0) }, stderr: { pending: "", tail: Buffer.alloc(0) },
    redactions, closed: false, sealed: false,
  };
}

function captureStartupChunk(capture: StartupCapture, streamName: "stdout" | "stderr", chunk: Buffer) {
  if (capture.sealed) return;
  const stream = capture[streamName];
  const combined = stream.pending + chunk.toString("utf8");
  const carry = Math.max(STARTUP_CAPTURE_CARRY_CHARS, ...capture.redactions.map(secret => secret.length));
  let cutoff = Math.max(0, combined.length - carry);
  // Keep any secret that straddles the boundary intact so the next chunk can
  // redact it before any of its bytes are committed to the retained tail.
  let moved = true;
  while (moved && cutoff > 0) {
    moved = false;
    for (const secret of capture.redactions) {
      let index = combined.indexOf(secret, Math.max(0, cutoff - secret.length + 1));
      while (index >= 0 && index < cutoff) {
        if (index + secret.length > cutoff) { cutoff = index; moved = true; }
        index = combined.indexOf(secret, index + 1);
      }
    }
  }
  stream.pending = combined.slice(cutoff);
  if (cutoff > 0) stream.tail = appendBoundedTail(stream.tail, redactStartupText(combined.slice(0, cutoff), capture.redactions));
}

function sealStartupCapture(capture: StartupCapture) {
  if (capture.sealed) return;
  for (const name of ["stdout", "stderr"] as const) {
    const stream = capture[name];
    if (stream.pending) stream.tail = appendBoundedTail(stream.tail, redactStartupText(stream.pending, capture.redactions));
    stream.pending = "";
  }
  capture.sealed = true;
}

function appendBoundedTail(previous: Buffer, text: string): Buffer {
  const joined = Buffer.concat([previous, Buffer.from(text)]);
  return joined.subarray(Math.max(0, joined.length - OUTPUT_TAIL_BYTES));
}

function redactStartupText(text: string, secrets: readonly string[]): string {
  let output = STARTUP_SENSITIVE_NAME.test(text) ? text.replace(STARTUP_SENSITIVE_ASSIGNMENT, "$1[redacted]") : text;
  for (const pattern of STARTUP_TOKEN_PATTERNS) output = output.replace(pattern, "[redacted]");
  for (const secret of secrets) output = output.split(secret).join("[redacted]");
  return output;
}

/**
 * Read-only freshness of another bridge's spawn claim: unreadable or malformed
 * counts as not fresh, and the file is never removed (a waiter does not touch
 * a claim it does not own).
 */
function claimIsFresh(claimPath: string, pidAlive: BridgeProcessActions["pidAlive"]): boolean {
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

function safeSpawnErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,32}$/.test(code) ? code : "spawn failure";
}

function startupFailureRecord(attempt: SpawnAttempt, reason: string): ServiceStartupFailure | null {
  const capture = attempt.startup;
  if (!capture) return null;
  const output = [
    capture.stdout.tail.length ? `stdout: ${capture.stdout.tail.toString("utf8")}` : "",
    capture.stderr.tail.length ? `stderr: ${capture.stderr.tail.toString("utf8")}` : "",
  ].filter(Boolean).join(" ");
  const boundedOutput = Buffer.from(output).subarray(-OUTPUT_TAIL_BYTES).toString("utf8");
  return {
    at: new Date().toISOString(), reason: reason.slice(0, 256), pid: capture.pid,
    exitCode: capture.exitCode, signal: capture.signal, spawnError: capture.spawnError,
    output: boundedOutput,
  };
}

function startupFailureSummary(failure: ServiceStartupFailure): string {
  const context = failure.spawnError
    ? `spawn error ${failure.spawnError}`
    : failure.exitCode !== null
      ? `child exited with code ${failure.exitCode}`
      : failure.signal
        ? `child terminated by ${failure.signal}`
        : failure.pid ? `child pid ${failure.pid} did not exit before readiness timed out` : "child did not start";
  return failure.output ? `${context}; ${failure.output}` : context;
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

/** The host's record of where this plugin is installed, or null when it has none. */
function readInstalledSourcePath(paseoHome: string): string | null {
  let config: { plugins?: Record<string, { path?: unknown; enabled?: boolean } | null> };
  try {
    config = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  return pluginRegistration(config.plugins)?.path ?? null;
}

// The claim constant is exported for fixtures; keep it referenced.
export type { SpawnClaim };
