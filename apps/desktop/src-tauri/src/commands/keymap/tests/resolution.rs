use longhorn_command::{
    CommandKeyResolution, CommandKeyboardGate, CommandKeyboardInput, CommandKeyboardMode,
};
use longhorn_command_config::CommandKeymapRejectionCode;

use super::*;

#[test]
fn conflict_reserved_and_input_ownership_gates_are_explicit() {
    let fixture = Fixture::new();
    let mut authority = fixture.authority();
    let original = loaded(&mut authority);
    let conflicting = CommandKeymapPatch {
        active_preset_id: None,
        clear_overrides: false,
        remove_binding_ids: Vec::new(),
        upsert_overrides: vec![
            CommandKeymapOverride::Add {
                binding: binding(
                    "nucleus:user:conflict-create",
                    "KeyJ",
                    "workspace",
                    "nucleus:project.create",
                )
                .unwrap(),
            },
            CommandKeymapOverride::Add {
                binding: binding(
                    "nucleus:user:conflict-manage",
                    "KeyJ",
                    "workspace",
                    "nucleus:project.manage",
                )
                .unwrap(),
            },
        ],
    };
    let CommandKeymapPreviewResult::Rejected {
        rejection,
        conflicts,
        ..
    } = authority
        .preview("main", preview_request(&original, conflicting))
        .expect("conflict preview")
    else {
        panic!("conflict must reject")
    };
    assert_eq!(rejection.code, CommandKeymapRejectionCode::Conflict);
    assert_eq!(conflicts.len(), 3);

    let reserved = CommandKeymapPatch {
        active_preset_id: None,
        clear_overrides: false,
        remove_binding_ids: Vec::new(),
        upsert_overrides: vec![CommandKeymapOverride::Add {
            binding: binding(
                "nucleus:user:reserved-quit",
                "KeyQ",
                "global",
                "nucleus:shell.open-settings",
            )
            .unwrap(),
        }],
    };
    let CommandKeymapPreviewResult::Rejected { rejection, .. } = authority
        .preview("main", preview_request(&original, reserved))
        .expect("reserved preview")
    else {
        panic!("reserved chord must reject")
    };
    assert_eq!(rejection.code, CommandKeymapRejectionCode::InvalidKeymap);
    assert!(!fixture.roots.config().join("commands/keymap.json").exists());

    let domain = keymap_domain().unwrap();
    let effective = domain.compile_state(domain.default_state()).unwrap();
    let save_trigger = primary_trigger("KeyS").unwrap();
    let save_input = CommandKeyboardInput {
        chord: save_trigger.resolve(CommandPlatform::MacOs).unwrap(),
        repeat: false,
        composing: false,
        editable_text: true,
    };
    let editor_context = longhorn_command::CommandContextSnapshot::new(
        longhorn_command::CommandContextRevision::new(1),
        ["global", "workspace", "project", "panel", "editor"]
            .into_iter()
            .map(|value| id(value).unwrap())
            .collect(),
    )
    .unwrap();
    assert!(matches!(
        effective
            .resolve(
                CommandPlatform::MacOs,
                &save_input,
                &editor_context,
                CommandKeyboardMode::Dispatch,
                &NucleusReservedChords,
            )
            .unwrap(),
        CommandKeyResolution::Resolved { .. }
    ));
    let composing = CommandKeyboardInput {
        composing: true,
        ..save_input
    };
    assert!(matches!(
        effective
            .resolve(
                CommandPlatform::MacOs,
                &composing,
                &editor_context,
                CommandKeyboardMode::Dispatch,
                &NucleusReservedChords,
            )
            .unwrap(),
        CommandKeyResolution::Gated {
            gate: CommandKeyboardGate::Composition,
            ..
        }
    ));
}
