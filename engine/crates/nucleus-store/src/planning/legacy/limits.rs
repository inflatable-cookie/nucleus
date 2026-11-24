use std::{collections::BTreeMap, path::Path};

use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, de::DeserializeOwned};

use super::{ImportError, open_copy, scratch_root};
use crate::{DispatchSettings, SettingsFile, SettingsValue, StorageError};

/// The capacity fields carried by the fenced TypeScript snapshot.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsImport {
    pub global_slots: u32,
    pub project_default_slots: u32,
    pub project_slot_overrides: BTreeMap<String, u32>,
    pub thread_retention_days: u32,
    pub thread_retention_interval_hours: u32,
    pub already_applied: bool,
}

/// Read only the five limits meta keys and optionally import them into a stopped profile.
/// # Errors
/// Rejects unsafe sources, invalid limits, running profiles or failed settings publication.
pub fn import_limits(
    scratch: &Path,
    source: &Path,
    settings: Option<&SettingsFile>,
) -> Result<LimitsImport, ImportError> {
    let source = open_copy(&scratch_root(scratch)?, source)?;
    let mut report = LimitsImport {
        global_slots: meta(&source, "globalLimit")?,
        project_default_slots: meta(&source, "projectLimit")?,
        project_slot_overrides: meta(&source, "projectDispatchLimitOverrides")?,
        thread_retention_days: meta(&source, "threadRetentionDays")?,
        thread_retention_interval_hours: meta(&source, "threadRetentionIntervalHours")?,
        already_applied: false,
    };
    if report.global_slots > 64 {
        return Err(ImportError::LimitsSchema("globalLimit"));
    }
    let mut proof = DispatchSettings::default();
    report.copy_to(&mut proof);
    proof
        .validate()
        .map_err(|issue| StorageError::InvalidSettings(issue.message))?;
    if let Some(settings) = settings {
        let _lock = settings.storage()?.lock_profile()?;
        let saved = settings.read::<DispatchSettings>()?;
        report.already_applied = saved.value.legacy_limits_imported;
        if !report.already_applied {
            // Projects no longer owns capacity. Publish its current typed registry
            // once to remove the ignored legacy fields on disk.
            settings.rewrite_legacy_projects()?;
            settings.edit(&saved.revision, |dispatch| {
                report.copy_to(dispatch);
                dispatch.legacy_limits_imported = true;
                Ok(())
            })?;
        }
    }
    Ok(report)
}

impl LimitsImport {
    fn copy_to(&self, value: &mut DispatchSettings) {
        value.global_slots = self.global_slots;
        value.project_default_slots = self.project_default_slots;
        value
            .project_slot_overrides
            .clone_from(&self.project_slot_overrides);
        value.thread_retention_days = self.thread_retention_days;
        value.thread_retention_interval_hours = self.thread_retention_interval_hours;
    }
}

fn meta<T: DeserializeOwned>(source: &Connection, key: &'static str) -> Result<T, ImportError> {
    let raw: String = source
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or(ImportError::LimitsSchema(key))?;
    serde_json::from_str(&raw).map_err(|_| ImportError::LimitsSchema(key))
}
