use nucleus_scm_forge::ForgeProviderKind;

use super::candidate::{EngineChangeRequestCandidateId, EngineChangeRequestCandidateRecord, EngineChangeRequestEvidenceRef};
use super::target::EngineChangeRequestTarget;

/// GitHub-specific review-boundary descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineGitHubReviewBoundaryDescriptor {
    pub candidate_id: EngineChangeRequestCandidateId,
    pub provider: ForgeProviderKind,
    pub provider_label: String,
    pub required_refs: Vec<EngineChangeRequestEvidenceRef>,
    pub target_branch: Option<nucleus_scm_forge::ScmBranchRef>,
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
