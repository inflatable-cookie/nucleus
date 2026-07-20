use super::{
    decode_workspace_ui_config, normalize_workspace_ui_config, preserve_host_owned_placement,
};
use crate::workspace_ui::{default_workspace_ui_config, SCHEMA_VERSION};

#[test]
fn default_config_has_primary_window_and_five_region_shape() {
    let config = default_workspace_ui_config();

    assert_eq!(config.schema_version, SCHEMA_VERSION);
    assert_eq!(config.window.id, "window:primary");
    assert_eq!(config.window.regions.left.len(), 0);
    assert_eq!(config.window.regions.right_top.len(), 0);
    assert_eq!(config.window.regions.right_bottom.len(), 0);
    assert_eq!(config.window.regions.center_top.len(), 1);
    assert_eq!(config.window.regions.center_top[0].kind, "agentChat");
    assert_eq!(config.window.regions.center_bottom.len(), 0);
    assert_eq!(config.window.layout, super::default_workspace_layout());
    assert_eq!(
        config.window.regions.center_top[0].allowed_regions,
        vec![
            "center_top".to_string(),
            "center_bottom".to_string(),
            "right_top".to_string(),
            "right_bottom".to_string(),
        ]
    );
    assert_eq!(
        config
            .window
            .active_panels
            .get("center_top")
            .map(String::as_str),
        Some("panel:agent-chat")
    );
}

#[test]
fn panel_resource_targets_round_trip_per_project() {
    let mut store = super::default_workspace_ui_store();
    super::ensure_project_layout(&mut store, "project:one");
    let panel = store
        .project_layouts
        .get_mut("project:one")
        .expect("project layout")
        .regions
        .center_top
        .first_mut()
        .expect("workspace panel");
    panel.resource_targets = std::collections::BTreeMap::from([
        ("project:one".to_owned(), "resource:alpha".to_owned()),
        ("project:two".to_owned(), "resource:beta".to_owned()),
    ]);

    let raw = serde_json::to_string(&store).expect("encode config");
    let (decoded, migrated) = super::decode_workspace_ui_store(&raw).expect("decode config");
    let restored = &decoded.project_layouts["project:one"].regions.center_top[0].resource_targets;

    assert!(!migrated);
    assert_eq!(
        restored.get("project:one").map(String::as_str),
        Some("resource:alpha")
    );
    assert_eq!(
        restored.get("project:two").map(String::as_str),
        Some("resource:beta")
    );
}

#[test]
fn empty_panel_resource_targets_serialize_as_an_object() {
    let config = default_workspace_ui_config();
    let value = serde_json::to_value(config).expect("encode config");

    assert_eq!(
        value["window"]["regions"]["center_top"][0]["resource_targets"],
        serde_json::json!({})
    );
}

#[test]
fn task_panel_is_closeable_and_normalized_to_one_instance() {
    let mut config = default_workspace_ui_config();
    config.window.regions.center_top.push(super::panel(
        "panel:tasks",
        "tasks",
        "Tasks",
        false,
        true,
    ));
    let mut duplicate = config.window.regions.center_top[1].clone();
    config.window.regions.center_top[1].closeable = false;
    duplicate.id = "panel:tasks:duplicate".to_owned();
    config.window.regions.right_bottom.push(duplicate);

    let normalized = normalize_workspace_ui_config(config);
    let task_panels = normalized
        .window
        .regions
        .center_top
        .iter()
        .chain(normalized.window.regions.center_bottom.iter())
        .chain(normalized.window.regions.right_top.iter())
        .chain(normalized.window.regions.right_bottom.iter())
        .filter(|panel| panel.kind == "tasks")
        .collect::<Vec<_>>();

    assert_eq!(task_panels.len(), 1);
    assert_eq!(task_panels[0].id, "panel:tasks");
    assert!(task_panels[0].closeable);
}

