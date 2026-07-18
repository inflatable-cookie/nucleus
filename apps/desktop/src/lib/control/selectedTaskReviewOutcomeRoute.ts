import { parseSingleRecordResponse, type QueryFallback } from "./singleRecordResponse";
import type { ControlResponseEnvelopeDto } from "./envelopes";

export type ControlSelectedTaskReviewOutcomeRouteSourceCountsDto = {
  decision_records: number;
  work_item_refs: number;
  evidence_refs: number;
  review_gap_count: number;
  scm_handoff_refs: number;
  downstream_command_hints: number;
  blockers: number;
};

export type ControlSelectedTaskReviewOutcomeRouteNoEffectsDto = {
  review_mutation_performed: boolean;
  task_lifecycle_mutation_performed: boolean;
  provider_execution_performed: boolean;
  provider_write_performed: boolean;
  scm_or_forge_mutation_performed: boolean;
  accepted_memory_apply_performed: boolean;
  planning_apply_performed: boolean;
  projection_write_performed: boolean;
  agent_scheduling_performed: boolean;
  ui_effect_performed: boolean;
};

export type ControlSelectedTaskReviewOutcomeRouteDto = {
  route_id: string;
  project_id: string;
  task_id: string;
  status: string;
  primary_route: string;
  candidates: string[];
  decision_ref: string | null;
  decision_outcome: string | null;
  work_item_refs: string[];
  evidence_refs: string[];
  downstream_command_hints: string[];
  blockers: string[];
  source_counts: ControlSelectedTaskReviewOutcomeRouteSourceCountsDto;
  no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;
};

export type SelectedTaskReviewOutcomeRouteQueryResult =
  | {
      state: "record";
      route: ControlSelectedTaskReviewOutcomeRouteDto;
    }
  | QueryFallback;

export function selectedTaskReviewOutcomeRouteFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskReviewOutcomeRouteQueryResult {
  return parseSingleRecordResponse(response, "selected_task_review_outcome_route", "selected task review outcome route", (body) => ({
    state: "record" as const,
    route: body.route,
  }));
}
