//! Engine-owned change-request preparation records.
//!
//! These records describe the handoff Nucleus may later publish through an SCM
//! or forge adapter. They do not create pull requests, publish snapshots,
//! merge, push, promote, resolve credentials, or call remote APIs.

use nucleus_scm_forge::{ForgeProviderKind, ScmBranchRef, ScmChangeRef, ScmWorkSessionId};
use nucleus_tasks::TaskId;

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineScmWorkItemLinkRecord, EngineTaskWorkItemId,
};

/// Stable id for one prepared change request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineChangeRequestPrepId(pub String);

/// Prepared change request handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineChangeRequestPrepRecord {
    pub prep_id: EngineChangeRequestPrepId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub work_session_id: ScmWorkSessionId,
    pub target: EngineChangeRequestTarget,
    pub change_refs: Vec<ScmChangeRef>,
    pub checkpoint_ids: Vec<EngineCheckpointRecordId>,
    pub diff_summary_ids: Vec<EngineDiffSummaryRecordId>,
    pub receipt_ids: Vec<EngineRuntimeReceiptRecordId>,
    pub publication: EngineChangeRequestPublicationState,
    pub review_policy: EngineChangeRequestReviewPolicy,
    pub status: EngineChangeRequestPrepStatus,
    pub summary: Option<String>,
}

impl EngineChangeRequestPrepRecord {
    /// Prepare a handoff record from an existing SCM work-item evidence link.
    pub fn from_scm_link(
        prep_id: EngineChangeRequestPrepId,
        link: &EngineScmWorkItemLinkRecord,
        target: EngineChangeRequestTarget,
        review_policy: EngineChangeRequestReviewPolicy,
    ) -> Self {
        Self {
            prep_id,
            task_id: link.task_id.clone(),
            work_item_id: link.work_item_id.clone(),
            work_session_id: link.work_session_id.clone(),
            target,
            change_refs: link.change_refs.clone(),
            checkpoint_ids: link.checkpoint_ids.clone(),
            diff_summary_ids: link.diff_summary_ids.clone(),
            receipt_ids: link.receipt_ids.clone(),
            publication: EngineChangeRequestPublicationState::NotRequested,
            review_policy,
            status: EngineChangeRequestPrepStatus::Draft,
            summary: link.summary.clone(),
        }
    }

    pub fn is_prep_only(&self) -> bool {
        self.publication == EngineChangeRequestPublicationState::NotRequested
            && matches!(
                self.status,
                EngineChangeRequestPrepStatus::Draft | EngineChangeRequestPrepStatus::Ready
            )
    }

    pub fn preserves_non_git_target(&self) -> bool {
        matches!(
            self.target,
            EngineChangeRequestTarget::ProviderPublication { .. }
                | EngineChangeRequestTarget::ProviderGate { .. }
                | EngineChangeRequestTarget::ManualHandoff
                | EngineChangeRequestTarget::Custom(_)
        )
    }
}

/// Neutral target for a future change request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestTarget {
    ForgeReview {
        provider: ForgeProviderKind,
        target_branch: Option<ScmBranchRef>,
    },
    ProviderPublication {
        publication_ref: Option<String>,
        gate_ref: Option<String>,
    },
    ProviderGate {
        gate_ref: Option<String>,
    },
    DirectAuthorityUpdate {
        target_ref: Option<String>,
    },
    ManualHandoff,
    Custom(String),
}

/// Publication state for a prep record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPublicationState {
    NotRequested,
    WaitingForApproval,
    PublicationRequested,
    Published { provider_ref: String },
    Rejected(String),
    Unsupported(String),
}

/// Review policy expected before shared authority changes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestReviewPolicy {
    HumanReviewRequired,
    StewardMayPrepareOnly,
    DirectAuthorityUpdateAllowed,
    Unsupported,
}

/// Prep lifecycle before provider publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPrepStatus {
    Draft,
    Ready,
    Blocked(String),
    Superseded(String),
    Abandoned(String),
}

/// Stable id for a provider-neutral change-request candidate.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineChangeRequestCandidateId(pub String);

/// Provider-neutral change-request candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineChangeRequestCandidateRecord {
    pub candidate_id: EngineChangeRequestCandidateId,
    pub title: String,
    pub summary: String,
    pub target: EngineChangeRequestTarget,
    pub evidence_refs: Vec<EngineChangeRequestEvidenceRef>,
    pub capture_refs: Vec<String>,
    pub work_session_refs: Vec<ScmWorkSessionId>,
    pub policy_gates: Vec<EngineChangeRequestPolicyGate>,
    pub status: EngineChangeRequestCandidateStatus,
}

