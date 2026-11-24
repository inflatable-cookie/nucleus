use std::collections::{BTreeMap, BTreeSet};

use nucleus_core::profiles::{Capability, Effort, Profile, Provider, Weight};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ImportError, has_table};
use crate::{NamedProfile, PoolRole, Profiles, SettingsFile, settings::SettingsValue};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImportReport {
    added: usize,
    enriched: usize,
    skipped: usize,
    conflicts: Vec<ProfileIssue>,
    unmapped: Vec<ProfileIssue>,
    retained: Vec<RetainedFields>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIssue {
    reason: String,
    profile: Option<Value>,
    pool: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetainedFields {
    profile_id: String,
    notes: String,
    scopes: Vec<String>,
    coordinator: bool,
    feature_values: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyProfile {
    id: String,
    name: String,
    provider: Provider,
    #[serde(default)]
    model: String,
    #[serde(alias = "effort")]
    thinking_option_id: Option<Effort>,
    mode_id: Option<String>,
    #[serde(alias = "instanceId")]
    provider_instance_id: Option<String>,
    #[serde(default)]
    feature_values: BTreeMap<String, Value>,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPool {
    #[serde(rename = "profileId")]
    _profile_id: String,
    enabled: bool,
    group: String,
    capability: Option<Capability>,
    weight: Weight,
    #[serde(default = "worker_only")]
    roles: Vec<PoolRole>,
    #[serde(alias = "capabilities")]
    scopes: Vec<String>,
}

fn worker_only() -> Vec<PoolRole> {
    vec![PoolRole::Worker]
}

fn records(source: &Connection, key: &str) -> Result<Option<Vec<Value>>, ImportError> {
    let encoded: Option<String> = source
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(encoded.as_deref().map(serde_json::from_str).transpose()?)
}

pub(super) fn apply(
    source: &Connection,
    settings: &SettingsFile,
) -> Result<Option<ProfileImportReport>, ImportError> {
    if !has_table(source, "meta")? {
        return Ok(None);
    }
    let profiles = records(source, "profiles")?;
    let pool = records(source, "pool")?;
    if profiles.is_none() && pool.is_none() {
        return Ok(None);
    }
    let snapshot = settings.read::<Profiles>()?;
    let mut next = snapshot.value.clone();
    let report = merge(
        &mut next,
        profiles.unwrap_or_default(),
        pool.unwrap_or_default(),
    )?;
    if next != snapshot.value {
        settings.edit::<Profiles>(&snapshot.revision, |current| {
            *current = next;
            Ok(())
        })?;
    }
    Ok(Some(report))
}

fn merge(
    target: &mut Profiles,
    profiles: Vec<Value>,
    pool: Vec<Value>,
) -> Result<ProfileImportReport, ImportError> {
    let mut report = ProfileImportReport::default();
    let mut pool_by_id = BTreeMap::new();
    for row in pool {
        if let Some(id) = row["profileId"].as_str().map(str::to_owned) {
            if pool_by_id.insert(id.clone(), row).is_some() {
                return Err(ImportError::DuplicateProfile { table: "pool", id });
            }
        } else {
            report.unmapped.push(ProfileIssue {
                reason: "pool entry needs a profileId".into(),
                profile: None,
                pool: Some(row),
            });
        }
    }

    let mut profile_ids = BTreeSet::new();
    for row in profiles {
        let pool = if let Some(id) = row["id"].as_str() {
            if !profile_ids.insert(id.to_owned()) {
                return Err(ImportError::DuplicateProfile {
                    table: "profiles",
                    id: id.into(),
                });
            }
            pool_by_id.remove(id)
        } else {
            None
        };
        let (seed, profile) = match convert(&row, pool.as_ref()) {
            Ok(records) => records,
            Err(reason) => {
                report.unmapped.push(ProfileIssue {
                    reason,
                    profile: Some(row),
                    pool,
                });
                continue;
            }
        };
        let existing = target
            .profiles
            .iter_mut()
            .find(|existing| existing.selection.id == profile.selection.id);
        match existing {
            Some(existing) if *existing == profile => report.skipped += 1,
            Some(existing) if *existing == seed && pool.is_some() => {
                existing.clone_from(&profile);
                report.enriched += 1;
            }
            Some(_) => {
                report.conflicts.push(ProfileIssue {
                    reason: "Rust profile differs from both the source and the original seed"
                        .into(),
                    profile: Some(row),
                    pool,
                });
                continue;
            }
            None => {
                target.profiles.push(profile.clone());
                report.added += 1;
            }
        }
        let coordinator = profile
            .roles
            .as_ref()
            .is_some_and(|roles| roles.contains(&PoolRole::Coordinator));
        if coordinator
            || !profile.scopes.is_empty()
            || !profile.notes.is_empty()
            || !profile.feature_values.is_empty()
        {
            report.retained.push(RetainedFields {
                profile_id: profile.selection.id,
                notes: profile.notes,
                scopes: profile.scopes,
                coordinator,
                feature_values: profile.feature_values,
            });
        }
    }
    for pool in pool_by_id.into_values() {
        report.unmapped.push(ProfileIssue {
            reason: "pool entry has no matching legacy profile".into(),
            profile: None,
            pool: Some(pool),
        });
    }
    Ok(report)
}

fn convert(row: &Value, pool: Option<&Value>) -> Result<(NamedProfile, NamedProfile), String> {
    let row: LegacyProfile =
        serde_json::from_value(row.clone()).map_err(|error| error.to_string())?;
    let pool: Option<LegacyPool> = pool
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| error.to_string())?;
    let seed = NamedProfile {
        name: row.name,
        selection: Profile {
            id: row.id,
            capability: pool
                .as_ref()
                .and_then(|pool| pool.capability)
                .unwrap_or_default(),
            weight: pool.as_ref().map_or(Weight::Default, |pool| pool.weight),
            provider: row.provider,
            model: row.model,
            effort: row.thinking_option_id,
        },
        group: pool.as_ref().map(|pool| pool.group.clone()),
        enabled: true,
        roles: None,
        scopes: Vec::new(),
        provider_instance_id: None,
        mode_id: None,
        feature_values: BTreeMap::new(),
        notes: String::new(),
        unrated: false,
    };
    let profile = NamedProfile {
        enabled: pool.as_ref().is_some_and(|pool| pool.enabled),
        unrated: pool.as_ref().is_some_and(|pool| pool.capability.is_none()),
        roles: pool.as_ref().map(|pool| pool.roles.clone()),
        scopes: pool.map_or_else(Vec::new, |pool| pool.scopes),
        provider_instance_id: row.provider_instance_id,
        mode_id: row.mode_id,
        feature_values: row.feature_values,
        notes: row.notes,
        ..seed.clone()
    };
    Profiles {
        profiles: vec![profile.clone()],
        ..Profiles::default()
    }
    .validate()
    .map_err(|issue| issue.message)?;
    Ok((seed, profile))
}
