//! Persisted domain boundary for server-local storage.

use nucleus_core::PersistenceDomain;

/// Local store domain category before repository traits exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreDomainBoundary {
    pub domain: PersistenceDomain,
    pub required_for_first_slice: bool,
}

/// Planned first persisted domain set.
///
/// This names storage coverage only. It does not create tables, indexes,
/// repositories, or projection import/export behavior.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalStoreDomainSet {
    pub domains: Vec<LocalStoreDomainBoundary>,
}

impl LocalStoreDomainSet {
    /// Domains that the first storage runway must leave room for.
    pub fn first_slice_plan() -> Self {
        Self {
            domains: vec![
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::Projects,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::Tasks,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::TaskHistory,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::Workspaces,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::SharedMemory,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::Planning,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::DeepResearch,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::ProjectTooling,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::AdapterRegistry,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::AgentSessions,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::ModelRoutes,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::EventJournal,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::CommandEvidence,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::ArtifactMetadata,
                    required_for_first_slice: true,
                },
                LocalStoreDomainBoundary {
                    domain: PersistenceDomain::RuntimeEffects,
                    required_for_first_slice: true,
                },
            ],
        }
    }
}
