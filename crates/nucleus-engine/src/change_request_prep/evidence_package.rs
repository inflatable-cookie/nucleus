use nucleus_scm_forge::ScmWorkSessionId;

use super::candidate::{
    EngineChangeRequestCandidateId, EngineChangeRequestCandidateRecord,
    EngineChangeRequestEvidenceRef, EngineChangeRequestPolicyGate,
};

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