impl EngineChangeRequestCandidateRecord {
    pub fn admit(&self) -> EngineChangeRequestCandidateAdmission {
        let blocked_reason = self.blocked_reason();
        EngineChangeRequestCandidateAdmission {
            candidate_id: self.candidate_id.clone(),
            status: match blocked_reason {
                Some(reason) => EngineChangeRequestCandidateAdmissionStatus::Blocked(reason),
                None => EngineChangeRequestCandidateAdmissionStatus::Accepted,
            },
            evidence_refs: self.evidence_refs.clone(),
            provider_network_allowed: false,
        }
    }

    fn blocked_reason(&self) -> Option<String> {
        if self.title.trim().is_empty() {
            return Some("change-request candidate requires a title".to_owned());
        }
        if self.summary.trim().is_empty() {
            return Some("change-request candidate requires a summary".to_owned());
        }
        if self.evidence_refs.is_empty() {
            return Some("change-request candidate requires evidence".to_owned());
        }
        if self.policy_gates.iter().any(|gate| gate.blocks_candidate()) {
            return Some("change-request candidate has blocking policy gates".to_owned());
        }
        None
    }
}

/// Candidate evidence reference.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineChangeRequestEvidenceRef(pub String);

/// Candidate policy gate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestPolicyGate {
    CaptureEvidenceReviewed,
    WorkingSessionReviewed,
    ValidationReviewed,
    HumanReviewRequired,
    Blocked(String),
}

impl EngineChangeRequestPolicyGate {
    fn blocks_candidate(&self) -> bool {
        matches!(self, Self::Blocked(_))
    }
}

/// Candidate lifecycle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestCandidateStatus {
    Draft,
    ReadyForReview,
    Blocked(String),
    Superseded(String),
}

/// Candidate admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineChangeRequestCandidateAdmission {
    pub candidate_id: EngineChangeRequestCandidateId,
    pub status: EngineChangeRequestCandidateAdmissionStatus,
    pub evidence_refs: Vec<EngineChangeRequestEvidenceRef>,
    pub provider_network_allowed: bool,
}

impl EngineChangeRequestCandidateAdmission {
    pub fn is_accepted(&self) -> bool {
        matches!(
            self.status,
            EngineChangeRequestCandidateAdmissionStatus::Accepted
        )
    }
}

/// Candidate admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineChangeRequestCandidateAdmissionStatus {
    Accepted,
    Blocked(String),
}

/// GitHub-specific review-boundary descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineGitHubReviewBoundaryDescriptor {
    pub candidate_id: EngineChangeRequestCandidateId,
    pub provider: ForgeProviderKind,
    pub provider_label: String,
    pub required_refs: Vec<EngineChangeRequestEvidenceRef>,
    pub target_branch: Option<ScmBranchRef>,
    pub network_call_allowed: bool,
}

impl EngineGitHubReviewBoundaryDescriptor {
    pub fn from_candidate(candidate: &EngineChangeRequestCandidateRecord) -> Option<Self> {
        let EngineChangeRequestTarget::ForgeReview {
            provider: ForgeProviderKind::GitHub,
            target_branch,
        } = &candidate.target else {
            return None;
        };

        Some(Self {
            candidate_id: candidate.candidate_id.clone(),
            provider: ForgeProviderKind::GitHub,
            provider_label: "pull_request".to_owned(),
            required_refs: candidate.evidence_refs.clone(),
            target_branch: target_branch.clone(),
            network_call_allowed: false,
        })
    }
}

/// Client-safe evidence package for a change-request candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineChangeRequestEvidencePackage {
    pub candidate_id: EngineChangeRequestCandidateId,
    pub title: String,
    pub capture_refs: Vec<String>,
    pub work_session_refs: Vec<ScmWorkSessionId>,
    pub status_diff_summary_refs: Vec<EngineChangeRequestEvidenceRef>,
    pub validation_summary_refs: Vec<EngineChangeRequestEvidenceRef>,
    pub blocked_reasons: Vec<String>,
    pub client_can_mutate_provider: bool,
}

