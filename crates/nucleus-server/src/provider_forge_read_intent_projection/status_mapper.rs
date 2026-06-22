use crate::{
    ForgeCredentialStatusRefreshPersistenceRecord, ForgeCredentialStatusRefreshPersistenceStatus,
    ForgePullRequestRefreshPersistenceRecord, ForgePullRequestRefreshPersistenceStatus,
    ForgeRepositoryMetadataRefreshPersistenceRecord,
    ForgeRepositoryMetadataRefreshPersistenceStatus, ForgeStatusCheckRefreshPersistenceRecord,
    ForgeStatusCheckRefreshPersistenceStatus,
};

use super::types::ForgeReadIntentProjectionStatus;

pub(super) fn credential_status(
    record: &ForgeCredentialStatusRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionStatus {
    match record.persistence_status {
        ForgeCredentialStatusRefreshPersistenceStatus::Persisted => {
            status_for_refresh_blockers(record.refresh_blockers.is_empty())
        }
        ForgeCredentialStatusRefreshPersistenceStatus::DuplicateNoop => {
            ForgeReadIntentProjectionStatus::DuplicateNoop
        }
        ForgeCredentialStatusRefreshPersistenceStatus::Blocked => {
            ForgeReadIntentProjectionStatus::Blocked
        }
    }
}

pub(super) fn repository_metadata_status(
    record: &ForgeRepositoryMetadataRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionStatus {
    match record.persistence_status {
        ForgeRepositoryMetadataRefreshPersistenceStatus::Persisted => {
            status_for_refresh_blockers(record.refresh_blockers.is_empty())
        }
        ForgeRepositoryMetadataRefreshPersistenceStatus::DuplicateNoop => {
            ForgeReadIntentProjectionStatus::DuplicateNoop
        }
        ForgeRepositoryMetadataRefreshPersistenceStatus::Blocked => {
            ForgeReadIntentProjectionStatus::Blocked
        }
    }
}

pub(super) fn pull_request_status(
    record: &ForgePullRequestRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionStatus {
    match record.persistence_status {
        ForgePullRequestRefreshPersistenceStatus::Persisted => {
            status_for_refresh_blockers(record.refresh_blockers.is_empty())
        }
        ForgePullRequestRefreshPersistenceStatus::DuplicateNoop => {
            ForgeReadIntentProjectionStatus::DuplicateNoop
        }
        ForgePullRequestRefreshPersistenceStatus::Blocked => {
            ForgeReadIntentProjectionStatus::Blocked
        }
    }
}

pub(super) fn status_check_status(
    record: &ForgeStatusCheckRefreshPersistenceRecord,
) -> ForgeReadIntentProjectionStatus {
    match record.persistence_status {
        ForgeStatusCheckRefreshPersistenceStatus::Persisted => {
            status_for_refresh_blockers(record.refresh_blockers.is_empty())
        }
        ForgeStatusCheckRefreshPersistenceStatus::DuplicateNoop => {
            ForgeReadIntentProjectionStatus::DuplicateNoop
        }
        ForgeStatusCheckRefreshPersistenceStatus::Blocked => {
            ForgeReadIntentProjectionStatus::Blocked
        }
    }
}

fn status_for_refresh_blockers(no_refresh_blockers: bool) -> ForgeReadIntentProjectionStatus {
    if no_refresh_blockers {
        ForgeReadIntentProjectionStatus::Ready
    } else {
        ForgeReadIntentProjectionStatus::RepairRequired
    }
}
