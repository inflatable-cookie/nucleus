use std::fs;

use longhorn_core::SettingsAuthorityToken;
use longhorn_settings::{
    SettingsAuthorityExpectation, SettingsLimits, SettingsLoadOutcome, SettingsModuleDefinition,
    SettingsMutationOutcome, SettingsMutationResult, SettingsMutationTiming,
    SettingsProtocolVersion, SettingsRegistryBuilder, SettingsRegistryGeneration,
    SettingsScopeRevision,
};
use serde_json::json;

use super::*;

mod support;

use support::*;

#[test]
fn registry_composes_nucleus_pages_with_shared_keybindings_and_typed_units() {
    let registry = build_registry().unwrap();
    let snapshot = SettingsRegistrySnapshot::from(&registry);

    assert_eq!(
        snapshot
            .pages
            .iter()
            .map(|page| page.id.as_str())
            .collect::<Vec<_>>(),
        [
            GENERAL_PAGE_ID,
            APPEARANCE_PAGE_ID,
            AGENT_PAGE_ID,
            longhorn_command_settings::KEYBINDING_SETTINGS_PAGE_ID,
            longhorn_settings_config::STORAGE_SETTINGS_PAGE_ID,
            longhorn_settings_config::BACKUP_SETTINGS_PAGE_ID,
            longhorn_settings_config::RESTORE_SETTINGS_PAGE_ID,
        ]
    );
    assert_eq!(snapshot.modules.len(), 3);
    assert_eq!(snapshot.sections.len(), 3);
    assert_eq!(snapshot.apply_units.len(), 3);
    let keybindings = snapshot
        .pages
        .iter()
        .find(|page| page.id.as_str() == longhorn_command_settings::KEYBINDING_SETTINGS_PAGE_ID)
        .expect("keybindings page");
    assert!(keybindings.readable_scope_ids.is_empty());
    assert!(keybindings.writable_apply_unit_ids.is_empty());
    for (id, timing) in [
        (GENERAL_UNIT_ID, SettingsMutationTiming::Immediate),
        (APPEARANCE_UNIT_ID, SettingsMutationTiming::Staged),
        (AGENT_UNIT_ID, SettingsMutationTiming::Staged),
    ] {
        assert_eq!(
            snapshot
                .apply_units
                .iter()
                .find(|unit| unit.id.as_str() == id)
                .unwrap()
                .timing,
            timing
        );
    }
}

#[test]
fn duplicate_registration_fails_before_registry_seal() {
    let mut builder = SettingsRegistryBuilder::new(
        SettingsRegistryGeneration::new(9),
        SettingsLimits::default(),
    );
    let module = SettingsModuleDefinition {
        id: module_id(MODULE_ID),
        label: "Nucleus".to_owned(),
        order: 0,
    };
    builder.register_module(module.clone()).unwrap();
    let error = builder.register_module(module).unwrap_err();
    assert_eq!(
        error.code(),
        longhorn_settings::SettingsRegistryErrorCode::DuplicateId
    );
}

#[test]
fn stale_generation_and_cross_domain_commands_fail_closed() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let stale = authority
        .load(
            "main",
            SettingsLoadCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:stale"),
                registry_generation: SettingsRegistryGeneration::new(99),
                scope_id: scope_id(GENERAL_SCOPE_ID),
                known_authority: None,
            },
        )
        .unwrap();
    assert!(matches!(stale, SettingsLoadOutcome::Rejected { .. }));

    let snapshot = fixture.load(&mut authority, GENERAL_SCOPE_ID);
    let result = authority
        .apply(
            "main",
            SettingsApplyCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:cross-domain"),
                page_id: page_id(APPEARANCE_PAGE_ID),
                apply_unit_id: apply_unit_id(GENERAL_UNIT_ID),
                scope_id: scope_id(GENERAL_SCOPE_ID),
                authority: snapshot.authority,
                intent: opaque(json!({"showFixtureStatus": false})),
            },
        )
        .unwrap();
    assert!(matches!(result, SettingsMutationResult::Rejected { .. }));
}

