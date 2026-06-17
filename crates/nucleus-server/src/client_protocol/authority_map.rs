use nucleus_projects::ProjectId;

use crate::host_authority::{
    EngineHostId, ProjectAuthorityAssignment, ProjectAuthorityDomain, ProjectAuthorityMap,
};

/// Client-visible authority-map publication for one project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityMapPublicationRecord {
    pub project_id: ProjectId,
    pub domains: Vec<ProjectAuthorityDomainPublication>,
    pub issues: Vec<ProjectAuthorityValidationIssue>,
}

impl ProjectAuthorityMapPublicationRecord {
    /// Publish a project authority map for a known set of domains.
    pub fn from_map(
        map: &ProjectAuthorityMap,
        expected_domains: Vec<ProjectAuthorityDomain>,
    ) -> Self {
        let domains = expected_domains
            .into_iter()
            .map(|domain| {
                let assignment = map.assignment_for(&domain);
                ProjectAuthorityDomainPublication::from_assignment(domain, assignment)
            })
            .collect();

        let mut record = Self {
            project_id: map.project_id.clone(),
            domains,
            issues: Vec::new(),
        };
        record.issues = record.validation_issues();
        record
    }

    /// Deferred publication when a host cannot safely expose the map yet.
    pub fn deferred(project_id: ProjectId, reason: impl Into<String>) -> Self {
        Self {
            project_id,
            domains: Vec::new(),
            issues: vec![ProjectAuthorityValidationIssue::PublicationDeferred {
                reason: reason.into(),
            }],
        }
    }

    /// Return the publication row for one authority domain.
    pub fn domain(
        &self,
        domain: &ProjectAuthorityDomain,
    ) -> Option<&ProjectAuthorityDomainPublication> {
        self.domains
            .iter()
            .find(|publication| &publication.domain == domain)
    }

    /// Validate the publication for client rendering.
    pub fn validation_issues(&self) -> Vec<ProjectAuthorityValidationIssue> {
        let mut issues = Vec::new();

        for domain in &self.domains {
            match &domain.state {
                ProjectAuthorityPublicationState::Assigned {
                    authoritative_host_id,
                    fallback_host_ids,
                    mutation_allowed: _,
                } if fallback_host_ids.contains(authoritative_host_id) => {
                    issues.push(
                        ProjectAuthorityValidationIssue::FallbackDuplicatesAuthority {
                            domain: domain.domain.clone(),
                            host_id: authoritative_host_id.clone(),
                        },
                    );
                }
                ProjectAuthorityPublicationState::Unassigned => {
                    issues.push(ProjectAuthorityValidationIssue::DomainUnassigned {
                        domain: domain.domain.clone(),
                    });
                }
                ProjectAuthorityPublicationState::PublicationDeferred { reason } => {
                    issues.push(ProjectAuthorityValidationIssue::PublicationDeferred {
                        reason: reason.clone(),
                    });
                }
                ProjectAuthorityPublicationState::Assigned { .. }
                | ProjectAuthorityPublicationState::FallbackOnly { .. }
                | ProjectAuthorityPublicationState::MutationDenied { .. } => {}
            }
        }

        issues
    }
}

/// Client-visible publication for one authority domain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectAuthorityDomainPublication {
    pub domain: ProjectAuthorityDomain,
    pub state: ProjectAuthorityPublicationState,
    pub note: Option<String>,
}

impl ProjectAuthorityDomainPublication {
    fn from_assignment(
        domain: ProjectAuthorityDomain,
        assignment: Option<&ProjectAuthorityAssignment>,
    ) -> Self {
        match assignment {
            Some(assignment) if assignment.mutation_allowed => Self {
                domain,
                state: ProjectAuthorityPublicationState::Assigned {
                    authoritative_host_id: assignment.authoritative_host_id.clone(),
                    fallback_host_ids: assignment.fallback_host_ids.clone(),
                    mutation_allowed: true,
                },
                note: assignment.note.clone(),
            },
            Some(assignment) => Self {
                domain,
                state: ProjectAuthorityPublicationState::MutationDenied {
                    authoritative_host_id: assignment.authoritative_host_id.clone(),
                    fallback_host_ids: assignment.fallback_host_ids.clone(),
                },
                note: assignment.note.clone(),
            },
            None => Self {
                domain,
                state: ProjectAuthorityPublicationState::Unassigned,
                note: None,
            },
        }
    }

    /// Create a fallback-only publication row for a client-visible repair flow.
    pub fn fallback_only(
        domain: ProjectAuthorityDomain,
        fallback_host_ids: Vec<EngineHostId>,
        note: Option<String>,
    ) -> Self {
        Self {
            domain,
            state: ProjectAuthorityPublicationState::FallbackOnly { fallback_host_ids },
            note,
        }
    }

    /// Create a deferred publication row for one domain.
    pub fn deferred(domain: ProjectAuthorityDomain, reason: impl Into<String>) -> Self {
        Self {
            domain,
            state: ProjectAuthorityPublicationState::PublicationDeferred {
                reason: reason.into(),
            },
            note: None,
        }
    }
}

