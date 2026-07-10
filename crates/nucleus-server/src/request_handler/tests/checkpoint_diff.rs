use super::*;

#[test]
fn handler_lists_checkpoint_and_diff_records_without_runtime_receipt_collision() {
    let (_temp_dir, mut handler) = handler(None);
    let checkpoint = EngineCheckpointRecord {
        checkpoint_id: EngineCheckpointRecordId("checkpoint:task:handler".to_owned()),
        family: EngineCheckpointFamily::TaskWork,
        primary_workflow_ref: EngineCheckpointRef::TaskId("task:handler".to_owned()),
        project_ref: EngineCheckpointRef::ProjectId("project:nucleus-local".to_owned()),
        source_ref: Some(EngineCheckpointRef::SnapshotRef(
            "convergence:snapshot:handler".to_owned(),
        )),
        scm_adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef(
            "adapter:convergence".to_owned(),
        )),
        authority_host_ref: EngineCheckpointRef::AuthorityHostId("host:local".to_owned()),
        created_by_actor_ref: EngineCheckpointRef::ActorId("actor:user".to_owned()),
        causal_refs: vec![EngineCheckpointRef::CommandId(
            "command:checkpoint".to_owned(),
        )],
        parent_checkpoint_refs: Vec::new(),
        artifact_refs: Vec::new(),
        summary: Some("handler checkpoint".to_owned()),
        recovery_state: EngineCheckpointRecoveryState::Available,
    };
    let diff = EngineDiffSummaryRecord {
        diff_id: EngineDiffSummaryRecordId("diff:handler".to_owned()),
        kind: EngineDiffSummaryKind::Source,
        source_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:before".to_owned()),
        target_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:after".to_owned()),
        source_ref: Some(EngineCheckpointRef::RepoId("repo:nucleus".to_owned())),
        adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef("adapter:scm".to_owned())),
        generated_by_ref: EngineCheckpointRef::CommandId("command:diff".to_owned()),
        confidence: EngineDiffSummaryConfidence::Partial,
        summary: "source summary".to_owned(),
        changed_paths: vec!["crates/nucleus-engine/src/lib.rs".to_owned()],
        path_changes: Vec::new(),
        counts: nucleus_engine::EngineDiffSummaryCounts {
            modified: 1,
            ..nucleus_engine::EngineDiffSummaryCounts::default()
        },
        coverage: nucleus_engine::EngineDiffCoverageState::Complete,
        truncated: false,
        attribution_notice: None,
        evidence_refs: Vec::new(),
        artifact_refs: Vec::new(),
    };
    write_checkpoint_record(
        handler.state(),
        &checkpoint,
        nucleus_core::RevisionId("rev:checkpoint:handler".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write checkpoint");
    write_diff_summary_record(
        handler.state(),
        &diff,
        nucleus_core::RevisionId("rev:diff:handler".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write diff");

    let checkpoint_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:checkpoint-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:checkpoints".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCheckpointRecords),
        }),
    });
    let diff_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:diff-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:diffs".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListDiffSummaryRecords),
        }),
    });
    let receipt_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:receipt-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:receipts-empty".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListRuntimeReceipts),
        }),
    });

    assert!(matches!(
        checkpoint_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::CheckpointRecords(ref records))
            if records.as_slice() == std::slice::from_ref(&checkpoint)
    ));
    assert!(matches!(
        diff_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::DiffSummaryRecords(ref records))
            if records.as_slice() == std::slice::from_ref(&diff)
    ));
    assert!(matches!(
        receipt_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::RuntimeReceipts(records))
            if records.is_empty()
    ));

    let checkpoint_dto =
        crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&checkpoint_response)
            .expect("checkpoint dto");
    let diff_dto =
        crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&diff_response)
            .expect("diff dto");
    assert!(matches!(
        checkpoint_dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::CheckpointRecords { records }
            if records.len() == 1
                && records[0].checkpoint_id == "checkpoint:task:handler"
                && records[0].scm_adapter_ref.as_deref() == Some("adapter:convergence")
    ));
    assert!(matches!(
        diff_dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::DiffSummaryRecords { records }
            if records.len() == 1
                && records[0].diff_id == "diff:handler"
                && records[0].changed_paths == vec!["crates/nucleus-engine/src/lib.rs".to_owned()]
    ));
}
