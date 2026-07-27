use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};

use crate::ServerStateService;

use super::{ScmWorkingCopyCommitReceipt, ScmWorkingCopyCommitRequest};

pub(super) const RECEIPT_SCHEMA_VERSION: u16 = 1;
const RECEIPT_PREFIX: &str = "scm-working-copy-commit:";

pub(super) fn request_fingerprint(
    request: &ScmWorkingCopyCommitRequest,
    message_digest: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [
        request.project_id.as_str(),
        request.resource_id.as_str(),
        request.expected_status_fingerprint.as_str(),
        message_digest,
    ] {
        hash_field(&mut hasher, value);
    }
    format!("scm-commit-request:{}", hasher.finalize().to_hex())
}

pub(super) fn receipt_id(idempotency_key: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!(
        "{RECEIPT_PREFIX}{}",
        blake3::hash(idempotency_key.as_bytes()).to_hex()
    ))
}

pub(super) fn read_receipt<B>(
    state: &ServerStateService<B>,
    idempotency_key: &str,
) -> Result<Option<ScmWorkingCopyCommitReceipt>, String>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .get(&receipt_id(idempotency_key))
        .map_err(store_error)?
        .map(|record| decode_receipt(&record.payload.bytes))
        .transpose()
}

pub(super) fn persist_receipt<B>(
    state: &ServerStateService<B>,
    receipt: &ScmWorkingCopyCommitReceipt,
) -> Result<(), String>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(receipt)
        .map_err(|error| format!("working-copy commit receipt encode failed: {error}"))?;
    state
        .artifact_metadata()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(receipt.receipt_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId(format!("rev:{}", receipt.receipt_id)),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .map_err(store_error)?;
    Ok(())
}

pub(super) fn valid_object_id(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn digest(prefix: &str, value: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hash_field(&mut hasher, prefix);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
    format!("{prefix}:{}", hasher.finalize().to_hex())
}

fn decode_receipt(bytes: &[u8]) -> Result<ScmWorkingCopyCommitReceipt, String> {
    let receipt: ScmWorkingCopyCommitReceipt = serde_json::from_slice(bytes)
        .map_err(|error| format!("working-copy commit receipt decode failed: {error}"))?;
    if receipt.schema_version != RECEIPT_SCHEMA_VERSION {
        return Err(format!(
            "unsupported working-copy commit receipt schema: {}",
            receipt.schema_version
        ));
    }
    Ok(receipt)
}

fn hash_field(hasher: &mut blake3::Hasher, value: &str) {
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn store_error(error: LocalStoreError) -> String {
    format!("working-copy commit receipt persistence failed: {error:?}")
}
