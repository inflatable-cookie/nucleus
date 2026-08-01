use std::collections::BTreeMap;
use std::fs;

use longhorn_config::StorageRoots;
use longhorn_core::{LayoutRequestId, SizingSlotId};
use longhorn_layout::{LayoutMutationCommand, LayoutMutationRequest, LayoutRatio};
use tempfile::TempDir;

use super::dto::{
    WorkspaceLayoutDispatchResultDto, WorkspaceLayoutSnapshotDto,
    WorkspacePanelPresentationInputDto, WorkspaceUiPaths,
};
use super::legacy::split_legacy_workspace_ui_document;
use super::registry::{definition_registry, REGION_IDS, SIZING_SLOT_IDS};
use super::WorkspaceUiRuntime;

struct Fixture {
    _temp: TempDir,
    roots: StorageRoots,
    paths: WorkspaceUiPaths,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config");
        let data = temp.path().join("data");
        let state = temp.path().join("state");
        let cache = temp.path().join("cache");
        let runtime = temp.path().join("runtime");
        let log = temp.path().join("logs");
        let backup = temp.path().join("backups");
        for path in [&config, &data, &state, &cache, &runtime, &log, &backup] {
            fs::create_dir_all(path).unwrap();
        }
        let roots =
            StorageRoots::new(&config, &data, &state, &cache, &runtime, &log, &backup).unwrap();
        let paths = WorkspaceUiPaths::new(
            state.join("window-placement.json"),
            config.join("project-layouts.json"),
            config.join("project-panel-presentations.json"),
            backup.join("legacy-project-layouts.json"),
            backup.join("legacy-project-layouts.receipt.json"),
        );
        Self {
            _temp: temp,
            roots,
            paths,
        }
    }

    fn runtime(&self) -> WorkspaceUiRuntime {
        WorkspaceUiRuntime::new(self.roots.clone(), &self.paths).unwrap()
    }
}

#[test]
fn registry_matches_the_accepted_five_region_four_slot_shape() {
    let registry = definition_registry().unwrap();
    let schema = registry.schemas().next().unwrap();
    assert_eq!(
        schema
            .regions()
            .iter()
            .map(|region| region.id().as_str())
            .collect::<Vec<_>>(),
        REGION_IDS
    );
    assert_eq!(
        schema
            .sizing_slots()
            .iter()
            .map(|slot| slot.id().as_str())
            .collect::<Vec<_>>(),
        SIZING_SLOT_IDS
    );
    assert_eq!(schema.sizing_slots()[0].default().millionths(), 200_000);
    assert_eq!(schema.sizing_slots()[1].default().millionths(), 740_000);
    let tasks = registry
        .panel_definitions()
        .find(|definition| definition.id().as_str() == "panel:tasks")
        .unwrap();
    assert!(matches!(
        tasks.instance_policy(),
        longhorn_layout::PanelInstancePolicy::OnePerContainer
    ));
}

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
            super::dto::WorkspaceLayoutMutationDto {
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
            super::dto::WorkspaceLayoutMutationDto {
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
            super::dto::WorkspaceLayoutMutationDto {
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
fn migration_backs_up_raw_state_and_separates_product_presentations() {
    let fixture = Fixture::new();
    let source = br#"{
      "schema_version": 10,
      "project_layouts": {
        "project:one": {
          "layout": {
            "left_center_ratio": 0.2,
            "center_right_ratio": 0.63,
            "center_stack_ratio": 0.74,
            "right_stack_ratio": 0.74
          },
          "regions": {
            "left": [],
            "center_top": [{
              "id": "panel:editor",
              "kind": "editor",
              "title": "Editor",
              "closeable": true,
              "movable": true,
              "resource_targets": {"project:one": "resource:one"},
              "editor_file": {"resource_id": "resource:one", "file_ref": "src/main.rs", "display_path": "src/main.rs"},
              "allowed_regions": []
            }],
            "center_bottom": [],
            "right_top": [],
            "right_bottom": []
          },
          "active_panels": {"center_top": "panel:editor"}
        }
      }
    }"#;
    fs::write(fixture.paths.project_layouts(), source).unwrap();

    let runtime = fixture.runtime();
    let loaded = runtime.snapshot("project:one").unwrap();
    assert_eq!(slot_ratio(&loaded, "center-right"), 630_000);
    assert_eq!(loaded.panels[0].external_id, "panel:editor");
    assert_eq!(
        loaded.panels[0].resource_targets.get("project:one"),
        Some(&"resource:one".to_owned())
    );
    assert_eq!(
        fs::read(fixture.paths.legacy_layout_backup()).unwrap(),
        source
    );
    assert!(fixture.paths.layout_migration_receipt().exists());

    let layout = fs::read_to_string(fixture.paths.project_layouts()).unwrap();
    assert!(layout.contains("nucleus.project-layouts"));
    assert!(!layout.contains("resource:one"));
    assert!(!layout.contains("src/main.rs"));
    assert!(!layout.contains("\"title\""));
    let presentations = fs::read_to_string(fixture.paths.panel_presentations()).unwrap();
    assert!(presentations.contains("resource:one"));
    assert!(presentations.contains("src/main.rs"));
}

#[test]
fn pending_single_layout_is_claimed_once_then_new_projects_seed_minimally() {
    let fixture = Fixture::new();
    fs::write(
        fixture.paths.project_layouts(),
        br#"{
          "schema_version": 6,
          "window": {
            "id": "window:primary",
            "layout": {
              "left_center_ratio": 0.2,
              "center_right_ratio": 0.7,
              "center_stack_ratio": 0.6,
              "right_stack_ratio": 0.8
            },
            "regions": {
              "left": [],
              "center_top": [{"id":"panel:terminal","kind":"terminal","title":"Terminal","closeable":true,"movable":true,"allowed_regions":[]}],
              "center_bottom": [],
              "right_top": [],
              "right_bottom": []
            },
            "active_panels": {"center_top":"panel:terminal"}
          }
        }"#,
    )
    .unwrap();
    let runtime = fixture.runtime();
    let claimed = runtime.snapshot("project:first").unwrap();
    assert_eq!(claimed.panels[0].kind, "terminal");
    let new_project = runtime.snapshot("project:second").unwrap();
    assert_agent_chat_only(&new_project);
}

#[test]
fn schemas_one_through_current_split_into_the_same_pending_shape() {
    for schema_version in 1..=10 {
        let raw = format!(
            r#"{{
              "schema_version": {schema_version},
              "window": {{
                "id": "window:primary",
                "regions": {{
                  "left": [],
                  "center_top": [{{"id":"panel:agent-chat","kind":"agentChat","title":"Agent Chat","closeable":true,"movable":true,"allowed_regions":[]}}],
                  "center_bottom": [],
                  "right_top": [],
                  "right_bottom": []
                }}
              }}
            }}"#
        );
        let (_, projects) = split_legacy_workspace_ui_document(raw.as_bytes()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&projects).unwrap();
        assert_eq!(value["schema_version"], 10);
        assert!(value["pending_legacy_layout"].is_object());
    }
}

