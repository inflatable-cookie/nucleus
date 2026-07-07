import type { ControlResponseEnvelopeDto } from "./envelopes";
import type { ControlTaskWorkflowNoEffectsDto } from "./taskWorkflow";

export type ControlSelectedTaskReviewSummaryDto = {
  state: string;
  reason: string;
  work_item_refs: string[];
  evidence_refs: string[];
};

export type ControlSelectedTaskReviewEvidenceDto = {
  receipt_refs: string[];
  checkpoint_refs: string[];
  diff_summary_refs: string[];
  validation_refs: string[];
  timeline_refs: string[];
  review_refs: string[];
};

export type ControlSelectedTaskReviewNextStepDto = {
  category: string;
  summary: string;
  next_ref: string | null;
  rationale_refs: string[];
};

export type ControlSelectedTaskReviewNextSourceCountsDto = {
  task_records: number;
  work_items: number;
  active_work_items: number;
  completed_work_items: number;
  reviewable_work_items: number;
  receipt_refs: number;
  checkpoint_refs: number;
  diff_summary_refs: number;
  validation_refs: number;
  timeline_refs: number;
  review_refs: number;
  task_completion_refs: number;
  guidance_refs: number;
  gap_count: number;
};

export type ControlSelectedTaskReviewGapDto = {
  area: string;
  reason: string;
};

export type ControlSelectedTaskReviewNextNoEffectsDto = ControlTaskWorkflowNoEffectsDto & {
  review_mutation_performed: boolean;
};

export type ControlSelectedTaskReviewNextDto = {
  review_next_id: string;
  project_id: string;
  task_id: string;
  review: ControlSelectedTaskReviewSummaryDto;
  evidence: ControlSelectedTaskReviewEvidenceDto;
  next: ControlSelectedTaskReviewNextStepDto;
  source_counts: ControlSelectedTaskReviewNextSourceCountsDto;
  gaps: ControlSelectedTaskReviewGapDto[];
  no_effects: ControlSelectedTaskReviewNextNoEffectsDto;
};

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type SelectedTaskReviewNextQueryResult =
  | {
      state: "record";
      reviewNext: ControlSelectedTaskReviewNextDto;
    }
  | QueryFallback;

export function selectedTaskReviewNextFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskReviewNextQueryResult {
  switch (response.body.type) {
    case "selected_task_review_next":
      return {
        state: "record",
        reviewNext: response.body.review_next,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected selected task review next response: ${response.body.type}`,
      };
  }
}
