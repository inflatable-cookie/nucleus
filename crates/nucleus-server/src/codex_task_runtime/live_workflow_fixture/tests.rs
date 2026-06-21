use super::*;

#[test]
fn task_backed_live_workflow_fixture_replays_full_path_without_side_effects() {
    let replay = task_backed_live_workflow_fixture();

    assert!(replay.scheduler_admitted);
    assert!(replay.live_executor_admitted);
    assert_eq!(replay.runtime_progress, "Completed");
    assert_eq!(replay.receipt_link.receipt_id, "receipt:fixture");
    assert_eq!(replay.timeline.entries.len(), 1);
    assert_eq!(replay.task_diagnostics.work_units.len(), 1);
    assert_eq!(replay.live_execution_diagnostics.attempts.len(), 2);
    assert!(!replay.task_completion_permitted_by_runtime);
    assert!(!replay.review_acceptance_permitted_by_runtime);
    assert!(replay.review_accepted_by_explicit_command);
    assert!(!replay.provider_write_executed_before_explicit_smoke);
    assert!(!replay.raw_provider_material_retained);
}

#[test]
fn task_backed_live_workflow_fixture_replay_is_deterministic() {
    let first = task_backed_live_workflow_fixture();
    let second = task_backed_live_workflow_fixture();

    assert_eq!(first, second);
}

#[test]
fn task_backed_live_workflow_fixture_contains_no_raw_provider_material() {
    let replay = task_backed_live_workflow_fixture();
    let debug = format!("{replay:?}");

    assert!(!debug.contains("raw_stdout"));
    assert!(!debug.contains("raw_stderr"));
    assert!(!debug.contains("raw_payload"));
    assert!(!debug.contains("stream_delta"));
    assert!(!replay.live_execution_diagnostics.provider_material_exposed);
}
