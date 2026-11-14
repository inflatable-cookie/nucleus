import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_PROTOCOL_VERSION, backendSourceDigest, sourcePathFromModule } from "../../../shared/service/build";
import { readServiceInfo, readServiceRoll, SERVICE_ROLL_REQUEST_FILE } from "../../../shared/service/discovery";
import type { ServiceRoll, ServiceRollDeferral } from "../../../shared/service-roll";
import type { ServiceClient } from "../../../shared/service/client";
import type { BridgeMainChannel } from "../../../shared/service/bridge-process";
import { CONNECT_ATTEMPT_TIMEOUT_MS, type BridgeOptions } from "./options";
import type { BridgeSession } from "./session";
import { SPAWN_CLAIM_FILE, StandbyStartupError, claimIsFresh } from "./spawn";

/** Wait this long after the last main revision change before rolling (Spec 035). */
export const ROLL_SETTLE_MS = 60_000;
/** Defer a due roll while a heavy run has an attached follower, up to this cap. */
export const ROLL_HEAVY_FOLLOWER_CAP_MS = 15 * 60_000;
const ROLL_CHECK_MS = 30_000;
const UPGRADE_POLL_MS = 250;
/** What the scheduler needs from the bridge that owns the connection. */
export interface RollContext {
  options: BridgeOptions;
  dataDir: string;
  session: BridgeSession;
  processActions: BridgeOptions["processActions"];
  /** The bridge's single-flight connect, used by the watchers. */
  ensure(): Promise<ServiceClient>;

}

/**
 * The main-channel roll scheduler.
 *
 * One owner for the rule that a merge changes the service: watch the configured
 * main channel, settle, defer while a heavy run has an attendant, build and prove
 * the staged version, replace the service, converge activation and reload the
 * plugin once the new build answers. Every step writes the durable roll record
 * that operators and waiters read, and each unfinished step is retried on the
 * next check rather than left waiting for a request.
 */
export class RollScheduler {
  private rollCheckTimer: NodeJS.Timeout | null = null;
  private rollRequestTimer: NodeJS.Timeout | null = null;
  private rolling: Promise<ServiceRoll | null> | null = null;
  /** The main-channel instance this bridge rolls from; opened on the first check. */
  private mainChannel: BridgeMainChannel | null | undefined;
  /**
   * Activation is a roll step: point `current` and the installer entrypoints at
   * the staged version. Set while a staged build waits to be activated.
   */
  private activateInstalled: (() => Promise<void>) | null = null;
  private rollAgain = false;
  private rollForced = false;
  private pendingDigest: string | null = null;
  private lastDigestChangeAt = 0;
  private heavyDeferSince = 0;
  private deferrals: ServiceRollDeferral[] = [];
  /** The roll in flight, so a forwarded call can wait for an owned handover. */
  active: Promise<ServiceRoll | null> | null = null;

  constructor(private readonly core: RollContext) {}

  private get session() { return this.core.session; }

  /** Start watching the main channel and the service's roll request hint. */
  start() {
    const every = this.core.options.rollCheckMs ?? ROLL_CHECK_MS;
    if (this.rollCheckTimer || this.rollRequestTimer || this.session.expected instanceof Error) return;
    if (every > 0) {
      this.rollCheckTimer = setInterval(() => { void this.core.ensure().catch(() => {}); void this.checkSource(); }, every);
      this.rollCheckTimer.unref?.();
    }
    // The service writes this hint only after syncing Queue's registered
    // checkout. Polling the hint keeps the backend digest check on its relaxed
    // interval while starting an authorized self-roll promptly.
    this.rollRequestTimer = setInterval(() => {
      if (!existsSync(join(this.core.dataDir, SERVICE_ROLL_REQUEST_FILE))) return;
      void this.core.ensure().then(() => {
        if (this.session.closed || !this.session.client?.connected) return;
        const request = this.core.processActions.consumeServiceRollRequest(this.core.dataDir);
        if (request) void this.checkSource(request.force);
      }).catch(() => {});
    }, 250);
    this.rollRequestTimer.unref?.();
  }

