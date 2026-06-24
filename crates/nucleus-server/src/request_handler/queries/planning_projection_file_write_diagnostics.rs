use nucleus_engine::{ManagementProjectionExportPlan, ManagementProjectionRoot};

use crate::control_api::{
    PlanningProjectionFileWriteDiagnosticsQuery, ServerControlError, ServerQueryResult,
};
use crate::management_projection_state::planning_projection_file_write_diagnostics;

pub(crate) fn planning_projection_file_write_diagnostics_query(
    query: PlanningProjectionFileWriteDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError> {
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "planning projection file-write diagnostics requires a project".to_owned(),
        });
    }

    Ok(ServerQueryResult::PlanningProjectionFileWriteDiagnostics(
        planning_projection_file_write_diagnostics(&empty_plan(), None),
    ))
}

fn empty_plan() -> ManagementProjectionExportPlan {
    ManagementProjectionExportPlan {
        root: ManagementProjectionRoot::default(),
        entries: Vec::new(),
        issues: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_projects::ProjectId;

    #[test]
    fn planning_projection_file_write_diagnostics_query_is_read_only() {
        let result = planning_projection_file_write_diagnostics_query(
            PlanningProjectionFileWriteDiagnosticsQuery {
                project_id: ProjectId("project:nucleus-local".to_owned()),
            },
        )
        .expect("planning projection file-write diagnostics");

        let ServerQueryResult::PlanningProjectionFileWriteDiagnostics(diagnostics) = result else {
            panic!("expected planning projection file-write diagnostics result");
        };

        assert_eq!(diagnostics.materialized_planning_artifact_files, 0);
        assert_eq!(diagnostics.materialized_planning_task_seed_files, 0);
        assert!(!diagnostics.import_or_apply_authority);
        assert!(!diagnostics.scm_mutation_authority);
    }
}
