//! Local filesystem artifact-store backend boundary.
//!
//! This module stores sanitized artifact metadata under a server state root.
//! It does not store command payload bytes, raw stdout/stderr, terminal
//! transcripts, secret material, run scanners, redact payloads, or resolve
//! artifacts for UI rendering.

use std::fs;
use std::path::PathBuf;

use nucleus_command_policy::CommandArtifactPayloadClass;

use crate::artifact_store_backend::{
    ArtifactStoreBackendEvidenceRef, ArtifactStoreBackendKind, ArtifactStoreBackendReadiness,
};
use crate::host_authority::EngineHostId;
use crate::local_host_runtime_discovery::{
    LocalHostRuntimeDiscovery, LocalHostRuntimeDiscoveryEvidenceRef,
    LocalHostRuntimeDiscoveryFinding, LocalHostRuntimeDiscoveryStatus,
};

mod codec;
mod types;

pub use types::{
    LocalArtifactMetadataId, LocalArtifactMetadataRecord, LocalArtifactMetadataStore,
    LocalArtifactStoreBackend, LocalArtifactStoreError,
};

const METADATA_DIR: &str = "command-artifacts/metadata";

impl LocalArtifactStoreBackend {
    /// Create a local backend with first-slice safe payload classes.
    pub fn new(execution_host_id: EngineHostId, state_root: impl Into<PathBuf>) -> Self {
        Self {
            execution_host_id,
            state_root: state_root.into(),
            accepted_payload_classes: first_slice_payload_classes(),
        }
    }

    /// Return the metadata store without creating directories.
    pub fn metadata_store(&self) -> LocalArtifactMetadataStore {
        LocalArtifactMetadataStore {
            state_root: self.state_root.clone(),
            accepted_payload_classes: self.accepted_payload_classes.clone(),
        }
    }

    /// Create the metadata directory and return the store handle.
    pub fn prepare_metadata_store(
        &self,
    ) -> Result<LocalArtifactMetadataStore, LocalArtifactStoreError> {
        let store = self.metadata_store();
        fs::create_dir_all(store.metadata_dir()).map_err(io_error)?;
        Ok(store)
    }

    /// Report backend readiness from local state-root metadata availability.
    pub fn readiness(&self) -> ArtifactStoreBackendReadiness {
        let metadata_ready = self.metadata_store().metadata_dir().is_dir();
        let evidence_prefix = self.execution_host_id.0.clone();

        ArtifactStoreBackendReadiness {
            execution_host_id: self.execution_host_id.clone(),
            backend_kind: ArtifactStoreBackendKind::Filesystem,
            supported_payload_classes: first_slice_payload_classes(),
            payload_storage_ready: metadata_ready,
            retention_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(format!(
                "evidence:{evidence_prefix}:artifact-store:retention:metadata-only"
            ))],
            redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(format!(
                "evidence:{evidence_prefix}:artifact-store:redaction:sanitized-metadata"
            ))],
            summary: Some(if metadata_ready {
                "local artifact metadata store ready".to_owned()
            } else {
                "local artifact metadata directory missing".to_owned()
            }),
        }
    }
}

impl LocalArtifactMetadataStore {
    /// Return the metadata directory path under the state root.
    pub fn metadata_dir(&self) -> PathBuf {
        self.state_root.join(METADATA_DIR)
    }

    /// Return the metadata file path for one id.
    pub fn metadata_path(
        &self,
        id: &LocalArtifactMetadataId,
    ) -> Result<PathBuf, LocalArtifactStoreError> {
        codec::validate_metadata_id(id)?;
        Ok(self.metadata_dir().join(format!("{}.json", id.0)))
    }

    /// Write sanitized metadata. Payload bytes are never accepted here.
    pub fn write_metadata(
        &self,
        record: &LocalArtifactMetadataRecord,
    ) -> Result<PathBuf, LocalArtifactStoreError> {
        codec::validate_record(record, &self.accepted_payload_classes)?;
        fs::create_dir_all(self.metadata_dir()).map_err(io_error)?;

        let path = self.metadata_path(&record.id)?;
        let payload = codec::encode_metadata_record(record)?;
        fs::write(&path, payload).map_err(io_error)?;
        Ok(path)
    }

    /// Read sanitized metadata by id.
    pub fn read_metadata(
        &self,
        id: &LocalArtifactMetadataId,
    ) -> Result<LocalArtifactMetadataRecord, LocalArtifactStoreError> {
        let path = self.metadata_path(id)?;
        let payload = fs::read(path).map_err(io_error)?;
        codec::decode_metadata_record(&payload)
    }
}

/// Compose concrete local artifact readiness into a discovery descriptor.
pub fn with_local_artifact_store_readiness(
    mut discovery: LocalHostRuntimeDiscovery,
    readiness: ArtifactStoreBackendReadiness,
) -> Result<LocalHostRuntimeDiscovery, LocalArtifactStoreError> {
    if readiness.execution_host_id != discovery.execution_host_id {
        return Err(LocalArtifactStoreError::HostMismatch {
            expected: discovery.execution_host_id,
            actual: readiness.execution_host_id,
        });
    }

    discovery.artifact_store_backend = readiness;
    discovery.findings.retain(|finding| {
        !matches!(
            finding,
            LocalHostRuntimeDiscoveryFinding::ArtifactStoreBackendUnsupported(_)
        )
    });
    discovery
        .evidence_refs
        .push(LocalHostRuntimeDiscoveryEvidenceRef(format!(
            "evidence:{}:local-host-runtime:artifact-store:ready",
            discovery.execution_host_id.0
        )));
    discovery.status = if discovery.findings.is_empty() {
        LocalHostRuntimeDiscoveryStatus::Ready
    } else {
        LocalHostRuntimeDiscoveryStatus::Degraded
    };
    discovery.summary =
        Some("local host runtime discovery with artifact store readiness".to_owned());

    Ok(discovery)
}

fn first_slice_payload_classes() -> Vec<CommandArtifactPayloadClass> {
    vec![
        CommandArtifactPayloadClass::SanitizedSummary,
        CommandArtifactPayloadClass::ValidationReport,
    ]
}

fn io_error(error: std::io::Error) -> LocalArtifactStoreError {
    LocalArtifactStoreError::Io(error.to_string())
}

#[cfg(test)]
mod tests;
