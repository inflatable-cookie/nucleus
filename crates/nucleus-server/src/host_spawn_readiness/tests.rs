use nucleus_command_policy::CommandProcessSupervisionEventKind;

use super::fixtures::{ready_input, sandbox_backend};
use super::{evaluate_host_spawn_readiness, HostSpawnReadinessBlocker, HostSpawnReadinessStatus};
use crate::{
    ArtifactStoreBackendKind, ProcessControlBackendKind, ProcessEventTransportBackendKind,
    SandboxBackendKind,
};

#[test]
fn host_spawn_readiness_blocks_missing_sandbox_enforcement() {
    let mut sandbox_backend = sandbox_backend(SandboxBackendKind::AdvisoryOnly);
    sandbox_backend.enforcement = nucleus_command_policy::CommandSandboxEnforcement::AdvisoryOnly;
    let gate = evaluate_host_spawn_readiness(ready_input(sandbox_backend));

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert!(gate
        .blockers
        .contains(&HostSpawnReadinessBlocker::SandboxBackendNotReady(
            SandboxBackendKind::AdvisoryOnly
        )));
}

#[test]
fn host_spawn_readiness_can_name_ready_without_spawning() {
    let gate =
        evaluate_host_spawn_readiness(ready_input(sandbox_backend(SandboxBackendKind::OsSandbox)));

    assert_eq!(gate.status, HostSpawnReadinessStatus::Ready);
    assert!(gate.blockers.is_empty());
}

#[test]
fn host_spawn_readiness_blocks_missing_artifact_store() {
    let mut input = ready_input(sandbox_backend(SandboxBackendKind::OsSandbox));
    input.artifact_store_backend.payload_storage_ready = false;

    let gate = evaluate_host_spawn_readiness(input);

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert!(gate
        .blockers
        .contains(&HostSpawnReadinessBlocker::ArtifactStoreBackendNotReady(
            ArtifactStoreBackendKind::Filesystem
        )));
}

#[test]
fn host_spawn_readiness_blocks_missing_event_transport() {
    let mut input = ready_input(sandbox_backend(SandboxBackendKind::OsSandbox));
    input
        .event_transport_backend
        .supported_event_kinds
        .retain(|kind| kind != &CommandProcessSupervisionEventKind::CleanupFailed);

    let gate = evaluate_host_spawn_readiness(input);

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert!(gate
        .blockers
        .contains(&HostSpawnReadinessBlocker::EventTransportBackendNotReady(
            ProcessEventTransportBackendKind::InProcess
        )));
}

#[test]
fn host_spawn_readiness_blocks_missing_interruption_contract() {
    let mut input = ready_input(sandbox_backend(SandboxBackendKind::OsSandbox));
    input.interruption_contract = None;

    let gate = evaluate_host_spawn_readiness(input);

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert!(gate
        .blockers
        .contains(&HostSpawnReadinessBlocker::InterruptionContractMissing));
}

#[test]
fn host_spawn_readiness_blocks_missing_process_control() {
    let mut input = ready_input(sandbox_backend(SandboxBackendKind::OsSandbox));
    input.process_control_backend.cancellation_ready = false;

    let gate = evaluate_host_spawn_readiness(input);

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert!(gate
        .blockers
        .contains(&HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
            ProcessControlBackendKind::StdProcess
        )));
}

#[test]
fn host_spawn_readiness_preserves_combined_blocker_detail() {
    let mut sandbox_backend = sandbox_backend(SandboxBackendKind::AdvisoryOnly);
    sandbox_backend.enforcement = nucleus_command_policy::CommandSandboxEnforcement::AdvisoryOnly;
    let mut input = ready_input(sandbox_backend);
    input.artifact_store_backend.payload_storage_ready = false;
    input
        .event_transport_backend
        .supported_event_kinds
        .retain(|kind| kind != &CommandProcessSupervisionEventKind::Terminal);
    input.interruption_contract = None;
    input.process_control_backend.timeout_ready = false;

    let gate = evaluate_host_spawn_readiness(input);

    assert_eq!(gate.status, HostSpawnReadinessStatus::Blocked);
    assert_eq!(
        gate.blockers,
        vec![
            HostSpawnReadinessBlocker::SandboxBackendNotReady(SandboxBackendKind::AdvisoryOnly),
            HostSpawnReadinessBlocker::ArtifactStoreBackendNotReady(
                ArtifactStoreBackendKind::Filesystem
            ),
            HostSpawnReadinessBlocker::EventTransportBackendNotReady(
                ProcessEventTransportBackendKind::InProcess
            ),
            HostSpawnReadinessBlocker::InterruptionContractMissing,
            HostSpawnReadinessBlocker::ProcessControlBackendNotReady(
                ProcessControlBackendKind::StdProcess
            ),
        ]
    );
}
