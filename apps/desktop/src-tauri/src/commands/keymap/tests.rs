use std::fs;

use longhorn_command::{CommandKeymapOverride, CommandPlatform};
use longhorn_command_config::{
    CommandKeymapCommit, CommandKeymapLoadOutcome, CommandKeymapMutationOutcome,
    CommandKeymapMutationResult, CommandKeymapPatch, CommandKeymapPreview,
    CommandKeymapPreviewResult, CommandKeymapReset,
};
use longhorn_config::StorageRoots;
use longhorn_core::CommandRequestId;
use tempfile::TempDir;

use super::*;

mod resolution;

#[test]
fn default_preset_is_physical_platform_aware_and_caller_scoped() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let catalogue = authority.catalogue("main").expect("catalogue");
    assert_eq!(catalogue.commands.len(), 27);
    assert_eq!(catalogue.presets.len(), 1);
    assert!(authority.catalogue("secondary").is_err());

    let snapshot = loaded(&mut authority);
    assert!(snapshot.state.overrides.is_empty());
    assert_eq!(snapshot.bindings.len(), 4);
    let palette = snapshot
        .bindings
        .iter()
        .find(|binding| {
            binding.invocation.command_id.as_str() == "nucleus:shell.show-command-palette"
        })
        .expect("palette binding");
    assert_eq!(
        palette
            .trigger
            .resolve(CommandPlatform::MacOs)
            .unwrap()
            .label(CommandPlatform::MacOs),
        "⇧⌘P"
    );
    let save = snapshot
        .bindings
        .iter()
        .find(|binding| binding.invocation.command_id.as_str() == "nucleus:editor.save")
        .expect("save binding");
    assert_eq!(
        save.trigger
            .resolve(CommandPlatform::MacOs)
            .unwrap()
            .label(CommandPlatform::MacOs),
        "⌘S"
    );
    assert_eq!(
        save.trigger
            .resolve(CommandPlatform::Windows)
            .unwrap()
            .label(CommandPlatform::Windows),
        "Ctrl+S"
    );
}

#[test]
fn sparse_override_commit_survives_restart_and_reset_removes_only_directives() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let original = loaded(&mut authority);
    let patch = CommandKeymapPatch {
        active_preset_id: None,
        clear_overrides: false,
        remove_binding_ids: Vec::new(),
        upsert_overrides: vec![CommandKeymapOverride::Add {
            binding: binding(
                "nucleus:user:open-projects",
                "KeyO",
                "workspace",
                "nucleus:project.manage",
            )
            .unwrap(),
        }],
    };
    let preview = authority
        .preview("main", preview_request(&original, patch.clone()))
        .expect("preview");
    let CommandKeymapPreviewResult::Accepted { evidence, snapshot } = preview else {
        panic!("expected accepted preview")
    };
    assert_eq!(snapshot.state.overrides.len(), 1);
    let committed = authority
        .commit(
            "main",
            CommandKeymapCommit {
                request_id: request_id("request:keymap-commit"),
                evidence,
                patch,
            },
        )
        .expect("commit");
    let CommandKeymapMutationResult::Applied { receipt, snapshot } = committed else {
        panic!("expected applied commit")
    };
    assert_eq!(receipt.outcome, CommandKeymapMutationOutcome::Changed);
    assert_eq!(snapshot.state.overrides.len(), 1);
    assert!(fixture
        .roots
        .config()
        .join("commands/keymap.json")
        .is_file());

    let mut restarted = fixture.authority();
    let restarted_snapshot = loaded(&mut restarted);
    assert_eq!(restarted_snapshot.state.overrides.len(), 1);
    let reset = restarted
        .reset(
            "main",
            CommandKeymapReset {
                request_id: request_id("request:keymap-reset"),
                registry_generation: restarted_snapshot.registry_generation,
                keymap_revision: restarted_snapshot.state.revision,
                active_preset_id: restarted_snapshot.state.active_preset_id,
                active_preset_version: restarted_snapshot.active_preset_version,
            },
        )
        .expect("reset");
    let CommandKeymapMutationResult::Applied { snapshot, .. } = reset else {
        panic!("expected applied reset")
    };
    assert!(snapshot.state.overrides.is_empty());
    assert_eq!(snapshot.bindings.len(), 4);

    let mut second_restart = fixture.authority();
    let reset_snapshot = loaded(&mut second_restart);
    assert!(reset_snapshot.state.overrides.is_empty());
    let disabled = CommandKeymapPatch {
        active_preset_id: None,
        clear_overrides: false,
        remove_binding_ids: Vec::new(),
        upsert_overrides: vec![CommandKeymapOverride::Disable {
            binding_id: id("nucleus:default:save-editor").unwrap(),
        }],
    };
    let CommandKeymapPreviewResult::Accepted { snapshot, .. } = second_restart
        .preview("main", preview_request(&reset_snapshot, disabled))
        .expect("disable preview")
    else {
        panic!("disable must preview")
    };
    assert_eq!(snapshot.state.overrides.len(), 1);
    assert_eq!(snapshot.bindings.len(), 3);
    assert!(snapshot
        .bindings
        .iter()
        .all(|binding| { binding.invocation.command_id.as_str() != "nucleus:editor.save" }));
}

struct Fixture {
    _temp: TempDir,
    roots: StorageRoots,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        let roots = StorageRoots::new(
            root.join("config"),
            root.join("data"),
            root.join("state"),
            root.join("cache"),
            root.join("runtime"),
            root.join("log"),
            root.join("backup"),
        )
        .unwrap();
        for path in [
            roots.config(),
            roots.data(),
            roots.state(),
            roots.cache(),
            roots.runtime(),
            roots.log(),
            roots.backup(),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        Self { _temp: temp, roots }
    }

    fn authority(&self) -> NucleusCommandHostAuthority {
        NucleusCommandHostAuthority::new(self.roots.clone()).unwrap()
    }
}

fn loaded(
    authority: &mut NucleusCommandHostAuthority,
) -> longhorn_command_config::CommandKeymapSnapshot {
    let CommandKeymapLoadOutcome::Loaded { snapshot } =
        authority.keymap("main").expect("keymap load")
    else {
        panic!("expected loaded keymap")
    };
    snapshot
}

fn preview_request(
    snapshot: &longhorn_command_config::CommandKeymapSnapshot,
    patch: CommandKeymapPatch,
) -> CommandKeymapPreview {
    CommandKeymapPreview {
        registry_generation: snapshot.registry_generation,
        keymap_revision: snapshot.state.revision,
        active_preset_id: snapshot.state.active_preset_id.clone(),
        active_preset_version: snapshot.active_preset_version,
        patch,
    }
}

fn request_id(value: &str) -> CommandRequestId {
    id(value).unwrap()
}
