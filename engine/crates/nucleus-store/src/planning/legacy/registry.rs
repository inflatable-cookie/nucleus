use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{ImportError, ImportReport, canonical_repository, has_table, open_copy, scratch_root};
use crate::{
    DATABASE_FILE, ProjectSettings, Projects, RepositorySettings, SettingsFile, SettingsValue,
    StorageError, Store, StoreError, planning::valid_key,
};

// The stopped profile is fenced until both durable stores have published. An
// interrupted Settings write resumes from this exact revision and payload.
pub(crate) const JOURNAL: &str = "
CREATE TABLE IF NOT EXISTS legacy_project_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pending TEXT CHECK (json_valid(pending))
) STRICT";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImportReport {
    pub projects: usize,
    pub repositories: usize,
    pub historical_projects: usize,
    pub plans: usize,
    pub plan_versions: usize,
    pub lanes: usize,
    pub lane_versions: usize,
    pub rekeyed_items: usize,
    pub coalesced_items: usize,
    pub items: ImportReport,
    pub replaced_project_settings: Vec<String>,
    pub already_applied: bool,
    pub resumed: bool,
}

#[derive(Deserialize, Serialize)]
struct Pending {
    revision: String,
    registry: Projects,
}

#[derive(Deserialize)]
struct LegacyProject {
    key: String,
    name: String,
    repositories: Vec<LegacyRepository>,
}

#[derive(Deserialize)]
struct LegacyRepository {
    origin: Option<String>,
    path: PathBuf,
}

pub(super) struct Registry {
    pub(super) projects: Projects,
    pub(super) origins: BTreeMap<String, String>,
    pub(super) aliases: BTreeMap<String, String>,
}

impl Registry {
    pub(super) fn project_for(&mut self, origin: &str) -> Result<String, ImportError> {
        if !canonical_repository(origin) {
            return Err(ImportError::Repository(origin.into()));
        }
        let origin = origin.to_ascii_lowercase();
        if let Some(id) = self.origins.get(&origin) {
            return Ok(id.clone());
        }
        let previous = old_key(&origin);
        // An origin can enroll again without taking over its archived history.
        let id = format!("legacy.{previous}");
        if self.projects.projects.contains_key(&id)
            || self.projects.projects.contains_key(&previous)
        {
            return Err(ImportError::ProjectConflict(format!(
                "the historical origin {origin} has a conflicting project key"
            )));
        }
        self.historical(&id, &origin);
        self.aliases.insert(previous, id.clone());
        self.origins.insert(origin, id.clone());
        Ok(id)
    }

    pub(super) fn historical(&mut self, id: &str, name: &str) {
        self.projects
            .projects
            .entry(id.into())
            .or_insert_with(|| ProjectSettings {
                name: name.into(),
                archived: true,
                repositories: Vec::new(),
            });
    }
}

pub(super) fn old_key(origin: &str) -> String {
    if origin == "inflatable-cookie/barge" {
        "barge".into()
    } else {
        format!("repo-{:x}", Sha256::digest(origin.as_bytes()))
    }
}

impl Store {
    pub(crate) fn check_legacy_project_import(tx: &Transaction<'_>) -> Result<(), StoreError> {
        let pending: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM legacy_project_import WHERE pending IS NOT NULL)",
            [],
            |row| row.get(0),
        )?;
        if pending {
            return Err(StoreError::ProjectImportPending);
        }
        Ok(())
    }
}

/// Rehearse the migration in scratch, or advance an explicitly selected stopped
/// profile. The TS copy is always opened immutable and its sidecars are refused.
///
/// # Errors
/// Returns a conflict without replacing ambiguous data, or a storage or decoding error.
pub fn import_projects(
    scratch: &Path,
    source: &Path,
    settings: Option<&SettingsFile>,
) -> Result<ProjectImportReport, ImportError> {
    let scratch = scratch_root(scratch)?;
    let source = open_copy(&scratch, source)?;
    if let Some(settings) = settings {
        return apply(&source, settings);
    }
    let directory = tempfile::Builder::new()
        .prefix("nucleus-project-import-")
        .tempdir_in(scratch)?;
    let mut store = Store::open_database(&directory.path().join(DATABASE_FILE))?;
    let tx = store.planning_write()?;
    let (_, report) = copy(&source, &tx, Projects::default())?;
    tx.rollback()?;
    Ok(report)
}

fn apply(source: &Connection, settings: &SettingsFile) -> Result<ProjectImportReport, ImportError> {
    let storage = settings.storage()?;
    storage.database().verify()?;
    let _lock = storage.lock_profile()?;
    let mut connection = Store::connect_database(
        &storage.database().path().join(DATABASE_FILE),
        OpenFlags::empty(),
    )?;
    let schema = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    Store::prepare_schema(&schema, false)?;
    schema.commit()?;
    connection.pragma_update(None, "foreign_keys", true)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let journal: Option<Option<String>> = tx
        .query_row(
            "SELECT pending FROM legacy_project_import WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let (pending, report) = match journal {
        Some(None) => {
            return Ok(ProjectImportReport {
                already_applied: true,
                ..ProjectImportReport::default()
            });
        }
        Some(Some(pending)) => (
            serde_json::from_str(&pending)?,
            ProjectImportReport {
                resumed: true,
                ..ProjectImportReport::default()
            },
        ),
        None => {
            let current = settings.read::<Projects>()?;
            let (registry, report) = copy(source, &tx, current.value)?;
            let pending = Pending {
                revision: current.revision,
                registry,
            };
            tx.execute(
                "INSERT INTO legacy_project_import (singleton, pending) VALUES (1, ?1)",
                [serde_json::to_string(&pending)?],
            )?;
            (pending, report)
        }
    };
    tx.commit()?;
    let current = settings.read::<Projects>()?;
    if current.value != pending.registry {
        settings.edit(&pending.revision, move |value: &mut Projects| {
            *value = pending.registry;
            Ok(())
        })?;
    }
    connection.execute(
        "UPDATE legacy_project_import SET pending = NULL WHERE singleton = 1",
        [],
    )?;
    Ok(report)
}

