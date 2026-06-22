use super::*;
use crate::{
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily,
};

#[test]
fn forge_credential_status_refresh_records_stopped_status_refs() {
    let set = forge_credential_status_refresh(input(vec![credential(
        "credential:one",
        ForgeNetworkCredentialStatus::Ready,
    )]));

    assert_eq!(set.records.len(), 1);
    assert!(set.stopped_refresh_recorded);
    assert!(!set.credential_resolution_performed);
    assert!(!set.provider_network_call_performed);
    assert!(!set.raw_provider_payload_retained);

    let record = &set.records[0];
    assert_eq!(
        record.refresh_id,
        "forge-credential-status-refresh:credential:one"
    );
    assert_eq!(
        record.status,
        ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh
    );
    assert_eq!(record.status_class, ForgeCredentialStatusClass::Ready);
    assert_eq!(
        record.provider_context_ref.as_deref(),
        Some("provider-context:github:repo")
    );
    assert!(record.stopped_refresh_recorded);
    assert!(!record.credential_resolution_performed);
    assert!(!record.provider_network_call_performed);
}

#[test]
fn forge_credential_status_refresh_classifies_non_ready_credentials() {
    let set = forge_credential_status_refresh(input(vec![
        credential("credential:expired", ForgeNetworkCredentialStatus::Expired),
        credential(
            "credential:unsupported",
            ForgeNetworkCredentialStatus::Unsupported,
        ),
        credential("credential:unknown", ForgeNetworkCredentialStatus::Unknown),
    ]));
    let dto = forge_credential_status_refresh_control_dto(&set);

    assert_eq!(dto.refresh_count, 3);
    assert_eq!(dto.ready_count, 3);
    assert_eq!(dto.repair_credential_count, 1);
    assert_eq!(dto.unsupported_credential_count, 1);
    assert_eq!(dto.unknown_credential_count, 1);
    assert_eq!(dto.blocker_count, 0);
}

#[test]
fn forge_credential_status_refresh_blocks_missing_refs() {
    let mut input = input(vec![credential(
        "credential:missing-refs",
        ForgeNetworkCredentialStatus::Ready,
    )]);
    input.provider_context_ref = None;
    input.status_refresh_evidence_ref = None;
    input.sanitization_policy_ref = None;

    let set = forge_credential_status_refresh(input);

    assert!(!set.stopped_refresh_recorded);
    assert_eq!(
        set.skipped_credential_ref_ids,
        vec!["credential:missing-refs"]
    );
    assert_eq!(
        set.records[0].status,
        ForgeCredentialStatusRefreshStatus::RepairRequired
    );
    assert_eq!(set.records[0].blockers.len(), 3);
}

#[test]
fn forge_credential_status_refresh_blocks_real_effect_requests() {
    let mut input = input(vec![credential(
        "credential:blocked",
        ForgeNetworkCredentialStatus::Ready,
    )]);
    input.credential_material_present = true;
    input.provider_payload_present = true;
    input.raw_provider_payload_retention_requested = true;
    input.real_credential_resolution_requested = true;
    input.provider_network_call_requested = true;
    input.callback_execution_requested = true;
    input.interruption_execution_requested = true;
    input.recovery_execution_requested = true;
    input.task_mutation_requested = true;

    let set = forge_credential_status_refresh(input);

    assert!(!set.stopped_refresh_recorded);
    assert_eq!(
        set.records[0].status,
        ForgeCredentialStatusRefreshStatus::Blocked
    );
    assert_eq!(set.records[0].blockers.len(), 9);
    assert!(!set.records[0].credential_resolution_performed);
    assert!(!set.records[0].provider_network_call_performed);
    assert!(!set.records[0].task_mutation_executed);
    assert!(!set.records[0].raw_provider_payload_retained);
}

#[test]
fn forge_credential_status_refresh_control_dto_serializes_sanitized_counts() {
    let set = forge_credential_status_refresh(input(vec![
        credential("credential:one", ForgeNetworkCredentialStatus::Ready),
        credential(
            "credential:two",
            ForgeNetworkCredentialStatus::RequiresUserAction,
        ),
    ]));
    let dto = forge_credential_status_refresh_control_dto(&set);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert!(serialized.contains("forge-credential-status-refresh-control-dto"));
    assert!(!serialized.contains("token"));
    assert_eq!(dto.refresh_count, 2);
    assert_eq!(dto.ready_count, 2);
    assert_eq!(dto.ready_credential_count, 1);
    assert_eq!(dto.repair_credential_count, 1);
    assert!(!dto.credential_resolution_performed);
    assert!(!dto.provider_network_call_performed);
}

fn input(
    credential_refs: Vec<ForgeNetworkExecutionCredentialRef>,
) -> ForgeCredentialStatusRefreshInput {
    ForgeCredentialStatusRefreshInput {
        credential_refs,
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        status_refresh_evidence_ref: Some("evidence:credential-status".to_owned()),
        sanitization_policy_ref: Some("sanitize:credential-status".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    }
}

fn credential(
    id: &str,
    status: ForgeNetworkCredentialStatus,
) -> ForgeNetworkExecutionCredentialRef {
    ForgeNetworkExecutionCredentialRef {
        credential_ref_id: id.to_owned(),
        credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
        resolution_boundary: ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
        status,
        allowed_operation_families: vec![
            ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
        ],
    }
}
