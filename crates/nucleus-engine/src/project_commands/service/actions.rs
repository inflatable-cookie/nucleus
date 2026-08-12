//! Project lifecycle action application and naming.
//!
//! Split from the service god file; behavior unchanged.

use super::helpers::invalid;
use super::super::model::EngineProjectCommandError;
use super::super::model::EngineProjectLifecycleAction;

pub(super) fn apply_action<E>(
    project: &mut nucleus_projects::ProjectStorageRecord,
    action: &EngineProjectLifecycleAction,
) -> Result<(), EngineProjectCommandError<E>> {
    match action {
        EngineProjectLifecycleAction::Rename { display_name } => {
            let display_name = display_name.trim();
            if display_name.is_empty() {
                return Err(invalid("project name must not be empty"));
            }
            project.display_name = display_name.to_owned();
        }
        EngineProjectLifecycleAction::Park => {
            project.status = nucleus_projects::ProjectStorageStatus::Parked
        }
        EngineProjectLifecycleAction::Archive => {
            project.status = nucleus_projects::ProjectStorageStatus::Archived
        }
        EngineProjectLifecycleAction::Restore => {
            project.status = nucleus_projects::ProjectStorageStatus::Active
        }
        EngineProjectLifecycleAction::Promote { display_name } => {
            if project.retention != nucleus_projects::ProjectRetentionStorage::Transient {
                return Err(invalid("only transient projects can be promoted"));
            }
            project.retention = nucleus_projects::ProjectRetentionStorage::Durable;
            if let Some(display_name) = display_name {
                let display_name = display_name.trim();
                if display_name.is_empty() {
                    return Err(invalid("project name must not be empty"));
                }
                project.display_name = display_name.to_owned();
            }
        }
        EngineProjectLifecycleAction::Delete | EngineProjectLifecycleAction::ExpireTransient => {
            unreachable!("delete and expiry handled before update")
        }
    }
    Ok(())
}

pub(super) fn action_name(action: &EngineProjectLifecycleAction) -> &'static str {
    match action {
        EngineProjectLifecycleAction::Rename { .. } => "rename",
        EngineProjectLifecycleAction::Park => "park",
        EngineProjectLifecycleAction::Archive => "archive",
        EngineProjectLifecycleAction::Restore => "restore",
        EngineProjectLifecycleAction::Delete => "delete",
        EngineProjectLifecycleAction::Promote { .. } => "promote",
        EngineProjectLifecycleAction::ExpireTransient => "expire-transient",
    }
}

pub(super) fn action_value(action: &EngineProjectLifecycleAction) -> &str {
    match action {
        EngineProjectLifecycleAction::Rename { display_name } => display_name.trim(),
        EngineProjectLifecycleAction::Promote {
            display_name: Some(display_name),
        } => display_name.trim(),
        _ => "",
    }
}
