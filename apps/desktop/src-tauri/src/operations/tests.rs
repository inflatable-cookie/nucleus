use super::*;

fn snapshot(runtime: &NucleusOperationRuntime) -> OperationSnapshot {
    runtime
        .snapshot(
            "main",
            OperationSnapshotQuery {
                protocol_version: OperationProtocolVersion::CURRENT,
                request_id: id("request:nucleus-operation:test:snapshot").expect("request id"),
            },
        )
        .expect("snapshot")
        .snapshot
}

#[test]
fn eligible_kinds_are_product_owned_and_explicit() {
    assert_eq!(
        [
            KIND_FORGE_INSPECTION,
            KIND_FORGE_MUTATION,
            KIND_FORGE_COMMIT,
            KIND_RESOURCE_IMPORT,
            KIND_INDEXING,
            KIND_RECOVERY,
        ],
        [
            "nucleus:forge-inspection",
            "nucleus:forge-mutation",
            "nucleus:forge-commit",
            "nucleus:resource-import",
            "nucleus:indexing",
            "nucleus:recovery",
        ]
    );
}

#[test]
fn running_work_becomes_sticky_terminal_without_product_payloads() {
    let runtime = NucleusOperationRuntime::new().expect("runtime");
    let (operation_id, registered) = runtime
        .begin_mutation(
            KIND_FORGE_MUTATION,
            Some("project:nucleus-local"),
            "Update Forge staging",
            false,
        )
        .expect("register");
    assert!(matches!(
        registered,
        OperationMutationResult::Committed { .. }
    ));

    let running = snapshot(&runtime);
    assert_eq!(running.active.len(), 1);
    assert!(running.recent.is_empty());
    let projection = &running.active[0];
    assert_eq!(projection.operation_id, operation_id);
    assert_eq!(projection.kind_id.to_string(), KIND_FORGE_MUTATION);
    assert_eq!(
        projection
            .scope_id
            .as_ref()
            .map(ToString::to_string)
            .as_deref(),
        Some("project:nucleus-local")
    );
    assert_eq!(projection.label, "Update Forge staging");
    assert_eq!(projection.state, OperationStateProjection::Running);
    let encoded = serde_json::to_string(projection).expect("projection JSON");
    assert!(!encoded.contains("path"));
    assert!(!encoded.contains("receipt"));
    assert!(!encoded.contains("fingerprint"));

    let handle = NucleusOperationHandle {
        operation_id,
        kind: KIND_FORGE_MUTATION.to_owned(),
        scope: Some("project:nucleus-local".to_owned()),
        label: "Update Forge staging".to_owned(),
    };
    let finished = runtime.finish_mutation(&handle, true).expect("finish");
    assert!(matches!(
        finished,
        OperationMutationResult::Committed { .. }
    ));
    let terminal = snapshot(&runtime);
    assert!(terminal.active.is_empty());
    assert_eq!(terminal.recent.len(), 1);
    assert_eq!(
        terminal.recent[0].state,
        OperationStateProjection::Succeeded
    );

    let late_terminal = runtime
        .finish_mutation(&handle, false)
        .expect("checked late terminal");
    assert!(matches!(
        late_terminal,
        OperationMutationResult::Rejected { .. }
    ));
    assert_eq!(
        snapshot(&runtime).recent[0].state,
        OperationStateProjection::Succeeded
    );
}

#[test]
fn renderer_cannot_register_or_mutate_host_work() {
    let runtime = NucleusOperationRuntime::new().expect("runtime");
    assert!(runtime
        .snapshot(
            "other-window",
            OperationSnapshotQuery {
                protocol_version: OperationProtocolVersion::CURRENT,
                request_id: id("request:nucleus-operation:test:unauthorized").expect("request id"),
            },
        )
        .is_err());

    let authority = snapshot(&runtime).authority;
    let result = runtime.mutate(
        "main",
        OperationMutationCommand::Register {
            request_id: id("request:nucleus-operation:test:renderer-register").expect("request id"),
            protocol_version: OperationProtocolVersion::CURRENT,
            authority,
            expected_catalogue_revision: snapshot(&runtime).catalogue_revision,
            operation_id: id("operation:nucleus:renderer").expect("operation id"),
            kind_id: id(KIND_INDEXING).expect("kind id"),
            scope_id: None,
            label: "Forbidden renderer work".to_owned(),
            initial_state: OperationStateProjection::Running,
            cancellation_support: OperationCancellationSupportProjection::Unsupported,
            retry_of: None,
        },
    );
    assert!(result.is_err());
    assert!(snapshot(&runtime).active.is_empty());
}
