use serde_json::Value;

use super::super::executor_types::{
    ProviderLiveReadGhCommandDescriptorRecord, ProviderLiveReadGhCommandDescriptorStatus,
    ProviderLiveReadRepositoryMetadataParseBlocker,
    ProviderLiveReadSanitizedRepositoryMetadataRecord,
    ProviderLiveReadSanitizedRepositoryMetadataStatus,
};

pub fn provider_live_read_sanitized_repository_metadata_output(
    descriptor: &ProviderLiveReadGhCommandDescriptorRecord,
    provider_stdout_json: &str,
) -> ProviderLiveReadSanitizedRepositoryMetadataRecord {
    if descriptor.status != ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn {
        return blocked_output(descriptor);
    }

    let parsed = serde_json::from_str::<Value>(provider_stdout_json);
    let (value, mut blockers) = match parsed {
        Ok(value) => (Some(value), Vec::new()),
        Err(_) => (
            None,
            vec![ProviderLiveReadRepositoryMetadataParseBlocker::JsonParseFailed],
        ),
    };
    let name_with_owner = value
        .as_ref()
        .and_then(|value| string_field(value, "nameWithOwner"));
    if name_with_owner.is_none() && blockers.is_empty() {
        blockers.push(ProviderLiveReadRepositoryMetadataParseBlocker::MissingNameWithOwner);
    }
    let status = if blockers.is_empty() {
        ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized
    } else {
        ProviderLiveReadSanitizedRepositoryMetadataStatus::ParseError
    };

    ProviderLiveReadSanitizedRepositoryMetadataRecord {
        output_record_id: format!(
            "provider-live-read-sanitized-output:{}",
            descriptor.command_descriptor_id
        ),
        command_descriptor_id: descriptor.command_descriptor_id.clone(),
        executor_request_id: descriptor.executor_request_id.clone(),
        name_with_owner,
        default_branch: value
            .as_ref()
            .and_then(|value| nested_string_field(value, "defaultBranchRef", "name")),
        is_private: value
            .as_ref()
            .and_then(|value| value.get("isPrivate").and_then(Value::as_bool)),
        visibility: value
            .as_ref()
            .and_then(|value| string_field(value, "visibility")),
        url: value.as_ref().and_then(|value| string_field(value, "url")),
        viewer_permission: value
            .as_ref()
            .and_then(|value| string_field(value, "viewerPermission")),
        pushed_at: value
            .as_ref()
            .and_then(|value| string_field(value, "pushedAt")),
        updated_at: value
            .as_ref()
            .and_then(|value| string_field(value, "updatedAt")),
        status,
        blockers,
        provider_network_call_performed: true,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn blocked_output(
    descriptor: &ProviderLiveReadGhCommandDescriptorRecord,
) -> ProviderLiveReadSanitizedRepositoryMetadataRecord {
    ProviderLiveReadSanitizedRepositoryMetadataRecord {
        output_record_id: format!(
            "provider-live-read-sanitized-output:{}",
            descriptor.command_descriptor_id
        ),
        command_descriptor_id: descriptor.command_descriptor_id.clone(),
        executor_request_id: descriptor.executor_request_id.clone(),
        name_with_owner: None,
        default_branch: None,
        is_private: None,
        visibility: None,
        url: None,
        viewer_permission: None,
        pushed_at: None,
        updated_at: None,
        status: ProviderLiveReadSanitizedRepositoryMetadataStatus::Blocked,
        blockers: vec![ProviderLiveReadRepositoryMetadataParseBlocker::CommandDescriptorNotReady],
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn nested_string_field(value: &Value, outer: &str, inner: &str) -> Option<String> {
    value
        .get(outer)
        .and_then(|nested| nested.get(inner))
        .and_then(Value::as_str)
        .map(str::to_owned)
}
