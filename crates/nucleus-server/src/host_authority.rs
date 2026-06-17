//! Engine host and project authority-map vocabulary.
//!
//! These types describe authority assignment only. They do not implement host
//! discovery, remote transport, auth, persistence, or synchronization.

use nucleus_projects::ProjectId;

/// Stable engine host id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineHostId(pub String);

/// Form of a running engine host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineHostForm {
    EmbeddedDesktop,
    LocalSidecar,
    RemoteAuthoritative,
    RemoteWorkerProxy,
    ManagedTeam,
    Custom(String),
}

/// Connected host descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineHostDescriptor {
    pub id: EngineHostId,
    pub display_name: String,
    pub form: EngineHostForm,
    pub location_hint: Option<String>,
}

/// Project authority domain assigned to an engine host.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ProjectAuthorityDomain {
    Project,
    Source,
    Task,
    Workspace,
    Session,
    Execution,
    ScmForge,
    Memory,
    Planning,
    Research,
    Credential,
    AuditEvidence,
    Projection,
    Custom(String),
}

/// One authority-domain assignment for a project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityAssignment {
    pub domain: ProjectAuthorityDomain,
    pub authoritative_host_id: EngineHostId,
    pub fallback_host_ids: Vec<EngineHostId>,
    pub mutation_allowed: bool,
    pub note: Option<String>,
}

/// Authority map for one project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityMap {
    pub project_id: ProjectId,
    pub assignments: Vec<ProjectAuthorityAssignment>,
}

/// Authority readiness for one host/domain pair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostAuthorityReadiness {
    pub host_id: EngineHostId,
    pub domain: ProjectAuthorityDomain,
    pub status: HostAuthorityReadinessStatus,
    pub assignment: Option<ProjectAuthorityAssignment>,
}

/// Result of an authority readiness check.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostAuthorityReadinessStatus {
    Ready,
    NoAssignment,
    AssignedToDifferentHost { authoritative_host_id: EngineHostId },
    MutationDenied,
}

impl ProjectAuthorityMap {
    /// Return the assignment for a domain when present.
    pub fn assignment_for(
        &self,
        domain: &ProjectAuthorityDomain,
    ) -> Option<&ProjectAuthorityAssignment> {
        self.assignments
            .iter()
            .find(|assignment| &assignment.domain == domain)
    }

    /// Return true only when the host is authoritative for the domain.
    pub fn host_owns_domain(
        &self,
        host_id: &EngineHostId,
        domain: &ProjectAuthorityDomain,
    ) -> bool {
        self.assignment_for(domain)
            .map(|assignment| &assignment.authoritative_host_id == host_id)
            .unwrap_or(false)
    }

    /// Check whether a host can mutate one authority domain.
    pub fn readiness_for(
        &self,
        host_id: &EngineHostId,
        domain: &ProjectAuthorityDomain,
    ) -> HostAuthorityReadiness {
        match self.assignment_for(domain) {
            None => HostAuthorityReadiness {
                host_id: host_id.clone(),
                domain: domain.clone(),
                status: HostAuthorityReadinessStatus::NoAssignment,
                assignment: None,
            },
            Some(assignment) if &assignment.authoritative_host_id != host_id => {
                HostAuthorityReadiness {
                    host_id: host_id.clone(),
                    domain: domain.clone(),
                    status: HostAuthorityReadinessStatus::AssignedToDifferentHost {
                        authoritative_host_id: assignment.authoritative_host_id.clone(),
                    },
                    assignment: Some(assignment.clone()),
                }
            }
            Some(assignment) if !assignment.mutation_allowed => HostAuthorityReadiness {
                host_id: host_id.clone(),
                domain: domain.clone(),
                status: HostAuthorityReadinessStatus::MutationDenied,
                assignment: Some(assignment.clone()),
            },
            Some(assignment) => HostAuthorityReadiness {
                host_id: host_id.clone(),
                domain: domain.clone(),
                status: HostAuthorityReadinessStatus::Ready,
                assignment: Some(assignment.clone()),
            },
        }
    }
}

