use crate::{
    ScmCaptureDryRunExecutionDiagnosticsRecord, ScmCaptureDryRunExecutionPersistenceRecord,
    ScmCaptureDryRunExecutionPersistenceStatus, ScmCaptureDryRunReceiptStatus,
};

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

fn outcome_count(
    records: &[ScmCaptureDryRunExecutionPersistenceRecord],
    outcome: ScmCaptureDryRunReceiptStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome == outcome)
        .count()
}
