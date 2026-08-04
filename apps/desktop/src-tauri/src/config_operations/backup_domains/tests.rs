use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};

use longhorn_config::{
    inspect_backup_archive, RestoreAdapterGroupExecutionOptions, RestoreAdapterGroupRecoveryOutcome,
};
use tempfile::tempdir;

use super::*;
use crate::{config_operations::restore, desktop_profile::DesktopProfile};

mod support;

use support::*;

#[test]
fn grouped_absent_targets_delete_file_and_sqlite_at_boot() {
    let temp = tempdir().expect("tempdir");
    let profile =
        DesktopProfile::portable_for_test(&temp.path().join("profile")).expect("portable profile");
    profile.prepare().expect("prepare profile");
    let sources = restore::sources(&profile);
    write_generation(&sources, "target");
    fs::remove_file(&sources.preferences).expect("remove file target");
    remove_sqlite_files(&sources.database);
    capture(profile.storage_roots(), &sources, sequence(1)).expect("capture target");
    let archive_path = published_archive(&profile);
    write_generation(&sources, "current");

    let selection = restore::prepare_selection(&profile, &archive_path).expect("prepare selection");
    restore::schedule_selection(&profile, &selection).expect("schedule selection");
    let receipt = restore::run_before_authorities(&profile).expect("boot restore");

    assert_eq!(receipt.outcome, restore::RestoreBootOutcome::Committed);
    assert_eq!(receipt.entries.len(), 7);
    for domain in ["nucleus.database", "nucleus.preferences"] {
        let entry = receipt
            .entries
            .iter()
            .find(|entry| entry.domain == domain)
            .expect("absence receipt entry");
        assert_eq!(entry.target_evidence, BackupAdapterStateEvidence::Absent);
        assert!(matches!(
            entry.rollback_evidence,
            BackupAdapterStateEvidence::Present { .. }
        ));
    }
    assert!(!sources.preferences.exists());
    assert!(!sources.database.exists());
    assert!(!PathBuf::from(format!("{}-wal", sources.database.display())).exists());
    assert!(!PathBuf::from(format!("{}-shm", sources.database.display())).exists());
    assert_file_generation_except(&sources, "target", &[&sources.preferences]);
}

#[test]
fn boot_catalog_rolls_an_applied_domain_back_to_absence_after_interruption() {
    let temp = tempdir().expect("tempdir");
    let profile =
        DesktopProfile::portable_for_test(&temp.path().join("profile")).expect("portable profile");
    profile.prepare().expect("prepare profile");
    let sources = restore::sources(&profile);
    write_generation(&sources, "target");
    capture(profile.storage_roots(), &sources, sequence(1)).expect("capture target");
    let archive_path = published_archive(&profile);
    let archive_bytes = fs::read(archive_path).expect("archive bytes");
    let archive = inspect_backup_archive(&archive_bytes, BackupArchiveLimits::default())
        .expect("inspect archive");
    write_generation(&sources, "current");
    fs::remove_file(&sources.keymap).expect("remove rollback target");

    let domains = domains().expect("domains");
    let mut adapters = adapters(&sources).expect("adapters");
    adapters[5] = Box::new(PanicTargetAdapter::new(
        "nucleus-window-placement-v1",
        sources.window_placement.clone(),
    ));
    let coordination =
        CoordinationAuthority::new(profile.storage_roots().data()).expect("coordination");
    let mut store = ConfigStore::new(profile.storage_roots().clone(), coordination);
    let mut catalog = BackupCatalog::new();
    for (domain, adapter) in domains.iter().zip(adapters.iter()) {
        store.register(domain).expect("register domain");
        catalog
            .custom(domain, adapter.as_ref())
            .expect("register adapter");
    }
    let inspection = store.inspect_restore(
        &catalog,
        &archive,
        &application().expect("application"),
        &producer().expect("producer"),
    );
    let plan = store
        .plan_grouped_adapter_restore(
            &inspection,
            domains
                .iter()
                .map(|domain| domain.descriptor().id().clone()),
        )
        .expect("plan");
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _ = store.execute_grouped_adapter_restore(
            &catalog,
            &archive,
            &inspection,
            &plan,
            plan.confirmation_digest(),
            RestoreAdapterGroupExecutionOptions::new(
                LOCK_TIMEOUT,
                backup_limits().expect("limits"),
            ),
        );
    }))
    .is_err());
    drop(catalog);
    drop(adapters);

    let recovery =
        recover_grouped_restore(profile.storage_roots(), &sources).expect("boot recovery");
    assert_eq!(
        recovery.outcome(),
        RestoreAdapterGroupRecoveryOutcome::RolledBack
    );
    assert!(!sources.keymap.exists());
    assert_file_generation_except(&sources, "current", &[&sources.keymap]);
    assert_database_generation(&sources, "current");
}
