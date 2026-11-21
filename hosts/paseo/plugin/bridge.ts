import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataHome } from "../../../shared/data-home.mjs";
import type { RpcCatalogueEntry } from "../../../shared/rpc-catalogue";
import {
  SERVICE_PROTOCOL_VERSION,
  sourcePathFromModule,
} from "../../../shared/service/build";
import { pluginRegistration } from "../../../shared/plugin-discovery.mjs";
import {
  currentLoginSession,
  readServiceInfo,
  readServiceRoll,
  readServiceStartupFailure,
  sessionsDiffer,
  type ServiceInfo,
} from "../../../shared/service/discovery";
import type { ServiceRoll } from "../../../shared/service-roll";
import {
  ServiceClient,
  ServiceRequestError,
} from "../../../shared/service/client";
import {
  CallNotSentError,
  callWithRollRecovery,
  confirmationRead,
  parseRequestOutcome,
  rollWaitWorthy,
} from "../../../shared/service/roll-recovery";
import { lifecycleSignalSchema } from "../../../shared/lifecycle-signal";
import { CONNECT_ATTEMPT_TIMEOUT_MS, type BridgeOptions } from "../../../service/roll/options";
import {
  BridgeSession,
  ServiceBridgeUnavailable,
  type BridgeState,
  type StandbyReadiness,
} from "../../../service/roll/session";
import { ServiceSpawner } from "../../../service/roll/spawn";
import { ensureRollOwner, resolveExpectedBuild } from "../../../service/roll/owner";
import { startupFailureSummary } from "../../../service/roll/startup-output";

/**
 * The authenticated bridge between the Paseo backend and the standalone Queue
 * service (Contract 007 / Spec 013).
 *
 * This file is what the bridge itself owns: the build identity it expects, the
 * authenticated connection it forwards over, the one presence claim that
 * connection holds, and the bounded wait a call gets while the service rolls.
 * It owns no Queue state: it never opens SQLite, Git or hook runtime modules,
 * performs no repository or lifecycle work, and awaits no lifecycle effect on the
 * request path. It validates both ends with the shared contracts, forwards
 * catalogue methods to the local service and reports a typed state when the
 * service is absent, starting, incompatible, being upgraded or unhealthy. It
 * never starts an in-plugin fallback runtime.
 *
 * Establishing the service (service/roll/spawn.ts) is its own owner, and the main
 * channel roll belongs to the host-independent roll owner (service/roll/owner.ts).
 * Forwarding decides which of them a failure needs; the bridge only starts and
 * reports the owner, and reloads the plugin once a landed roll is recorded.
 */
export type { BridgeState, StandbyReadiness } from "../../../service/roll/session";
export { ServiceBridgeUnavailable } from "../../../service/roll/session";
export type { BridgeOptions } from "../../../service/roll/options";
export type { BridgeProcessActions } from "../../../shared/service/bridge-process";

/** Forwarded RPC window: covers the legacy compatibility waits (submit/task 15 s, handoff 60 s) with latency headroom. */
const FORWARDED_REQUEST_TIMEOUT_MS = 90_000;
/** Bounded projections stay short so a wedged service surfaces a typed state quickly. */
const PROJECTION_REQUEST_TIMEOUT_MS = 15_000;
const PROJECTION_METHODS = new Set([
  "queue.snapshot",
  "queue.ui-snapshot",
  "queue.detail",
  "queue.outcome",
  "queue.outcome-search",
  "queue.telemetry",
  "lanes",
]);
/**
 * Bounded wait for a call that arrived mid-roll (reads re-answer, mutations
 * recover their recorded outcome): the roll's own readiness budget — warm
 * standby cap, upgrade window and spawn readiness — plus slack.
 */
const ROLL_CALL_WAIT_MS = 210_000;

export class ServiceBridge {
  private readonly session: BridgeSession;
  private readonly spawner: ServiceSpawner;
  private ensurePromise: Promise<ServiceClient> | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private readonly dataDir: string;