#[test]
fn legacy_config_flattens_the_active_surface_into_the_primary_window() {
    let raw = r#"{
          "schema_version": 1,
          "active_surface_id": "surface:second",
          "surfaces": [
            {
              "id": "surface:main",
              "title": "Main",
              "kind": "workspace",
              "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.7, "center_stack_ratio": 0.7},
              "regions": {"left": [], "right": [], "center_top": [], "center_bottom": []}
            },
            {
              "id": "surface:second",
              "title": "Second",
              "kind": "workspace",
              "layout": {"left_center_ratio": 0.3, "center_right_ratio": 0.6, "center_stack_ratio": 0.5},
              "regions": {
                "left": [],
                "right": [],
                "center_top": [{"id":"panel:editor","kind":"editor","title":"Editor","closeable":true,"movable":true,"allowed_regions":[]}],
                "center_bottom": []
              }
            }
          ]
        }"#;

    let (config, migrated) = decode_workspace_ui_config(raw).expect("legacy config migrates");
    let normalized = normalize_workspace_ui_config(config);

    assert!(migrated);
    assert_eq!(normalized.schema_version, SCHEMA_VERSION);
    assert_eq!(normalized.window.id, "window:primary");
    assert_eq!(
        normalized.window.placement,
        super::WorkspaceWindowPlacementDto::default()
    );
    assert_eq!(normalized.window.layout.left_center_ratio, 0.3);
    assert_eq!(normalized.window.regions.center_top[0].kind, "editor");
    assert_eq!(
        normalized.window.regions.center_top[0].allowed_regions,
        vec![
            "center_top".to_string(),
            "center_bottom".to_string(),
            "right_top".to_string(),
            "right_bottom".to_string(),
        ]
    );
}

#[test]
fn schema_two_config_gains_empty_native_window_placement() {
    let raw = r#"{
          "schema_version": 2,
          "window": {
            "id": "window:primary",
            "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.74, "center_stack_ratio": 0.74},
            "regions": {"left": [], "right": [], "center_top": [], "center_bottom": []}
          }
        }"#;

    let (config, migrated) = decode_workspace_ui_config(raw).expect("schema two decodes");
    let normalized = normalize_workspace_ui_config(config);

    assert!(migrated);
    assert_eq!(normalized.schema_version, SCHEMA_VERSION);
    assert_eq!(
        normalized.window.placement,
        super::WorkspaceWindowPlacementDto::default()
    );
    assert!(normalized.window.regions.right_top.is_empty());
    assert!(normalized.window.regions.right_bottom.is_empty());
    assert_eq!(normalized.window.layout.right_stack_ratio, 0.74);
}

#[test]
fn schema_three_right_region_migrates_to_right_top() {
    let raw = r#"{
          "schema_version": 3,
          "window": {
            "id": "window:primary",
            "placement": {"maximized": false},
            "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.74, "center_stack_ratio": 0.6},
            "regions": {
              "left": [],
              "right": [{"id":"panel:context","kind":"context","title":"Context","closeable":true,"movable":true,"allowed_regions":["right"]}],
              "center_top": [],
              "center_bottom": []
            }
          }
        }"#;

    let (config, migrated) = decode_workspace_ui_config(raw).expect("schema three decodes");
    let normalized = normalize_workspace_ui_config(config);

    assert!(migrated);
    assert_eq!(normalized.window.regions.right_top.len(), 1);
    assert!(normalized.window.regions.right_bottom.is_empty());
    assert_eq!(normalized.window.regions.right_top[0].kind, "memory");
    assert_eq!(normalized.window.regions.right_top[0].title, "Memory");
    assert_eq!(normalized.window.regions.right_top[0].id, "panel:context");
    assert_eq!(normalized.window.layout.right_stack_ratio, 0.74);
    assert_eq!(
        normalized.window.regions.right_top[0].allowed_regions,
        vec![
            "center_top".to_string(),
            "center_bottom".to_string(),
            "right_top".to_string(),
            "right_bottom".to_string(),
        ]
    );
}

#[test]
fn schema_four_context_panel_migrates_to_memory_in_place() {
    let raw = r#"{
          "schema_version": 4,
          "window": {
            "id": "window:primary",
            "placement": {"maximized": false},
            "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.74, "center_stack_ratio": 0.6, "right_stack_ratio": 0.5},
            "regions": {
              "left": [],
              "right_top": [],
              "right_bottom": [{"id":"window:primary:panel:context:42","kind":"context","title":"Context","closeable":true,"movable":true,"allowed_regions":["center_top","center_bottom","right_top","right_bottom"]}],
              "center_top": [],
              "center_bottom": []
            }
          }
        }"#;

    let (config, migrated) = decode_workspace_ui_config(raw).expect("schema four decodes");
    let normalized = normalize_workspace_ui_config(config);
    let panel = &normalized.window.regions.right_bottom[0];

    assert!(migrated);
    assert_eq!(panel.id, "window:primary:panel:context:42");
    assert_eq!(panel.kind, "memory");
    assert_eq!(panel.title, "Memory");
    assert!(panel.closeable);
    assert!(panel.movable);
}

