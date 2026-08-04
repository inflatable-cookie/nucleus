use super::super::dto::WorkspaceLayoutMutationDto;
use super::*;

#[test]
fn projects_keep_distinct_layouts_and_new_projects_seed_only_agent_chat() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let first = runtime.snapshot("project:first").unwrap();
    assert_agent_chat_only(&first);
    create_panel(
        &runtime,
        "project:first",
        "panel:terminal:first",
        "terminal",
        "right_top",
        Some(("project:first", "resource:first")),
    );
    let saved_first = set_ratio(&runtime, "project:first", "center-right", 610_000);

    let second = runtime.snapshot("project:second").unwrap();
    assert_agent_chat_only(&second);
    create_panel(
        &runtime,
        "project:second",
        "panel:browser:second",
        "browser",
        "center_bottom",
        None,
    );
    set_ratio(&runtime, "project:second", "center-stack", 550_000);

    let restored_first = runtime.snapshot("project:first").unwrap();
    assert_eq!(region_ids(&restored_first, "right_top").len(), 1);
    assert!(region_ids(&restored_first, "center_bottom").is_empty());
    assert_eq!(slot_ratio(&restored_first, "center-right"), 610_000);
    assert!(restored_first.document.revision().get() > saved_first);
}

#[test]
fn stale_rejections_and_invalid_scope_preserve_the_layout_document() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let stale = runtime.snapshot("project:one").unwrap();
    create_panel(
        &runtime,
        "project:one",
        "panel:terminal",
        "terminal",
        "center_bottom",
        None,
    );
    let before = fs::read(fixture.paths.project_layouts()).unwrap();
    let request = LayoutMutationRequest::new(
        LayoutRequestId::new("request:test:stale").unwrap(),
        stale.document.revision(),
        LayoutMutationCommand::SetSizingSlot {
            container_id: longhorn_core::LayoutContainerId::new(stale.container_id).unwrap(),
            sizing_slot_id: SizingSlotId::new("center-stack").unwrap(),
            ratio: LayoutRatio::from_millionths(600_000).unwrap(),
        },
    );
    let response = runtime
        .dispatch(
            "project:one",
            WorkspaceLayoutMutationDto {
                request,
                create_panel: None,
            },
        )
        .unwrap();
    assert!(matches!(
        response.result,
        WorkspaceLayoutDispatchResultDto::Rejected { .. }
    ));
    assert_eq!(fs::read(fixture.paths.project_layouts()).unwrap(), before);

    assert!(runtime
        .prepare_panel("project:one", panel_input("bad", "unknownKind", None))
        .is_err());
    let other = runtime.snapshot("project:two").unwrap();
    let request = LayoutMutationRequest::new(
        LayoutRequestId::new("request:test:cross-scope").unwrap(),
        other.document.revision(),
        LayoutMutationCommand::SetSizingSlot {
            container_id: longhorn_core::LayoutContainerId::new(other.container_id).unwrap(),
            sizing_slot_id: SizingSlotId::new("center-stack").unwrap(),
            ratio: LayoutRatio::from_millionths(600_000).unwrap(),
        },
    );
    assert!(runtime
        .dispatch(
            "project:one",
            WorkspaceLayoutMutationDto {
                request,
                create_panel: None,
            },
        )
        .is_err());
}

#[test]
fn layout_publication_never_rewrites_the_window_domain() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let window_bytes = br#"{"domain":"nucleus.window-placement","sentinel":true}"#;
    fs::write(fixture.paths.window_placement(), window_bytes).unwrap();
    runtime.snapshot("project:one").unwrap();
    set_ratio(&runtime, "project:one", "right-stack", 620_000);
    assert_eq!(
        fs::read(fixture.paths.window_placement()).unwrap(),
        window_bytes
    );
}

