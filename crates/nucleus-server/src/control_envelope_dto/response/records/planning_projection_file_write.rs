use serde::{Deserialize, Serialize};

use crate::{
    PlanningProjectionFileWriteDiagnosticIssue, PlanningProjectionFileWriteDiagnosticIssueClass,
    PlanningProjectionFileWriteDiagnostics,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningProjectionFileWriteDiagnosticsDto {
    #[ts(as = "u32")]
    pub materialized_planning_artifact_files: usize,
    #[ts(as = "u32")]
    pub materialized_planning_task_seed_files: usize,
    #[ts(as = "u32")]
    pub invalid_ref_count: usize,
    #[ts(as = "u32")]
    pub unsupported_record_count: usize,
    #[ts(as = "u32")]
    pub encode_failure_count: usize,
    #[ts(as = "u32")]
    pub skipped_write_count: usize,
    pub issues: Vec<ControlPlanningProjectionFileWriteDiagnosticIssueDto>,
    pub import_or_apply_authority: bool,
    pub scm_mutation_authority: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlPlanningProjectionFileWriteDiagnosticIssueDto {
    pub file_ref: Option<String>,
    pub class: String,
    pub summary: String,
}

impl From<&PlanningProjectionFileWriteDiagnostics>
    for ControlPlanningProjectionFileWriteDiagnosticsDto
{
    fn from(diagnostics: &PlanningProjectionFileWriteDiagnostics) -> Self {
        Self {
            materialized_planning_artifact_files: diagnostics.materialized_planning_artifact_files,
            materialized_planning_task_seed_files: diagnostics
                .materialized_planning_task_seed_files,
            invalid_ref_count: diagnostics.invalid_ref_count,
            unsupported_record_count: diagnostics.unsupported_record_count,
            encode_failure_count: diagnostics.encode_failure_count,
            skipped_write_count: diagnostics.skipped_write_count,
            issues: diagnostics
                .issues
                .iter()
                .map(ControlPlanningProjectionFileWriteDiagnosticIssueDto::from)
                .collect(),
            import_or_apply_authority: diagnostics.import_or_apply_authority,
            scm_mutation_authority: diagnostics.scm_mutation_authority,
        }
    }
}

impl From<&PlanningProjectionFileWriteDiagnosticIssue>
    for ControlPlanningProjectionFileWriteDiagnosticIssueDto
{
    fn from(issue: &PlanningProjectionFileWriteDiagnosticIssue) -> Self {
        Self {
            file_ref: issue.file_ref.as_ref().map(|file_ref| file_ref.0.clone()),
            class: issue_class_dto(&issue.class),
            summary: issue.summary.clone(),
        }
    }
}

fn issue_class_dto(class: &PlanningProjectionFileWriteDiagnosticIssueClass) -> String {
    match class {
        PlanningProjectionFileWriteDiagnosticIssueClass::InvalidRef => "invalid_ref",
        PlanningProjectionFileWriteDiagnosticIssueClass::UnsupportedRecord => "unsupported_record",
        PlanningProjectionFileWriteDiagnosticIssueClass::EncodeFailed => "encode_failed",
        PlanningProjectionFileWriteDiagnosticIssueClass::SkippedWrite => "skipped_write",
    }
    .to_owned()
}