  constructor(private readonly options: BridgeOptions) {
    this.dataDir = options.dataDir ?? dataHome();
    // The host's registry entry is the anchor that survives every loading format,
    // because it is a file the host wrote rather than a module URL: the bridge side
    // is loaded as a CJS bundle, where `import.meta` is empty. Fall back to the
    // module location for fixtures and direct runs.
    const sourcePath =
      options.sourcePath ?? readInstalledSourcePath(this.paseoHome());
    const { expected, digest, pluginBuild } = resolveExpectedBuild(sourcePath);
    this.session = new BridgeSession(expected, pluginBuild, sourcePath, digest);
    // An unresolvable build is a typed state, not a throw: every call reports it.
    if (expected instanceof Error)
      this.session.report("unhealthy", expected.message);
    this.spawner = new ServiceSpawner({
      options,
      dataDir: this.dataDir,
      processActions: options.processActions,
      session: this.session,
      connect: (info, connectOptions) => this.tryConnect(info, connectOptions),
      paseoHome: () => this.paseoHome(),
      currentSession: () => this.currentSession(),
    });
  }

  private currentSession(): string {
    return this.options.sessionId ?? currentLoginSession();
  }

  private paseoHome(): string {
    return (
      this.options.paseoHome ??
      process.env.PASEO_HOME ??
      join(homedir(), ".paseo")
    );
  }

  current(): { state: BridgeState; detail: string } {
    return { state: this.session.state, detail: this.session.detail };
  }

  /** The last replacement's standby readiness, or null when this bridge spawned none. */
  standbyReadiness(): StandbyReadiness | null {
    return this.session.lastStandbyReadiness;
  }

