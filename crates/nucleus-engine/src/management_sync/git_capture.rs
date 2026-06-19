use nucleus_scm_forge::{
    git_scm_driver_descriptor, ScmCapability, ScmDriverId, ScmInspectionAccess,
    ScmRepositoryRefId, ScmWorkingCopyInspection,
};

use crate::{
    EngineRuntimeReceiptRef, ManagementProjectionCaptureAdmission,
    ManagementProjectionCaptureCommand, ManagementProjectionCaptureCommandId,
    ManagementProjectionFileRef,
};

/// Stable id for a Git management capture plan.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct GitManagementCapturePlanId(pub String);

/// Git adapter mapping for a neutral management capture request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitManagementCapturePlan {
    pub plan_id: GitManagementCapturePlanId,
    pub capture_command_id: ManagementProjectionCaptureCommandId,
    pub repository_id: ScmRepositoryRefId,
    pub descriptor: GitManagementCaptureDescriptor,
    pub candidate_file_refs: Vec<ManagementProjectionFileRef>,
    pub evidence: GitManagementCaptureEvidence,
    pub status: GitManagementCapturePlanStatus,
}

impl GitManagementCapturePlan {
    pub fn from_capture_admission(
        plan_id: GitManagementCapturePlanId,
        command: &ManagementProjectionCaptureCommand,
        admission: &ManagementProjectionCaptureAdmission,
    ) -> Self {
        let Some(repository_id) = command.repository_id.clone() else {
            return Self::blocked(
                plan_id,
                command,
                "git capture plan requires repository ref".to_owned(),
            );
        };

        if !admission.is_accepted() {
            return Self::blocked(
                plan_id,
                command,
                "capture admission must be accepted before Git planning".to_owned(),
            );
        }

        Self {
            plan_id,
            capture_command_id: command.command_id.clone(),
            repository_id,
            descriptor: GitManagementCaptureDescriptor::from_registry(),
            candidate_file_refs: admission.admitted_file_refs.clone(),
            evidence: GitManagementCaptureEvidence::default(),
            status: GitManagementCapturePlanStatus::NeedsDryRunEvidence,
        }
    }

    pub fn with_evidence(mut self, evidence: GitManagementCaptureEvidence) -> Self {
        self.status = if evidence.is_sufficient_for_review() {
            GitManagementCapturePlanStatus::ReadyForReview
        } else {
            GitManagementCapturePlanStatus::Blocked(
                "git capture plan requires sanitized status and diff evidence".to_owned(),
            )
        };
        self.evidence = evidence;
        self
    }

    pub fn mutates_git(&self) -> bool {
        false
    }

    fn blocked(
        plan_id: GitManagementCapturePlanId,
        command: &ManagementProjectionCaptureCommand,
        reason: String,
    ) -> Self {
        Self {
            plan_id,
            capture_command_id: command.command_id.clone(),
            repository_id: command
                .repository_id
                .clone()
                .unwrap_or_else(|| ScmRepositoryRefId("repo:unknown".to_owned())),
            descriptor: GitManagementCaptureDescriptor::from_registry(),
            candidate_file_refs: command.requested_file_refs.clone(),
            evidence: GitManagementCaptureEvidence::default(),
            status: GitManagementCapturePlanStatus::Blocked(reason),
        }
    }
}

/// Git descriptor details retained as adapter mapping, not core capture terms.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitManagementCaptureDescriptor {
    pub driver_id: ScmDriverId,
    pub local_capture_label: String,
    pub share_label: String,
    pub required_capabilities: Vec<ScmCapability>,
}

impl GitManagementCaptureDescriptor {
    pub fn from_registry() -> Self {
        let descriptor = git_scm_driver_descriptor();
        Self {
            driver_id: descriptor.id,
            local_capture_label: "commit".to_owned(),
            share_label: "push_or_review_request".to_owned(),
            required_capabilities: vec![
                ScmCapability::InspectWorkingCopy,
                ScmCapability::InspectCapturedChanges,
                ScmCapability::PrepareManagementCapture,
            ],
        }
    }
}

