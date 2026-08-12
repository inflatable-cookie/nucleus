//! Shared project command helpers: identity derivation, request
//! fingerprints, and error constructors.
//!
//! Split from the service god file; behavior unchanged.

use nucleus_projects::ProjectId;

use super::super::model::EngineProjectCommandError;

pub(super) fn project_id_for_create(idempotency_key: &str) -> ProjectId {
    let hash = blake3::hash(idempotency_key.as_bytes())
        .to_hex()
        .to_string();
    ProjectId(format!("project:{}", &hash[..24]))
}

pub(super) fn request_fingerprint(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

pub(super) fn invalid<E>(reason: &str) -> EngineProjectCommandError<E> {
    EngineProjectCommandError::InvalidRequest {
        reason: reason.to_owned(),
    }
}

pub(super) fn codec_error<E>(
    error: nucleus_projects::ProjectRecordCodecError,
) -> EngineProjectCommandError<E> {
    EngineProjectCommandError::Codec {
        reason: error.reason,
    }
}
