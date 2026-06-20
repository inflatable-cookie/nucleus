//! Read-only diagnostics for live provider evidence task linkage.

use serde::{Deserialize, Serialize};

use crate::{
    LiveProviderEvidenceReviewReadinessRecord, LiveProviderEvidenceReviewReadinessStatus,
    LiveProviderEvidenceWorkCandidateRecord, LiveProviderEvidenceWorkCandidateStatus,
    LiveProviderEvidenceWorkObservationRecord, LiveProviderEvidenceWorkObservationStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveProviderEvidenceDiagnosticsInput {
    pub candidates: Vec<LiveProviderEvidenceWorkCandidateRecord>,
    pub observations: Vec<LiveProviderEvidenceWorkObservationRecord>,
    pub readiness: Vec<LiveProviderEvidenceReviewReadinessRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveProviderEvidenceDiagnosticsRecord {
    pub diagnostics_id: String,
    pub candidate_count: usize,
    pub ready_candidate_count: usize,
    pub repair_required_candidate_count: usize,
    pub observation_count: usize,
    pub persisted_observation_count: usize,
    pub blocked_observation_count: usize,
    pub review_readiness_count: usize,
    pub awaiting_review_count: usize,
    pub repair_required: bool,
    pub refs: Vec<LiveProviderEvidenceDiagnosticsRef>,
    pub raw_provider_material_exposed: bool,
    pub raw_stream_exposed: bool,
    pub client_mutation_authority: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveProviderEvidenceDiagnosticsRef {
    pub ref_id: String,
    pub kind: LiveProviderEvidenceDiagnosticsRefKind,
    pub task_id: String,
    pub work_item_id: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceDiagnosticsRefKind {
    Candidate,
    Observation,
    ReviewReadiness,
}

pub fn live_provider_evidence_diagnostics(
    input: LiveProviderEvidenceDiagnosticsInput,
) -> LiveProviderEvidenceDiagnosticsRecord {
    let mut refs = Vec::new();
    refs.extend(input.candidates.iter().map(candidate_ref));
    refs.extend(input.observations.iter().map(observation_ref));
    refs.extend(input.readiness.iter().map(readiness_ref));
    refs.sort_by(|left, right| left.ref_id.cmp(&right.ref_id));

    let repair_required_candidate_count = input
        .candidates
        .iter()
        .filter(|candidate| {
            candidate.status == LiveProviderEvidenceWorkCandidateStatus::RepairRequired
        })
        .count();
    let blocked_observation_count = input
        .observations
        .iter()
        .filter(|observation| {
            observation.status == LiveProviderEvidenceWorkObservationStatus::Blocked
        })
        .count();

    LiveProviderEvidenceDiagnosticsRecord {
        diagnostics_id: "live-provider-evidence-diagnostics".to_owned(),
        candidate_count: input.candidates.len(),
        ready_candidate_count: input
            .candidates
            .iter()
            .filter(|candidate| candidate.status == LiveProviderEvidenceWorkCandidateStatus::Ready)
            .count(),
        repair_required_candidate_count,
        observation_count: input.observations.len(),
        persisted_observation_count: input
            .observations
            .iter()
            .filter(|observation| {
                observation.status == LiveProviderEvidenceWorkObservationStatus::Persisted
            })
            .count(),
        blocked_observation_count,
        review_readiness_count: input.readiness.len(),
        awaiting_review_count: input
            .readiness
            .iter()
            .filter(|readiness| {
                readiness.status
                    == LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview
            })
            .count(),
        repair_required: repair_required_candidate_count > 0 || blocked_observation_count > 0,
        refs,
        raw_provider_material_exposed: false,
        raw_stream_exposed: false,
        client_mutation_authority: false,
    }
}

fn candidate_ref(
    candidate: &LiveProviderEvidenceWorkCandidateRecord,
) -> LiveProviderEvidenceDiagnosticsRef {
    LiveProviderEvidenceDiagnosticsRef {
        ref_id: candidate.candidate_id.clone(),
        kind: LiveProviderEvidenceDiagnosticsRefKind::Candidate,
        task_id: candidate.task_id.clone(),
        work_item_id: candidate.work_item_id.clone(),
        status: format!("{:?}", candidate.status),
    }
}

fn observation_ref(
    observation: &LiveProviderEvidenceWorkObservationRecord,
) -> LiveProviderEvidenceDiagnosticsRef {
    LiveProviderEvidenceDiagnosticsRef {
        ref_id: observation.observation_id.clone(),
        kind: LiveProviderEvidenceDiagnosticsRefKind::Observation,
        task_id: observation.task_id.clone(),
        work_item_id: observation.work_item_id.clone(),
        status: format!("{:?}", observation.status),
    }
}

fn readiness_ref(
    readiness: &LiveProviderEvidenceReviewReadinessRecord,
) -> LiveProviderEvidenceDiagnosticsRef {
    LiveProviderEvidenceDiagnosticsRef {
        ref_id: readiness.readiness_id.clone(),
        kind: LiveProviderEvidenceDiagnosticsRefKind::ReviewReadiness,
        task_id: readiness.task_id.clone(),
        work_item_id: readiness.work_item_id.clone(),
        status: format!("{:?}", readiness.status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_provider_evidence_diagnostics_summarize_linkage_without_authority() {
        let diagnostics =
            live_provider_evidence_diagnostics(LiveProviderEvidenceDiagnosticsInput {
                candidates: vec![candidate(LiveProviderEvidenceWorkCandidateStatus::Ready)],
                observations: vec![observation(
                    LiveProviderEvidenceWorkObservationStatus::Persisted,
                )],
                readiness: vec![readiness(
                    LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview,
                )],
            });

        assert_eq!(diagnostics.candidate_count, 1);
        assert_eq!(diagnostics.ready_candidate_count, 1);
        assert_eq!(diagnostics.persisted_observation_count, 1);
        assert_eq!(diagnostics.awaiting_review_count, 1);
        assert_eq!(diagnostics.refs.len(), 3);
        assert!(!diagnostics.repair_required);
        assert!(!diagnostics.raw_provider_material_exposed);
        assert!(!diagnostics.raw_stream_exposed);
        assert!(!diagnostics.client_mutation_authority);
    }

    #[test]
    fn live_provider_evidence_diagnostics_surface_repair_required_state() {
        let diagnostics =
            live_provider_evidence_diagnostics(LiveProviderEvidenceDiagnosticsInput {
                candidates: vec![candidate(
                    LiveProviderEvidenceWorkCandidateStatus::RepairRequired,
                )],
                observations: vec![observation(
                    LiveProviderEvidenceWorkObservationStatus::Blocked,
                )],
                readiness: vec![readiness(
                    LiveProviderEvidenceReviewReadinessStatus::NotReady,
                )],
            });

        assert_eq!(diagnostics.repair_required_candidate_count, 1);
        assert_eq!(diagnostics.blocked_observation_count, 1);
        assert!(diagnostics.repair_required);
        assert!(!diagnostics.client_mutation_authority);
    }

    fn candidate(
        status: LiveProviderEvidenceWorkCandidateStatus,
    ) -> LiveProviderEvidenceWorkCandidateRecord {
        LiveProviderEvidenceWorkCandidateRecord {
            candidate_id: "candidate:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            task_id: "task:live-provider".to_owned(),
            work_item_id: "work:live-provider".to_owned(),
            evidence_id: "evidence:live-provider".to_owned(),
            replay_id: "replay:live-provider".to_owned(),
            runtime_receipt_id: Some("receipt:live-provider".to_owned()),
            live_executor_outcome_id: Some("outcome:live-provider".to_owned()),
            thread_id: Some("thread:live-provider".to_owned()),
            turn_id: Some("turn:live-provider".to_owned()),
            provider_instance_id: "codex:live-provider".to_owned(),
            status,
            gaps: Vec::new(),
            provider_write_executed: true,
            runtime_completed: true,
            review_ready_candidate: true,
            task_completion_inferred: false,
            review_acceptance_inferred: false,
        }
    }

    fn observation(
        status: LiveProviderEvidenceWorkObservationStatus,
    ) -> LiveProviderEvidenceWorkObservationRecord {
        LiveProviderEvidenceWorkObservationRecord {
            observation_id: "observation:1".to_owned(),
            candidate_id: "candidate:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            task_id: "task:live-provider".to_owned(),
            work_item_id: "work:live-provider".to_owned(),
            evidence_id: "evidence:live-provider".to_owned(),
            runtime_receipt_id: Some("receipt:live-provider".to_owned()),
            live_executor_outcome_id: Some("outcome:live-provider".to_owned()),
            thread_id: Some("thread:live-provider".to_owned()),
            turn_id: Some("turn:live-provider".to_owned()),
            status,
            blockers: Vec::new(),
            duplicate_observation_detected: false,
            provider_write_executed: true,
            runtime_completed: true,
            review_ready_candidate: true,
            task_completion_permitted: false,
            review_acceptance_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }

    fn readiness(
        status: LiveProviderEvidenceReviewReadinessStatus,
    ) -> LiveProviderEvidenceReviewReadinessRecord {
        LiveProviderEvidenceReviewReadinessRecord {
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:live-provider".to_owned(),
            work_item_id: "work:live-provider".to_owned(),
            evidence_id: "evidence:live-provider".to_owned(),
            status,
            blockers: Vec::new(),
            runtime_completed: true,
            review_ready: true,
            task_completion_permitted: false,
            review_acceptance_permitted: false,
        }
    }
}
