use super::*;

#[test]
fn management_projection_import_repair_preserves_invalid_and_unsupported_records() {
    let invalid = ManagementProjectionEnvelope {
        schema_version: ManagementProjectionSchemaVersion::current(),
        record_id: ManagementProjectionRecordId(String::new()),
        record_kind: ManagementProjectionRecordKind::Task,
        file_ref: ManagementProjectionFileRef("outside/task.toml".to_owned()),
    };
    let unsupported = ManagementProjectionEnvelope {
        schema_version: ManagementProjectionSchemaVersion("future".to_owned()),
        record_id: ManagementProjectionRecordId("task:future".to_owned()),
        record_kind: ManagementProjectionRecordKind::Task,
        file_ref: ManagementProjectionFileRef::task("task:future"),
    };

    let invalid_report = validate_projection_envelope(
        &invalid,
        &[ManagementProjectionExcludedStateMarker::PerProjectPanelLayout],
    );
    let unsupported_report = validate_projection_envelope(&unsupported, &[]);
    let invalid_proposal = ManagementProjectionImportRepairProposal::from_validation_report(
        ManagementProjectionImportRepairProposalId("repair:invalid".to_owned()),
        &invalid_report,
    )
    .expect("invalid proposal");
    let unsupported_proposal = ManagementProjectionImportRepairProposal::from_validation_report(
        ManagementProjectionImportRepairProposalId("repair:unsupported".to_owned()),
        &unsupported_report,
    )
    .expect("unsupported proposal");

    assert_eq!(
        invalid_proposal.kind,
        ManagementProjectionImportRepairKind::SchemaRepair
    );
    assert_eq!(
        unsupported_proposal.kind,
        ManagementProjectionImportRepairKind::UnsupportedPreservation
    );
    assert!(unsupported_proposal.preserves_unsupported_record());
    assert!(!invalid_proposal.can_silently_overwrite_task_meaning());
    assert!(!unsupported_proposal.can_silently_overwrite_task_meaning());
    assert!(invalid_proposal.issue_summaries.iter().any(|summary| {
        summary.contains("management projection files must live under nucleus/")
    }));
}

#[test]
fn management_projection_import_repair_ignores_valid_reports() {
    let envelope = ManagementProjectionEnvelope {
        schema_version: ManagementProjectionSchemaVersion::current(),
        record_id: ManagementProjectionRecordId("task:valid".to_owned()),
        record_kind: ManagementProjectionRecordKind::Task,
        file_ref: ManagementProjectionFileRef::task("task:valid"),
    };
    let report = validate_projection_envelope(&envelope, &[]);

    assert_eq!(report.status, ManagementProjectionValidationStatus::Valid);
    assert!(
        ManagementProjectionImportRepairProposal::from_validation_report(
            ManagementProjectionImportRepairProposalId("repair:none".to_owned()),
            &report,
        )
        .is_none()
    );
}