#[test]
fn exact_panel_commands_keep_product_presentation_in_step_with_layout() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    create_panel(
        &runtime,
        "project:one",
        "panel:browser:one",
        "browser",
        "center_bottom",
        None,
    );
    let created = runtime.snapshot("project:one").unwrap();
    let panel = created
        .panels
        .iter()
        .find(|panel| panel.external_id == "panel:browser:one")
        .unwrap();
    let mut changed = panel_input("panel:browser:one", "browser", None);
    changed.title = "Research Browser".to_owned();
    let updated = runtime
        .update_panel_presentation("project:one", &panel.panel_instance_id, changed)
        .unwrap();
    assert_eq!(
        updated
            .panels
            .iter()
            .find(|candidate| candidate.panel_instance_id == panel.panel_instance_id)
            .unwrap()
            .title,
        "Research Browser"
    );

    let request = LayoutMutationRequest::new(
        LayoutRequestId::new("request:test:close-browser").unwrap(),
        updated.document.revision(),
        LayoutMutationCommand::ClosePanel {
            panel_instance_id: longhorn_core::PanelInstanceId::new(&panel.panel_instance_id)
                .unwrap(),
        },
    );
    let closed = runtime
        .dispatch(
            "project:one",
            WorkspaceLayoutMutationDto {
                request,
                create_panel: None,
            },
        )
        .unwrap();
    assert!(matches!(
        closed.result,
        WorkspaceLayoutDispatchResultDto::Committed { .. }
    ));
    assert!(closed
        .snapshot
        .panels
        .iter()
        .all(|candidate| candidate.panel_instance_id != panel.panel_instance_id));
    assert!(!fs::read_to_string(fixture.paths.panel_presentations())
        .unwrap()
        .contains("panel:browser:one"));
}

#[test]
fn project_context_and_chat_attachment_survive_runtime_restart() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let initial = runtime.snapshot("project:one").unwrap();
    let chat = initial.panels.first().unwrap();
    let mut presentation = panel_input(&chat.external_id, "agentChat", None);
    presentation.conversation_id = Some("conversation:one".to_owned());
    runtime
        .update_panel_presentation("project:one", &chat.panel_instance_id, presentation)
        .unwrap();
    create_panel(
        &runtime,
        "project:one",
        "panel:agent-chat:second",
        "agentChat",
        "right_top",
        None,
    );
    let second_chat = runtime
        .snapshot("project:one")
        .unwrap()
        .panels
        .into_iter()
        .find(|panel| panel.external_id == "panel:agent-chat:second")
        .unwrap();
    let mut second_presentation = panel_input(&second_chat.external_id, "agentChat", None);
    second_presentation.conversation_id = Some("conversation:two".to_owned());
    runtime
        .update_panel_presentation(
            "project:one",
            &second_chat.panel_instance_id,
            second_presentation,
        )
        .unwrap();
    runtime
        .update_project_context(
            "project:one",
            WorkspaceProjectContextDto {
                selected_goal_id: Some("goal:one".to_owned()),
                selected_task_id: Some("task:one".to_owned()),
                active_conversation_id: Some("conversation:two".to_owned()),
            },
        )
        .unwrap();
    drop(runtime);

    let restored = fixture.runtime().snapshot("project:one").unwrap();
    assert_eq!(restored.panels.len(), 2);
    let attachments = restored
        .panels
        .iter()
        .map(|panel| panel.conversation_id.as_deref())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        attachments,
        std::collections::BTreeSet::from([Some("conversation:one"), Some("conversation:two")])
    );
    assert_eq!(
        restored.context,
        WorkspaceProjectContextDto {
            selected_goal_id: Some("goal:one".to_owned()),
            selected_task_id: Some("task:one".to_owned()),
            active_conversation_id: Some("conversation:two".to_owned()),
        }
    );
    assert_eq!(
        fixture.runtime().snapshot("project:two").unwrap().context,
        WorkspaceProjectContextDto::default()
    );
}

#[test]
fn context_rejects_blank_refs_and_non_chat_conversation_attachments() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    runtime.snapshot("project:one").unwrap();
    assert!(runtime
        .update_project_context(
            "project:one",
            WorkspaceProjectContextDto {
                selected_goal_id: Some("  ".to_owned()),
                ..WorkspaceProjectContextDto::default()
            },
        )
        .is_err());

    create_panel(
        &runtime,
        "project:one",
        "panel:browser:one",
        "browser",
        "center_bottom",
        None,
    );
    let browser = runtime
        .snapshot("project:one")
        .unwrap()
        .panels
        .into_iter()
        .find(|panel| panel.kind == "browser")
        .unwrap();
    let mut presentation = panel_input(&browser.external_id, "browser", None);
    presentation.conversation_id = Some("conversation:wrong".to_owned());
    assert!(runtime
        .update_panel_presentation("project:one", &browser.panel_instance_id, presentation)
        .is_err());
}

#[test]
fn legacy_presentation_state_defaults_shared_context_and_conversation_attachment() {
    let decoded: PanelPresentationState = serde_json::from_value(serde_json::json!({
        "projects": {
            "project:one": {
                "instance:one": {
                    "external_id": "panel:agent-chat",
                    "title": "Agent Chat",
                    "resource_targets": {}
                }
            }
        }
    }))
    .unwrap();

    assert!(decoded.contexts.is_empty());
    assert_eq!(
        decoded.projects["project:one"]["instance:one"].conversation_id,
        None
    );
}
