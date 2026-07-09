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

pub(super) fn parse_selected_task_completion_route_apply<I>(
    iter: &mut I,
) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    let (project_id, task_id) = parse_project_task(iter, "selected-task-completion-route-apply")?;
    let mut expected_revision = None;
    let mut operator_ref = "operator:nucleusd".to_owned();
    let mut route_admission_id = None;
    let mut review_decision_ref = None;
    let mut evidence_refs = Vec::new();

    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--expected-revision" => {
                expected_revision = Some(iter.next().ok_or_else(|| {
                    "selected-task-completion-route-apply requires a value after --expected-revision"
                        .to_owned()
                })?);
            }
            "--operator" => {
                operator_ref = iter.next().ok_or_else(|| {
                    "selected-task-completion-route-apply requires a value after --operator"
                        .to_owned()
                })?;
            }
            "--route-admission" => {
                route_admission_id = Some(iter.next().ok_or_else(|| {
                    "selected-task-completion-route-apply requires a value after --route-admission"
                        .to_owned()
                })?);
            }
            "--review-decision" => {
                review_decision_ref = Some(iter.next().ok_or_else(|| {
                    "selected-task-completion-route-apply requires a value after --review-decision"
                        .to_owned()
                })?);
            }
            "--evidence-ref" => {
                evidence_refs.push(iter.next().ok_or_else(|| {
                    "selected-task-completion-route-apply requires a value after --evidence-ref"
                        .to_owned()
                })?);
            }
            other => {
                return Err(format!(
                    "unsupported selected-task-completion-route-apply flag: {other}"
                ));
            }
        }
    }

    Ok(QueryDomain::SelectedTaskCompletionRouteApply {
        project_id,
        task_id,
        expected_revision,
        operator_ref,
        route_admission_id,
        review_decision_ref,
        evidence_refs,
    })
}

pub(super) fn parse_selected_task_rework_preparation<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    let (project_id, task_id) = parse_project_task(iter, "selected-task-rework-preparation")?;
    let mut operator_ref = "operator:nucleusd".to_owned();
    let mut route_admission_id = None;
    let mut review_decision_ref = None;
    let mut reviewed_work_item_refs = Vec::new();
    let mut reviewed_evidence_refs = Vec::new();
    let mut expected_task_revision = None;
    let mut expected_work_item_revision = None;

    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--operator" => {
                operator_ref = iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --operator".to_owned()
                })?;
            }
            "--route-admission" => {
                route_admission_id = Some(iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --route-admission"
                        .to_owned()
                })?);
            }
            "--review-decision" => {
                review_decision_ref = Some(iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --review-decision"
                        .to_owned()
                })?);
            }
            "--work-item-ref" => {
                reviewed_work_item_refs.push(iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --work-item-ref"
                        .to_owned()
                })?);
            }
            "--evidence-ref" => {
                reviewed_evidence_refs.push(iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --evidence-ref"
                        .to_owned()
                })?);
            }
            "--expected-task-revision" => {
                expected_task_revision = Some(iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --expected-task-revision"
                        .to_owned()
                })?);
            }
            "--expected-work-item-revision" => {
                expected_work_item_revision = Some(iter.next().ok_or_else(|| {
                    "selected-task-rework-preparation requires a value after --expected-work-item-revision"
                        .to_owned()
                })?);
            }
            other => {
                return Err(format!(
                    "unsupported selected-task-rework-preparation flag: {other}"
                ));
            }
        }
    }

    Ok(QueryDomain::SelectedTaskReworkPreparation {
        project_id,
        task_id,
        operator_ref,
        route_admission_id,
        review_decision_ref,
        reviewed_work_item_refs,
        reviewed_evidence_refs,
        expected_task_revision,
        expected_work_item_revision,
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

pub(super) fn parse_selected_task_product_aggregate<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    let (project_id, task_id) = parse_project_task(iter, "selected-task-product-aggregate")?;
    let mut expected_revision = None;
    let mut operator_ref = "operator:nucleusd".to_owned();

    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--expected-revision" => {
                expected_revision = Some(iter.next().ok_or_else(|| {
                    "selected-task-product-aggregate requires a value after --expected-revision"
                        .to_owned()
                })?);
            }
            "--operator" => {
                operator_ref = iter.next().ok_or_else(|| {
                    "selected-task-product-aggregate requires a value after --operator".to_owned()
                })?;
            }
            other => {
                return Err(format!(
                    "unsupported selected-task-product-aggregate flag: {other}"
                ));
            }
        }
    }

    Ok(QueryDomain::SelectedTaskProductAggregate {
        project_id,
        task_id,
        expected_revision,
        operator_ref,
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
