//! Pure project-resource mutation admission at the server boundary.

use nucleus_core::RevisionId;
use nucleus_projects::{ProjectId, ProjectResourceId, ProjectResourceKind};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResourceMutationCandidate {
    pub project_id: ProjectId,
    pub resource_id: Option<ProjectResourceId>,
    pub resource_kind: ProjectResourceKind,
    pub expected_revision: RevisionId,
    pub actor_ref: String,
    pub authority_host_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResourceMutationAdmissionContext {
    pub current_revision: RevisionId,
    pub authoritative_host_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResourceMutationAdmission {
    pub status: ProjectResourceMutationAdmissionStatus,
    pub candidate: Option<ProjectResourceMutationCandidate>,
    pub blocker: Option<ProjectResourceMutationAdmissionBlocker>,
    pub no_effects: ProjectResourceMutationNoEffects,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectResourceMutationAdmissionStatus {
    Admitted,
    Refused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectResourceMutationAdmissionBlocker {
    pub kind: ProjectResourceMutationAdmissionBlockerKind,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectResourceMutationAdmissionBlockerKind {
    MissingActor,
    StaleRevision,
    WrongAuthorityHost,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProjectResourceMutationNoEffects {
    pub project_write_performed: bool,
    pub resource_write_performed: bool,
    pub filesystem_effect_performed: bool,
}

pub fn admit_project_resource_mutation(
    candidate: ProjectResourceMutationCandidate,
    context: &ProjectResourceMutationAdmissionContext,
) -> ProjectResourceMutationAdmission {
    let blocker = if candidate.actor_ref.trim().is_empty() {
        Some(ProjectResourceMutationAdmissionBlocker {
            kind: ProjectResourceMutationAdmissionBlockerKind::MissingActor,
            reason: "project-resource mutation requires an actor ref".to_owned(),
        })
    } else if candidate.expected_revision != context.current_revision {
        Some(ProjectResourceMutationAdmissionBlocker {
            kind: ProjectResourceMutationAdmissionBlockerKind::StaleRevision,
            reason: "project-resource mutation revision is stale".to_owned(),
        })
    } else if candidate.authority_host_ref != context.authoritative_host_ref {
        Some(ProjectResourceMutationAdmissionBlocker {
            kind: ProjectResourceMutationAdmissionBlockerKind::WrongAuthorityHost,
            reason: "project-resource mutation was submitted to a non-authoritative host"
                .to_owned(),
        })
    } else {
        None
    };

    ProjectResourceMutationAdmission {
        status: if blocker.is_some() {
            ProjectResourceMutationAdmissionStatus::Refused
        } else {
            ProjectResourceMutationAdmissionStatus::Admitted
        },
        candidate: blocker.is_none().then_some(candidate),
        blocker,
        no_effects: ProjectResourceMutationNoEffects::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> ProjectResourceMutationCandidate {
        ProjectResourceMutationCandidate {
            project_id: ProjectId("project:control".to_owned()),
            resource_id: Some(ProjectResourceId("resource:working".to_owned())),
            resource_kind: ProjectResourceKind::FilesystemFolder,
            expected_revision: RevisionId("rev:2".to_owned()),
            actor_ref: "operator:tom".to_owned(),
            authority_host_ref: "host:server".to_owned(),
        }
    }

    fn context() -> ProjectResourceMutationAdmissionContext {
        ProjectResourceMutationAdmissionContext {
            current_revision: RevisionId("rev:2".to_owned()),
            authoritative_host_ref: "host:server".to_owned(),
        }
    }

    #[test]
    fn admits_a_current_candidate_on_the_authoritative_host_without_effects() {
        let admission = admit_project_resource_mutation(candidate(), &context());

        assert_eq!(
            admission.status,
            ProjectResourceMutationAdmissionStatus::Admitted
        );
        assert!(admission.candidate.is_some());
        assert_eq!(admission.blocker, None);
        assert_eq!(
            admission.no_effects,
            ProjectResourceMutationNoEffects::default()
        );
    }

    #[test]
    fn refuses_missing_actor_stale_revision_and_wrong_host() {
        let mut missing_actor = candidate();
        missing_actor.actor_ref.clear();
        let admission = admit_project_resource_mutation(missing_actor, &context());
        assert_eq!(
            admission.blocker.expect("missing actor blocker").kind,
            ProjectResourceMutationAdmissionBlockerKind::MissingActor
        );

        let mut stale = candidate();
        stale.expected_revision = RevisionId("rev:1".to_owned());
        let admission = admit_project_resource_mutation(stale, &context());
        assert_eq!(
            admission.blocker.expect("stale blocker").kind,
            ProjectResourceMutationAdmissionBlockerKind::StaleRevision
        );

        let mut wrong_host = candidate();
        wrong_host.authority_host_ref = "host:desktop".to_owned();
        let admission = admit_project_resource_mutation(wrong_host, &context());
        assert_eq!(
            admission.blocker.expect("host blocker").kind,
            ProjectResourceMutationAdmissionBlockerKind::WrongAuthorityHost
        );
    }
}
