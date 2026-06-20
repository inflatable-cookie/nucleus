use serde::{Deserialize, Serialize};

use crate::control_api::{ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot};
use crate::diagnostics_read_models::{
    CodexProviderDiagnosticsDto, EffigyDiagnosticsDto, ScmSessionDiagnosticsDto,
    StewardDiagnosticsDto, SyncDiagnosticsDto, TaskAgentDiagnosticsDto,
};

/// Serializable diagnostics query result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "domain", content = "record", rename_all = "snake_case")]
pub enum ControlDiagnosticsResultDto {
    Steward(StewardDiagnosticsDto),
    Effigy(EffigyDiagnosticsDto),
    ManagementSync(SyncDiagnosticsDto),
    ScmSession(ScmSessionDiagnosticsDto),
    TaskAgent(TaskAgentDiagnosticsDto),
    CodexProvider(CodexProviderDiagnosticsDto),
    LiveEvidenceCompletion(crate::LiveEvidenceCompletionControlDto),
    CompletionScmReadiness(crate::CompletionScmControlDto),
    CompletionScmCapture(crate::CompletionScmCaptureControlDto),
    CompletionScmCapturePreparation(crate::CompletionScmCapturePreparationControlDto),
    ScmCaptureDryRun(crate::ScmCaptureDryRunControlDto),
    ScmCaptureDryRunExecution(crate::ScmCaptureDryRunExecutionControlDto),
    GitDryRunExecution(crate::GitDryRunExecutionControlDto),
    ScmCaptureWorkflow(crate::ScmCaptureWorkflowControlDto),
    ScmCaptureReview(crate::ScmCaptureReviewControlDto),
    ScmCaptureReviewDecision(crate::ScmCaptureReviewDecisionControlDto),
    ScmChangeRequestPreparation(crate::ScmChangeRequestPrepControlDto),
    All(ControlDiagnosticsSnapshotDto),
}

/// Serializable combined diagnostics snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlDiagnosticsSnapshotDto {
    pub steward: StewardDiagnosticsDto,
    pub effigy: EffigyDiagnosticsDto,
    pub management_sync: SyncDiagnosticsDto,
    pub scm_session: ScmSessionDiagnosticsDto,
    pub task_agent: TaskAgentDiagnosticsDto,
    pub codex_provider: CodexProviderDiagnosticsDto,
    pub live_evidence_completion: crate::LiveEvidenceCompletionControlDto,
    pub completion_scm_readiness: crate::CompletionScmControlDto,
    pub completion_scm_capture: crate::CompletionScmCaptureControlDto,
    pub completion_scm_capture_preparation: crate::CompletionScmCapturePreparationControlDto,
    pub scm_capture_dry_run: crate::ScmCaptureDryRunControlDto,
    pub scm_capture_dry_run_execution: crate::ScmCaptureDryRunExecutionControlDto,
    pub git_dry_run_execution: crate::GitDryRunExecutionControlDto,
    pub scm_capture_workflow: crate::ScmCaptureWorkflowControlDto,
    pub scm_capture_review: crate::ScmCaptureReviewControlDto,
    pub scm_capture_review_decision: crate::ScmCaptureReviewDecisionControlDto,
    pub scm_change_request_preparation: crate::ScmChangeRequestPrepControlDto,
}

impl From<&ServerDiagnosticsQueryResult> for ControlDiagnosticsResultDto {
    fn from(result: &ServerDiagnosticsQueryResult) -> Self {
        match result {
            ServerDiagnosticsQueryResult::Steward(record) => Self::Steward(record.clone()),
            ServerDiagnosticsQueryResult::Effigy(record) => Self::Effigy(record.clone()),
            ServerDiagnosticsQueryResult::ManagementSync(record) => {
                Self::ManagementSync(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmSession(record) => Self::ScmSession(record.clone()),
            ServerDiagnosticsQueryResult::TaskAgent(record) => Self::TaskAgent(record.clone()),
            ServerDiagnosticsQueryResult::CodexProvider(record) => {
                Self::CodexProvider(record.clone())
            }
            ServerDiagnosticsQueryResult::LiveEvidenceCompletion(record) => {
                Self::LiveEvidenceCompletion(record.clone())
            }
            ServerDiagnosticsQueryResult::CompletionScmReadiness(record) => {
                Self::CompletionScmReadiness(record.clone())
            }
            ServerDiagnosticsQueryResult::CompletionScmCapture(record) => {
                Self::CompletionScmCapture(record.clone())
            }
            ServerDiagnosticsQueryResult::CompletionScmCapturePreparation(record) => {
                Self::CompletionScmCapturePreparation(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmCaptureDryRun(record) => {
                Self::ScmCaptureDryRun(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmCaptureDryRunExecution(record) => {
                Self::ScmCaptureDryRunExecution(record.clone())
            }
            ServerDiagnosticsQueryResult::GitDryRunExecution(record) => {
                Self::GitDryRunExecution(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmCaptureWorkflow(record) => {
                Self::ScmCaptureWorkflow(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmCaptureReview(record) => {
                Self::ScmCaptureReview(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmCaptureReviewDecision(record) => {
                Self::ScmCaptureReviewDecision(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmChangeRequestPreparation(record) => {
                Self::ScmChangeRequestPreparation(record.clone())
            }
            ServerDiagnosticsQueryResult::All(snapshot) => {
                Self::All(ControlDiagnosticsSnapshotDto::from(snapshot))
            }
        }
    }
}

impl From<&ServerDiagnosticsSnapshot> for ControlDiagnosticsSnapshotDto {
    fn from(snapshot: &ServerDiagnosticsSnapshot) -> Self {
        Self {
            steward: snapshot.steward.clone(),
            effigy: snapshot.effigy.clone(),
            management_sync: snapshot.management_sync.clone(),
            scm_session: snapshot.scm_session.clone(),
            task_agent: snapshot.task_agent.clone(),
            codex_provider: snapshot.codex_provider.clone(),
            live_evidence_completion: snapshot.live_evidence_completion.clone(),
            completion_scm_readiness: snapshot.completion_scm_readiness.clone(),
            completion_scm_capture: snapshot.completion_scm_capture.clone(),
            completion_scm_capture_preparation: snapshot.completion_scm_capture_preparation.clone(),
            scm_capture_dry_run: snapshot.scm_capture_dry_run.clone(),
            scm_capture_dry_run_execution: snapshot.scm_capture_dry_run_execution.clone(),
            git_dry_run_execution: snapshot.git_dry_run_execution.clone(),
            scm_capture_workflow: snapshot.scm_capture_workflow.clone(),
            scm_capture_review: snapshot.scm_capture_review.clone(),
            scm_capture_review_decision: snapshot.scm_capture_review_decision.clone(),
            scm_change_request_preparation: snapshot.scm_change_request_preparation.clone(),
        }
    }
}
