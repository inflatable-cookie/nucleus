//! Stopped admission records for forge provider network execution.

mod record_builder;
mod types;

pub use types::{
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionAdmissionBlocker,
    ForgeNetworkExecutionAdmissionInput, ForgeNetworkExecutionAdmissionRecord,
    ForgeNetworkExecutionAdmissionSet, ForgeNetworkExecutionAdmissionStatus,
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
};

use record_builder::admission_record;

pub fn forge_network_execution_admission(
    input: ForgeNetworkExecutionAdmissionInput,
) -> ForgeNetworkExecutionAdmissionSet {
    let mut admissions = input
        .request_set
        .requests
        .iter()
        .cloned()
        .map(|request| admission_record(&input, request))
        .collect::<Vec<_>>();
    admissions.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));
    let stopped_preflight_permitted = admissions
        .iter()
        .any(|admission| admission.stopped_preflight_permitted);

    ForgeNetworkExecutionAdmissionSet {
        admission_set_id: "forge-network-execution-admission".to_owned(),
        skipped_request_adapter_ids: admissions
            .iter()
            .filter(|admission| {
                admission.status != ForgeNetworkExecutionAdmissionStatus::ReadyForStoppedPreflight
            })
            .map(|admission| admission.request_adapter_id.clone())
            .collect(),
        admissions,
        stopped_preflight_permitted,
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

#[cfg(test)]
mod tests;