#[test]
fn schema_five_and_six_single_layouts_become_pending_project_layouts() {
    for schema_version in [5, 6] {
        let raw = format!(
            r#"{{
                  "schema_version": {schema_version},
                  "window": {{
                    "id": "window:primary",
                    "placement": {{"display_id":"display:main","maximized":false}},
                    "layout": {{"left_center_ratio":0.2,"center_right_ratio":0.61,"center_stack_ratio":0.74,"right_stack_ratio":0.74}},
                    "regions": {{
                      "left": [],
                      "right_top": [],
                      "right_bottom": [],
                      "center_top": [{{"id":"panel:agent-chat","kind":"agentChat","title":"Agent Chat","closeable":true,"movable":true,"resource_targets":{{}},"allowed_regions":[]}}],
                      "center_bottom": []
                    }}
                  }}
                }}"#
        );

        let (store, migrated) =
            super::decode_workspace_ui_store(&raw).expect("single layout migrates");

        assert!(migrated);
        assert!(store.project_layouts.is_empty());
        assert_eq!(
            store
                .pending_legacy_layout
                .as_ref()
                .expect("pending layout")
                .layout
                .center_right_ratio,
            0.61
        );
        assert_eq!(
            store.window.placement.display_id.as_deref(),
            Some("display:main")
        );
    }
}

#[test]
fn placement_normalization_repairs_dimensions_and_display_id() {
    let mut config = default_workspace_ui_config();
    config.window.placement = super::WorkspaceWindowPlacementDto {
        display_id: Some("  display:main  ".to_owned()),
        normal_bounds: Some(super::WorkspaceWindowBoundsDto {
            x: -100,
            y: 40,
            width: 100,
            height: 99_999,
        }),
        maximized: true,
    };

    let normalized = normalize_workspace_ui_config(config);
    let bounds = normalized.window.placement.normal_bounds.unwrap();

    assert_eq!(
        normalized.window.placement.display_id.as_deref(),
        Some("display:main")
    );
    assert_eq!(bounds.width, super::MIN_WINDOW_WIDTH);
    assert_eq!(bounds.height, super::MAX_WINDOW_DIMENSION);
    assert!(normalized.window.placement.maximized);
}

#[test]
fn renderer_config_save_preserves_host_owned_placement() {
    let mut current = default_workspace_ui_config();
    current.window.placement = super::WorkspaceWindowPlacementDto {
        display_id: Some("display:current".to_owned()),
        normal_bounds: Some(super::WorkspaceWindowBoundsDto {
            x: 20,
            y: 30,
            width: 1200,
            height: 800,
        }),
        maximized: false,
    };
    let mut requested = default_workspace_ui_config();
    requested.window.placement.display_id = Some("display:stale".to_owned());
    requested.window.layout.left_center_ratio = 0.4;

    preserve_host_owned_placement(&mut requested, &current);

    assert_eq!(requested.window.placement, current.window.placement);
    assert_eq!(requested.window.layout.left_center_ratio, 0.4);
}

#[test]
fn workspace_panels_can_move_to_all_main_regions() {
    assert_eq!(
        super::allowed_regions_for_kind("diff"),
        vec![
            "center_top".to_string(),
            "center_bottom".to_string(),
            "right_top".to_string(),
            "right_bottom".to_string(),
        ]
    );
}

#[test]
fn normalize_repairs_stale_diff_allowed_regions() {
    let mut config = default_workspace_ui_config();
    config
        .window
        .regions
        .center_top
        .push(super::WorkspacePanelDto {
            id: "panel:diff".to_owned(),
            kind: "diff".to_owned(),
            title: "Diff".to_owned(),
            closeable: true,
            movable: true,
            resource_targets: std::collections::BTreeMap::from([(
                "project:multi".to_owned(),
                "resource:second".to_owned(),
            )]),
            allowed_regions: vec!["center_top".to_owned(), "center_bottom".to_owned()],
        });

    let normalized = normalize_workspace_ui_config(config);
    let panel = normalized
        .window
        .regions
        .center_top
        .iter()
        .find(|panel| panel.kind == "diff")
        .expect("diff panel should remain in center top");

    assert_eq!(
        panel.allowed_regions,
        vec![
            "center_top".to_string(),
            "center_bottom".to_string(),
            "right_top".to_string(),
            "right_bottom".to_string(),
        ]
    );
    assert_eq!(
        panel
            .resource_targets
            .get("project:multi")
            .map(String::as_str),
        Some("resource:second")
    );
}