  /** Typed state surface for operators; no fallback runtime, no SQLite inspection. */
  async serviceState(): Promise<{
    state: BridgeState;
    detail: string;
    buildId: string | null;
    pid: number | null;
    startedAt: string | null;
    ready: boolean | null;
    paused: boolean | null;
    hostId: string | null;
    error: string;
    bootstrap: { pending: boolean; startedAt: string | null };
    pluginBuildId: string | null;
    roll: ServiceRoll | null;
  }> {
    // State is a bounded authenticated observation, not the bridge instance's
    // initial cache. It also uses the same single-flight bootstrap as forwarding.
    try {
      const client = await this.ensure();
      this.session.health = (await client.request(
        "service.health",
        {},
        CONNECT_ATTEMPT_TIMEOUT_MS,
      )) as Record<string, unknown>;
      this.session.markRunning();
    } catch (error) {
      this.session.dropClient();
      this.session.health = null;
      if (this.session.state === "running" || this.session.state === "absent")
        this.session.state = "unhealthy";
      this.session.detail =
        error instanceof Error ? error.message : String(error);
      const previousFailure = readServiceStartupFailure(this.dataDir);
      if (previousFailure && !this.session.detail.includes("child startup")) {
        this.session.detail = `${this.session.detail}; previous child startup: ${startupFailureSummary(previousFailure)}`;
      }
    }
    const health = this.session.health;
    const error =
      this.session.state === "running"
        ? String(health?.["startError"] ?? "")
        : this.session.detail;
    return {
      state: this.session.state,
      detail: this.session.detail,
      buildId:
        typeof health?.["buildId"] === "string"
          ? (health["buildId"] as string)
          : null,
      pid:
        typeof health?.["pid"] === "number" ? (health["pid"] as number) : null,
      startedAt:
        typeof health?.["startedAt"] === "string"
          ? (health["startedAt"] as string)
          : null,
      ready:
        typeof health?.["ready"] === "boolean"
          ? (health["ready"] as boolean)
          : null,
      paused:
        typeof health?.["paused"] === "boolean"
          ? (health["paused"] as boolean)
          : null,
      hostId:
        typeof health?.["hostId"] === "string"
          ? (health["hostId"] as string)
          : null,
      error,
      // A hung bootstrap is otherwise invisible: this is how the runtime wedged while
      // every surface reported ready.
      bootstrap: {
        pending: Boolean(
          (health?.["bootstrap"] as { pending?: boolean } | undefined)?.pending,
        ),
        startedAt:
          (health?.["bootstrap"] as { startedAt?: string | null } | undefined)
            ?.startedAt ?? null,
      },
      pluginBuildId: this.session.pluginBuild,
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
    const validated = await (
      entry.contract.input as {
        parseAsync: (value: unknown) => Promise<unknown>;
      }
    ).parseAsync(input);
    const raw = await callWithRollRecovery({
      method: entry.name,
      mutating: entry.mutating,
      input: validated,
      waitMs: this.options.rollCallWaitMs ?? ROLL_CALL_WAIT_MS,
      attempt: async (key) => {
        let client: ServiceClient;
        try {
          client = await this.ensure();
        } catch (error) {
          throw new CallNotSentError(
            new ServiceBridgeUnavailable(
              this.session.state,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        try {
          // Forwarded catalogue calls get a bounded window: short for projections,
          // wide enough for the legacy compatibility waits (submit/task 15 s, handoff 60 s).
          // Every forwarded request names this surface: the Paseo plugin bridge is how
          // the operator's Settings screen reaches the service, and the Settings-only
          // capacity rule allows `queue.capacity` from no other surface.
          return await client.request(
            entry.name,
            validated,
            PROJECTION_METHODS.has(entry.name)
              ? PROJECTION_REQUEST_TIMEOUT_MS
              : FORWARDED_REQUEST_TIMEOUT_MS,
            "paseo",
            key,
          );
        } catch (error) {
          // The connection is no longer trustworthy: close and release it, then
          // surface the typed state. A timed-out client must not linger as an orphan.
          if (
            !(error instanceof ServiceRequestError) ||
            ["timeout", "unavailable", "internal", "busy", "draining"].includes(
              error.code,
            )
          ) {
            this.session.dropClient();
            this.session.markUnhealthy(
              error instanceof Error ? error.message : String(error),
            );
          }
          throw error;
        }
      },
      awaitService: async (remaining) => {
        if (
          !rollWaitWorthy(this.dataDir) &&
          readServiceRoll(this.dataDir)?.status !== "failed"
        )
          return null;
        // ensure() waits out the roll handoff or replacement itself; its refusal
        // names the roll, which is the recovery's bound. Its own windows are the
        // roll's readiness budget, so the recovery's remaining time only tightens it.
        void remaining;
        return await this.ensure();
      },
      askOutcome: async (waited, key) =>
        parseRequestOutcome(
          await (waited as ServiceClient).request(
            "service.request-outcome",
            { key },
            CONNECT_ATTEMPT_TIMEOUT_MS,
          ),
        ),
      confirmingRead: (input2) => confirmationRead(entry.name, input2),
    });
    this.session.markRunning();
    return await (
      entry.contract.output as {
        parseAsync: (value: unknown) => Promise<unknown>;
      }
    ).parseAsync(raw);
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
    let expectedBuild: string;
    try {
      expectedBuild = this.session.buildId();
    } catch {
      return false;
    }
    const info = readServiceInfo(this.dataDir);
    if (
      !info ||
      info.protocolVersion !== SERVICE_PROTOCOL_VERSION ||
      info.buildId !== expectedBuild ||
      sessionsDiffer(info.sessionId, this.currentSession()) ||
      !this.options.processActions.pidAlive(info.pid)
    )
      return false;
    const client = this.session.client?.connected
      ? this.session.client
      : await this.tryConnect(info);
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
    if (this.session.closed)
      throw new ServiceBridgeUnavailable(
        "unhealthy",
        "this bridge is closed and cannot start the service",
      );
    this.session.buildId();
    if (this.session.client?.connected) {
      // A refused claim is retried on the retained connection until it is granted
      // (nucleus#972 / 971): otherwise hostPresenceClosed arms the plugin-lost
      // fault and this bridge never clears it.
      if (!this.session.presenceClaimed) await this.refreshPresenceClaim();
      if (this.session.client?.connected) return this.session.client;
    }
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.spawner.ensureOnce().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  /** Re-request the one presence claim on the retained connection. */
  private async refreshPresenceClaim(): Promise<void> {
    const client = this.session.client;
    if (!client?.connected || this.session.presenceClaimed) return;
    try {
      const presence = (await client.request(
        "service.nucleus-bridge-presence",
        {},
        CONNECT_ATTEMPT_TIMEOUT_MS,
      )) as { active?: unknown };
      this.session.presenceClaimed = presence?.active === true;
    } catch {
      if (!client.connected) this.session.dropClient();
    }
  }

  private async tryConnect(
    info: ServiceInfo,
    { claimPresence = true }: { claimPresence?: boolean } = {},
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
          `Service reports build ${String(health["buildId"] ?? "unknown")}; bridge expects ${buildId}`,
        );
        return null;
      }
      // The one presence claim (nucleus#971): a probe never takes it. A refused
      // claim still keeps this health-matching service for RPC (nucleus#972)
      // and is retried on the retained connection until granted, so the idle
      // clock and plugin-lost fault follow presence again.
      let presenceClaimed = false;
      if (claimPresence) {
        const presence = (await client.request(
          "service.nucleus-bridge-presence",
          {},
          CONNECT_ATTEMPT_TIMEOUT_MS,
        )) as { active?: unknown };
        presenceClaimed = presence?.active === true;
      }
      this.session.attach(client, health, presenceClaimed);
      try {
        this.options.processActions.removeServiceStartupFailure(this.dataDir);
      } catch {
        /* readiness is authoritative even if cleanup fails */
      }
      return client;
    } catch {
      client.close();
      return null;
    }
  }

  /**
   * Keep the presence claim, the owner and the plugin's reload current. The roll
   * itself belongs to the roll owner; this bridge only starts it when this plugin
   * was installed with the owner launch (the plugin entry does, fixtures do not).
   */
  watch() {
    // Presence is a hint only; identity is observed by the service itself.
    void this.ensure().catch(() => {});
    this.ensureOwner();
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => {
        void this.ensure().catch(() => {});
        this.ensureOwner();
        this.followLandedRoll();
      }, 2000);
      this.presenceTimer.unref?.();
    }
  }

