use super::super::status_check_smoke_types::{
    ProviderLiveReadStatusCheckSmokeChecklistRecord,
    ProviderLiveReadStatusCheckSmokeChecklistStatus, ProviderLiveReadStatusCheckSmokeDiagnostics,
    ProviderLiveReadStatusCheckSmokeRequestRecord, ProviderLiveReadStatusCheckSmokeRequestStatus,
    ProviderLiveReadStatusCheckSmokeTargetRecord, ProviderLiveReadStatusCheckSmokeTargetStatus,
};

pub fn provider_live_read_status_check_smoke_diagnostics(
    targets: Vec<ProviderLiveReadStatusCheckSmokeTargetRecord>,
    checklists: Vec<ProviderLiveReadStatusCheckSmokeChecklistRecord>,
    requests: Vec<ProviderLiveReadStatusCheckSmokeRequestRecord>,
) -> ProviderLiveReadStatusCheckSmokeDiagnostics {
    ProviderLiveReadStatusCheckSmokeDiagnostics {
        diagnostics_id: "provider-live-read-status-check-smoke-diagnostics".to_owned(),
        target_count: targets.len(),
        selected_target_count: targets
            .iter()
            .filter(|record| record.status == ProviderLiveReadStatusCheckSmokeTargetStatus::Selected)
            .count(),
        checklist_count: checklists.len(),
        approval_required_count: checklists
            .iter()
            .filter(|record| {
                record.status == ProviderLiveReadStatusCheckSmokeChecklistStatus::ApprovalRequired
            })
            .count()
            + requests
                .iter()
                .filter(|record| {
                    record.status == ProviderLiveReadStatusCheckSmokeRequestStatus::ApprovalRequired
                })
                .count(),
        stopped_request_count: requests
            .iter()
            .filter(|record| {
                record.status
                    == ProviderLiveReadStatusCheckSmokeRequestStatus::StoppedPendingExplicitExecution
            })
            .count(),
        blocked_count: targets
            .iter()
            .filter(|record| record.status == ProviderLiveReadStatusCheckSmokeTargetStatus::Blocked)
            .count()
            + checklists
                .iter()
                .filter(|record| {
                    record.status == ProviderLiveReadStatusCheckSmokeChecklistStatus::Blocked
                })
                .count()
            + requests
                .iter()
                .filter(|record| {
                    record.status == ProviderLiveReadStatusCheckSmokeRequestStatus::Blocked
                })
                .count(),
        blocker_count: targets
            .iter()
            .map(|record| record.blockers.len())
            .sum::<usize>()
            + checklists
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>()
            + requests
                .iter()
                .map(|record| record.blockers.len())
                .sum::<usize>(),
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}
