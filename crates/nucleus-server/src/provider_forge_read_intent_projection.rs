//! Generic projection for stopped provider read-intent records.

mod entry_builder;
mod status_mapper;
mod types;

pub use types::{
    ForgeReadIntentProjectionControlDto, ForgeReadIntentProjectionEntry,
    ForgeReadIntentProjectionFamily, ForgeReadIntentProjectionInput, ForgeReadIntentProjectionSet,
    ForgeReadIntentProjectionStatus,
};

use entry_builder::{
    credential_entry, pull_request_entry, repository_metadata_entry, status_check_entry,
};

pub fn forge_read_intent_projection(
    input: ForgeReadIntentProjectionInput,
) -> ForgeReadIntentProjectionSet {
    let mut entries = Vec::new();
    entries.extend(
        input
            .credential_status_records
            .into_iter()
            .map(credential_entry),
    );
    entries.extend(
        input
            .repository_metadata_records
            .into_iter()
            .map(repository_metadata_entry),
    );
    entries.extend(
        input
            .pull_request_records
            .into_iter()
            .map(pull_request_entry),
    );
    entries.extend(
        input
            .status_check_records
            .into_iter()
            .map(status_check_entry),
    );
    entries.sort_by(|left, right| left.intent_id.cmp(&right.intent_id));

    ForgeReadIntentProjectionSet {
        projection_id: "forge-read-intent-projection".to_owned(),
        total_count: entries.len(),
        credential_status_count: family_count(
            &entries,
            ForgeReadIntentProjectionFamily::CredentialStatus,
        ),
        repository_metadata_count: family_count(
            &entries,
            ForgeReadIntentProjectionFamily::RepositoryMetadata,
        ),
        pull_request_count: family_count(&entries, ForgeReadIntentProjectionFamily::PullRequest),
        status_check_count: family_count(&entries, ForgeReadIntentProjectionFamily::StatusCheck),
        ready_count: status_count(&entries, ForgeReadIntentProjectionStatus::Ready),
        duplicate_noop_count: status_count(
            &entries,
            ForgeReadIntentProjectionStatus::DuplicateNoop,
        ),
        blocked_count: status_count(&entries, ForgeReadIntentProjectionStatus::Blocked),
        repair_required_count: status_count(
            &entries,
            ForgeReadIntentProjectionStatus::RepairRequired,
        ),
        blocker_count: entries.iter().map(|entry| entry.blocker_count).sum(),
        evidence_ref_count: entries.iter().map(|entry| entry.evidence_ref_count).sum(),
        entries,
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

pub fn forge_read_intent_projection_control_dto(
    set: &ForgeReadIntentProjectionSet,
) -> ForgeReadIntentProjectionControlDto {
    ForgeReadIntentProjectionControlDto {
        dto_id: "forge-read-intent-projection-control-dto".to_owned(),
        projection_id: set.projection_id.clone(),
        total_count: set.total_count,
        credential_status_count: set.credential_status_count,
        repository_metadata_count: set.repository_metadata_count,
        pull_request_count: set.pull_request_count,
        status_check_count: set.status_check_count,
        ready_count: set.ready_count,
        duplicate_noop_count: set.duplicate_noop_count,
        blocked_count: set.blocked_count,
        repair_required_count: set.repair_required_count,
        blocker_count: set.blocker_count,
        evidence_ref_count: set.evidence_ref_count,
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

fn family_count(
    entries: &[ForgeReadIntentProjectionEntry],
    family: ForgeReadIntentProjectionFamily,
) -> usize {
    entries
        .iter()
        .filter(|entry| entry.family == family)
        .count()
}

fn status_count(
    entries: &[ForgeReadIntentProjectionEntry],
    status: ForgeReadIntentProjectionStatus,
) -> usize {
    entries
        .iter()
        .filter(|entry| entry.status == status)
        .count()
}

#[cfg(test)]
mod tests;
