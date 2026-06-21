use super::*;

#[test]
fn convergence_local_snap_spawn_receipt_control_dto_reports_counts_and_ids() {
    let dto = convergence_local_snap_spawn_receipt_control_dto(input(vec![
        record(
            "accepted",
            ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapSpawnReceiptStatus::Blocked,
            vec![ConvergenceLocalSnapSpawnReceiptBlocker::HandoffNotReady],
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapSpawnReceiptBlocker::DuplicateReceipt],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapSpawnReceiptStatus::Unsupported,
            Vec::new(),
        ),
        record(
            "failed",
            ConvergenceLocalSnapSpawnReceiptStatus::Failed,
            Vec::new(),
        ),
        record(
            "cleanup",
            ConvergenceLocalSnapSpawnReceiptStatus::CleanupRequired,
            Vec::new(),
        ),
    ]));

    assert_eq!(dto.receipt_set_id, "receipt-set");
    assert_eq!(dto.accepted_count, 1);
    assert_eq!(dto.blocked_count, 1);
    assert_eq!(dto.duplicate_count, 1);
    assert_eq!(dto.unsupported_count, 1);
    assert_eq!(dto.failed_count, 1);
    assert_eq!(dto.cleanup_required_count, 1);
    assert_eq!(dto.blocker_count, 2);
    assert_eq!(dto.accepted_receipt_ids, vec!["receipt:accepted"]);
    assert_eq!(dto.blocked_receipt_ids, vec!["receipt:blocked"]);
    assert_eq!(dto.duplicate_receipt_ids, vec!["receipt:duplicate"]);
    assert_eq!(dto.unsupported_receipt_ids, vec!["receipt:unsupported"]);
    assert_eq!(dto.failed_receipt_ids, vec!["receipt:failed"]);
    assert_eq!(dto.cleanup_required_receipt_ids, vec!["receipt:cleanup"]);
}

#[test]
fn convergence_local_snap_spawn_receipt_control_dto_preserves_sanitized_refs() {
    let dto = convergence_local_snap_spawn_receipt_control_dto(input(vec![record(
        "refs",
        ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
        Vec::new(),
    )]));
    let record = &dto.records[0];

    assert_eq!(record.receipt_id, "receipt:refs");
    assert_eq!(record.handoff_id, "handoff:refs");
    assert_eq!(record.spawn_request_id, "spawn:refs");
    assert_eq!(record.preflight_record_id, "preflight:refs");
    assert_eq!(record.replay_record_id, "replay:refs");
    assert_eq!(record.adapter_record_id, "adapter:refs");
    assert_eq!(record.persisted_evidence_id, "persisted-evidence:refs");
    assert_eq!(record.evidence_id, "evidence:refs");
    assert_eq!(record.proof_id, "proof:refs");
    assert_eq!(record.persisted_request_id, "persisted:refs");
    assert_eq!(record.stopped_request_id, "stopped:refs");
    assert_eq!(record.idempotency_key, "idempotency:refs");
    assert_eq!(record.descriptor_id, "descriptor:refs");
    assert_eq!(record.admission_id, "admission:refs");
    assert_eq!(record.source_replay_record_id, "source-replay:refs");
    assert_eq!(record.task_ids, vec!["task:refs"]);
    assert_eq!(record.repo_ids, vec!["repo:refs"]);
    assert_eq!(record.source_authority_ref, "source-authority:refs");
    assert_eq!(record.execution_authority_ref, "execution-authority:refs");
    assert_eq!(record.inspected_ref_count, 1);
}

