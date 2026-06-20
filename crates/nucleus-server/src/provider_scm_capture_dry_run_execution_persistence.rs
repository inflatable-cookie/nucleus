//! Persistence for SCM capture dry-run execution receipts.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureDryRunReceiptBlocker, ScmCaptureDryRunReceiptRecord, ScmCaptureDryRunReceiptStatus,
    ServerStateService,
};

const SCM_CAPTURE_DRY_RUN_EXECUTION_PREFIX: &str = "scm-capture-dry-run-execution:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunExecutionPersistenceInput {
    pub receipt: ScmCaptureDryRunReceiptRecord,
    pub existing_execution_receipt_ids: Vec<String>,
    pub raw_output_present: bool,
    pub scm_capture_requested: bool,
    pub scm_publish_requested: bool,
    pub forge_change_request_requested: bool,
    pub forge_merge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionPersistenceRecord {
    pub persisted_execution_receipt_id: String,
    pub receipt_id: String,
    pub capability_item_id: String,
    pub admission_id: String,
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub outcome: ScmCaptureDryRunReceiptStatus,
    pub receipt_blockers: Vec<ScmCaptureDryRunReceiptBlocker>,
    pub persistence_status: ScmCaptureDryRunExecutionPersistenceStatus,
    pub persistence_blockers: Vec<ScmCaptureDryRunExecutionPersistenceBlocker>,
    pub duplicate_execution_receipt_detected: bool,
    pub evidence_refs: Vec<String>,
    pub changed_path_count: usize,
    pub summary_line_count: usize,
    pub scm_dry_run_executed: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_change_request_created: bool,
    pub forge_merge_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionPersistenceBlocker {
    MissingEvidenceRef,
    RawOutputPresent,
    CaptureRequested,
    PublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub receipt_count: usize,
    pub accepted_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub timed_out_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub blocker_count: usize,
    pub dry_run_executed_count: usize,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

pub fn persist_scm_capture_dry_run_execution_receipt<B>(
    state: &ServerStateService<B>,
    input: ScmCaptureDryRunExecutionPersistenceInput,
) -> LocalStoreResult<ScmCaptureDryRunExecutionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let persisted_execution_receipt_id = persisted_execution_receipt_id(&input.receipt.receipt_id);
    if input
        .existing_execution_receipt_ids
        .contains(&persisted_execution_receipt_id)
    {
        return Ok(persistence_record(
            input,
            persisted_execution_receipt_id,
            ScmCaptureDryRunExecutionPersistenceStatus::DuplicateNoop,
            Vec::new(),
            true,
        ));
    }

    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        ScmCaptureDryRunExecutionPersistenceStatus::Persisted
    } else {
        ScmCaptureDryRunExecutionPersistenceStatus::Blocked
    };
    let record = persistence_record(
        input,
        persisted_execution_receipt_id,
        status,
        blockers,
        false,
    );

    if record.persistence_status == ScmCaptureDryRunExecutionPersistenceStatus::Persisted {
        state.artifact_metadata().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.persisted_execution_receipt_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", record.persisted_execution_receipt_id)),
                payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
            },
            RevisionExpectation::MustNotExist,
        )?;
    }

    Ok(record)
}

pub fn read_scm_capture_dry_run_execution_receipts<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ScmCaptureDryRunExecutionPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| {
            record
                .id
                .0
                .starts_with(SCM_CAPTURE_DRY_RUN_EXECUTION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<ScmCaptureDryRunExecutionPersistenceRecord>(
                &record.payload.bytes,
            )
            .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| {
        left.persisted_execution_receipt_id
            .cmp(&right.persisted_execution_receipt_id)
    });
    Ok(records)
}

