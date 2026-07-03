import type { ControlResponseEnvelopeDto } from "./envelopes";

export type CountByLabelDto = {
  count: number;
  status?: string;
  kind?: string;
  scope?: string;
  sensitivity?: string;
  retention?: string;
};

export type ControlPlanningSessionSummaryDto = {
  session_id: string;
  kind: string;
  status: string;
  prompt_or_template_refs: string[];
  participant_count: number;
  source_ref_count: number;
  source_kind_counts: CountByLabelDto[];
  output_refs: {
    artifact_refs: string[];
    task_seed_refs: string[];
    memory_proposal_refs: string[];
    research_run_brief_refs: string[];
  };
};

export type ControlPlanningSessionSourceCountsDto = {
  planning_session_records: number;
  exploration_session_records: number;
  prompt_or_template_refs: number;
  participant_refs: number;
  source_refs: number;
  output_refs: number;
};

export type ControlMemoryProposalSummaryDto = {
  proposal_id: string;
  scope: string;
  kind: string;
  status: string;
  review_status: string;
  sensitivity: string;
  retention: string;
  source_ref_count: number;
  link_ref_count: number;
  supersedes_count: number;
  superseded_by_count: number;
};

export type ControlMemoryProposalSourceCountsDto = {
  proposal_records: number;
  source_refs: number;
  link_refs: number;
  supersession_refs: number;
};

export type ControlResearchRunBriefSummaryDto = {
  run_id: string;
  status: string;
  source_plan_ref_count: number;
  question_count: number;
  source_ref_count: number;
  observation_ref_count: number;
  synthesis_ref_count: number;
  promotion_target_ref_count: number;
  coverage_ref_count: number;
  gap_ref_count: number;
};

export type ControlResearchRunBriefSourceCountsDto = {
  run_records: number;
  source_plan_refs: number;
  questions: number;
  source_refs: number;
  observation_refs: number;
  synthesis_refs: number;
  promotion_target_refs: number;
  coverage_refs: number;
  gap_refs: number;
};

export type PlanningSessionsQueryResult =
  | {
      state: "records";
      project_id: string;
      sessions: ControlPlanningSessionSummaryDto[];
      status_counts: CountByLabelDto[];
      source_counts: ControlPlanningSessionSourceCountsDto;
      client_can_mutate: false;
      provider_execution_available: false;
    }
  | QueryFallback;

export type MemoryProposalsQueryResult =
  | {
      state: "records";
      project_id: string;
      proposals: ControlMemoryProposalSummaryDto[];
      status_counts: CountByLabelDto[];
      scope_counts: CountByLabelDto[];
      sensitivity_counts: CountByLabelDto[];
      retention_counts: CountByLabelDto[];
      source_counts: ControlMemoryProposalSourceCountsDto;
      client_can_mutate: false;
      provider_execution_available: false;
    }
  | QueryFallback;

export type ResearchRunBriefsQueryResult =
  | {
      state: "records";
      project_id: string;
      runs: ControlResearchRunBriefSummaryDto[];
      status_counts: CountByLabelDto[];
      source_kind_counts: CountByLabelDto[];
      observation_kind_counts: CountByLabelDto[];
      synthesis_kind_counts: CountByLabelDto[];
      source_counts: ControlResearchRunBriefSourceCountsDto;
      client_can_mutate: false;
      provider_execution_available: false;
    }
  | QueryFallback;

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export function planningSessionsFromResponse(
  response: ControlResponseEnvelopeDto,
): PlanningSessionsQueryResult {
  switch (response.body.type) {
    case "planning_sessions":
      return {
        state: "records",
        project_id: response.body.project_id,
        sessions: response.body.sessions,
        status_counts: response.body.status_counts,
        source_counts: response.body.source_counts,
        client_can_mutate: response.body.client_can_mutate,
        provider_execution_available: response.body.provider_execution_available,
      };
    default:
      return fallbackFromResponse(response, "planning sessions");
  }
}

export function memoryProposalsFromResponse(
  response: ControlResponseEnvelopeDto,
): MemoryProposalsQueryResult {
  switch (response.body.type) {
    case "memory_proposals":
      return {
        state: "records",
        project_id: response.body.project_id,
        proposals: response.body.proposals,
        status_counts: response.body.status_counts,
        scope_counts: response.body.scope_counts,
        sensitivity_counts: response.body.sensitivity_counts,
        retention_counts: response.body.retention_counts,
        source_counts: response.body.source_counts,
        client_can_mutate: response.body.client_can_mutate,
        provider_execution_available: response.body.provider_execution_available,
      };
    default:
      return fallbackFromResponse(response, "memory proposals");
  }
}

export function researchRunBriefsFromResponse(
  response: ControlResponseEnvelopeDto,
): ResearchRunBriefsQueryResult {
  switch (response.body.type) {
    case "research_run_briefs":
      return {
        state: "records",
        project_id: response.body.project_id,
        runs: response.body.runs,
        status_counts: response.body.status_counts,
        source_kind_counts: response.body.source_kind_counts,
        observation_kind_counts: response.body.observation_kind_counts,
        synthesis_kind_counts: response.body.synthesis_kind_counts,
        source_counts: response.body.source_counts,
        client_can_mutate: response.body.client_can_mutate,
        provider_execution_available: response.body.provider_execution_available,
      };
    default:
      return fallbackFromResponse(response, "research run briefs");
  }
}

function fallbackFromResponse(
  response: ControlResponseEnvelopeDto,
  label: string,
): QueryFallback {
  switch (response.body.type) {
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
        reason: `unexpected ${label} response: ${response.body.type}`,
      };
  }
}
