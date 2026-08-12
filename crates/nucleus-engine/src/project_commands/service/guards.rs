//! Project retention guards: transient expiry and delete refuse when durable
//! children still reference the project.
//!
//! Split from the service god file; behavior unchanged.

use super::super::model::{
    EngineProjectCommandError, EngineProjectRepository, EngineProjectScanDomain,
};
use super::helpers::invalid;
use super::CommandResult;
use super::EngineProjectCommandService;

impl<R> EngineProjectCommandService<R>
where
    R: EngineProjectRepository,
{
    /// Transient expiry deletes only chat residue: any durable child (task,
    /// goal, accepted memory, attached resource) blocks it and demands an
    /// explicit retention decision instead. Conversations do not block —
    /// transient chat expires with its project.
    pub(super) fn refuse_expiry_with_durable_children(
        &self,
        project: &nucleus_projects::ProjectStorageRecord,
    ) -> CommandResult<R> {
        if project.retention != nucleus_projects::ProjectRetentionStorage::Transient {
            return Err(invalid("only transient projects can expire"));
        }
        let mut retained: Vec<String> = Vec::new();
        if !project.resources.is_empty() {
            retained.push(format!("resources={}", project.resources.len()));
        }
        let durable_domains = [
            (EngineProjectScanDomain::Tasks, None),
            (EngineProjectScanDomain::Planning, Some("Goal")),
            (EngineProjectScanDomain::SharedMemory, None),
        ];
        for (domain, kind_filter) in durable_domains {
            let matches = self
                .repository
                .domain_payloads(domain)
                .map_err(EngineProjectCommandError::Storage)?
                .into_iter()
                .filter(|(_, kind, _)| kind_filter.map_or(true, |expected| kind == expected))
                .try_fold(0_usize, |count, (record_id, _, payload)| {
                    let value: serde_json::Value =
                        serde_json::from_slice(&payload).map_err(|_| {
                            invalid(&format!(
                                "transient expiry cannot prove child safety: {record_id}"
                            ))
                        })?;
                    Ok(count + usize::from(json_references_project(&value, &project.project_id)))
                })?;
            if matches > 0 {
                retained.push(format!("{}={matches}", domain.label()));
            }
        }
        if retained.is_empty() {
            Ok(())
        } else {
            Err(invalid(&format!(
                "transient expiry refused: durable children require a retention decision: {}",
                retained.join(", ")
            )))
        }
    }

    /// A project deletes only when nothing still references it: no attached
    /// resources, refs, or records in any scanned domain.
    pub(super) fn refuse_delete_with_retained_records(
        &self,
        project: &nucleus_projects::ProjectStorageRecord,
    ) -> CommandResult<R> {
        let mut retained: Vec<String> = Vec::new();
        if !project.resources.is_empty() {
            retained.push(format!("resources={}", project.resources.len()));
        }
        for domain in EngineProjectScanDomain::ALL {
            let matches = self
                .repository
                .domain_payloads(domain)
                .map_err(EngineProjectCommandError::Storage)?
                .into_iter()
                .try_fold(0_usize, |count, (record_id, _, payload)| {
                    let value: serde_json::Value =
                        serde_json::from_slice(&payload).map_err(|_| {
                            invalid(&format!(
                                "project deletion cannot prove retained record safety: {record_id}"
                            ))
                        })?;
                    Ok(count + usize::from(json_references_project(&value, &project.project_id)))
                })?;
            if matches > 0 {
                retained.push(format!("{}={matches}", domain.label()));
            }
        }
        if retained.is_empty() {
            Ok(())
        } else {
            Err(invalid(&format!(
                "project deletion refused: retained {}",
                retained.join(", ")
            )))
        }
    }
}

fn json_references_project(value: &serde_json::Value, project_id: &str) -> bool {
    match value {
        serde_json::Value::Object(values) => values.iter().any(|(key, value)| {
            matches!(key.as_str(), "project_id" | "project_ref")
                && value.as_str() == Some(project_id)
                || json_references_project(value, project_id)
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_references_project(value, project_id)),
        _ => false,
    }
}
