import { createContext, useContext } from "react";

/**
 * What the engine behind this board supports. The TypeScript engine supports
 * everything; the Rust engine (Spec 070) drops the machinery its rulings retire.
 * A surface checks the flag for a retired control and leaves it out, so one set
 * of screens serves both engines. Each `false` names its ruling in
 * `RUST_ENGINE_FEATURES`.
 */
export interface EngineFeatures {
  /** The engine behind the board. */
  engine: "typescript" | "rust";
  /** Header refresh: re-reads the host profile catalogue (`queue.refresh`). */
  catalogRefresh: boolean;
  /** Service state notices under the header (`queue.service-state`). */
  serviceNotices: boolean;
  /** Settings → Telemetry and its task telemetry reads. */
  telemetry: boolean;
  /** Settings → Backups, with Back up now and the tiered snapshot list. */
  backupsTab: boolean;
  /** Legacy Limits controls for papercuts, stall, hold, drain, outages and pruning. */
  advancedLimits: boolean;
  /** A global per-project default limit separate from each project's own slots. */
  projectDefaultLimit: boolean;
  /** Bound runs and per-project slot usage in the queue menu. */
  slotUsage: boolean;
  /** The coordinator dispatch role, as a Profiles usage view. */
  coordinatorRole: boolean;
  /** Projects: agent registration, planner picking and legacy project management. */
  projectAgents: boolean;
  /** Hosts: the multi-host catalogue, default host and host removal. */
  hostCatalog: boolean;
  /** Lead check and approve steps, lane keeps and drain prompts. */
  planningCeremony: boolean;
  /** Decision withdraw and free-text answers. */
  decisionWithdraw: boolean;
}

export const TYPESCRIPT_ENGINE_FEATURES: EngineFeatures = {
  engine: "typescript",
  catalogRefresh: true,
  serviceNotices: true,
  telemetry: true,
  backupsTab: true,
  advancedLimits: true,
  projectDefaultLimit: true,
  slotUsage: true,
  coordinatorRole: true,
  projectAgents: true,
  hostCatalog: true,
  planningCeremony: true,
  decisionWithdraw: true,
};

/** Spec 070's retired machinery. Each entry names the ruling that retires it. */
export const RUST_ENGINE_FEATURES: EngineFeatures = {
  engine: "rust",
  // Ruling 11: Profiles owns the action that reloads the held catalog.
  catalogRefresh: false,
  // Ruling 16: one health endpoint replaces the service-state notices.
  serviceNotices: false,
  // Ruling 16: no telemetry stage catalogue.
  telemetry: false,
  // Ruling 17: Storage folds in backups and retention; the engine has no backup-now verb.
  backupsTab: false,
  // Tom retired Papercuts slots, Stall threshold, Hold reminder, Hold escalation
  // and Host outage notice on 2026-11-24. Ruling 12 retires Lane drain and its
  // escalation. Ruling 5 retires Default host (hostCatalog below).
  advancedLimits: false,
  projectDefaultLimit: true,
  // Ruling 11: the board reads no run custody beyond each task's own summary.
  slotUsage: false,
  // Ruling 1: worker and reviewer are the only dispatch roles.
  coordinatorRole: false,
  // Ruling 8: planners resolve live and are never typed in; no agent
  // registration, merge or bulk cancellation.
  projectAgents: false,
  // Rulings 5 and 17: T3 is the only host.
  hostCatalog: false,
  // Ruling 12 and the planning model: promotion is one step; no keeps or drain prompts.
  planningCeremony: false,
  // Planning model: a decision is answered by choosing one of its options.
  decisionWithdraw: false,
};

export const EngineFeaturesContext = createContext<EngineFeatures>(
  TYPESCRIPT_ENGINE_FEATURES,
);

export function useEngineFeatures(): EngineFeatures {
  return useContext(EngineFeaturesContext);
}
