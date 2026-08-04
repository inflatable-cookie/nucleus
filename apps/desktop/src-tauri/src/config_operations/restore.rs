use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use longhorn_config::{
    inspect_backup_archive, BackupAdapterStateEvidence, BackupArchiveLimits,
    RestoreAdapterGroupReceiptEntry, RestoreAdapterGroupRecoveryOutcome, Sha256Digest,
};
use serde::{Deserialize, Serialize};

use crate::desktop_profile::DesktopProfile;

use self::state::*;
use super::backup_domains::{self, BackupSources};

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) mod commands;
mod state;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreBootReceipt {
    pub outcome: RestoreBootOutcome,
    pub recovery: RestoreBootRecovery,
    pub archive_sha256: Option<String>,
    pub entries: Vec<RestoreBootDomainReceipt>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreBootDomainReceipt {
    pub domain: String,
    pub target_evidence: BackupAdapterStateEvidence,
    pub rollback_evidence: BackupAdapterStateEvidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RestoreBootOutcome {
    NoRequest,
    Committed,
    RejectedOrRolledBack,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RestoreBootRecovery {
    None,
    RolledBack,
    TerminalCleanup,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PreparedRestoreSelection {
    pub request_id: String,
    pub archive_path: PathBuf,
    pub archive_sha256: String,
    pub domains: Vec<String>,
    pub confirmation_digest: String,
}

pub(super) fn sources(profile: &DesktopProfile) -> BackupSources {
    let roots = profile.storage_roots();
    let workspace = profile.workspace_ui_paths();
    BackupSources {
        database: profile.database_path(),
        preferences: roots.config().join("preferences/nucleus.json"),
        keymap: roots.config().join("commands/keymap.json"),
        project_layouts: workspace.project_layouts().to_path_buf(),
        panel_presentations: workspace.panel_presentations().to_path_buf(),
        window_placement: workspace.window_placement().to_path_buf(),
        notifications: roots.state().join("notifications.json"),
    }
}

/// Binds an exact archive and grouped confirmation into a durable restart request.
///
/// The caller may request process restart only after this returns successfully.
pub(super) fn prepare_selection(
    profile: &DesktopProfile,
    archive_path: &Path,
) -> Result<PreparedRestoreSelection, String> {
    if !archive_path.is_absolute() {
        return Err("restore archive path must be absolute".to_owned());
    }
    let bytes = read_archive(archive_path)?;
    let archive = inspect_backup_archive(&bytes, BackupArchiveLimits::default())
        .map_err(|error| format!("inspect restore archive failed: {error}"))?;
    let preparation = backup_domains::prepare_grouped_restore(
        profile.storage_roots(),
        &sources(profile),
        &archive,
    )?;
    Ok(PreparedRestoreSelection {
        request_id: format!(
            "nucleus-restore-{}-{}",
            std::process::id(),
            REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        archive_path: archive_path.to_path_buf(),
        archive_sha256: preparation.archive_sha256.as_str().to_owned(),
        domains: preparation
            .domains
            .iter()
            .map(|domain| domain.as_str().to_owned())
            .collect(),
        confirmation_digest: preparation.confirmation_digest.as_str().to_owned(),
    })
}

pub(super) fn schedule_selection(
    profile: &DesktopProfile,
    selection: &PreparedRestoreSelection,
) -> Result<(), String> {
    let fresh = prepare_selection(profile, &selection.archive_path)?;
    if fresh.archive_sha256 != selection.archive_sha256
        || fresh.domains != selection.domains
        || fresh.confirmation_digest != selection.confirmation_digest
    {
        return Err("restore evidence changed after operator review".to_owned());
    }
    write_json(
        &request_path(profile),
        &PendingRestoreRequest {
            schema_version: REQUEST_SCHEMA_VERSION,
            layout_digest: profile.layout_digest().to_owned(),
            archive_path: selection.archive_path.clone(),
            archive_sha256: selection.archive_sha256.clone(),
            domains: selection.domains.clone(),
            confirmation_digest: selection.confirmation_digest.clone(),
        },
    )
}

/// Recovers any interrupted group and executes one pending restore before product
/// authorities open.
pub(crate) fn run_before_authorities(
    profile: &DesktopProfile,
) -> Result<RestoreBootReceipt, String> {
    let sources = sources(profile);
    let recovery_receipt =
        backup_domains::recover_grouped_restore(profile.storage_roots(), &sources)
            .map_err(|error| format!("boot restore recovery failed: {error}"))?;
    let recovery_entries = project_entries(recovery_receipt.entries());
    let recovery = match recovery_receipt.outcome() {
        RestoreAdapterGroupRecoveryOutcome::NoRecoveryNeeded => RestoreBootRecovery::None,
        RestoreAdapterGroupRecoveryOutcome::RolledBack => RestoreBootRecovery::RolledBack,
        RestoreAdapterGroupRecoveryOutcome::TerminalCleanup => RestoreBootRecovery::TerminalCleanup,
    };

    let request_path = request_path(profile);
    let Some(request) = read_request(&request_path)? else {
        let receipt = RestoreBootReceipt {
            outcome: RestoreBootOutcome::NoRequest,
            recovery,
            archive_sha256: None,
            entries: recovery_entries,
            detail: None,
        };
        if recovery != RestoreBootRecovery::None {
            write_json(&receipt_path(profile), &receipt)?;
        }
        return Ok(receipt);
    };

    let result = execute_request(profile, &sources, &request);
    let receipt = match result {
        Ok(entries) => RestoreBootReceipt {
            outcome: RestoreBootOutcome::Committed,
            recovery,
            archive_sha256: Some(request.archive_sha256.clone()),
            entries,
            detail: None,
        },
        Err(detail) => {
            let terminal_recovery =
                backup_domains::recover_grouped_restore(profile.storage_roots(), &sources)
                    .map_err(|recovery_error| {
                        format!(
                    "boot restore failed ({detail}); terminal recovery failed: {recovery_error}"
                )
                    })?;
            let terminal_entries = project_entries(terminal_recovery.entries());
            let recovery = match terminal_recovery.outcome() {
                RestoreAdapterGroupRecoveryOutcome::NoRecoveryNeeded => recovery,
                RestoreAdapterGroupRecoveryOutcome::RolledBack => RestoreBootRecovery::RolledBack,
                RestoreAdapterGroupRecoveryOutcome::TerminalCleanup => {
                    RestoreBootRecovery::TerminalCleanup
                }
            };
            RestoreBootReceipt {
                outcome: RestoreBootOutcome::RejectedOrRolledBack,
                recovery,
                archive_sha256: Some(request.archive_sha256.clone()),
                entries: if terminal_entries.is_empty() {
                    recovery_entries
                } else {
                    terminal_entries
                },
                detail: Some(detail),
            }
        }
    };
    write_json(&receipt_path(profile), &receipt)?;
    remove_durable(&request_path)?;
    Ok(receipt)
}

fn execute_request(
    profile: &DesktopProfile,
    sources: &BackupSources,
    request: &PendingRestoreRequest,
) -> Result<Vec<RestoreBootDomainReceipt>, String> {
    if request.schema_version != REQUEST_SCHEMA_VERSION {
        return Err("pending restore request schema is unsupported".to_owned());
    }
    if request.layout_digest != profile.layout_digest() {
        return Err("pending restore storage layout changed before restart".to_owned());
    }
    let bytes = read_archive(&request.archive_path)?;
    let archive = inspect_backup_archive(&bytes, BackupArchiveLimits::default())
        .map_err(|error| format!("reinspect restore archive failed: {error}"))?;
    if archive.archive_sha256().as_str() != request.archive_sha256 {
        return Err("pending restore archive changed before restart".to_owned());
    }
    let preparation =
        backup_domains::prepare_grouped_restore(profile.storage_roots(), sources, &archive)?;
    let domains = preparation
        .domains
        .iter()
        .map(|domain| domain.as_str().to_owned())
        .collect::<Vec<_>>();
    if domains != request.domains {
        return Err("pending restore domain set changed before restart".to_owned());
    }
    if preparation.confirmation_digest.as_str() != request.confirmation_digest {
        return Err("pending restore confirmation changed before restart".to_owned());
    }
    let confirmation = Sha256Digest::new(&request.confirmation_digest)
        .map_err(|error| format!("pending restore confirmation is invalid: {error}"))?;
    let receipt = backup_domains::execute_grouped_restore(
        profile.storage_roots(),
        sources,
        &archive,
        &confirmation,
    )?;
    Ok(project_entries(receipt.entries()))
}

fn project_entries(entries: &[RestoreAdapterGroupReceiptEntry]) -> Vec<RestoreBootDomainReceipt> {
    entries
        .iter()
        .map(|entry| RestoreBootDomainReceipt {
            domain: entry.domain().as_str().to_owned(),
            target_evidence: entry.target_evidence().clone(),
            rollback_evidence: entry.rollback_evidence().clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests;
