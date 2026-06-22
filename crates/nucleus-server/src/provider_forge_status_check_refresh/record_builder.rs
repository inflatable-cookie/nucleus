use super::blockers::{blockers, status};
use super::types::{
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshRecord, ForgeStatusCheckRefreshStatus,
};
use crate::ForgeNetworkExecutionOperationFamily;

pub(super) fn refresh_record(
    input: &ForgeStatusCheckRefreshInput,
    provider_context_ref: String,
) -> ForgeStatusCheckRefreshRecord {
    let blockers = blockers(input, &provider_context_ref);
    let status = status(&blockers);

    ForgeStatusCheckRefreshRecord {
        refresh_id: format!("forge-status-check-refresh:{provider_context_ref}"),
        provider_context_ref,
        provider_instance_ref: input.provider_instance_ref.clone(),
        forge_provider: input.forge_provider.clone(),
        remote_repo_ref: input.remote_repo_ref.clone(),
        refresh_scope: input.refresh_scope.clone(),
        operation_family: ForgeNetworkExecutionOperationFamily::StatusCheckRefresh,
        credential_status_evidence_ref: input.credential_status_evidence_ref.clone(),
        repository_metadata_evidence_ref: input.repository_metadata_evidence_ref.clone(),
        status_check_refresh_evidence_ref: input.status_check_refresh_evidence_ref.clone(),
        sanitization_policy_ref: input.sanitization_policy_ref.clone(),
        stopped_refresh_recorded: status == ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh,
        status,
        blockers,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}
