//! Durable Codex live-smoke replay comparison.
//!
//! This module compares persisted smoke evidence with the deterministic
//! task-backed live workflow fixture. Differences become repair-required
//! evidence, not automatic task/review promotion.

use serde::{Deserialize, Serialize};

use crate::{
    task_backed_live_workflow_fixture, DurableCodexLiveSmokeEvidenceRecord,
    DurableCodexLiveSmokeEvidenceStatus, TaskBackedLiveWorkflowReplay,
};

/// Durable live-smoke replay comparison record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveSmokeReplayComparisonRecord {
    pub comparison_id: String,
    pub evidence_id: String,
    pub run_id: String,
    pub status: DurableCodexLiveSmokeReplayComparisonStatus,
    pub gaps: Vec<DurableCodexLiveSmokeReplayGap>,
    pub evidence_refs: Vec<String>,
    pub runtime_receipt_id: Option<String>,
    pub live_executor_outcome_id: Option<String>,
    pub fixture_scheduler_admitted: bool,
    pub fixture_live_executor_admitted: bool,
    pub fixture_review_explicitly_accepted: bool,
    pub replay_equivalent: bool,
    pub repair_required: bool,
    pub provider_write_executed: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
    pub review_acceptance_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeReplayComparisonStatus {
    ReplayEquivalent,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeReplayGap {
    EvidenceNotPersisted,
    MissingRuntimeReceipt,
    MissingLiveExecutorOutcome,
    MissingEvidenceRef,
    FixtureSchedulerNotAdmitted,
    FixtureLiveExecutorNotAdmitted,
    ReviewAcceptanceNotExplicit,
    ProviderWriteAlreadyExecuted,
    RawProviderMaterialRetained,
    TaskMutationPermitted,
    ReviewAcceptancePermitted,
}

/// Compare one persisted durable smoke record with the task-backed fixture.
pub fn durable_codex_live_smoke_replay_comparison(
    evidence: &DurableCodexLiveSmokeEvidenceRecord,
) -> DurableCodexLiveSmokeReplayComparisonRecord {
    durable_codex_live_smoke_replay_comparison_with_fixture(
        evidence,
        task_backed_live_workflow_fixture(),
    )
}

/// Compare one persisted durable smoke record with an explicit fixture replay.
pub fn durable_codex_live_smoke_replay_comparison_with_fixture(
    evidence: &DurableCodexLiveSmokeEvidenceRecord,
    fixture: TaskBackedLiveWorkflowReplay,
) -> DurableCodexLiveSmokeReplayComparisonRecord {
    let gaps = replay_gaps(evidence, &fixture);
    let status = if gaps.is_empty() {
        DurableCodexLiveSmokeReplayComparisonStatus::ReplayEquivalent
    } else {
        DurableCodexLiveSmokeReplayComparisonStatus::RepairRequired
    };

    DurableCodexLiveSmokeReplayComparisonRecord {
        comparison_id: format!(
            "durable-codex-live-smoke-replay:{}",
            evidence.write_attempt_id
        ),
        evidence_id: evidence.evidence_id.clone(),
        run_id: evidence.run_id.clone(),
        status: status.clone(),
        gaps,
        evidence_refs: evidence.evidence_refs.clone(),
        runtime_receipt_id: evidence.runtime_receipt_id.clone(),
        live_executor_outcome_id: evidence.live_executor_outcome_id.clone(),
        fixture_scheduler_admitted: fixture.scheduler_admitted,
        fixture_live_executor_admitted: fixture.live_executor_admitted,
        fixture_review_explicitly_accepted: fixture.review_accepted_by_explicit_command,
        replay_equivalent: status == DurableCodexLiveSmokeReplayComparisonStatus::ReplayEquivalent,
        repair_required: status == DurableCodexLiveSmokeReplayComparisonStatus::RepairRequired,
        provider_write_executed: false,
        raw_provider_material_retained: false,
        task_mutation_permitted: false,
        review_acceptance_permitted: false,
    }
}

fn replay_gaps(
    evidence: &DurableCodexLiveSmokeEvidenceRecord,
    fixture: &TaskBackedLiveWorkflowReplay,
) -> Vec<DurableCodexLiveSmokeReplayGap> {
    let mut gaps = Vec::new();

    if evidence.status != DurableCodexLiveSmokeEvidenceStatus::Persisted {
        gaps.push(DurableCodexLiveSmokeReplayGap::EvidenceNotPersisted);
    }
    if evidence.runtime_receipt_id.is_none() {
        gaps.push(DurableCodexLiveSmokeReplayGap::MissingRuntimeReceipt);
    }
    if evidence.live_executor_outcome_id.is_none() {
        gaps.push(DurableCodexLiveSmokeReplayGap::MissingLiveExecutorOutcome);
    }
    if evidence.evidence_refs.is_empty() {
        gaps.push(DurableCodexLiveSmokeReplayGap::MissingEvidenceRef);
    }
    if !fixture.scheduler_admitted {
        gaps.push(DurableCodexLiveSmokeReplayGap::FixtureSchedulerNotAdmitted);
    }
    if !fixture.live_executor_admitted {
        gaps.push(DurableCodexLiveSmokeReplayGap::FixtureLiveExecutorNotAdmitted);
    }
    if !fixture.review_accepted_by_explicit_command {
        gaps.push(DurableCodexLiveSmokeReplayGap::ReviewAcceptanceNotExplicit);
    }
    if evidence.provider_write_executed {
        gaps.push(DurableCodexLiveSmokeReplayGap::ProviderWriteAlreadyExecuted);
    }
    if evidence.raw_provider_material_retained || evidence.raw_stream_retained {
        gaps.push(DurableCodexLiveSmokeReplayGap::RawProviderMaterialRetained);
    }
    if evidence.task_mutation_permitted {
        gaps.push(DurableCodexLiveSmokeReplayGap::TaskMutationPermitted);
    }

    gaps
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable_codex_live_smoke_dispatch_run, persist_durable_codex_live_smoke_evidence,
        DurableCodexLiveSmokeDispatchRunInput, DurableCodexLiveSmokeEvidencePersistenceInput,
        DurableCodexLiveSmokeIntent, ServerStateService,
    };
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn durable_codex_live_smoke_replay_matching_evidence_is_equivalent() {
        let evidence = persisted_evidence();

        let comparison = durable_codex_live_smoke_replay_comparison(&evidence);

        assert_eq!(
            comparison.status,
            DurableCodexLiveSmokeReplayComparisonStatus::ReplayEquivalent
        );
        assert!(comparison.replay_equivalent);
        assert!(!comparison.repair_required);
        assert!(comparison.runtime_receipt_id.is_some());
        assert!(comparison.live_executor_outcome_id.is_some());
        assert!(comparison.fixture_review_explicitly_accepted);
        assert!(!comparison.review_acceptance_permitted);
    }

    #[test]
    fn durable_codex_live_smoke_replay_missing_refs_are_repair_required() {
        let mut evidence = persisted_evidence();
        evidence.runtime_receipt_id = None;
        evidence.live_executor_outcome_id = None;
        evidence.evidence_refs.clear();

        let comparison = durable_codex_live_smoke_replay_comparison(&evidence);

        assert_eq!(
            comparison.status,
            DurableCodexLiveSmokeReplayComparisonStatus::RepairRequired
        );
        assert!(comparison
            .gaps
            .contains(&DurableCodexLiveSmokeReplayGap::MissingRuntimeReceipt));
        assert!(comparison
            .gaps
            .contains(&DurableCodexLiveSmokeReplayGap::MissingLiveExecutorOutcome));
        assert!(comparison
            .gaps
            .contains(&DurableCodexLiveSmokeReplayGap::MissingEvidenceRef));
        assert!(comparison.repair_required);
        assert!(!comparison.provider_write_executed);
    }

    #[test]
    fn durable_codex_live_smoke_replay_blocks_authority_promotion() {
        let mut evidence = persisted_evidence();
        evidence.provider_write_executed = true;
        evidence.raw_provider_material_retained = true;
        evidence.task_mutation_permitted = true;

        let comparison = durable_codex_live_smoke_replay_comparison(&evidence);

        assert!(comparison
            .gaps
            .contains(&DurableCodexLiveSmokeReplayGap::ProviderWriteAlreadyExecuted));
        assert!(comparison
            .gaps
            .contains(&DurableCodexLiveSmokeReplayGap::RawProviderMaterialRetained));
        assert!(comparison
            .gaps
            .contains(&DurableCodexLiveSmokeReplayGap::TaskMutationPermitted));
        assert!(!comparison.provider_write_executed);
        assert!(!comparison.task_mutation_permitted);
        assert!(!comparison.review_acceptance_permitted);
    }

    fn persisted_evidence() -> DurableCodexLiveSmokeEvidenceRecord {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        persist_durable_codex_live_smoke_evidence(
            &state,
            DurableCodexLiveSmokeEvidencePersistenceInput {
                run: durable_codex_live_smoke_dispatch_run(DurableCodexLiveSmokeDispatchRunInput {
                    intent: DurableCodexLiveSmokeIntent::DryRunOnly,
                    run_id: "replay".to_owned(),
                    provider_instance_id: "codex:replay".to_owned(),
                    runtime_session_ref: "runtime-session:replay".to_owned(),
                    task_id: "task:replay".to_owned(),
                    work_item_id: "work:replay".to_owned(),
                    operator_confirmation_ref: "operator-confirmation:replay".to_owned(),
                    evidence_refs: vec!["evidence:replay:command".to_owned()],
                }),
                live_outcome: None,
                existing_write_attempt_ids: Vec::new(),
                persistence_evidence_refs: vec!["evidence:replay:persistence".to_owned()],
                artifact_refs: vec!["artifact:replay-summary".to_owned()],
                raw_provider_material_present: false,
                raw_stream_present: false,
                secret_material_present: false,
                credential_material_present: false,
                unbounded_local_path_present: false,
            },
        )
        .expect("persist evidence")
    }
}
