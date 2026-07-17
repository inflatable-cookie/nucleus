//! Process-control backend readiness descriptors.
//!
//! These records describe whether an execution host has process-control
//! mechanics ready for future host spawning. They do not spawn processes,
//! select an async runtime, cancel processes, kill process trees, or run
//! cleanup.

use crate::host_authority::EngineHostId;

/// Stable process-control backend evidence ref (shared core type).
pub use nucleus_core::EvidenceRef as ProcessControlBackendEvidenceRef;

/// Host process-control backend family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessControlBackendKind {
    None,
    StdProcess,
    TokioProcess,
    SystemService,
    Custom(String),
}

/// Process-control backend readiness descriptor for one execution host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessControlBackendReadiness {
    pub execution_host_id: EngineHostId,
    pub backend_kind: ProcessControlBackendKind,
    pub spawn_ready: bool,
    pub timeout_ready: bool,
    pub cancellation_ready: bool,
    pub cleanup_ready: bool,
    pub implementation_evidence_refs: Vec<ProcessControlBackendEvidenceRef>,
    pub summary: Option<String>,
}

impl ProcessControlBackendReadiness {
    /// Returns true when process-control mechanics are ready for future spawn.
    pub fn supports_future_spawn(&self) -> bool {
        self.backend_kind != ProcessControlBackendKind::None
            && self.spawn_ready
            && self.timeout_ready
            && self.cancellation_ready
            && self.cleanup_ready
            && !self.implementation_evidence_refs.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> EngineHostId {
        EngineHostId("host:local".to_owned())
    }

    #[test]
    fn process_control_backend_requires_timeout_cancellation_and_cleanup() {
        let readiness = ProcessControlBackendReadiness {
            execution_host_id: host(),
            backend_kind: ProcessControlBackendKind::StdProcess,
            spawn_ready: true,
            timeout_ready: true,
            cancellation_ready: false,
            cleanup_ready: true,
            implementation_evidence_refs: vec![ProcessControlBackendEvidenceRef(
                "evidence:process-control".to_owned(),
            )],
            summary: Some("cancellation missing".to_owned()),
        };

        assert!(!readiness.supports_future_spawn());
    }

    #[test]
    fn process_control_backend_requires_implementation_evidence() {
        let readiness = ProcessControlBackendReadiness {
            execution_host_id: host(),
            backend_kind: ProcessControlBackendKind::StdProcess,
            spawn_ready: true,
            timeout_ready: true,
            cancellation_ready: true,
            cleanup_ready: true,
            implementation_evidence_refs: Vec::new(),
            summary: Some("evidence missing".to_owned()),
        };

        assert!(!readiness.supports_future_spawn());
    }

    #[test]
    fn process_control_backend_can_name_future_spawn_without_spawning() {
        let readiness = ProcessControlBackendReadiness {
            execution_host_id: host(),
            backend_kind: ProcessControlBackendKind::StdProcess,
            spawn_ready: true,
            timeout_ready: true,
            cancellation_ready: true,
            cleanup_ready: true,
            implementation_evidence_refs: vec![ProcessControlBackendEvidenceRef(
                "evidence:process-control".to_owned(),
            )],
            summary: Some("metadata-only readiness".to_owned()),
        };

        assert!(readiness.supports_future_spawn());
    }
}
