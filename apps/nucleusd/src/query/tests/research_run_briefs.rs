use nucleus_server::{
    ControlResearchObservationKindCountDto, ControlResearchRunBriefSourceCountsDto,
    ControlResearchRunBriefStatusCountDto, ControlResearchRunBriefSummaryDto,
    ControlResearchSourceKindCountDto, ControlResearchSynthesisKindCountDto,
};

use super::*;

#[test]
fn research_run_briefs_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::research_run_briefs_response_lines(
        "research-run-briefs",
        "project:nucleus-local".to_owned(),
        vec![ControlResearchRunBriefSummaryDto {
            run_id: "research-run:nucleus-local:harness-communications".to_owned(),
            status: "proposed".to_owned(),
            source_plan_ref_count: 1,
            question_count: 1,
            source_ref_count: 1,
            observation_ref_count: 1,
            synthesis_ref_count: 1,
            promotion_target_ref_count: 2,
            coverage_ref_count: 0,
            gap_ref_count: 3,
        }],
        vec![ControlResearchRunBriefStatusCountDto {
            status: "proposed".to_owned(),
            count: 1,
        }],
        vec![ControlResearchSourceKindCountDto {
            kind: "official_docs".to_owned(),
            count: 1,
        }],
        vec![ControlResearchObservationKindCountDto {
            kind: "evidence".to_owned(),
            count: 1,
        }],
        vec![ControlResearchSynthesisKindCountDto {
            kind: "decision_support".to_owned(),
            count: 1,
        }],
        ControlResearchRunBriefSourceCountsDto {
            run_records: 1,
            source_plan_refs: 1,
            questions: 1,
            source_refs: 1,
            observation_refs: 1,
            synthesis_refs: 1,
            promotion_target_refs: 2,
            coverage_refs: 0,
            gap_refs: 3,
        },
        false,
        false,
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=research-run-briefs"));
    assert!(rendered.contains("runs=1"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("provider_execution_available=false"));
    assert!(rendered.contains("source_kind kind=official_docs count=1"));
    assert!(rendered.contains("observation_kind kind=evidence count=1"));
    assert!(rendered.contains("synthesis_kind kind=decision_support count=1"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("browser_cache"));
    assert!(!rendered.contains("secret"));
    assert!(!rendered.contains("private_note"));
}
