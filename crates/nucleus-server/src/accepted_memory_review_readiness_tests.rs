use nucleus_projects::ProjectId;

use crate::accepted_memory_projection::{AcceptedMemoryProjection, AcceptedMemoryProjectionRecord};
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;
use crate::accepted_memory_projection_import_diagnostics::{
    AcceptedMemoryProjectionImportDiagnosticRecord, AcceptedMemoryProjectionImportDiagnostics,
};
use crate::accepted_memory_projection_test_fixtures::accepted_memory;
use crate::accepted_memory_projection_write_diagnostics::{
    AcceptedMemoryProjectionWriteDiagnosticRecord, AcceptedMemoryProjectionWriteDiagnostics,
};
use crate::accepted_memory_review_readiness::{
    AcceptedMemoryReviewReadiness, AcceptedMemoryReviewReadinessStatus,
};

#[test]
fn readiness_composes_accepted_memory_projection_import_and_apply_state() {
    let project_id = ProjectId("project:nucleus".to_owned());
    let memory = accepted_memory("memory:ready");

    let projection = AcceptedMemoryProjection::from_projection_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionRecord::Accepted(memory.clone())],
    );
    let write_diagnostics = AcceptedMemoryProjectionWriteDiagnostics::from_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionWriteDiagnosticRecord::Accepted(
            memory.clone(),
        )],
    );
    let import_diagnostics = AcceptedMemoryProjectionImportDiagnostics::from_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionImportDiagnosticRecord::Accepted(
            memory,
        )],
    );
    let apply_diagnostics = AcceptedMemoryProjectionImportApplyDiagnostics::from_import_diagnostics(
        import_diagnostics.clone(),
    );

    let readiness = AcceptedMemoryReviewReadiness::from_diagnostics(
        projection,
        write_diagnostics,
        import_diagnostics,
        apply_diagnostics,
    );

    assert_eq!(readiness.project_id, project_id);
    assert_eq!(readiness.counts.accepted_memories, 1);
    assert_eq!(readiness.counts.projectable, 1);
    assert_eq!(readiness.counts.projection_write_admitted, 1);
    assert_eq!(readiness.counts.import_candidates_ready, 1);
    assert_eq!(readiness.counts.import_admitted, 1);
    assert_eq!(readiness.counts.duplicate_noops, 1);
    assert_eq!(readiness.counts.approval_required, 1);
    assert_eq!(readiness.counts.apply_blocked, 0);
    assert!(readiness.records.iter().any(|record| {
        record.status == AcceptedMemoryReviewReadinessStatus::ApprovalRequired
            && record.approval_required
    }));
    assert_no_effects(&readiness);
}

#[test]
fn readiness_keeps_duplicate_noops_and_conflicts_visible() {
    let project_id = ProjectId("project:nucleus".to_owned());
    let memory = accepted_memory("memory:duplicate");

    let projection = AcceptedMemoryProjection::from_projection_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionRecord::Accepted(memory.clone())],
    );
    let write_diagnostics = AcceptedMemoryProjectionWriteDiagnostics::from_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionWriteDiagnosticRecord::Accepted(
            memory.clone(),
        )],
    );
    let import_diagnostics = AcceptedMemoryProjectionImportDiagnostics::from_records(
        project_id,
        vec![AcceptedMemoryProjectionImportDiagnosticRecord::Accepted(
            memory,
        )],
    );
    let apply_diagnostics = AcceptedMemoryProjectionImportApplyDiagnostics::from_import_diagnostics(
        import_diagnostics.clone(),
    );

    let readiness = AcceptedMemoryReviewReadiness::from_diagnostics(
        projection,
        write_diagnostics,
        import_diagnostics,
        apply_diagnostics,
    );

    assert_eq!(readiness.counts.duplicate_noops, 1);
    assert_eq!(readiness.counts.approval_required, 1);
    assert!(readiness
        .records
        .iter()
        .any(|record| { record.status == AcceptedMemoryReviewReadinessStatus::DuplicateNoop }));
    assert_no_effects(&readiness);
}

#[test]
fn readiness_reports_blocked_projection_and_import_candidates() {
    let project_id = ProjectId("project:nucleus".to_owned());
    let mut memory = accepted_memory("memory:blocked");
    memory.actors.accepted_by_ref.clear();
    memory.review.reviewer_ref.clear();
    memory.accepted_at = None;

    let projection = AcceptedMemoryProjection::from_projection_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionRecord::Accepted(memory.clone())],
    );
    let write_diagnostics = AcceptedMemoryProjectionWriteDiagnostics::from_records(
        project_id.clone(),
        vec![AcceptedMemoryProjectionWriteDiagnosticRecord::Accepted(
            memory.clone(),
        )],
    );
    let import_diagnostics = AcceptedMemoryProjectionImportDiagnostics::from_records(
        project_id,
        vec![AcceptedMemoryProjectionImportDiagnosticRecord::Accepted(
            memory,
        )],
    );
    let apply_diagnostics = AcceptedMemoryProjectionImportApplyDiagnostics::from_import_diagnostics(
        import_diagnostics.clone(),
    );

    let readiness = AcceptedMemoryReviewReadiness::from_diagnostics(
        projection,
        write_diagnostics,
        import_diagnostics,
        apply_diagnostics,
    );

    assert_eq!(readiness.counts.projection_write_blocked, 1);
    assert_eq!(readiness.counts.import_candidates_blocked, 1);
    assert_eq!(readiness.counts.import_blocked, 2);
    assert!(readiness.counts.blocker_count > 0);
    assert_no_effects(&readiness);
}

fn assert_no_effects(readiness: &AcceptedMemoryReviewReadiness) {
    assert!(!readiness.no_effects.active_memory_apply_performed);
    assert!(!readiness.no_effects.projection_write_performed);
    assert!(!readiness.no_effects.scm_effect_performed);
    assert!(!readiness.no_effects.embedding_available);
    assert!(!readiness.no_effects.provider_sync_available);
    assert!(!readiness.no_effects.automatic_extraction_performed);
    assert!(!readiness.no_effects.task_mutation_performed);
    assert!(!readiness.no_effects.agent_scheduling_performed);
    assert!(!readiness.no_effects.ui_effect_performed);
}
