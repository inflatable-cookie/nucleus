use nucleus_scm_forge::ScmWorkSessionId;

use super::target::EngineChangeRequestTarget;

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

/// Candidate evidence reference (shared core type).
pub use nucleus_core::EvidenceRef as EngineChangeRequestEvidenceRef;

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
