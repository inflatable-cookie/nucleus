use super::*;

#[test]
fn management_projection_conflict_routes_keep_mechanical_and_semantic_separate() {
    let schema = conflict_report(ManagementProjectionConflictClass::Schema(
        ManagementProjectionSchemaConflictKind::InvalidRecordShape,
    ));
    let semantic = conflict_report(ManagementProjectionConflictClass::Semantic(
        ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
    ));
    let unsupported = conflict_report(ManagementProjectionConflictClass::Unsupported(
        ManagementProjectionUnsupportedConflictKind::UnsupportedSchemaPreserved,
    ));
    let scm = conflict_report(ManagementProjectionConflictClass::Scm(
        ManagementProjectionScmConflictKind::FileChangedDuringImport,
    ));

    let schema_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&schema);
    let semantic_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&semantic);
    let unsupported_route =
        ManagementProjectionSyncAssistanceRoute::from_conflict_report(&unsupported);
    let scm_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&scm);

    assert_eq!(
        schema_route.kind,
        ManagementProjectionSyncAssistanceKind::MechanicalConflictRepair
    );
    assert_eq!(
        semantic_route.kind,
        ManagementProjectionSyncAssistanceKind::SemanticConflictEscalation
    );
    assert_eq!(
        unsupported_route.kind,
        ManagementProjectionSyncAssistanceKind::UnsupportedRecordPreservation
    );
    assert_eq!(
        scm_route.kind,
        ManagementProjectionSyncAssistanceKind::ScmRetryOrRestage
    );
    assert!(!schema_route.hides_semantic_conflict());
    assert!(semantic_route.requires_human_approval());
    assert!(unsupported_route.requires_human_approval());
    assert!(!schema_route.can_mutate_shared_projection());
    assert!(!semantic_route.can_mutate_shared_projection());
    assert_eq!(
        semantic_route.file_ref,
        ManagementProjectionFileRef::task("task:1")
    );
}