#[test]
fn stale_authority_conflicts_without_overwriting_and_restart_reloads_commit() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let original = fixture.load(&mut authority, APPEARANCE_SCOPE_ID);
    let command = SettingsApplyCommand {
        protocol_version: SettingsProtocolVersion::CURRENT,
        request_id: request_id("request:test:appearance-1"),
        page_id: page_id(APPEARANCE_PAGE_ID),
        apply_unit_id: apply_unit_id(APPEARANCE_UNIT_ID),
        scope_id: scope_id(APPEARANCE_SCOPE_ID),
        authority: original.authority.clone(),
        intent: opaque(json!({"density": "comfortable"})),
    };
    let first = authority.apply("main", command.clone()).unwrap();
    assert_eq!(
        mutation_change_events(&first)
            .iter()
            .map(|event| event.scope_id.as_str())
            .collect::<Vec<_>>(),
        [GENERAL_SCOPE_ID, APPEARANCE_SCOPE_ID, AGENT_SCOPE_ID]
    );
    let SettingsMutationResult::Applied { snapshot, receipt } = first else {
        panic!("expected settings apply")
    };
    assert_eq!(receipt.outcome, SettingsMutationOutcome::Changed);
    assert_eq!(snapshot.values[0].effective.value(), &json!("comfortable"));

    let stale = authority.apply("main", command).unwrap();
    assert!(matches!(stale, SettingsMutationResult::Conflict { .. }));

    drop(authority);
    let mut restarted = fixture.authority();
    let restarted_snapshot = fixture.load(&mut restarted, APPEARANCE_SCOPE_ID);
    assert_eq!(
        restarted_snapshot.values[0].effective.value(),
        &json!("comfortable")
    );
}

#[test]
fn agent_defaults_are_typed_persisted_and_reset_without_route_fallback() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let original = fixture.load(&mut authority, AGENT_SCOPE_ID);
    assert_eq!(
        original
            .values
            .iter()
            .map(|value| value.effective.value().clone())
            .collect::<Vec<_>>(),
        [
            json!("gpt-5.4-mini"),
            json!("codex:local-default"),
            json!("low"),
            json!("normal"),
            json!(null)
        ]
    );

    let applied = authority
        .apply(
            "main",
            SettingsApplyCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:agent-apply"),
                page_id: page_id(AGENT_PAGE_ID),
                apply_unit_id: apply_unit_id(AGENT_UNIT_ID),
                scope_id: scope_id(AGENT_SCOPE_ID),
                authority: original.authority,
                intent: opaque(json!({
                    "defaultProviderInstanceId": "codex:local-default",
                    "defaultProviderId": null,
                    "defaultModel": "gpt-5.6-codex",
                    "defaultReasoningEffort": "high",
                    "defaultHarnessMode": "plan"
                })),
            },
        )
        .unwrap();
    let SettingsMutationResult::Applied { snapshot, .. } = applied else {
        panic!("expected agent settings apply")
    };
    assert_eq!(
        snapshot
            .values
            .iter()
            .map(|value| value.effective.value().clone())
            .collect::<Vec<_>>(),
        [
            json!("gpt-5.6-codex"),
            json!("codex:local-default"),
            json!("high"),
            json!("plan"),
            json!(null)
        ]
    );

    drop(authority);
    let mut restarted = fixture.authority();
    let persisted = fixture.load(&mut restarted, AGENT_SCOPE_ID);
    assert!(persisted.values.iter().all(|value| {
        value.entry_id == entry_id(DEFAULT_PROVIDER_ID_ENTRY_ID) || value.configured.is_some()
    }));

    let reset = restarted
        .reset(
            "main",
            SettingsResetCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:agent-reset"),
                page_id: page_id(AGENT_PAGE_ID),
                apply_unit_id: apply_unit_id(AGENT_UNIT_ID),
                scope_id: scope_id(AGENT_SCOPE_ID),
                authority: persisted.authority,
                entry_ids: vec![
                    entry_id(DEFAULT_PROVIDER_INSTANCE_ENTRY_ID),
                    entry_id(DEFAULT_PROVIDER_ID_ENTRY_ID),
                    entry_id(DEFAULT_MODEL_ENTRY_ID),
                    entry_id(DEFAULT_REASONING_ENTRY_ID),
                    entry_id(DEFAULT_HARNESS_MODE_ENTRY_ID),
                ],
            },
        )
        .unwrap();
    let SettingsMutationResult::Applied { snapshot, .. } = reset else {
        panic!("expected agent settings reset")
    };
    assert!(snapshot
        .values
        .iter()
        .all(|value| value.configured.is_none()));
}

