import type { ControlOrchestrationRunSummaryDto } from "./control/generated/ControlOrchestrationRunSummaryDto";

const now = BigInt(Math.floor(Date.now() / 1000));

export const fleetPanelRuns: ControlOrchestrationRunSummaryDto[] = [
  {
    run_id: "run:active-worker",
    state: "running",
    provider_instance: "codex:local-default",
    provider_model: "gpt-5.4-mini",
    orchestrator_designation: "operator:desktop",
    updated_at: now - 90n,
    has_closeout: false,
  },
  {
    run_id: "run:delivered-worker",
    state: "delivered",
    provider_instance: "codex:local-default",
    provider_model: "gpt-5.4-mini",
    orchestrator_designation: null,
    updated_at: now - 3600n,
    has_closeout: true,
  },
  {
    run_id: "run:failed-worker",
    state: "failed",
    provider_instance: "codex:local-default",
    provider_model: "gpt-5.4-mini",
    orchestrator_designation: null,
    updated_at: now - 7200n,
    has_closeout: false,
  },
];