fn create_panel(
    runtime: &WorkspaceUiRuntime,
    project_id: &str,
    external_id: &str,
    kind: &str,
    region_id: &str,
    resource: Option<(&str, &str)>,
) {
    let input = panel_input(external_id, kind, resource);
    let prepared = runtime.prepare_panel(project_id, input.clone()).unwrap();
    let snapshot = runtime.snapshot(project_id).unwrap();
    let insertion_index = region_ids(&snapshot, region_id).len() as u32;
    let request = LayoutMutationRequest::new(
        LayoutRequestId::new(format!("request:test:create:{external_id}")).unwrap(),
        snapshot.document.revision(),
        LayoutMutationCommand::CreatePanel {
            panel_instance_id: longhorn_core::PanelInstanceId::new(prepared.panel_instance_id)
                .unwrap(),
            panel_definition_id: longhorn_core::PanelDefinitionId::new(
                prepared.panel_definition_id,
            )
            .unwrap(),
            container_id: longhorn_core::LayoutContainerId::new(snapshot.container_id).unwrap(),
            region_id: longhorn_core::RegionId::new(region_id).unwrap(),
            insertion_index,
        },
    );
    let response = runtime
        .dispatch(
            project_id,
            super::dto::WorkspaceLayoutMutationDto {
                request,
                create_panel: Some(input),
            },
        )
        .unwrap();
    assert!(matches!(
        response.result,
        WorkspaceLayoutDispatchResultDto::Committed { .. }
    ));
}

fn set_ratio(runtime: &WorkspaceUiRuntime, project_id: &str, slot: &str, value: u32) -> u64 {
    let snapshot = runtime.snapshot(project_id).unwrap();
    let request = LayoutMutationRequest::new(
        LayoutRequestId::new(format!("request:test:ratio:{project_id}:{slot}:{value}")).unwrap(),
        snapshot.document.revision(),
        LayoutMutationCommand::SetSizingSlot {
            container_id: longhorn_core::LayoutContainerId::new(snapshot.container_id).unwrap(),
            sizing_slot_id: SizingSlotId::new(slot).unwrap(),
            ratio: LayoutRatio::from_millionths(value).unwrap(),
        },
    );
    let response = runtime
        .dispatch(
            project_id,
            super::dto::WorkspaceLayoutMutationDto {
                request,
                create_panel: None,
            },
        )
        .unwrap();
    match response.result {
        WorkspaceLayoutDispatchResultDto::Committed { receipt } => {
            receipt.committed_revision().get()
        }
        WorkspaceLayoutDispatchResultDto::Rejected { rejection } => panic!("{rejection}"),
    }
}

fn assert_agent_chat_only(snapshot: &WorkspaceLayoutSnapshotDto) {
    assert_eq!(snapshot.panels.len(), 1);
    assert_eq!(snapshot.panels[0].kind, "agentChat");
}

fn region_ids<'a>(
    snapshot: &'a WorkspaceLayoutSnapshotDto,
    region_id: &str,
) -> &'a [longhorn_core::PanelInstanceId] {
    snapshot
        .document
        .container(&longhorn_core::LayoutContainerId::new(&snapshot.container_id).unwrap())
        .unwrap()
        .region(&longhorn_core::RegionId::new(region_id).unwrap())
        .unwrap()
        .panel_instance_ids()
}

fn slot_ratio(snapshot: &WorkspaceLayoutSnapshotDto, slot: &str) -> u32 {
    snapshot
        .document
        .container(&longhorn_core::LayoutContainerId::new(&snapshot.container_id).unwrap())
        .unwrap()
        .sizing_slot(&SizingSlotId::new(slot).unwrap())
        .unwrap()
        .ratio()
        .millionths()
}

fn panel_input(
    external_id: &str,
    kind: &str,
    resource: Option<(&str, &str)>,
) -> WorkspacePanelPresentationInputDto {
    WorkspacePanelPresentationInputDto {
        external_id: external_id.to_owned(),
        kind: kind.to_owned(),
        title: match kind {
            "agentChat" => "Agent Chat",
            "terminal" => "Terminal",
            "browser" => "Browser",
            _ => "Panel",
        }
        .to_owned(),
        resource_targets: resource
            .map(|(project, resource)| BTreeMap::from([(project.to_owned(), resource.to_owned())]))
            .unwrap_or_default(),
        editor_file: None,
        forge_diff: None,
    }
}
