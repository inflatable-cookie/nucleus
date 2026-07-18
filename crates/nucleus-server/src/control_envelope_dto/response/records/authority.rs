use serde::{Deserialize, Serialize};

use crate::client_protocol::{
    ProjectAuthorityDomainPublication, ProjectAuthorityMapPublicationRecord,
    ProjectAuthorityPublicationState, ProjectAuthorityValidationIssue,
};
use crate::host_authority::ProjectAuthorityDomain;

/// Serializable project authority-map publication.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProjectAuthorityMapDto {
    pub project_id: String,
    pub domains: Vec<ControlProjectAuthorityDomainDto>,
    pub issues: Vec<ControlProjectAuthorityIssueDto>,
}

/// Serializable project authority-domain publication.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProjectAuthorityDomainDto {
    pub domain: String,
    pub state: String,
    pub authoritative_host_id: Option<String>,
    pub fallback_host_ids: Vec<String>,
    pub mutation_allowed: Option<bool>,
    pub reason: Option<String>,
    pub note: Option<String>,
}

/// Serializable authority-map validation issue.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProjectAuthorityIssueDto {
    pub kind: String,
    pub domain: Option<String>,
    pub host_id: Option<String>,
    pub reason: Option<String>,
}
impl From<&ProjectAuthorityMapPublicationRecord> for ControlProjectAuthorityMapDto {
    fn from(record: &ProjectAuthorityMapPublicationRecord) -> Self {
        Self {
            project_id: record.project_id.0.clone(),
            domains: record
                .domains
                .iter()
                .map(ControlProjectAuthorityDomainDto::from)
                .collect(),
            issues: record
                .issues
                .iter()
                .map(ControlProjectAuthorityIssueDto::from)
                .collect(),
        }
    }
}

impl From<&ProjectAuthorityDomainPublication> for ControlProjectAuthorityDomainDto {
    fn from(publication: &ProjectAuthorityDomainPublication) -> Self {
        match &publication.state {
            ProjectAuthorityPublicationState::Assigned {
                authoritative_host_id,
                fallback_host_ids,
                mutation_allowed,
            } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "assigned".to_owned(),
                authoritative_host_id: Some(authoritative_host_id.0.clone()),
                fallback_host_ids: fallback_host_ids
                    .iter()
                    .map(|host| host.0.clone())
                    .collect(),
                mutation_allowed: Some(*mutation_allowed),
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::MutationDenied {
                authoritative_host_id,
                fallback_host_ids,
            } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "mutation_denied".to_owned(),
                authoritative_host_id: Some(authoritative_host_id.0.clone()),
                fallback_host_ids: fallback_host_ids
                    .iter()
                    .map(|host| host.0.clone())
                    .collect(),
                mutation_allowed: Some(false),
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::FallbackOnly { fallback_host_ids } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "fallback_only".to_owned(),
                authoritative_host_id: None,
                fallback_host_ids: fallback_host_ids
                    .iter()
                    .map(|host| host.0.clone())
                    .collect(),
                mutation_allowed: None,
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::Unassigned => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "unassigned".to_owned(),
                authoritative_host_id: None,
                fallback_host_ids: Vec::new(),
                mutation_allowed: None,
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::PublicationDeferred { reason } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "publication_deferred".to_owned(),
                authoritative_host_id: None,
                fallback_host_ids: Vec::new(),
                mutation_allowed: None,
                reason: Some(reason.clone()),
                note: publication.note.clone(),
            },
        }
    }
}

impl From<&ProjectAuthorityValidationIssue> for ControlProjectAuthorityIssueDto {
    fn from(issue: &ProjectAuthorityValidationIssue) -> Self {
        match issue {
            ProjectAuthorityValidationIssue::DomainUnassigned { domain } => Self {
                kind: "domain_unassigned".to_owned(),
                domain: Some(authority_domain_dto(domain)),
                host_id: None,
                reason: None,
            },
            ProjectAuthorityValidationIssue::PublicationDeferred { reason } => Self {
                kind: "publication_deferred".to_owned(),
                domain: None,
                host_id: None,
                reason: Some(reason.clone()),
            },
            ProjectAuthorityValidationIssue::FallbackDuplicatesAuthority { domain, host_id } => {
                Self {
                    kind: "fallback_duplicates_authority".to_owned(),
                    domain: Some(authority_domain_dto(domain)),
                    host_id: Some(host_id.0.clone()),
                    reason: None,
                }
            }
        }
    }
}

fn authority_domain_dto(domain: &ProjectAuthorityDomain) -> String {
    match domain {
        ProjectAuthorityDomain::Project => "project".to_owned(),
        ProjectAuthorityDomain::Source => "source".to_owned(),
        ProjectAuthorityDomain::Task => "task".to_owned(),
        ProjectAuthorityDomain::Workspace => "workspace".to_owned(),
        ProjectAuthorityDomain::Session => "session".to_owned(),
        ProjectAuthorityDomain::Execution => "execution".to_owned(),
        ProjectAuthorityDomain::Terminal => "terminal".to_owned(),
        ProjectAuthorityDomain::ScmForge => "scm_forge".to_owned(),
        ProjectAuthorityDomain::Memory => "memory".to_owned(),
        ProjectAuthorityDomain::Planning => "planning".to_owned(),
        ProjectAuthorityDomain::Research => "research".to_owned(),
        ProjectAuthorityDomain::Credential => "credential".to_owned(),
        ProjectAuthorityDomain::AuditEvidence => "audit_evidence".to_owned(),
        ProjectAuthorityDomain::Projection => "projection".to_owned(),
        ProjectAuthorityDomain::Custom(value) => value.clone(),
    }
}