#[test]
fn normalization_keeps_activity_left_and_workspace_tabs_in_main_regions() {
    let mut config = default_workspace_ui_config();
    config.window.regions.left.push(super::WorkspacePanelDto {
        id: "panel:legacy-left-editor".to_owned(),
        kind: "editor".to_owned(),
        title: "Editor".to_owned(),
        closeable: true,
        movable: true,
        resource_targets: std::collections::BTreeMap::new(),
        allowed_regions: vec!["left".to_owned()],
    });
    config
        .window
        .regions
        .right_bottom
        .push(super::WorkspacePanelDto {
            id: "panel:activity".to_owned(),
            kind: "activity".to_owned(),
            title: "Activity".to_owned(),
            closeable: false,
            movable: false,
            resource_targets: std::collections::BTreeMap::new(),
            allowed_regions: vec!["right_bottom".to_owned()],
        });

    let normalized = normalize_workspace_ui_config(config);

    assert!(normalized
        .window
        .regions
        .center_top
        .iter()
        .any(|panel| panel.id == "panel:legacy-left-editor"));
    assert!(normalized
        .window
        .regions
        .left
        .iter()
        .any(|panel| panel.id == "panel:activity"));
    assert!(normalized.window.regions.right_bottom.is_empty());
}

#[test]
fn migrated_single_layout_is_claimed_once() {
    let mut legacy = default_workspace_ui_config();
    legacy.window.layout.center_right_ratio = 0.42;
    legacy.window.regions.right_top.push(super::panel(
        "panel:legacy-editor",
        "editor",
        "Editor",
        true,
        true,
    ));
    let mut store = super::migrate_single_layout(legacy);

    assert!(super::ensure_project_layout(&mut store, "project:first"));
    assert!(super::ensure_project_layout(&mut store, "project:second"));

    let first =
        super::materialize_project_config(&store, "project:first").expect("first project config");
    let second =
        super::materialize_project_config(&store, "project:second").expect("second project config");
    assert_eq!(first.window.layout.center_right_ratio, 0.42);
    assert!(first
        .window
        .regions
        .right_top
        .iter()
        .any(|panel| panel.id == "panel:legacy-editor"));
    assert_eq!(second.window.regions.center_top.len(), 1);
    assert_eq!(second.window.regions.center_top[0].kind, "agentChat");
    assert!(second.window.regions.right_top.is_empty());
    assert!(store.pending_legacy_layout.is_none());
}

#[test]
fn project_layout_updates_do_not_cross_project_boundary() {
    let mut store = super::default_workspace_ui_store();
    super::ensure_project_layout(&mut store, "project:one");
    super::ensure_project_layout(&mut store, "project:two");
    let mut first =
        super::materialize_project_config(&store, "project:one").expect("first project config");
    first.window.layout.center_stack_ratio = 0.35;
    first.window.regions.center_bottom.push(super::panel(
        "panel:terminal",
        "terminal",
        "Terminal",
        true,
        true,
    ));
    first
        .window
        .active_panels
        .insert("center_bottom".to_owned(), "panel:terminal".to_owned());

    super::apply_project_config(&mut store, "project:one", first);

    let first = super::materialize_project_config(&store, "project:one")
        .expect("updated first project config");
    let second = super::materialize_project_config(&store, "project:two")
        .expect("unchanged second project config");
    assert_eq!(first.window.layout.center_stack_ratio, 0.35);
    assert_eq!(first.window.regions.center_bottom.len(), 1);
    assert_eq!(
        first
            .window
            .active_panels
            .get("center_bottom")
            .map(String::as_str),
        Some("panel:terminal")
    );
    assert_eq!(second.window.layout, super::default_workspace_layout());
    assert!(second.window.regions.center_bottom.is_empty());
    assert!(!second.window.active_panels.contains_key("center_bottom"));
}

#[test]
fn project_layout_save_cannot_replace_global_window_placement() {
    let mut store = super::default_workspace_ui_store();
    store.window.placement.display_id = Some("display:host".to_owned());
    super::ensure_project_layout(&mut store, "project:one");
    let mut config =
        super::materialize_project_config(&store, "project:one").expect("project config");
    config.window.placement.display_id = Some("display:renderer".to_owned());

    super::apply_project_config(&mut store, "project:one", config);

    assert_eq!(
        store.window.placement.display_id.as_deref(),
        Some("display:host")
    );
}
