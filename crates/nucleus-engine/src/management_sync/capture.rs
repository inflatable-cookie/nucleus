use nucleus_projects::{ProjectId, RepoMembershipId};
use nucleus_scm_forge::ScmRepositoryRefId;

use crate::{EngineRuntimeReceiptRecordId, ManagementProjectionFileRef, ManagementProjectionRoot};

use super::plans::{ManagementProjectionSyncPlan, ManagementProjectionSyncPlanId};

/// Stable id for management capture preparation.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ManagementProjectionCapturePrepId(pub String);

/// Provider-neutral management capture preparation record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionCapturePrepRecord {
    pub prep_id: ManagementProjectionCapturePrepId,
    pub plan_id: ManagementProjectionSyncPlanId,
    pub status: ManagementProjectionCapturePrepStatus,
    pub scope: ManagementProjectionCaptureScope,
    pub file_refs: Vec<ManagementProjectionFileRef>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub write_evidence_refs: Vec<String>,
    pub assistance_refs: Vec<String>,
    pub summary: Option<String>,
}

impl ManagementProjectionCapturePrepRecord {
    pub fn from_sync_plan(
        prep_id: ManagementProjectionCapturePrepId,
        plan: &ManagementProjectionSyncPlan,
        assistance_refs: Vec<String>,
    ) -> Self {
        Self {
            prep_id,
            plan_id: plan.plan_id.clone(),
            status: ManagementProjectionCapturePrepStatus::Draft,
            scope: ManagementProjectionCaptureScope::ManagementProjection,
            file_refs: plan.file_refs.clone(),
            receipt_ids: plan.receipt_ids.clone(),
            write_evidence_refs: Vec::new(),
            assistance_refs,
            summary: plan.summary.clone(),
        }
    }

    pub fn from_admitted_command(
        prep_id: ManagementProjectionCapturePrepId,
        command: &ManagementProjectionCaptureCommand,
        admission: &ManagementProjectionCaptureAdmission,
    ) -> Self {
        Self {
            prep_id,
            plan_id: ManagementProjectionSyncPlanId(command.command_id.0.clone()),
            status: match &admission.status {
                ManagementProjectionCaptureAdmissionStatus::Accepted => {
                    ManagementProjectionCapturePrepStatus::ReadyForApproval
                }
                ManagementProjectionCaptureAdmissionStatus::Blocked(reason) => {
                    ManagementProjectionCapturePrepStatus::Blocked(reason.clone())
                }
            },
            scope: command.scope.clone(),
            file_refs: command.requested_file_refs.clone(),
            receipt_ids: command.evidence.apply_receipt_ids.clone(),
            write_evidence_refs: command.evidence.write_evidence_refs.clone(),
            assistance_refs: command.evidence.review_summary_refs.clone(),
            summary: Some(command.reason.summary()),
        }
    }

    pub fn is_execution(&self) -> bool {
        false
    }

    pub fn cites_projection_files_and_receipts(&self) -> bool {
        !self.file_refs.is_empty() && !self.receipt_ids.is_empty()
    }

    pub fn cites_projection_files_and_capture_evidence(&self) -> bool {
        !self.file_refs.is_empty()
            && (!self.receipt_ids.is_empty() || !self.write_evidence_refs.is_empty())
    }

    pub fn share_readiness(&self) -> ManagementProjectionCaptureShareReadiness {
        match &self.status {
            ManagementProjectionCapturePrepStatus::ReadyForApproval => {
                if self.cites_projection_files_and_capture_evidence() {
                    ManagementProjectionCaptureShareReadiness::ReadyForReviewBoundary
                } else {
                    ManagementProjectionCaptureShareReadiness::Blocked(
                        "capture prep requires projection files and capture evidence".to_owned(),
                    )
                }
            }
            ManagementProjectionCapturePrepStatus::Blocked(reason) => {
                ManagementProjectionCaptureShareReadiness::Blocked(reason.clone())
            }
            ManagementProjectionCapturePrepStatus::Draft => {
                ManagementProjectionCaptureShareReadiness::NeedsReview
            }
            ManagementProjectionCapturePrepStatus::Superseded(reason) => {
                ManagementProjectionCaptureShareReadiness::Blocked(reason.clone())
            }
        }
    }
}

/// Capture preparation status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCapturePrepStatus {
    Draft,
    ReadyForApproval,
    Blocked(String),
    Superseded(String),
}

/// Capture preparation scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCaptureScope {
    ManagementProjection,
    TaskRecords,
    ProjectMetadata,
    DocsIndexes,
    Custom(String),
}

/// Stable id for one management capture command.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ManagementProjectionCaptureCommandId(pub String);

/// Command to prepare management projection capture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionCaptureCommand {
    pub command_id: ManagementProjectionCaptureCommandId,
    pub actor_ref: String,
    pub target_project_id: ProjectId,
    pub repo_membership_id: Option<RepoMembershipId>,
    pub repository_id: Option<ScmRepositoryRefId>,
    pub projection_root: ManagementProjectionRoot,
    pub requested_file_refs: Vec<ManagementProjectionFileRef>,
    pub reason: ManagementProjectionCaptureReason,
    pub scope: ManagementProjectionCaptureScope,
    pub policy_gates: Vec<ManagementProjectionCapturePolicyGate>,
    pub evidence: ManagementProjectionCaptureEvidence,
}

