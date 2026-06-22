use crate::ForgeNetworkExecutionOperationFamily;

use super::super::executor_types::{
    ProviderLiveReadGhCommandDescriptorBlocker, ProviderLiveReadGhCommandDescriptorRecord,
    ProviderLiveReadGhCommandDescriptorStatus, ProviderLiveReadServerRequestRecord,
    ProviderLiveReadServerRequestStatus,
};

const GH_REPO_VIEW_FIELDS: &[&str] = &[
    "nameWithOwner",
    "defaultBranchRef",
    "isPrivate",
    "visibility",
    "url",
    "viewerPermission",
    "pushedAt",
    "updatedAt",
];

const SANITIZED_REPOSITORY_METADATA_FIELDS: &[&str] = &[
    "name_with_owner",
    "default_branch",
    "is_private",
    "visibility",
    "url",
    "viewer_permission",
    "pushed_at",
    "updated_at",
];

pub fn provider_live_read_gh_repo_view_descriptor(
    request: &ProviderLiveReadServerRequestRecord,
) -> ProviderLiveReadGhCommandDescriptorRecord {
    let blockers = command_descriptor_blockers(request);
    let status = if blockers.is_empty() {
        ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn
    } else {
        ProviderLiveReadGhCommandDescriptorStatus::Blocked
    };
    let remote_repo_ref = request.remote_repo_ref.clone().unwrap_or_default();
    let json_fields = GH_REPO_VIEW_FIELDS
        .iter()
        .map(|field| (*field).to_owned())
        .collect::<Vec<_>>();

    ProviderLiveReadGhCommandDescriptorRecord {
        command_descriptor_id: format!(
            "provider-live-read-gh-repo-view:{}",
            request.executor_request_id
        ),
        executor_request_id: request.executor_request_id.clone(),
        remote_repo_ref: remote_repo_ref.clone(),
        executable: "gh".to_owned(),
        args: vec![
            "repo".to_owned(),
            "view".to_owned(),
            remote_repo_ref,
            "--json".to_owned(),
            GH_REPO_VIEW_FIELDS.join(","),
        ],
        json_fields,
        expected_sanitized_fields: SANITIZED_REPOSITORY_METADATA_FIELDS
            .iter()
            .map(|field| (*field).to_owned())
            .collect(),
        status,
        blockers,
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn command_descriptor_blockers(
    request: &ProviderLiveReadServerRequestRecord,
) -> Vec<ProviderLiveReadGhCommandDescriptorBlocker> {
    let mut blockers = Vec::new();
    if request.status != ProviderLiveReadServerRequestStatus::ReadyForCommandDescriptor {
        blockers.push(ProviderLiveReadGhCommandDescriptorBlocker::ExecutorRequestNotReady);
    }
    if request.remote_repo_ref.is_none() {
        blockers.push(ProviderLiveReadGhCommandDescriptorBlocker::MissingRemoteRepoRef);
    }
    if request.operation_family != ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh {
        blockers.push(ProviderLiveReadGhCommandDescriptorBlocker::UnsupportedOperationFamily);
    }
    blockers
}
