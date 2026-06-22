use crate::ForgeNetworkExecutionOutcomePersistenceRecord;

use super::types::{
    ForgeNetworkExecutionOutcomeControlDto, ForgeNetworkExecutionOutcomeDiagnosticsRecord,
    ForgeNetworkExecutionOutcomePersistenceStatus, ForgeNetworkExecutionOutcomeStatus,
};

pub fn forge_network_execution_outcome_diagnostics_from_persisted_records(
    records: Vec<ForgeNetworkExecutionOutcomePersistenceRecord>,
) -> ForgeNetworkExecutionOutcomeDiagnosticsRecord {
    ForgeNetworkExecutionOutcomeDiagnosticsRecord {
        diagnostics_id: "forge-network-execution-outcome-diagnostics".to_owned(),
        outcome_count: records.len(),
        stopped_recorded_count: outcome_count(
            &records,
            ForgeNetworkExecutionOutcomeStatus::StoppedRecorded,
        ),
        failed_count: outcome_count(&records, ForgeNetworkExecutionOutcomeStatus::Failed),
        blocked_count: outcome_count(&records, ForgeNetworkExecutionOutcomeStatus::Blocked),
        repair_required_count: outcome_count(
            &records,
            ForgeNetworkExecutionOutcomeStatus::RepairRequired,
        ),
        duplicate_noop_count: outcome_count(
            &records,
            ForgeNetworkExecutionOutcomeStatus::DuplicateNoop,
        ),
        persistence_blocked_count: records
            .iter()
            .filter(|record| {
                record.persistence_status == ForgeNetworkExecutionOutcomePersistenceStatus::Blocked
            })
            .count(),
        blocker_count: records
            .iter()
            .map(|record| record.request_receipt_blockers.len() + record.persistence_blockers.len())
            .sum(),
        evidence_ref_count: records
            .iter()
            .map(|record| record.evidence_refs.len())
            .sum(),
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn forge_network_execution_outcome_control_dto_from_diagnostics(
    diagnostics: ForgeNetworkExecutionOutcomeDiagnosticsRecord,
) -> ForgeNetworkExecutionOutcomeControlDto {
    ForgeNetworkExecutionOutcomeControlDto {
        dto_id: "forge-network-execution-outcome-control-dto".to_owned(),
        diagnostics_id: diagnostics.diagnostics_id,
        outcome_count: diagnostics.outcome_count,
        stopped_recorded_count: diagnostics.stopped_recorded_count,
        failed_count: diagnostics.failed_count,
        blocked_count: diagnostics.blocked_count,
        repair_required_count: diagnostics.repair_required_count,
        duplicate_noop_count: diagnostics.duplicate_noop_count,
        persistence_blocked_count: diagnostics.persistence_blocked_count,
        blocker_count: diagnostics.blocker_count,
        evidence_ref_count: diagnostics.evidence_ref_count,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn outcome_count(
    records: &[ForgeNetworkExecutionOutcomePersistenceRecord],
    status: ForgeNetworkExecutionOutcomeStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.outcome_status == status)
        .count()
}
