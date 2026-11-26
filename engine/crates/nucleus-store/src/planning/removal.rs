use nucleus_core::Task;
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::settings_domains::{RemovedProject, RemovedRepository};
use crate::{
    ProjectSettings, Projects, SettingsFile, SettingsSnapshot, StorageError, Store, StoreError,
    TASK_COLUMNS, decode_task,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRemoval {
    pub project: ProjectSettings,
    pub digest: String,
    pub tasks: Vec<RemovalTask>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalTask {
    pub task_id: String,
    pub version: i64,
    pub label: String,
}

impl Store {
    /// Preview open work against the current registry revision.
    ///
    /// # Errors
    /// Returns an error if the project is missing or the preview cannot be read.
    pub fn project_removal_preview(
        &self,
        settings: &SettingsFile,
        project: &str,
        live: impl Fn(&Task) -> bool,
    ) -> Result<ProjectRemoval, StoreError> {
        preview(&self.connection, &settings.read()?, project, &live)
    }

    /// Recheck blockers and confirmation in the planning deletion transaction.
    ///
    /// # Errors
    /// Returns a conflict when confirmation is stale or tasks are open, or an error
    /// if storage cannot publish the removal.
    pub fn remove_project(
        &mut self,
        settings: &SettingsFile,
        project: &str,
        digest: &str,
        reason: String,
        removed_at_ms: u64,
        live: impl Fn(&Task) -> bool,
    ) -> Result<(SettingsSnapshot<Projects>, RemovedProject), StoreError> {
        let tx = self.planning_write()?;
        let current = settings.read::<Projects>()?;
        let previous = current.value.removed.get(project);
        if let Some(removed) = previous.filter(|removed| removed.digest == digest) {
            if removed.reason != reason {
                return Err(StorageError::SettingsConflict.into());
            }
            let receipt = removed.clone();
            if !receipt.cleanup_pending {
                return Ok((current, receipt));
            }
            clear_removed_project(&tx, project, &receipt)?;
            tx.commit()?;
            let saved = publish_cleanup(settings, &current.revision, [project])?;
            return Ok((saved, receipt));
        }
        if previous.is_some() && !current.value.projects.contains_key(project) {
            return Err(StorageError::SettingsConflict.into());
        }
        let confirmed = preview(&tx, &current, project, &live)?;
        if !confirmed.tasks.is_empty() {
            return Err(StoreError::PlanningConflict);
        }
        if confirmed.digest != digest {
            return Err(StorageError::SettingsConflict.into());
        }
        let mut blocked_origins = previous
            .map(|removed| removed.blocked_origins.clone())
            .unwrap_or_default();
        blocked_origins.extend(
            confirmed
                .project
                .repositories
                .iter()
                .map(|repo| repo.origin.to_ascii_lowercase()),
        );
        let receipt = RemovedProject {
            cleanup_pending: true,
            blocked_origins,
            repositories: confirmed
                .project
                .repositories
                .into_iter()
                .map(|repo| RemovedRepository {
                    origin: repo.origin,
                    path: repo.path,
                })
                .collect(),
            digest: digest.into(),
            reason,
            removed_at_ms,
        };
        clear_removed_project(&tx, project, &receipt)?;
        let (saved, _) = settings.edit(&current.revision, |registry: &mut Projects| {
            registry
                .projects
                .remove(project)
                .ok_or(StorageError::SettingsConflict)?;
            registry.removed.insert(project.into(), receipt.clone());
            Ok(())
        })?;
        // The registry commits first, so a restart can finish the SQLite deletion.
        tx.commit()?;
        let saved = publish_cleanup(settings, &saved.revision, [project])?;
        Ok((saved, receipt))
    }

    /// Finish deletion when the registry published before `SQLite` could commit.
    ///
    /// # Errors
    /// Returns an error if planning cleanup cannot commit.
    pub fn clean_removed_projects(
        &mut self,
        settings: &SettingsFile,
    ) -> Result<SettingsSnapshot<Projects>, StoreError> {
        let current = settings.read::<Projects>()?;
        if !current.value.has_pending_removals() {
            return Ok(current);
        }
        let tx = self.planning_write()?;
        let mut cleaned = Vec::new();
        for (project, removed) in &current.value.removed {
            if removed.cleanup_pending {
                clear_removed_project(&tx, project, removed)?;
                cleaned.push(project.as_str());
            }
        }
        tx.commit()?;
        publish_cleanup(settings, &current.revision, cleaned)
    }

    /// Check whether a task belongs to a removed project incarnation.
    ///
    /// # Errors
    /// Returns an error if the task journal cannot be read.
    pub fn task_project_removed(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE task_id = ?1 AND kind = 'project_removed')",
            [id],
            |row| row.get(0),
        )?)
    }
}

