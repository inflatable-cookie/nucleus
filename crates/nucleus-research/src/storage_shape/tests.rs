use super::*;

fn storage_record() -> ResearchRunBriefStorageRecord {
    ResearchRunBriefStorageRecord {
        schema_version: RESEARCH_STORAGE_SCHEMA_VERSION,
        run_id: "research-run:harness".to_owned(),
        project_id: Some("project:nucleus".to_owned()),
        title: "Harness communications evidence".to_owned(),
        brief_summary: "Compare harness communication surfaces.".to_owned(),
        brief_detail: Some("Keep raw sources out of storage.".to_owned()),
        status: ResearchRunBriefStorageStatus::Proposed,
        scope_boundary: ResearchRunScopeStorageBoundary {
            in_scope: vec!["official docs".to_owned()],
            out_of_scope: vec!["crawler implementation".to_owned()],
            constraints: vec!["no raw payload retention".to_owned()],
        },
        source_plan_refs: vec!["source-plan:harness:v1".to_owned()],
        confidence: ResearchConfidenceStorage::Unknown,
        coverage: ResearchCoverageStorageSummary {
            covered_refs: vec!["source:official-docs".to_owned()],
            gap_refs: vec!["gap:message-identity".to_owned()],
            note: Some("Early brief storage.".to_owned()),
        },
        questions: vec![ResearchQuestionStorageRecord {
            question_id: "research-question:harness:identity".to_owned(),
            run_id: "research-run:harness".to_owned(),
            text: "Which identity model does each harness use?".to_owned(),
            priority: ResearchQuestionStoragePriority::High,
            status: ResearchQuestionStorageStatus::Open,
            source_requirements: vec![ResearchQuestionSourceRequirementStorage {
                label: "official docs".to_owned(),
                required: true,
            }],
            answer_summary: None,
            evidence_refs: vec!["evidence:classified-docs".to_owned()],
            open_gap_refs: vec!["gap:cursor-ids".to_owned()],
        }],
        source_refs: vec![ResearchSourceStorageRef {
            source_id: "research-source:harness:docs".to_owned(),
            run_id: "research-run:harness".to_owned(),
            kind: ResearchSourceStorageKind::OfficialDocs,
            locator: "https://example.invalid/docs".to_owned(),
            accessed_at: Some("2026-07-03T00:00:00Z".to_owned()),
            author_or_publisher: Some("Example".to_owned()),
            published_or_updated_at: None,
            retrieval_method: ResearchRetrievalStorageMethodHint::Manual,
            reliability: ResearchSourceStorageReliability::Official,
            quote_or_license_note: Some("Link only.".to_owned()),
            retained_artifact_refs: Vec::new(),
        }],
        observation_refs: vec![ResearchObservationStorageRecord {
            observation_id: "research-observation:harness:identity".to_owned(),
            run_id: "research-run:harness".to_owned(),
            source_refs: vec!["research-source:harness:docs".to_owned()],
            kind: ResearchObservationStorageKind::Evidence,
            summary: "Docs describe session ids.".to_owned(),
            evidence_ref: Some("evidence:classified-docs".to_owned()),
        }],
        synthesis_refs: vec![ResearchSynthesisStorageRef {
            synthesis_id: "research-synthesis:harness:identity".to_owned(),
            run_id: "research-run:harness".to_owned(),
            kind: ResearchSynthesisStorageKind::DecisionSupport,
            observation_refs: vec!["research-observation:harness:identity".to_owned()],
            source_coverage_refs: vec!["research-source:harness:docs".to_owned()],
            confidence: ResearchConfidenceStorage::Medium,
            gap_refs: vec!["gap:cursor-tool-call-ids".to_owned()],
            promotion_targets: ResearchPromotionTargetStorageRefs {
                memory_proposal_refs: vec!["memory-proposal:harness-identity".to_owned()],
                planning_artifact_refs: vec!["planning-artifact:harness-contract".to_owned()],
                task_seed_refs: vec!["task-seed:adapter-fixtures".to_owned()],
                source_evidence_refs: vec!["evidence:classified-docs".to_owned()],
            },
        }],
        created_at: Some("2026-07-03T00:00:00Z".to_owned()),
        updated_at: None,
        synthesized_at: None,
        accepted_at: None,
    }
}

#[test]
fn research_storage_codec_round_trips_structured_refs() {
    let record = storage_record();

    let bytes = encode_research_run_brief_storage_payload(&record).expect("encode");
    let decoded = decode_research_run_brief_storage_record(&bytes).expect("decode");

    assert_eq!(decoded.schema_version, RESEARCH_STORAGE_SCHEMA_VERSION);
    assert_eq!(decoded.run_id, "research-run:harness");
    assert_eq!(decoded.project_id.as_deref(), Some("project:nucleus"));
    assert_eq!(
        decoded.questions[0].question_id,
        "research-question:harness:identity"
    );
    assert_eq!(
        decoded.source_refs[0].kind,
        ResearchSourceStorageKind::OfficialDocs
    );
    assert_eq!(
        decoded.observation_refs[0].kind,
        ResearchObservationStorageKind::Evidence
    );
    assert_eq!(
        decoded.synthesis_refs[0].promotion_targets.task_seed_refs,
        ["task-seed:adapter-fixtures".to_owned()]
    );
}

#[test]
fn research_storage_excludes_raw_private_or_secret_payload_fields() {
    let bytes = encode_research_run_brief_storage_payload(&storage_record()).expect("encode");
    let payload = String::from_utf8(bytes).expect("json utf8");

    assert!(!payload.contains("raw_transcript"));
    assert!(!payload.contains("provider_payload"));
    assert!(!payload.contains("browser_cache"));
    assert!(!payload.contains("credential"));
    assert!(!payload.contains("secret_value"));
    assert!(!payload.contains("private_note"));
    assert!(!payload.contains("copyrighted_source_payload"));
}

#[test]
fn storage_records_do_not_grant_effect_authority() {
    let record = storage_record();

    assert!(!record.status.grants_execution_authority());
    assert!(!record.scope_boundary.grants_source_access_authority());
    assert!(!record.questions[0].grants_execution_authority());
    assert!(!record.source_refs[0].stores_raw_source_payload());
    assert!(!record.source_refs[0].grants_retrieval_authority());
    assert!(!record.observation_refs[0].grants_mutation_authority());
    assert!(!record.synthesis_refs[0].grants_promotion_authority());
    assert!(!record.synthesis_refs[0]
        .promotion_targets
        .grants_mutation_authority());
}

#[test]
fn model_generated_leads_are_not_evidence_by_default() {
    let mut record = storage_record();
    record.source_refs[0].kind = ResearchSourceStorageKind::ModelGeneratedLead;

    assert!(!record.source_refs[0].is_evidence_by_default());
}
