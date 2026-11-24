use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::settings_domains::RemovedProject;
use crate::{
    ProjectSettings, Projects, SettingsFile, SettingsSnapshot, StorageError, Store, StoreError,
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
    ) -> Result<ProjectRemoval, StoreError> {
        preview(&self.connection, &settings.read()?, project)
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
    ) -> Result<(SettingsSnapshot<Projects>, ProjectSettings), StoreError> {
        let tx = self.planning_write()?;
        let current = settings.read()?;
        let confirmed = preview(&tx, &current, project)?;
        if !confirmed.tasks.is_empty() {
            return Err(StoreError::PlanningConflict);
        }
        if confirmed.digest != digest {
            return Err(StorageError::SettingsConflict.into());
        }
        clear_planning(&tx, project)?;
        let (saved, _) = settings.edit(&current.revision, |registry: &mut Projects| {
            let removed = registry
                .projects
                .remove(project)
                .ok_or(StorageError::SettingsConflict)?;
            registry.removed.insert(
                project.into(),
                RemovedProject {
                    origins: removed
                        .repositories
                        .into_iter()
                        .map(|repo| repo.origin)
                        .collect(),
                    reason,
                    removed_at_ms,
                },
            );
            Ok(())
        })?;
        // The registry commits first, so a restart can finish the SQLite deletion.
        tx.commit()?;
        Ok((saved, confirmed.project))
    }

    /// Finish deletion when the registry published before SQLite could commit.
    ///
    /// # Errors
    /// Returns an error if planning cleanup cannot commit.
    pub fn clean_removed_projects(&mut self, registry: &Projects) -> Result<(), StoreError> {
        if registry.removed.is_empty() {
            return Ok(());
        }
        let tx = self.planning_write()?;
        for project in registry.removed.keys() {
            clear_planning(&tx, project)?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn preview(
    connection: &Connection,
    snapshot: &SettingsSnapshot<Projects>,
    id: &str,
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
    let mut query = connection.prepare_cached(
        "SELECT id, version, reference FROM tasks
         WHERE (phase NOT IN ('done','cancelled') OR run IS NOT NULL)
           AND (repository COLLATE NOCASE IN (SELECT value FROM json_each(?1))
                OR json_extract(report_task, '$.project') = ?2
                OR id IN (SELECT task_id FROM planning_task_sources WHERE project = ?2))
         ORDER BY id",
    )?;
    let tasks = query
        .query_map(params![serde_json::to_string(&origins)?, id], |row| {
            Ok(RemovalTask {
                task_id: row.get(0)?,
                version: row.get(1)?,
                label: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let newest: Option<i64> = connection.query_row(
        "SELECT max(sequence) FROM planning_history WHERE project = ?1",
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

fn clear_planning(connection: &Connection, project: &str) -> Result<(), StoreError> {
    for table in [
        "planning_task_sources",
        "planning_items",
        "planning_decisions",
        "planning_lanes",
        "planning_plans",
        "planning_history",
    ] {
        connection.execute(
            &format!("DELETE FROM {table} WHERE project = ?1"),
            [project],
        )?;
    }
    Ok(())
}
