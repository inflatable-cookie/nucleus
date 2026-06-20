//! Durable Codex live provider-write replay reconciliation.
//!
//! This reconciles live provider-write evidence against the durable smoke
//! replay projection without promoting task completion or review acceptance.

use serde::{Deserialize, Serialize};

use crate::{
    durable_codex_live_smoke_replay_comparison, DurableCodexLiveSmokeEvidenceRecord,
    DurableCodexLiveSmokeEvidenceStatus, DurableCodexLiveSmokeReplayComparisonStatus,
};

/// Replay reconciliation record for durable live provider-write evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveProviderWriteReplayRecord {
    pub replay_id: String,
    pub evidence_id: String,
    pub write_attempt_id: String,
    pub status: DurableCodexLiveProviderWriteReplayStatus,
    pub gaps: Vec<DurableCodexLiveProviderWriteReplayGap>,
    pub smoke_replay_status: DurableCodexLiveSmokeReplayComparisonStatus,
    pub provider_write_executed: bool,
    pub replay_reconciled: bool,
    pub repair_required: bool,
    pub task_completion_promoted: bool,
    pub review_acceptance_promoted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveProviderWriteReplayStatus {
    Reconciled,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveProviderWriteReplayGap {
    EvidenceNotPersisted,
    MissingRuntimeReceipt,
    MissingLiveExecutorOutcome,
    MissingEvidenceRef,
    MissingThreadId,
    MissingTurnId,
    MissingFinalTurnStatus,
    MissingMethodSequence,
    RawProviderMaterialRetained,
    RawStreamRetained,
    TaskMutationPermitted,
    ReviewAcceptancePermitted,
}

/// Reconcile durable live provider-write evidence.
pub fn durable_live_provider_write_replay(
    evidence: &DurableCodexLiveSmokeEvidenceRecord,
) -> DurableCodexLiveProviderWriteReplayRecord {
    let smoke = durable_codex_live_smoke_replay_comparison(evidence);
    let gaps = live_write_replay_gaps(evidence);
    let status = if gaps.is_empty() {
        DurableCodexLiveProviderWriteReplayStatus::Reconciled
    } else {
        DurableCodexLiveProviderWriteReplayStatus::RepairRequired
    };

    DurableCodexLiveProviderWriteReplayRecord {
        replay_id: format!(
            "durable-live-provider-write-replay:{}",
            evidence.write_attempt_id
        ),
        evidence_id: evidence.evidence_id.clone(),
        write_attempt_id: evidence.write_attempt_id.clone(),
        status: status.clone(),
        gaps,
        smoke_replay_status: smoke.status,
        provider_write_executed: evidence.provider_write_executed,
        replay_reconciled: status == DurableCodexLiveProviderWriteReplayStatus::Reconciled,
        repair_required: status == DurableCodexLiveProviderWriteReplayStatus::RepairRequired,
        task_completion_promoted: false,
        review_acceptance_promoted: false,
    }
}

fn live_write_replay_gaps(
    evidence: &DurableCodexLiveSmokeEvidenceRecord,
) -> Vec<DurableCodexLiveProviderWriteReplayGap> {
    let mut gaps = Vec::new();

    if evidence.status != DurableCodexLiveSmokeEvidenceStatus::Persisted {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::EvidenceNotPersisted);
    }
    if evidence.runtime_receipt_id.is_none() {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingRuntimeReceipt);
    }
    if evidence.live_executor_outcome_id.is_none() {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingLiveExecutorOutcome);
    }
    if evidence.evidence_refs.is_empty() {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingEvidenceRef);
    }
    if evidence.provider_write_executed {
        live_write_identity_gaps(evidence, &mut gaps);
    }
    if evidence.raw_provider_material_retained {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::RawProviderMaterialRetained);
    }
    if evidence.raw_stream_retained {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::RawStreamRetained);
    }
    if evidence.task_mutation_permitted {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::TaskMutationPermitted);
    }

    gaps
}

