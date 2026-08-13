import type { ControlOrchestratorDesignationDto } from "./generated/ControlOrchestratorDesignationDto";
import type { ControlDelegationActionDto } from "./generated/ControlDelegationActionDto";
import { buildControlCommandEnvelope, buildControlQueryEnvelope, type ControlResponseEnvelopeDto } from "./envelopes";
import { submitControlEnvelope } from "./client";

export type { ControlDelegationActionDto };

export type OrchestratorDesignationsQueryResult =
  | { state: "record"; designations: ControlOrchestratorDesignationDto[] }
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type DesignationMutationResult =
  | { state: "accepted" }
  | { state: "rejected"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

/** List the project's orchestrator designations (any status). */
export async function queryOrchestratorDesignations(
  projectId: string,
  providerInstance?: string | null,
): Promise<OrchestratorDesignationsQueryResult> {
  const response = await submitControlEnvelope(
    buildControlQueryEnvelope({
      kind: "orchestrator_designations",
      query_id: "",
      action: "list",
      project_id: projectId,
      provider_instance: providerInstance ?? null,
    }),
  );
  switch (response.body.type) {
    case "orchestrator_designations":
      return { state: "record", designations: response.body.designations };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return { state: "error", kind: response.body.kind, reason: response.body.reason };
    default:
      return {
        state: "unexpected",
        reason: `unexpected designations response: ${response.body.type}`,
      };
  }
}

/** The active designation binding a provider instance to the project, if any. */
export async function queryActiveDesignationForSession(
  projectId: string,
  providerInstance: string,
): Promise<ControlOrchestratorDesignationDto | null> {
  const result = await queryOrchestratorDesignations(projectId, providerInstance);
  if (result.state !== "record") return null;
  return (
    result.designations.find((designation) => designation.status === "active") ?? null
  );
}

export type DesignationEnvelopeInput = {
  designationId: string;
  projectId: string;
  orchestratorProviderInstance: string;
  allowedWorkerProviderInstances: string[] | null;
  allowedWorkerModels: string[] | null;
  concurrentRunBudget: bigint;
  perRunTokenBudget: bigint | null;
  perRunTimeBudgetSeconds: bigint | null;
  allowedActions: ControlDelegationActionDto[];
  steeringPermitted: boolean;
  expectedRevision: string | null;
};

/** Designate (create) or re-designate (replace) a project orchestrator. */
export async function designateOrchestrator(
  input: DesignationEnvelopeInput,
): Promise<DesignationMutationResult> {
  const response = await submitControlEnvelope(
    buildControlCommandEnvelope({
      kind: "designate_orchestrator",
      command_id: "",
      designation_id: input.designationId,
      project_id: input.projectId,
      orchestrator_provider_instance: input.orchestratorProviderInstance,
      allowed_worker_provider_instances: input.allowedWorkerProviderInstances,
      allowed_worker_models: input.allowedWorkerModels,
      concurrent_run_budget: input.concurrentRunBudget,
      per_run_token_budget: input.perRunTokenBudget,
      per_run_time_budget_seconds: input.perRunTimeBudgetSeconds,
      allowed_actions: input.allowedActions,
      steering_permitted: input.steeringPermitted,
      expected_revision: input.expectedRevision,
    }),
  );
  return designationMutationFromResponse(response);
}

/** Revoke a designation; blocks new delegation, cancels no running work. */
export async function revokeOrchestrator(
  designationId: string,
  expectedRevision: string | null,
): Promise<DesignationMutationResult> {
  const response = await submitControlEnvelope(
    buildControlCommandEnvelope({
      kind: "revoke_orchestrator",
      command_id: "",
      designation_id: designationId,
      expected_revision: expectedRevision,
    }),
  );
  return designationMutationFromResponse(response);
}

export function designationMutationFromResponse(
  response: ControlResponseEnvelopeDto,
): DesignationMutationResult {
  if (response.body.type !== "command_receipt") {
    if (response.body.type === "error") {
      return { state: "rejected", kind: response.body.kind, reason: response.body.reason };
    }
    return {
      state: "unexpected",
      reason: `unexpected designation response: ${response.body.type}`,
    };
  }
  if (response.body.status === "accepted_for_state_mutation") {
    return { state: "accepted" };
  }
  return {
    state: "rejected",
    kind: response.body.error_kind ?? "command_rejected",
    reason: response.body.error_reason ?? response.body.status,
  };
}
