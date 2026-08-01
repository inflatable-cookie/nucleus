use std::collections::BTreeMap;
use std::fs;

use longhorn_config::StorageRoots;
use tempfile::TempDir;

use super::dto::{
    WorkspacePanelDto, WorkspaceUiConfigDto, WorkspaceUiPaths, WorkspaceWindowPlacementDto,
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
    let placement = WorkspaceWindowPlacementDto::default();
    let mut first = runtime.load("project:first", placement.clone()).unwrap();
    assert_agent_chat_only(&first);
    first.window.regions.right_top.push(panel(
        "window:primary:panel:terminal:1",
        "terminal",
        "Terminal",
        Some(("project:first", "resource:first")),
    ));
    first.window.active_panels.insert(
        "right_top".to_owned(),
        "window:primary:panel:terminal:1".to_owned(),
    );
    first.window.layout.center_right_ratio = 0.61;
    let saved_first = runtime
        .save("project:first", first, placement.clone())
        .unwrap();

    let mut second = runtime.load("project:second", placement.clone()).unwrap();
    assert_agent_chat_only(&second);
    second.window.regions.center_bottom.push(panel(
        "window:primary:panel:browser:1",
        "browser",
        "Browser",
        None,
    ));
    second.window.active_panels.insert(
        "center_bottom".to_owned(),
        "window:primary:panel:browser:1".to_owned(),
    );
    second.window.layout.center_stack_ratio = 0.55;
    runtime
        .save("project:second", second, placement.clone())
        .unwrap();

    let restored_first = runtime.load("project:first", placement).unwrap();
    assert_eq!(restored_first.window.regions.right_top.len(), 1);
    assert!(restored_first.window.regions.center_bottom.is_empty());
    assert_eq!(restored_first.window.layout.center_right_ratio, 0.61);
    assert_eq!(
        restored_first.window.active_panels.get("right_top"),
        Some(&"window:primary:panel:terminal:1".to_owned())
    );
    assert!(restored_first.layout_revision > saved_first.layout_revision);
}

#[test]
fn stale_and_invalid_saves_preserve_the_layout_document_and_revision() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let placement = WorkspaceWindowPlacementDto::default();
    let stale = runtime.load("project:one", placement.clone()).unwrap();
    let mut current = stale.clone();
    current.window.regions.center_bottom.push(panel(
        "panel:terminal",
        "terminal",
        "Terminal",
        None,
    ));
    runtime
        .save("project:one", current, placement.clone())
        .unwrap();
    let before = fs::read(fixture.paths.project_layouts()).unwrap();

    assert!(runtime
        .save("project:one", stale, placement.clone())
        .is_err());
    assert_eq!(fs::read(fixture.paths.project_layouts()).unwrap(), before);

    let mut invalid = runtime.load("project:one", placement.clone()).unwrap();
    invalid.window.regions.right_bottom.push(panel(
        "panel:unknown",
        "unknownKind",
        "Unknown",
        None,
    ));
    assert!(runtime.save("project:one", invalid, placement).is_err());
    assert_eq!(fs::read(fixture.paths.project_layouts()).unwrap(), before);

    let mut invalid_active = runtime
        .load("project:one", WorkspaceWindowPlacementDto::default())
        .unwrap();
    invalid_active
        .window
        .active_panels
        .insert("right_bottom".to_owned(), "panel:terminal".to_owned());
    assert!(runtime
        .save(
            "project:one",
            invalid_active,
            WorkspaceWindowPlacementDto::default(),
        )
        .is_err());
    assert_eq!(fs::read(fixture.paths.project_layouts()).unwrap(), before);
}

#[test]
fn layout_publication_never_rewrites_the_window_domain() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    let window_bytes = br#"{"domain":"nucleus.window-placement","sentinel":true}"#;
    fs::write(fixture.paths.window_placement(), window_bytes).unwrap();
    let placement = WorkspaceWindowPlacementDto::default();
    let mut config = runtime.load("project:one", placement.clone()).unwrap();
    config.window.layout.right_stack_ratio = 0.62;
    runtime.save("project:one", config, placement).unwrap();

    assert_eq!(
        fs::read(fixture.paths.window_placement()).unwrap(),
        window_bytes
    );
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
    let loaded = runtime
        .load("project:one", WorkspaceWindowPlacementDto::default())
        .unwrap();
    assert_eq!(loaded.window.layout.center_right_ratio, 0.63);
    assert_eq!(loaded.window.regions.center_top[0].id, "panel:editor");
    assert_eq!(
        loaded.window.regions.center_top[0]
            .resource_targets
            .get("project:one"),
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
    let claimed = runtime
        .load("project:first", WorkspaceWindowPlacementDto::default())
        .unwrap();
    assert_eq!(claimed.window.regions.center_top[0].kind, "terminal");
    let new_project = runtime
        .load("project:second", WorkspaceWindowPlacementDto::default())
        .unwrap();
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

fn assert_agent_chat_only(config: &WorkspaceUiConfigDto) {
    let panels = [
        &config.window.regions.left,
        &config.window.regions.center_top,
        &config.window.regions.center_bottom,
        &config.window.regions.right_top,
        &config.window.regions.right_bottom,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    assert_eq!(panels.len(), 1);
    assert_eq!(panels[0].kind, "agentChat");
}

fn panel(id: &str, kind: &str, title: &str, resource: Option<(&str, &str)>) -> WorkspacePanelDto {
    WorkspacePanelDto {
        id: id.to_owned(),
        kind: kind.to_owned(),
        title: title.to_owned(),
        closeable: true,
        movable: true,
        resource_targets: resource
            .map(|(project, resource)| BTreeMap::from([(project.to_owned(), resource.to_owned())]))
            .unwrap_or_default(),
        editor_file: None,
        forge_diff: None,
        allowed_regions: Vec::new(),
    }
}
