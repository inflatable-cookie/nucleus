import { parseSingleRecordResponse, type QueryFallback } from "./singleRecordResponse";
import type { ControlResponseEnvelopeDto } from "./envelopes";

export type ControlSelectedTaskScmHandoffSummaryDto = {
  state: string;
  reason: string;
  handoff_refs: string[];
  blocker_refs: string[];
};

export type ControlSelectedTaskScmHandoffTargetDto = {
  shape: string;
  target_refs: string[];
};

export type ControlSelectedTaskScmHandoffEvidenceDto = {
  work_item_refs: string[];
  scm_handoff_refs: string[];
  scm_work_session_refs: string[];
  provider_change_refs: string[];
  checkpoint_refs: string[];
  diff_summary_refs: string[];
  runtime_receipt_refs: string[];
  validation_refs: string[];
  review_refs: string[];
  change_request_prep_refs: string[];
  repair_refs: string[];
};

export type ControlSelectedTaskScmHandoffNextStepDto = {
  category: string;
  summary: string;
  next_ref: string | null;
  rationale_refs: string[];
};

export type ControlSelectedTaskScmHandoffSourceCountsDto = {
  task_records: number;
  work_items: number;
  scm_handoff_refs: number;
  scm_work_session_refs: number;
  provider_change_refs: number;
  checkpoint_refs: number;
  diff_summary_refs: number;
  runtime_receipt_refs: number;
  validation_refs: number;
  review_refs: number;
  change_request_prep_refs: number;
  repair_refs: number;
  gap_count: number;
};

export type ControlSelectedTaskScmHandoffGapDto = {
  area: string;
  reason: string;
};

export type ControlSelectedTaskScmHandoffNoEffectsDto = {
  scm_mutation_performed: boolean;
  forge_mutation_performed: boolean;
  credential_resolution_performed: boolean;
  task_mutation_performed: boolean;
  provider_execution_performed: boolean;
  review_mutation_performed: boolean;
  accepted_memory_apply_performed: boolean;
  planning_apply_performed: boolean;
  projection_write_performed: boolean;
  ui_effect_performed: boolean;
};

export type ControlSelectedTaskScmHandoffDto = {
  handoff_id: string;
  project_id: string;
  task_id: string;
  readiness: ControlSelectedTaskScmHandoffSummaryDto;
  target: ControlSelectedTaskScmHandoffTargetDto;
  evidence: ControlSelectedTaskScmHandoffEvidenceDto;
  next: ControlSelectedTaskScmHandoffNextStepDto;
  source_counts: ControlSelectedTaskScmHandoffSourceCountsDto;
  gaps: ControlSelectedTaskScmHandoffGapDto[];
  no_effects: ControlSelectedTaskScmHandoffNoEffectsDto;
};

export type SelectedTaskScmHandoffQueryResult =
  | {
      state: "record";
      handoff: ControlSelectedTaskScmHandoffDto;
    }
  | QueryFallback;

export function selectedTaskScmHandoffFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskScmHandoffQueryResult {
  return parseSingleRecordResponse(response, "selected_task_scm_handoff", "selected task SCM handoff", (body) => ({
    state: "record" as const,
    handoff: body.handoff,
  }));
}
