use crate::host_authority::{EngineHostDescriptor, EngineHostForm, ProjectAuthorityDomain};

use super::ClientProtocolProfile;

/// Client-visible host capability advertisement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostCapabilityAdvertisement {
    pub host: EngineHostDescriptor,
    pub connection_mode: HostConnectionMode,
    pub protocol: ClientProtocolProfile,
    pub status: HostCapabilityAdvertisementStatus,
    pub capabilities: Vec<HostCapabilityCategory>,
    pub authority_map: HostAuthorityMapPublication,
    pub runtime_readiness: HostRuntimeReadinessPublication,
}

impl HostCapabilityAdvertisement {
    /// Build a local embedded-host advertisement for the first desktop proof.
    pub fn embedded_local(
        host: EngineHostDescriptor,
        domains: Vec<ProjectAuthorityDomain>,
    ) -> Self {
        Self {
            host,
            connection_mode: HostConnectionMode::Embedded,
            protocol: ClientProtocolProfile::v1_control_and_events(),
            status: HostCapabilityAdvertisementStatus::Available,
            capabilities: vec![
                HostCapabilityCategory::ControlRequests,
                HostCapabilityCategory::StateQueries,
                HostCapabilityCategory::EventReplay,
                HostCapabilityCategory::RuntimeReadiness,
            ],
            authority_map: HostAuthorityMapPublication::Published { domains },
            runtime_readiness: HostRuntimeReadinessPublication::Published {
                refs: vec![HostCapabilityReadinessRef {
                    name: "local-runtime-readiness".to_owned(),
                    status: HostCapabilityReadinessStatus::Ready,
                }],
            },
        }
    }

    /// Build a remote worker advertisement without project authority.
    pub fn remote_worker_deferred(host: EngineHostDescriptor) -> Self {
        Self {
            host,
            connection_mode: HostConnectionMode::RemoteWorker,
            protocol: ClientProtocolProfile::v1_control_and_events(),
            status: HostCapabilityAdvertisementStatus::Deferred {
                reason: "remote worker auth and transport are not implemented".to_owned(),
            },
            capabilities: vec![
                HostCapabilityCategory::ControlRequests,
                HostCapabilityCategory::RuntimeReadiness,
                HostCapabilityCategory::Custom("worker-proxy".to_owned()),
            ],
            authority_map: HostAuthorityMapPublication::Unsupported {
                reason: "remote workers do not become authoritative by connection".to_owned(),
            },
            runtime_readiness: HostRuntimeReadinessPublication::Deferred {
                reason: "live remote readiness probe is not implemented".to_owned(),
            },
        }
    }

    /// Returns true only when the advertisement says a domain is published.
    pub fn publishes_authority_domain(&self, domain: &ProjectAuthorityDomain) -> bool {
        match &self.authority_map {
            HostAuthorityMapPublication::Published { domains } => domains.contains(domain),
            HostAuthorityMapPublication::Deferred { .. }
            | HostAuthorityMapPublication::Unsupported { .. } => false,
        }
    }

    /// Returns true when the advertisement has the named capability category.
    pub fn advertises(&self, capability: &HostCapabilityCategory) -> bool {
        self.capabilities.contains(capability)
    }
}

/// How a client is connected to the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostConnectionMode {
    Embedded,
    LocalSidecar,
    RemoteAuthoritative,
    RemoteWorker,
    Managed,
    Custom(String),
}

impl From<&EngineHostForm> for HostConnectionMode {
    fn from(form: &EngineHostForm) -> Self {
        match form {
            EngineHostForm::EmbeddedDesktop => Self::Embedded,
            EngineHostForm::LocalSidecar => Self::LocalSidecar,
            EngineHostForm::RemoteAuthoritative => Self::RemoteAuthoritative,
            EngineHostForm::RemoteWorkerProxy => Self::RemoteWorker,
            EngineHostForm::ManagedTeam => Self::Managed,
            EngineHostForm::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

/// Coarse availability of the advertisement itself.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostCapabilityAdvertisementStatus {
    Available,
    Deferred { reason: String },
    Unsupported { reason: String },
}

/// Client-visible capability categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostCapabilityCategory {
    ControlRequests,
    StateQueries,
    EventReplay,
    RuntimeReadiness,
    CommandScheduling,
    HarnessRuntime,
    ScmForge,
    ManagementProjection,
    Custom(String),
}

/// Publication state for host authority-map information.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostAuthorityMapPublication {
    Published {
        domains: Vec<ProjectAuthorityDomain>,
    },
    Deferred {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
}

/// Publication state for runtime readiness information.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostRuntimeReadinessPublication {
    Published {
        refs: Vec<HostCapabilityReadinessRef>,
    },
    Deferred {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
}

/// Reference to a readiness surface advertised by the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostCapabilityReadinessRef {
    pub name: String,
    pub status: HostCapabilityReadinessStatus,
}

/// Readiness status exposed as an advertisement value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostCapabilityReadinessStatus {
    Ready,
    Blocked,
    Deferred,
    Unsupported,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_authority::{EngineHostId, ProjectAuthorityDomain};

    fn host(form: EngineHostForm) -> EngineHostDescriptor {
        EngineHostDescriptor {
            id: EngineHostId("host:local".to_owned()),
            display_name: "Local Host".to_owned(),
            form,
            location_hint: Some("local".to_owned()),
        }
    }

    #[test]
    fn embedded_advertisement_names_protocol_capabilities_and_domains() {
        let advertisement = HostCapabilityAdvertisement::embedded_local(
            host(EngineHostForm::EmbeddedDesktop),
            vec![
                ProjectAuthorityDomain::Project,
                ProjectAuthorityDomain::Task,
                ProjectAuthorityDomain::Execution,
            ],
        );

        assert_eq!(advertisement.connection_mode, HostConnectionMode::Embedded);
        assert!(advertisement.advertises(&HostCapabilityCategory::ControlRequests));
        assert!(advertisement.advertises(&HostCapabilityCategory::RuntimeReadiness));
        assert!(advertisement.publishes_authority_domain(&ProjectAuthorityDomain::Task));
        assert!(!advertisement.publishes_authority_domain(&ProjectAuthorityDomain::ScmForge));
        assert_eq!(advertisement.protocol.family, crate::CLIENT_PROTOCOL_FAMILY);
    }

    #[test]
    fn remote_worker_advertisement_does_not_grant_authority() {
        let advertisement = HostCapabilityAdvertisement::remote_worker_deferred(host(
            EngineHostForm::RemoteWorkerProxy,
        ));

        assert_eq!(
            advertisement.connection_mode,
            HostConnectionMode::RemoteWorker
        );
        assert!(matches!(
            advertisement.status,
            HostCapabilityAdvertisementStatus::Deferred { .. }
        ));
        assert!(matches!(
            advertisement.authority_map,
            HostAuthorityMapPublication::Unsupported { .. }
        ));
        assert!(!advertisement.publishes_authority_domain(&ProjectAuthorityDomain::Execution));
    }

    #[test]
    fn connection_mode_maps_engine_host_form_without_transport_selection() {
        assert_eq!(
            HostConnectionMode::from(&EngineHostForm::LocalSidecar),
            HostConnectionMode::LocalSidecar
        );
        assert_eq!(
            HostConnectionMode::from(&EngineHostForm::RemoteAuthoritative),
            HostConnectionMode::RemoteAuthoritative
        );
        assert_eq!(
            HostConnectionMode::from(&EngineHostForm::ManagedTeam),
            HostConnectionMode::Managed
        );
    }
}
