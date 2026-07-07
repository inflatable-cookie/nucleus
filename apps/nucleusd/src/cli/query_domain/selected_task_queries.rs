use super::{expect_flag, QueryDomain};

pub(super) fn parse_selected_task_action_readiness<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    parse_project_task(iter, "selected-task-action-readiness").map(|(project_id, task_id)| {
        QueryDomain::SelectedTaskActionReadiness {
            project_id,
            task_id,
        }
    })
}

pub(super) fn parse_selected_task_operator_action_gate<I>(
    iter: &mut I,
) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    parse_project_task(iter, "selected-task-operator-action-gate").map(|(project_id, task_id)| {
        QueryDomain::SelectedTaskOperatorActionGate {
            project_id,
            task_id,
        }
    })
}

pub(super) fn parse_selected_task_review_next<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    parse_project_task(iter, "selected-task-review-next").map(|(project_id, task_id)| {
        QueryDomain::SelectedTaskReviewNext {
            project_id,
            task_id,
        }
    })
}

pub(super) fn parse_selected_task_review_outcome_route<I>(
    iter: &mut I,
) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    parse_project_task(iter, "selected-task-review-outcome-route").map(|(project_id, task_id)| {
        QueryDomain::SelectedTaskReviewOutcomeRoute {
            project_id,
            task_id,
        }
    })
}

pub(super) fn parse_selected_task_route_admission<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    let (project_id, task_id) = parse_project_task(iter, "selected-task-route-admission")?;
    let mut expected_revision = None;
    let mut operator_ref = "operator:nucleusd".to_owned();

    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--expected-revision" => {
                expected_revision = Some(iter.next().ok_or_else(|| {
                    "selected-task-route-admission requires a value after --expected-revision"
                        .to_owned()
                })?);
            }
            "--operator" => {
                operator_ref = iter.next().ok_or_else(|| {
                    "selected-task-route-admission requires a value after --operator".to_owned()
                })?;
            }
            other => {
                return Err(format!(
                    "unsupported selected-task-route-admission flag: {other}"
                ));
            }
        }
    }

    Ok(QueryDomain::SelectedTaskRouteAdmission {
        project_id,
        task_id,
        expected_revision,
        operator_ref,
    })
}

pub(super) fn parse_selected_task_scm_handoff<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    parse_project_task(iter, "selected-task-scm-handoff").map(|(project_id, task_id)| {
        QueryDomain::SelectedTaskScmHandoff {
            project_id,
            task_id,
        }
    })
}

fn parse_project_task<I>(iter: &mut I, label: &str) -> Result<(String, String), String>
where
    I: Iterator<Item = String>,
{
    expect_flag(iter, "--project")?;
    let project_id = iter
        .next()
        .ok_or_else(|| format!("{label} requires --project <project-id>"))?;
    expect_flag(iter, "--task")?;
    let task_id = iter
        .next()
        .ok_or_else(|| format!("{label} requires --task <task-id>"))?;
    Ok((project_id, task_id))
}
