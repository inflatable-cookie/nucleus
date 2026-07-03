use nucleus_server::{
    ControlPlanningProjectionImportApplyBucketDto,
    ControlPlanningProjectionImportApplyDiagnosticsDto,
};

use super::*;

#[test]
fn planning_projection_import_apply_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::planning_projection_import_apply_response_lines(
        "planning-projection-import-apply-diagnostics",
        ControlPlanningProjectionImportApplyDiagnosticsDto {
            diagnostics_id: "planning-projection-import-apply-diagnostics".to_owned(),
            stopped_apply_record_count: 2,
            persisted_apply_record_count: 1,
            duplicate_noop_record_count: 0,
            blocked_apply_record_count: 1,
            planned_operation_count: 1,
            skipped_operation_count: 0,
            blocked_operation_count: 1,
            ready_count: 1,
            blocked_count: 1,
            conflict_count: 1,
            stale_count: 0,
            duplicate_noop_count: 0,
            repair_required_count: 0,
            blocker_count: 1,
            evidence_ref_count: 2,
            record_status_buckets: vec![ControlPlanningProjectionImportApplyBucketDto {
                label: "persisted".to_owned(),
                count: 1,
            }],
            blocker_buckets: vec![ControlPlanningProjectionImportApplyBucketDto {
                label: "ConflictStaged".to_owned(),
                count: 1,
            }],
            active_planning_mutation_permitted: false,
            task_creation_permitted: false,
            task_promotion_permitted: false,
            projection_write_permitted: false,
            agent_scheduling_permitted: false,
            provider_execution_permitted: false,
            scm_mutation_permitted: false,
            forge_mutation_permitted: false,
            semantic_merge_permitted: false,
            raw_payload_retained: false,
            payload_body_included: false,
            private_planning_body_exposed: false,
            provider_payload_exposed: false,
            source_body_exposed: false,
            ui_apply_permitted: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=planning-projection-import-apply-diagnostics"));
    assert!(rendered.contains("records=2"));
    assert!(rendered.contains("ready=1"));
    assert!(rendered.contains("blocked=1"));
    assert!(rendered.contains("conflict=1"));
    assert!(rendered.contains("active_planning_mutation_permitted=false"));
    assert!(rendered.contains("provider_execution_permitted=false"));
    assert!(rendered.contains("raw_payload_retained=false"));
    assert!(rendered.contains("private_planning_body_exposed=false"));
    assert!(rendered.contains("provider_payload_exposed=false"));
    assert!(rendered.contains("source_body_exposed=false"));
    assert!(rendered.contains("record_status label=persisted count=1"));
    assert!(rendered.contains("blocker label=ConflictStaged count=1"));
    assert!(!rendered.contains("private planning body"));
    assert!(!rendered.contains("raw projected payload"));
    assert!(!rendered.contains("provider_write_executed=true"));
}