#[test]
fn provider_managed_revoke_stays_secret_free_and_preserves_restart_state() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let original = fixture.load(&mut authority, AGENT_SCOPE_ID);
    let applied = authority
        .apply(
            "main",
            SettingsApplyCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:credential-restart"),
                page_id: page_id(AGENT_PAGE_ID),
                apply_unit_id: apply_unit_id(AGENT_UNIT_ID),
                scope_id: scope_id(AGENT_SCOPE_ID),
                authority: original.authority,
                intent: opaque(json!({
                    "defaultProviderInstanceId": "codex:local-default",
                    "defaultProviderId": null,
                    "defaultModel": "gpt-5.4-mini",
                    "defaultReasoningEffort": "high",
                    "defaultHarnessMode": "plan"
                })),
            },
        )
        .unwrap();
    assert!(matches!(applied, SettingsMutationResult::Applied { .. }));

    let receipt = nucleus_server::request_local_codex_credential_action(
        nucleus_server::LocalCodexCredentialActionRequest {
            request_id: "credential-action:revoke:restart-fixture".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            credential_ref: None,
            action: nucleus_server::LocalCodexCredentialAction::Revoke,
        },
    );
    assert_eq!(
        receipt.outcome,
        nucleus_server::LocalCodexCredentialActionOutcome::Unavailable
    );
    assert!(!receipt.changed);

    let persisted = fs::read_to_string(fixture.roots.config().join("preferences/nucleus.json"))
        .expect("persisted desktop preferences");
    for forbidden in [
        "credential",
        "apiKey",
        "accessToken",
        "refreshToken",
        "secret",
    ] {
        assert!(!persisted.contains(forbidden), "persisted {forbidden}");
    }

    drop(authority);
    let mut restarted = fixture.authority();
    let restarted = fixture.load(&mut restarted, AGENT_SCOPE_ID);
    assert_eq!(
        restarted
            .values
            .iter()
            .find(|value| value.entry_id.as_str() == DEFAULT_HARNESS_MODE_ENTRY_ID)
            .unwrap()
            .effective
            .value(),
        &json!("plan")
    );
}

#[test]
fn reset_removes_only_the_named_domain_override() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let original = fixture.load(&mut authority, GENERAL_SCOPE_ID);
    let applied = authority
        .apply(
            "main",
            SettingsApplyCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:general-apply"),
                page_id: page_id(GENERAL_PAGE_ID),
                apply_unit_id: apply_unit_id(GENERAL_UNIT_ID),
                scope_id: scope_id(GENERAL_SCOPE_ID),
                authority: original.authority,
                intent: opaque(json!({"showFixtureStatus": false})),
            },
        )
        .unwrap();
    let SettingsMutationResult::Applied { snapshot, .. } = applied else {
        panic!("expected settings apply")
    };
    let reset = authority
        .reset(
            "main",
            SettingsResetCommand {
                protocol_version: SettingsProtocolVersion::CURRENT,
                request_id: request_id("request:test:general-reset"),
                page_id: page_id(GENERAL_PAGE_ID),
                apply_unit_id: apply_unit_id(GENERAL_UNIT_ID),
                scope_id: scope_id(GENERAL_SCOPE_ID),
                authority: snapshot.authority,
                entry_ids: vec![entry_id(FIXTURE_STATUS_ENTRY_ID)],
            },
        )
        .unwrap();
    let SettingsMutationResult::Applied { snapshot, .. } = reset else {
        panic!("expected settings reset")
    };
    assert_eq!(snapshot.values[0].configured, None);
    assert_eq!(snapshot.values[0].effective.value(), &json!(true));
}

#[test]
fn failed_publication_never_returns_an_applied_receipt() {
    let fixture = Fixture::new();
    fs::write(
        fixture.roots.config().join("preferences"),
        b"not a directory",
    )
    .unwrap();
    let mut authority = fixture.authority();
    let snapshot = fixture.load(&mut authority, GENERAL_SCOPE_ID);
    let result = authority.apply(
        "main",
        SettingsApplyCommand {
            protocol_version: SettingsProtocolVersion::CURRENT,
            request_id: request_id("request:test:failed-write"),
            page_id: page_id(GENERAL_PAGE_ID),
            apply_unit_id: apply_unit_id(GENERAL_UNIT_ID),
            scope_id: scope_id(GENERAL_SCOPE_ID),
            authority: snapshot.authority,
            intent: opaque(json!({"showFixtureStatus": false})),
        },
    );
    assert!(!matches!(
        result,
        Ok(SettingsMutationResult::Applied { .. })
    ));
}

#[test]
fn unauthorized_window_cannot_read_or_write_settings() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    assert!(authority.registry("secondary").is_err());
    let result = authority.load(
        "secondary",
        SettingsLoadCommand {
            protocol_version: SettingsProtocolVersion::CURRENT,
            request_id: request_id("request:test:unauthorized"),
            registry_generation: GENERATION,
            scope_id: scope_id(GENERAL_SCOPE_ID),
            known_authority: Some(SettingsAuthorityExpectation {
                registry_generation: GENERATION,
                scope_revision: SettingsScopeRevision::INITIAL,
                authority_token: SettingsAuthorityToken::new("token:unauthorized").unwrap(),
            }),
        },
    );
    assert!(result.is_err());
}
