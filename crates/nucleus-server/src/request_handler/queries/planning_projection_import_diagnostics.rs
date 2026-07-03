use crate::control_api::{
    PlanningProjectionImportDiagnosticsQuery, ServerControlError, ServerQueryResult,
};
use crate::management_projection_state::{
    planning_projection_import_diagnostics, PlanningProjectionImportDiagnosticsInput,
};

pub(crate) fn planning_projection_import_diagnostics_query(
    query: PlanningProjectionImportDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError> {
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "planning projection import diagnostics requires a project".to_owned(),
        });
    }

    Ok(ServerQueryResult::PlanningProjectionImportDiagnostics(
        planning_projection_import_diagnostics(PlanningProjectionImportDiagnosticsInput {
            candidates: Vec::new(),
            admissions: Vec::new(),
            conflicts: Vec::new(),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_projects::ProjectId;

    #[test]
    fn planning_projection_import_diagnostics_query_is_read_only() {
        let result = planning_projection_import_diagnostics_query(
            PlanningProjectionImportDiagnosticsQuery {
                project_id: ProjectId("project:nucleus-local".to_owned()),
            },
        )
        .expect("planning projection import diagnostics");

        let ServerQueryResult::PlanningProjectionImportDiagnostics(diagnostics) = result else {
            panic!("expected planning projection import diagnostics result");
        };

        assert_eq!(diagnostics.candidate_count, 0);
        assert_eq!(diagnostics.admission_count, 0);
        assert_eq!(diagnostics.conflict_count, 0);
        assert!(!diagnostics.apply_permitted);
        assert!(!diagnostics.task_promotion_permitted);
        assert!(!diagnostics.provider_execution_permitted);
        assert!(!diagnostics.scm_mutation_permitted);
        assert!(!diagnostics.forge_mutation_permitted);
        assert!(!diagnostics.raw_payload_retained);
        assert!(!diagnostics.ui_apply_permitted);
    }

    #[test]
    fn planning_projection_import_diagnostics_query_requires_project() {
        let error = planning_projection_import_diagnostics_query(
            PlanningProjectionImportDiagnosticsQuery {
                project_id: ProjectId(" ".to_owned()),
            },
        )
        .expect_err("empty project should be rejected");

        assert!(matches!(error, ServerControlError::InvalidRequest { .. }));
    }
}