  /** Stop both timers; a closed bridge rolls nothing. */
  stop() {
    if (this.rollCheckTimer) clearInterval(this.rollCheckTimer);
    if (this.rollRequestTimer) clearInterval(this.rollRequestTimer);
    this.rollCheckTimer = null;
    this.rollRequestTimer = null;
  }

  /** One roll at a time; a change noticed during a roll is coalesced and rolled after the settle window. */
  checkSource(force = false): Promise<ServiceRoll | null> {
    // Activation is a roll step, retried on each check, not gated on a successful
    // connect (nucleus#972). A standby that cannot claim presence still fails
    // `ensure` on the replacement path inside `rollOnce`; this entry does not
    // spawn just to learn that.
    if (force) this.rollForced = true;
    if (this.rolling) { this.rollAgain = true; return this.rolling; }
    this.rolling = this.active = (async () => {
      let last: ServiceRoll | null = null;
      do {
        this.rollAgain = false;
        const forced = this.rollForced;
        this.rollForced = false;
        last = await this.rollOnce(forced) ?? last;
      } while (this.rollAgain);
      return last;
    })().finally(() => { this.rolling = null; this.active = null; });
    return this.rolling;
  }

  /**
   * Adopt a staged replacement a plugin reload interrupted: the roll record still
   * names the pending build, so the new bridge proves and activates it.
   */
  async resumeInstalled(sourcePath: string): Promise<void> {
    const channel = this.mainChannel = await this.core.processActions.openMainChannel(sourcePath);
    const pending = await channel?.pending();
    if (!channel || !pending) return;
    const staged = await this.core.processActions.verifyVersion(pending.root);
    await channel.proveStartup(staged);
    this.session.sourcePath = staged.root;
    this.session.expected = staged.buildId;
    this.session.sourceDigest = pending.target.key;
    this.activateInstalled = async () => {
      await this.core.processActions.activateVersion(staged.root);
      await channel.activated(pending.target);
    };
  }

  private rememberDeferral(reason: ServiceRollDeferral["reason"], until: string): void {
    const at = new Date().toISOString();
    const last = this.deferrals[this.deferrals.length - 1];
    if (last && last.reason === reason && last.until === until) { last.at = at; return; }
    this.deferrals.push({ at, reason, until });
    if (this.deferrals.length > 64) this.deferrals.splice(0, this.deferrals.length - 64);
  }

