use serde::{Deserialize, Serialize};

use nucleus_engine::EngineScmWorkItemLinkRecord;
use nucleus_scm_forge::{
    ScmSessionCommandAdmission, ScmWorkingCopySessionMode, ScmWorkingCopySessionPlan,
};

use super::helpers::{source_status, source_summary};

/// SCM session diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmSessionDiagnosticsDto {
    pub sessions: Vec<ScmSessionPlanDiagnosticDto>,
    pub admissions: Vec<ScmCommandAdmissionDiagnosticDto>,
    pub work_item_links: Vec<ScmWorkItemLinkDiagnosticDto>,
    pub client_can_mutate_working_copy: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmSessionPlanDiagnosticDto {
    pub session_id: String,
    pub repository_id: String,
    pub provider_kind: String,
    pub mode: String,
    pub status: String,
    pub user_can_test_in_known_directory: bool,
    pub runtime_constraints: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCommandAdmissionDiagnosticDto {
    pub command_id: String,
    pub status: String,
    pub required_capability: String,
    pub executes_provider_command: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkItemLinkDiagnosticDto {
    pub link_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub work_session_id: String,
    pub session_command_ids: Vec<String>,
    pub change_refs: Vec<String>,
    pub checkpoint_ids: Vec<String>,
    pub diff_summary_ids: Vec<String>,
    pub requires_repair: bool,
}

pub fn scm_session_diagnostics(
    sessions: &[ScmWorkingCopySessionPlan],
    admissions: &[ScmSessionCommandAdmission],
    links: &[EngineScmWorkItemLinkRecord],
) -> ScmSessionDiagnosticsDto {
    let record_count = sessions.len() + admissions.len() + links.len();
    ScmSessionDiagnosticsDto {
        sessions: sessions
            .iter()
            .map(ScmSessionPlanDiagnosticDto::from)
            .collect(),
        admissions: admissions
            .iter()
            .map(ScmCommandAdmissionDiagnosticDto::from)
            .collect(),
        work_item_links: links
            .iter()
            .map(ScmWorkItemLinkDiagnosticDto::from)
            .collect(),
        client_can_mutate_working_copy: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "scm session source records are not persisted yet",
            "scm session diagnostics loaded from source records",
        )),
    }
}

impl From<&ScmWorkingCopySessionPlan> for ScmSessionPlanDiagnosticDto {
    fn from(plan: &ScmWorkingCopySessionPlan) -> Self {
        Self {
            session_id: plan.id.0.clone(),
            repository_id: plan.repository_id.0.clone(),
            provider_kind: format!("{:?}", plan.provider_kind),
            mode: session_mode(&plan.mode),
            status: format!("{:?}", plan.status),
            user_can_test_in_known_directory: plan.testability.user_can_test_in_known_directory,
            runtime_constraints: plan
                .runtime_constraints
                .iter()
                .map(|constraint| format!("{constraint:?}"))
                .collect(),
        }
    }
}

impl From<&ScmSessionCommandAdmission> for ScmCommandAdmissionDiagnosticDto {
    fn from(admission: &ScmSessionCommandAdmission) -> Self {
        Self {
            command_id: admission.command_id.0.clone(),
            status: format!("{:?}", admission.status),
            required_capability: format!("{:?}", admission.required_capability),
            executes_provider_command: admission.executes_provider_command(),
        }
    }
}

impl From<&EngineScmWorkItemLinkRecord> for ScmWorkItemLinkDiagnosticDto {
    fn from(link: &EngineScmWorkItemLinkRecord) -> Self {
        Self {
            link_id: link.link_id.0.clone(),
            task_id: link.task_id.0.clone(),
            work_item_id: link.work_item_id.0.clone(),
            work_session_id: link.work_session_id.0.clone(),
            session_command_ids: link
                .session_command_ids
                .iter()
                .map(|command| command.0.clone())
                .collect(),
            change_refs: link
                .change_refs
                .iter()
                .map(|change| change.provider_ref.0.clone())
                .collect(),
            checkpoint_ids: link
                .checkpoint_ids
                .iter()
                .map(|checkpoint| checkpoint.0.clone())
                .collect(),
            diff_summary_ids: link
                .diff_summary_ids
                .iter()
                .map(|diff| diff.0.clone())
                .collect(),
            requires_repair: link.requires_repair(),
        }
    }
}

fn session_mode(mode: &ScmWorkingCopySessionMode) -> String {
    match mode {
        ScmWorkingCopySessionMode::PrimaryTree { .. } => "primary_tree".to_owned(),
        ScmWorkingCopySessionMode::IsolatedLocation { .. } => "isolated_location".to_owned(),
        ScmWorkingCopySessionMode::ExternalManaged { .. } => "external_managed".to_owned(),
        ScmWorkingCopySessionMode::Unsupported { .. } => "unsupported".to_owned(),
    }
}