pub fn scm_capture_dry_run_execution_diagnostics_from_persisted_records(
    records: Vec<ScmCaptureDryRunExecutionPersistenceRecord>,
) -> ScmCaptureDryRunExecutionDiagnosticsRecord {
    ScmCaptureDryRunExecutionDiagnosticsRecord {
        diagnostics_id: "scm-capture-dry-run-execution-diagnostics-from-persistence".to_owned(),
        receipt_count: records.len(),
        accepted_count: outcome_count(&records, ScmCaptureDryRunReceiptStatus::Accepted),
        completed_count: outcome_count(&records, ScmCaptureDryRunReceiptStatus::Completed),
        failed_count: outcome_count(&records, ScmCaptureDryRunReceiptStatus::Failed),
        timed_out_count: outcome_count(&records, ScmCaptureDryRunReceiptStatus::TimedOut),
        blocked_count: outcome_count(&records, ScmCaptureDryRunReceiptStatus::Blocked),
        repair_required_count: outcome_count(
            &records,
            ScmCaptureDryRunReceiptStatus::RepairRequired,
        ),
        duplicate_noop_count: records
            .iter()
            .filter(|record| {
                record.persistence_status
                    == ScmCaptureDryRunExecutionPersistenceStatus::DuplicateNoop
            })
            .count(),
        blocker_count: records
            .iter()
            .map(|record| record.receipt_blockers.len() + record.persistence_blockers.len())
            .sum(),
        dry_run_executed_count: records
            .iter()
            .filter(|record| record.scm_dry_run_executed)
            .count(),
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn persistence_record(
    input: ScmCaptureDryRunExecutionPersistenceInput,
    persisted_execution_receipt_id: String,
    persistence_status: ScmCaptureDryRunExecutionPersistenceStatus,
    persistence_blockers: Vec<ScmCaptureDryRunExecutionPersistenceBlocker>,
    duplicate_execution_receipt_detected: bool,
) -> ScmCaptureDryRunExecutionPersistenceRecord {
    ScmCaptureDryRunExecutionPersistenceRecord {
        persisted_execution_receipt_id,
        receipt_id: input.receipt.receipt_id,
        capability_item_id: input.receipt.capability_item_id,
        admission_id: input.receipt.admission_id,
        persisted_dry_run_plan_id: input.receipt.persisted_dry_run_plan_id,
        dry_run_plan_item_id: input.receipt.dry_run_plan_item_id,
        task_id: input.receipt.task_id,
        work_item_id: input.receipt.work_item_id,
        completion_id: input.receipt.completion_id,
        operator_ref: input.receipt.operator_ref,
        adapter_label: input.receipt.adapter_label,
        workflow_label: input.receipt.workflow_label,
        outcome: input.receipt.outcome,
        receipt_blockers: input.receipt.blockers,
        persistence_status,
        persistence_blockers,
        duplicate_execution_receipt_detected,
        evidence_refs: unique_sorted(input.receipt.evidence_refs),
        changed_path_count: input.receipt.changed_path_count,
        summary_line_count: input.receipt.summary_line_count,
        scm_dry_run_executed: input.receipt.scm_dry_run_executed,
        scm_capture_executed: false,
        scm_publish_executed: false,
        forge_change_request_created: false,
        forge_merge_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_material_exposed: false,
    }
}

fn blockers(
    input: &ScmCaptureDryRunExecutionPersistenceInput,
) -> Vec<ScmCaptureDryRunExecutionPersistenceBlocker> {
    let mut blockers = Vec::new();
    if input.receipt.evidence_refs.is_empty() {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::MissingEvidenceRef);
    }
    if input.raw_output_present {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::RawOutputPresent);
    }
    if input.scm_capture_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::CaptureRequested);
    }
    if input.scm_publish_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::PublishRequested);
    }
    if input.forge_change_request_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::ForgeChangeRequestRequested);
    }
    if input.forge_merge_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::ForgeMergeRequested);
    }
    if input.provider_write_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::CallbackResponseRequested);
    }
    if input.interruption_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::InterruptionRequested);
    }
    if input.recovery_requested {
        blockers.push(ScmCaptureDryRunExecutionPersistenceBlocker::RecoveryRequested);
    }
    blockers
}

fn outcome_count(
    records: &[ScmCaptureDryRunExecutionPersistenceRecord],
    outcome: ScmCaptureDryRunReceiptStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome == outcome)
        .count()
}

