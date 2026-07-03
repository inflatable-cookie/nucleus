use nucleus_projects::ProjectId;

use crate::control_api::{ServerControlResponse, ServerControlResponseBody, ServerQueryResult};
use crate::control_envelope_dto::{ControlResponseBodyDto, ControlResponseEnvelopeDto};
use crate::research_run_briefs_projection::{
    ResearchObservationKindCount, ResearchObservationKindSummary, ResearchRunBriefSourceCounts,
    ResearchRunBriefStatusCount, ResearchRunBriefSummary, ResearchRunBriefSummaryStatus,
    ResearchRunBriefsProjection, ResearchSourceKindCount, ResearchSourceKindSummary,
    ResearchSynthesisKindCount, ResearchSynthesisKindSummary,
};
use crate::{ServerControlRequestId, ServerControlResponseStatus};

#[test]
fn response_envelope_dto_serializes_research_run_briefs_without_bodies_or_effects() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:research-run-briefs".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::ResearchRunBriefs(
            ResearchRunBriefsProjection {
                project_id: ProjectId("project:nucleus".to_owned()),
                runs: vec![ResearchRunBriefSummary {
                    run_id: "research-run:nucleus:harness".to_owned(),
                    status: ResearchRunBriefSummaryStatus::Proposed,
                    source_plan_ref_count: 1,
                    question_count: 1,
                    source_ref_count: 1,
                    observation_ref_count: 1,
                    synthesis_ref_count: 1,
                    promotion_target_ref_count: 2,
                    coverage_ref_count: 0,
                    gap_ref_count: 2,
                }],
                status_counts: vec![ResearchRunBriefStatusCount {
                    status: ResearchRunBriefSummaryStatus::Proposed,
                    count: 1,
                }],
                source_kind_counts: vec![ResearchSourceKindCount {
                    kind: ResearchSourceKindSummary::OfficialDocs,
                    count: 1,
                }],
                observation_kind_counts: vec![ResearchObservationKindCount {
                    kind: ResearchObservationKindSummary::Evidence,
                    count: 1,
                }],
                synthesis_kind_counts: vec![ResearchSynthesisKindCount {
                    kind: ResearchSynthesisKindSummary::DecisionSupport,
                    count: 1,
                }],
                source_counts: ResearchRunBriefSourceCounts {
                    run_records: 1,
                    source_plan_refs: 1,
                    questions: 1,
                    source_refs: 1,
                    observation_refs: 1,
                    synthesis_refs: 1,
                    promotion_target_refs: 2,
                    coverage_refs: 0,
                    gap_refs: 2,
                },
                client_can_mutate: false,
                provider_execution_available: false,
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    let ControlResponseBodyDto::ResearchRunBriefs {
        project_id,
        runs,
        source_counts,
        client_can_mutate,
        provider_execution_available,
        ..
    } = dto.body
    else {
        panic!("expected research run briefs body");
    };

    assert_eq!(project_id, "project:nucleus");
    assert_eq!(runs[0].run_id, "research-run:nucleus:harness");
    assert_eq!(source_counts.questions, 1);
    assert!(!client_can_mutate);
    assert!(!provider_execution_available);
    assert!(json.contains("\"type\":\"research_run_briefs\""));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("browser_cache"));
    assert!(!json.contains("secret"));
    assert!(!json.contains("private_note"));
}