/// Git capture planning state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitManagementCapturePlanStatus {
    NeedsDryRunEvidence,
    ReadyForReview,
    Blocked(String),
}

/// Sanitized evidence for Git capture readiness.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GitManagementCaptureEvidence {
    pub status_evidence_refs: Vec<EngineRuntimeReceiptRef>,
    pub diff_summary_refs: Vec<EngineRuntimeReceiptRef>,
    pub inspection: Option<ScmWorkingCopyInspection>,
    pub blocked_reasons: Vec<String>,
}

impl GitManagementCaptureEvidence {
    pub fn is_sufficient_for_review(&self) -> bool {
        self.blocked_reasons.is_empty()
            && !self.status_evidence_refs.is_empty()
            && !self.diff_summary_refs.is_empty()
            && self
                .inspection
                .as_ref()
                .map(|inspection| inspection.access == ScmInspectionAccess::ReadOnly)
                .unwrap_or(false)
    }
}

/// Stable id for a dry-run Git capture command envelope.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct GitCaptureDryRunEnvelopeId(pub String);

/// Dry-run command envelope for Git capture readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCaptureDryRunEnvelope {
    pub envelope_id: GitCaptureDryRunEnvelopeId,
    pub plan_id: GitManagementCapturePlanId,
    pub repository_id: ScmRepositoryRefId,
    pub requested_checks: Vec<GitCaptureDryRunCheck>,
}

impl GitCaptureDryRunEnvelope {
    pub fn from_plan(
        envelope_id: GitCaptureDryRunEnvelopeId,
        plan: &GitManagementCapturePlan,
        requested_checks: Vec<GitCaptureDryRunCheck>,
    ) -> Self {
        Self {
            envelope_id,
            plan_id: plan.plan_id.clone(),
            repository_id: plan.repository_id.clone(),
            requested_checks,
        }
    }

    pub fn admit(&self) -> GitCaptureDryRunAdmission {
        if self.requested_checks.is_empty() {
            return GitCaptureDryRunAdmission::blocked(
                self,
                "git capture dry-run envelope requires checks".to_owned(),
            );
        }
        if self
            .requested_checks
            .iter()
            .any(GitCaptureDryRunCheck::is_mutating)
        {
            return GitCaptureDryRunAdmission::blocked(
                self,
                "git capture dry-run envelope cannot include mutating checks".to_owned(),
            );
        }

        GitCaptureDryRunAdmission {
            envelope_id: self.envelope_id.clone(),
            status: GitCaptureDryRunAdmissionStatus::Accepted,
            accepted_checks: self.requested_checks.clone(),
            provider_mutation_allowed: false,
        }
    }
}

/// Read-only or rejected Git capture checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitCaptureDryRunCheck {
    StatusPorcelainV2,
    DiffNameOnly,
    DiffStat,
    RevParseHead,
    MutatingProviderCommand(String),
}

impl GitCaptureDryRunCheck {
    fn is_mutating(&self) -> bool {
        matches!(self, Self::MutatingProviderCommand(_))
    }
}

/// Admission result for a Git capture dry-run envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCaptureDryRunAdmission {
    pub envelope_id: GitCaptureDryRunEnvelopeId,
    pub status: GitCaptureDryRunAdmissionStatus,
    pub accepted_checks: Vec<GitCaptureDryRunCheck>,
    pub provider_mutation_allowed: bool,
}

impl GitCaptureDryRunAdmission {
    fn blocked(envelope: &GitCaptureDryRunEnvelope, reason: String) -> Self {
        Self {
            envelope_id: envelope.envelope_id.clone(),
            status: GitCaptureDryRunAdmissionStatus::Blocked(reason),
            accepted_checks: Vec::new(),
            provider_mutation_allowed: false,
        }
    }
}

/// Git capture dry-run admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitCaptureDryRunAdmissionStatus {
    Accepted,
    Blocked(String),
}
