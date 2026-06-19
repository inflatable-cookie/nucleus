use super::*;
use crate::{
    validate_projection_envelope, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
    ManagementProjectionApplyCommand, ManagementProjectionApplyCommandId,
    ManagementProjectionApplyRecordTarget, ManagementProjectionConflictClass,
    ManagementProjectionConflictReport, ManagementProjectionEnvelope,
    ManagementProjectionExcludedStateMarker, ManagementProjectionFileRef,
    ManagementProjectionRecordId, ManagementProjectionRecordKind, ManagementProjectionRoot,
    ManagementProjectionSchemaConflictKind, ManagementProjectionSchemaVersion,
    ManagementProjectionScmConflictKind, ManagementProjectionSemanticConflictKind,
    ManagementProjectionUnsupportedConflictKind, ManagementProjectionValidationStatus,
};
use nucleus_core::RevisionId;
use nucleus_projects::{ProjectId, RepoMembershipId};
use nucleus_scm_forge::{
    GitStatusEntry, GitStatusEntryKind, GitStatusSnapshot, ScmRepositoryRefId,
};

mod apply;
mod assistance;
mod capture;
mod git_capture;
mod plans;
mod repairs;

fn conflict_report(class: ManagementProjectionConflictClass) -> ManagementProjectionConflictReport {
    ManagementProjectionConflictReport {
        conflict_id: "conflict:projection:1".to_owned(),
        file_ref: ManagementProjectionFileRef::task("task:1"),
        local_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
        incoming_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
        class,
        summary: "projection conflict evidence".to_owned(),
    }
}

fn capture_command(
    policy_gates: Vec<ManagementProjectionCapturePolicyGate>,
) -> ManagementProjectionCaptureCommand {
    ManagementProjectionCaptureCommand {
        command_id: ManagementProjectionCaptureCommandId("capture-command:1".to_owned()),
        actor_ref: "actor:steward".to_owned(),
        target_project_id: ProjectId("project:nucleus".to_owned()),
        repo_membership_id: Some(RepoMembershipId("repo:nucleus".to_owned())),
        repository_id: Some(ScmRepositoryRefId("scm-repo:nucleus".to_owned())),
        projection_root: ManagementProjectionRoot::default(),
        requested_file_refs: vec![
            ManagementProjectionFileRef::project(),
            ManagementProjectionFileRef::task("task:1"),
        ],
        reason: ManagementProjectionCaptureReason::AppliedManagementProjection,
        scope: ManagementProjectionCaptureScope::ManagementProjection,
        policy_gates,
        evidence: ManagementProjectionCaptureEvidence {
            projection_file_refs: vec![
                ManagementProjectionFileRef::project(),
                ManagementProjectionFileRef::task("task:1"),
            ],
            apply_receipt_ids: vec![EngineRuntimeReceiptRecordId(
                "receipt:management-projection-apply:task:1:accepted".to_owned(),
            )],
            review_summary_refs: vec!["sync-review:1".to_owned()],
            validation_report_refs: vec!["validation:1".to_owned()],
            blocked_reasons: Vec::new(),
        },
    }
}
