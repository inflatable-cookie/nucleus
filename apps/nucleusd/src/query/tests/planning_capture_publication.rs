use nucleus_server::{
    ControlPlanningCapturePublicationBucketDto, ControlPlanningCapturePublicationDiagnosticsDto,
};

#[test]
fn planning_capture_publication_response_lines_are_read_only_and_sanitized() {
    let lines = super::typed_response::planning_capture_publication_response_lines(
        "planning-capture-publication-diagnostics",
        ControlPlanningCapturePublicationDiagnosticsDto {
            diagnostics_id: "planning-capture-publication".to_owned(),
            request_count: 1,
            persisted_request_count: 1,
            duplicate_request_count: 0,
            blocked_request_count: 0,
            blocker_count: 0,
            adapter_family_buckets: vec![ControlPlanningCapturePublicationBucketDto {
                label: "snapshot_publication_like".to_owned(),
                count: 1,
            }],
            operation_buckets: vec![ControlPlanningCapturePublicationBucketDto {
                label: "publish".to_owned(),
                count: 1,
            }],
            evidence_ref_count: 1,
            management_file_ref_count: 2,
            command_execution_permitted: false,
            runner_handoff_permitted: false,
            commit_permitted: false,
            snapshot_permitted: false,
            publish_permitted: false,
            push_permitted: false,
            forge_share_permitted: false,
            provider_write_permitted: false,
            projection_import_permitted: false,
            task_promotion_permitted: false,
            callback_response_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            raw_payload_retained: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=planning-capture-publication-diagnostics"));
    assert!(rendered.contains("records=1"));
    assert!(rendered.contains("persisted=1"));
    assert!(rendered.contains("adapter_family label=snapshot_publication_like count=1"));
    assert!(rendered.contains("operation label=publish count=1"));
    assert!(rendered.contains("command_execution_permitted=false"));
    assert!(rendered.contains("runner_handoff_permitted=false"));
    assert!(rendered.contains("publish_permitted=false"));
    assert!(rendered.contains("projection_import_permitted=false"));
    assert!(rendered.contains("task_promotion_permitted=false"));
    assert!(rendered.contains("raw_payload_retained=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload_retained=true"));
    assert!(!rendered.contains("provider_secret"));
}
