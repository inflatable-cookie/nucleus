use std::io::Write;
use std::process::{Command, Stdio};

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::{
    inspect_scm_working_copy, working_copy_mutation_guard, ScmWorkingCopyChangeKind,
    ScmWorkingCopyInspection, ScmWorkingCopyInspectionRequest, ScmWorkingCopyInspectionState,
};
use receipt::{
    digest, persist_receipt, read_receipt, receipt_id, request_fingerprint, valid_object_id,
    RECEIPT_SCHEMA_VERSION,
};

const MAX_COMMIT_MESSAGE_BYTES: usize = 16 * 1024;

mod receipt;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyCommitRequest {
    pub project_id: String,
    pub resource_id: String,
    pub message: String,
    pub expected_status_fingerprint: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyCommitReceipt {
    pub schema_version: u16,
    pub receipt_id: String,
    pub project_id: String,
    pub resource_id: String,
    pub staged_paths: Vec<String>,
    pub message_digest: String,
    pub expected_status_fingerprint: String,
    pub before_status_fingerprint: String,
    pub after_status_fingerprint: String,
    pub previous_head_oid: Option<String>,
    pub commit_oid: String,
    pub idempotency_key: String,
    pub request_fingerprint: String,
    pub operator_ref: String,
    pub execution_host_ref: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkingCopyCommitResult {
    pub receipt: ScmWorkingCopyCommitReceipt,
    pub inspection: ScmWorkingCopyInspection,
}

pub fn commit_scm_working_copy<B>(
    state: &ServerStateService<B>,
    execution_host_ref: &str,
    operator_ref: &str,
    request: &ScmWorkingCopyCommitRequest,
) -> Result<ScmWorkingCopyCommitResult, String>
where
    B: LocalStoreBackend,
{
    validate_request(request, execution_host_ref, operator_ref)?;
    let message_digest = digest("scm-commit-message", request.message.as_bytes());
    let request_fingerprint = request_fingerprint(request, &message_digest);
    let _guard = working_copy_mutation_guard()?;

    if let Some(receipt) = read_receipt(state, &request.idempotency_key)? {
        if receipt.request_fingerprint != request_fingerprint
            || receipt.operator_ref != operator_ref
            || receipt.execution_host_ref != execution_host_ref
        {
            return Err("commit idempotency key is already bound to another request".to_owned());
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
        return Ok(ScmWorkingCopyCommitResult {
            receipt,
            inspection,
        });
    }

    let target =
        resolve_project_resource_target(state, &request.project_id, Some(&request.resource_id))?;
    if target.authority_host_ref != execution_host_ref {
        return Err(format!(
            "working-copy commit must run on resource authority host {}",
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
        return Err("working-copy status changed; refresh before committing".to_owned());
    }
    if before
        .files
        .iter()
        .any(|file| file.change_kind == ScmWorkingCopyChangeKind::Conflicted)
    {
        return Err("working-copy conflicts must be resolved before committing".to_owned());
    }
    let mut staged_paths = before
        .files
        .iter()
        .filter(|file| file.staged)
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    staged_paths.sort();
    staged_paths.dedup();
    if staged_paths.is_empty() {
        return Err("working-copy commit requires staged changes".to_owned());
    }

    let mut child = Command::new("git")
        .args([
            "--no-optional-locks",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--no-gpg-sign",
            "--file",
            "-",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("LC_ALL", "C")
        .current_dir(&target.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Git commit could not start: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Git commit message input is unavailable".to_owned())?
        .write_all(request.message.as_bytes())
        .map_err(|error| format!("Git commit message could not be sent: {error}"))?;
    let status = child
        .wait()
        .map_err(|error| format!("Git commit could not finish: {error}"))?;
    if !status.success() {
        return Err("Git commit failed; check repository identity and staged state".to_owned());
    }

    let after = inspect_scm_working_copy(state, &inspection_request);
    let after_fingerprint = ready_fingerprint(&after)?;
    let commit_oid = after
        .head_oid
        .clone()
        .filter(|oid| valid_object_id(oid))
        .ok_or_else(|| "Git commit completed without a valid resulting object id".to_owned())?;
    if before.head_oid.as_ref() == Some(&commit_oid) {
        return Err("Git commit did not advance the repository head".to_owned());
    }

    let receipt_id = receipt_id(&request.idempotency_key);
    let receipt = ScmWorkingCopyCommitReceipt {
        schema_version: RECEIPT_SCHEMA_VERSION,
        receipt_id: receipt_id.0.clone(),
        project_id: request.project_id.clone(),
        resource_id: request.resource_id.clone(),
        staged_paths,
        message_digest,
        expected_status_fingerprint: request.expected_status_fingerprint.clone(),
        before_status_fingerprint: before_fingerprint.to_owned(),
        after_status_fingerprint: after_fingerprint.to_owned(),
        previous_head_oid: before.head_oid,
        commit_oid,
        idempotency_key: request.idempotency_key.clone(),
        request_fingerprint,
        operator_ref: operator_ref.to_owned(),
        execution_host_ref: execution_host_ref.to_owned(),
        replayed: false,
    };
    persist_receipt(state, &receipt)?;
    Ok(ScmWorkingCopyCommitResult {
        receipt,
        inspection: after,
    })
}

fn validate_request(
    request: &ScmWorkingCopyCommitRequest,
    execution_host_ref: &str,
    operator_ref: &str,
) -> Result<(), String> {
    if request.project_id.trim().is_empty()
        || request.resource_id.trim().is_empty()
        || request.message.trim().is_empty()
        || request.expected_status_fingerprint.trim().is_empty()
        || request.idempotency_key.trim().is_empty()
        || execution_host_ref.trim().is_empty()
        || operator_ref.trim().is_empty()
    {
        return Err("working-copy commit request is incomplete".to_owned());
    }
    if request.message.len() > MAX_COMMIT_MESSAGE_BYTES || request.message.contains('\0') {
        return Err("commit message is too long or contains invalid content".to_owned());
    }
    if request.project_id.len() > 512
        || request.resource_id.len() > 512
        || request.expected_status_fingerprint.len() > 128
        || request.idempotency_key.len() > 256
        || execution_host_ref.len() > 256
        || operator_ref.len() > 256
    {
        return Err("working-copy commit request exceeds its size limit".to_owned());
    }
    Ok(())
}

fn ready_fingerprint(inspection: &ScmWorkingCopyInspection) -> Result<&str, String> {
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

#[cfg(test)]
mod tests;
