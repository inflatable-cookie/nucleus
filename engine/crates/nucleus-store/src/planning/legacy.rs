//! Offline import from a standalone TypeScript `SQLite` copy.

mod limits;
mod profiles;
mod project_records;
mod registry;
mod rekey;
#[cfg(test)]
mod tests;
mod versions;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

use super::{
    Item, ItemContent, ItemKind, ItemRecord, ItemState, WriteAt, decode, insert, record_history,
    valid_key,
};
use crate::{DATABASE_FILE, SettingsFile, StorageError, Store, StoreError, TaskNumberSeed};

pub use limits::{LimitsImport, import_limits};
pub(crate) use registry::JOURNAL as PROJECT_IMPORT_JOURNAL;
pub use registry::{ProjectImportReport, import_projects};

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("the source must be a standalone SQLite copy inside the configured scratch root")]
    Source,
    #[error("the copy does not contain a legacy planning table")]
    Schema,
    #[error("the copy does not contain legacy profiles or pool settings")]
    ProfilesSchema,
    #[error("the copy does not contain the legacy project registry and planning tables")]
    ProjectsSchema,
    #[error("missing or invalid legacy dispatch setting {0}")]
    LimitsSchema(&'static str),
    #[error("project import conflict: {0}")]
    ProjectConflict(String),
    #[error("every repository needs a project mapping; missing {0}")]
    Repository(String),
    #[error("invalid repository mapping or legacy item {0}")]
    Item(String),
    #[error("legacy item {id} collides with existing planning data in project {project}")]
    Collision { project: String, id: String },
    #[error("invalid legacy history for {id} at version {version}")]
    History { id: String, version: u32 },
    #[error("invalid legacy task number range")]
    NumberSeed,
    #[error("task number seed scope must be a canonical owner/repository")]
    NumberSeedScope,
    #[error("invalid legacy timestamp {0}")]
    Timestamp(String),
    #[error("duplicate legacy {table} record for profile {id}")]
    DuplicateProfile { table: &'static str, id: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

#[derive(Debug, Clone, Copy)]
pub enum ImportMode {
    Rehearse,
    Keep,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub leads: usize,
    pub papercuts: usize,
    pub versions: usize,
    pub task_links: usize,
    pub skipped: usize,
    pub database: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<profiles::ProfileImportReport>,
}

/// Read an immutable TS backup and run the item import in a fresh scratch database.
/// Rehearsal rolls back the same transaction a kept import commits.
///
/// # Errors
/// Returns an error for an unsafe path, unmapped repository, or unreadable source or destination.
pub fn import_items(
    scratch: &Path,
    source: &Path,
    repositories: &BTreeMap<String, String>,
    mode: ImportMode,
) -> Result<ImportReport, ImportError> {
    let scratch = scratch_root(scratch)?;
    let source = open_copy(&scratch, source)?;
    let mapping = repository_projects(repositories)?;
    let directory = tempfile::Builder::new()
        .prefix("nucleus-planning-import-")
        .tempdir_in(scratch)?;
    let database = directory.path().join(DATABASE_FILE);
    let mut store = Store::open_database(&database)?;
    let tx = store.planning_write()?;
    let mut report = copy_items(&source, &tx, &mapping)?;
    match mode {
        ImportMode::Rehearse => tx.rollback()?,
        ImportMode::Keep => {
            tx.commit()?;
            drop(store);
            report.database = Some(directory.keep().join(DATABASE_FILE));
        }
    }
    Ok(report)
}

/// Append planning items and profiles while holding the stopped engine's service lock.
///
/// # Errors
/// Returns an error for a running or missing profile, unsafe source, item collision,
/// unmapped repository, or storage failure. Each store publishes atomically.
pub fn apply_items(
    scratch: &Path,
    source: &Path,
    repositories: &BTreeMap<String, String>,
    settings: &SettingsFile,
) -> Result<ImportReport, ImportError> {
    let source = open_copy(&scratch_root(scratch)?, source)?;
    let mapping = repository_projects(repositories)?;
    let storage = settings.storage()?;
    storage.database().verify()?;
    let _lock = storage.lock_profile()?;
    let database = storage.database().path().join(DATABASE_FILE);
    let mut connection = Store::connect_database(&database, OpenFlags::empty())?;
    let schema = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    Store::prepare_schema(&schema, false)?;
    schema.commit()?;
    connection.pragma_update(None, "foreign_keys", true)?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    Store::check_legacy_project_import(&tx)?;
    let mut report = copy_items(&source, &tx, &mapping)?;
    report.profiles = profiles::apply(&source, settings)?;
    tx.commit()?;
    report.database = Some(database);
    Ok(report)
}

/// Apply only Profiles through the stopped engine's service lock.
///
/// # Errors
/// Returns an error for an unsafe copy, missing profile metadata, running
/// service or unreadable settings.
pub fn apply_profiles(
    scratch: &Path,
    source: &Path,
    settings: &SettingsFile,
) -> Result<ImportReport, ImportError> {
    let source = open_copy(&scratch_root(scratch)?, source)?;
    let storage = settings.storage()?;
    let _lock = storage.lock_profile()?;
    let profiles = profiles::apply(&source, settings)?.ok_or(ImportError::ProfilesSchema)?;
    Ok(ImportReport {
        profiles: Some(profiles),
        ..ImportReport::default()
    })
}

fn scratch_root(scratch: &Path) -> Result<PathBuf, ImportError> {
    if !scratch.is_absolute() {
        return Err(ImportError::Source);
    }
    Ok(scratch.canonicalize()?)
}

fn repository_projects(
    repositories: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, &str>, ImportError> {
    if repositories.is_empty() {
        return Err(ImportError::Source);
    }
    let mut mapping = BTreeMap::new();
    for (repository, project) in repositories {
        if !canonical_repository(repository)
            || !valid_key(project)
            || mapping
                .insert(repository.to_ascii_lowercase(), project.as_str())
                .is_some()
        {
            return Err(ImportError::Item(repository.clone()));
        }
    }
    Ok(mapping)
}

/// Read canonical repository counters from a standalone copy made after the
/// TypeScript allocator was fenced. A single pilot can restrict the seed to
/// its validated repository. The counter already stores the next number.
///
/// # Errors
/// Returns an error for an unsafe copy path, unreadable legacy tables, an
/// invalid repository scope, or an invalid counter.
pub fn read_task_number_seed(
    scratch: &Path,
    source: &Path,
    repository: Option<&str>,
) -> Result<TaskNumberSeed, ImportError> {
    let scratch = scratch_root(scratch)?;
    if repository.is_some_and(|repository| !canonical_repository(repository)) {
        return Err(ImportError::NumberSeedScope);
    }
    let scope = repository.map(str::to_ascii_lowercase);
    let source = open_copy(&scratch, source)?;
    let mut query = source.prepare(
        "SELECT lower(repository), max(next_number), max(assigned)
         FROM (
           SELECT repository, next_number, NULL AS assigned FROM task_number_counters
           UNION ALL
           SELECT repository, NULL, number FROM task_numbers
         )
         WHERE ?1 IS NULL OR lower(repository) = ?1
         GROUP BY lower(repository)",
    )?;
    let mut rows = query.query([&scope])?;
    let mut floors = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let origin: String = row.get(0)?;
        if !canonical_repository(&origin) {
            continue;
        }
        let counter: Option<i64> = row.get(1)?;
        let used: Option<i64> = row.get(2)?;
        if counter.is_some_and(|value| value < 1) || used.is_some_and(|value| value < 1) {
            return Err(ImportError::NumberSeed);
        }
        let after_used = used
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(ImportError::NumberSeed)?;
        floors.insert(origin, counter.unwrap_or(1).max(after_used));
    }
    let all_repositories = scope.is_none();
    if let Some(repository) = scope {
        floors.entry(repository).or_insert(1);
    }
    Ok(TaskNumberSeed {
        floors,
        all_repositories,
    })
}

fn canonical_repository(repository: &str) -> bool {
    repository
        .split_once('/')
        .is_some_and(|(owner, name)| valid_key(owner) && valid_key(name))
}

fn open_copy(scratch: &Path, path: &Path) -> Result<Connection, ImportError> {
    let path = path.canonicalize()?;
    if !path.starts_with(scratch) {
        return Err(ImportError::Source);
    }
    let metadata = path.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(ImportError::Source);
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(sidecar) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
            Ok(_) => return Err(ImportError::Source),
        }
    }
    let mut url = Url::from_file_path(path).map_err(|()| ImportError::Source)?;
    url.query_pairs_mut().append_pair("immutable", "1");
    let source = Connection::open_with_flags(
        url.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_URI,
    )?;
    source.pragma_update(None, "trusted_schema", false)?;
    Ok(source)
}