fn publish_cleanup<'a>(
    settings: &SettingsFile,
    revision: &str,
    cleaned: impl IntoIterator<Item = &'a str>,
) -> Result<SettingsSnapshot<Projects>, StoreError> {
    let (saved, _) = settings.edit(revision, |registry: &mut Projects| {
        for project in cleaned {
            registry
                .removed
                .get_mut(project)
                .ok_or(StorageError::SettingsConflict)?
                .cleanup_pending = false;
        }
        Ok(())
    })?;
    Ok(saved)
}

fn preview(
    connection: &Connection,
    snapshot: &SettingsSnapshot<Projects>,
    id: &str,
    live: &impl Fn(&Task) -> bool,
) -> Result<ProjectRemoval, StoreError> {
    let project = snapshot
        .value
        .projects
        .get(id)
        .ok_or(StoreError::PlanningMissing)?;
    let origins: Vec<_> = project
        .repositories
        .iter()
        .map(|repo| &repo.origin)
        .collect();
    let mut query = connection.prepare_cached(&format!(
        "SELECT {TASK_COLUMNS}, version FROM tasks
         WHERE {PROJECT_TASK} AND (phase NOT IN ('done','cancelled') OR run IS NOT NULL
               OR json_extract(threads, '$.worker') IS NOT NULL
               OR json_extract(threads, '$.reviewer') IS NOT NULL)
         ORDER BY id",
    ))?;
    let mut rows = query.query(params![serde_json::to_string(&origins)?, id])?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next()? {
        let task = decode_task(row)?;
        if !task.phase().is_terminal() || live(&task) {
            tasks.push(RemovalTask {
                task_id: task.identity().id.clone(),
                version: row.get(18)?,
                label: task.identity().reference.clone(),
            });
        }
    }
    let newest: Option<i64> = connection.query_row(
        "SELECT max(version) FROM planning_record_clocks WHERE project = ?1",
        [id],
        |row| row.get(0),
    )?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            &snapshot.revision,
            id,
            newest,
            &tasks
        ))?)
    );
    Ok(ProjectRemoval {
        project: project.clone(),
        digest,
        tasks,
    })
}

const PROJECT_TASK: &str = "(repository COLLATE NOCASE IN (SELECT value FROM json_each(?1))
      OR json_extract(report_task, '$.project') = ?2
      OR id IN (SELECT task_id FROM planning_task_sources WHERE project = ?2))";

fn clear_removed_project(
    connection: &Connection,
    project: &str,
    removed: &RemovedProject,
) -> Result<(), StoreError> {
    connection.execute(
        &format!(
            "INSERT INTO events (task_id, at, kind, detail)
             SELECT id, ?3, 'project_removed', ?4 FROM tasks
             WHERE {PROJECT_TASK} AND phase IN ('done','cancelled')
             AND NOT EXISTS (SELECT 1 FROM events WHERE task_id = tasks.id AND kind = 'project_removed')",
        ),
        params![
            serde_json::to_string(&removed.blocked_origins)?,
            project,
            i64::try_from(removed.removed_at_ms).unwrap_or(i64::MAX),
            json!({ "project": project }).to_string(),
        ],
    )?;
    for table in [
        "planning_task_sources",
        "planning_items",
        "planning_decisions",
        "planning_lanes",
        "planning_plans",
        "planning_history",
        "planning_record_clocks",
    ] {
        connection.execute(
            &format!("DELETE FROM {table} WHERE project = ?1"),
            [project],
        )?;
    }
    Ok(())
}
