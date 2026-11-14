import type { ServiceClient } from "../../../shared/service/client";
import type { StandbyWaitCause } from "../../../shared/service/standby-wait";

/** The typed state the bridge reports for the service it forwards to. */
export type BridgeState = "absent" | "starting" | "running" | "incompatible" | "upgrading" | "unhealthy";

export class ServiceBridgeUnavailable extends Error {
  constructor(readonly state: BridgeState, detail: string) {
    super(`Queue service ${state}: ${detail}`);
  }
}

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

/**
 * One bridge instance's session with the service: what it expects to run, what
 * it is connected to, and the one roll handoff it may own.
 *
 * The bridge, the spawner and the roll scheduler all read and write these facts,
 * so they live in one typed record rather than in three copies of a mutable
 * field. Every transition that more than one of them performs has a name here:
 * the typed state report, the connection attach and drop, the compatibility
 * failure, and the activation step a roll installs.
 */
export class BridgeSession {
  state: BridgeState = "absent";
  detail = "";
  client: ServiceClient | null = null;
  health: Record<string, unknown> | null = null;
  presenceClaimed = false;
  /** Build the service must answer with; an Error means this bridge cannot start one. */
  expected: string | Error;
  /** Installed plugin source the service may be spawned from. */
  sourcePath: string | null;
  /** Source revision the expected build describes, and the last revision whose main build failed. */
  sourceDigest: string | null = null;
  failedDigest: string | null = null;
  /**
   * Set while this bridge owns a roll handoff (spawn, drain, replacement wait).
   * A bridge that did not start the handoff waits for it instead of spawning a
   * second owner over an uncertain one (2026-10-04, a reload during a roll).
   */
  handoff = false;
  /** Set while a roll replaces the service, so the drain can record it on affected tasks. */
  rollNote: { fromBuild: string; toBuild: string } | null = null;
  /** Latest standby readiness observation; a cold one explains a longer endpoint gap. */
  lastStandbyReadiness: StandbyReadiness | null = null;
  /** Build the plugin loaded with; the UI bundle is this old until a plugin reload. */
  pluginBuild: string | null;
  /** Build the plugin already reloaded for, so a landed roll reloads it once. */
  reloadedFor: string | null = null;
  /** A closed bridge is a released fixture or plugin owner: it never spawns again. */
  closed = false;

  constructor(expected: string | Error, pluginBuild: string | null, sourcePath: string | null, sourceDigest: string | null) {
    this.expected = expected;
    this.pluginBuild = pluginBuild;
    this.sourcePath = sourcePath;
    this.sourceDigest = sourceDigest;
  }

  /** Report the typed state a caller will see; the detail always names what was observed. */
  report(state: BridgeState, detail: string) { this.state = state; this.detail = detail; }

  markRunning() { this.state = "running"; this.detail = ""; }

  markUnhealthy(detail: string) { this.state = "unhealthy"; this.detail = detail; }

  /** The build id this bridge insists on, or a typed refusal when it has none. */
  buildId(): string {
    if (this.expected instanceof Error) throw new ServiceBridgeUnavailable("unhealthy", this.expected.message);
    return this.expected;
  }

  /** Keep the authenticated connection and the one presence claim it holds. */
  attach(client: ServiceClient, health: Record<string, unknown>, presenceClaimed: boolean) {
    this.client = client;
    this.health = health;
    this.presenceClaimed = presenceClaimed;
    this.markRunning();
  }

  /** Drop the cached connection; the presence claim rides it and goes with it. */
  dropClient() {
    const stale = this.client;
    this.client = null;
    this.presenceClaimed = false;
    stale?.close();
  }
}
