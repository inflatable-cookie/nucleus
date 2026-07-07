use super::{expect_flag, QueryDomain};

pub(super) fn parse_selected_task_command_admission<I>(iter: &mut I) -> Result<QueryDomain, String>
where
    I: Iterator<Item = String>,
{
    expect_flag(iter, "--project")?;
    let project_id = iter.next().ok_or_else(|| {
        "selected-task-command-admission requires --project <project-id>".to_owned()
    })?;
    expect_flag(iter, "--task")?;
    let task_id = iter
        .next()
        .ok_or_else(|| "selected-task-command-admission requires --task <task-id>".to_owned())?;
    expect_flag(iter, "--family")?;
    let family = iter.next().ok_or_else(|| {
        "selected-task-command-admission requires --family <action-family>".to_owned()
    })?;
    validate_selected_task_action_family(&family)?;

    let mut expected_revision = None;
    let mut reason = None;
    let mut operator_ref = "operator:nucleusd".to_owned();

    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--expected-revision" => {
                expected_revision = Some(iter.next().ok_or_else(|| {
                    "selected-task-command-admission requires --expected-revision <revision-id>"
                        .to_owned()
                })?);
            }
            "--reason" => {
                reason = Some(iter.next().ok_or_else(|| {
                    "selected-task-command-admission requires --reason <reason>".to_owned()
                })?);
            }
            "--operator" => {
                operator_ref = iter.next().ok_or_else(|| {
                    "selected-task-command-admission requires --operator <operator-ref>".to_owned()
                })?;
            }
            _ => {
                return Err(format!(
                    "unsupported selected-task-command-admission flag: {flag}"
                ));
            }
        }
    }

    Ok(QueryDomain::SelectedTaskCommandAdmission {
        project_id,
        task_id,
        family,
        expected_revision,
        reason,
        operator_ref,
    })
}

fn validate_selected_task_action_family(family: &str) -> Result<(), String> {
    match family {
        "plan_selected_task"
        | "start_selected_task"
        | "block_selected_task"
        | "complete_selected_task"
        | "archive_selected_task"
        | "prepare_delegation"
        | "inspect_runtime_evidence"
        | "review_work_evidence"
        | "prepare_scm_handoff" => Ok(()),
        _ => Err(format!("unsupported selected task action family: {family}")),
    }
}
