use crate::control_envelope_dto::ControlApiCodecError;
use crate::host_authority::ProjectAuthorityDomain;

pub(super) fn authority_domain_dto(domain: &ProjectAuthorityDomain) -> String {
    match domain {
        ProjectAuthorityDomain::Project => "project",
        ProjectAuthorityDomain::Source => "source",
        ProjectAuthorityDomain::Task => "task",
        ProjectAuthorityDomain::Workspace => "workspace",
        ProjectAuthorityDomain::Session => "session",
        ProjectAuthorityDomain::Execution => "execution",
        ProjectAuthorityDomain::Terminal => "terminal",
        ProjectAuthorityDomain::ScmForge => "scm_forge",
        ProjectAuthorityDomain::Memory => "memory",
        ProjectAuthorityDomain::Planning => "planning",
        ProjectAuthorityDomain::Research => "research",
        ProjectAuthorityDomain::Credential => "credential",
        ProjectAuthorityDomain::AuditEvidence => "audit_evidence",
        ProjectAuthorityDomain::Projection => "projection",
        ProjectAuthorityDomain::Custom(value) => value,
    }
    .to_owned()
}

pub(super) fn authority_domain_from_dto(
    domain: String,
) -> Result<ProjectAuthorityDomain, ControlApiCodecError> {
    Ok(match domain.as_str() {
        "project" => ProjectAuthorityDomain::Project,
        "source" => ProjectAuthorityDomain::Source,
        "task" => ProjectAuthorityDomain::Task,
        "workspace" => ProjectAuthorityDomain::Workspace,
        "session" => ProjectAuthorityDomain::Session,
        "execution" => ProjectAuthorityDomain::Execution,
        "terminal" => ProjectAuthorityDomain::Terminal,
        "scm_forge" => ProjectAuthorityDomain::ScmForge,
        "memory" => ProjectAuthorityDomain::Memory,
        "planning" => ProjectAuthorityDomain::Planning,
        "research" => ProjectAuthorityDomain::Research,
        "credential" => ProjectAuthorityDomain::Credential,
        "audit_evidence" => ProjectAuthorityDomain::AuditEvidence,
        "projection" => ProjectAuthorityDomain::Projection,
        "" => {
            return Err(ControlApiCodecError::unsupported(
                "project authority-map query contains an empty authority domain",
            ));
        }
        custom => ProjectAuthorityDomain::Custom(custom.to_owned()),
    })
}
