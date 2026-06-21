//! Protocol labels and string mappings for the control envelope wire format.

use crate::control_api::{DiagnosticsQuery, RuntimeMetadataQuery};
use crate::control_serialization_readiness::{
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};

use super::ControlApiCodecError;

pub(super) fn validate_protocol(family: &str, version: u16) -> Result<(), ControlApiCodecError> {
    if family != CONTROL_API_PROTOCOL_FAMILY {
        return Err(ControlApiCodecError::malformed(format!(
            "unsupported protocol family: {family}"
        )));
    }
    if version != CONTROL_API_PROTOCOL_VERSION_V1 {
        return Err(ControlApiCodecError::unsupported_version(version));
    }
    Ok(())
}

pub(super) fn diagnostics_domain_dto(query: &DiagnosticsQuery) -> String {
    match query {
        DiagnosticsQuery::Steward => "steward".to_owned(),
        DiagnosticsQuery::Effigy => "effigy".to_owned(),
        DiagnosticsQuery::ManagementSync => "management_sync".to_owned(),
        DiagnosticsQuery::ScmSession => "scm_session".to_owned(),
        DiagnosticsQuery::TaskAgent => "task_agent".to_owned(),
        DiagnosticsQuery::CodexProvider => "codex_provider".to_owned(),
        DiagnosticsQuery::LiveEvidenceCompletion => "live_evidence_completion".to_owned(),
        DiagnosticsQuery::CompletionScmReadiness => "completion_scm_readiness".to_owned(),
        DiagnosticsQuery::CompletionScmCapture => "completion_scm_capture".to_owned(),
        DiagnosticsQuery::CompletionScmCapturePreparation => {
            "completion_scm_capture_preparation".to_owned()
        }
        DiagnosticsQuery::ScmCaptureDryRun => "scm_capture_dry_run".to_owned(),
        DiagnosticsQuery::ScmCaptureDryRunExecution => "scm_capture_dry_run_execution".to_owned(),
        DiagnosticsQuery::GitDryRunExecution => "git_dry_run_execution".to_owned(),
        DiagnosticsQuery::ScmCaptureWorkflow => "scm_capture_workflow".to_owned(),
        DiagnosticsQuery::ScmCaptureReview => "scm_capture_review".to_owned(),
        DiagnosticsQuery::ScmCaptureReviewDecision => "scm_capture_review_decision".to_owned(),
        DiagnosticsQuery::ScmChangeRequestPreparation => {
            "scm_change_request_preparation".to_owned()
        }
        DiagnosticsQuery::All => "all".to_owned(),
    }
}

pub(super) fn diagnostics_query_from_domain(
    domain: &str,
) -> Result<DiagnosticsQuery, ControlApiCodecError> {
    match domain {
        "steward" => Ok(DiagnosticsQuery::Steward),
        "effigy" => Ok(DiagnosticsQuery::Effigy),
        "management_sync" => Ok(DiagnosticsQuery::ManagementSync),
        "scm_session" => Ok(DiagnosticsQuery::ScmSession),
        "task_agent" => Ok(DiagnosticsQuery::TaskAgent),
        "codex_provider" => Ok(DiagnosticsQuery::CodexProvider),
        "live_evidence_completion" => Ok(DiagnosticsQuery::LiveEvidenceCompletion),
        "completion_scm_readiness" => Ok(DiagnosticsQuery::CompletionScmReadiness),
        "completion_scm_capture" => Ok(DiagnosticsQuery::CompletionScmCapture),
        "completion_scm_capture_preparation" => {
            Ok(DiagnosticsQuery::CompletionScmCapturePreparation)
        }
        "scm_capture_dry_run" => Ok(DiagnosticsQuery::ScmCaptureDryRun),
        "scm_capture_dry_run_execution" => Ok(DiagnosticsQuery::ScmCaptureDryRunExecution),
        "git_dry_run_execution" => Ok(DiagnosticsQuery::GitDryRunExecution),
        "scm_capture_workflow" => Ok(DiagnosticsQuery::ScmCaptureWorkflow),
        "scm_capture_review" => Ok(DiagnosticsQuery::ScmCaptureReview),
        "scm_capture_review_decision" => Ok(DiagnosticsQuery::ScmCaptureReviewDecision),
        "scm_change_request_preparation" => Ok(DiagnosticsQuery::ScmChangeRequestPreparation),
        "all" => Ok(DiagnosticsQuery::All),
        _ => Err(ControlApiCodecError::unsupported(
            "diagnostics query domain is not supported",
        )),
    }
}

pub(super) fn runtime_metadata_action(
    query: &RuntimeMetadataQuery,
) -> Result<&'static str, ControlApiCodecError> {
    match query {
        RuntimeMetadataQuery::ListArtifactMetadata => Ok("list_artifact_metadata"),
        RuntimeMetadataQuery::ListCommandEvidence => Ok("list_command_evidence"),
        RuntimeMetadataQuery::ListRuntimeReceipts => Ok("list_runtime_receipts"),
        RuntimeMetadataQuery::ListCheckpointRecords => Ok("list_checkpoint_records"),
        RuntimeMetadataQuery::ListDiffSummaryRecords => Ok("list_diff_summary_records"),
        RuntimeMetadataQuery::ListTaskWorkProgress => Ok("list_task_work_progress"),
        RuntimeMetadataQuery::GetLocalRuntimeReadiness => Ok("get_local_runtime_readiness"),
        _ => Err(ControlApiCodecError::unsupported(
            "query shape is not supported by the first control envelope",
        )),
    }
}

pub(super) fn runtime_metadata_query_from_action(
    action: &str,
) -> Result<RuntimeMetadataQuery, ControlApiCodecError> {
    match action {
        "list_artifact_metadata" => Ok(RuntimeMetadataQuery::ListArtifactMetadata),
        "list_command_evidence" => Ok(RuntimeMetadataQuery::ListCommandEvidence),
        "list_runtime_receipts" => Ok(RuntimeMetadataQuery::ListRuntimeReceipts),
        "list_checkpoint_records" => Ok(RuntimeMetadataQuery::ListCheckpointRecords),
        "list_diff_summary_records" => Ok(RuntimeMetadataQuery::ListDiffSummaryRecords),
        "list_task_work_progress" => Ok(RuntimeMetadataQuery::ListTaskWorkProgress),
        "get_local_runtime_readiness" => Ok(RuntimeMetadataQuery::GetLocalRuntimeReadiness),
        _ => Err(ControlApiCodecError::unsupported(
            "runtime metadata action is not supported",
        )),
    }
}

pub(super) fn protocol_family() -> String {
    CONTROL_API_PROTOCOL_FAMILY.to_owned()
}

pub(super) fn protocol_version() -> u16 {
    CONTROL_API_PROTOCOL_VERSION_V1
}