  private async heavyFollowersAttached(): Promise<boolean> {
    if (this.core.options.heavyFollowers) return this.core.options.heavyFollowers();
    const count = (health: Record<string, unknown> | null | undefined) => {
      const endpoint = health?.hostRunEndpoint as { heavyFollowers?: unknown } | null | undefined;
      return Number(endpoint?.heavyFollowers ?? 0);
    };
    try {
      if (!this.session.client) return false;
      const health = await this.session.client.request("service.health", {}, CONNECT_ATTEMPT_TIMEOUT_MS) as Record<string, unknown>;
      this.session.health = health;
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
    const existing = readServiceRoll(this.core.dataDir);
    const buildId = typeof this.session.expected === "string" ? this.session.expected : "";
    const roll: ServiceRoll = {
      status: "retrying",
      fromBuild: existing?.fromBuild || buildId,
      toBuild: existing?.toBuild ?? (buildId || null),
      digest: existing?.digest || this.session.sourceDigest || "",
      at: new Date().toISOString(),
      detail: detail.slice(-4000),
      deferrals: existing?.deferrals ?? [],
    };
    try { mkdirSync(this.core.dataDir, { recursive: true, mode: 0o700 }); this.core.processActions.writeServiceRoll(this.core.dataDir, roll); } catch { /* the record is advisory */ }
  }

  /** Build and roll only the configured main channel, after settle and follower deferrals. */
  private async rollOnce(force = false): Promise<ServiceRoll | null> {
    if (typeof this.session.expected !== "string") return null;
    const root = this.session.sourcePath ?? sourcePathFromModule();
    if (this.mainChannel === undefined) this.mainChannel = await this.core.processActions.openMainChannel(root);
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
      const roll: ServiceRoll = { status: "failed", fromBuild: this.session.expected, toBuild: null, digest: this.session.sourceDigest ?? "", at: new Date().toISOString(), detail: `main build source unavailable: ${error instanceof Error ? error.message : String(error)}`, deferrals: [] };
      try { mkdirSync(this.core.dataDir, { recursive: true, mode: 0o700 }); this.core.processActions.writeServiceRoll(this.core.dataDir, roll); } catch { /* the record is advisory */ }
      return roll;
    }
    if (digest === this.session.sourceDigest || digest === this.session.failedDigest) {
      // An unfinished replacement (or a handoff a reload interrupted) is retried on
      // each check, not left waiting for a request.
      const status = readServiceRoll(this.core.dataDir)?.status;
      let ensureError: unknown = null;
      if (status === "retrying" || status === "replacing") {
        try { await this.core.ensure(); } catch (error) { ensureError = error; }
      }
      const activationError = await this.convergeActivation();
      if (activationError) return readServiceRoll(this.core.dataDir);
      if (ensureError) {
        this.recordRetrying(`the replacement did not complete and is retried: ${ensureError instanceof Error ? ensureError.message : String(ensureError)}`);
        return readServiceRoll(this.core.dataDir);
      }
      const buildId = this.session.health?.["buildId"];
      if (typeof buildId === "string") this.settleLandedRoll(buildId);
      return null;
    }
    if (digest !== this.pendingDigest) {
      this.pendingDigest = digest;
      this.lastDigestChangeAt = Date.now();
    }
    const fromBuild = this.session.expected;
    const record = (status: ServiceRoll["status"], toBuild: string | null, detail: string): ServiceRoll => {
      const roll: ServiceRoll = {
        status, fromBuild, toBuild, digest, at: new Date().toISOString(),
        detail: detail.slice(-4000), deferrals: [...this.deferrals],
      };
      try { mkdirSync(this.core.dataDir, { recursive: true, mode: 0o700 }); this.core.processActions.writeServiceRoll(this.core.dataDir, roll); } catch { /* the record is advisory */ }
      return roll;
    };
    record("typechecking", null, "Building main locally while the settle window runs");
    try {
      staged = target.staged ?? await channel.build(target.revision!);
      const latest = await channel.target();
      if (latest?.key !== target.key) { this.rollAgain = true; return null; }
    } catch (error) {
      this.session.failedDigest = digest;
      return record("failed", null, `the main build failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const settleMs = this.core.options.rollSettleMs ?? ROLL_SETTLE_MS;
    const capMs = this.core.options.rollHeavyFollowerCapMs ?? ROLL_HEAVY_FOLLOWER_CAP_MS;
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
    const previousSourcePath = this.session.sourcePath, previousDigest = this.session.sourceDigest;
    const previousActivation = this.activateInstalled;
    try { await channel.prepare(staged, target); }
    catch (error) {
      this.session.failedDigest = digest;
      return record("failed", identity.buildId, `the staged main build failed startup proof: ${error instanceof Error ? error.message : String(error)}`);
    }
    record("replacing", identity.buildId, "Main build and startup proof verified; replacing the service");
    this.session.sourcePath = staged.root;
    const activationRoot = staged.root;
    this.activateInstalled = async () => {
      await this.core.processActions.activateVersion(activationRoot);
      await channel.activated(target!);
    };
    this.session.expected = identity.buildId;
    this.session.sourceDigest = digest;
    this.session.failedDigest = null;
    this.session.dropClient();
    this.session.rollNote = { fromBuild, toBuild: identity.buildId };
    this.session.lastStandbyReadiness = null;
    // This bridge owns the handoff the `replacing` record describes, so its own
    // `ensure` must spawn the replacement rather than wait on that record.
    const wasHandoff = this.session.handoff;
    this.session.handoff = true;
    try {
      await this.core.ensure();
      const activationError = await this.convergeActivation();
      if (activationError) return record("retrying", identity.buildId, activationError);
      const rolled = record("rolled", identity.buildId, `Service replaced after a verified main build${this.standbyRollNote()}`);
      this.deferrals = [];
      this.pendingDigest = null;
      this.reloadPlugin(identity.buildId);
      return rolled;
    } catch (error) {
      if (error instanceof StandbyStartupError) {
        this.session.expected = fromBuild;
        this.session.sourceDigest = previousDigest;
        this.session.sourcePath = previousSourcePath;
        this.activateInstalled = previousActivation;
        this.session.failedDigest = digest;
        await channel.abandon(staged);
        this.session.markRunning();
        return record("failed", identity.buildId, error.message);
      }
      // The new build is now the expected one; the next request or check retries the replace.
      const activationError = await this.convergeActivation();
      const replacement = `the replacement did not complete and is retried: ${error instanceof Error ? error.message : String(error)}`;
      return record("retrying", identity.buildId, activationError ? `${replacement}; ${activationError}` : replacement);
    } finally {
      this.session.handoff = wasHandoff;
      this.session.rollNote = null;
    }
  }

  /** Note appended to a landed roll when the bridge drained past a standby that never reported loaded. */
  private standbyRollNote(): string {
    const readiness = this.session.lastStandbyReadiness;
    if (!readiness || readiness.warm) return "";
    return `; the warm standby had not reported loaded after ${readiness.waitedMs} ms (${readiness.cause}), so the old service was drained anyway`;
  }

  /**
   * An unfinished roll has landed once its target build answers. A retried or
   * interrupted replacement names that build; a roll still deferred or
   * typechecking names only its source digest, and lands when a fresh bridge
   * loaded from that source replaced the service first (papercut 2f9f0b06: a
   * plugin reload inside the settle window left the record deferred for good).
   */
  settleLandedRoll(buildId: string) {
    // Activation is a roll step: a service that answers is not landed while
    // `current` and the installer entrypoints are still pending.
    if (this.activateInstalled) return;
    const roll = readServiceRoll(this.core.dataDir);
    if (!roll) return;
    const named = (roll.status === "retrying" || roll.status === "replacing") && roll.toBuild === buildId;
    const overtaken = (roll.status === "deferred" || roll.status === "typechecking")
      && roll.toBuild === null && this.session.sourceDigest !== null && roll.digest === this.session.sourceDigest;
    let abandoned = roll.status === "retrying" && roll.toBuild !== buildId && !this.session.handoff;
    if (abandoned) {
      // A healthy old bridge is not evidence that another bridge's current
      // target was abandoned. Keep main-channel and claimed attempts visible.
      abandoned = !this.mainChannel && !claimIsFresh(join(this.core.dataDir, SPAWN_CLAIM_FILE), this.core.processActions.pidAlive);
      const root = this.session.sourcePath ?? sourcePathFromModule();
      try {
        const selected = existsSync(join(root, "manifest.json")) ? this.session.sourceDigest : backendSourceDigest(root);
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
    try { this.core.processActions.writeServiceRoll(this.core.dataDir, { ...roll, status: "rolled", toBuild: buildId, at: new Date().toISOString(), detail }); } catch { /* advisory */ }
    this.reloadPlugin(buildId);
  }

  /**
   * After a roll lands, the bridge and UI still hold the contracts they loaded with.
   * Both validate every reply strictly, so a reply field the new build adds fails
   * every call until the plugin reloads (observed live 2026-09-27 after #080). The
   * reload is detached so it outlives this bridge, and runs once per landed build.
   */
  reloadPlugin(buildId: string) {
    const command = this.core.options.reloadPluginCommand?.();
    if (!command || this.session.reloadedFor === buildId || buildId === this.session.pluginBuild) return;
    this.session.reloadedFor = buildId;
    try {
      const child = this.core.processActions.spawn(command.command, command.args, { detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => { /* the header notice still asks for a manual reload */ });
      child.unref();
    } catch { /* the header notice still asks for a manual reload */ }
  }
}