/// Client-visible authority publication state for one domain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectAuthorityPublicationState {
    Assigned {
        authoritative_host_id: EngineHostId,
        fallback_host_ids: Vec<EngineHostId>,
        mutation_allowed: bool,
    },
    MutationDenied {
        authoritative_host_id: EngineHostId,
        fallback_host_ids: Vec<EngineHostId>,
    },
    FallbackOnly {
        fallback_host_ids: Vec<EngineHostId>,
    },
    Unassigned,
    PublicationDeferred {
        reason: String,
    },
}

/// Validation issue for client-visible authority-map publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectAuthorityValidationIssue {
    DomainUnassigned {
        domain: ProjectAuthorityDomain,
    },
    PublicationDeferred {
        reason: String,
    },
    FallbackDuplicatesAuthority {
        domain: ProjectAuthorityDomain,
        host_id: EngineHostId,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(id: &str) -> EngineHostId {
        EngineHostId(id.to_owned())
    }

    fn map() -> ProjectAuthorityMap {
        ProjectAuthorityMap {
            project_id: ProjectId("project:nucleus".to_owned()),
            assignments: vec![
                ProjectAuthorityAssignment {
                    domain: ProjectAuthorityDomain::Project,
                    authoritative_host_id: host("host:local"),
                    fallback_host_ids: Vec::new(),
                    mutation_allowed: true,
                    note: None,
                },
                ProjectAuthorityAssignment {
                    domain: ProjectAuthorityDomain::Execution,
                    authoritative_host_id: host("host:remote-worker"),
                    fallback_host_ids: vec![host("host:local")],
                    mutation_allowed: true,
                    note: Some("remote worker owns execution for this task".to_owned()),
                },
                ProjectAuthorityAssignment {
                    domain: ProjectAuthorityDomain::Projection,
                    authoritative_host_id: host("host:local"),
                    fallback_host_ids: Vec::new(),
                    mutation_allowed: false,
                    note: Some("projection repair in progress".to_owned()),
                },
            ],
        }
    }

    #[test]
    fn authority_map_publication_describes_assigned_domains() {
        let record = ProjectAuthorityMapPublicationRecord::from_map(
            &map(),
            vec![
                ProjectAuthorityDomain::Project,
                ProjectAuthorityDomain::Execution,
                ProjectAuthorityDomain::Projection,
            ],
        );

        let execution = record
            .domain(&ProjectAuthorityDomain::Execution)
            .expect("execution publication");

        assert_eq!(
            execution.state,
            ProjectAuthorityPublicationState::Assigned {
                authoritative_host_id: host("host:remote-worker"),
                fallback_host_ids: vec![host("host:local")],
                mutation_allowed: true,
            }
        );
        assert!(record.issues.is_empty());
    }

    #[test]
    fn authority_map_publication_preserves_mutation_denied_state() {
        let record = ProjectAuthorityMapPublicationRecord::from_map(
            &map(),
            vec![ProjectAuthorityDomain::Projection],
        );

        let projection = record
            .domain(&ProjectAuthorityDomain::Projection)
            .expect("projection publication");

        assert_eq!(
            projection.state,
            ProjectAuthorityPublicationState::MutationDenied {
                authoritative_host_id: host("host:local"),
                fallback_host_ids: Vec::new(),
            }
        );
        assert!(projection.note.is_some());
    }

    #[test]
    fn authority_map_publication_reports_unassigned_domains() {
        let record = ProjectAuthorityMapPublicationRecord::from_map(
            &map(),
            vec![ProjectAuthorityDomain::Task],
        );

        assert_eq!(
            record
                .domain(&ProjectAuthorityDomain::Task)
                .map(|domain| &domain.state),
            Some(&ProjectAuthorityPublicationState::Unassigned)
        );
        assert!(record
            .issues
            .contains(&ProjectAuthorityValidationIssue::DomainUnassigned {
                domain: ProjectAuthorityDomain::Task,
            }));
    }

    #[test]
    fn authority_map_publication_can_be_deferred_without_transport() {
        let record = ProjectAuthorityMapPublicationRecord::deferred(
            ProjectId("project:nucleus".to_owned()),
            "authority map not published for remote worker",
        );

        assert!(record.domains.is_empty());
        assert_eq!(
            record.issues,
            vec![ProjectAuthorityValidationIssue::PublicationDeferred {
                reason: "authority map not published for remote worker".to_owned(),
            }]
        );
    }

    #[test]
    fn fallback_only_publication_does_not_grant_authority() {
        let publication = ProjectAuthorityDomainPublication::fallback_only(
            ProjectAuthorityDomain::Execution,
            vec![host("host:local")],
            Some("fallback can resume only after authority repair".to_owned()),
        );

        assert_eq!(
            publication.state,
            ProjectAuthorityPublicationState::FallbackOnly {
                fallback_host_ids: vec![host("host:local")],
            }
        );
    }
}
