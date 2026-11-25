//! Read-only Barge class lookup through the versioned CLI contract.

use std::{path::PathBuf, process::Command};

use serde::Deserialize;

use crate::StorageError;

#[derive(Deserialize)]
struct Reply {
    schema: String,
    data: ClassPath,
}

#[derive(Deserialize)]
struct ClassPath {
    path: PathBuf,
    fallback: bool,
}

#[derive(Deserialize)]
struct Failure {
    schema: String,
    error: FailureDetails,
}

#[derive(Deserialize)]
struct FailureDetails {
    message: String,
}

pub(crate) fn class_path(class: &'static str) -> Result<PathBuf, StorageError> {
    project_class(class, "nucleus")
}

pub(crate) fn project_class(class: &'static str, project: &str) -> Result<PathBuf, StorageError> {
    let refusal = |reason| StorageError::BargePlacement { class, reason };
    let output = Command::new("barge")
        .args(["--json", "path", class, "--project", project])
        .output()
        .map_err(|error| refusal(format!("could not run barge ({error})")))?;
    if !output.status.success() {
        let reason = serde_json::from_slice::<Failure>(&output.stderr)
            .ok()
            .filter(|failure| failure.schema == "barge.error/1")
            .map_or_else(
                || format!("barge exited with {}", output.status),
                |failure| failure.error.message,
            );
        return Err(refusal(reason));
    }
    let reply: Reply = serde_json::from_slice(&output.stdout)
        .map_err(|_| refusal("invalid barge.path/1 response".into()))?;
    if reply.schema != "barge.path/1" {
        return Err(refusal("invalid barge.path/1 response".into()));
    }
    if reply.data.fallback {
        return Err(refusal("the configured volume is absent".into()));
    }
    if !reply.data.path.is_absolute() || !reply.data.path.ends_with(project) {
        return Err(refusal("invalid Nucleus project path".into()));
    }
    Ok(reply.data.path)
}