#[test]
fn convergence_local_snap_spawn_receipt_control_dto_carries_no_authority() {
    let dto = convergence_local_snap_spawn_receipt_control_dto(input(vec![record(
        "accepted",
        ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
        Vec::new(),
    )]));
    let record = &dto.records[0];

    assert!(!dto.process_runner_invocation_permitted);
    assert!(!dto.command_spawn_permitted);
    assert!(!dto.local_snap_creation_permitted);
    assert!(!dto.object_upload_permitted);
    assert!(!dto.publication_permitted);
    assert!(!dto.lane_sync_permitted);
    assert!(!dto.provider_write_permitted);
    assert!(!dto.task_mutation_permitted);
    assert!(!dto.raw_output_retained);
    assert!(!record.process_runner_invocation_permitted);
    assert!(!record.command_spawn_permitted);
    assert!(!record.local_snap_creation_permitted);
    assert!(!record.object_upload_permitted);
    assert!(!record.publication_permitted);
    assert!(!record.lane_sync_permitted);
    assert!(!record.provider_write_permitted);
    assert!(!record.task_mutation_permitted);
    assert!(!record.raw_output_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapSpawnReceiptControlRecordDto>,
) -> ConvergenceLocalSnapSpawnReceiptSet {
    ConvergenceLocalSnapSpawnReceiptSet {
        receipt_set_id: "receipt-set".to_owned(),
        accepted_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
        ),
        blocked_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Blocked,
        ),
        duplicate_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop,
        ),
        unsupported_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Unsupported,
        ),
        failed_receipt_ids: ids_by_status(&records, ConvergenceLocalSnapSpawnReceiptStatus::Failed),
        cleanup_required_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::CleanupRequired,
        ),
        records: records
            .into_iter()
            .map(ConvergenceLocalSnapSpawnReceiptRecord::from)
            .collect(),
        process_runner_invocation_permitted: false,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapSpawnReceiptStatus,
    blockers: Vec<ConvergenceLocalSnapSpawnReceiptBlocker>,
) -> ConvergenceLocalSnapSpawnReceiptControlRecordDto {
    ConvergenceLocalSnapSpawnReceiptControlRecordDto {
        receipt_id: format!("receipt:{suffix}"),
        handoff_id: format!("handoff:{suffix}"),
        spawn_request_id: format!("spawn:{suffix}"),
        preflight_record_id: format!("preflight:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("persisted:{suffix}"),
        stopped_request_id: format!("stopped:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        descriptor_id: format!("descriptor:{suffix}"),
        admission_id: format!("admission:{suffix}"),
        source_replay_record_id: format!("source-replay:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        inspected_ref_count: 1,
        status,
        blockers,
        duplicate_receipt_detected: false,
        process_runner_invocation_permitted: false,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn ids_by_status(
    records: &[ConvergenceLocalSnapSpawnReceiptControlRecordDto],
    status: ConvergenceLocalSnapSpawnReceiptStatus,
) -> Vec<String> {
    records
        .iter()
        .filter(|record| record.status == status)
        .map(|record| record.receipt_id.clone())
        .collect()
}

impl From<ConvergenceLocalSnapSpawnReceiptControlRecordDto>
    for ConvergenceLocalSnapSpawnReceiptRecord
{
    fn from(record: ConvergenceLocalSnapSpawnReceiptControlRecordDto) -> Self {
        Self {
            receipt_id: record.receipt_id,
            handoff_id: record.handoff_id,
            spawn_request_id: record.spawn_request_id,
            preflight_record_id: record.preflight_record_id,
            replay_record_id: record.replay_record_id,
            adapter_record_id: record.adapter_record_id,
            persisted_evidence_id: record.persisted_evidence_id,
            evidence_id: record.evidence_id,
            proof_id: record.proof_id,
            persisted_request_id: record.persisted_request_id,
            stopped_request_id: record.stopped_request_id,
            idempotency_key: record.idempotency_key,
            descriptor_id: record.descriptor_id,
            admission_id: record.admission_id,
            source_replay_record_id: record.source_replay_record_id,
            task_ids: record.task_ids,
            repo_ids: record.repo_ids,
            source_authority_ref: record.source_authority_ref,
            execution_authority_ref: record.execution_authority_ref,
            inspected_ref_count: record.inspected_ref_count,
            status: record.status,
            blockers: record.blockers,
            duplicate_receipt_detected: record.duplicate_receipt_detected,
            process_runner_invocation_permitted: false,
            command_spawn_permitted: false,
            local_snap_creation_permitted: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_output_retained: false,
        }
    }
}