  /** Start the main-channel roll owner for this install unless one already runs. */
  private ensureOwner() {
    if (!this.options.rollOwnerLaunch) return;
    try {
      ensureRollOwner({ dataDir: this.dataDir, root: this.session.sourcePath ?? sourcePathFromModule() });
    } catch {
      /* the owner's roll record names any failure it reaches; a missing entry is not a service failure */
    }
  }

  /**
   * A landed roll (recorded by the owner) reloads this plugin once, so the bridge
   * and UI load the contracts the new service answers with.
   */
  private followLandedRoll() {
    const roll = readServiceRoll(this.dataDir);
    if (roll?.status === "rolled" && roll.toBuild) this.reloadPlugin(roll.toBuild);
  }

  private reloadPlugin(buildId: string) {
    const command = this.options.reloadPluginCommand?.();
    if (!command || this.session.reloadedFor === buildId || buildId === this.session.pluginBuild) return;
    this.session.reloadedFor = buildId;
    try {
      const child = this.options.processActions.spawn(command.command, command.args, { detached: true, stdio: "ignore", env: process.env });
      child.on("error", () => {
        /* the header notice still asks for a manual reload */
      });
      child.unref();
    } catch {
      /* the header notice still asks for a manual reload */
    }
  }

  close() {
    this.session.closed = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.session.dropClient();
    this.session.report("absent", "");
  }
}

/** The host's record of where this plugin is installed, or null when it has none. */
function readInstalledSourcePath(paseoHome: string): string | null {
  let config: {
    plugins?: Record<string, { path?: unknown; enabled?: boolean } | null>;
  };
  try {
    config = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  return pluginRegistration(config.plugins)?.path ?? null;
}
