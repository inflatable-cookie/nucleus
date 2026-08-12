//! Startup fixture seeding for the desktop managed state.
//!
//! Split from the state god file; behavior unchanged.

use std::path::Path;

use nucleus_command_policy::{
    CommandEvidence, CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention,
    CommandRequestId,
};
use nucleus_core::RevisionId;
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_server::{
    forge_credential_status_refresh, forge_pull_request_refresh,
    forge_repository_metadata_refresh, forge_status_check_refresh,
    persist_forge_credential_status_refreshes, persist_forge_pull_request_refreshes,
    persist_forge_repository_metadata_refreshes, persist_forge_status_check_refreshes,
    read_forge_credential_status_refreshes, read_forge_pull_request_refreshes,
    read_forge_repository_metadata_refreshes, read_forge_status_check_refreshes,
    seed_local_memory_proposal, seed_local_planning_session,
    seed_local_project_with_resource_root, seed_local_research_run_brief, seed_local_task,
    write_command_evidence, ForgeCredentialStatusRefreshInput,
    ForgeCredentialStatusRefreshPersistenceInput, ForgeNetworkCredentialKind,
    ForgeNetworkCredentialResolutionBoundary, ForgeNetworkCredentialStatus,
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ForgePullRequestRefreshInput,
    ForgePullRequestRefreshPersistenceInput, ForgePullRequestRefreshScope,
    ForgeRepositoryMetadataRefreshInput, ForgeRepositoryMetadataRefreshPersistenceInput,
    ForgeStatusCheckRefreshInput, ForgeStatusCheckRefreshPersistenceInput,
    ForgeStatusCheckRefreshScope,
};
use nucleus_server::LocalControlRequestHandler;