fn copy_items(
    source: &Connection,
    target: &Transaction<'_>,
    mapping: &BTreeMap<String, &str>,
) -> Result<ImportReport, ImportError> {
    let mut report = ImportReport::default();
    walk_items(source, |id, fields, raw, revisions| {
        copy_item(target, mapping, id, fields, raw, revisions, &mut report)
    })?;
    Ok(report)
}

fn walk_items(
    source: &Connection,
    mut copy: impl FnMut(&str, &LegacyItem, &Value, &BTreeMap<u32, Value>) -> Result<(), ImportError>,
) -> Result<(), ImportError> {
    let leads = has_table(source, "leads")?;
    let papercuts = has_table(source, "papercuts")?;
    if !leads && !papercuts {
        return Err(ImportError::Schema);
    }
    if leads {
        let mut query = source.prepare("SELECT id, data FROM leads ORDER BY id")?;
        let rows = query.query_map([], legacy_row)?;
        let mut history = versions::Reader::new(source)?;
        for row in rows {
            let (id, mut raw) = row?;
            let revisions = history.read(&id)?;
            if raw["body"].is_null()
                && let Some(version) = raw["version"].as_u64()
                && let Ok(version) = u32::try_from(version)
                && let Some(snapshot) = revisions.get(&version)
            {
                raw["body"] = snapshot["body"].clone();
            }
            let fields: LegacyItem = serde_json::from_value(raw.clone())?;
            copy(&id, &fields, &raw, &revisions)?;
        }
    }
    if papercuts {
        let statement = if leads {
            "SELECT id, data FROM papercuts WHERE NOT EXISTS (SELECT 1 FROM leads WHERE leads.id = papercuts.id) ORDER BY id"
        } else {
            "SELECT id, data FROM papercuts ORDER BY id"
        };
        let mut query = source.prepare(statement)?;
        let rows = query.query_map([], legacy_row)?;
        for row in rows {
            let (id, raw) = row?;
            let cut: LegacyPapercut = serde_json::from_value(raw.clone())?;
            copy(&id, &cut.into_item(), &raw, &BTreeMap::new())?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyItem {
    id: String,
    title: String,
    body: String,
    author: String,
    repositories: Vec<Repository>,
    #[serde(default)]
    lanes: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    papercut: Option<Value>,
    state: LegacyState,
    parked: Option<Park>,
    drop_reason: Option<String>,
    closure: Option<Closure>,
    #[serde(default)]
    targets: Vec<Target>,
    created_at: String,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct Repository {
    origin: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum LegacyState {
    Open,
    Parked,
    Dropped,
    Closed,
    Promoted,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Park {
    reason: String,
    revisit_at: Option<String>,
}

#[derive(Deserialize)]
struct Closure {
    reason: String,
    note: Option<String>,
}

#[derive(Deserialize)]
struct Target {
    kind: String,
    repository: Option<String>,
    reference: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPapercut {
    id: String,
    title: String,
    repository: Repository,
    area: Option<String>,
    happened: String,
    impact: String,
    fix: Option<String>,
    filed_by: String,
    filed_at: String,
    state: LegacyState,
    parked: Option<Park>,
    #[serde(default)]
    lanes: Vec<String>,
    task_id: Option<String>,
    closed_reason: Option<String>,
    note: Option<String>,
    closed_at: Option<String>,
}

impl LegacyPapercut {
    fn into_item(self) -> LegacyItem {
        let body = [
            self.area.map(|area| format!("Area\n\n{area}")),
            Some(format!("What happened\n\n{}", self.happened)),
            Some(format!("Impact\n\n{}", self.impact)),
            self.fix.map(|fix| format!("Suggested fix\n\n{fix}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n");
        let targets = self
            .task_id
            .map(|reference| Target {
                kind: "task".into(),
                repository: Some(self.repository.origin.clone()),
                reference,
            })
            .into_iter()
            .collect();
        LegacyItem {
            id: self.id,
            title: self.title,
            body,
            author: self.filed_by,
            repositories: vec![self.repository],
            lanes: self.lanes,
            tags: vec!["papercut".into()],
            papercut: None,
            state: self.state,
            parked: self.parked,
            drop_reason: None,
            closure: self.closed_reason.map(|reason| Closure {
                reason,
                note: self.note,
            }),
            targets,
            created_at: self.filed_at,
            updated_at: self.closed_at,
        }
    }
}

impl LegacyItem {
    fn validate(&self, id: &str) -> Result<(), ImportError> {
        if id != self.id
            || !valid_key(id)
            || self.repositories.is_empty()
            || self.author.trim().is_empty()
            || self.title.trim().is_empty()
            || (matches!(self.state, LegacyState::Parked) && self.parked.is_none())
        {
            return Err(ImportError::Item(id.into()));
        }
        Ok(())
    }

    fn item(&self, task_links: Vec<String>) -> Item {
        Item {
            id: self.id.clone(),
            kind: self.kind(),
            author: self.author.clone(),
            content: ItemContent {
                title: self.title.clone(),
                body: self.body.clone(),
                lanes: self.lanes.clone(),
            },
            state: self.state(&task_links),
            task_links,
            repositories: Vec::new(),
        }
    }

    fn kind(&self) -> ItemKind {
        if self.papercut.is_some() || self.tags.iter().any(|tag| tag == "papercut") {
            ItemKind::Papercut
        } else {
            ItemKind::Lead
        }
    }

    fn state(&self, task_links: &[String]) -> ItemState {
        match self.state {
            LegacyState::Open | LegacyState::Parked => {
                self.parked
                    .as_ref()
                    .map_or(ItemState::Open, |park| ItemState::Parked {
                        reason: park.reason.clone(),
                        revisit_at: park.revisit_at.clone(),
                    })
            }
            LegacyState::Promoted => task_links.first().map_or_else(
                || ItemState::Dropped {
                    reason: Some("Legacy promotion has no task in this project.".into()),
                },
                |id| ItemState::Promoted {
                    task_id: id.clone(),
                },
            ),
            LegacyState::Closed | LegacyState::Dropped => ItemState::Dropped {
                reason: self.drop_reason.clone().or_else(|| {
                    self.closure.as_ref().map(|closure| {
                        closure
                            .note
                            .clone()
                            .unwrap_or_else(|| closure.reason.clone())
                    })
                }),
            },
        }
    }
}

fn copy_item(
    tx: &Transaction<'_>,
    mapping: &BTreeMap<String, &str>,
    id: &str,
    legacy: &LegacyItem,
    raw: &Value,
    revisions: &BTreeMap<u32, Value>,
    report: &mut ImportReport,
) -> Result<(), ImportError> {
    legacy.validate(id)?;
    let mut projects = BTreeSet::new();
    for repository in &legacy.repositories {
        let project = mapping
            .get(&repository.origin.to_ascii_lowercase())
            .ok_or_else(|| ImportError::Repository(repository.origin.clone()))?;
        projects.insert(*project);
    }
    for project in projects {
        if already_imported(tx, project, id)? {
            report.skipped += 1;
            continue;
        }
        let mut seen = BTreeSet::new();
        let task_links: Vec<_> = legacy
            .targets
            .iter()
            .filter(|target| {
                target.kind == "task"
                    && !target.reference.trim().is_empty()
                    && target.repository.as_ref().is_none_or(|repository| {
                        mapping.get(&repository.to_ascii_lowercase()) == Some(&project)
                    })
                    && seen.insert(&target.reference)
            })
            .map(|target| target.reference.clone())
            .collect();
        let item = legacy.item(task_links);
        insert_imported_item(tx, project, legacy, &item, raw, revisions, report)?;
    }
    Ok(())
}

fn insert_imported_item(
    tx: &Transaction<'_>,
    project: &str,
    legacy: &LegacyItem,
    item: &Item,
    raw: &Value,
    revisions: &BTreeMap<u32, Value>,
    report: &mut ImportReport,
) -> Result<(), ImportError> {
    let id = &item.id;
    for version in revisions.values() {
        let author = version["author"].as_str().unwrap_or(&legacy.author);
        let date = version["createdAt"].as_str().unwrap_or(&legacy.created_at);
        record_history(
            tx,
            ItemRecord,
            project,
            id,
            "legacy_version",
            &version.to_string(),
            WriteAt {
                actor: author,
                at_ms: date_ms(date)?,
            },
        )?;
    }
    let stamp = WriteAt {
        actor: &legacy.author,
        at_ms: date_ms(legacy.updated_at.as_deref().unwrap_or(&legacy.created_at))?,
    };
    record_history(
        tx,
        ItemRecord,
        project,
        id,
        "legacy_snapshot",
        &raw.to_string(),
        stamp,
    )?;
    insert(tx, ItemRecord, project, id, "import", item, stamp)?;
    match item.kind {
        ItemKind::Lead => report.leads += 1,
        ItemKind::Papercut => report.papercuts += 1,
    }
    report.versions += revisions.len();
    report.task_links += item.task_links.len();
    Ok(())
}

fn already_imported(tx: &Transaction<'_>, project: &str, id: &str) -> Result<bool, ImportError> {
    let (exists, imported) = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM planning_items WHERE project = ?1 AND id = ?2),
                EXISTS (SELECT 1 FROM planning_history
                        WHERE project = ?1 AND id = ?2 AND kind = ?3 AND action = 'import')",
        params![project, id, ItemRecord.as_str()],
        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
    )?;
    match (exists, imported) {
        (true, true) => Ok(true),
        (false, false) => Ok(false),
        _ => Err(ImportError::Collision {
            project: project.into(),
            id: id.into(),
        }),
    }
}

fn date_ms(date: &str) -> Result<u64, ImportError> {
    OffsetDateTime::parse(date, &Rfc3339)
        .ok()
        .and_then(|date| u64::try_from(date.unix_timestamp_nanos() / 1_000_000).ok())
        .ok_or_else(|| ImportError::Timestamp(date.into()))
}

fn legacy_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, Value)> {
    Ok((row.get(0)?, decode(row, 1)?))
}

fn has_table(source: &Connection, name: &str) -> rusqlite::Result<bool> {
    source.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )
}
