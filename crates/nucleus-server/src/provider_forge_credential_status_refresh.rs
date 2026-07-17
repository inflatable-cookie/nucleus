//! Stopped provider credential-status refresh records and control DTOs.

mod record_builder;
mod types;

pub use types::{
    ForgeCredentialStatusClass, ForgeCredentialStatusRefreshBlocker,
    ForgeCredentialStatusRefreshControlDto, ForgeCredentialStatusRefreshInput,
    ForgeCredentialStatusRefreshRecord, ForgeCredentialStatusRefreshSet,
    ForgeCredentialStatusRefreshStatus,
};

use crate::provider_no_effects::ProviderRuntimeNoEffects;
use record_builder::refresh_record;

pub fn forge_credential_status_refresh(
    input: ForgeCredentialStatusRefreshInput,
) -> ForgeCredentialStatusRefreshSet {
    let mut records = input
        .credential_refs
        .iter()
        .cloned()
        .map(|credential_ref| refresh_record(&input, credential_ref))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.refresh_id.cmp(&right.refresh_id));

    ForgeCredentialStatusRefreshSet {
        refresh_set_id: "forge-credential-status-refresh".to_owned(),
        skipped_credential_ref_ids: records
            .iter()
            .filter(|record| {
                record.status != ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh
            })
            .map(|record| record.credential_ref_id.clone())
            .collect(),
        stopped_refresh_recorded: records.iter().any(|record| record.stopped_refresh_recorded),
        records,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

pub fn forge_credential_status_refresh_control_dto(
    set: &ForgeCredentialStatusRefreshSet,
) -> ForgeCredentialStatusRefreshControlDto {
    ForgeCredentialStatusRefreshControlDto {
        dto_id: "forge-credential-status-refresh-control-dto".to_owned(),
        refresh_set_id: set.refresh_set_id.clone(),
        refresh_count: set.records.len(),
        ready_count: status_count(
            set,
            ForgeCredentialStatusRefreshStatus::ReadyForStoppedRefresh,
        ),
        repair_required_count: status_count(
            set,
            ForgeCredentialStatusRefreshStatus::RepairRequired,
        ),
        blocked_count: status_count(set, ForgeCredentialStatusRefreshStatus::Blocked),
        ready_credential_count: class_count(set, ForgeCredentialStatusClass::Ready),
        repair_credential_count: class_count(set, ForgeCredentialStatusClass::RequiresRepair),
        unknown_credential_count: class_count(set, ForgeCredentialStatusClass::Unknown),
        unsupported_credential_count: class_count(set, ForgeCredentialStatusClass::Unsupported),
        blocker_count: set.records.iter().map(|record| record.blockers.len()).sum(),
        skipped_credential_ref_count: set.skipped_credential_ref_ids.len(),
        stopped_refresh_recorded: set.stopped_refresh_recorded,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

fn status_count(
    set: &ForgeCredentialStatusRefreshSet,
    status: ForgeCredentialStatusRefreshStatus,
) -> usize {
    set.records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

fn class_count(set: &ForgeCredentialStatusRefreshSet, class: ForgeCredentialStatusClass) -> usize {
    set.records
        .iter()
        .filter(|record| record.status_class == class)
        .count()
}

#[cfg(test)]
mod tests;