/// Seed local fixture state once while still applying bounded migrations to
/// an existing local project record.
pub(super) fn seed_fixture_state(
    handler: &LocalControlRequestHandler<SqliteBackend>,
    proof_fixture_root: Option<&Path>,
) -> Result<(), String> {
    let seed = nucleus_server::LocalProjectSeed::nucleus_local();
    let project_exists = handler
        .state()
        .projects()
        .get(&nucleus_core::PersistenceRecordId(seed.project_id.clone()))
        .map_err(|error| format!("startup storage probe failed: {error}"))?
        .is_some();
    seed_local_project_with_resource_root(
        handler.state(),
        seed,
        proof_fixture_root.map(Path::to_path_buf),
    )
    .map_err(|error| format!("startup seed failed at project: {error:?}"))?;
    if project_exists {
        return Ok(());
    }
    seed_local_task(
        handler.state(),
        nucleus_server::LocalTaskSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at task: {error:?}"))?;
    seed_local_command_evidence(handler.state())
        .map_err(|error| format!("startup seed failed at command evidence: {error:?}"))?;
    seed_local_provider_readiness_evidence(handler.state()).map_err(|error| {
        format!("startup seed failed at provider readiness evidence: {error:?}")
    })?;
    seed_local_planning_session(
        handler.state(),
        nucleus_server::LocalPlanningSessionSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at planning session: {error:?}"))?;
    seed_local_memory_proposal(
        handler.state(),
        nucleus_server::LocalMemoryProposalSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at memory proposal: {error:?}"))?;
    seed_local_research_run_brief(
        handler.state(),
        nucleus_server::LocalResearchRunBriefSeed::nucleus_local_bootstrap(),
    )
    .map_err(|error| format!("startup seed failed at research run brief: {error:?}"))?;
    Ok(())
}

fn seed_local_command_evidence(
    state: &nucleus_server::ServerStateService<SqliteBackend>,
) -> nucleus_local_store::LocalStoreResult<nucleus_local_store::LocalStoreRecord> {
    write_command_evidence(
        state,
        &CommandEvidence {
            id: CommandEvidenceId("command:evidence:nucleus-local:bootstrap".to_owned()),
            request_id: CommandRequestId("command:request:nucleus-local:bootstrap".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("desktop bootstrap command evidence seed".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        },
        RevisionId("rev:command-evidence:nucleus-local:bootstrap".to_owned()),
        RevisionExpectation::Any,
    )
}

fn seed_local_provider_readiness_evidence(
    state: &nucleus_server::ServerStateService<SqliteBackend>,
) -> nucleus_local_store::LocalStoreResult<()> {
    let existing_credential_refresh_ids = read_forge_credential_status_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();
    let existing_repository_refresh_ids = read_forge_repository_metadata_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();
    let existing_pull_request_refresh_ids = read_forge_pull_request_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();
    let existing_status_check_refresh_ids = read_forge_status_check_refreshes(state)?
        .into_iter()
        .map(|record| record.persisted_refresh_id)
        .collect::<Vec<_>>();

    let credential_refresh_set =
        forge_credential_status_refresh(ForgeCredentialStatusRefreshInput {
            credential_refs: vec![ForgeNetworkExecutionCredentialRef {
                credential_ref_id: "credential:nucleus-local:github".to_owned(),
                credential_kind: ForgeNetworkCredentialKind::HostCredentialProvider,
                resolution_boundary:
                    ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
                status: ForgeNetworkCredentialStatus::Ready,
                allowed_operation_families: vec![
                    ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh,
                ],
            }],
            provider_context_ref: Some("provider-context:nucleus-local:github".to_owned()),
            status_refresh_evidence_ref: Some(
                "evidence:nucleus-local:credential-status".to_owned(),
            ),
            sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        });
    persist_forge_credential_status_refreshes(
        state,
        ForgeCredentialStatusRefreshPersistenceInput {
            refresh_set: credential_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:credential-status".to_owned()],
            existing_persisted_refresh_ids: existing_credential_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    let repository_refresh_set =
        forge_repository_metadata_refresh(ForgeRepositoryMetadataRefreshInput {
            provider_context_refs: vec!["provider-context:nucleus-local:github".to_owned()],
            provider_instance_ref: Some("provider-instance:nucleus-local:github".to_owned()),
            forge_provider: Some(ForgePullRequestProvider::GitHub),
            remote_repo_ref: Some("remote-repo:nucleus-local:github".to_owned()),
            credential_status_evidence_ref: Some(
                "evidence:nucleus-local:credential-status".to_owned(),
            ),
            repository_metadata_evidence_ref: Some(
                "evidence:nucleus-local:repository-metadata".to_owned(),
            ),
            sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        });
    persist_forge_repository_metadata_refreshes(
        state,
        ForgeRepositoryMetadataRefreshPersistenceInput {
            refresh_set: repository_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:repository-metadata".to_owned()],
            existing_persisted_refresh_ids: existing_repository_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    let pull_request_refresh_set = forge_pull_request_refresh(ForgePullRequestRefreshInput {
        provider_context_refs: vec!["provider-context:nucleus-local:github".to_owned()],
        provider_instance_ref: Some("provider-instance:nucleus-local:github".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:nucleus-local:github".to_owned()),
        refresh_scope: Some(ForgePullRequestRefreshScope::AllOpen),
        credential_status_evidence_ref: Some("evidence:nucleus-local:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some(
            "evidence:nucleus-local:repository-metadata".to_owned(),
        ),
        pull_request_refresh_evidence_ref: Some(
            "evidence:nucleus-local:pull-request-refresh".to_owned(),
        ),
        sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    });
    persist_forge_pull_request_refreshes(
        state,
        ForgePullRequestRefreshPersistenceInput {
            refresh_set: pull_request_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:pull-request-refresh".to_owned()],
            existing_persisted_refresh_ids: existing_pull_request_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    let status_check_refresh_set = forge_status_check_refresh(ForgeStatusCheckRefreshInput {
        provider_context_refs: vec!["provider-context:nucleus-local:github".to_owned()],
        provider_instance_ref: Some("provider-instance:nucleus-local:github".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:nucleus-local:github".to_owned()),
        refresh_scope: Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:nucleus-local:github:bootstrap".to_owned(),
        )),
        credential_status_evidence_ref: Some("evidence:nucleus-local:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some(
            "evidence:nucleus-local:repository-metadata".to_owned(),
        ),
        status_check_refresh_evidence_ref: Some(
            "evidence:nucleus-local:status-check-refresh".to_owned(),
        ),
        sanitization_policy_ref: Some("sanitize:nucleus-local:provider-readiness".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    });
    persist_forge_status_check_refreshes(
        state,
        ForgeStatusCheckRefreshPersistenceInput {
            refresh_set: status_check_refresh_set,
            evidence_refs: vec!["evidence:nucleus-local:status-check-refresh".to_owned()],
            existing_persisted_refresh_ids: existing_status_check_refresh_ids,
            credential_material_present: false,
            provider_payload_present: false,
            raw_provider_payload_retention_requested: false,
            real_credential_resolution_requested: false,
            provider_network_call_requested: false,
            callback_execution_requested: false,
            interruption_execution_requested: false,
            recovery_execution_requested: false,
            task_mutation_requested: false,
        },
    )?;

    Ok(())
}
