//! Artifact store backend readiness descriptors.
//!
//! These records describe whether an execution host has an artifact backend
//! ready for command payload retention. They do not store payload bytes, read
//! artifacts, write artifacts, run scanners, redact data, or render artifacts.

use nucleus_command_policy::CommandArtifactPayloadClass;

use crate::host_authority::EngineHostId;

/// Stable artifact store backend evidence ref (shared core type).
pub use nucleus_core::EvidenceRef as ArtifactStoreBackendEvidenceRef;

/// Host artifact store backend family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArtifactStoreBackendKind {
    None,
    Filesystem,
    EmbeddedDatabase,
    ObjectStore,
    ProjectLocalFiles,
    RemoteStore,
    Custom(String),
}

/// Artifact store backend readiness descriptor for one execution host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactStoreBackendReadiness {
    pub execution_host_id: EngineHostId,
    pub backend_kind: ArtifactStoreBackendKind,
    pub supported_payload_classes: Vec<CommandArtifactPayloadClass>,
    pub payload_storage_ready: bool,
    pub retention_evidence_refs: Vec<ArtifactStoreBackendEvidenceRef>,
    pub redaction_evidence_refs: Vec<ArtifactStoreBackendEvidenceRef>,
    pub summary: Option<String>,
}

impl ArtifactStoreBackendReadiness {
    /// Returns true when the backend can retain the requested payload class.
    pub fn supports_payload_class(&self, payload_class: &CommandArtifactPayloadClass) -> bool {
        self.backend_kind != ArtifactStoreBackendKind::None
            && self.payload_storage_ready
            && self.supported_payload_classes.contains(payload_class)
            && !self.retention_evidence_refs.is_empty()
            && !self.redaction_evidence_refs.is_empty()
    }

    /// Returns true when the backend can retain all requested payload classes.
    pub fn supports_payload_classes(
        &self,
        payload_classes: &[CommandArtifactPayloadClass],
    ) -> bool {
        payload_classes
            .iter()
            .all(|payload_class| self.supports_payload_class(payload_class))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    #[test]
    fn artifact_store_backend_requires_payload_storage_ready() {
        let readiness = ArtifactStoreBackendReadiness {
            execution_host_id: host(),
            backend_kind: ArtifactStoreBackendKind::Filesystem,
            supported_payload_classes: vec![CommandArtifactPayloadClass::SanitizedSummary],
            payload_storage_ready: false,
            retention_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:retention".to_owned(),
            )],
            redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:redaction".to_owned(),
            )],
            summary: Some("storage disabled".to_owned()),
        };

        assert!(!readiness.supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));
    }

    #[test]
    fn artifact_store_backend_requires_retention_and_redaction_evidence() {
        let readiness = ArtifactStoreBackendReadiness {
            execution_host_id: host(),
            backend_kind: ArtifactStoreBackendKind::Filesystem,
            supported_payload_classes: vec![CommandArtifactPayloadClass::Stdout],
            payload_storage_ready: true,
            retention_evidence_refs: Vec::new(),
            redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:redaction".to_owned(),
            )],
            summary: Some("retention evidence missing".to_owned()),
        };

        assert!(!readiness.supports_payload_class(&CommandArtifactPayloadClass::Stdout));
    }

    #[test]
    fn artifact_store_backend_can_support_named_payload_classes_without_storing_bytes() {
        let readiness = ArtifactStoreBackendReadiness {
            execution_host_id: host(),
            backend_kind: ArtifactStoreBackendKind::Filesystem,
            supported_payload_classes: vec![
                CommandArtifactPayloadClass::SanitizedSummary,
                CommandArtifactPayloadClass::ValidationReport,
            ],
            payload_storage_ready: true,
            retention_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:retention".to_owned(),
            )],
            redaction_evidence_refs: vec![ArtifactStoreBackendEvidenceRef(
                "evidence:redaction".to_owned(),
            )],
            summary: Some("metadata-only readiness".to_owned()),
        };

        assert!(readiness.supports_payload_class(&CommandArtifactPayloadClass::SanitizedSummary));
        assert!(!readiness.supports_payload_class(&CommandArtifactPayloadClass::Stdout));
    }
}
