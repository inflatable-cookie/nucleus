use super::*;

fn snapshot(runtime: &NucleusNotificationRuntime) -> NotificationSnapshot {
    runtime
        .snapshot(
            "main",
            NotificationSnapshotQuery {
                protocol_version: NotificationProtocolVersion::CURRENT,
                request_id: id("request:nucleus-notification:test:snapshot").expect("request id"),
                offset: 0,
                limit: SNAPSHOT_LIMIT,
            },
        )
        .expect("snapshot")
        .snapshot
}

#[test]
fn operation_failure_is_redacted_and_routes_through_semantic_action() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let runtime = NucleusNotificationRuntime::new(directory.path().join("notifications.json"))
        .expect("notification runtime");
    let operation_id = id("operation:nucleus:test").expect("operation id");
    let result = runtime
        .operation_failure_mutation(
            &operation_id,
            crate::operations::KIND_FORGE_COMMIT,
            Some("project:nucleus-local"),
            "Commit Forge changes",
        )
        .expect("publish failure");
    assert!(matches!(
        result,
        NotificationMutationResult::Committed { .. }
    ));

    let snapshot = snapshot(&runtime);
    assert_eq!(snapshot.unseen_count, 1);
    let record = &snapshot.page.records[0];
    assert_eq!(record.draft.source_id.to_string(), SOURCE_OPERATIONS);
    assert_eq!(record.draft.title, "Commit Forge changes failed");
    assert_eq!(record.draft.actions.len(), 1);
    assert_eq!(
        record.draft.actions[0].reference_id.to_string(),
        ACTION_OPEN_FORGE
    );
    let encoded = serde_json::to_string(record).expect("record JSON");
    assert!(!encoded.contains("commit message"));
    assert!(!encoded.contains("fingerprint"));
    assert!(!encoded.contains("provider"));
}

#[test]
fn command_refusal_is_warning_with_reason_and_project_scope() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let runtime = NucleusNotificationRuntime::new(directory.path().join("notifications.json"))
        .expect("notification runtime");
    runtime
        .command_refusal_mutation(
            "command:project-delete",
            Some("project:nucleus-local"),
            "Project deletion",
            "project deletion refused: retained resources=1, tasks=6",
        )
        .expect("publish refusal");

    let snapshot = snapshot(&runtime);
    assert_eq!(snapshot.unseen_count, 1);
    let record = &snapshot.page.records[0];
    assert_eq!(record.draft.source_id.to_string(), SOURCE_COMMANDS);
    assert_eq!(
        record.draft.severity,
        NotificationSeverityProjection::Warning
    );
    assert_eq!(record.draft.title, "Project deletion refused");
    assert!(record
        .draft
        .summary
        .contains("retained resources=1, tasks=6"));
    assert_eq!(
        record
            .draft
            .cause_id
            .as_ref()
            .map(ToString::to_string)
            .as_deref(),
        Some("command:project-delete")
    );
    assert_eq!(record.draft.actions.len(), 0);
}

#[test]
fn seen_and_dismissed_state_survive_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("notifications.json");
    let runtime = NucleusNotificationRuntime::new(path.clone()).expect("notification runtime");
    runtime
        .operation_failure_mutation(
            &id("operation:nucleus:test").expect("operation id"),
            crate::operations::KIND_FORGE_MUTATION,
            None,
            "Update Forge staging",
        )
        .expect("publish failure");
    let current = snapshot(&runtime);
    let notification_id = current.page.records[0].notification_id.clone();
    let seen = runtime
        .mutate(
            "main",
            NotificationMutationCommand::MarkSeen {
                request_id: id("request:nucleus-notification:test:seen").expect("request id"),
                protocol_version: NotificationProtocolVersion::CURRENT,
                authority: current.authority,
                expected_ledger_revision: current.ledger_revision,
                notification_id: notification_id.clone(),
            },
        )
        .expect("mark seen");
    assert!(matches!(seen, NotificationMutationResult::Committed { .. }));
    drop(runtime);

    let restarted = NucleusNotificationRuntime::new(path.clone()).expect("restart runtime");
    let restored = snapshot(&restarted);
    assert_eq!(restored.unseen_count, 0);
    assert_eq!(
        restored.page.records[0].read_state,
        NotificationReadStateProjection::Seen
    );
    let dismissed = restarted
        .mutate(
            "main",
            NotificationMutationCommand::Dismiss {
                request_id: id("request:nucleus-notification:test:dismiss").expect("request id"),
                protocol_version: NotificationProtocolVersion::CURRENT,
                authority: restored.authority,
                expected_ledger_revision: restored.ledger_revision,
                notification_id,
            },
        )
        .expect("dismiss");
    assert!(matches!(
        dismissed,
        NotificationMutationResult::Committed { .. }
    ));
    drop(restarted);

    let restarted = NucleusNotificationRuntime::new(path).expect("second restart runtime");
    assert!(snapshot(&restarted).page.records.is_empty());
}

#[test]
fn renderer_cannot_publish_attention_records() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let runtime = NucleusNotificationRuntime::new(directory.path().join("notifications.json"))
        .expect("notification runtime");
    let current = snapshot(&runtime);
    let result = runtime.mutate(
        "main",
        NotificationMutationCommand::Add {
            request_id: id("request:nucleus-notification:test:forbidden").expect("request id"),
            protocol_version: NotificationProtocolVersion::CURRENT,
            authority: current.authority,
            expected_ledger_revision: current.ledger_revision,
            notification_id: id("notification:nucleus:forbidden").expect("notification id"),
            draft: NotificationDraftProjection {
                source_id: id(SOURCE_OPERATIONS).expect("source id"),
                severity: NotificationSeverityProjection::Info,
                title: "Routine success".to_owned(),
                summary: "Should remain quiet".to_owned(),
                cause_id: None,
                actions: Vec::new(),
                replacement_key: None,
                producer_token: None,
                retention_class: NotificationRetentionClassProjection::Standard,
                presentation_time_unix_ms: None,
            },
        },
    );
    assert!(result.is_err());
    assert!(snapshot(&runtime).page.records.is_empty());
}
