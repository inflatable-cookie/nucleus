use super::*;

#[test]
fn management_projection_apply_command_is_explicit_and_non_scm_mutating() {
    let command = ManagementProjectionApplyCommand {
        command_id: ManagementProjectionApplyCommandId("apply:1".to_owned()),
        actor_ref: "actor:steward".to_owned(),
        target_project_id: "project:nucleus".to_owned(),
        targets: vec![ManagementProjectionApplyRecordTarget {
            record_id: ManagementProjectionRecordId("task:1".to_owned()),
            expected_current_revision: Some(RevisionId("rev:task:1".to_owned())),
        }],
        validation_report_refs: vec!["validation:1".to_owned()],
        conflict_resolution_refs: Vec::new(),
    };

    assert!(command.requires_explicit_targets());
    assert!(!command.mutates_scm());
    assert_eq!(
        command.targets[0].record_id,
        ManagementProjectionRecordId("task:1".to_owned())
    );
}