impl ManagementProjectionCaptureCommand {
    pub fn mutates_provider(&self) -> bool {
        false
    }

    pub fn is_share_or_publish(&self) -> bool {
        false
    }

    pub fn admit(&self) -> ManagementProjectionCaptureAdmission {
        let blocked_reason = self.blocked_reason();
        ManagementProjectionCaptureAdmission {
            command_id: self.command_id.clone(),
            status: match blocked_reason {
                Some(reason) => ManagementProjectionCaptureAdmissionStatus::Blocked(reason),
                None => ManagementProjectionCaptureAdmissionStatus::Accepted,
            },
            admitted_file_refs: self.requested_file_refs.clone(),
            evidence: self.evidence.clone(),
            provider_mutation_allowed: false,
        }
    }

    fn blocked_reason(&self) -> Option<String> {
        if self.actor_ref.trim().is_empty() {
            return Some("capture command requires an actor".to_owned());
        }
        if self.target_project_id.0.trim().is_empty() {
            return Some("capture command requires a project".to_owned());
        }
        if self.requested_file_refs.is_empty() {
            return Some("capture command requires projection file refs".to_owned());
        }
        if self
            .requested_file_refs
            .iter()
            .any(|file| !file.0.starts_with("nucleus/"))
        {
            return Some("capture command can only cite nucleus/ projection files".to_owned());
        }
        if !self.evidence.cites_projection_files_and_capture_evidence() {
            return Some(
                "capture command requires projection files and capture evidence".to_owned(),
            );
        }
        if self.policy_gates.iter().any(|gate| gate.blocks_capture()) {
            return Some("capture command has blocking policy gates".to_owned());
        }
        None
    }
}

/// Why capture preparation was requested.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCaptureReason {
    AppliedManagementProjection,
    UserRequested,
    StewardRecommended,
    ValidationCheckpoint,
    Custom(String),
}

impl ManagementProjectionCaptureReason {
    fn summary(&self) -> String {
        match self {
            Self::AppliedManagementProjection => {
                "prepare accepted management projection changes for capture".to_owned()
            }
            Self::UserRequested => "prepare user-requested management capture".to_owned(),
            Self::StewardRecommended => "prepare steward-recommended management capture".to_owned(),
            Self::ValidationCheckpoint => {
                "prepare management capture validation checkpoint".to_owned()
            }
            Self::Custom(summary) => summary.clone(),
        }
    }
}

/// Provider-neutral policy gate for capture preparation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCapturePolicyGate {
    ProjectionApplied,
    ExpectedRevisionSatisfied,
    ConflictReviewComplete,
    EvidenceSanitized,
    UserApprovalRequired,
    Blocked(String),
}

impl ManagementProjectionCapturePolicyGate {
    pub fn blocks_capture(&self) -> bool {
        matches!(self, Self::Blocked(_))
    }
}

/// Evidence required before a capture prep record can become review-ready.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ManagementProjectionCaptureEvidence {
    pub projection_file_refs: Vec<ManagementProjectionFileRef>,
    pub apply_receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub write_evidence_refs: Vec<String>,
    pub review_summary_refs: Vec<String>,
    pub validation_report_refs: Vec<String>,
    pub blocked_reasons: Vec<String>,
}

impl ManagementProjectionCaptureEvidence {
    pub fn cites_projection_files_and_apply_receipts(&self) -> bool {
        !self.projection_file_refs.is_empty()
            && !self.apply_receipt_ids.is_empty()
            && self.blocked_reasons.is_empty()
    }

    pub fn cites_projection_files_and_capture_evidence(&self) -> bool {
        !self.projection_file_refs.is_empty()
            && (!self.apply_receipt_ids.is_empty() || !self.write_evidence_refs.is_empty())
            && self.blocked_reasons.is_empty()
    }
}

/// Admission result for management capture preparation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionCaptureAdmission {
    pub command_id: ManagementProjectionCaptureCommandId,
    pub status: ManagementProjectionCaptureAdmissionStatus,
    pub admitted_file_refs: Vec<ManagementProjectionFileRef>,
    pub evidence: ManagementProjectionCaptureEvidence,
    pub provider_mutation_allowed: bool,
}

impl ManagementProjectionCaptureAdmission {
    pub fn is_accepted(&self) -> bool {
        matches!(
            self.status,
            ManagementProjectionCaptureAdmissionStatus::Accepted
        )
    }
}

/// Capture preparation admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCaptureAdmissionStatus {
    Accepted,
    Blocked(String),
}

/// Provider-neutral share readiness for prepared management capture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementProjectionCaptureShareReadiness {
    NeedsReview,
    ReadyForReviewBoundary,
    Blocked(String),
}
