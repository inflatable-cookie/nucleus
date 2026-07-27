use super::super::{
    ScmWorkingCopyChangeKind, ScmWorkingCopyInspection, ScmWorkingCopyInspectionState,
};
use super::receipt::action_name;
use super::{ScmWorkingCopyMutationAction, ScmWorkingCopyMutationRequest};

const MAX_MUTATION_PATHS: usize = 5_000;

pub(super) fn validate_request(
    request: &ScmWorkingCopyMutationRequest,
    execution_host_ref: &str,
    operator_ref: &str,
) -> Result<Vec<String>, String> {
    if request.project_id.trim().is_empty()
        || request.resource_id.trim().is_empty()
        || request.expected_status_fingerprint.trim().is_empty()
        || request.idempotency_key.trim().is_empty()
        || execution_host_ref.trim().is_empty()
        || operator_ref.trim().is_empty()
    {
        return Err("working-copy mutation request is incomplete".to_owned());
    }
    if request.project_id.len() > 512
        || request.resource_id.len() > 512
        || request.expected_status_fingerprint.len() > 128
        || request.idempotency_key.len() > 256
        || execution_host_ref.len() > 256
        || operator_ref.len() > 256
    {
        return Err("working-copy mutation request exceeds its size limit".to_owned());
    }
    if request.paths.is_empty() || request.paths.len() > MAX_MUTATION_PATHS {
        return Err(format!(
            "working-copy mutation requires 1 to {MAX_MUTATION_PATHS} paths"
        ));
    }
    let mut paths = request.paths.clone();
    if paths
        .iter()
        .any(|path| path.trim().is_empty() || path.len() > 4096)
    {
        return Err("working-copy mutation path is empty or too long".to_owned());
    }
    paths.sort();
    paths.dedup();
    if paths.len() != request.paths.len() {
        return Err("working-copy mutation paths must be unique".to_owned());
    }
    Ok(paths)
}

pub(super) fn validate_observed_paths(
    inspection: &ScmWorkingCopyInspection,
    action: ScmWorkingCopyMutationAction,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let mut command_paths = paths.to_vec();
    for path in paths {
        let file = inspection
            .files
            .iter()
            .find(|file| file.path == *path)
            .ok_or_else(|| format!("working-copy path is no longer observed: {path}"))?;
        if file.change_kind == ScmWorkingCopyChangeKind::Conflicted {
            return Err(format!(
                "working-copy conflict staging is not admitted: {path}"
            ));
        }
        let eligible = match action {
            ScmWorkingCopyMutationAction::Stage => file.unstaged,
            ScmWorkingCopyMutationAction::Unstage => file.staged,
        };
        if !eligible {
            return Err(format!(
                "working-copy path is not eligible for {}: {path}",
                action_name(action)
            ));
        }
        if let Some(original_path) = file.original_path.as_ref() {
            command_paths.push(original_path.clone());
        }
    }
    command_paths.sort();
    command_paths.dedup();
    Ok(command_paths)
}

pub(super) fn ready_fingerprint(inspection: &ScmWorkingCopyInspection) -> Result<&str, String> {
    if inspection.state != ScmWorkingCopyInspectionState::Ready {
        return Err(inspection
            .error
            .clone()
            .unwrap_or_else(|| "working-copy status is unavailable".to_owned()));
    }
    inspection
        .status_fingerprint
        .as_deref()
        .ok_or_else(|| "working-copy status fingerprint is unavailable".to_owned())
}