impl HostAuthorityReadiness {
    /// Returns true when the host owns the domain and mutation is allowed.
    pub fn is_ready(&self) -> bool {
        self.status == HostAuthorityReadinessStatus::Ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str) -> EngineHostId {
        EngineHostId(id.to_owned())
    }

    #[test]
    fn connected_host_is_not_authoritative_without_assignment() {
        let local = host("host:local");
        let remote = host("host:remote-worker");
        let map = ProjectAuthorityMap {
            project_id: ProjectId("project:nucleus".to_owned()),
            assignments: vec![ProjectAuthorityAssignment {
                domain: ProjectAuthorityDomain::Execution,
                authoritative_host_id: remote.clone(),
                fallback_host_ids: Vec::new(),
                mutation_allowed: true,
                note: Some("remote worker can execute but owns no source".to_owned()),
            }],
        };

        assert!(!map.host_owns_domain(&local, &ProjectAuthorityDomain::Execution));
        assert!(map.host_owns_domain(&remote, &ProjectAuthorityDomain::Execution));
        assert!(!map.host_owns_domain(&remote, &ProjectAuthorityDomain::Source));
        assert!(!map.host_owns_domain(&remote, &ProjectAuthorityDomain::Task));
    }

    #[test]
    fn embedded_desktop_can_own_all_local_single_user_domains() {
        let local = host("host:embedded-desktop");
        let assignments = [
            ProjectAuthorityDomain::Project,
            ProjectAuthorityDomain::Source,
            ProjectAuthorityDomain::Task,
            ProjectAuthorityDomain::Workspace,
            ProjectAuthorityDomain::Session,
            ProjectAuthorityDomain::Execution,
        ]
        .into_iter()
        .map(|domain| ProjectAuthorityAssignment {
            domain,
            authoritative_host_id: local.clone(),
            fallback_host_ids: Vec::new(),
            mutation_allowed: true,
            note: None,
        })
        .collect();
        let map = ProjectAuthorityMap {
            project_id: ProjectId("project:local".to_owned()),
            assignments,
        };

        assert!(map.host_owns_domain(&local, &ProjectAuthorityDomain::Project));
        assert!(map.host_owns_domain(&local, &ProjectAuthorityDomain::Execution));
    }

    #[test]
    fn readiness_distinguishes_connection_from_authority() {
        let local = host("host:local");
        let remote = host("host:remote");
        let map = ProjectAuthorityMap {
            project_id: ProjectId("project:nucleus".to_owned()),
            assignments: vec![ProjectAuthorityAssignment {
                domain: ProjectAuthorityDomain::Execution,
                authoritative_host_id: remote.clone(),
                fallback_host_ids: vec![local.clone()],
                mutation_allowed: true,
                note: None,
            }],
        };

        let local_readiness = map.readiness_for(&local, &ProjectAuthorityDomain::Execution);
        let remote_readiness = map.readiness_for(&remote, &ProjectAuthorityDomain::Execution);

        assert_eq!(
            local_readiness.status,
            HostAuthorityReadinessStatus::AssignedToDifferentHost {
                authoritative_host_id: remote
            }
        );
        assert!(!local_readiness.is_ready());
        assert!(remote_readiness.is_ready());
    }

    #[test]
    fn readiness_can_block_mutation_even_for_authoritative_host() {
        let local = host("host:local");
        let map = ProjectAuthorityMap {
            project_id: ProjectId("project:nucleus".to_owned()),
            assignments: vec![ProjectAuthorityAssignment {
                domain: ProjectAuthorityDomain::Projection,
                authoritative_host_id: local.clone(),
                fallback_host_ids: Vec::new(),
                mutation_allowed: false,
                note: Some("projection is read-only during repair".to_owned()),
            }],
        };

        let readiness = map.readiness_for(&local, &ProjectAuthorityDomain::Projection);

        assert_eq!(
            readiness.status,
            HostAuthorityReadinessStatus::MutationDenied
        );
        assert!(!readiness.is_ready());
    }
}
