use super::*;

pub(in crate::config_operations) struct GroupedRestorePreparation {
    pub archive_sha256: Sha256Digest,
    pub confirmation_digest: Sha256Digest,
    pub domains: Vec<DomainId>,
}

pub(in crate::config_operations) fn prepare(
    roots: &StorageRoots,
    sources: &BackupSources,
    archive: &BackupArchiveInspection,
) -> Result<GroupedRestorePreparation, String> {
    with_authority(roots, sources, |store, catalog, domains| {
        let application = application()?;
        let producer = producer()?;
        let inspection = store.inspect_restore(catalog, archive, &application, &producer);
        let selected = domains
            .iter()
            .map(|domain| domain.descriptor().id().clone())
            .collect::<Vec<_>>();
        let plan = store
            .plan_grouped_adapter_restore(&inspection, selected)
            .map_err(|error| error.to_string())?;
        Ok(GroupedRestorePreparation {
            archive_sha256: archive.archive_sha256().clone(),
            confirmation_digest: plan.confirmation_digest().clone(),
            domains: plan
                .entries()
                .iter()
                .map(|entry| entry.domain().clone())
                .collect(),
        })
    })
}

pub(in crate::config_operations) fn execute(
    roots: &StorageRoots,
    sources: &BackupSources,
    archive: &BackupArchiveInspection,
    confirmation: &Sha256Digest,
) -> Result<RestoreAdapterGroupExecutionReceipt, String> {
    with_authority(roots, sources, |store, catalog, domains| {
        let application = application()?;
        let producer = producer()?;
        let inspection = store.inspect_restore(catalog, archive, &application, &producer);
        let selected = domains
            .iter()
            .map(|domain| domain.descriptor().id().clone())
            .collect::<Vec<_>>();
        let plan = store
            .plan_grouped_adapter_restore(&inspection, selected)
            .map_err(|error| error.to_string())?;
        if plan.confirmation_digest() != confirmation {
            return Err("grouped restore confirmation changed before boot execution".to_owned());
        }
        store
            .execute_grouped_adapter_restore(
                catalog,
                archive,
                &inspection,
                &plan,
                confirmation,
                RestoreAdapterGroupExecutionOptions::new(LOCK_TIMEOUT, backup_limits()?),
            )
            .map_err(|error| error.to_string())
    })
}

pub(in crate::config_operations) fn recover(
    roots: &StorageRoots,
    sources: &BackupSources,
) -> Result<RestoreAdapterGroupRecoveryReceipt, String> {
    with_authority(roots, sources, |store, catalog, _domains| {
        store
            .recover_grouped_adapter_restore(catalog, LOCK_TIMEOUT)
            .map_err(|error| error.to_string())
    })
}

fn with_authority<T>(
    roots: &StorageRoots,
    sources: &BackupSources,
    use_authority: impl FnOnce(&ConfigStore, &BackupCatalog<'_>, &[OpaqueDomain]) -> Result<T, String>,
) -> Result<T, String> {
    let domains = domains()?;
    let adapters = adapters(sources)?;
    let coordination =
        CoordinationAuthority::new(roots.data()).map_err(|error| error.to_string())?;
    let mut store = ConfigStore::new(roots.clone(), coordination);
    let mut catalog = BackupCatalog::new();
    for (domain, adapter) in domains.iter().zip(adapters.iter()) {
        store.register(domain).map_err(|error| error.to_string())?;
        catalog
            .custom(domain, adapter.as_ref())
            .map_err(|error| error.to_string())?;
    }
    use_authority(&store, &catalog, &domains)
}
