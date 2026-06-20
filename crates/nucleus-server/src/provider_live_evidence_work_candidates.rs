//! Task work progress candidates from durable live provider-write evidence.
//!
//! Candidates are reference-only. They do not complete tasks, accept reviews,
//! answer callbacks, cancel/resume providers, or mutate SCM state.

use nucleus_engine::EngineTaskWorkItemId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;
use serde::{Deserialize, Serialize};

use crate::{
    DurableCodexLiveProviderWriteReplayRecord, DurableCodexLiveProviderWriteReplayStatus,
    DurableCodexLiveSmokeEvidenceRecord,
};

/// Input for projecting live provider evidence into a task-work candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveProviderEvidenceWorkCandidateInput {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub evidence: DurableCodexLiveSmokeEvidenceRecord,
    pub replay: DurableCodexLiveProviderWriteReplayRecord,
}

/// Reference-only task work candidate derived from durable live provider evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveProviderEvidenceWorkCandidateRecord {
    pub candidate_id: String,
    pub project_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub evidence_id: String,
    pub replay_id: String,
    pub runtime_receipt_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub provider_instance_id: String,
    pub status: LiveProviderEvidenceWorkCandidateStatus,
    pub gaps: Vec<LiveProviderEvidenceWorkCandidateGap>,
    pub provider_write_executed: bool,
    pub runtime_completed: bool,
    pub review_ready_candidate: bool,
    pub task_completion_inferred: bool,
    pub review_acceptance_inferred: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceWorkCandidateStatus {
    Ready,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceWorkCandidateGap {
    ReplayNotReconciled,
    EvidenceIdMissing,
    RuntimeReceiptMissing,
    LiveExecutorOutcomeMissing,
    ThreadIdMissing,
    TurnIdMissing,
    TaskIdentityMissing,
    WorkItemIdentityMissing,
}

/// Build a task-work progress candidate from durable live evidence.
pub fn live_provider_evidence_work_candidate(
    input: LiveProviderEvidenceWorkCandidateInput,
) -> LiveProviderEvidenceWorkCandidateRecord {
    let gaps = candidate_gaps(&input);
    let project_id = input.project_id.0.clone();
    let task_id = input.task_id.0.clone();
    let work_item_id = input.work_item_id.0.clone();
    let status = if gaps.is_empty() {
        LiveProviderEvidenceWorkCandidateStatus::Ready
    } else {
        LiveProviderEvidenceWorkCandidateStatus::RepairRequired
    };
    let runtime_completed = input.evidence.provider_write_executed
        && input.replay.status == DurableCodexLiveProviderWriteReplayStatus::Reconciled;

    LiveProviderEvidenceWorkCandidateRecord {
        candidate_id: format!(
            "live-provider-evidence-work-candidate:{}:{}",
            work_item_id, input.evidence.write_attempt_id
        ),
        project_id,
        task_id,
        work_item_id,
        evidence_id: input.evidence.evidence_id,
        replay_id: input.replay.replay_id,
        runtime_receipt_id: input.evidence.runtime_receipt_id,
        live_executor_outcome_id: input.evidence.live_executor_outcome_id,
        thread_id: input.evidence.thread_id,
        turn_id: input.evidence.turn_id,
        provider_instance_id: input.evidence.provider_instance_id,
        status,
        gaps,
        provider_write_executed: input.evidence.provider_write_executed,
        runtime_completed,
        review_ready_candidate: runtime_completed,
        task_completion_inferred: false,
        review_acceptance_inferred: false,
    }
}

fn candidate_gaps(
    input: &LiveProviderEvidenceWorkCandidateInput,
) -> Vec<LiveProviderEvidenceWorkCandidateGap> {
    let mut gaps = Vec::new();

    if input.replay.status != DurableCodexLiveProviderWriteReplayStatus::Reconciled {
        gaps.push(LiveProviderEvidenceWorkCandidateGap::ReplayNotReconciled);
    }
    if input.evidence.evidence_id.trim().is_empty() {
        gaps.push(LiveProviderEvidenceWorkCandidateGap::EvidenceIdMissing);
    }
    if input.evidence.runtime_receipt_id.is_none() {
        gaps.push(LiveProviderEvidenceWorkCandidateGap::RuntimeReceiptMissing);
    }
    if input.evidence.live_executor_outcome_id.is_none() {
        gaps.push(LiveProviderEvidenceWorkCandidateGap::LiveExecutorOutcomeMissing);
    }
    if input.evidence.provider_write_executed {
        if input
            .evidence
            .thread_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        {
            gaps.push(LiveProviderEvidenceWorkCandidateGap::ThreadIdMissing);
        }
        if input
            .evidence
            .turn_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        {
            gaps.push(LiveProviderEvidenceWorkCandidateGap::TurnIdMissing);
        }
    }
    if input.task_id.0.trim().is_empty() {
        gaps.push(LiveProviderEvidenceWorkCandidateGap::TaskIdentityMissing);
    }
    if input.work_item_id.0.trim().is_empty() {
        gaps.push(LiveProviderEvidenceWorkCandidateGap::WorkItemIdentityMissing);
    }

    gaps
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexAppServerLiveExecutorCleanupStatus;
    use crate::{
        durable_live_provider_write_replay, DurableCodexLiveSmokeEvidenceStatus,
        ProviderRetentionPolicyStatus,
    };

    #[test]
    fn live_provider_evidence_work_candidates_create_ready_candidate_from_reconciled_evidence() {
        let evidence = evidence("ready");
        let replay = durable_live_provider_write_replay(&evidence);

        let candidate = live_provider_evidence_work_candidate(input(evidence, replay));

        assert_eq!(
            candidate.status,
            LiveProviderEvidenceWorkCandidateStatus::Ready
        );
        assert!(candidate.provider_write_executed);
        assert!(candidate.runtime_completed);
        assert!(candidate.review_ready_candidate);
        assert_eq!(
            candidate.runtime_receipt_id.as_deref(),
            Some("receipt:ready")
        );
        assert!(!candidate.task_completion_inferred);
        assert!(!candidate.review_acceptance_inferred);
    }

    #[test]
    fn live_provider_evidence_work_candidates_report_repair_required_gaps() {
        let mut evidence = evidence("repair");
        evidence.runtime_receipt_id = None;
        evidence.live_executor_outcome_id = None;
        evidence.thread_id = None;
        evidence.turn_id = None;
        let replay = durable_live_provider_write_replay(&evidence);

        let candidate = live_provider_evidence_work_candidate(input(evidence, replay));

        assert_eq!(
            candidate.status,
            LiveProviderEvidenceWorkCandidateStatus::RepairRequired
        );
        assert!(candidate
            .gaps
            .contains(&LiveProviderEvidenceWorkCandidateGap::ReplayNotReconciled));
        assert!(candidate
            .gaps
            .contains(&LiveProviderEvidenceWorkCandidateGap::RuntimeReceiptMissing));
        assert!(candidate
            .gaps
            .contains(&LiveProviderEvidenceWorkCandidateGap::ThreadIdMissing));
        assert!(!candidate.task_completion_inferred);
        assert!(!candidate.review_acceptance_inferred);
    }

    #[test]
    fn live_provider_evidence_work_candidates_do_not_infer_task_or_review_acceptance() {
        let evidence = evidence("authority");
        let replay = durable_live_provider_write_replay(&evidence);

        let candidate = live_provider_evidence_work_candidate(input(evidence, replay));

        assert!(candidate.review_ready_candidate);
        assert!(!candidate.task_completion_inferred);
        assert!(!candidate.review_acceptance_inferred);
    }

    fn input(
        evidence: DurableCodexLiveSmokeEvidenceRecord,
        replay: DurableCodexLiveProviderWriteReplayRecord,
    ) -> LiveProviderEvidenceWorkCandidateInput {
        LiveProviderEvidenceWorkCandidateInput {
            project_id: ProjectId("project:nucleus".to_owned()),
            task_id: TaskId("task:live-provider".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:live-provider".to_owned()),
            evidence,
            replay,
        }
    }

    fn evidence(label: &str) -> DurableCodexLiveSmokeEvidenceRecord {
        DurableCodexLiveSmokeEvidenceRecord {
            evidence_id: format!("evidence:{label}"),
            run_id: label.to_owned(),
            boundary_id: format!("boundary:{label}"),
            command_id: format!("command:{label}"),
            dispatch_attempt_id: format!("dispatch:{label}"),
            handoff_id: format!("handoff:{label}"),
            provider_instance_id: format!("codex:{label}"),
            runtime_session_ref: format!("runtime-session:{label}"),
            write_attempt_id: format!("write:{label}"),
            idempotency_key: format!("idempotency:{label}"),
            status: DurableCodexLiveSmokeEvidenceStatus::Persisted,
            retention_status: ProviderRetentionPolicyStatus::AcceptedReferenceOnly,
            live_executor_outcome_id: Some(format!("outcome:{label}")),
            runtime_receipt_id: Some(format!("receipt:{label}")),
            thread_id: Some(format!("thread:{label}")),
            turn_id: Some(format!("turn:{label}")),
            final_turn_status: Some("completed".to_owned()),
            method_sequence_count: 6,
            notification_count: 3,
            server_request_count: 1,
            cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
            evidence_refs: vec![format!("evidence:{label}:ref")],
            artifact_refs: vec![format!("artifact:{label}")],
            duplicate_write_attempt_detected: false,
            provider_write_executed: true,
            executor_invoked: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
            task_mutation_permitted: false,
        }
    }
}
