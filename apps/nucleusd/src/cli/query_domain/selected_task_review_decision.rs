use super::{expect_flag, QueryDomain};

pub(super) fn parse_selected_task_review_decision_admission<I>(
    iter: &mut I,
) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    let args =
        parse_selected_task_review_decision_args(iter, "selected-task-review-decision-admission")?;
    Ok(QueryDomain::SelectedTaskReviewDecisionAdmission(args))
}

pub(super) fn parse_selected_task_review_decision_apply<I>(
    iter: &mut I,
) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    let args =
        parse_selected_task_review_decision_args(iter, "selected-task-review-decision-apply")?;
    Ok(QueryDomain::SelectedTaskReviewDecisionApply(args))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SelectedTaskReviewDecisionQueryArgs {
    pub project_id: String,
    pub task_id: String,
    pub action: String,
    pub expected_revision: Option<String>,
    pub current_revision: Option<String>,
    pub reason: Option<String>,
    pub operator_ref: String,
    pub reviewed_evidence_refs: Vec<String>,
    pub idempotency_key: String,
}

fn parse_selected_task_review_decision_args<I>(
    iter: &mut I,
    domain: &str,
) -> Result<SelectedTaskReviewDecisionQueryArgs, String>
where
    I: Iterator<Item = String>,
{
    expect_flag(iter, "--project")?;
    let project_id = iter
        .next()
        .ok_or_else(|| format!("{domain} requires --project <project-id>"))?;
    expect_flag(iter, "--task")?;
    let task_id = iter
        .next()
        .ok_or_else(|| format!("{domain} requires --task <task-id>"))?;
    expect_flag(iter, "--action")?;
    let action = iter
        .next()
        .ok_or_else(|| format!("{domain} requires --action <decision-action>"))?;
    validate_review_decision_action(&action)?;

    let mut expected_revision = None;
    let mut current_revision = None;
    let mut reason = None;
    let mut operator_ref = "operator:nucleusd".to_owned();
    let mut reviewed_evidence_refs = Vec::new();
    let mut idempotency_key = None;

    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--expected-revision" => {
                expected_revision = Some(iter.next().ok_or_else(|| {
                    format!("{domain} requires --expected-revision <revision-id>")
                })?);
            }
            "--current-revision" => {
                current_revision = Some(iter.next().ok_or_else(|| {
                    format!("{domain} requires --current-revision <revision-id>")
                })?);
            }
            "--reason" => {
                reason = Some(
                    iter.next()
                        .ok_or_else(|| format!("{domain} requires --reason <reason>"))?,
                );
            }
            "--operator" => {
                operator_ref = iter
                    .next()
                    .ok_or_else(|| format!("{domain} requires --operator <operator-ref>"))?;
            }
            "--evidence-ref" => {
                reviewed_evidence_refs.push(
                    iter.next()
                        .ok_or_else(|| format!("{domain} requires --evidence-ref <ref>"))?,
                );
            }
            "--idempotency-key" => {
                idempotency_key = Some(iter.next().ok_or_else(|| {
                    format!("{domain} requires --idempotency-key <idempotency-key>")
                })?);
            }
            _ => return Err(format!("unsupported {domain} flag: {flag}")),
        }
    }

    Ok(SelectedTaskReviewDecisionQueryArgs {
        project_id,
        task_id,
        action,
        expected_revision,
        current_revision,
        reason,
        operator_ref,
        reviewed_evidence_refs,
        idempotency_key: idempotency_key
            .ok_or_else(|| format!("{domain} requires --idempotency-key <idempotency-key>"))?,
    })
}

fn validate_review_decision_action(action: &str) -> Result<(), String> {
    match action {
        "accept_evidence" | "reject_evidence" | "request_changes" | "abandon_review" => Ok(()),
        _ => Err(format!(
            "unsupported selected task review-decision action: {action}"
        )),
    }
}