fn copy(
    source: &Connection,
    tx: &Transaction<'_>,
    existing: Projects,
) -> Result<(Projects, ProjectImportReport), ImportError> {
    for table in ["projects", "meta", "lanes", "project_plans"] {
        if !has_table(source, table)? {
            return Err(ImportError::ProjectsSchema);
        }
    }
    let mut report = ProjectImportReport::default();
    let mut registry = read_registry(source, existing, &mut report)?;
    super::rekey::copy_items(source, tx, &mut registry, &mut report)?;
    super::project_records::copy(source, tx, &mut registry, &mut report)?;
    super::rekey::remaining(tx, &registry.aliases)?;
    registry
        .projects
        .validate()
        .map_err(|issue| StorageError::InvalidSettings(issue.message))?;
    report.historical_projects = registry
        .projects
        .projects
        .values()
        .filter(|project| project.archived && project.repositories.is_empty())
        .count();
    Ok((registry.projects, report))
}

fn read_registry(
    source: &Connection,
    existing: Projects,
    report: &mut ProjectImportReport,
) -> Result<Registry, ImportError> {
    let mut projects = Projects {
        removed: existing.removed.clone(),
        ..Projects::default()
    };
    let mut origins = BTreeMap::new();
    let mut aliases = BTreeMap::new();
    let mut query = source.prepare("SELECT key, data FROM projects ORDER BY key")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let project: LegacyProject = super::decode(row, 1)?;
        if project.key != id || !valid_key(&id) || project.repositories.is_empty() {
            return Err(ImportError::ProjectConflict(id));
        }
        let mut repositories = Vec::new();
        for repository in project.repositories {
            let origin = repository
                .origin
                .filter(|origin| canonical_repository(origin))
                .ok_or_else(|| {
                    ImportError::ProjectConflict(format!(
                        "{id} has a repository with no GitHub origin"
                    ))
                })?
                .to_ascii_lowercase();
            if origins.insert(origin.clone(), id.clone()).is_some() {
                return Err(ImportError::ProjectConflict(format!(
                    "{origin} belongs to more than one project"
                )));
            }
            let alias = old_key(&origin);
            if alias != id {
                aliases.insert(alias, id.clone());
            }
            repositories.push(RepositorySettings {
                origin,
                path: repository.path,
                // TS did not store a base for a registry member. The unbound
                // value is its admission default, replaced by exact Git proof.
                base: "main".into(),
                host_project: None,
                host_project_title: None,
                planner_threads: Vec::new(),
                required_checks: Vec::new(),
                hung_tool_minutes: 30,
            });
        }
        report.repositories += repositories.len();
        projects.projects.insert(
            id.clone(),
            ProjectSettings {
                name: project.name,
                archived: false,
                repositories,
            },
        );
    }
    report.projects = projects.projects.len();
    for id in aliases.keys() {
        if projects.projects.contains_key(id) {
            return Err(ImportError::ProjectConflict(format!(
                "the old key {id} is also a current TS project"
            )));
        }
    }
    preserve_settings(&mut projects, existing, &origins, &aliases, report)?;
    for (id, project) in &projects.projects {
        for repo in &project.repositories {
            origins
                .entry(repo.origin.to_ascii_lowercase())
                .or_insert_with(|| id.clone());
        }
    }
    Ok(Registry {
        projects,
        origins,
        aliases,
    })
}

fn preserve_settings(
    projects: &mut Projects,
    existing: Projects,
    origins: &BTreeMap<String, String>,
    aliases: &BTreeMap<String, String>,
    report: &mut ProjectImportReport,
) -> Result<(), ImportError> {
    for (id, mut project) in existing.projects {
        let conflicting = || {
            ImportError::ProjectConflict(format!(
                "Rust project {id} has an incompatible repository assignment"
            ))
        };
        let target_id = aliases.get(&id).unwrap_or(&id);
        let Some(target) = projects.projects.get_mut(target_id) else {
            if project
                .repositories
                .iter()
                .any(|repo| origins.contains_key(&repo.origin.to_ascii_lowercase()))
            {
                return Err(conflicting());
            }
            projects.projects.insert(id, project);
            continue;
        };
        if project.archived && aliases.contains_key(&id) {
            return Err(ImportError::ProjectConflict(format!(
                "archived Rust project {id} needs an explicit disposition before reassignment"
            )));
        }
        if project.name != target.name {
            report.replaced_project_settings.push(id.clone());
        }
        if !aliases.contains_key(&id) {
            target.archived = project.archived;
        }
        for repo in project.repositories.drain(..) {
            let dest = target
                .repositories
                .iter_mut()
                .find(|dest| dest.origin.eq_ignore_ascii_case(&repo.origin))
                .ok_or_else(conflicting)?;
            if dest.host_project.is_some() {
                return Err(conflicting());
            }
            *dest = repo;
        }
    }
    Ok(())
}
