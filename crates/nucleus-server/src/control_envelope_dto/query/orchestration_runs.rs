use nucleus_engine::EngineRunId;
use nucleus_projects::ProjectId;

use super::ControlQueryDto;
use crate::control_api::{
    OrchestrationRunReviewPatchQuery, OrchestrationRunReviewQuery, OrchestrationRunsQuery,
    ServerQueryKind,
};
use crate::control_envelope_dto::ControlApiCodecError;

pub(super) fn orchestration_runs_query_from_action(
    action: &str,
    project_id: String,
    run_id: Option<String>,
    file_ref: Option<String>,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "fleet" => Ok(ServerQueryKind::OrchestrationRuns(OrchestrationRunsQuery {
            project_id: ProjectId(project_id),
        })),
        "review" => {
            let run_id = run_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    ControlApiCodecError::unsupported(
                        "orchestration runs review requires a run id".to_owned(),
                    )
                })?;
            Ok(ServerQueryKind::OrchestrationRunReview(OrchestrationRunReviewQuery {
                project_id: ProjectId(project_id),
                run_id: EngineRunId(run_id),
            }))
        }
        "review_patch" => {
            let run_id = run_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    ControlApiCodecError::unsupported(
                        "orchestration runs review patch requires a run id".to_owned(),
                    )
                })?;
            let file_ref = file_ref
                .filter(|ref_value| !ref_value.trim().is_empty())
                .ok_or_else(|| {
                    ControlApiCodecError::unsupported(
                        "orchestration runs review patch requires a file ref".to_owned(),
                    )
                })?;
            Ok(ServerQueryKind::OrchestrationRunReviewPatch(
                OrchestrationRunReviewPatchQuery {
                    project_id: ProjectId(project_id),
                    run_id: EngineRunId(run_id),
                    file_ref,
                },
            ))
        }
        _ => Err(ControlApiCodecError::unsupported(format!(
            "orchestration runs query action is not supported: {action}"
        ))),
    }
}

impl TryFrom<&ControlQueryDto> for OrchestrationRunsQuery {
    type Error = ControlApiCodecError;

    fn try_from(query: &ControlQueryDto) -> Result<Self, Self::Error> {
        match query {
            ControlQueryDto::OrchestrationRuns { project_id, .. } => {
                Ok(OrchestrationRunsQuery {
                    project_id: ProjectId(project_id.clone()),
                })
            }
            _ => Err(ControlApiCodecError::unsupported(
                "query shape is not an orchestration runs query",
            )),
        }
    }
}
