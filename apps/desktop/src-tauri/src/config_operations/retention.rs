use std::{collections::BTreeSet, path::Path};

use longhorn_config::{
    apply_backup_retention, plan_backup_retention, BackupArchiveLimits, BackupOperationalListing,
    BackupRetentionPlan, BackupRetentionPolicy, Sha256Digest,
};
use longhorn_tauri_config::ConfigOperationsHostError;

use super::{NucleusConfigOperationsAuthority, MAX_SCAN_ENTRIES};

const KEEP_NEWEST: usize = 10;

pub(super) fn plan(
    listing: &BackupOperationalListing,
) -> Result<Option<(BackupRetentionPlan, Sha256Digest)>, ConfigOperationsHostError> {
    let Some(newest) = listing.candidates().first() else {
        return Ok(None);
    };
    let plan = plan_backup_retention(
        listing,
        BackupRetentionPolicy::new(KEEP_NEWEST, None, None, MAX_SCAN_ENTRIES)
            .map_err(NucleusConfigOperationsAuthority::operational)?,
        &BTreeSet::new(),
        newest.archive_sha256(),
    )
    .map_err(NucleusConfigOperationsAuthority::operational)?;
    let confirmation = confirmation(&plan);
    Ok(Some((plan, confirmation)))
}

pub(super) fn apply(plan: &BackupRetentionPlan) -> Result<Vec<String>, ConfigOperationsHostError> {
    let receipt = apply_backup_retention(plan, BackupArchiveLimits::default())
        .map_err(NucleusConfigOperationsAuthority::operational)?;
    receipt
        .deleted
        .into_iter()
        .map(|path| exact_path(&path))
        .collect()
}

fn confirmation(plan: &BackupRetentionPlan) -> Sha256Digest {
    let mut evidence = String::from("nucleus-backup-retention-v1\n");
    for deletion in plan.deletions() {
        evidence.push_str(&deletion.path.to_string_lossy());
        evidence.push('\n');
        evidence.push_str(deletion.archive_sha256.as_str());
        evidence.push('\n');
    }
    Sha256Digest::from_bytes(evidence.as_bytes())
}

fn exact_path(path: &Path) -> Result<String, ConfigOperationsHostError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        ConfigOperationsHostError::authority("configuration path is not valid UTF-8", false)
    })
}
