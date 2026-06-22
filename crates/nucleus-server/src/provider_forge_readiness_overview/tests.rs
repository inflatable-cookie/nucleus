use super::*;
use crate::{
    forge_read_intent_projection, ForgeCredentialStatusRefreshPersistenceStatus,
    ForgeNetworkExecutionOperationFamily, ForgePullRequestRefreshPersistenceStatus,
    ForgeReadIntentProjectionFamily, ForgeReadIntentProjectionInput,
    ForgeRepositoryMetadataRefreshBlocker, ForgeRepositoryMetadataRefreshPersistenceStatus,
    ForgeStatusCheckRefreshPersistenceStatus,
};

mod support {
    include!("../provider_forge_read_intent_projection/tests/support.rs");
}

use support::*;

#[test]
fn readiness_overview_reports_unknown_for_empty_evidence() {
    let overview = forge_readiness_overview(input(ForgeReadIntentProjectionInput {
        credential_status_records: Vec::new(),
        repository_metadata_records: Vec::new(),
        pull_request_records: Vec::new(),
        status_check_records: Vec::new(),
    }));

    assert_eq!(overview.status, ForgeReadinessOverviewStatus::Unknown);
    assert_eq!(overview.total_read_intent_count, 0);
    assert_eq!(overview.missing_evidence_family_count, 4);
    assert_eq!(overview.blocker_count, 4);
    assert!(!overview.provider_network_call_performed);
    assert!(!overview.credential_resolution_performed);
}

#[test]
fn readiness_overview_reports_ready_when_all_read_families_are_represented() {
    let overview = forge_readiness_overview(input(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential(
            "credential",
            ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        )],
        repository_metadata_records: vec![repository(
            "repo",
            ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted,
        )],
        pull_request_records: vec![pull_request(
            "pr",
            ForgePullRequestRefreshPersistenceStatus::Persisted,
        )],
        status_check_records: vec![status_check(
            "check",
            ForgeStatusCheckRefreshPersistenceStatus::Persisted,
        )],
    }));

    assert_eq!(overview.status, ForgeReadinessOverviewStatus::Ready);
    assert_eq!(overview.total_read_intent_count, 4);
    assert_eq!(overview.missing_evidence_family_count, 0);
    assert_eq!(overview.blocker_count, 0);
    assert_eq!(overview.evidence_ref_count, 4);
    assert_eq!(
        overview.represented_read_families,
        vec![
            ForgeReadIntentProjectionFamily::CredentialStatus,
            ForgeReadIntentProjectionFamily::RepositoryMetadata,
            ForgeReadIntentProjectionFamily::PullRequest,
            ForgeReadIntentProjectionFamily::StatusCheck,
        ]
    );
    assert_eq!(
        overview.provider_instance_refs,
        vec!["provider-instance:github:main".to_owned()]
    );
    assert_eq!(
        overview.remote_repo_refs,
        vec!["remote-repo:owner/name".to_owned()]
    );
}

#[test]
fn readiness_overview_reports_blocked_for_missing_read_family_evidence() {
    let overview = forge_readiness_overview(input(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential(
            "credential",
            ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        )],
        repository_metadata_records: Vec::new(),
        pull_request_records: Vec::new(),
        status_check_records: Vec::new(),
    }));

    assert_eq!(overview.status, ForgeReadinessOverviewStatus::Blocked);
    assert_eq!(overview.missing_evidence_family_count, 3);
    assert_eq!(overview.blocker_count, 3);
    assert_eq!(
        overview.represented_read_families,
        vec![ForgeReadIntentProjectionFamily::CredentialStatus]
    );
}

#[test]
fn readiness_overview_reports_repair_for_repair_required_evidence() {
    let mut repository_record = repository(
        "repo",
        ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted,
    );
    repository_record
        .refresh_blockers
        .push(ForgeRepositoryMetadataRefreshBlocker::MissingRemoteRepoRef);

    let overview = forge_readiness_overview(input(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential(
            "credential",
            ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        )],
        repository_metadata_records: vec![repository_record],
        pull_request_records: vec![pull_request(
            "pr",
            ForgePullRequestRefreshPersistenceStatus::Persisted,
        )],
        status_check_records: vec![status_check(
            "check",
            ForgeStatusCheckRefreshPersistenceStatus::Persisted,
        )],
    }));

    assert_eq!(overview.status, ForgeReadinessOverviewStatus::NeedsRepair);
    assert_eq!(overview.repair_required_count, 1);
    assert_eq!(overview.blocker_count, 1);
}

#[test]
fn readiness_overview_serializes_without_forbidden_provider_material() {
    let overview = forge_readiness_overview(input(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential(
            "credential",
            ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        )],
        repository_metadata_records: vec![repository(
            "repo",
            ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted,
        )],
        pull_request_records: vec![pull_request(
            "pr",
            ForgePullRequestRefreshPersistenceStatus::Persisted,
        )],
        status_check_records: vec![status_check(
            "check",
            ForgeStatusCheckRefreshPersistenceStatus::Persisted,
        )],
    }));
    let json = serde_json::to_string(&overview).expect("overview json");

    assert!(overview.represented_mutating_families.is_empty());
    assert!(!overview.provider_effect_executed);
    assert!(!overview.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn readiness_overview_keeps_mutating_families_represented_not_executed() {
    let mut projection = forge_read_intent_projection(ForgeReadIntentProjectionInput {
        credential_status_records: vec![credential(
            "credential",
            ForgeCredentialStatusRefreshPersistenceStatus::Persisted,
        )],
        repository_metadata_records: vec![repository(
            "repo",
            ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted,
        )],
        pull_request_records: vec![pull_request(
            "pr",
            ForgePullRequestRefreshPersistenceStatus::Persisted,
        )],
        status_check_records: vec![status_check(
            "check",
            ForgeStatusCheckRefreshPersistenceStatus::Persisted,
        )],
    });
    projection.entries[0].operation_family =
        ForgeNetworkExecutionOperationFamily::PullRequestCreate;

    let overview = forge_readiness_overview(ForgeReadinessOverviewInput {
        overview_id: "overview:mutating-family".to_owned(),
        project_ref: None,
        repo_ref: None,
        authority_host_ref: None,
        projection,
    });

    assert_eq!(
        overview.represented_mutating_families,
        vec![ForgeNetworkExecutionOperationFamily::PullRequestCreate]
    );
    assert!(!overview.provider_effect_executed);
    assert!(!overview.provider_network_call_performed);
}

fn input(projection_input: ForgeReadIntentProjectionInput) -> ForgeReadinessOverviewInput {
    ForgeReadinessOverviewInput {
        overview_id: "overview:provider-readiness".to_owned(),
        project_ref: Some("project:nucleus".to_owned()),
        repo_ref: Some("repo:nucleus".to_owned()),
        authority_host_ref: Some("host:local".to_owned()),
        projection: forge_read_intent_projection(projection_input),
    }
}
