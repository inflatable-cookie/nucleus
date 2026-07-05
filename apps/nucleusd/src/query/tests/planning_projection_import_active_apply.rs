use nucleus_server::{
    ControlPlanningProjectionImportActiveApplyBucketDto,
    ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
};

use super::*;

#[test]
fn planning_projection_import_active_apply_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::planning_projection_import_active_apply_response_lines(
        "planning-projection-import-active-apply-diagnostics",
        ControlPlanningProjectionImportActiveApplyDiagnosticsDto {
            diagnostics_id: "planning-projection-import-active-apply-diagnostics".to_owned(),
            admission_record_count: 2,
            admitted_record_count: 1,
            duplicate_noop_record_count: 0,
            blocked_record_count: 1,
            operation_ref_count: 1,
            evidence_ref_count: 2,
            blocker_count: 1,
            stale_count: 0,
            conflict_count: 1,
            unsupported_count: 0,
            repair_required_count: 0,
            missing_ref_count: 0,
            record_status_buckets: vec![ControlPlanningProjectionImportActiveApplyBucketDto {
                label: "admitted_stopped".to_owned(),
                count: 1,
            }],
            blocker_buckets: vec![ControlPlanningProjectionImportActiveApplyBucketDto {
                label: "ConflictEvidence".to_owned(),
                count: 1,
            }],
            active_planning_mutation_permitted: false,
            executor_invocation_permitted: false,
            task_creation_permitted: false,
            task_promotion_permitted: false,
            projection_write_permitted: false,
            agent_scheduling_permitted: false,
            provider_execution_permitted: false,
            scm_mutation_permitted: false,
            forge_mutation_permitted: false,
            semantic_merge_permitted: false,
            accepted_memory_mutation_permitted: false,
            callback_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            raw_payload_retained: false,
            payload_body_included: false,
            private_planning_body_exposed: false,
            provider_payload_exposed: false,
            source_body_exposed: false,
            ui_apply_permitted: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=planning-projection-import-active-apply-diagnostics"));
    assert!(rendered.contains("records=2"));
    assert!(rendered.contains("admitted=1"));
    assert!(rendered.contains("conflict=1"));
    assert!(rendered.contains("executor_invocation_permitted=false"));
    assert!(rendered.contains("raw_payload_retained=false"));
    assert!(rendered.contains("private_planning_body_exposed=false"));
    assert!(!rendered.contains("raw projected payload"));
    assert!(!rendered.contains("private planning body"));
    assert!(!rendered.contains("access_token"));
}