impl EngineChangeRequestEvidencePackage {
    pub fn from_candidate(candidate: &EngineChangeRequestCandidateRecord) -> Self {
        let mut status_diff_summary_refs = Vec::new();
        let mut validation_summary_refs = Vec::new();

        for evidence in &candidate.evidence_refs {
            if evidence.0.contains("diff") || evidence.0.contains("status") {
                status_diff_summary_refs.push(evidence.clone());
            }
            if evidence.0.contains("validation") {
                validation_summary_refs.push(evidence.clone());
            }
        }

        Self {
            candidate_id: candidate.candidate_id.clone(),
            title: candidate.title.clone(),
            capture_refs: candidate.capture_refs.clone(),
            work_session_refs: candidate.work_session_refs.clone(),
            status_diff_summary_refs,
            validation_summary_refs,
            blocked_reasons: candidate
                .policy_gates
                .iter()
                .filter_map(|gate| match gate {
                    EngineChangeRequestPolicyGate::Blocked(reason) => Some(reason.clone()),
                    _ => None,
                })
                .collect(),
            client_can_mutate_provider: false,
        }
    }

    pub fn is_review_ready(&self) -> bool {
        self.blocked_reasons.is_empty()
            && !self.status_diff_summary_refs.is_empty()
            && !self.validation_summary_refs.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_scm_forge::{
        ScmChangeKind, ScmProviderRef, ScmRepositoryRefId, ScmSessionCommandId, ScmWorkSessionId,
    };

    use crate::{EngineScmWorkItemLinkId, EngineScmWorkItemLinkRecord, EngineScmWorkItemLinkState};

    fn change_ref(kind: ScmChangeKind, provider_ref: &str) -> ScmChangeRef {
        ScmChangeRef {
            repository_id: ScmRepositoryRefId("repo:nucleus".to_owned()),
            kind,
            provider_ref: ScmProviderRef(provider_ref.to_owned()),
            summary: Some("captured change".to_owned()),
        }
    }

    fn scm_link(change_ref: ScmChangeRef) -> EngineScmWorkItemLinkRecord {
        EngineScmWorkItemLinkRecord {
            link_id: EngineScmWorkItemLinkId("link:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            work_session_id: ScmWorkSessionId("session:scm".to_owned()),
            session_command_ids: vec![ScmSessionCommandId("scm-command:1".to_owned())],
            change_refs: vec![change_ref],
            checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
            diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
            receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
            state: EngineScmWorkItemLinkState::Linked,
            summary: Some("ready for handoff prep".to_owned()),
        }
    }

    #[test]
    fn forge_review_prep_is_distinct_from_publication() {
        let prep = EngineChangeRequestPrepRecord::from_scm_link(
            EngineChangeRequestPrepId("prep:github".to_owned()),
            &scm_link(change_ref(ScmChangeKind::Commit, "git:commit:abc123")),
            EngineChangeRequestTarget::ForgeReview {
                provider: ForgeProviderKind::GitHub,
                target_branch: None,
            },
            EngineChangeRequestReviewPolicy::HumanReviewRequired,
        );

        assert!(prep.is_prep_only());
        assert_eq!(
            prep.publication,
            EngineChangeRequestPublicationState::NotRequested
        );
        assert_eq!(
            prep.diff_summary_ids,
            vec![EngineDiffSummaryRecordId("diff:1".to_owned())]
        );
        assert!(matches!(
            prep.target,
            EngineChangeRequestTarget::ForgeReview {
                provider: ForgeProviderKind::GitHub,
                ..
            }
        ));
    }

    #[test]
    fn convergence_style_publication_target_remains_viable() {
        let prep = EngineChangeRequestPrepRecord::from_scm_link(
            EngineChangeRequestPrepId("prep:convergence".to_owned()),
            &scm_link(change_ref(
                ScmChangeKind::Snapshot,
                "convergence:snapshot:abc123",
            )),
            EngineChangeRequestTarget::ProviderPublication {
                publication_ref: Some("convergence:publication:draft".to_owned()),
                gate_ref: Some("convergence:gate:review".to_owned()),
            },
            EngineChangeRequestReviewPolicy::StewardMayPrepareOnly,
        );

        assert!(prep.is_prep_only());
        assert!(prep.preserves_non_git_target());
        assert_eq!(prep.change_refs[0].kind, ScmChangeKind::Snapshot);
    }

    #[test]
    fn prep_record_keeps_pr_shape_out_of_storage_model() {
        let prep = EngineChangeRequestPrepRecord::from_scm_link(
            EngineChangeRequestPrepId("prep:manual".to_owned()),
            &scm_link(change_ref(ScmChangeKind::Patch, "patch:series:1")),
            EngineChangeRequestTarget::ManualHandoff,
            EngineChangeRequestReviewPolicy::HumanReviewRequired,
        );

        assert!(prep.preserves_non_git_target());
        assert_eq!(prep.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
        assert_eq!(
            prep.checkpoint_ids,
            vec![EngineCheckpointRecordId("checkpoint:1".to_owned())]
        );
        assert!(matches!(
            prep.target,
            EngineChangeRequestTarget::ManualHandoff
        ));
    }

    #[test]
    fn change_request_candidate_admission_requires_evidence_without_network_access() {
        let candidate = candidate_record();
        let admission = candidate.admit();

        assert!(admission.is_accepted());
        assert!(!admission.provider_network_allowed);
        assert_eq!(admission.evidence_refs.len(), 3);
    }

    #[test]
    fn change_request_candidate_blocks_missing_evidence_or_policy_gates() {
        let mut missing_evidence = candidate_record();
        missing_evidence.evidence_refs.clear();
        let missing_admission = missing_evidence.admit();

        assert!(!missing_admission.is_accepted());

        let mut blocked = candidate_record();
        blocked
            .policy_gates
            .push(EngineChangeRequestPolicyGate::Blocked(
                "validation failed".to_owned(),
            ));
        let blocked_admission = blocked.admit();

        assert!(matches!(
            missing_admission.status,
            EngineChangeRequestCandidateAdmissionStatus::Blocked(_)
        ));
        assert!(matches!(
            blocked_admission.status,
            EngineChangeRequestCandidateAdmissionStatus::Blocked(_)
        ));
        assert!(!blocked_admission.provider_network_allowed);
    }

    #[test]
    fn github_review_boundary_descriptor_stays_provider_specific() {
        let candidate = candidate_record();
        let descriptor = EngineGitHubReviewBoundaryDescriptor::from_candidate(&candidate)
            .expect("github descriptor");

        assert_eq!(descriptor.provider, ForgeProviderKind::GitHub);
        assert_eq!(descriptor.provider_label, "pull_request");
        assert_eq!(descriptor.required_refs, candidate.evidence_refs);
        assert!(!descriptor.network_call_allowed);

        let mut manual = candidate;
        manual.target = EngineChangeRequestTarget::ManualHandoff;
        assert!(EngineGitHubReviewBoundaryDescriptor::from_candidate(&manual).is_none());
    }

    #[test]
    fn evidence_package_exposes_review_readiness_without_provider_authority() {
        let candidate = candidate_record();
        let package = EngineChangeRequestEvidencePackage::from_candidate(&candidate);

        assert!(package.is_review_ready());
        assert!(!package.client_can_mutate_provider);
        assert_eq!(package.capture_refs, vec!["capture-prep:1".to_owned()]);
        assert_eq!(
            package.work_session_refs,
            vec![ScmWorkSessionId("session:scm".to_owned())]
        );
        assert_eq!(package.status_diff_summary_refs.len(), 2);
        assert_eq!(package.validation_summary_refs.len(), 1);
    }

    fn candidate_record() -> EngineChangeRequestCandidateRecord {
        EngineChangeRequestCandidateRecord {
            candidate_id: EngineChangeRequestCandidateId("candidate:1".to_owned()),
            title: "Prepare management sync review".to_owned(),
            summary: "Review captured management projection changes".to_owned(),
            target: EngineChangeRequestTarget::ForgeReview {
                provider: ForgeProviderKind::GitHub,
                target_branch: None,
            },
            evidence_refs: vec![
                EngineChangeRequestEvidenceRef("evidence:git-status".to_owned()),
                EngineChangeRequestEvidenceRef("evidence:diff-summary".to_owned()),
                EngineChangeRequestEvidenceRef("evidence:validation-summary".to_owned()),
            ],
            capture_refs: vec!["capture-prep:1".to_owned()],
            work_session_refs: vec![ScmWorkSessionId("session:scm".to_owned())],
            policy_gates: vec![
                EngineChangeRequestPolicyGate::CaptureEvidenceReviewed,
                EngineChangeRequestPolicyGate::WorkingSessionReviewed,
                EngineChangeRequestPolicyGate::ValidationReviewed,
                EngineChangeRequestPolicyGate::HumanReviewRequired,
            ],
            status: EngineChangeRequestCandidateStatus::ReadyForReview,
        }
    }
}
