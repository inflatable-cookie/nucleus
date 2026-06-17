use std::path::PathBuf;

use nucleus_command_policy::{CommandArtifactPayloadClass, CommandArtifactRef, CommandRequestId};

use crate::artifact_store_backend::ArtifactStoreBackendEvidenceRef;
use crate::host_authority::EngineHostId;

/// Stable id for a local artifact metadata record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LocalArtifactMetadataId(pub String);

/// Local artifact-store backend configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalArtifactStoreBackend {
    pub execution_host_id: EngineHostId,
    pub state_root: PathBuf,
    pub accepted_payload_classes: Vec<CommandArtifactPayloadClass>,
}

/// Sanitized artifact metadata stored under the local state root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalArtifactMetadataRecord {
    pub id: LocalArtifactMetadataId,
    pub artifact_ref: CommandArtifactRef,
    pub command_request_id: CommandRequestId,
    pub payload_class: CommandArtifactPayloadClass,
    pub declared_payload_bytes: u64,
    pub retention_evidence_ref: ArtifactStoreBackendEvidenceRef,
    pub redaction_evidence_ref: ArtifactStoreBackendEvidenceRef,
    pub summary: Option<String>,
}

/// Filesystem metadata store for sanitized artifact records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalArtifactMetadataStore {
    pub(crate) state_root: PathBuf,
    pub(crate) accepted_payload_classes: Vec<CommandArtifactPayloadClass>,
}

/// Local artifact-store failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalArtifactStoreError {
    InvalidMetadataId(String),
    UnsupportedPayloadClass(CommandArtifactPayloadClass),
    SummaryTooLarge {
        max_bytes: usize,
        actual_bytes: usize,
    },
    SecretMaterialMarkerDetected(String),
    HostMismatch {
        expected: EngineHostId,
        actual: EngineHostId,
    },
    Io(String),
    Codec(String),
}