fn live_write_identity_gaps(
    evidence: &DurableCodexLiveSmokeEvidenceRecord,
    gaps: &mut Vec<DurableCodexLiveProviderWriteReplayGap>,
) {
    if evidence.thread_id.as_deref().unwrap_or_default().is_empty() {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingThreadId);
    }
    if evidence.turn_id.as_deref().unwrap_or_default().is_empty() {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingTurnId);
    }
    if evidence
        .final_turn_status
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingFinalTurnStatus);
    }
    if evidence.method_sequence_count == 0 {
        gaps.push(DurableCodexLiveProviderWriteReplayGap::MissingMethodSequence);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable_codex_live_provider_write_invocation_gate, durable_codex_live_smoke_dispatch_run,
        persist_durable_live_provider_write_evidence, CodexAppServerLiveExecutorCleanupStatus,
        CodexAppServerLiveExecutorMethod, CodexAppServerLiveExecutorOutcomeStatus,
        DurableCodexLiveProviderWriteEvidenceInput,
        DurableCodexLiveProviderWriteInvocationGateInput, DurableCodexLiveSmokeDispatchRunInput,
        DurableCodexLiveSmokeIntent, ServerStateService,
    };
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn durable_live_provider_write_replay_matching_evidence_reconciles() {
        let evidence = persisted_success("reconcile");

        let replay = durable_live_provider_write_replay(&evidence);

        assert_eq!(
            replay.status,
            DurableCodexLiveProviderWriteReplayStatus::Reconciled
        );
        assert!(replay.provider_write_executed);
        assert!(replay.replay_reconciled);
        assert!(!replay.repair_required);
        assert!(!replay.task_completion_promoted);
        assert!(!replay.review_acceptance_promoted);
    }

    #[test]
    fn durable_live_provider_write_replay_missing_evidence_requires_repair() {
        let mut evidence = persisted_success("missing");
        evidence.runtime_receipt_id = None;
        evidence.live_executor_outcome_id = None;
        evidence.evidence_refs.clear();
        evidence.thread_id = None;
        evidence.turn_id = None;
        evidence.final_turn_status = None;
        evidence.method_sequence_count = 0;

        let replay = durable_live_provider_write_replay(&evidence);

        assert_eq!(
            replay.status,
            DurableCodexLiveProviderWriteReplayStatus::RepairRequired
        );
        assert!(replay
            .gaps
            .contains(&DurableCodexLiveProviderWriteReplayGap::MissingRuntimeReceipt));
        assert!(replay
            .gaps
            .contains(&DurableCodexLiveProviderWriteReplayGap::MissingThreadId));
        assert!(replay.repair_required);
    }

    #[test]
    fn durable_live_provider_write_replay_keeps_task_and_review_authority_closed() {
        let mut evidence = persisted_success("authority");
        evidence.task_mutation_permitted = true;

        let replay = durable_live_provider_write_replay(&evidence);

        assert!(replay
            .gaps
            .contains(&DurableCodexLiveProviderWriteReplayGap::TaskMutationPermitted));
        assert!(!replay.task_completion_promoted);
        assert!(!replay.review_acceptance_promoted);
    }

    fn persisted_success(run_id: &str) -> DurableCodexLiveSmokeEvidenceRecord {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        persist_durable_live_provider_write_evidence(
            &state,
            DurableCodexLiveProviderWriteEvidenceInput {
                run: run(run_id),
                gate: gate(run_id),
                existing_write_attempt_ids: Vec::new(),
                thread_id: Some(format!("thread:{run_id}")),
                turn_id: Some(format!("turn:{run_id}")),
                final_turn_status: Some("completed".to_owned()),
                status: CodexAppServerLiveExecutorOutcomeStatus::Completed,
                method_sequence: completed_methods(),
                notification_count: 3,
                server_request_count: 1,
                cleanup_status: CodexAppServerLiveExecutorCleanupStatus::Completed,
                evidence_refs: vec![format!("evidence:{run_id}:live")],
                artifact_refs: vec![format!("artifact:{run_id}:summary")],
                raw_provider_material_present: false,
                raw_stream_present: false,
                secret_material_present: false,
                credential_material_present: false,
                unbounded_local_path_present: false,
            },
        )
        .expect("persist success evidence")
    }

    fn gate(run_id: &str) -> crate::DurableCodexLiveProviderWriteInvocationGateRecord {
        durable_codex_live_provider_write_invocation_gate(
            DurableCodexLiveProviderWriteInvocationGateInput {
                boundary: run(run_id).boundary,
                invocation_evidence_refs: vec![format!("evidence:{run_id}:gate")],
                executor_invocation_requested: false,
                provider_write_requested: false,
                raw_provider_material_requested: false,
                raw_stream_requested: false,
                task_mutation_requested: false,
                review_acceptance_requested: false,
                callback_answer_requested: false,
                cancellation_requested: false,
                resume_requested: false,
                scm_mutation_requested: false,
            },
        )
    }

    fn run(run_id: &str) -> crate::DurableCodexLiveSmokeDispatchRunRecord {
        durable_codex_live_smoke_dispatch_run(DurableCodexLiveSmokeDispatchRunInput {
            intent: DurableCodexLiveSmokeIntent::ConfirmedRealWriteWithEffect {
                confirmation_ref: format!("evidence:{run_id}:confirm"),
                effect_ref: format!("evidence:{run_id}:effect"),
            },
            run_id: run_id.to_owned(),
            provider_instance_id: format!("codex:{run_id}"),
            runtime_session_ref: format!("runtime-session:{run_id}"),
            task_id: format!("task:{run_id}"),
            work_item_id: format!("work:{run_id}"),
            operator_confirmation_ref: format!("operator-confirmation:{run_id}"),
            evidence_refs: vec![format!("evidence:{run_id}:command")],
        })
    }

    fn completed_methods() -> Vec<CodexAppServerLiveExecutorMethod> {
        vec![
            CodexAppServerLiveExecutorMethod::Initialize,
            CodexAppServerLiveExecutorMethod::InitializedNotification,
            CodexAppServerLiveExecutorMethod::ThreadStart,
            CodexAppServerLiveExecutorMethod::TurnStart,
            CodexAppServerLiveExecutorMethod::TurnCompleted,
            CodexAppServerLiveExecutorMethod::Cleanup,
        ]
    }
}
