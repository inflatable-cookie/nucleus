use nucleus_server::{
    ControlPlanningProjectionImportBucketDto, ControlPlanningProjectionImportDiagnosticsDto,
};

use super::*;

#[test]
fn planning_projection_import_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::planning_projection_import_response_lines(
        "planning-projection-import-diagnostics",
        ControlPlanningProjectionImportDiagnosticsDto {
            diagnostics_id: "planning-projection-import-diagnostics".to_owned(),
            candidate_count: 1,
            ready_candidate_count: 1,
            blocked_candidate_count: 0,
            admission_count: 1,
            admitted_stopped_count: 1,
            duplicate_noop_count: 0,
            blocked_admission_count: 0,
            conflict_count: 1,
            blocker_count: 1,
            evidence_ref_count: 2,
            candidate_status_buckets: vec![ControlPlanningProjectionImportBucketDto {
                label: "ready".to_owned(),
                count: 1,
            }],
            admission_status_buckets: vec![ControlPlanningProjectionImportBucketDto {
                label: "admitted_stopped".to_owned(),
                count: 1,
            }],
            conflict_kind_buckets: vec![ControlPlanningProjectionImportBucketDto {
                label: "artifact_title".to_owned(),
                count: 1,
            }],
            apply_blocked: true,
            apply_permitted: false,
            task_promotion_permitted: false,
            provider_execution_permitted: false,
            scm_mutation_permitted: false,
            forge_mutation_permitted: false,
            raw_payload_retained: false,
            ui_apply_permitted: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=planning-projection-import-diagnostics"));
    assert!(rendered.contains("records=3"));
    assert!(rendered.contains("ready_candidates=1"));
    assert!(rendered.contains("admitted_stopped=1"));
    assert!(rendered.contains("conflicts=1"));
    assert!(rendered.contains("apply_blocked=true"));
    assert!(rendered.contains("apply_permitted=false"));
    assert!(rendered.contains("task_promotion_permitted=false"));
    assert!(rendered.contains("provider_execution_permitted=false"));
    assert!(rendered.contains("scm_mutation_permitted=false"));
    assert!(rendered.contains("forge_mutation_permitted=false"));
    assert!(rendered.contains("raw_payload_retained=false"));
    assert!(rendered.contains("ui_apply_permitted=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(rendered.contains("candidate_status label=ready count=1"));
    assert!(rendered.contains("admission_status label=admitted_stopped count=1"));
    assert!(rendered.contains("conflict_kind label=artifact_title count=1"));
    assert!(!rendered.contains("problem_statement"));
    assert!(!rendered.contains("raw import payload body"));
    assert!(!rendered.contains("provider_write_executed=true"));
}
