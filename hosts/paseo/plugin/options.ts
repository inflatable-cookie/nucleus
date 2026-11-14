import type { BridgeProcessActions } from "../../../shared/service/bridge-process";

/** A command to spawn detached, as a plain value so the composition supplies it. */
export type Command = { command: string; args: string[] };

/** The bridge's connect, health and drain attempts are all bounded by this window. */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_500;

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
