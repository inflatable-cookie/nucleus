use std::io::Write;
use std::process::Command;
use std::process::Stdio;

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::{
    inspect_scm_working_copy, working_copy_mutation_guard, ScmWorkingCopyInspection,
    ScmWorkingCopyInspectionRequest,
};
use receipt::{
    persist_receipt, read_receipt, receipt_id, request_fingerprint, RECEIPT_SCHEMA_VERSION,
};
use validation::{ready_fingerprint, validate_observed_paths, validate_request};

mod receipt;
mod validation;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmWorkingCopyMutationAction {
    Stage,
    Unstage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyMutationRequest {
    pub project_id: String,
    pub resource_id: String,
    pub action: ScmWorkingCopyMutationAction,
    pub paths: Vec<String>,
    pub expected_status_fingerprint: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyMutationReceipt {
    pub schema_version: u16,
    pub receipt_id: String,
    pub project_id: String,
    pub resource_id: String,
    pub action: ScmWorkingCopyMutationAction,
    pub paths: Vec<String>,
    pub expected_status_fingerprint: String,
    pub before_status_fingerprint: String,
    pub after_status_fingerprint: String,
    pub idempotency_key: String,
    pub request_fingerprint: String,
    pub operator_ref: String,
    pub execution_host_ref: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyMutationResult {
    pub receipt: ScmWorkingCopyMutationReceipt,
    pub inspection: ScmWorkingCopyInspection,
}

pub fn mutate_scm_working_copy<B>(
    state: &ServerStateService<B>,
    execution_host_ref: &str,
    operator_ref: &str,
    request: &ScmWorkingCopyMutationRequest,
) -> Result<ScmWorkingCopyMutationResult, String>
where
    B: LocalStoreBackend,
{
    let paths = validate_request(request, execution_host_ref, operator_ref)?;
    let request_fingerprint = request_fingerprint(request, &paths);
    let _guard = working_copy_mutation_guard()?;

    if let Some(receipt) = read_receipt(state, &request.idempotency_key)? {
        if receipt.request_fingerprint != request_fingerprint
            || receipt.operator_ref != operator_ref
            || receipt.execution_host_ref != execution_host_ref
        {
            return Err(
                "working-copy idempotency key is already bound to another request".to_owned(),
            );
        }
        let inspection = inspect_scm_working_copy(
            state,
            &ScmWorkingCopyInspectionRequest {
                project_id: request.project_id.clone(),
                resource_id: request.resource_id.clone(),
            },
        );
        let mut receipt = receipt;
        receipt.replayed = true;
        return Ok(ScmWorkingCopyMutationResult {
            receipt,
            inspection,
        });
    }

    let target =
        resolve_project_resource_target(state, &request.project_id, Some(&request.resource_id))?;
    if target.authority_host_ref != execution_host_ref {
        return Err(format!(
            "working-copy mutation must run on resource authority host {}",
            target.authority_host_ref
        ));
    }
    if !target.root.join(".git").exists() {
        return Err("resource root is not a Git working copy".to_owned());
    }

    let inspection_request = ScmWorkingCopyInspectionRequest {
        project_id: request.project_id.clone(),
        resource_id: request.resource_id.clone(),
    };
    let before = inspect_scm_working_copy(state, &inspection_request);
    let before_fingerprint = ready_fingerprint(&before)?;
    if before_fingerprint != request.expected_status_fingerprint {
        return Err("working-copy status changed; refresh before staging".to_owned());
    }
    let command_paths = validate_observed_paths(&before, request.action, &paths)?;

    let mut command = Command::new("git");
    command.arg("--no-optional-locks");
    match request.action {
        ScmWorkingCopyMutationAction::Stage => {
            command.args([
                "add",
                "--all",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]);
        }
        ScmWorkingCopyMutationAction::Unstage => {
            command.args(["reset", "--pathspec-from-file=-", "--pathspec-file-nul"]);
        }
    }
    let mut child = command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .current_dir(&target.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Git index mutation could not start: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Git index mutation path input is unavailable".to_owned())?;
    for path in &command_paths {
        stdin
            .write_all(path.as_bytes())
            .and_then(|_| stdin.write_all(&[0]))
            .map_err(|error| format!("Git index mutation paths could not be sent: {error}"))?;
    }
    drop(stdin);
    let status = child
        .wait()
        .map_err(|error| format!("Git index mutation could not finish: {error}"))?;
    if !status.success() {
        return Err(match request.action {
            ScmWorkingCopyMutationAction::Stage => "Git stage failed".to_owned(),
            ScmWorkingCopyMutationAction::Unstage => "Git unstage failed".to_owned(),
        });
    }

    let after = inspect_scm_working_copy(state, &inspection_request);
    let after_fingerprint = ready_fingerprint(&after)?;
    let receipt_id = receipt_id(&request.idempotency_key);
    let receipt = ScmWorkingCopyMutationReceipt {
        schema_version: RECEIPT_SCHEMA_VERSION,
        receipt_id: receipt_id.0.clone(),
        project_id: request.project_id.clone(),
        resource_id: request.resource_id.clone(),
        action: request.action,
        paths,
        expected_status_fingerprint: request.expected_status_fingerprint.clone(),
        before_status_fingerprint: before_fingerprint.to_owned(),
        after_status_fingerprint: after_fingerprint.to_owned(),
        idempotency_key: request.idempotency_key.clone(),
        request_fingerprint,
        operator_ref: operator_ref.to_owned(),
        execution_host_ref: execution_host_ref.to_owned(),
        replayed: false,
    };
    persist_receipt(state, &receipt)?;
    Ok(ScmWorkingCopyMutationResult {
        receipt,
        inspection: after,
    })
}

#[cfg(test)]
mod tests;