fn persisted_execution_receipt_id(receipt_id: &str) -> String {
    format!("{SCM_CAPTURE_DRY_RUN_EXECUTION_PREFIX}{receipt_id}")
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn scm_capture_dry_run_execution_persistence_records_round_trip_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record = persist_scm_capture_dry_run_execution_receipt(
            &state,
            input(receipt("1", ScmCaptureDryRunReceiptStatus::Completed, true)),
        )
        .expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_scm_capture_dry_run_execution_receipts(&reopened).expect("read");

        assert_eq!(records, vec![record]);
        assert_eq!(records[0].changed_path_count, 2);
        assert!(records[0].scm_dry_run_executed);
        assert!(!records[0].scm_capture_executed);
        assert!(!records[0].raw_material_exposed);
    }

    #[test]
    fn scm_capture_dry_run_execution_state_api_reads_records_in_stable_order() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        persist_scm_capture_dry_run_execution_receipt(
            &state,
            input(receipt("b", ScmCaptureDryRunReceiptStatus::Accepted, false)),
        )
        .expect("persist b");
        persist_scm_capture_dry_run_execution_receipt(
            &state,
            input(receipt("a", ScmCaptureDryRunReceiptStatus::Accepted, false)),
        )
        .expect("persist a");

        let records = read_scm_capture_dry_run_execution_receipts(&state).expect("read");

        assert_eq!(records[0].receipt_id, "receipt:a");
        assert_eq!(records[1].receipt_id, "receipt:b");
    }

    #[test]
    fn scm_capture_dry_run_execution_duplicate_blocked_preserves_terminal_outcomes() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

        let failed = persist_scm_capture_dry_run_execution_receipt(
            &state,
            input(receipt(
                "failed",
                ScmCaptureDryRunReceiptStatus::Failed,
                false,
            )),
        )
        .expect("persist failed");
        let repair = persist_scm_capture_dry_run_execution_receipt(
            &state,
            input(receipt(
                "repair",
                ScmCaptureDryRunReceiptStatus::RepairRequired,
                false,
            )),
        )
        .expect("persist repair");
        let duplicate = persist_scm_capture_dry_run_execution_receipt(
            &state,
            ScmCaptureDryRunExecutionPersistenceInput {
                existing_execution_receipt_ids: vec![failed.persisted_execution_receipt_id.clone()],
                ..input(receipt(
                    "failed",
                    ScmCaptureDryRunReceiptStatus::Completed,
                    true,
                ))
            },
        )
        .expect("duplicate");

        assert_eq!(failed.outcome, ScmCaptureDryRunReceiptStatus::Failed);
        assert_eq!(
            repair.outcome,
            ScmCaptureDryRunReceiptStatus::RepairRequired
        );
        assert_eq!(
            duplicate.persistence_status,
            ScmCaptureDryRunExecutionPersistenceStatus::DuplicateNoop
        );
        assert!(duplicate.duplicate_execution_receipt_detected);
    }

    #[test]
    fn scm_capture_dry_run_execution_duplicate_blocked_blocks_raw_or_external_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
        let mut input = input(receipt(
            "blocked",
            ScmCaptureDryRunReceiptStatus::Completed,
            true,
        ));
        input.raw_output_present = true;
        input.scm_capture_requested = true;
        input.forge_change_request_requested = true;

        let record = persist_scm_capture_dry_run_execution_receipt(&state, input).expect("blocked");

        assert_eq!(
            record.persistence_status,
            ScmCaptureDryRunExecutionPersistenceStatus::Blocked
        );
        assert!(record
            .persistence_blockers
            .contains(&ScmCaptureDryRunExecutionPersistenceBlocker::RawOutputPresent));
        assert!(record
            .persistence_blockers
            .contains(&ScmCaptureDryRunExecutionPersistenceBlocker::CaptureRequested));
        assert!(!record.scm_capture_executed);
        assert!(!record.raw_material_exposed);
    }

    #[test]
    fn scm_capture_dry_run_execution_diagnostics_source_summarizes_persisted_records() {
        let diagnostics = scm_capture_dry_run_execution_diagnostics_from_persisted_records(vec![
            persisted("accepted", ScmCaptureDryRunReceiptStatus::Accepted, false),
            persisted("completed", ScmCaptureDryRunReceiptStatus::Completed, true),
            persisted("failed", ScmCaptureDryRunReceiptStatus::Failed, false),
            persisted("timeout", ScmCaptureDryRunReceiptStatus::TimedOut, false),
            persisted("blocked", ScmCaptureDryRunReceiptStatus::Blocked, false),
            persisted(
                "repair",
                ScmCaptureDryRunReceiptStatus::RepairRequired,
                false,
            ),
        ]);

        assert_eq!(diagnostics.receipt_count, 6);
        assert_eq!(diagnostics.accepted_count, 1);
        assert_eq!(diagnostics.completed_count, 1);
        assert_eq!(diagnostics.failed_count, 1);
        assert_eq!(diagnostics.timed_out_count, 1);
        assert_eq!(diagnostics.blocked_count, 1);
        assert_eq!(diagnostics.repair_required_count, 1);
        assert_eq!(diagnostics.dry_run_executed_count, 1);
        assert!(!diagnostics.scm_capture_executed);
        assert!(!diagnostics.raw_material_exposed);
    }

    fn input(receipt: ScmCaptureDryRunReceiptRecord) -> ScmCaptureDryRunExecutionPersistenceInput {
        ScmCaptureDryRunExecutionPersistenceInput {
            receipt,
            existing_execution_receipt_ids: Vec::new(),
            raw_output_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        }
    }

    fn receipt(
        id: &str,
        outcome: ScmCaptureDryRunReceiptStatus,
        scm_dry_run_executed: bool,
    ) -> ScmCaptureDryRunReceiptRecord {
        ScmCaptureDryRunReceiptRecord {
            receipt_id: format!("receipt:{id}"),
            capability_item_id: format!("capability:{id}"),
            admission_id: format!("admission:{id}"),
            persisted_dry_run_plan_id: format!("persisted-plan:{id}"),
            dry_run_plan_item_id: format!("dry-run-plan:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            outcome,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:receipt".to_owned(), "evidence:receipt".to_owned()],
            changed_path_count: 2,
            summary_line_count: 4,
            scm_dry_run_executed,
            scm_capture_executed: false,
            scm_publish_executed: false,
            forge_change_request_created: false,
            forge_merge_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_material_exposed: false,
        }
    }

    fn persisted(
        id: &str,
        outcome: ScmCaptureDryRunReceiptStatus,
        scm_dry_run_executed: bool,
    ) -> ScmCaptureDryRunExecutionPersistenceRecord {
        ScmCaptureDryRunExecutionPersistenceRecord {
            persisted_execution_receipt_id: format!("persisted:{id}"),
            receipt_id: format!("receipt:{id}"),
            capability_item_id: format!("capability:{id}"),
            admission_id: format!("admission:{id}"),
            persisted_dry_run_plan_id: format!("persisted-plan:{id}"),
            dry_run_plan_item_id: format!("dry-run-plan:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            adapter_label: "git".to_owned(),
            workflow_label: "working-tree-preview".to_owned(),
            outcome,
            receipt_blockers: Vec::new(),
            persistence_status: ScmCaptureDryRunExecutionPersistenceStatus::Persisted,
            persistence_blockers: Vec::new(),
            duplicate_execution_receipt_detected: false,
            evidence_refs: vec!["evidence:receipt".to_owned()],
            changed_path_count: 1,
            summary_line_count: 2,
            scm_dry_run_executed,
            scm_capture_executed: false,
            scm_publish_executed: false,
            forge_change_request_created: false,
            forge_merge_executed: false,
            provider_write_executed: false,
            callback_response_executed: false,
            interruption_executed: false,
            recovery_executed: false,
            raw_material_exposed: false,
        }
    }
}
